/**
 * Quota-exhaustion failover: when an account's subscription allowance is used
 * up, carry on with a backup account instead of handing the 429 to the client.
 *
 * The upstream refuses an exhausted account before it has produced a single
 * byte of the answer, and the gateway has not written anything to the client
 * by then either. So the same request body can be sent again under a backup
 * account's credential and the client only ever sees the backup's answer: the
 * conversation carries on, one round trip later. Thinking-block signatures are
 * valid across accounts, so a conversation started on one account continues on
 * another; what does not carry over is the prompt cache, so the first turn on
 * the backup is billed for its whole input.
 *
 * Only a refusal that means "this account's allowance is gone" moves anything.
 * A transient 429 — a burst limit, a malformed request an OAuth credential
 * answers with a bare 429 — is passed through untouched, because moving a
 * device off a healthy account would just spend the backup for nothing.
 *
 * Off by default, per account: an account nobody configured behaves exactly as
 * it did before this existed.
 */

/** How many backups one account may name. More would be a pool, not a list. */
export const FAILOVER_MAX_BACKUPS = 4;

/**
 * How long an exhausted account is avoided when the refusal did not say when
 * it resets. Short, so an account whose limit was transient is retried soon;
 * a refusal that does carry a reset time is believed instead.
 */
export const FAILOVER_UNKNOWN_RESET_MS = 15 * 60_000;

/** The longest a refusal's reset time is believed: one weekly window. */
const MAX_EXHAUSTION_MS = 8 * 24 * 60 * 60_000;

/** Enough for every account a console holds, with room to spare. */
const MAX_TRACKED_ACCOUNTS = 256;

const CLAUDE_UNIFIED_PREFIX = 'anthropic-ratelimit-unified-';

/**
 * The stored setting, normalized. Anything that is not an explicit `true`
 * reads as off, and the backup list keeps only distinct, non-empty ids: a
 * record that cannot be understood must not be able to move traffic.
 */
export function normalizeAccountFailover(value) {
  const ids = Array.isArray(value?.backup_account_ids) ? value.backup_account_ids : [];
  const backupAccountIds = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id.length > 128) continue;
    if (backupAccountIds.includes(id)) continue;
    backupAccountIds.push(id);
    if (backupAccountIds.length === FAILOVER_MAX_BACKUPS) break;
  }
  return { enabled: value?.enabled === true, backup_account_ids: backupAccountIds };
}

