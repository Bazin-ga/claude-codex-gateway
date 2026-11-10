/**
 * A third-party model platform behind the gateway: one OpenAI-compatible
 * endpoint and one platform key, shared by every device, with an allow-list of
 * the models members may run on it.
 *
 * Devices do not get a new credential for it. A request that already reaches
 * the Claude or Codex proxy and names an allowed model is handed to the
 * platform instead of to an account; everything else takes the path it always
 * took. The platform key never leaves this process.
 */
import { billingWeekProfile, compileBillingExpression } from './relay-pricing.js';

export const RELAY_PROXY_PREFIX = '/relay';
/** Metrics rows need an account id; relay turns are filed under this one. */
export const RELAY_ACCOUNT_ID = 'relay';
export const RELAY_MAX_ALLOWED_MODELS = 64;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/**
 * new-api's default ratio for a model the operator never priced. A price
 * computed from it is a guess about the bill, not a quote, so it is flagged.
 */
export const RELAY_PLACEHOLDER_RATIO = 37.5;
/** new-api bills a ratio of 1 as $2 per million tokens. */
const USD_PER_MILLION_AT_RATIO_ONE = 2;

export function relayModelName(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  return MODEL_NAME.test(model) ? model : null;
}

export function normalizeRelay(value) {
  const relay = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = [];
  for (const model of Array.isArray(relay.allowed_models) ? relay.allowed_models : []) {
    const name = relayModelName(model);
    if (name && !allowed.includes(name)) allowed.push(name);
  }
  return {
    name: typeof relay.name === 'string' && relay.name ? relay.name : null,
    base_url: typeof relay.base_url === 'string' && relay.base_url ? relay.base_url : null,
    allowed_models: allowed.slice(0, RELAY_MAX_ALLOWED_MODELS),
    updated_at: typeof relay.updated_at === 'string' ? relay.updated_at : null,
    updated_by: typeof relay.updated_by === 'string' ? relay.updated_by : null,
  };
}

/**
 * The platform root, without a trailing slash or `/v1`: the proxy appends the
 * API path, and the catalog reads `/api/pricing` from the same root.
 */
