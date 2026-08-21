import { Transform } from 'node:stream';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from 'node:zlib';

// Observation is best effort and must never become an unbounded second response
// consumer. Raw bytes still pass after either ceiling; only token extraction stops.
export const MAX_OBSERVED_RAW_BYTES = 16 * 1024 * 1024;
export const MAX_OBSERVED_DECODED_BYTES = 16 * 1024 * 1024;
// Shared across all in-flight observations in this process, charged as bytes are
// actually observed rather than reserved per response up front.
export const MAX_GLOBAL_OBSERVATION_BUDGET_BYTES = 32 * 1024 * 1024;
let reservedObservationBytes = 0;

function boundedLimit(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function normalizedEncoding(value) {
  const text = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const encoding = text.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return 'identity';
  if (encoding === 'gzip' || encoding === 'x-gzip') return 'gzip';
  if (encoding === 'br') return 'br';
  if (encoding === 'deflate') return 'deflate';
  return 'unsupported';
}

function decoderFor(encoding) {
  if (encoding === 'gzip') return createGunzip();
  if (encoding === 'br') return createBrotliDecompress();
  if (encoding === 'deflate') return createInflate();
  return null;
}

export function createCompositeResponseObserver(observers = []) {
  const entries = (Array.isArray(observers) ? observers : [])
    .filter((observer) => observer && typeof observer === 'object')
    .map((observer) => ({ observer, active: true }));

  function stop(entry, reason) {
    if (!entry.active) return;
    entry.active = false;
    try { entry.observer.abort?.(reason); } catch {}
  }

  return {
    write(chunk) {
      for (const entry of entries) {
        if (!entry.active) continue;
        try {
          if (entry.observer.write?.(chunk) === false) stop(entry, 'observer_stopped');
        } catch {
          stop(entry, 'observer_write_error');
        }
      }
      return entries.some((entry) => entry.active);
    },
    async end() {
      for (const entry of entries) {
        if (!entry.active) continue;
        entry.active = false;
        try { await entry.observer.end?.(); } catch {
          try { entry.observer.abort?.('observer_end_error'); } catch {}
        }
      }
    },
    abort(reason) {
      for (const entry of entries) stop(entry, reason);
    },
    snapshot() {
      const result = {};
      for (const entry of entries) {
        try {
          const value = entry.observer.snapshot?.();
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(result, value);
          }
        } catch {}
      }
      return result;
    },
  };
}

/**
 * Create the one raw-response tee used by P5 and, later, P6.
 *
 * The Transform forwards the exact Buffer object it receives. A bounded decoded
 * side observation is delivered to `observer`, whose methods are deliberately
 * synchronous and best effort: write(Buffer), end(), abort(reason), snapshot().
 * Decoder/parser errors resolve `done` and disable observation without touching
 * the client-facing stream.
 */
export function createResponseObservationTee({
  contentEncoding = null,
  observer = null,
  maxObservedRawBytes = MAX_OBSERVED_RAW_BYTES,
  maxObservedDecodedBytes = MAX_OBSERVED_DECODED_BYTES,
} = {}) {
  const rawLimit = boundedLimit(
    maxObservedRawBytes,
    MAX_OBSERVED_RAW_BYTES,
    MAX_OBSERVED_RAW_BYTES,
  );
  const decodedLimit = boundedLimit(
    maxObservedDecodedBytes,
    MAX_OBSERVED_DECODED_BYTES,
    MAX_OBSERVED_DECODED_BYTES,
  );
  const encoding = normalizedEncoding(contentEncoding);
  let rawBytes = 0;
  let observedRawBytes = 0;
  let decodedBytes = 0;
  let active = Boolean(observer);
  let ended = false;
  let decoder = null;
  let reservedBytes = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function settle() {
    if (ended) return;
    ended = true;
    active = false;
    if (reservedBytes > 0) {
      reservedObservationBytes = Math.max(0, reservedObservationBytes - reservedBytes);
      reservedBytes = 0;
    }
    resolveDone();
  }

  /**
   * Take `bytes` more from the shared pool as they actually arrive.
   *
   * Reserving the per-response ceiling up front instead cost 16 MiB for a
   * response whose median size is a few KB, so a 32 MiB pool admitted only two
   * concurrent compressed responses and shed every one after that — losing both
   * the conversation text and the token usage for them. Charging for observed
   * bytes keeps the same global bound without the 1000x over-reservation.
   *
   * @returns {boolean} false when this observation has just been shed.
   */
  function reserveMore(bytes) {
    if (!active || ended || bytes <= 0) return active && !ended;
    if (reservedObservationBytes + bytes > MAX_GLOBAL_OBSERVATION_BUDGET_BYTES) {
      safeAbort('global_budget');
      return false;
    }
    reservedObservationBytes += bytes;
    reservedBytes += bytes;
    return true;
  }

  function safeAbort(reason) {
    if (!active || ended) return;
    try {
      observer?.abort?.(reason);
    } catch {
      // Observation failures never affect response delivery.
    }
    if (decoder && !decoder.destroyed) decoder.destroy();
    settle();
  }

  function safeEnd() {
    if (!active || ended) return;
    try {
      const result = observer?.end?.();
      Promise.resolve(result).then(settle, () => safeAbort('observer_end_error'));
    } catch {
      safeAbort('observer_end_error');
    }
  }

  function deliverDecoded(chunk) {
    if (!active || ended) return;
    decodedBytes += chunk.length;
    if (decodedBytes > decodedLimit) {
      safeAbort('decoded_limit');
      return;
    }
    if (!reserveMore(chunk.length)) return;
    try {
      if (observer?.write?.(chunk) === false) safeAbort('observer_stopped');
    } catch {
      safeAbort('observer_write_error');
    }
  }

  // Nothing is reserved up front: the pool is charged in `reserveMore` as bytes
  // are actually observed, so a small response costs what it uses.

  if (!active) {
    settle();
  } else if (encoding === 'unsupported') {
    safeAbort('unsupported_encoding');
  } else if (encoding !== 'identity') {
    decoder = decoderFor(encoding);
    decoder.on('data', deliverDecoded);
    decoder.once('end', safeEnd);
    decoder.once('error', () => safeAbort('decode_error'));
  }

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      rawBytes += chunk.length;
      if (active && !ended) {
        observedRawBytes += chunk.length;
        if (observedRawBytes > rawLimit) {
          safeAbort('raw_limit');
        } else if (!reserveMore(chunk.length)) {
          // Shed by the shared pool; the chunk still reaches the client below.
        } else if (encoding === 'identity') {
          deliverDecoded(chunk);
        } else if (decoder && !decoder.destroyed) {
          // Never wait on decoder backpressure: doing so would make telemetry a
          // second flow-control authority. The raw ceiling bounds queued input.
          try {
            decoder.write(chunk);
          } catch {
            safeAbort('decode_error');
          }
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (active && !ended) {
        if (encoding === 'identity') safeEnd();
        else if (decoder && !decoder.destroyed) {
          try {
            decoder.end();
          } catch {
            safeAbort('decode_error');
          }
        }
      }
      // Decoder completion gates only metric finalization, never the client EOF.
      callback();
    },
  });

  return {
    stream,
    done,
    bytes: () => rawBytes,
    abort: safeAbort,
    snapshot() {
      try {
        return observer?.snapshot?.() ?? null;
      } catch {
        return null;
      }
    },
  };
}
