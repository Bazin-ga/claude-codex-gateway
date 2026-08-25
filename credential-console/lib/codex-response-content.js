import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

/**
 * Assemble the assistant's visible text from a Codex (Responses API) stream.
 *
 * The event vocabulary shares nothing with Anthropic's, which is why this is a
 * sibling of response-content.js rather than a mode inside it. Observed live
 * against chatgpt.com/backend-api/codex/responses, in order:
 *
 *   response.created → response.in_progress → response.output_item.added
 *   → response.content_part.added → response.output_text.delta (many)
 *   → response.output_text.done → response.content_part.done
 *   → response.output_item.done → response.completed
 *
 * Deltas are accumulated and `response.output_text.done` carries the finished
 * text for the same part. The done event is preferred where present — it is
 * authoritative and immune to a delta lost to a truncated read — and the
 * accumulated deltas are the fallback.
 *
 * Reasoning summaries arrive on their own `response.reasoning_*` events and are
 * deliberately not collected: the conversation view records what was said, not
 * the model's private working.
 */
export const CODEX_RESPONSE_MAX_BYTES = 1024 * 1024;
export const CODEX_RESPONSE_MAX_EVENTS = 1_000_000;
export const CODEX_RESPONSE_MAX_EVENT_BYTES = 1024 * 1024;
export const CODEX_RESPONSE_MAX_PARTS = 128;

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedLimit(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function asBytes(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

export class CodexResponseContentAssembler {
  constructor({
    maxBytes = CODEX_RESPONSE_MAX_BYTES,
    maxEvents = CODEX_RESPONSE_MAX_EVENTS,
    maxEventBytes = CODEX_RESPONSE_MAX_EVENT_BYTES,
    maxParts = CODEX_RESPONSE_MAX_PARTS,
  } = {}) {
    this.maxBytes = boundedLimit(maxBytes, CODEX_RESPONSE_MAX_BYTES, MAX_CONFIG_BYTES);
    this.maxEvents = boundedLimit(maxEvents, CODEX_RESPONSE_MAX_EVENTS, 4_000_000);
    this.maxEventBytes = Math.min(
      boundedLimit(maxEventBytes, CODEX_RESPONSE_MAX_EVENT_BYTES, MAX_CONFIG_BYTES),
      this.maxBytes,
    );
    this.maxParts = boundedLimit(maxParts, CODEX_RESPONSE_MAX_PARTS, 4096);

    this.decoder = new TextDecoder('utf-8', { fatal: true });
    // Keyed by "item:part" so two output items cannot bleed into one another.
    this.parts = new Map();
    this.order = [];
    this.bytesSeen = 0;
    this.textBytes = 0;
    this.eventsSeen = 0;
    this.sawTerminal = false;
    this.sseLine = '';
    this.dataParts = [];
    this.eventBytes = 0;
    this.eventOversized = false;
    this.truncated = false;
    this.invalid = false;
    this.limitExceeded = false;
    this.ended = false;
  }

  /** The observer contract the proxy's response tee expects. */
  write(chunk) {
    if (this.ended) return true;
    const bytes = asBytes(chunk);
    if (!bytes) {
      this.invalid = true;
      return false;
    }
    const remaining = this.maxBytes - this.bytesSeen;
    if (remaining <= 0) {
      this.truncated = true;
      return false;
    }
    const accepted = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
    this.bytesSeen += accepted.byteLength;
    let text;
    try {
      text = this.decoder.decode(accepted, { stream: true });
    } catch {
      this.invalid = true;
      return false;
    }
    if (text) this.feed(text);
    if (accepted.byteLength < bytes.byteLength) this.truncated = true;
    return !this.invalid && !this.truncated && !this.limitExceeded;
  }

  end() {
    if (this.ended) return;
    try {
      const tail = this.decoder.decode();
      if (tail) this.feed(tail);
    } catch {
      this.invalid = true;
    }
    // An upstream that closed after the last `data:` line but before its blank
    // line would otherwise lose that event.
    if (this.sseLine) this.feed('\n');
    this.dispatch();
    this.ended = true;
  }

  abort() {
    this.truncated = true;
    this.ended = true;
  }

  snapshot() {
    const text = this.order
      .map((key) => this.parts.get(key))
      .filter((part) => part && part.text)
      .map((part) => part.text)
      .join('');
    let status = 'incomplete';
    if (this.invalid) status = 'unavailable';
    else if (this.truncated || this.limitExceeded) status = 'truncated';
    else if (this.sawTerminal) status = 'complete';
    return {
      text,
      status,
      truncated: this.truncated || this.limitExceeded,
      reason: this.invalid ? 'protocol_invalid' : null,
      bytesSeen: this.bytesSeen,
      eventsSeen: this.eventsSeen,
    };
  }

  feed(text) {
    this.sseLine += text;
    let index;
    while ((index = this.sseLine.indexOf('\n')) !== -1) {
      const raw = this.sseLine.slice(0, index);
      this.sseLine = this.sseLine.slice(index + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        this.dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field !== 'data') continue;
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      this.eventBytes += value.length + 1;
      if (this.eventBytes > this.maxEventBytes) {
        this.eventOversized = true;
        this.dataParts = [];
        continue;
      }
      this.dataParts.push(value);
    }
  }

  dispatch() {
    if (this.eventOversized) {
      this.eventOversized = false;
      this.eventBytes = 0;
      this.dataParts = [];
      this.eventsSeen += 1;
      return;
    }
    if (this.dataParts.length === 0) return;
    const payload = this.dataParts.join('\n');
    this.dataParts = [];
    this.eventBytes = 0;
    this.eventsSeen += 1;
    if (this.eventsSeen > this.maxEvents) {
      this.limitExceeded = true;
      return;
    }
    if (payload === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      // One unreadable event among thousands is not grounds for discarding a
      // whole reply.
      return;
    }
    this.consume(event);
  }

  keyFor(event) {
    const item = event.item_id ?? event.output_index ?? 0;
    const part = event.content_index ?? 0;
    return `${item}:${part}`;
  }

  slot(key) {
    let part = this.parts.get(key);
    if (!part) {
      if (this.parts.size >= this.maxParts) return null;
      part = { text: '', done: false };
      this.parts.set(key, part);
      this.order.push(key);
    }
    return part;
  }

  append(key, text) {
    if (typeof text !== 'string' || !text) return;
    const part = this.slot(key);
    // A part already settled by its `done` event must not be appended to: the
    // done text is the whole of it, and adding deltas would duplicate.
    if (!part || part.done) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.textBytes + bytes > this.maxBytes) {
      this.truncated = true;
      return;
    }
    part.text += text;
    this.textBytes += bytes;
  }

  settle(key, text) {
    if (typeof text !== 'string') return;
    const part = this.slot(key);
    if (!part) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    const previous = Buffer.byteLength(part.text, 'utf8');
    if (this.textBytes - previous + bytes > this.maxBytes) {
      this.truncated = true;
      part.done = true;
      return;
    }
    this.textBytes = this.textBytes - previous + bytes;
    part.text = text;
    part.done = true;
  }

  consume(event) {
    if (!isRecord(event)) return;
    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
      case 'response.output_text.delta':
        this.append(this.keyFor(event), event.delta);
        break;
      case 'response.output_text.done':
        // Authoritative for this part, and survives a delta lost to truncation.
        this.settle(this.keyFor(event), event.text);
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
      case 'response.cancelled':
        this.sawTerminal = true;
        break;
      default:
        break;
    }
  }
}

export function createCodexResponseContentAssembler(options = {}) {
  return new CodexResponseContentAssembler(options);
}
