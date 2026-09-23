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

/** Kept under its old name for callers written before the reader was shared. */
export { MODEL_GATE_PREFIX_BYTES as CODEX_GUARD_PREFIX_BYTES, readModelPrefix as readCodexModelPrefix } from './model-gate.js';

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
