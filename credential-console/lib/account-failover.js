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
 * How often an account the upstream refused is re-checked for an early
 * recovery, off the request path. The reset time a refusal announces is an
 * upper bound, not a promise: on Chicago (2026-10-18) an account refused with a
 * 19:30 reset was answering again at 17:00. That used to be found by spending
 * a member's request on a probe every few minutes, which on a console whose
 * accounts are all exhausted meant every request first collected one 429 per
 * account. The usage endpoint answers the same question for free.
 */
export const EXHAUSTION_RECHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Remaining quota a usage reading has to show before a refused account is
 * believed recovered. Above zero rather than at it: a window reported at 99.6%
 * used is the reading the upstream refuses on, rounded.
 */
const RECOVERED_MIN_REMAINING_PERCENT = 2;

/** The largest refusal body kept for replay; a real one is a few hundred bytes. */
const MAX_REPLAY_BODY_BYTES = 16 * 1024;

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
    // When each account last answered successfully.
    this.succeededAt = new Map();
  }

  /**
   * Record a refusal. `reply` is the refusal itself — the status headers and
   * body the upstream sent — kept so that later requests for this account can
   * be answered with it here instead of being sent to collect it again.
   */
  mark(accountId, { resetsAtMs = null, claim = null, reply = null } = {}, now = Date.now()) {
    if (typeof accountId !== 'string' || !accountId) return null;
    const until = Number.isFinite(resetsAtMs) && resetsAtMs > now
      ? Math.min(resetsAtMs, now + MAX_EXHAUSTION_MS)
      : now + FAILOVER_UNKNOWN_RESET_MS;
    const entry = { until, claim, markedAt: now, checkedAt: now, reply: replayableReply(reply) };
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

  /**
   * The refused accounts due an early-recovery check, oldest check first.
   * Claims each one, so overlapping sweeps do not check the same account twice.
   */
  dueForRecheck(now = Date.now(), intervalMs = EXHAUSTION_RECHECK_INTERVAL_MS) {
    const due = [];
    for (const [accountId, entry] of this.accounts) {
      if (entry.until <= now) {
        this.accounts.delete(accountId);
        continue;
      }
      if (now - entry.checkedAt < intervalMs) continue;
      entry.checkedAt = now;
      due.push({ accountId, claim: entry.claim, until: entry.until });
    }
    return due;
  }

  /** Whether the account has answered since `sinceMs`. */
  succeededSince(accountId, sinceMs) {
    const at = this.succeededAt.get(accountId);
    return Number.isFinite(at) && Number.isFinite(sinceMs) && at > sinceMs;
  }
}

/**
 * A refusal worth replaying: a 429 with its headers and a small body. Anything
 * else is not kept, and an account marked without one is still skipped as a
 * backup — it is just not answered for locally.
 */
function replayableReply(reply) {
  if (!reply || typeof reply !== 'object') return null;
  const body = Buffer.isBuffer(reply.body) ? reply.body : null;
  if (!body || body.length > MAX_REPLAY_BODY_BYTES) return null;
  const headers = {};
  for (const [name, value] of Object.entries(reply.headers ?? {})) {
    // A request id names the request that was refused, not the one being
    // answered; a length is recomputed when the body is sent.
    if (['request-id', 'x-request-id', 'x-oai-request-id', 'content-length', 'x-codex-turn-state']
      .includes(name)) continue;
    if (typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
      headers[name] = value;
    }
  }
  return { headers, body };
}

/**
 * The windows a refusal's claim refers to, as the usage reader names them, or
 * null when the claim cannot be matched to a polled window. Claude names the
 * window it refused on; a Codex refusal names none, and any used-up window
 * refuses it.
 */
function windowsForClaim(provider, claim) {
  if (provider === 'codex') return ['five_hour', 'weekly', 'primary', 'secondary'];
  if (claim === 'five_hour') return ['five_hour'];
  if (claim === 'seven_day') return ['weekly'];
  // An overage refusal is a spend-cap refusal, not proof that the base
  // five-hour or weekly allowance is gone. Treat it like the base windows so
  // a usage reading can clear it as soon as those windows have room again.
  if (claim === 'overage') return ['five_hour', 'weekly'];
  return null;
}

/**
 * Whether a fresh usage reading shows a refused account usable again before
 * the reset it announced. Conservative on purpose: a reading that failed, a
 * claim the poll has no window for, or a window still at its limit all say no,
 * and the account simply waits for its reset or for a member's request to be
 * answered by it.
 */
