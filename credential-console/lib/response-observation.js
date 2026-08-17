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
export const MAX_GLOBAL_OBSERVATION_BUDGET_BYTES = 32 * 1024 * 1024;
// The JSON parser retains up to 1 MiB as a UTF-16 JavaScript string, so reserve
// twice its byte ceiling for identity responses rather than counting UTF-8 only.
const IDENTITY_OBSERVATION_RESERVATION_BYTES = 2 * 1024 * 1024;
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
    try {
      if (observer?.write?.(chunk) === false) safeAbort('observer_stopped');
    } catch {
      safeAbort('observer_write_error');
    }
  }

  if (active && encoding !== 'unsupported') {
    const requestedReservation = encoding === 'identity'
      ? Math.min(decodedLimit, IDENTITY_OBSERVATION_RESERVATION_BYTES)
      : Math.max(rawLimit, decodedLimit);
    if (reservedObservationBytes + requestedReservation
      <= MAX_GLOBAL_OBSERVATION_BUDGET_BYTES) {
      reservedObservationBytes += requestedReservation;
      reservedBytes = requestedReservation;
    } else {
      safeAbort('global_budget');
    }
  }

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
