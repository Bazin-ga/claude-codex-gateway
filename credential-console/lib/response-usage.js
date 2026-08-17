import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

// This parser is deliberately independent of the proxy.  The proxy can tee an
// already-decoded response into it without giving the parser a socket, a file,
// or a second copy of the response body.
export const RESPONSE_USAGE_MAX_BYTES = 1024 * 1024;
export const RESPONSE_USAGE_MAX_EVENTS = 8192;
export const RESPONSE_USAGE_MAX_EVENT_BYTES = 64 * 1024;

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_EVENTS = 32 * 1024;
const MAX_CONFIG_EVENT_BYTES = 1024 * 1024;
const AUTO_DETECT_CHARS = 256;

const USAGE_KEYS = Object.freeze([
  ['input_tokens', 'inputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ['output_tokens', 'outputTokens'],
]);
const EVENT_TYPES = new Set(['message_start', 'message_delta', 'message_stop', 'error']);

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

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Incrementally parses usage from either an Anthropic SSE response or a
 * non-streaming JSON response.  `push` never throws for malformed response
 * bytes; callers can use `finish({ truncated: true })` when the upstream
 * response ends before its protocol terminator.
 */
export class ResponseUsageParser {
  constructor({
    format = 'auto',
    maxBytes = RESPONSE_USAGE_MAX_BYTES,
    maxEvents = RESPONSE_USAGE_MAX_EVENTS,
    maxEventBytes = RESPONSE_USAGE_MAX_EVENT_BYTES,
  } = {}) {
    this.format = format === 'sse' || format === 'json' ? format : 'auto';
    this.mode = this.format === 'auto' ? null : this.format;
    this.maxBytes = boundedLimit(maxBytes, RESPONSE_USAGE_MAX_BYTES, MAX_CONFIG_BYTES);
    this.maxEvents = boundedLimit(maxEvents, RESPONSE_USAGE_MAX_EVENTS, MAX_CONFIG_EVENTS);
    this.maxEventBytes = Math.min(
      boundedLimit(maxEventBytes, RESPONSE_USAGE_MAX_EVENT_BYTES, MAX_CONFIG_EVENT_BYTES),
      this.maxBytes,
    );

    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.usage = emptyUsage();
    this.bytesSeen = 0;
    this.eventsSeen = 0;
    this.numericUsageSeen = false;
    this.sawMessageStart = false;
    this.sawMessageStop = false;
    this.jsonParsed = false;
    this.jsonUsagePresent = false;
    this.sseTailPartial = false;
    this.autoProbe = '';
    this.jsonText = '';
    this.sseLine = '';
    this.eventName = '';
    this.dataParts = [];
    this.eventDataBytes = 0;
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
      this.markInvalid();
      return this.snapshot();
    }
    if (bytes.byteLength === 0) return this.snapshot();

    const remaining = this.maxBytes - this.bytesSeen;
    if (remaining <= 0) {
      this.markTruncated();
      return this.snapshot();
    }
    const accepted = bytes.byteLength > remaining
      ? bytes.subarray(0, remaining)
      : bytes;
    this.bytesSeen += accepted.byteLength;

    let text;
    try {
      text = this.decoder.decode(accepted, { stream: true });
    } catch {
      this.markInvalid();
      return this.snapshot();
    }
    if (text) this.feedText(text);
    if (accepted.byteLength < bytes.byteLength && !this.invalid && !this.limitExceeded) {
      this.markTruncated();
    }
    return this.snapshot();
  }

  finish({ truncated = false } = {}) {
    if (this.finished) return this.snapshot();
    if (truncated && !this.invalid && !this.limitExceeded) this.markTruncated();

    if (!this.invalid && !this.truncated && !this.limitExceeded) {
      let tail = '';
      try {
        tail = this.decoder.decode();
      } catch {
        this.markInvalid();
      }
      if (tail && !this.invalid) this.feedText(tail);

      if (!this.invalid && !this.truncated && !this.limitExceeded) {
        this.finishModeSelection();
        if (this.mode === 'sse') {
          // SSE dispatches only after a blank line.  A data line cut at EOF is
          // therefore partial, even when its JSON happens to be parseable.
          this.sseTailPartial = Boolean(
            this.sseLine || this.eventName || this.dataParts.length,
          );
        } else if (this.mode === 'json') {
          this.finishJson();
        }
      }
    }

    this.finished = true;
    this.finalParseState = this.deriveParseState();
    return this.snapshot();
  }

  snapshot() {
    const parseState = this.finalParseState ?? this.deriveParseState();
    const usageState = this.deriveUsageState(parseState);
    const completeness = parseState === 'complete'
      ? 'complete'
      : (parseState === 'pending' || parseState === 'partial') && usageState === 'partial'
        ? 'partial'
        : 'incomplete';
    return {
      inputTokens: this.usage.inputTokens,
      cacheCreationInputTokens: this.usage.cacheCreationInputTokens,
      cacheReadInputTokens: this.usage.cacheReadInputTokens,
      outputTokens: this.usage.outputTokens,
      usageState,
      completeness,
      parseState,
      bytesSeen: this.bytesSeen,
      eventsSeen: this.eventsSeen,
    };
  }

  feedText(text) {
    if (this.invalid || this.truncated || this.limitExceeded || this.finished) return;
    if (!this.mode) {
      this.autoProbe += text;
      const probe = this.autoProbe.replace(/^\uFEFF/, '');
      const trimmed = probe.replace(/^[\s]*/, '');
      if (/^(?:event|data)\s*:/.test(trimmed) || trimmed.startsWith(':')) {
        this.mode = 'sse';
      } else if (/^[\[{]/.test(trimmed) || this.autoProbe.length >= AUTO_DETECT_CHARS) {
        this.mode = 'json';
      } else {
        return;
      }
      const pending = this.autoProbe;
      this.autoProbe = '';
      this.feedText(pending);
      return;
    }
    if (this.mode === 'sse') this.feedSseText(text);
    else this.jsonText += text;
  }

  finishModeSelection() {
    if (this.mode) return;
    const probe = this.autoProbe.replace(/^\uFEFF/, '');
    const trimmed = probe.replace(/^[\s]*/, '');
    this.mode = /^(?:event|data)\s*:/.test(trimmed) || trimmed.startsWith(':')
      ? 'sse'
      : 'json';
    const pending = this.autoProbe;
    this.autoProbe = '';
    if (pending) this.feedText(pending);
  }

  feedSseText(text) {
    this.sseLine += text;

    while (!this.invalid && !this.truncated && !this.limitExceeded) {
      let lineEnd = -1;
      let terminatorLength = 1;
      for (let index = 0; index < this.sseLine.length; index += 1) {
        const character = this.sseLine[index];
        if (character === '\n') {
          lineEnd = index;
          break;
        }
        if (character === '\r') {
          // A CR at the end may become CRLF in the next chunk.
          if (index + 1 === this.sseLine.length) break;
          lineEnd = index;
          terminatorLength = this.sseLine[index + 1] === '\n' ? 2 : 1;
          break;
        }
      }
      if (lineEnd < 0) {
        // Complete lines are dispatched below; only an unterminated line is
        // subject to the per-event retained-data cap here.  A large network
        // chunk containing many small events must remain valid.
        if (byteLength(this.sseLine) > this.maxEventBytes) this.markLimit();
        break;
      }
      const line = this.sseLine.slice(0, lineEnd);
      this.sseLine = this.sseLine.slice(lineEnd + terminatorLength);
      if (byteLength(line) > this.maxEventBytes) {
        this.markLimit();
        break;
      }
      this.processSseLine(line);
    }
  }

  processSseLine(line) {
    if (line === '') {
      this.dispatchSseEvent();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      this.eventName = value;
      return;
    }
    if (field !== 'data') return;
    const addition = this.dataParts.length ? `\n${value}` : value;
    this.eventDataBytes += byteLength(addition);
    if (this.eventDataBytes > this.maxEventBytes) {
      this.markLimit();
      return;
    }
    this.dataParts.push(value);
  }

  dispatchSseEvent() {
    if (!this.eventName && this.dataParts.length === 0) return;
    if (this.eventsSeen >= this.maxEvents) {
      this.markLimit();
      return;
    }
    const eventName = this.eventName;
    const data = this.dataParts.join('\n');
    this.eventName = '';
    this.dataParts = [];
    this.eventDataBytes = 0;
    this.eventsSeen += 1;
    this.handleSseEvent(eventName, data);
  }

  handleSseEvent(eventName, data) {
    const knownEventName = EVENT_TYPES.has(eventName);
    // New provider event names are intentionally ignored without parsing their
    // data.  This also keeps a future event's large/changed schema harmless.
    if (eventName && !knownEventName) return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      if (knownEventName) this.markInvalid();
      return;
    }
    if (!isRecord(payload)) {
      if (knownEventName) this.markInvalid();
      return;
    }
    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    if (knownEventName && payloadType !== eventName) {
      this.markInvalid();
      return;
    }
    const type = knownEventName ? eventName : payloadType;
    if (!EVENT_TYPES.has(type)) return;
    this.handleKnownEvent(type, payload);
  }

  handleKnownEvent(type, payload) {
    if (type === 'error') return;
    if (type === 'message_start') {
      if (this.sawMessageStart || this.sawMessageStop || !isRecord(payload.message)) {
        this.markInvalid();
        return;
      }
      this.sawMessageStart = true;
      if (Object.hasOwn(payload.message, 'usage')
        && !this.applyUsage(payload.message.usage)) this.markInvalid();
      return;
    }
    if (type === 'message_delta') {
      if (!this.sawMessageStart || this.sawMessageStop) {
        this.markInvalid();
        return;
      }
      if (Object.hasOwn(payload, 'usage') && !this.applyUsage(payload.usage, { delta: true })) {
        this.markInvalid();
      }
      return;
    }
    if (type === 'message_stop') {
      if (!this.sawMessageStart || this.sawMessageStop) this.markInvalid();
      else this.sawMessageStop = true;
    }
  }

  applyUsage(value, { delta = false } = {}) {
    if (!isRecord(value)) return false;
    const updates = [];
    for (const [key, property] of USAGE_KEYS) {
      if (!Object.hasOwn(value, key)) continue;
      const tokenValue = value[key];
      const nullableCache = property === 'cacheCreationInputTokens'
        || property === 'cacheReadInputTokens';
      const nullableDeltaInput = delta && property === 'inputTokens';
      if (tokenValue === null && (nullableCache || nullableDeltaInput)) {
        // MessageDeltaUsage input/cache fields are nullable. Null means that
        // this cumulative snapshot has no newer value; retain any value from
        // message_start or an earlier delta instead of erasing known usage.
        if (!delta) updates.push([property, null]);
        continue;
      }
      if (!Number.isSafeInteger(tokenValue) || tokenValue < 0) return false;
      updates.push([property, tokenValue]);
    }
    for (const [property, tokenValue] of updates) {
      this.usage[property] = tokenValue;
      if (tokenValue !== null) this.numericUsageSeen = true;
    }
    return true;
  }

  finishJson() {
    const source = this.jsonText.replace(/^\uFEFF/, '');
    if (!source.trim()) return;
    let payload;
    try {
      payload = JSON.parse(source);
    } catch {
      this.markInvalid();
      return;
    }
    if (!isRecord(payload)) {
      this.markInvalid();
      return;
    }
    this.jsonParsed = true;
    if (!Object.hasOwn(payload, 'usage')) return;
    this.jsonUsagePresent = true;
    if (!this.applyUsage(payload.usage)) this.markInvalid();
  }

  deriveParseState() {
    if (this.invalid) return 'invalid';
    if (this.limitExceeded) return 'limit';
    if (this.truncated) return 'truncated';
    if (!this.finished) return 'pending';
    if (this.mode === 'sse') {
      return this.sawMessageStart
        && this.sawMessageStop
        && !this.sseTailPartial
        && this.usage.inputTokens !== null
        && this.usage.outputTokens !== null
        ? 'complete'
        : 'partial';
    }
    return this.jsonParsed
      && this.jsonUsagePresent
      && this.usage.inputTokens !== null
      && this.usage.outputTokens !== null
      ? 'complete'
      : 'partial';
  }

  deriveUsageState(parseState) {
    if (parseState === 'complete') return 'complete';
    return this.numericUsageSeen ? 'partial' : 'unavailable';
  }

  markInvalid() {
    if (this.truncated || this.limitExceeded) return;
    this.invalid = true;
  }

  markTruncated() {
    if (this.invalid || this.limitExceeded) return;
    this.truncated = true;
  }

  markLimit() {
    if (this.invalid || this.truncated) return;
    this.limitExceeded = true;
  }
}

export function createResponseUsageParser(options = {}) {
  return new ResponseUsageParser(options);
}

export function parseResponseUsage(input, options = {}) {
  const parser = createResponseUsageParser(options);
  parser.push(input);
  return parser.finish();
}
