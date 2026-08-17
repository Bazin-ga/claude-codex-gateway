import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

// This is the only body text ceiling.  The assembler never writes a body to a
// file or to the credential/metrics stores; callers can retain its snapshot
// separately if a later P6 feature explicitly needs that policy.
export const RESPONSE_CONTENT_MAX_BYTES = 1024 * 1024;
// Keep one retained UTF-16 SSE line below the identity observation reservation.
// A line can contain astral UTF-8 text, so the bound is expressed in bytes and
// intentionally leaves room for the usage parser and JSON envelope prefix.
export const RESPONSE_CONTENT_MAX_SSE_LINE_BYTES = 2 * 1024 * 1024;
export const RESPONSE_CONTENT_MAX_BLOCKS = 128;
export const RESPONSE_CONTENT_MAX_SSE_DATA_PARTS = 128;

// A JSON envelope has syntax and escaping around its content text. Keep a
// bounded whole-document buffer; if it does not fit, fail closed rather than
// regex-scanning nested tool data and misclassifying it as assistant text.
const MAX_JSON_BUFFER_BYTES = RESPONSE_CONTENT_MAX_BYTES * 2 + 64 * 1024;
const MAX_SSE_LINE_BYTES = RESPONSE_CONTENT_MAX_SSE_LINE_BYTES;
const SSE_LINE_CHUNK_BYTES = 8 * 1024;
const AUTO_DETECT_CHARS = 256;

const KNOWN_EVENTS = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_stop',
]);

function boundedLimit(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeReason(reason) {
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object' && typeof reason.code === 'string') {
    return reason.code;
  }
  return reason == null ? 'aborted' : 'aborted';
}

function appendJsonPrefix(current, currentBytes, text, limit) {
  const remaining = limit - currentBytes;
  if (remaining <= 0) return { value: current, overflow: Boolean(text) };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= remaining) {
    return { value: current + text, bytes: currentBytes + bytes.byteLength, overflow: false };
  }
  let prefixBytes = remaining;
  let prefix = '';
  while (prefixBytes > 0) {
    try {
      prefix = new TextDecoder('utf-8', { fatal: true })
        .decode(bytes.subarray(0, prefixBytes));
      break;
    } catch {
      prefixBytes -= 1;
    }
  }
  return {
    value: current + prefix,
    bytes: currentBytes + prefixBytes,
    overflow: true,
  };
}

/**
 * Incrementally assemble only assistant text from already-decoded response
 * bytes.  It accepts SSE event chunks or one non-streaming JSON envelope and
 * exposes the same write/end/abort/snapshot shape as the P5 response tee's
 * observer.  No transport, credentials, headers, or persistence are involved.
 */
export class ResponseContentAssembler {
  constructor({ format = 'auto', maxBytes = RESPONSE_CONTENT_MAX_BYTES } = {}) {
    this.requestedFormat = format === 'sse' || format === 'json' ? format : 'auto';
    this.mode = this.requestedFormat === 'auto' ? null : this.requestedFormat;
    this.maxBytes = boundedLimit(
      maxBytes,
      RESPONSE_CONTENT_MAX_BYTES,
      RESPONSE_CONTENT_MAX_BYTES,
    );

    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.text = '';
    this.capturedBytes = 0;
    this.truncated = false;
    this.inputTruncated = false;
    this.invalid = false;
    this.ended = false;
    this.aborted = false;
    this.abortReason = null;
    this.protocolComplete = false;
    this.messageStarted = false;
    this.contentBlocks = new Map();

    this.autoProbe = '';
    this.bomHandled = false;
    this.sseLineParts = [];
    this.sseLineChunk = '';
    this.sseLineBytes = 0;
    this.ssePendingCR = false;
    this.eventName = '';
    this.dataParts = [];
    this.eventDataBytes = 0;
    this.ssePartialEvent = false;
    this.jsonText = '';
    this.jsonTextBytes = 0;
    this.jsonOverflow = false;
  }

