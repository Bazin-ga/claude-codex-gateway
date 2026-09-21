/**
 * A near-live read of Codex quota, taken from traffic that was going to happen
 * anyway.
 *
 * chatgpt.com stamps every `/responses` answer with `x-codex-primary-used-percent`
 * and `x-codex-secondary-used-percent` — the same numbers `codex /status` shows,
 * and the gateway already forwards them to the client. Reading them on the way
 * past costs nothing and closes the gap the hourly usage poll leaves: a guard
 * that could only see an hour-old snapshot would keep letting large models
 * through for most of an hour after the account crossed its threshold.
 *
 * This is a supplement to the poll, never a replacement. The poll is the only
 * source for plan type, reset credits, and for accounts nobody is using; the
 * observation here only covers the two windows, and only for as long as
 * somebody keeps making requests.
 */

/** Enough for every account a console holds, with room to spare. */
const MAX_TRACKED_ACCOUNTS = 256;

const PRIMARY_HEADER = 'x-codex-primary-used-percent';
const SECONDARY_HEADER = 'x-codex-secondary-used-percent';

function usedPercent(value) {
  if (Array.isArray(value)) return usedPercent(value[0]);
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null;
  return Math.round(numeric * 10) / 10;
}

/**
 * Which header belongs to which window is decided by the window's `position`
 * — the slot the provider reported it in — and never by its `kind`.
 *
 * This was the bug. `kind` comes from the window's *duration*, and on a Pro
 * plan the provider puts the seven-day window in `primary_window` and reports
 * no secondary at all. Pairing kind 'weekly' with the secondary header meant
 * writing a figure for a window that does not exist onto the one that does:
 * an account genuinely at 93% remaining rendered as 100%, and — far worse —
 * an account at 0% also read as 100%, so the low-quota guard could never fire
 * on the accounts that needed it.
 *
 * A window with no recorded position is left alone rather than guessed at. The
 * hourly poll rewrites the cache with positions, so the only cost is that an
 * observation is ignored until the next poll.
 */
const HEADER_FOR_POSITION = Object.freeze({
  primary: 'primary_used_percent',
  secondary: 'secondary_used_percent',
});

/** Window kinds that mean "the seven-day allowance", most specific first. */
const WEEKLY_KINDS = Object.freeze(['weekly', 'secondary']);

export class CodexQuotaSignal {
  constructor() {
    this.observations = new Map();
  }

  /**
   * Record what an upstream response said about this account's windows.
   *
   * Absent or unparseable headers are simply not an observation: the previous
   * one stands rather than being replaced with a guess.
   */
  observe(accountId, headers, atMs = Date.now()) {
    if (typeof accountId !== 'string' || !accountId) return null;
    const primary = usedPercent(headers?.[PRIMARY_HEADER]);
    const secondary = usedPercent(headers?.[SECONDARY_HEADER]);
    if (primary === null && secondary === null) return null;
    const observation = {
      primary_used_percent: primary,
      secondary_used_percent: secondary,
      observed_at_ms: Number.isFinite(atMs) ? atMs : Date.now(),
    };
    // Re-inserting moves the key to the end of the Map's iteration order, which
    // is what makes the eviction below least-recently-observed rather than
    // arbitrary.
    this.observations.delete(accountId);
    this.observations.set(accountId, observation);
    while (this.observations.size > MAX_TRACKED_ACCOUNTS) {
      const oldest = this.observations.keys().next().value;
      if (oldest === undefined) break;
      this.observations.delete(oldest);
    }
    return observation;
  }

  observationFor(accountId) {
    return this.observations.get(accountId) ?? null;
  }

  forget(accountId) {
    this.observations.delete(accountId);
  }

  reset() {
    this.observations.clear();
  }

  /**
   * The freshest weekly remaining percentage this console can honestly claim,
   * or null if it cannot claim one.
   *
   * Whichever reading is newer wins — an observation is not automatically
   * better than a poll, it is only usually more recent. Comparing timestamps
   * rather than preferring a source keeps a stale observation from overriding
   * a poll that just ran.
   *
   * The snapshot is what says which window is the weekly one and which slot it
   * arrived in, so with no snapshot there is no weekly reading to give — the
   * headers alone cannot say which of them describes the week.
   */
  weeklyRemainingPercent(accountId, snapshot) {
    const window = weeklyWindow(snapshot);
    if (!window) return null;

    const observation = this.observations.get(accountId);
    const observed = observedUsedPercent(observation, window.position);
    const snapshotAtMs = Date.parse(String(snapshot?.fetched_at ?? ''));
    const fresher = observed !== null
      && (!Number.isFinite(snapshotAtMs) || observation.observed_at_ms >= snapshotAtMs);
    if (fresher) return Math.round((100 - observed) * 10) / 10;
    if (Number.isFinite(Number(window.remaining_percent))) return Number(window.remaining_percent);
    return null;
  }

  /**
   * The snapshot a page should render: the polled one, with any newer
   * observation folded in.
   *
   * `status` is deliberately left alone. A proxied response proves the token
   * works, but it says nothing about whether the usage poll succeeded, and
   * promoting a stale snapshot to 'available' on that evidence would hide a
   * broken poller. `observed_at` is added instead, so the page can date the
   * numbers it is actually showing.
   */
  merge(accountId, snapshot) {
    const observation = this.observations.get(accountId);
    if (!observation || !Array.isArray(snapshot?.windows) || !snapshot.windows.length) {
      return snapshot ?? null;
    }
    const snapshotAtMs = Date.parse(String(snapshot.fetched_at ?? ''));
    if (Number.isFinite(snapshotAtMs) && snapshotAtMs > observation.observed_at_ms) return snapshot;

    let changed = false;
    const windows = snapshot.windows.map((window) => {
      const used = observedUsedPercent(observation, window?.position);
      if (used === null || used === window.used_percent) return window;
      changed = true;
      return {
        ...window,
        used_percent: used,
        remaining_percent: Math.round((100 - used) * 10) / 10,
      };
    });
    if (!changed) return snapshot;
    return {
      ...snapshot,
      windows,
      observed_at: new Date(observation.observed_at_ms).toISOString(),
    };
  }
}

/** The observed figure for a window's slot, or null if there isn't one. */
function observedUsedPercent(observation, position) {
  const field = HEADER_FOR_POSITION[position];
  if (!observation || !field) return null;
  const used = observation[field];
  return Number.isFinite(used) ? used : null;
}

function weeklyWindow(snapshot) {
  if (!Array.isArray(snapshot?.windows)) return null;
  for (const kind of WEEKLY_KINDS) {
    const window = snapshot.windows.find((entry) => entry?.kind === kind);
    if (window) return window;
  }
  return null;
}

/**
 * One signal per process, shared by the proxy that fills it and the dashboard
 * that reads it. Two instances would mean the page and the guard disagreeing
 * about the same account.
 */
export const codexQuotaSignal = new CodexQuotaSignal();
