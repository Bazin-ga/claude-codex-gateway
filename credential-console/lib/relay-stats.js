/**
 * What the third-party page says about each source: how fast it answers, how
 * often it fails, what it costs and how long its balance will last.
 *
 * Everything here is read from the turns the gateway already records; nothing
 * probes a source. The reading is a scan of a day of turns plus a month of
 * spend, seconds of work on a busy console, so it is done off the event loop,
 * kept, and re-read only while somebody is looking.
 */
import { RELAY_STAT_WINDOWS } from './metrics.js';
import { RELAY_ACCOUNT_ID, relayCostUsd } from './relay.js';

const HOUR_MS = 3_600_000;
const SPEND_SPAN_MS = 30 * 24 * HOUR_MS;
/**
 * A turn is recorded when it ends, under the hour it began, and a stream may
 * run for an hour. So the two hours before the previous reading are read
 * again each time, and everything older than that is final.
 */
const SPEND_RECHECK_MS = 2 * HOUR_MS;
/** A reading this recent is shown as it is. */
const FRESH_MS = 60_000;
/** A reading this old is shown while a new one is fetched; an older one is waited for. */
const USABLE_MS = 5 * 60_000;
/** The background refresh runs only this long after the page was last opened. */
const WATCHED_MS = 30 * 60_000;

export const RELAY_STAT_WINDOW_KEYS = RELAY_STAT_WINDOWS.map(([key]) => key);
export const RELAY_STAT_DEFAULT_WINDOW = '1h';

/**
 * The kept reading. `query(params)` runs MetricsStore.queryRelayStats wherever
 * the caller wants it run and resolves to its result, or to null when it
 * cannot be run right now.
 */
