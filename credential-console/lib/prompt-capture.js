import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

// These are deliberately below the P2 prefix ceiling.  A prompt candidate is
// either retained in full or rejected; it is never silently truncated.
export const PROMPT_CAPTURE_MAX_INPUT_BYTES = 64 * 1024;
export const PROMPT_CAPTURE_MAX_TEXT_BLOCKS = 128;
export const PROMPT_CAPTURE_MAX_BLOCK_BYTES = 16 * 1024;
export const PROMPT_CAPTURE_MAX_TEXT_BYTES = 32 * 1024;
export const PROMPT_CAPTURE_SEPARATOR = '\n\n';

function boundedLimit(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
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

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function decodeInput(input, maxInputBytes) {
  const bytes = asBytes(input);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxInputBytes) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function unwrapInput(input, parseState) {
  // This envelope lets the proxy pass the P2 tee result without exposing any
  // request headers or credentials to this pure parser.
  if (isRecord(input) && Object.hasOwn(input, 'prefix')) {
    return {
      source: input.prefix,
      parseState: input.parseState ?? parseState,
    };
  }
  return { source: input, parseState };
}

/**
 * Return a bounded candidate only for the final user message containing real
 * text.  `parseState` must be the P2 tee's completed state; a prefix marked
 * pending, invalid, or truncated is never treated as a complete prompt.
 *
 * The function accepts a parsed JSON object or a UTF-8 Buffer/Uint8Array.  It
 * has no access to transport headers, tokens, credentials, or any I/O surface.
 */
export function extractPromptCandidate(input, {
  parseState = 'complete',
  maxInputBytes = PROMPT_CAPTURE_MAX_INPUT_BYTES,
  maxTextBlocks = PROMPT_CAPTURE_MAX_TEXT_BLOCKS,
  maxBlockBytes = PROMPT_CAPTURE_MAX_BLOCK_BYTES,
  maxPromptBytes = PROMPT_CAPTURE_MAX_TEXT_BYTES,
} = {}) {
  try {
    const limits = {
      maxInputBytes: boundedLimit(
        maxInputBytes,
        PROMPT_CAPTURE_MAX_INPUT_BYTES,
        PROMPT_CAPTURE_MAX_INPUT_BYTES,
      ),
      maxTextBlocks: boundedLimit(
        maxTextBlocks,
        PROMPT_CAPTURE_MAX_TEXT_BLOCKS,
        PROMPT_CAPTURE_MAX_TEXT_BLOCKS,
      ),
      maxBlockBytes: boundedLimit(
        maxBlockBytes,
        PROMPT_CAPTURE_MAX_BLOCK_BYTES,
        PROMPT_CAPTURE_MAX_BLOCK_BYTES,
      ),
      maxPromptBytes: boundedLimit(
        maxPromptBytes,
        PROMPT_CAPTURE_MAX_TEXT_BYTES,
        PROMPT_CAPTURE_MAX_TEXT_BYTES,
      ),
    };
    const unwrapped = unwrapInput(input, parseState);
    if (unwrapped.parseState !== 'complete') return null;

    const parsed = asBytes(unwrapped.source)
      ? decodeInput(unwrapped.source, limits.maxInputBytes)
      : unwrapped.source;
    if (!isRecord(parsed) || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return null;
    }

    const messageIndex = parsed.messages.length - 1;
    const message = parsed.messages[messageIndex];
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content)) {
      return null;
    }
    if (message.content.length > limits.maxTextBlocks) return null;

    const texts = [];
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
      if (hasUnpairedSurrogate(block.text)) return null;
      if (!block.text.trim()) continue;
      const text = block.text;
      if (byteLength(text) > limits.maxBlockBytes) return null;
      texts.push(text);
      if (texts.length > limits.maxTextBlocks) return null;
    }
    if (texts.length === 0) return null;

    const promptText = texts.join(PROMPT_CAPTURE_SEPARATOR);
    if (byteLength(promptText) > limits.maxPromptBytes) return null;
    return Object.freeze({
      promptText,
      messageIndex,
      contentBlockCount: message.content.length,
      textBlockCount: texts.length,
    });
  } catch {
    // Hostile parsed objects/getters and malformed wire values are simply not
    // candidates; prompt capture must never affect request forwarding.
    return null;
  }
}