export function relayBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${url.origin}${path}`;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    // new-api serves some of these as Python-style dict literals.
    try {
      return JSON.parse(value.replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
}

/**
 * The platform's public price list, read as dollars per million tokens.
 *
 * new-api prices a model as `model_ratio × $2/M`, scaled by the ratio of the
 * group the request is billed under; the output side is further multiplied by
 * `completion_ratio`. Which group a request lands in is the platform's choice,
 * so the cheapest group the model is offered in is shown — the price members
 * actually pay was measured to match it on this platform. Groups named
 * `test*` are the operator's own and never offered.
 *
 * A model priced by a billing expression is quoted from the expression, at
 * its cheapest hour of the week, with the multiplier of its dearest: the
 * ratios beside such an expression are leftovers that understate the bill.
 */
export function relayCatalogFromPricing(pricing) {
  const groupRatio = parseMaybeJson(pricing?.group_ratio) ?? {};
  const vendorList = parseMaybeJson(pricing?.vendors);
  const vendors = new Map(Array.isArray(vendorList) ? vendorList.map((vendor) => [vendor.id, vendor.name]) : []);
  const rows = [];
  for (const entry of Array.isArray(pricing?.data) ? pricing.data : []) {
    const model = relayModelName(entry?.model_name);
    if (!model) continue;
    const offered = (Array.isArray(entry.enable_groups) ? entry.enable_groups : [])
      .filter((group) => typeof group === 'string');
    const candidates = offered.filter((group) => !group.startsWith('test') && Number.isFinite(groupRatio[group]));
    const pool = candidates.length ? candidates : offered.filter((group) => Number.isFinite(groupRatio[group]));
    const group = pool.sort((a, b) => groupRatio[a] - groupRatio[b])[0] ?? null;
    const factor = group ? groupRatio[group] : 1;
    const perCall = entry.quota_type === 1;
    const ratio = Number(entry.model_ratio) || 0;
    const billing = !perCall && entry.billing_mode === 'tiered_expr'
      ? compileBillingExpression(entry.billing_expr)
      : null;
    const week = billing ? billingWeekProfile(billing) : null;
    const quoted = (tokens) => (week ? billing(tokens, week.baseAtMs) : null);
    const formula = week
      ? { input: quoted({ p: 1e6 }), output: quoted({ c: 1e6 }), cached: quoted({ cr: 1e6 }) }
      : null;
    const priced = formula && formula.input !== null && formula.output !== null;
    const ratioInput = perCall ? null : ratio * USD_PER_MILLION_AT_RATIO_ONE * factor;
    const input = priced ? (formula.input / 1e6) * factor : ratioInput;
    const cacheRatio = Number(entry.cache_ratio);
    const ratioCached = input === null || !Number.isFinite(cacheRatio) || cacheRatio <= 0
      ? null
      : input * cacheRatio;
    rows.push({
      model,
      vendor: vendors.get(entry.vendor_id) ?? (typeof entry.owner_by === 'string' ? entry.owner_by : '') ?? '',
      group,
      per_call_usd: perCall ? (Number(entry.model_price) || 0) * factor : null,
      input_usd_per_m: input,
      output_usd_per_m: priced
        ? (formula.output / 1e6) * factor
        : (input === null ? null : input * (Number(entry.completion_ratio) || 1)),
      cached_input_usd_per_m: priced
        ? (formula.cached > 0 ? (formula.cached / 1e6) * factor : null)
        : ratioCached,
      // Present only where the platform bills by formula; see relayCostUsd.
      billing: priced ? billing : null,
      group_ratio: factor,
      peak_multiplier: priced ? week.peakMultiplier : 1,
      placeholder: !perCall && !priced && ratio === RELAY_PLACEHOLDER_RATIO,
      endpoints: (Array.isArray(entry.supported_endpoint_types) ? entry.supported_endpoint_types : [])
        .filter((type) => typeof type === 'string'),
    });
  }
  rows.sort((a, b) => (a.vendor || '~').localeCompare(b.vendor || '~')
    || (a.input_usd_per_m ?? Infinity) - (b.input_usd_per_m ?? Infinity)
    || a.model.localeCompare(b.model));
  return rows;
}

/**
 * The estimated dollar cost of a token count at a price row: a catalog row, or
 * a source's own per-million prices in the same shape.
 *
 * `inputTokens` excludes the cached ones, which is how every usage parser here
 * records them; they are billed at their own, much lower price. `atMs` is when
 * the tokens were used, for a formula that charges more at some hours, and
 * `requests` lets a formula with per-request tiers see a typical request
 * rather than the sum of many.
 */
export function relayCostUsd(row, {
  inputTokens = 0,
  outputTokens = 0,
  cacheReadInputTokens = 0,
  requests = 1,
} = {}, atMs = Date.now()) {
  if (!row || row.input_usd_per_m === null || row.input_usd_per_m === undefined) return null;
  const input = Math.max(0, inputTokens || 0);
  const output = Math.max(0, outputTokens || 0);
  const cached = Math.max(0, cacheReadInputTokens || 0);
  if (row.billing) {
    const count = Math.max(1, requests || 1);
    const each = row.billing({ p: input / count, c: output / count, cr: cached / count }, atMs);
    if (each !== null) return (each * count * (row.group_ratio ?? 1)) / 1e6;
  }
  return (input * row.input_usd_per_m
    + cached * (row.cached_input_usd_per_m ?? row.input_usd_per_m)
    + output * (row.output_usd_per_m ?? 0)) / 1e6;
}

/**
 * How many times its usual price a row costs at `atMs`: 1 except where the
 * platform's formula charges more at that hour.
 */
export function relayPriceMultiplier(row, atMs = Date.now()) {
  if (!row?.billing || !(row.input_usd_per_m > 0)) return 1;
  const usual = row.input_usd_per_m + (row.output_usd_per_m ?? 0);
  const now = relayCostUsd(row, { inputTokens: 1e6, outputTokens: 1e6 }, atMs);
  return now === null || !(usual > 0) ? 1 : now / usual;
}

/** How long balance readings are kept to measure how fast the key is spent. */
const BALANCE_HISTORY_MS = 24 * 60 * 60_000;
/** The platform's counter lags and batches; a shorter span measures noise. */
const BURN_MIN_SPAN_MS = 30 * 60_000;
const BURN_MAX_SPAN_MS = 3 * 60 * 60_000;

/**
 * The platform's price list and the key's spend, refreshed in the background.
 *
 * Both are read-only and cost nothing. A failed refresh keeps the last good
 * reading and says so, the same way the account usage monitor does.
 */
export class RelayCatalog {
  constructor({
    store,
    fetchImpl = fetch,
    intervalMs = 60 * 60_000,
    balanceIntervalMs = 10 * 60_000,
    timeoutMs = 20_000,
    now = Date.now,
  } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.balanceIntervalMs = balanceIntervalMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.rows = [];
    this.balance = null;
    this.balanceHistory = [];
    this.fetchedAt = null;
    this.error = null;
    this.timer = null;
    this.balanceTimer = null;
    this.inFlight = null;
    this.balanceInFlight = null;
  }

  start() {
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    // The balance decides whether a source is still used, so it is read more
    // often than the price list, which changes rarely.
    this.balanceTimer = setInterval(() => this.refreshBalance().catch(() => {}), this.balanceIntervalMs);
    this.balanceTimer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    this.timer = null;
    this.balanceTimer = null;
  }

  async #getJson(url, headers = {}) {
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const settings = this.store.relaySettings();
      if (!settings.base_url) {
        this.rows = [];
        this.balance = null;
        this.error = 'not_configured';
        return;
      }
      try {
        this.rows = relayCatalogFromPricing(await this.#getJson(`${settings.base_url}/api/pricing`));
        this.fetchedAt = new Date().toISOString();
        this.error = null;
      } catch (error) {
        this.error = error?.name === 'TimeoutError' ? 'timeout' : (error?.message ?? 'unavailable');
      }
      await this.refreshBalance();
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** The key's limit and spend. A failed read keeps the last one. */
  async refreshBalance() {
    if (this.balanceInFlight) return this.balanceInFlight;
    this.balanceInFlight = (async () => {
      const settings = this.store.relaySettings();
      const apiKey = this.store.relayApiKey();
      if (!settings.base_url || !apiKey) return;
      try {
        const auth = { Authorization: `Bearer ${apiKey}` };
        const [subscription, usage] = await Promise.all([
          this.#getJson(`${settings.base_url}/v1/dashboard/billing/subscription`, auth),
          this.#getJson(`${settings.base_url}/v1/dashboard/billing/usage`, auth),
        ]);
        // OpenAI's billing shape, which new-api copies: the limit in dollars,
        // the usage in cents.
        const atMs = this.now();
        this.balance = {
          limit_usd: Number.isFinite(subscription?.hard_limit_usd) ? subscription.hard_limit_usd : null,
          used_usd: Number.isFinite(usage?.total_usage) ? usage.total_usage / 100 : null,
          fetched_at: new Date(atMs).toISOString(),
        };
        if (this.balance.used_usd !== null) {
          this.balanceHistory.push({ at_ms: atMs, used_usd: this.balance.used_usd });
          while (this.balanceHistory.length && this.balanceHistory[0].at_ms < atMs - BALANCE_HISTORY_MS) {
            this.balanceHistory.shift();
          }
        }
      } catch {
        // The price list alone is still worth showing.
      }
    })();
    try {
      return await this.balanceInFlight;
    } finally {
      this.balanceInFlight = null;
    }
  }

  /** What is left on the key, or null when either figure is unknown. */
  remainingUsd() {
    const balance = this.balance;
    return balance && balance.limit_usd !== null && balance.used_usd !== null
      ? balance.limit_usd - balance.used_usd
      : null;
  }

  /**
   * Dollars per hour the key is actually being spent at — by everyone holding
   * it, not only this gateway — measured across the last few readings. Null
   * until enough of them span long enough to mean something.
   */
  burnUsdPerHour() {
    const latest = this.balanceHistory.at(-1);
    if (!latest) return null;
    const earliest = this.balanceHistory.find((reading) => reading.at_ms >= latest.at_ms - BURN_MAX_SPAN_MS);
    const spanMs = latest.at_ms - (earliest?.at_ms ?? latest.at_ms);
    if (spanMs < BURN_MIN_SPAN_MS) return null;
    return Math.max(0, ((latest.used_usd - earliest.used_usd) / spanMs) * 3_600_000);
  }

  snapshot() {
    return {
      rows: this.rows,
      balance: this.balance
        ? { ...this.balance, remaining_usd: this.remainingUsd(), burn_usd_per_hour: this.burnUsdPerHour() }
        : null,
      fetched_at: this.fetchedAt,
      error: this.error,
    };
  }

  row(model) {
    return this.rows.find((row) => row.model === model) ?? null;
  }
}
