/**
 * What an OpenAI API-key account costs, estimated from the tokens the gateway
 * recorded.
 *
 * A project key (`sk-proj-…`) cannot read the organization's billing, so the
 * console prices what it already counts: every request's uncached input, cache
 * writes, cache reads and output, at the public list price. OpenAI charges the
 * whole request at the long-context rate once its prompt passes 272K tokens,
 * which is why the grouping keeps long and short requests apart rather than
 * pricing a sum.
 */

/** Prompts above this many input tokens are billed at the long-context rate. */
export const OPENAI_LONG_CONTEXT_ABOVE = 272_000;

/** When the prices below were read off the OpenAI pricing page. */
export const OPENAI_PRICES_AS_OF = '2026-10-25';

// USD per million tokens, Standard tier. Cache writes are the 30-minute rate:
// Codex asks for `prompt_cache_options.ttl: "30m"`; the 12-hour rate is double.
const price = (input, cached, write, output) => ({ input, cached, write, output });
const OPENAI_API_PRICES = Object.freeze({
  'gpt-6-luna': { short: price(0.10, 0.01, 0.125, 0.50), long: price(0.20, 0.02, 0.25, 0.75) },
  'gpt-6-sol': { short: price(2.00, 0.20, 2.50, 10.00), long: price(4.00, 0.40, 5.00, 15.00) },
  'gpt-6.1-sol': { short: price(2.00, 0.10, 2.50, 10.00), long: price(4.00, 0.20, 5.00, 15.00) },
  'gpt-6-astra': { short: price(10.00, 1.00, 12.50, 50.00), long: price(20.00, 2.00, 25.00, 75.00) },
});

/**
 * The price row for a model, or null. Accepts a dated snapshot name
 * (`gpt-6-luna-2026-09-30`) as the model it snapshots.
 */
export function openaiApiPrice(model) {
  const name = String(model ?? '').toLowerCase();
  if (Object.hasOwn(OPENAI_API_PRICES, name)) return OPENAI_API_PRICES[name];
  const base = Object.keys(OPENAI_API_PRICES)
    .filter((key) => name.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? OPENAI_API_PRICES[base] : null;
}

/** Dollars for one group of requests that share a model and a context tier. */
export function openaiApiCostUsd(model, { longContext = false, input = 0, cacheWrite = 0, cacheRead = 0, output = 0 } = {}) {
  const row = openaiApiPrice(model);
  if (!row) return null;
  const rate = longContext ? row.long : row.short;
  return (input * rate.input + cacheWrite * rate.write + cacheRead * rate.cached + output * rate.output) / 1e6;
}

/** The windows the card shows, by the `period` the query assigns. */
export const API_SPEND_PERIODS = Object.freeze([
  { key: 'day', ms: 86_400_000 },
  { key: 'week', ms: 7 * 86_400_000 },
  { key: 'month', ms: 30 * 86_400_000 },
]);

/**
 * Fold the query's groups into what the card shows: spend per window, and
 * the last 30 days by model and by device.
 *
 * `groups` rows carry model, device_id, long_context, period (0 = last day,
 * 1 = last week, 2 = older), requests, without_usage and the four token sums.
 * Each row counts toward its own window and every wider one.
 * `describeDevice(id)` names a device: `{ label, note }`.
 */
export function summarizeApiSpend(groups, { describeDevice = (id) => ({ label: id ?? '—' }), computedAt = new Date().toISOString() } = {}) {
  const totals = Object.fromEntries(API_SPEND_PERIODS.map(({ key }) => [key, 0]));
  const byModel = new Map();
  const byDevice = new Map();
  let requests = 0;
  let withoutUsage = 0;
  const unpriced = new Set();
  const add = (map, key, names, row, cost) => {
    const entry = map.get(key) ?? { label: names.label, note: names.note ?? null, requests: 0, tokens: 0, costUsd: 0 };
    entry.requests += row.requests;
    entry.tokens += row.input + row.cacheWrite + row.cacheRead + row.output;
    entry.costUsd += cost ?? 0;
    map.set(key, entry);
  };
  for (const raw of Array.isArray(groups) ? groups : []) {
    const row = {
      model: raw.model ?? null,
      deviceId: raw.device_id ?? null,
      longContext: Boolean(raw.long_context),
      period: Number(raw.period),
      requests: Number(raw.requests) || 0,
      withoutUsage: Number(raw.without_usage) || 0,
      input: Number(raw.input_tokens) || 0,
      cacheWrite: Number(raw.cache_write_tokens) || 0,
      cacheRead: Number(raw.cache_read_tokens) || 0,
      output: Number(raw.output_tokens) || 0,
    };
    const cost = openaiApiCostUsd(row.model, row);
    if (cost === null && row.requests > row.withoutUsage) unpriced.add(row.model ?? '—');
    API_SPEND_PERIODS.forEach(({ key }, index) => {
      if (row.period <= index) totals[key] += cost ?? 0;
    });
    requests += row.requests;
    withoutUsage += row.withoutUsage;
    add(byModel, row.model ?? '—', { label: row.model ?? '—' }, row, cost);
    add(byDevice, row.deviceId ?? '—', describeDevice(row.deviceId), row, cost);
  }
  const sorted = (map) => [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
  return {
    computed_at: computedAt,
    totals,
    requests,
    without_usage: withoutUsage,
    unpriced_models: [...unpriced].sort(),
    models: sorted(byModel),
    devices: sorted(byDevice),
  };
}
