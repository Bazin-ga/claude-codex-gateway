/**
 * The credit guard: whether the gateway may let a Codex account spend credits.
 *
 * Credits are what chatgpt.com draws on once an account's included quota is
 * used up. Nothing in the request decides it — the official CLI sends no
 * opt-in, and the upstream simply keeps answering and debits the balance — so a
 * request the gateway forwards past that point is a request paid for in
 * credits. The only place this console can stop that is before forwarding.
 *
 * It only covers traffic that goes through this gateway. Anything holding the
 * account's token directly (a dispenser client, the owner's own login) spends
 * credits without this console ever seeing the request.
 *
 * Off is the default and off is free, for the same reason as the low-quota
 * guard: an account nobody configured keeps working exactly as before.
 */

/**
 * The stored shape, normalized. Anything that is not an explicit `true` reads
 * as "off": a record that cannot be understood must not be able to block
 * traffic.
 */
export function normalizeCodexCreditGuard(value) {
  return { enabled: value?.enabled === true };
}

/**
 * The account's credit balance, as `/wham/usage` reports it.
 *
 * `balance` arrives as a decimal string ("44154.6605095000"). Absent on
 * responses that predate the field, which is null rather than a zero: the panel
 * omits the line instead of claiming an empty balance.
 */
export function codexCreditBalance(credits) {
  if (!credits || typeof credits !== 'object') return null;
  return {
    has_credits: credits.has_credits === true,
    unlimited: credits.unlimited === true,
    balance: finiteNumber(credits.balance),
  };
}

/**
 * A number, or null. Not `Number(value)` on its own: that turns null and '' into
 * 0, which here would read a missing quota as an exhausted one and block an
 * account nobody can see.
 */
function finiteNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * When the included quota runs out next, if it already has — the earliest reset
 * among the windows that are used up — or null while any of it is left.
 *
 * Takes the merged snapshot, so a proxied response that just reported 100% is
 * believed before the next hourly poll. A window whose reset time has passed is
 * not exhausted any more, whatever the snapshot last said: once the guard is
 * refusing everything, no response comes back to update the reading, and
 * without this an account would stay blocked until the poll noticed.
 *
 * A null reading is not an exhausted one. If nobody can see the quota, the
 * account keeps working.
 */
export function includedQuotaExhaustion(snapshot, nowMs = Date.now()) {
  if (!Array.isArray(snapshot?.windows)) return null;
  let exhausted = false;
  let resetsAtMs = null;
  // Every window counts, whatever its kind: a free plan reports a thirty-day
  // window that has no kind of its own, and running out of it spends credits
  // just the same.
  for (const window of snapshot.windows) {
    const remaining = finiteNumber(window?.remaining_percent);
    if (remaining === null || remaining > 0) continue;
    const resetMs = Date.parse(String(window.resets_at ?? ''));
    if (Number.isFinite(resetMs) && resetMs <= nowMs) continue;
    exhausted = true;
    if (Number.isFinite(resetMs) && (resetsAtMs === null || resetMs < resetsAtMs)) resetsAtMs = resetMs;
  }
  return exhausted ? { resetsAtMs } : null;
}

/**
 * The refusal, shaped the way chatgpt.com shapes its own: a 429 of type
 * `usage_limit_reached` with `resets_at` in epoch seconds. The CLI recognises
 * exactly that and shows its ordinary "usage limit reached, try again at …"
 * instead of retrying, which is what the caller should see — their included
 * quota really is gone; the gateway is only declining to pay for more.
 *
 * `plan_type` is left out on purpose: the CLI parses it into a closed enum,
 * and a value it does not know would make it discard the whole error.
 */
export function creditGuardRefusalBody(exhaustion) {
  const resetsAtMs = exhaustion?.resetsAtMs;
  return {
    error: {
      type: 'usage_limit_reached',
      code: 'credits_blocked_by_gateway',
      message: 'this account\'s included Codex quota is used up, and the gateway is set not to spend credits on it '
        + '(该账号订阅额度已用完，网关已设置为不消耗 credits)',
      ...(Number.isFinite(resetsAtMs) ? { resets_at: Math.floor(resetsAtMs / 1000) } : {}),
    },
  };
}
