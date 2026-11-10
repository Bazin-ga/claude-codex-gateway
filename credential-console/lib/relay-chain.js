/**
 * One model served by several interchangeable sources, tried in order.
 *
 * The same open-weight model can be had from more than one place — a paid
 * platform, a second platform, a self-hosted server — and each of them runs
 * out, slows down or disappears on its own schedule. A chain gives the model
 * one name for clients and an ordered list of sources behind it. A turn goes
 * to the first source that is usable; a source that fails before any byte has
 * reached the client is put aside for a while and the turn is retried on the
 * next. Nothing is balanced or raced: order is the administrator's statement
 * of preference, and only failure moves a turn down it.
 *
 * A conversation that was moved to a fallback stays there for a while even
 * after the preferred source recovers. Sources differ in what they keep
 * between turns (prompt caches, whether reasoning is passed back), so
 * bouncing a live conversation between them costs more than it saves.
 */
import { relayBaseUrl, relayModelName } from './relay.js';

export const RELAY_MAX_CHAINS = 8;
export const RELAY_MAX_SOURCES = 8;
export const RELAY_MAX_ALIASES = 8;
/** Lower-case so a source's metrics alias (`relay:<name>`) has one spelling. */
export const RELAY_SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SOURCE_ID = /^[a-f0-9]{8,32}$/;
/** `platform` borrows the console's platform address and key; `endpoint` has its own. */
export const RELAY_SOURCE_KINDS = ['platform', 'endpoint'];

/**
 * How long a streaming turn waits for a source's response headers before the
 * next source is tried. Only applied while there is a next source.
 */
export const RELAY_FIRST_BYTE_TIMEOUT_DEFAULT_S = 60;
export const RELAY_FIRST_BYTE_TIMEOUT_MIN_S = 5;
export const RELAY_FIRST_BYTE_TIMEOUT_MAX_S = 600;

const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 10 * 60_000;
/** A source that says it is out of money will say so again in thirty seconds. */
const BALANCE_COOLDOWN_MS = 10 * 60_000;
export const RELAY_PIN_MS = 30 * 60_000;
const MAX_PINS = 5000;

function price(value) {
  const amount = (entry) => (Number.isFinite(entry) && entry >= 0 ? entry : null);
  const input = amount(value?.input_usd_per_m);
  const output = amount(value?.output_usd_per_m);
  if (input === null || output === null) return null;
  return {
    input_usd_per_m: input,
    output_usd_per_m: output,
    cached_input_usd_per_m: amount(value?.cached_input_usd_per_m),
  };
}

function firstByteTimeout(value) {
  return Number.isInteger(value)
    && value >= RELAY_FIRST_BYTE_TIMEOUT_MIN_S
    && value <= RELAY_FIRST_BYTE_TIMEOUT_MAX_S
    ? value
    : RELAY_FIRST_BYTE_TIMEOUT_DEFAULT_S;
}

function normalizeSource(value) {
  const id = typeof value?.id === 'string' && SOURCE_ID.test(value.id) ? value.id : null;
  const name = typeof value?.name === 'string' && RELAY_SOURCE_NAME.test(value.name) ? value.name : null;
  const kind = RELAY_SOURCE_KINDS.includes(value?.kind) ? value.kind : null;
  const upstreamModel = relayModelName(value?.upstream_model);
  const baseUrl = kind === 'endpoint' ? relayBaseUrl(value?.base_url) : null;
  if (!id || !name || !kind || !upstreamModel || (kind === 'endpoint' && !baseUrl)) return null;
  return {
    id,
    name,
    kind,
    base_url: baseUrl,
    upstream_model: upstreamModel,
    enabled: value.enabled !== false,
    // Only a platform source has a balance this console can read.
    min_balance_usd: kind === 'platform' && Number.isFinite(value.min_balance_usd) && value.min_balance_usd >= 0
      ? value.min_balance_usd
      : null,
    price: price(value.price),
    first_byte_timeout_s: firstByteTimeout(value.first_byte_timeout_s),
    credential: kind === 'endpoint' && value.credential ? value.credential : null,
  };
}

/**
 * The stored chains, normalized, credentials included. An entry that cannot
 * be understood is dropped rather than half-used: a chain decides where paid
 * requests go.
 */
