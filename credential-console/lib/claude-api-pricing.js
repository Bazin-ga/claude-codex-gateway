/**
 * What a Claude request would cost at the public API list price.
 *
 * A subscription account is not billed by the token, so nothing upstream says
 * what a request "cost". A guest key's allowance is in dollars all the same,
 * so the gateway prices the tokens it counted the way the Messages API would
 * have: uncached input, cache writes (5-minute and 1-hour apart — the 1-hour
 * write is double the base input price), cache reads and output.
 *
 * Not priced: the fast-mode premium, the `inference_geo` multiplier and
 * server-tool fees (web search is billed per search). A guest key is an
 * allowance, not an invoice.
 */

/** When the prices below were read off the Anthropic pricing page. */
export const CLAUDE_PRICES_AS_OF = '2026-11-10';

/** Haiku 5.5 bills the whole request at a higher rate above this prompt size. */
export const CLAUDE_HAIKU_LONG_PROMPT_ABOVE = 100_000;

// USD per million tokens, which is also micro-dollars per token.
const price = (input, write5m, write1h, read, output) => ({ input, write5m, write1h, read, output });
const FABLE_5_2 = price(8, 10, 16, 0.20, 40);
const FABLE_5_1 = price(10, 12.50, 20, 0.25, 50);
const FABLE_5 = price(10, 12.50, 20, 1, 50);
const OPUS_5 = price(5, 6.25, 10, 0.50, 25);
const OPUS_4 = price(15, 18.75, 30, 1.50, 75);
const SONNET_4 = price(3, 3.75, 6, 0.30, 15);
const CLAUDE_API_PRICES = Object.freeze({
  'claude-fable-5-2': { short: FABLE_5_2 },
  'claude-mythos-5-2': { short: FABLE_5_2 },
  'claude-fable-5-1': { short: FABLE_5_1 },
  'claude-mythos-5-1': { short: FABLE_5_1 },
  'claude-fable-5': { short: FABLE_5 },
  'claude-mythos-5': { short: FABLE_5 },
  'claude-opus-5-5': { short: price(4, 5, 8, 0.20, 20) },
  'claude-opus-5': { short: OPUS_5 },
  'claude-opus-4-8': { short: OPUS_5 },
  'claude-opus-4-7': { short: OPUS_5 },
  'claude-opus-4-6': { short: OPUS_5 },
  'claude-opus-4-5': { short: OPUS_5 },
  'claude-opus-4-1': { short: OPUS_4 },
  'claude-opus-4': { short: OPUS_4 },
  'claude-sonnet-5-5': { short: price(2, 2.50, 4, 0.10, 10) },
  'claude-sonnet-5': { short: price(2, 2.50, 4, 0.20, 10) },
  'claude-sonnet-4-6': { short: SONNET_4 },
  'claude-sonnet-4-5': { short: SONNET_4 },
  'claude-sonnet-4': { short: SONNET_4 },
  'claude-haiku-5-5': {
    short: price(0.10, 0.125, 0.20, 0.01, 0.50),
    long: price(0.50, 0.625, 1, 0.05, 2.50),
    longAbove: CLAUDE_HAIKU_LONG_PROMPT_ABOVE,
  },
  'claude-haiku-4-5': { short: price(1, 1.25, 2, 0.10, 5) },
});

/**
 * What a model nobody priced is charged at: the dearest row there is. An
 * allowance that a new or misspelt model name could spend for free would not
 * be an allowance.
 */
export const CLAUDE_UNPRICED_FALLBACK = Object.freeze({ short: OPUS_4 });

/**
 * The name the price table knows a model by: lower case, without Claude Code's
 * `[1m]` context marker and without a cloud vendor's prefix
 * (`us.anthropic.claude-…`).
 */
export function claudePricedModelName(model) {
  let name = String(model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  const at = name.lastIndexOf('claude-');
  if (at > 0) name = name.slice(at);
  return name;
}

/**
 * The price row for a model, or null. A dated snapshot
 * (`claude-haiku-4-5-20251001`) is priced as the model it snapshots: the
 * longest table name the model's name starts with wins, so `claude-opus-4-1-…`
 * is Opus 4.1 and not Opus 4.
 */
export function claudeApiPrice(model) {
  const name = claudePricedModelName(model);
  if (Object.hasOwn(CLAUDE_API_PRICES, name)) return CLAUDE_API_PRICES[name];
  const base = Object.keys(CLAUDE_API_PRICES)
    .filter((key) => name.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? CLAUDE_API_PRICES[base] : null;
}

const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/**
 * Micro-dollars for one request, rounded up, and whether the model was in the
 * table. `cacheWrite1h` is the part of the cache write that asked for the
 * one-hour lifetime; `cacheWrite5m` is the rest.
 */
export function claudeApiCostMicroUsd(model, {
  input = 0,
  cacheWrite5m = 0,
  cacheWrite1h = 0,
  cacheRead = 0,
  output = 0,
} = {}) {
  const row = claudeApiPrice(model);
  const priced = row ?? CLAUDE_UNPRICED_FALLBACK;
  const tokens = {
    input: count(input),
    write5m: count(cacheWrite5m),
    write1h: count(cacheWrite1h),
    read: count(cacheRead),
    output: count(output),
  };
  const prompt = tokens.input + tokens.write5m + tokens.write1h + tokens.read;
  const rate = priced.long && prompt > priced.longAbove ? priced.long : priced.short;
  const microUsd = tokens.input * rate.input
    + tokens.write5m * rate.write5m
    + tokens.write1h * rate.write1h
    + tokens.read * rate.read
    + tokens.output * rate.output;
  return { microUsd: Math.max(0, Math.ceil(microUsd - 1e-9)), priced: row !== null };
}
