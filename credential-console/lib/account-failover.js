import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

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
export const FAILOVER_MAX_BACKUPS = 8;

/**
 * How long an exhausted account is avoided when the refusal did not say when
 * it resets. Short, so an account whose limit was transient is retried soon;
 * a refusal that does carry a reset time is believed instead.
 */
export const FAILOVER_UNKNOWN_RESET_MS = 15 * 60_000;

/**
 * How often an account believed exhausted may still be tried as a backup when
 * nothing better is left. The reset time a refusal announces is an upper
 * bound, not a promise: on Chicago (2026-10-18) an account refused with a
 * 19:30 reset was answering again at 17:00, and the gateway refused to use it
 * for 70 minutes while another account's devices collected 49 errors. A probe
 * that fails costs one quick 429 and gives the client the answer it would have
 * had anyway.
 */
export const FAILOVER_PROBE_INTERVAL_MS = 3 * 60_000;

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

/** A small upstream error body, decoded; null when it cannot be read. */
function decodeErrorBody(body, contentEncoding) {
  const encoding = String(contentEncoding ?? '').trim().toLowerCase();
  try {
    if (!encoding || encoding === 'identity') return body.toString('utf8');
    if (encoding === 'gzip') return zlib.gunzipSync(body).toString('utf8');
    if (encoding === 'br') return zlib.brotliDecompressSync(body).toString('utf8');
    if (encoding === 'deflate') return zlib.inflateSync(body).toString('utf8');
    if (encoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(body).toString('utf8');
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Whether a Codex 429 is chatgpt.com saying the account's included quota is
 * used up. That refusal is a JSON body of type `usage_limit_reached` with the
 * reset in epoch seconds — the shape the CLI shows as "usage limit reached,
 * try again at …". The status line alone cannot tell it from a burst limit, so
 * the body is read; it is a few hundred bytes.
 */
export function codexQuotaRejection(statusCode, body, { contentEncoding = null, now = Date.now() } = {}) {
  if (statusCode !== 429 || !Buffer.isBuffer(body)) return null;
  const text = decodeErrorBody(body, contentEncoding);
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const error = parsed?.error;
  if (error?.type !== 'usage_limit_reached') return null;
  let resetsAtMs = null;
  const resetsAt = Number(error.resets_at);
  const resetsIn = Number(error.resets_in_seconds);
  if (Number.isFinite(resetsAt) && resetsAt > 0) resetsAtMs = Math.round(resetsAt * 1000);
  else if (Number.isFinite(resetsIn) && resetsIn > 0) resetsAtMs = now + Math.round(resetsIn * 1000);
  const code = typeof error.code === 'string' && /^[a-z0-9_]{1,60}$/i.test(error.code) ? error.code : null;
  return { claim: code, resetsAtMs };
}

/** The quota headers chatgpt.com puts on a Codex 429, for the log line. */
export function codexRateLimitHeaders(headers) {
  const picked = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!name.startsWith('x-codex-') && name !== 'retry-after') continue;
    if (name === 'x-codex-turn-state') continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    picked[name] = text.slice(0, 200);
  }
  return picked;
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
    // When each account last answered successfully, and when it was last
    // tried as a backup while believed exhausted.
    this.succeededAt = new Map();
    this.probedAt = new Map();
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

  /**
   * The account just answered. Whatever a refusal or the last usage poll said,
   * it is not exhausted now.
   */
  succeeded(accountId, now = Date.now()) {
    if (typeof accountId !== 'string' || !accountId) return;
    this.accounts.delete(accountId);
    this.succeededAt.delete(accountId);
    this.succeededAt.set(accountId, now);
    while (this.succeededAt.size > MAX_TRACKED_ACCOUNTS) {
      this.succeededAt.delete(this.succeededAt.keys().next().value);
    }
  }

  /** Whether the account has answered since `sinceMs`. */
  succeededSince(accountId, sinceMs) {
    const at = this.succeededAt.get(accountId);
    return Number.isFinite(at) && Number.isFinite(sinceMs) && at > sinceMs;
  }

  /**
   * Whether an account believed exhausted may be tried now, at most once per
   * FAILOVER_PROBE_INTERVAL_MS. Claims the slot when it says yes, so that
   * concurrent requests do not all probe at once.
   */
  claimProbe(accountId, now = Date.now()) {
    const last = this.probedAt.get(accountId);
    if (Number.isFinite(last) && now - last < FAILOVER_PROBE_INTERVAL_MS) return false;
    this.probedAt.delete(accountId);
    this.probedAt.set(accountId, now);
    while (this.probedAt.size > MAX_TRACKED_ACCOUNTS) {
      this.probedAt.delete(this.probedAt.keys().next().value);
    }
    return true;
  }
}

/** When a usage reading was taken, or null. */
function snapshotTakenAt(snapshot) {
  const at = Date.parse(String(snapshot?.observed_at ?? snapshot?.fetched_at ?? ''));
  return Number.isFinite(at) ? at : null;
}

/**
 * When the windows a reading shows used up reset — the latest of them, since
 * the account is only usable once all have — or null if it shows none used up
 * or does not say.
 */
export function usageExhaustedUntil(snapshot, now = Date.now()) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  let until = null;
  for (const entry of windows) {
    if (!['five_hour', 'weekly', 'primary', 'secondary'].includes(entry?.kind)) continue;
    if (!(Number.isFinite(entry.remaining_percent) && entry.remaining_percent <= 0)) continue;
    const resetsAt = Date.parse(String(entry.resets_at ?? ''));
    if (Number.isFinite(resetsAt) && resetsAt > now && (until === null || resetsAt > until)) until = resetsAt;
  }
  return until;
}