export function normalizeRelayChains(value) {
  const chains = [];
  const names = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    if (chains.length >= RELAY_MAX_CHAINS) break;
    const model = relayModelName(entry?.model);
    if (!model || names.has(model)) continue;
    names.add(model);
    const aliases = [];
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
      const name = relayModelName(alias);
      if (!name || names.has(name) || aliases.length >= RELAY_MAX_ALIASES) continue;
      names.add(name);
      aliases.push(name);
    }
    const sources = [];
    for (const candidate of Array.isArray(entry.sources) ? entry.sources : []) {
      const source = normalizeSource(candidate);
      if (!source || sources.length >= RELAY_MAX_SOURCES) continue;
      if (sources.some((other) => other.id === source.id || other.name === source.name)) continue;
      sources.push(source);
    }
    chains.push({
      model,
      aliases,
      sources,
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      updated_by: typeof entry.updated_by === 'string' ? entry.updated_by : null,
    });
  }
  return chains;
}

/** A chain as pages and the proxy see it: whether a key is stored, never the key. */
export function publicRelayChain(chain) {
  return {
    ...chain,
    sources: chain.sources.map(({ credential, ...source }) => ({ ...source, has_key: Boolean(credential) })),
  };
}

/** The chain that answers to `model`, by its own name or an alias. */
export function relayChainFor(chains, model) {
  if (typeof model !== 'string') return null;
  return chains.find((chain) => chain.model === model || chain.aliases.includes(model)) ?? null;
}

function dollars(value, what) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const amount = /^\d{1,7}(\.\d{1,6})?$/.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(amount)) throw new Error(`${what} must be a plain number of dollars`);
  return amount;
}

/**
 * A chain's name and aliases as submitted, validated against the other chains:
 * a name can only ever mean one chain.
 */
export function parseRelayChainInput({ model, aliases = '' }, { others = [] } = {}) {
  const name = relayModelName(model);
  if (!name) throw new Error('a valid model name is required');
  const list = [];
  for (const entry of (Array.isArray(aliases) ? aliases : String(aliases ?? '').split(/[\s,;]+/))) {
    const text = String(entry ?? '').trim();
    if (!text) continue;
    const alias = relayModelName(text);
    if (!alias) throw new Error(`"${text.slice(0, 64)}" is not a valid model name`);
    if (alias !== name && !list.includes(alias)) list.push(alias);
  }
  if (list.length > RELAY_MAX_ALIASES) throw new Error(`at most ${RELAY_MAX_ALIASES} other names`);
  for (const other of others) {
    for (const taken of [other.model, ...other.aliases]) {
      if (taken === name || list.includes(taken)) throw new Error(`"${taken}" already names another chain`);
    }
  }
  return { model: name, aliases: list };
}

/**
 * A source as submitted from the console or an import file, validated. The
 * key is returned apart from the record: the caller encrypts it, or keeps the
 * one already stored when none was given.
 */
