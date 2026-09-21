/**
 * The low-quota model guard: what a Codex account may still be spent on once
 * its weekly window is nearly gone.
 *
 * The rule is deliberately narrow. Below a per-account threshold of weekly
 * quota remaining, only the small model is allowed through; everything else is
 * refused with an explanation rather than downgraded behind the caller's back,
 * because an answer that silently came from a different model is worse than no
 * answer at all — nobody can tell it happened.
 *
 * Off is the default and off is free: `guardRestricts` is the only thing an
 * account with the switch closed ever evaluates, and it returns false without
 * reading the request body. The proxy's hot path is unchanged for every account
 * that has not opted in.
 */

import { TopLevelJsonScanner } from './request-metadata.js';

/**
 * The model family that survives the guard, matched as a case-insensitive
 * substring of the requested model id.
 *
 * A substring rather than an exact list: the ids carry a version prefix
 * (`gpt-5.6-luna`), and a list would silently start refusing the small model
 * the day upstream ships `gpt-6-luna` — exactly when quota is tight and the
 * guard matters most.
 */
export const CODEX_GUARD_MODEL_KEYWORD = 'luna';

export const CODEX_GUARD_DEFAULT_THRESHOLD_PERCENT = 15;
export const CODEX_GUARD_MIN_THRESHOLD_PERCENT = 1;
/**
 * Half the window is the most a guard may reserve. Above that the switch stops
 * being a low-quota protection and becomes a permanent ban on the large models,
 * which is a different decision and should not be reachable by nudging a
 * number upward.
 */
export const CODEX_GUARD_MAX_THRESHOLD_PERCENT = 50;

/**
 * How much of the request body the guard will read looking for `model`.
 *
 * The Codex CLI serializes `model` first, so in practice this is satisfied by
 * the first chunk. The bound exists for the body that never names a model at
 * all: without it the guard would buffer an entire 32 MB upload before ruling.
 */
export const CODEX_GUARD_PREFIX_BYTES = 64 * 1024;

/**
 * The stored shape, normalized. Anything unrecognized reads as "off": a guard
 * that cannot be understood must not be able to block traffic, and a malformed
 * record is not evidence that anyone asked for one.
 */
export function normalizeCodexGuard(value) {
  const threshold = Number(value?.threshold_percent);
  const usable = Number.isFinite(threshold)
    && threshold >= CODEX_GUARD_MIN_THRESHOLD_PERCENT
    && threshold <= CODEX_GUARD_MAX_THRESHOLD_PERCENT;
  return {
    enabled: value?.enabled === true && usable,
    threshold_percent: usable ? Math.trunc(threshold) : CODEX_GUARD_DEFAULT_THRESHOLD_PERCENT,
  };
}

/**
 * Validate what a form submitted. Unlike `normalizeCodexGuard`, this refuses
 * rather than falls back: silently storing 15 when somebody typed 150 would
 * leave them believing a protection is in force at a level it is not.
 */
export function parseCodexGuardInput({ enabled, thresholdPercent }) {
  const raw = String(thresholdPercent ?? '').trim();
  const threshold = Number(raw);
  if (!/^\d{1,3}$/.test(raw) || !Number.isFinite(threshold)) {
    throw new Error('the low-quota threshold must be a whole percentage');
  }
  if (threshold < CODEX_GUARD_MIN_THRESHOLD_PERCENT
    || threshold > CODEX_GUARD_MAX_THRESHOLD_PERCENT) {
    throw new Error(
      `the low-quota threshold must be between ${CODEX_GUARD_MIN_THRESHOLD_PERCENT}% and ${CODEX_GUARD_MAX_THRESHOLD_PERCENT}%`,
    );
  }
  return { enabled: enabled === true, threshold_percent: threshold };
}

/** Whether this request's model is one the guard still lets through. */
export function codexGuardAllowsModel(model) {
  if (typeof model !== 'string' || !model) return false;
  return model.toLowerCase().includes(CODEX_GUARD_MODEL_KEYWORD);
}

/**
 * Whether the guard is currently biting.
 *
 * A null reading is not a low reading. If nobody can see the quota right now,
 * the account keeps working: one broken usage poll should not take every large
 * model away from everyone, and the failure is recorded either way.
 */
export function guardRestricts(guard, remainingPercent) {
  if (!guard?.enabled) return false;
  if (!Number.isFinite(remainingPercent)) return false;
  return remainingPercent < guard.threshold_percent;
}

/**
 * Read the head of a request body far enough to learn its `model`, and hand
 * back the bytes that were consumed so the caller can put them in front of the
 * body it forwards.
 *
 * The stream is left paused with its listeners removed, so a caller that
 * decides to proceed can pipe it as usual. `ended` means the whole body was
 * consumed here and there is nothing left to pipe — piping an already-ended
 * stream delivers neither data nor 'end', which would hang the forward path.
 */
export function readCodexModelPrefix(req, { limitBytes = CODEX_GUARD_PREFIX_BYTES } = {}) {
  return new Promise((resolve) => {
    const scanner = new TopLevelJsonScanner();
    const chunks = [];
    let bytes = 0;
    let scanned = 0;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onFailure);
      req.off('aborted', onFailure);
      if (!result.ended && !result.aborted) req.pause();
      resolve({
        model: null,
        ended: false,
        aborted: false,
        ...result,
        head: chunks.length ? Buffer.concat(chunks) : null,
        bytes,
      });
    };

    function onData(chunk) {
      chunks.push(chunk);
      bytes += chunk.length;
      // Scanned up to the limit, not chunk by chunk. A single socket read can
      // be tens of kilobytes, so checking the limit only after pushing a whole
      // chunk would make `limitBytes` mean "the limit, plus however much
      // arrived at once" — and the point of the number is to be a bound.
      const take = Math.min(Math.max(0, limitBytes - scanned), chunk.length);
      try {
        if (take > 0) {
          scanner.push(take === chunk.length ? chunk : chunk.subarray(0, take));
          scanned += take;
        }
      } catch {
        settle({ model: null });
        return;
      }
      const { model, parseState } = scanner.snapshot();
      if (model !== null) settle({ model });
      // 'invalid' and 'not_object' are terminal: no later byte can produce a
      // model, so there is nothing to gain by buffering the rest.
      else if (parseState === 'invalid' || parseState === 'not_object') settle({ model: null });
      else if (scanned >= limitBytes) settle({ model: null });
    }

    function onEnd() {
      try {
        scanner.finish();
      } catch {
        settle({ model: null, ended: true });
        return;
      }
      settle({ model: scanner.snapshot().model, ended: true });
    }

    function onFailure() {
      settle({ model: null, aborted: true });
    }

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onFailure);
    req.once('aborted', onFailure);
    req.resume();
  });
}