/**
 * Whether an account counts as exhausted, from a refusal the gateway saw or
 * from the usage reading — unless it has answered since that reading was
 * taken, which outranks an hour-old poll.
 */
export function knownExhausted(accountId, {
  exhaustion = quotaExhaustion,
  snapshot = null,
  exhaustedBy = usageShowsExhausted,
  now = Date.now(),
} = {}) {
  if (exhaustion.exhausted(accountId, now)) return true;
  if (!exhaustedBy(snapshot, now)) return false;
  const takenAt = snapshotTakenAt(snapshot);
  return !(takenAt !== null && exhaustion.succeededSince(accountId, takenAt));
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
  exhaustedBy = usageShowsExhausted,
  acceptCandidate = () => true,
  allowProbe = true,
  now = Date.now(),
}) {
  const policy = normalizeAccountFailover(homeAccount?.failover);
  if (!policy.enabled) return null;
  // Usable accounts that are only believed exhausted, in chain order: tried as
  // a probe when nothing else is left.
  const believedExhausted = [];
  for (const id of policy.backup_account_ids) {
    if (id === homeAccount.id || exclude.includes(id)) continue;
    const candidate = store.accountById(id);
    if (!candidate || candidate.provider !== homeAccount.provider) continue;
    if (!['healthy', 'stored'].includes(candidate.status)) continue;
    if (typeof store.failoverCandidateProblem === 'function'
      && store.failoverCandidateProblem(candidate)) continue;
    if (!acceptCandidate(candidate)) continue;
    let snapshot = null;
    try {
      snapshot = usageSnapshotFor(candidate.id);
    } catch {
      snapshot = null;
    }
    if (knownExhausted(candidate.id, { exhaustion, snapshot, exhaustedBy, now })) {
      believedExhausted.push(candidate);
      continue;
    }
    return candidate;
  }
  if (!allowProbe) return null;
  return believedExhausted.find((candidate) => exhaustion.claimProbe(candidate.id, now)) ?? null;
}

/**
 * Apply one edit from the console to an account's failover policy.
 *
 * The console edits a chain one step at a time — switch it on or off, add a
 * backup, remove one, move one earlier — rather than resubmitting a list, so a
 * page listing a hundred accounts never has to render a hundred choices per
 * row. Returns the new `{ enabled, backup_account_ids }`; the store validates
 * it. Removing the last backup turns failover off, since a chain with nothing
 * in it cannot be on.
 */
