import { Buffer } from 'node:buffer';
import { createResponseUsageParser } from './response-usage.js';

/**
 * Usage from a Bedrock `invoke-with-response-stream` response.
 *
 * That response is framed in the AWS event-stream binary format, not SSE, so
 * none of the existing parsers can read it directly. Each frame is
 *
 *   total length (u32) | headers length (u32) | prelude CRC (u32)
 *   headers | payload | message CRC (u32)
 *
 * and, for an Anthropic model, the payload of every `chunk` event is
 * `{"bytes": "<base64 of one Anthropic streaming event>"}`. Unwrapping that
 * gives exactly the events the Claude proxy already meters, so they are handed
 * to the same ResponseUsageParser as `data:` lines and the two paths count
 * tokens identically.
 *
 * Observation only: the client receives the upstream bytes untouched, so CRCs
 * are not checked here — a corrupt frame is the client SDK's to reject, and the
 * worst this side can do with one is lose the turn's usage.
 */

const PRELUDE_BYTES = 12;
const MIN_FRAME_BYTES = 16;
/** Far above any real frame; a length past it means the framing is lost. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Usage arrives in the last event, so the inner parser must see the whole turn. */
const USAGE_MAX_BYTES = 16 * 1024 * 1024;

const HEADER_VALUE_BYTES = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

/** The string-valued headers of one frame; other value types are skipped. */
export function eventStreamHeaders(buffer) {
  const headers = {};
  let offset = 0;
  while (offset < buffer.length) {
    const nameLength = buffer[offset];
    offset += 1;
    const name = buffer.toString('utf8', offset, offset + nameLength);
    offset += nameLength;
    const type = buffer[offset];
    offset += 1;
    if (type === 6 || type === 7) {
      const length = buffer.readUInt16BE(offset);
      offset += 2;
      if (type === 7) headers[name] = buffer.toString('utf8', offset, offset + length);
      offset += length;
    } else if (type in HEADER_VALUE_BYTES) {
      offset += HEADER_VALUE_BYTES[type];
    } else {
      throw new Error('unknown event-stream header type');
    }
  }
  return headers;
}

export class BedrockEventStreamUsageParser {
  constructor() {
    this.inner = createResponseUsageParser({ format: 'sse', maxBytes: USAGE_MAX_BYTES });
    this.pending = Buffer.alloc(0);
    this.invalid = false;
  }

  push(chunk) {
    if (this.invalid) return this.snapshot();
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    while (this.pending.length >= PRELUDE_BYTES) {
      const total = this.pending.readUInt32BE(0);
      const headersLength = this.pending.readUInt32BE(4);
      if (total < MIN_FRAME_BYTES || total > MAX_FRAME_BYTES
        || headersLength > total - MIN_FRAME_BYTES) {
        this.markInvalid();
        break;
      }
      if (this.pending.length < total) break;
      const frame = this.pending.subarray(0, total);
      this.pending = this.pending.subarray(total);
      try {
        this.frame(frame, headersLength);
      } catch {
        this.markInvalid();
        break;
      }
    }
    return this.snapshot();
  }

  frame(frame, headersLength) {
    const headers = eventStreamHeaders(frame.subarray(PRELUDE_BYTES, PRELUDE_BYTES + headersLength));
    if (headers[':message-type'] !== 'event' || headers[':event-type'] !== 'chunk') return;
    const payload = JSON.parse(frame.toString('utf8', PRELUDE_BYTES + headersLength, frame.length - 4));
    if (typeof payload?.bytes !== 'string') return;
    const event = Buffer.from(payload.bytes, 'base64').toString('utf8');
    this.inner.push(`data: ${event.replace(/\r?\n/g, ' ')}\n\n`);
  }

  markInvalid() {
    this.invalid = true;
    this.pending = Buffer.alloc(0);
  }

  finish({ truncated = false } = {}) {
    return this.inner.finish({ truncated: truncated || this.invalid || this.pending.length > 0 });
  }

  snapshot() {
    return this.inner.snapshot();
  }
}

export function createBedrockEventStreamUsageParser() {
  return new BedrockEventStreamUsageParser();
}