export function createRelayStatsCache({ query, now = Date.now, log = () => {} }) {
  let latest = null;
  /** Month of spend rows by the hour they belong to, so only recent hours are re-read. */
  const buckets = new Map();
  /** When the kept month was last brought up to date; null until it has been read whole. */
  let spendReadAtMs = null;
  let inFlight = null;
  let watchedAtMs = 0;

  const refresh = () => {
    if (inFlight) return inFlight;
    const nowMs = now();
    // Everything that was already final at the last reading stays; the hours
    // since, however long ago that was, are read again.
    const spendFromMs = spendReadAtMs === null
      ? nowMs - SPEND_SPAN_MS
      : Math.max(nowMs - SPEND_SPAN_MS, Math.floor((spendReadAtMs - SPEND_RECHECK_MS) / HOUR_MS) * HOUR_MS);
    inFlight = (async () => {
      const stats = await query({ accountId: RELAY_ACCOUNT_ID, nowMs, spendFromMs });
      if (!stats) return;
      for (const key of [...buckets.keys()]) {
        if (key + HOUR_MS > spendFromMs || key + HOUR_MS <= nowMs - SPEND_SPAN_MS) buckets.delete(key);
      }
      for (const row of stats.spend) {
        const key = Number(row.hour_bucket_ms);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
      }
      spendReadAtMs = nowMs;
      latest = { now_ms: stats.now_ms, sources: stats.sources };
    })().catch((error) => {
      log('relay_stats_query_failed', { code: error?.code ?? error?.name ?? 'unknown' });
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    refresh,
    /** For a page: the reading, waited for only when there is none worth showing. */
    async read() {
      watchedAtMs = now();
      const age = latest ? now() - latest.now_ms : Infinity;
      if (age > USABLE_MS) await refresh();
      else if (age > FRESH_MS) refresh();
      return latest ? { ...latest, spend: [...buckets.values()].flat() } : null;
    },
    /** For a timer: keep the reading warm while the page is in use. */
    tick() {
      if (now() - watchedAtMs < WATCHED_MS) refresh();
    },
    pending: () => inFlight,
  };
}

/**
 * The price a recorded turn is estimated at, by the source that served it and
 * the model recorded. A chain source has its own price, or — when it is the
 * platform — the platform's list price for the model it asks for. A turn
 * outside any chain is the platform's at the list price, or unpriced.
 */
export function relayPricer({ chains = [], settings = {}, catalog = null }) {
  const platformAlias = `relay:${settings.name ?? 'platform'}`;
  const sourcePrice = (source) => source.price
    ?? (source.kind === 'platform' ? catalog?.row(source.upstream_model) ?? null : null);
  return (alias, model) => {
    const named = chains.filter((chain) => chain.sources.some((source) => `relay:${source.name}` === alias));
    const chain = named.find((entry) => entry.model === model) ?? named[0];
    if (chain) return sourcePrice(chain.sources.find((source) => `relay:${source.name}` === alias));
    return alias === platformAlias ? catalog?.row(model) ?? null : null;
  };
}

function costOf(price, alias, rows) {
  let cost = null;
  for (const row of rows) {
    const each = relayCostUsd(price(alias, row.model), {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadInputTokens: row.cache_read_tokens,
      requests: row.requests,
    }, Number(row.hour_bucket_ms));
    if (each !== null) cost = (cost ?? 0) + each;
  }
  return cost;
}

const EMPTY_WINDOW = {
  requests: 0,
  failures: 0,
  disconnects: 0,
  failure_statuses: {},
  ttfb_p50_ms: null,
  ttfb_p90_ms: null,
  duration_p50_ms: null,
  duration_p90_ms: null,
  output_tokens_per_s: null,
  usage: [],
};

/**
 * The per-source table for one window: each chain's sources in the order they
 * are tried, then every other source that served a turn in the last day.
 * `balance` is the platform key's reading (RelayCatalog.snapshot().balance)
 * and `sourceStates` the proxy's view of each chain source right now.
 */
export function summarizeRelaySources({
  stats,
  window = RELAY_STAT_DEFAULT_WINDOW,
  chains = [],
  settings = {},
  catalog = null,
  balance = null,
  sourceStates = new Map(),
}) {
  const key = RELAY_STAT_WINDOW_KEYS.includes(window) ? window : RELAY_STAT_DEFAULT_WINDOW;
  const spanHours = RELAY_STAT_WINDOWS.find(([name]) => name === key)[1] / HOUR_MS;
  const price = relayPricer({ chains, settings, catalog });
  const measured = new Map((stats?.sources ?? []).map((source) => [source.alias, source]));
  const platformAlias = `relay:${settings.name ?? 'platform'}`;
  const hourly = (alias) => {
    const usage = measured.get(alias)?.windows['1h']?.usage ?? [];
    return costOf(price, alias, usage);
  };
  /** What is left on the platform key and when it runs out, at the rate it is being spent. */
  const platformBalance = (alias, lineUsd = null) => {
    if (!balance || !Number.isFinite(balance.remaining_usd)) return null;
    // The key's own counter is the truth; until enough of it has been seen,
    // the gateway's estimate of the last hour stands in.
    const estimated = !Number.isFinite(balance.burn_usd_per_hour);
    const burn = estimated ? hourly(alias) : balance.burn_usd_per_hour;
    const hours = (amount) => (burn > 0 ? Math.max(0, amount) / burn : null);
    return {
      remaining_usd: balance.remaining_usd,
      burn_usd_per_hour: burn > 0 ? burn : null,
      burn_estimated: estimated,
      hours_left: hours(balance.remaining_usd),
      line_usd: lineUsd,
      hours_to_line: lineUsd === null ? null : hours(balance.remaining_usd - lineUsd),
    };
  };
  const entry = (alias) => {
    const source = measured.get(alias);
    const figures = source?.windows[key] ?? EMPTY_WINDOW;
    const cost = costOf(price, alias, figures.usage);
    return {
      alias,
      name: alias.replace(/^relay:/, ''),
      requests: figures.requests,
      failures: figures.failures,
      disconnects: figures.disconnects,
      failure_statuses: figures.failure_statuses,
      error_rate: figures.requests ? figures.failures / figures.requests : null,
      ttfb_p50_ms: figures.ttfb_p50_ms,
      ttfb_p90_ms: figures.ttfb_p90_ms,
      duration_p50_ms: figures.duration_p50_ms,
      duration_p90_ms: figures.duration_p90_ms,
      output_tokens_per_s: figures.output_tokens_per_s,
      cost_usd: cost,
      usd_per_hour: cost === null ? null : cost / spanHours,
      last_request_at_ms: source?.last_request_at_ms ?? null,
    };
  };

  const placed = new Set();
  const chainTables = chains.map((chain) => {
    let first = null;
    const sources = chain.sources.map((source, index) => {
      const alias = `relay:${source.name}`;
      placed.add(alias);
      const state = sourceStates.get(source.id) ?? {};
      const usable = source.enabled && state.configured !== false && !state.balance_low;
      if (first === null && usable && !state.cooling_until_ms) first = source.id;
      return {
        ...entry(alias),
        source,
        order: index + 1,
        state: {
          enabled: source.enabled,
          configured: state.configured !== false,
          balance_low: state.balance_low === true,
          cooling_until_ms: state.cooling_until_ms ?? null,
          last_failure: state.last_failure ?? null,
        },
        balance: source.kind === 'platform' ? platformBalance(alias, source.min_balance_usd) : null,
      };
    });
    return {
      model: chain.model,
      aliases: chain.aliases,
      sources: sources.map((row) => ({ ...row, first: row.source.id === first })),
    };
  });
  const others = [...measured.keys()].filter((alias) => !placed.has(alias)).sort().map((alias) => ({
    ...entry(alias),
    source: null,
    order: null,
    state: null,
    first: false,
    balance: alias === platformAlias ? platformBalance(alias) : null,
  }));
  return { window: key, at_ms: stats?.now_ms ?? null, chains: chainTables, others };
}

/**
 * The month's spend by model and by device, each turn priced at the source
 * that served it. An estimate: a platform bills its own way, and what its key
 * has actually spent is shown beside it.
 */
export function summarizeRelaySpend({ spend = [], price, describeDevice = (id) => id ?? '—' }) {
  const models = new Map();
  const devices = new Map();
  const add = (groups, key, start, row, cost) => {
    let group = groups.get(key);
    if (!group) {
      group = { ...start, requestCount: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null };
      groups.set(key, group);
    }
    group.requestCount += Number(row.requests) || 0;
    group.inputTokens += Number(row.input_tokens) || 0;
    group.cachedTokens += Number(row.cache_read_tokens) || 0;
    group.outputTokens += Number(row.output_tokens) || 0;
    if (cost !== null) group.costUsd = (group.costUsd ?? 0) + cost;
  };
  let totalUsd = 0;
  for (const row of spend) {
    const cost = costOf(price, row.account_alias, [row]);
    totalUsd += cost ?? 0;
    add(models, row.model, { model: row.model }, row, cost);
    add(devices, `${row.device_id}\n${row.model}`, { deviceId: row.device_id, model: row.model }, row, cost);
  }
  const byCost = (left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0) || right.requestCount - left.requestCount;
  return {
    models: [...models.values()].sort(byCost),
    devices: [...devices.values()]
      .map(({ deviceId, ...row }) => ({ label: describeDevice(deviceId), ...row }))
      .sort(byCost),
    totalUsd,
  };
}