export function applyFailoverEdit(current, { op, accountId = null, order = null } = {}) {
  const policy = normalizeAccountFailover(current);
  let enabled = policy.enabled;
  const ids = [...policy.backup_account_ids];
  const index = accountId ? ids.indexOf(accountId) : -1;
  if (op === 'enable') enabled = true;
  else if (op === 'disable') enabled = false;
  else if (op === 'add') {
    if (!accountId) throw new Error('choose an account to add');
    if (index !== -1) throw new Error('that account is already a backup');
    if (ids.length >= FAILOVER_MAX_BACKUPS) {
      throw new Error(`at most ${FAILOVER_MAX_BACKUPS} backup accounts`);
    }
    ids.push(accountId);
  } else if (op === 'remove') {
    if (index === -1) throw new Error('that account is not a backup');
    // Removing is the only edit that can leave nothing behind.
    ids.splice(index, 1);
    if (ids.length === 0) enabled = false;
  } else if (op === 'up') {
    if (index === -1) throw new Error('that account is not a backup');
    if (index > 0) [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
  } else if (op === 'down') {
    if (index === -1) throw new Error('that account is not a backup');
    if (index < ids.length - 1) [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
  } else if (op === 'order') {
    // A whole new order, from dragging. It has to be the same accounts, just
    // rearranged: a page that went stale must not add or drop one by accident.
    const next = Array.isArray(order) ? order : [];
    if (next.length !== ids.length || new Set(next).size !== next.length
      || !next.every((id) => ids.includes(id))) {
      throw new Error('the backup list changed meanwhile; reload and try again');
    }
    return { enabled, backup_account_ids: next };
  } else {
    throw new Error('unknown failover change');
  }
  return { enabled, backup_account_ids: ids };
}

/**
 * Everything a proxy decides about failover before it sends anything.
 *
 * The backup list that governs is the home account's: the one the device was
 * on before the gateway moved it, if it did. A moved device whose home has
 * since reset goes back first. A device still pointed at an account known to
 * be exhausted — from a refusal another device just collected, or from the
 * usage reading — goes straight to a backup instead of asking again.
 *
 * Returns the account to start with and a `nextBackup()` that hands out each
 * remaining usable backup once, plus what `recordMove()` needs to move the
 * device itself once a backup has answered.
 */
export function beginFailover({
  store,
  device,
  account,
  exhaustion = quotaExhaustion,
  usageSnapshotFor = () => null,
  exhaustedBy = usageShowsExhausted,
  acceptCandidate = () => true,
  log = () => {},
  logPrefix,
  now = Date.now,
}) {
  const marker = device.account_failover;
  const markerHome = marker && marker.account_id === account.id
    ? store.accountById(marker.home_account_id)
    : null;
  const homeAccount = markerHome?.provider === account.provider ? markerHome : account;
  const enabled = normalizeAccountFailover(homeAccount.failover).enabled;
  const snapshot = (id) => {
    try {
      return usageSnapshotFor(id);
    } catch {
      return null;
    }
  };
  const isExhausted = (id) => knownExhausted(id, {
    exhaustion,
    snapshot: snapshot(id),
    exhaustedBy,
    now: now(),
  });
  let current = account;
  // The account the device row points at, which is where a persistent move
  // has to start from.
  let deviceSelectedId = account.id;
  if (markerHome && homeAccount === markerHome
    && Date.parse(marker.return_after ?? '') <= now()
    && ['healthy', 'stored'].includes(markerHome.status)
    && !isExhausted(markerHome.id)
    && !store.failoverCandidateProblem?.(markerHome)) {
    log(`${logPrefix}_quota_failback`, {
      device_id: device.id,
      from_account_id: account.id,
      to_account_id: markerHome.id,
    });
    store.failbackDeviceAccount?.({ deviceId: device.id, reason: 'home account reset' })
      ?.catch?.((error) => log(`${logPrefix}_failback_persist_failed`, {
        device_id: device.id,
        code: error?.code ?? error?.name ?? 'unknown',
      }));
    current = markerHome;
    deviceSelectedId = markerHome.id;
  }
  const tried = [current.id];
  const state = {
    enabled,
    homeAccount,
    account: current,
    // The account this request was moved off, once it has been.
    failedOverFrom: null,
    nextBackup({ allowProbe = true } = {}) {
      if (!enabled) return null;
      const backup = chooseFailoverAccount({
        allowProbe,
        store,
        homeAccount,
        exclude: tried,
        exhaustion,
        usageSnapshotFor: snapshot,
        exhaustedBy,
        acceptCandidate,
        now: now(),
      });
      if (backup) tried.push(backup.id);
      return backup;
    },
    /** Note that the request now runs on `backup` instead of the current account. */
    moveTo(backup) {
      state.failedOverFrom ??= state.account;
      state.account = backup;
    },
    /**
     * Once a backup has answered, move the device itself, so its next request
     * goes straight there and the console shows where it is. Fire and forget:
     * the answer is already on its way to the client.
     */
    recordMove() {
      if (state.recorded || !state.failedOverFrom || deviceSelectedId === state.account.id) return;
      state.recorded = true;
      // Prefer what the gateway saw, then what the usage reading says; a
      // guessed quarter of an hour only when neither knows.
      const returnAfterMs = exhaustion.exhausted(homeAccount.id, now())?.until
        ?? usageExhaustedUntil(snapshot(homeAccount.id), now())
        ?? exhaustion.exhausted(state.failedOverFrom.id, now())?.until
        ?? usageExhaustedUntil(snapshot(state.failedOverFrom.id), now())
        ?? now() + FAILOVER_UNKNOWN_RESET_MS;
      store.failoverDeviceAccount?.({
        deviceId: device.id,
        homeAccountId: homeAccount.id,
        fromAccountId: deviceSelectedId,
        toAccountId: state.account.id,
        returnAfterMs,
        reason: `quota exhausted on ${state.failedOverFrom.alias}`,
      })?.catch?.((error) => log(`${logPrefix}_failover_persist_failed`, {
        device_id: device.id,
        to_account_id: state.account.id,
        code: error?.code ?? error?.name ?? 'unknown',
      }));
    },
    recorded: false,
    preflight: false,
  };
  if (enabled && isExhausted(current.id)) {
    // Before anything is sent, only a backup believed usable is worth moving
    // to: the current account is only believed exhausted too, and sending to
    // it is as good a probe as sending to another such account.
    const backup = state.nextBackup({ allowProbe: false });
    if (backup) {
      log(`${logPrefix}_quota_failover`, {
        stage: 'preflight',
        device_id: device.id,
        from_account_id: current.id,
        to_account_id: backup.id,
      });
      state.moveTo(backup);
      state.preflight = true;
    }
  }
  return state;
}
