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
    const input = perCall ? null : ratio * USD_PER_MILLION_AT_RATIO_ONE * factor;
    const cacheRatio = Number(entry.cache_ratio);
    rows.push({
      model,
      vendor: vendors.get(entry.vendor_id) ?? (typeof entry.owner_by === 'string' ? entry.owner_by : '') ?? '',
      group,
      per_call_usd: perCall ? (Number(entry.model_price) || 0) * factor : null,
      input_usd_per_m: input,
      output_usd_per_m: input === null ? null : input * (Number(entry.completion_ratio) || 1),
      cached_input_usd_per_m: input === null || !Number.isFinite(cacheRatio) || cacheRatio <= 0
        ? null
        : input * cacheRatio,
      placeholder: !perCall && ratio === RELAY_PLACEHOLDER_RATIO,
      endpoints: (Array.isArray(entry.supported_endpoint_types) ? entry.supported_endpoint_types : [])
        .filter((type) => typeof type === 'string'),
    });
  }
  rows.sort((a, b) => (a.vendor || '~').localeCompare(b.vendor || '~')
    || (a.input_usd_per_m ?? Infinity) - (b.input_usd_per_m ?? Infinity)
    || a.model.localeCompare(b.model));
  return rows;
}

/** The estimated dollar cost of a token count at a catalog row's prices. */
export function relayCostUsd(row, { inputTokens = 0, outputTokens = 0, cacheReadInputTokens = 0 } = {}) {
  if (!row || row.input_usd_per_m === null) return null;
  const cached = Math.min(cacheReadInputTokens || 0, inputTokens || 0);
  const cachedPrice = row.cached_input_usd_per_m ?? row.input_usd_per_m;
  return ((inputTokens - cached) * row.input_usd_per_m
    + cached * cachedPrice
    + (outputTokens || 0) * row.output_usd_per_m) / 1e6;
}

/**
 * The platform's price list and the key's spend, refreshed in the background.
 *
 * Both are read-only and cost nothing. A failed refresh keeps the last good
 * reading and says so, the same way the account usage monitor does.
 */
export class RelayCatalog {
  constructor({ store, fetchImpl = fetch, intervalMs = 60 * 60_000, timeoutMs = 20_000 } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.rows = [];
    this.balance = null;
    this.fetchedAt = null;
    this.error = null;
    this.timer = null;
    this.inFlight = null;
  }

  start() {
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      const apiKey = this.store.relayApiKey();
      if (!apiKey) return;
      try {
        const auth = { Authorization: `Bearer ${apiKey}` };
        const [subscription, usage] = await Promise.all([
          this.#getJson(`${settings.base_url}/v1/dashboard/billing/subscription`, auth),
          this.#getJson(`${settings.base_url}/v1/dashboard/billing/usage`, auth),
        ]);
        // OpenAI's billing shape, which new-api copies: the limit in dollars,
        // the usage in cents.
        this.balance = {
          limit_usd: Number.isFinite(subscription?.hard_limit_usd) ? subscription.hard_limit_usd : null,
          used_usd: Number.isFinite(usage?.total_usage) ? usage.total_usage / 100 : null,
          fetched_at: new Date().toISOString(),
        };
      } catch {
        // The price list alone is still worth showing.
      }
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  snapshot() {
    return {
      rows: this.rows,
      balance: this.balance,
      fetched_at: this.fetchedAt,
      error: this.error,
    };
  }

  row(model) {
    return this.rows.find((row) => row.model === model) ?? null;
  }
}
