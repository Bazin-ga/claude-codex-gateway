import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

/**
 * Usage parsing for the Codex (OpenAI Responses) wire format.
 *
 * Deliberately a sibling of ResponseUsageParser rather than a mode inside it:
 * the two protocols agree on almost nothing.  Anthropic dispatches usage across
 * `message_start` and `message_delta`; the Responses API reports it once, in
 * whichever terminal event ends the turn.  Folding both into one state machine
 * would put every Claude request at risk of a Codex-shaped bug, and the Claude
 * path carries essentially all of today's traffic.
 *
 * The interface is identical on purpose — push/finish/snapshot with the same
 * snapshot keys — so the proxy's observer plumbing takes either one unchanged.
 */
export const CODEX_USAGE_MAX_BYTES = 1024 * 1024;
export const CODEX_USAGE_MAX_EVENTS = 8192;

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_EVENTS = 32 * 1024;
const AUTO_DETECT_CHARS = 256;

/**
 * The events that end a turn. `response.completed` is the ordinary one;
 * a turn that hits a length cap or fails still reports the tokens it burned,
 * and those are exactly the turns worth accounting for.
 */
const TERMINAL_TYPES = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);

function emptyUsage() {
  return {
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
  };
}

function boundedLimit(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asBytes(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Read one field of the input-token breakdown.
 *
 * Observed live against chatgpt.com/backend-api/codex/responses, which nests the
 * breakdown: `input_tokens_details: { cached_tokens, cache_write_tokens }`. The
 * flat spellings are accepted as well because the public Responses API and this
 * backend have not always agreed, and guessing wrong silently loses a column.
 */
function inputDetail(usage, nested, flat) {
  const direct = tokenCount(usage[flat]);
  if (direct !== null) return direct;
  const details = usage.input_tokens_details;
  return isRecord(details) ? tokenCount(details[nested]) : null;
}

/**
 * Translate OpenAI token accounting into the Anthropic-shaped columns the rest
 * of this console stores and sums.
 *
 * The two vendors disagree about what "input" means, and the difference is not
 * cosmetic. OpenAI's `input_tokens` is the whole prompt and
 * `input_tokens_details` is a breakdown *of* it; Anthropic's `input_tokens`
 * counts only the part that was neither read from nor written to cache, and
 * reports those two separately. Storing OpenAI's number as-is alongside the
 * cache columns would count the cached prefix twice in every total on the
 * metrics page. Subtracting keeps one meaning per column and preserves the
 * invariant those totals rely on: input + cache_read + cache_creation is the
 * whole prompt, counted once.
 *
 * `output_tokens` needs no adjustment: reasoning tokens are a subset of it, and
 * Anthropic's output column likewise counts everything generated. A live turn
 * confirmed the arithmetic — input_tokens 13521 + output_tokens 5 =
 * total_tokens 13526, with the details nested inside input_tokens.
 */
export function normalizeCodexUsage(usage) {
  if (!isRecord(usage)) return null;
  const rawInput = tokenCount(usage.input_tokens);
  const cacheRead = inputDetail(usage, 'cached_tokens', 'cached_input_tokens');
  const cacheWrite = inputDetail(usage, 'cache_write_tokens', 'cache_creation_input_tokens');
  const output = tokenCount(usage.output_tokens);
  if (rawInput === null && cacheRead === null && cacheWrite === null && output === null) {
    return null;
  }
  return {
    inputTokens: rawInput === null
      ? null
      // Clamped: a malformed payload whose parts exceed the whole must not
      // produce a negative count, which the column's CHECK would reject.
      : Math.max(0, rawInput - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
  };
}

export class CodexUsageParser {
  constructor({
    format = 'auto',
    maxBytes = CODEX_USAGE_MAX_BYTES,
    maxEvents = CODEX_USAGE_MAX_EVENTS,
  } = {}) {
    this.format = format === 'sse' || format === 'json' ? format : 'auto';
    this.mode = this.format === 'auto' ? null : this.format;
    this.maxBytes = boundedLimit(maxBytes, CODEX_USAGE_MAX_BYTES, MAX_CONFIG_BYTES);
    this.maxEvents = boundedLimit(maxEvents, CODEX_USAGE_MAX_EVENTS, MAX_CONFIG_EVENTS);

    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.usage = emptyUsage();
    this.sawTerminal = false;
    this.sawUsage = false;
    this.bytesSeen = 0;
    this.eventsSeen = 0;
    this.autoProbe = '';
    this.jsonText = '';
    this.sseLine = '';
    this.dataParts = [];
    this.invalid = false;
    this.truncated = false;
    this.limitExceeded = false;
    this.finished = false;
    this.finalParseState = null;
  }

  push(chunk) {
    if (this.finished || this.invalid || this.truncated || this.limitExceeded) {
      return this.snapshot();
    }
    const bytes = asBytes(chunk);
    if (!bytes) {
      this.invalid = true;
      return this.snapshot();
    }
    if (bytes.byteLength === 0) return this.snapshot();

    const remaining = this.maxBytes - this.bytesSeen;
    if (remaining <= 0) {
      this.truncated = true;
      return this.snapshot();
    }
    const accepted = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
    this.bytesSeen += accepted.byteLength;

    let text;
    try {
      text = this.decoder.decode(accepted, { stream: true });
    } catch {
      this.invalid = true;
      return this.snapshot();
    }
    if (text) this.feedText(text);
    if (accepted.byteLength < bytes.byteLength && !this.invalid && !this.limitExceeded) {
      this.truncated = true;
    }
    return this.snapshot();
  }

  finish({ truncated = false } = {}) {
    if (this.finished) return this.snapshot();
    if (truncated && !this.invalid && !this.limitExceeded) this.truncated = true;

    if (!this.invalid && !this.truncated && !this.limitExceeded) {
      let tail = '';
      try {
        tail = this.decoder.decode();
      } catch {
        this.invalid = true;
      }
      if (tail && !this.invalid) this.feedText(tail);
      if (!this.invalid && !this.truncated && !this.limitExceeded) {
        if (!this.mode) this.mode = this.format === 'auto' ? this.probeMode(this.autoProbe) : this.format;
        if (this.mode === 'json') this.finishJson();
        // An SSE stream that stops mid-event is simply missing its terminal
        // event; the usage already collected still stands.
      }
    }

    this.finished = true;
    this.finalParseState = this.deriveParseState();
    return this.snapshot();
  }

  snapshot() {
    const parseState = this.finalParseState ?? this.deriveParseState();
    const usageState = this.deriveUsageState(parseState);
    return {
      inputTokens: this.usage.inputTokens,
      cacheCreationInputTokens: this.usage.cacheCreationInputTokens,
      cacheReadInputTokens: this.usage.cacheReadInputTokens,
      outputTokens: this.usage.outputTokens,
      usageState,
      completeness: parseState === 'complete'
        ? 'complete'
        : usageState === 'partial' ? 'partial' : 'incomplete',
      parseState,
      bytesSeen: this.bytesSeen,
      eventsSeen: this.eventsSeen,
    };
  }

  probeMode(text) {
    const probe = text.replace(/^\uFEFF/, '').trimStart();
    if (!probe) return null;
    // SSE always begins with a field name; JSON with a brace.
    if (probe.startsWith('{') || probe.startsWith('[')) return 'json';
    return 'sse';
  }

  feedText(text) {
    if (this.invalid || this.truncated || this.limitExceeded || this.finished) return;
    if (!this.mode) {
      this.autoProbe += text;
      // probeMode only declines while it has seen nothing but whitespace, so
      // keep accumulating until the first real character decides the format.
      const mode = this.probeMode(this.autoProbe.slice(0, AUTO_DETECT_CHARS));
      if (!mode) return;
      this.mode = mode;
      const pending = this.autoProbe;
      this.autoProbe = '';
      if (this.mode === 'json') this.jsonText += pending;
      else this.feedSse(pending);
      return;
    }
    if (this.mode === 'json') this.jsonText += text;
    else this.feedSse(text);
  }

  feedSse(text) {
    this.sseLine += text;
    let index;
    while ((index = this.sseLine.indexOf('\n')) !== -1) {
      const rawLine = this.sseLine.slice(0, index);
      this.sseLine = this.sseLine.slice(index + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        this.dispatchSseEvent();
        continue;
      }
      // Comments (":" keep-alives) and fields other than data carry no usage.
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field !== 'data') continue;
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      this.dataParts.push(value);
    }
  }

  dispatchSseEvent() {
    if (this.dataParts.length === 0) return;
    const payload = this.dataParts.join('\n');
    this.dataParts = [];
    this.eventsSeen += 1;
    if (this.eventsSeen > this.maxEvents) {
      this.limitExceeded = true;
      return;
    }
    // Redundant by construction — `[DONE]` is not valid JSON, so the parse below
    // would reject it anyway — but naming the protocol's sentinel keeps a reader
    // from mistaking it for the malformed input the catch clause is there for.
    if (payload === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      // A single unparseable event is not grounds for discarding a turn's
      // accounting: the stream carries many event types and only a few matter.
      return;
    }
    this.consumeEvent(event);
  }

  consumeEvent(event) {
    if (!isRecord(event)) return;
    const type = typeof event.type === 'string' ? event.type : '';
    const response = isRecord(event.response) ? event.response : null;
    const usage = response && isRecord(response.usage)
      ? response.usage
      : isRecord(event.usage) ? event.usage : null;
    if (usage) this.applyUsage(usage);
    if (TERMINAL_TYPES.has(type)) this.sawTerminal = true;
  }

  applyUsage(rawUsage) {
    const normalized = normalizeCodexUsage(rawUsage);
    if (!normalized) return;
    this.usage = normalized;
    this.sawUsage = true;
  }

  finishJson() {
    const text = this.jsonText.trim();
    if (!text) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.invalid = true;
      return;
    }
    if (!isRecord(parsed)) return;
    const response = isRecord(parsed.response) ? parsed.response : parsed;
    if (isRecord(response.usage)) this.applyUsage(response.usage);
    // A complete JSON body is itself the end of the turn.
    this.sawTerminal = true;
  }

  deriveParseState() {
    if (this.invalid) return 'invalid';
    if (this.limitExceeded) return 'limit';
    if (this.truncated) return 'truncated';
    if (!this.finished) return 'pending';
    return this.sawTerminal ? 'complete' : 'partial';
  }

  deriveUsageState(parseState) {
    if (!this.sawUsage) return 'unavailable';
    const complete = parseState === 'complete'
      && this.usage.inputTokens !== null
      && this.usage.outputTokens !== null;
    return complete ? 'complete' : 'partial';
  }
}

export function createCodexUsageParser(options = {}) {
  return new CodexUsageParser(options);
}

export function parseCodexUsage(input, options = {}) {
  const parser = new CodexUsageParser(options);
  parser.push(input);
  return parser.finish();
}