  write(chunk) {
    if (this.ended || this.aborted || this.invalid || this.inputTruncated || this.protocolComplete) {
      return false;
    }
    const bytes = asBytes(chunk);
    if (!bytes) return false;
    if (bytes.byteLength === 0) return true;

    let decoded;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      this.invalid = true;
      this.abortReason = 'invalid_utf8';
      return false;
    }
    if (decoded) this.feedText(decoded);
    return !(this.ended || this.aborted || this.invalid || this.inputTruncated || this.protocolComplete);
  }

  end() {
    if (this.ended) return this.snapshot();
    if (this.aborted) {
      this.ended = true;
      return this.snapshot();
    }
    if (this.invalid) {
      this.ended = true;
      return this.snapshot();
    }

    let tail = '';
    try {
      tail = this.decoder.decode();
    } catch {
      this.invalid = true;
      this.abortReason = 'invalid_utf8';
    }
    if (tail) this.feedText(tail);

    this.finishModeSelection();
    if (this.mode === 'sse') this.finishSse();
    else if (this.mode === 'json') {
      this.finishJson();
      // No raw JSON envelope survives protocol finalization; only the bounded
      // assistant-text prefix remains observable through snapshot().
      this.jsonText = '';
      this.jsonTextBytes = 0;
    }
    this.ended = true;
    return this.snapshot();
  }

  abort(reason = 'aborted') {
    // A composite observer calls abort after a child returns false. Preserve
    // the child's precise parser failure instead of replacing invalid_utf8 or
    // protocol_invalid with the generic observer_stopped reason.
    if (this.ended || this.aborted || this.invalid || this.protocolComplete) {
      return this.snapshot();
    }
    this.aborted = true;
    this.abortReason = safeReason(reason);
    return this.snapshot();
  }

  snapshot() {
    const status = this.aborted || this.invalid
      ? 'incomplete'
      : this.protocolComplete
        ? 'complete'
        : this.ended
          ? 'incomplete'
          : 'active';
    return {
      text: this.text,
      capturedBytes: this.capturedBytes,
      truncated: this.truncated,
      status,
      complete: status === 'complete',
      incomplete: status === 'incomplete',
      format: this.mode ?? this.requestedFormat,
      reason: this.abortReason,
    };
  }

  feedText(text) {
    if (this.ended || this.aborted || this.invalid || this.inputTruncated || this.protocolComplete) return;
    if (!this.bomHandled) {
      this.bomHandled = true;
      text = text.replace(/^\uFEFF/, '');
    }
    if (!text) return;
    if (!this.mode) {
      this.autoProbe += text;
      const probe = this.autoProbe.replace(/^\uFEFF/, '');
      const trimmed = probe.replace(/^\s*/, '');
      if (/^(?:event|data)\s*:/.test(trimmed) || trimmed.startsWith(':')) {
        this.mode = 'sse';
      } else if (/^[{[]/.test(trimmed) || this.autoProbe.length >= AUTO_DETECT_CHARS) {
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
    else this.feedJsonText(text);
  }

  finishModeSelection() {
    if (this.mode) return;
    const probe = this.autoProbe.replace(/^\uFEFF/, '');
    const trimmed = probe.replace(/^\s*/, '');
    this.mode = /^(?:event|data)\s*:/.test(trimmed) || trimmed.startsWith(':')
      ? 'sse'
      : 'json';
    const pending = this.autoProbe;
    this.autoProbe = '';
    if (pending) this.feedText(pending);
  }

  appendText(value) {
    if (typeof value !== 'string' || value.length === 0) return;
    if (hasUnpairedSurrogate(value)) {
      this.invalid = true;
      this.abortReason = 'invalid_text';
      return;
    }
    const remaining = this.maxBytes - this.capturedBytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= remaining) {
      this.text += value;
      this.capturedBytes += bytes.byteLength;
      return;
    }
    // Never manufacture U+FFFD by cutting through a multi-byte code point;
    // retain the largest valid UTF-8 prefix that fits under the byte ceiling.
    let prefixBytes = remaining;
    let prefix = '';
    while (prefixBytes > 0) {
      try {
        prefix = new TextDecoder('utf-8', { fatal: true })
          .decode(bytes.subarray(0, prefixBytes));
        break;
      } catch {
        prefixBytes -= 1;
      }
    }
    this.text += prefix;
    this.capturedBytes += prefixBytes;
    this.truncated = true;
  }

  feedJsonText(text) {
    const result = appendJsonPrefix(this.jsonText, this.jsonTextBytes, text, MAX_JSON_BUFFER_BYTES);
    this.jsonText = result.value;
    this.jsonTextBytes = result.bytes ?? this.jsonTextBytes;
    if (result.overflow) this.jsonOverflow = true;
  }

  finishJson() {
    const source = this.jsonText.replace(/^\uFEFF/, '');
    if (!source.trim()) return;

    let payload = null;
    if (!this.jsonOverflow) {
      try {
        payload = JSON.parse(source);
      } catch {
        return;
      }
    }

    if (isRecord(payload) && payload.role === 'assistant' && Array.isArray(payload.content)) {
      if (payload.content.length > RESPONSE_CONTENT_MAX_BLOCKS) {
        this.markInputTruncated();
        return;
      }
      for (const block of payload.content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          this.appendText(block.text);
        }
      }
      this.protocolComplete = true;
      return;
    }

    if (this.jsonOverflow) {
      this.truncated = true;
    }
  }

  feedSseText(text) {
    if (this.ssePendingCR) {
      this.ssePendingCR = false;
      if (text.startsWith('\n')) this.dispatchSseLine();
      else this.dispatchSseLine();
      if (text.startsWith('\n')) text = text.slice(1);
    }
    let segmentStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character !== '\n' && character !== '\r') continue;
      this.appendSseLineText(text.slice(segmentStart, index));
      if (this.inputTruncated || this.invalid || this.protocolComplete) return;
      if (character === '\r' && index + 1 === text.length) {
        this.ssePendingCR = true;
        segmentStart = index + 1;
        break;
      }
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      this.dispatchSseLine();
      if (this.inputTruncated || this.invalid || this.protocolComplete) return;
      segmentStart = index + 1;
    }
    if (!this.inputTruncated && !this.invalid && !this.protocolComplete) {
      this.appendSseLineText(text.slice(segmentStart));
    }
  }

  appendSseLineText(text) {
    if (!text) return;
    this.sseLineBytes += byteLength(text);
    if (this.sseLineBytes > MAX_SSE_LINE_BYTES) {
      this.markInputTruncated();
      return;
    }
    this.sseLineChunk += text;
    if (byteLength(this.sseLineChunk) >= SSE_LINE_CHUNK_BYTES) {
      this.sseLineParts.push(this.sseLineChunk);
      this.sseLineChunk = '';
    }
  }

  dispatchSseLine() {
    const line = `${this.sseLineParts.join('')}${this.sseLineChunk}`;
    this.sseLineParts = [];
    this.sseLineChunk = '';
    this.sseLineBytes = 0;
    this.processSseLine(line);
  }

  markInputTruncated() {
    this.inputTruncated = true;
    this.truncated = true;
    this.sseLineParts = [];
    this.sseLineChunk = '';
    this.sseLineBytes = 0;
    this.ssePendingCR = false;
    this.eventName = '';
    this.dataParts = [];
    this.eventDataBytes = 0;
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
    if (this.eventDataBytes > MAX_SSE_LINE_BYTES) {
      this.markInputTruncated();
      return;
    }
    if (this.dataParts.length >= RESPONSE_CONTENT_MAX_SSE_DATA_PARTS) {
      this.markInputTruncated();
      return;
    }
    this.dataParts.push(value);
  }

  dispatchSseEvent() {
    if (!this.eventName && this.dataParts.length === 0) return;
    const eventName = this.eventName;
    const data = this.dataParts.join('\n');
    this.eventName = '';
    this.dataParts = [];
    this.eventDataBytes = 0;

    let payload = null;
    if (data) {
      try {
        payload = JSON.parse(data);
      } catch {
        // Unknown/malformed events are ignored; recognized event names still
        // reach the protocol validator below.
      }
    }
    const payloadType = isRecord(payload) && typeof payload.type === 'string'
      ? payload.type
      : '';
    const type = KNOWN_EVENTS.has(payloadType)
      ? payloadType
      : payload !== null && KNOWN_EVENTS.has(eventName)
        ? eventName
        : '';
    if (!type) return;
    this.handleSseEvent(type, payload);
  }

  handleSseEvent(type, payload) {
    if (this.invalid) return;
    if (!isRecord(payload) || payload.type !== type) {
      this.protocolFail();
      return;
    }
    if (type === 'message_start') {
      if (this.messageStarted || this.protocolComplete
        || !isRecord(payload.message) || payload.message.role !== 'assistant') {
        this.protocolFail();
      } else {
        this.messageStarted = true;
      }
      return;
    }
    if (type === 'message_stop') {
      if (!this.messageStarted || [...this.contentBlocks.values()].some((block) => !block.stopped)) {
        this.protocolFail();
      } else {
        this.protocolComplete = true;
      }
      return;
    }
    if (!this.messageStarted) return;
    if (!isRecord(payload)) return;
    if (type === 'content_block_start') {
      const index = payload.index;
      const block = payload.content_block;
      if (this.contentBlocks.size >= RESPONSE_CONTENT_MAX_BLOCKS) {
        this.markInputTruncated();
        return;
      }
      if (!Number.isSafeInteger(index) || index < 0 || this.contentBlocks.has(index)
        || !isRecord(block) || typeof block.type !== 'string') {
        this.protocolFail();
        return;
      }
      this.contentBlocks.set(index, { type: block.type, stopped: false });
      if (block.type === 'text' && block.text !== undefined && typeof block.text !== 'string') {
        this.protocolFail();
        return;
      }
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        this.appendText(block.text);
      }
      return;
    }
    if (type === 'content_block_delta') {
      const index = payload.index;
      const delta = payload.delta;
      const block = Number.isSafeInteger(index) ? this.contentBlocks.get(index) : null;
      if (!block || block.stopped || !isRecord(delta) || typeof delta.type !== 'string') {
        this.protocolFail();
        return;
      }
      if (delta.type === 'text_delta' && block.type !== 'text') {
        this.protocolFail();
        return;
      }
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.appendText(delta.text);
      }
      return;
    }
    if (type === 'content_block_stop') {
      const index = payload.index;
      const block = Number.isSafeInteger(index) ? this.contentBlocks.get(index) : null;
      if (!block || block.stopped) {
        this.protocolFail();
        return;
      }
      block.stopped = true;
    }
    // content_block_stop intentionally carries no body text.
  }

  protocolFail() {
    this.invalid = true;
    this.abortReason = 'protocol_invalid';
  }

  finishSse() {
    // A CR terminates a line at EOF, but without the following blank line the
    // accumulated event remains partial according to SSE framing rules.
    if (this.ssePendingCR) {
      this.ssePendingCR = false;
      this.dispatchSseLine();
    } else if (this.sseLineBytes > 0) {
      this.dispatchSseLine();
    }
    this.ssePartialEvent = Boolean(this.eventName || this.dataParts.length);
    // `message_stop` is the protocol terminal.  An EOF before it is an
    // incomplete response even when useful text was observed.
  }
}

export function createResponseContentAssembler(options = {}) {
  return new ResponseContentAssembler(options);
}

export function assembleResponseContent(chunks, options = {}) {
  const assembler = createResponseContentAssembler(options);
  if (chunks && typeof chunks[Symbol.iterator] === 'function') {
    for (const chunk of chunks) assembler.write(chunk);
  }
  return assembler.end();
}