export function usageShowsRecovered(snapshot, { provider, claim = null } = {}) {
  if (snapshot?.status !== 'available' || !Array.isArray(snapshot.windows)) return false;
  const kinds = windowsForClaim(provider, claim);
  if (!kinds) return false;
  const windows = snapshot.windows.filter((entry) => kinds.includes(entry?.kind));
  if (!windows.length) return false;
  return windows.every((entry) => Number.isFinite(entry.remaining_percent)
    && entry.remaining_percent >= RECOVERED_MIN_REMAINING_PERCENT);
}

/**
 * Check every refused account due for it against a fresh usage reading, and
 * forget the refusal of any that has recovered early. Runs on a timer in the
 * console, never on a member's request.
 */
export async function recheckExhaustedAccounts({
  store,
  refreshUsage,
  exhaustion = quotaExhaustion,
  log = () => {},
  now = Date.now(),
  shouldStop = () => false,
}) {
  for (const { accountId, claim } of exhaustion.dueForRecheck(now)) {
    if (shouldStop()) return;
    const account = store.accountById(accountId);
    if (!account) {
      exhaustion.clear(accountId);
      continue;
    }
    let snapshot = null;
    try {
      snapshot = await refreshUsage(accountId);
    } catch {
      snapshot = null;
    }
    if (usageShowsRecovered(snapshot, { provider: account.provider, claim })) {
      exhaustion.clear(accountId);
      log('quota_exhaustion_cleared', { account_id: accountId, reason: 'usage_recovered', claim });
    }
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
  allowLastResort = true,
  now = Date.now(),
}) {
  const policy = normalizeAccountFailover(homeAccount?.failover);
  if (!policy.enabled) return null;
  // Accounts only the usage reading shows as used up, in chain order: tried
  // when nothing else is left, because the reading can be an hour old and a
  // Codex account past its included quota may still answer on credits. One the
  // upstream itself refused is never among them: it is skipped until it resets
  // or is seen to recover.
  const lastResort = [];
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
    if (exhaustion.exhausted(candidate.id, now)) continue;
    if (knownExhausted(candidate.id, { exhaustion, snapshot, exhaustedBy, now })) {
      lastResort.push(candidate);
      continue;
    }
    return candidate;
  }
  return allowLastResort ? lastResort[0] ?? null : null;
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
  // The return_after stamp is only the reset the refusal announced. An
  // account can answer again sooner, and a fresh usage reading (or a
  // successful request) clears the exhaustion entry; when that happens the
  // device should go home immediately, not wait for the announced reset.
  if (markerHome && homeAccount === markerHome
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
    nextBackup({ allowLastResort = true } = {}) {
      if (!enabled) return null;
      const backup = chooseFailoverAccount({
        allowLastResort,
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
    // Set when the account this request would go to was refused by the
    // upstream and has not reset: the refusal to answer with instead of
    // sending the request to collect it again.
    refusal: null,
  };
  const refused = exhaustion.exhausted(current.id, now());
  if (enabled && (refused || isExhausted(current.id))) {
    // An account the upstream refused is certain to refuse again, so even a
    // backup only the usage reading doubts is worth trying. One that is only
    // doubted itself is as good a try as another doubted one, so then only a
    // backup believed usable is moved to.
    const backup = state.nextBackup({ allowLastResort: Boolean(refused) });
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
  // Only a refusal that was kept can be replayed; without one the request
  // goes upstream as before and collects a fresh refusal to keep.
  if (refused?.reply && state.account === current) state.refusal = refused;
  return state;
}

/**
 * Answer a request with the refusal its account already collected, rather
 * than sending it upstream to be refused again. `Retry-After` is recomputed
 * from the reset the refusal announced, since the copied value counted from
 * when it was first sent.
 */
export function sendCachedRefusal(res, refusal, now = Date.now()) {
  const headers = { ...(refusal.reply?.headers ?? {}) };
  const seconds = Math.max(1, Math.ceil((refusal.until - now) / 1000));
  if ('retry-after' in headers) headers['retry-after'] = String(seconds);
  const body = refusal.reply?.body ?? Buffer.from('{}');
  res.writeHead(429, {
    ...headers,
    'content-length': String(body.length),
    'cache-control': 'no-store',
    // The request body was never read; closing stops the rest of the upload.
    connection: 'close',
    'x-gateway-cached-refusal': '1',
  });
  res.end(body);
}