function header(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

/**
 * The epoch-seconds reset stamp the upstream sends, as milliseconds, or null.
 */
function resetMs(value) {
  if (typeof value !== 'string' || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/**
 * Whether a Claude response is the upstream saying this account's allowance is
 * used up, and if so which window and until when.
 *
 * Claude Code itself reads `anthropic-ratelimit-unified-status: rejected` as
 * hard exhaustion, so the gateway uses the same signal. The representative
 * claim names the window that ran out (`five_hour`, `seven_day`, ...).
 */
export function claudeQuotaRejection(statusCode, headers) {
  if (statusCode !== 429) return null;
  if (header(headers, `${CLAUDE_UNIFIED_PREFIX}status`)?.trim().toLowerCase() !== 'rejected') {
    return null;
  }
  const claim = header(headers, `${CLAUDE_UNIFIED_PREFIX}representative-claim`)?.trim() || null;
  return {
    claim: claim && /^[a-z0-9_]{1,40}$/i.test(claim) ? claim : null,
    resetsAtMs: resetMs(header(headers, `${CLAUDE_UNIFIED_PREFIX}reset`)),
  };
}

/**
 * The upstream's rate-limit headers on a 429, for the log line. None of these
 * carry a credential or anything about the request; they are what tells an
 * operator which window ran out.
 */
export function claudeRateLimitHeaders(headers) {
  const picked = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!name.startsWith(CLAUDE_UNIFIED_PREFIX) && name !== 'retry-after') continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    picked[name] = text.slice(0, 200);
  }
  return picked;
}

/**
 * Which accounts are known to be out of allowance, and until when.
 *
 * Fed by refusals the proxy has just seen, so a device still pointed at an
 * exhausted account goes straight to its backup instead of first collecting
 * another refusal — the upstream sees fewer requests against the exhausted
 * account than it did before failover existed, not more.
 *
 * In memory on purpose: a restart forgets it, and the first request after that
 * relearns it from the upstream at the cost of one refusal.
 */
export class QuotaExhaustion {
  constructor() {
    this.accounts = new Map();
  }

  mark(accountId, { resetsAtMs = null, claim = null } = {}, now = Date.now()) {
    if (typeof accountId !== 'string' || !accountId) return null;
    const until = Number.isFinite(resetsAtMs) && resetsAtMs > now
      ? Math.min(resetsAtMs, now + MAX_EXHAUSTION_MS)
      : now + FAILOVER_UNKNOWN_RESET_MS;
    const entry = { until, claim, markedAt: now };
    this.accounts.delete(accountId);
    this.accounts.set(accountId, entry);
    while (this.accounts.size > MAX_TRACKED_ACCOUNTS) {
      this.accounts.delete(this.accounts.keys().next().value);
    }
    return entry;
  }

  /** The entry while it is still in force, otherwise null (and forgotten). */
  exhausted(accountId, now = Date.now()) {
    const entry = this.accounts.get(accountId);
    if (!entry) return null;
    if (entry.until <= now) {
      this.accounts.delete(accountId);
      return null;
    }
    return entry;
  }

  clear(accountId) {
    this.accounts.delete(accountId);
  }
}

export const quotaExhaustion = new QuotaExhaustion();

/**
 * Whether the hourly usage poll already shows an account's allowance as gone.
 *
 * Only the windows every request draws on count. A model-specific window
 * (`fable_weekly`) running out only stops that model, and refusing the whole
 * account as a backup on that basis would waste it; if a request for that
 * model is refused there, the refusal itself moves on to the next backup.
 */
export function usageShowsExhausted(snapshot, now = Date.now()) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  return windows.some((entry) => {
    if (!['five_hour', 'weekly', 'primary', 'secondary'].includes(entry?.kind)) return false;
    if (!(Number.isFinite(entry.remaining_percent) && entry.remaining_percent <= 0)) return false;
    const resetsAt = Date.parse(String(entry.resets_at ?? ''));
    return !Number.isFinite(resetsAt) || resetsAt > now;
  });
}

/**
 * The account a device should fail over to, or null when no backup is usable.
 *
 * `homeAccount` is the account whose backup list governs: the one the device
 * was on before any failover. Backups are tried in the order configured, and a
 * backup is skipped when it is the wrong provider, unusable, already tried for
 * this request, known exhausted, or shown exhausted by the last usage poll.
 */
export function chooseFailoverAccount({
  store,
  homeAccount,
  exclude = [],
  exhaustion = quotaExhaustion,
  usageSnapshotFor = () => null,
  now = Date.now(),
}) {
  const policy = normalizeAccountFailover(homeAccount?.failover);
  if (!policy.enabled) return null;
  for (const id of policy.backup_account_ids) {
    if (id === homeAccount.id || exclude.includes(id)) continue;
    const candidate = store.accountById(id);
    if (!candidate || candidate.provider !== homeAccount.provider) continue;
    if (!['healthy', 'stored'].includes(candidate.status)) continue;
    if (typeof store.failoverCandidateProblem === 'function'
      && store.failoverCandidateProblem(candidate)) continue;
    if (exhaustion.exhausted(candidate.id, now)) continue;
    let snapshot = null;
    try {
      snapshot = usageSnapshotFor(candidate.id);
    } catch {
      snapshot = null;
    }
    if (usageShowsExhausted(snapshot, now)) continue;
    return candidate;
  }
  return null;
}