export function parseRelaySourceInput(input) {
  const name = String(input?.name ?? '').trim();
  if (!RELAY_SOURCE_NAME.test(name)) {
    throw new Error('a source name of lower-case letters, digits, dot, dash or underscore is required');
  }
  const kind = String(input?.kind ?? '').trim();
  if (!RELAY_SOURCE_KINDS.includes(kind)) throw new Error('a source is either the platform or its own endpoint');
  const upstreamModel = relayModelName(input?.upstream_model ?? input?.upstreamModel);
  if (!upstreamModel) throw new Error('the model name the source knows is required');
  const baseUrl = kind === 'endpoint' ? relayBaseUrl(input?.base_url ?? input?.baseUrl) : null;
  if (kind === 'endpoint' && !baseUrl) throw new Error('a valid http(s) address is required');
  const apiKey = kind === 'endpoint' ? String(input?.api_key ?? input?.apiKey ?? '').trim() : '';
  if (apiKey && !/^[\x21-\x7e]{8,512}$/.test(apiKey)) throw new Error('the source API key looks malformed');

  const inputPrice = dollars(input?.input_usd_per_m, 'the input price');
  const outputPrice = dollars(input?.output_usd_per_m, 'the output price');
  const cachedPrice = dollars(input?.cached_input_usd_per_m, 'the cached-input price');
  if ((inputPrice === null) !== (outputPrice === null)) {
    throw new Error('give both the input and the output price, or neither');
  }
  if (inputPrice === null && cachedPrice !== null) throw new Error('a cached-input price needs the other two');

  const timeoutText = String(input?.first_byte_timeout_s ?? '').trim();
  const timeout = timeoutText ? (/^\d{1,3}$/.test(timeoutText) ? Number(timeoutText) : NaN) : RELAY_FIRST_BYTE_TIMEOUT_DEFAULT_S;
  if (!(timeout >= RELAY_FIRST_BYTE_TIMEOUT_MIN_S && timeout <= RELAY_FIRST_BYTE_TIMEOUT_MAX_S)) {
    throw new Error(`the first-byte wait must be ${RELAY_FIRST_BYTE_TIMEOUT_MIN_S} to ${RELAY_FIRST_BYTE_TIMEOUT_MAX_S} seconds`);
  }
  const minBalance = dollars(input?.min_balance_usd, 'the balance line');
  if (minBalance !== null && kind !== 'platform') {
    throw new Error('only the platform source has a balance the console can read');
  }
  return {
    source: {
      name,
      kind,
      base_url: baseUrl,
      upstream_model: upstreamModel,
      enabled: input?.enabled !== false && input?.enabled !== 'false',
      min_balance_usd: minBalance,
      price: inputPrice === null
        ? null
        : { input_usd_per_m: inputPrice, output_usd_per_m: outputPrice, cached_input_usd_per_m: cachedPrice },
      first_byte_timeout_s: timeout,
    },
    apiKey,
  };
}

/** Upstream answers that mean "this source cannot take the turn", not "this turn is wrong". */
export function relayFailoverStatus(status) {
  return status >= 500 || [401, 402, 403, 404, 405, 408, 429].includes(status);
}

/**
 * Of those, the ones that say nothing of the source's health: it does not
 * serve this endpoint or this model, and is as fit for every other turn as it
 * was. The turn goes on to the next source and this one is not rested.
 */
export function relayRequestOnlyStatus(status) {
  return status === 404 || status === 405;
}

// "quota" and "额度" alone are also how a rate limit is worded.
const BALANCE_REFUSAL = /insufficient|balance|billing|arrears|quota (?:is )?not enough|exceeded your current quota|余额|欠费|额度(?:不足|已用尽|已耗尽|已用完)/i;

/** Whether a refusal is the source saying its account is out of money. */
export function relayBalanceRefusal(status, text) {
  return status === 402 || ([401, 403, 429].includes(status) && BALANCE_REFUSAL.test(text ?? ''));
}

/**
 * What the proxy remembers about sources between turns: which are being
 * rested after failing, and which conversations were moved to a fallback.
 * In memory only — a restart forgets it, and the first failure relearns it.
 */
