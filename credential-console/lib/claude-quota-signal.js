/**
 * A near-live read of Claude quota, taken from traffic that was going to
 * happen anyway.
 *
 * api.anthropic.com stamps every answer to a subscription credential with
 * `anthropic-ratelimit-unified-7d-utilization` and `-5h-utilization` — the
 * fraction of each window used, the figures Claude Code's own `/usage` shows —
 * next to the epoch second each window resets. The gateway already forwards
 * them to the client. Reading them on the way past costs nothing and closes
 * the gap the hourly usage poll leaves: a reserve that could only see an
 * hour-old snapshot would let an account run an hour past its threshold.
 *
 * This is a supplement to the poll, never a replacement. The poll is the only
 * source for an account nobody is using through the gateway — which is exactly
 * the state of an account held in reserve, whose owner is still spending it
 * directly — so whichever reading is newer wins.
 */

/** Enough for every account a console holds, with room to spare. */
const MAX_TRACKED_ACCOUNTS = 256;

const PREFIX = 'anthropic-ratelimit-unified-';

/** The windows the upstream reports a utilization for, by snapshot kind. */
const HEADER_WINDOWS = Object.freeze({ weekly: '7d', five_hour: '5h' });

function header(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

/**
 * A utilization fraction as a used percentage. The upstream reports past 1
 * when a window is overdrawn (1.01 seen on a five-hour window); that is still
 * a reading, of a window with nothing left.
 */
function usedPercent(value) {
  if (typeof value !== 'string' || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return null;
  const fraction = Number(value);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 100) return null;
  return Math.round(fraction * 1000) / 10;
}

function resetMs(value) {
  if (typeof value !== 'string' || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

function remainingOf(used) {
  return Math.max(0, Math.round((100 - used) * 10) / 10);
}

export class ClaudeQuotaSignal {
  constructor() {
    this.observations = new Map();
  }

  /**
   * Record what an upstream response said about this account's windows.
   *
   * A response without the weekly figure is not an observation: the previous
   * one stands rather than being replaced with a guess.
   */
  observe(accountId, headers, atMs = Date.now()) {
    if (typeof accountId !== 'string' || !accountId) return null;
    const windows = {};
    for (const [kind, name] of Object.entries(HEADER_WINDOWS)) {
      const used = usedPercent(header(headers, `${PREFIX}${name}-utilization`));
      if (used === null) continue;
      windows[kind] = {
        used_percent: used,
        resets_at_ms: resetMs(header(headers, `${PREFIX}${name}-reset`)),
      };
    }
    if (!windows.weekly) return null;
    const observation = { windows, observed_at_ms: Number.isFinite(atMs) ? atMs : Date.now() };
    // Re-inserting moves the key to the end of the Map's iteration order, which
    // makes the eviction below least-recently-observed.
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
   * The freshest weekly reading this console can honestly claim, as
   * `{ remaining_percent, resets_at_ms, at_ms }`, or null if it has none.
   *
   * Whichever of the observation and the polled snapshot is newer wins. A
   * reading whose window has since reset describes a week that is over, so it
   * is no reading at all: that is what lets a reserved account serve again at
   * its reset without waiting for anybody to poll it.
   */
  weeklyReading(accountId, snapshot, now = Date.now()) {
    const observation = this.observations.get(accountId);
    const observed = observation?.windows.weekly
      ? {
        remaining_percent: remainingOf(observation.windows.weekly.used_percent),
        resets_at_ms: observation.windows.weekly.resets_at_ms,
        at_ms: observation.observed_at_ms,
      }
      : null;
    const window = Array.isArray(snapshot?.windows)
      ? snapshot.windows.find((entry) => entry?.kind === 'weekly')
      : null;
    const polledAtMs = Date.parse(String(snapshot?.fetched_at ?? ''));
    const polledResetMs = Date.parse(String(window?.resets_at ?? ''));
    const polled = window && Number.isFinite(Number(window.remaining_percent)) && window.remaining_percent !== null
      ? {
        remaining_percent: Number(window.remaining_percent),
        resets_at_ms: Number.isFinite(polledResetMs) ? polledResetMs : null,
        at_ms: Number.isFinite(polledAtMs) ? polledAtMs : null,
      }
      : null;
    const reading = observed && (!polled || polled.at_ms === null || observed.at_ms >= polled.at_ms)
      ? observed
      : polled;
    if (!reading) return null;
    if (reading.resets_at_ms !== null && reading.resets_at_ms <= now) return null;
    return reading;
  }

  /**
   * The snapshot a page should render: the polled one, with any newer
   * observation folded in. `status` is left alone — a proxied response says
   * nothing about whether the usage poll works — and `observed_at` dates the
   * numbers actually shown.
   */
  merge(accountId, snapshot, now = Date.now()) {
    const observation = this.observations.get(accountId);
    if (!observation || !Array.isArray(snapshot?.windows) || !snapshot.windows.length) {
      return snapshot ?? null;
    }
    const snapshotAtMs = Date.parse(String(snapshot.fetched_at ?? ''));
    if (Number.isFinite(snapshotAtMs) && snapshotAtMs > observation.observed_at_ms) return snapshot;

    let changed = false;
    const windows = snapshot.windows.map((window) => {
      const observed = observation.windows[window?.kind];
      if (!observed) return window;
      // The window the observation described has ended; the poll will say what
      // the new one looks like.
      if (observed.resets_at_ms !== null && observed.resets_at_ms <= now) return window;
      if (observed.used_percent === window.used_percent) return window;
      changed = true;
      return {
        ...window,
        used_percent: observed.used_percent,
        remaining_percent: remainingOf(observed.used_percent),
        ...(observed.resets_at_ms !== null
          ? { resets_at: new Date(observed.resets_at_ms).toISOString() }
          : {}),
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

/**
 * One signal per process, shared by the proxy that fills it and the dashboard
 * that reads it. Two instances would mean the page and the reserve
 * disagreeing about the same account.
 */
export const claudeQuotaSignal = new ClaudeQuotaSignal();
