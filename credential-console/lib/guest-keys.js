/**
 * Guest keys: a gateway key for somebody outside the team, with a dollar
 * allowance instead of a seat.
 *
 * One key works on both the Claude and the Codex route. Behind it sits one
 * ordinary device per provider, so everything a device already has — account
 * policy, quota failover along the account's backup chain, metrics, the model
 * block rules — applies to a guest unchanged. What is new is only this:
 *
 *   - the key's accounts come from the guest pool, the accounts an
 *     administrator marked as open to guests;
 *   - every answered request is priced at the public API list price and added
 *     to the key's spend, and once the spend reaches the allowance inference
 *     is refused until an administrator tops the key up;
 *   - a guest key reaches the two subscription routes and nothing else: not
 *     the third-party models, not Bedrock, not machine control.
 *
 * This module is the arithmetic and the wording; the records live in the
 * store, the checks in the two proxies.
 */
import { sha256 } from './security.js';
import { claudeApiCostMicroUsd } from './claude-api-pricing.js';
import { OPENAI_LONG_CONTEXT_ABOVE, openaiApiCostUsd } from './openai-api-pricing.js';

export const GUEST_PROVIDERS = Object.freeze(['claude', 'codex']);
export const GUEST_KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const GUEST_KEY_MAX_ACTIVE = 200;
export const GUEST_KEY_MAX_NOTE = 200;
export const GUEST_KEY_MAX_TOPUPS = 50;
/** No key holds more than this: a million dollars, in micro-dollars. */
export const GUEST_BUDGET_MAX_MICRO_USD = 1_000_000 * 1_000_000;
/** What the dearest OpenAI model costs; a model nobody priced is charged this. */
const OPENAI_UNPRICED_FALLBACK_MODEL = 'gpt-6-astra';
/**
 * A cut-off Claude answer reports the output it had produced only in the
 * event that never arrived. Its streamed bytes stand in: an answer runs to
 * roughly forty decoded bytes of event framing and text per output token. No
 * model writes more than the cap in one answer.
 */
const CLAUDE_STREAM_BYTES_PER_OUTPUT_TOKEN = 40;
const CLAUDE_ESTIMATED_OUTPUT_CAP = 128_000;

/**
 * The response-usage limits for a guest's request. The ordinary limits stop
 * reading a long answer partway, which only costs the metrics page a count;
 * here the final count is the bill.
 */
export const GUEST_CLAUDE_USAGE_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxEvents: 1_000_000,
});

export function isGuestDevice(device) {
  return typeof device?.guest_key_id === 'string' && device.guest_key_id.length > 0;
}

/** Whether an account is open to guest keys. */
export function isGuestPoolAccount(account) {
  return account?.guest_pool?.enabled === true;
}

/**
 * The machine handle both of a key's devices carry, so the machine inventory
 * shows a guest as one machine. Derived, not stored: it means nothing else.
 */
export function guestMachineId(keyId) {
  return sha256(`guest-key ${keyId}`).slice(0, 40);
}

/**
 * Dollars typed into a form, as whole micro-dollars. Up to six decimals, so
 * the amount is exact; anything else is refused rather than rounded.
 */
export function parseUsdAmount(value) {
  const text = String(value ?? '').trim().replace(/^\$/, '');
  if (!/^\d{1,7}(?:\.\d{1,6})?$/.test(text)) {
    throw new Error('enter an amount in US dollars, such as 20 or 2.50');
  }
  const [whole, fraction = ''] = text.split('.');
  const microUsd = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (microUsd <= 0) throw new Error('the amount must be more than zero');
  if (microUsd > GUEST_BUDGET_MAX_MICRO_USD) throw new Error('the amount is too large');
  return microUsd;
}

const tokens = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/**
 * What one answered request costs a guest key, in whole micro-dollars.
 *
 * `snapshot` is the usage parser's own snapshot (the four counts in the
 * console's Anthropic-shaped columns, plus `usageState` and `bytesSeen`);
 * `cacheDetail` is the Claude parser's split of the cache write by lifetime.
 */