export function createRelaySourceHealth({ now = Date.now } = {}) {
  const states = new Map();
  const pins = new Map();
  const state = (id) => {
    let entry = states.get(id);
    if (!entry) {
      entry = { failures: 0, coolingUntilMs: 0, lastFailure: null, lastSuccessAtMs: null };
      states.set(id, entry);
    }
    return entry;
  };

  return {
    /** A failed attempt: rest the source, longer each time in a row. */
    failure(id, { status = null, reason = null, balance = false } = {}) {
      const entry = state(id);
      entry.failures += 1;
      const wait = balance
        ? BALANCE_COOLDOWN_MS
        : Math.min(COOLDOWN_BASE_MS * 2 ** Math.min(entry.failures - 1, 10), COOLDOWN_MAX_MS);
      entry.coolingUntilMs = Math.max(entry.coolingUntilMs, now() + wait);
      entry.lastFailure = { at_ms: now(), status, reason, balance };
    },
    success(id) {
      const entry = state(id);
      entry.failures = 0;
      entry.coolingUntilMs = 0;
      entry.lastSuccessAtMs = now();
    },
    /** When the source's rest ends, or 0 when it is not resting. */
    coolingUntil(id) {
      const until = states.get(id)?.coolingUntilMs ?? 0;
      return until > now() ? until : 0;
    },
    /** For the console: one source's state, without creating it. */
    describe(id) {
      const entry = states.get(id);
      return {
        cooling_until_ms: entry && entry.coolingUntilMs > now() ? entry.coolingUntilMs : null,
        failures: entry?.failures ?? 0,
        last_failure: entry?.lastFailure ?? null,
        last_success_at_ms: entry?.lastSuccessAtMs ?? null,
      };
    },
    /** The source a conversation was moved to, while that still holds. */
    pinned(key) {
      if (!key) return null;
      const pin = pins.get(key);
      if (!pin) return null;
      if (pin.untilMs <= now()) {
        pins.delete(key);
        return null;
      }
      return pin.sourceId;
    },
    /**
     * Keep a conversation on the fallback that just served it. The hold runs
     * from the move and is not extended by use, so every conversation finds
     * its way back to the preferred source.
     */
    pin(key, sourceId) {
      if (!key) return;
      const current = pins.get(key);
      if (current && current.sourceId === sourceId && current.untilMs > now()) return;
      pins.delete(key);
      pins.set(key, { sourceId, untilMs: now() + RELAY_PIN_MS });
      // Every hold lasts the same, so the oldest entry is the first to lapse.
      while (pins.size > MAX_PINS) pins.delete(pins.keys().next().value);
    },
    unpin(key) {
      if (key) pins.delete(key);
    },
  };
}

/**
 * The order in which a turn tries a chain's sources. `usable` are the sources
 * that could take it at all (enabled, configured, above their balance line),
 * in chain order. A conversation's pinned source goes first; then the ones
 * not resting; the resting ones are kept as a last resort, soonest back
 * first, because a source that failed a minute ago beats no answer at all.
 */
export function planRelaySources(usable, { health, pinnedId = null }) {
  const ready = [];
  const resting = [];
  for (const source of usable) {
    const until = health.coolingUntil(source.id);
    if (until) resting.push({ source, until });
    else ready.push(source);
  }
  resting.sort((left, right) => left.until - right.until);
  const order = [...ready, ...resting.map((entry) => entry.source)];
  const pinned = pinnedId ? ready.find((source) => source.id === pinnedId) : null;
  return pinned ? [pinned, ...order.filter((source) => source !== pinned)] : order;
}

/** Upstream 400s that are about reasoning the conversation does not carry. */
export const RELAY_THINKING_REFUSAL = /thinking|reasoning/i;

/**
 * The same request with reasoning switched off and no reasoning left in its
 * history, or null when there was nothing to change.
 *
 * A model in thinking mode insists that each assistant turn's reasoning is
 * passed back. A conversation that began on a source which emits none — or
 * whose client dropped it — can then never continue on a source that does:
 * every turn is refused with a 400. Without reasoning the turn runs.
 */
export function relayRequestWithoutThinking(kind, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (kind === 'messages') {
    if (parsed.thinking?.type === 'disabled') return null;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.map((message) => {
        if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
        const content = message.content.filter((block) => !['thinking', 'redacted_thinking'].includes(block?.type));
        // A turn that was only reasoning is left alone: an empty one is refused too.
        return content.length === 0 || content.length === message.content.length ? message : { ...message, content };
      })
      : parsed.messages;
    return { ...parsed, messages, thinking: { type: 'disabled' } };
  }
  if (kind === 'responses') {
    if (parsed.reasoning?.effort === 'none') return null;
    const input = Array.isArray(parsed.input)
      ? parsed.input.filter((item) => item?.type !== 'reasoning')
      : parsed.input;
    const { include, ...rest } = parsed;
    const kept = Array.isArray(include) ? include.filter((entry) => !String(entry).startsWith('reasoning.')) : include;
    return {
      ...rest,
      ...(kept === undefined ? {} : { include: kept }),
      input,
      reasoning: { effort: 'none' },
    };
  }
  if (parsed.thinking?.type === 'disabled') return null;
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages.map((message) => {
      if (message?.role !== 'assistant' || !('reasoning_content' in message)) return message;
      const { reasoning_content: dropped, ...rest } = message;
      return rest;
    })
    : parsed.messages;
  return { ...parsed, messages, thinking: { type: 'disabled' } };
}