export function guestCostMicroUsd({ provider, model, snapshot, cacheDetail = null }) {
  const usage = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const input = tokens(usage.inputTokens);
  const cacheWrite = tokens(usage.cacheCreationInputTokens);
  const cacheRead = tokens(usage.cacheReadInputTokens);
  let output = tokens(usage.outputTokens);
  if (provider === 'codex') {
    const counts = {
      longContext: input + cacheWrite + cacheRead > OPENAI_LONG_CONTEXT_ABOVE,
      input,
      cacheWrite,
      cacheRead,
      output,
    };
    const usd = openaiApiCostUsd(model, counts);
    return {
      microUsd: Math.max(0, Math.ceil((usd ?? openaiApiCostUsd(OPENAI_UNPRICED_FALLBACK_MODEL, counts)) * 1e6 - 1e-6)),
      priced: usd !== null,
      estimated: false,
    };
  }
  let estimated = false;
  if (usage.usageState !== 'complete') {
    const guess = Math.min(
      CLAUDE_ESTIMATED_OUTPUT_CAP,
      Math.ceil(tokens(usage.bytesSeen) / CLAUDE_STREAM_BYTES_PER_OUTPUT_TOKEN),
    );
    if (guess > output) {
      output = guess;
      estimated = true;
    }
  }
  const cacheWrite1h = Math.min(cacheWrite, tokens(cacheDetail?.ephemeral1hInputTokens));
  const cost = claudeApiCostMicroUsd(model, {
    input,
    cacheWrite5m: cacheWrite - cacheWrite1h,
    cacheWrite1h,
    cacheRead,
    output,
  });
  return { ...cost, estimated };
}

/** Micro-dollars as the dollars a person reads: `$12.34`, or `$0.0042` when small. */
export function formatMicroUsd(microUsd) {
  const usd = (Number(microUsd) || 0) / 1e6;
  const digits = Math.abs(usd) > 0 && Math.abs(usd) < 1 ? 4 : 2;
  return `$${usd.toFixed(digits)}`;
}

/** What a guest whose allowance is spent is told, in both languages. */
export function guestBudgetMessage({ name, budgetMicroUsd, revoked = false }) {
  if (revoked) {
    return `Guest key "${name}" has been revoked. 访客 Key「${name}」已被吊销。`;
  }
  const budget = formatMicroUsd(budgetMicroUsd);
  return `Guest key "${name}" has used up its ${budget} allowance. Ask the administrator who issued it for a top-up. `
    + `访客 Key「${name}」的 ${budget} 额度已用完，请联系发放它的管理员充值。`;
}

/**
 * Charge a guest key for a request that has just finished. Called by both
 * proxies where they write the request's metrics row; never throws, because
 * the response it accounts for has already been sent.
 */
export function chargeGuestRequest({ store, device, provider, model, parser, log = () => {} }) {
  if (!isGuestDevice(device) || !parser || typeof store?.chargeGuestKey !== 'function') return null;
  try {
    const cost = guestCostMicroUsd({
      provider,
      model,
      snapshot: parser.snapshot?.(),
      cacheDetail: parser.cacheCreationDetail?.() ?? null,
    });
    store.chargeGuestKey(device.guest_key_id, { provider, microUsd: cost.microUsd });
    if (!cost.priced || cost.estimated) {
      log('guest_key_charge_approximate', {
        guest_key_id: device.guest_key_id,
        device_id: device.id,
        model: model ?? null,
        priced: cost.priced,
        estimated: cost.estimated,
        micro_usd: cost.microUsd,
      });
    }
    return cost;
  } catch (error) {
    log('guest_key_charge_failed', {
      guest_key_id: device.guest_key_id,
      device_id: device.id,
      code: error?.code ?? error?.name ?? 'unknown',
    });
    return null;
  }
}
