import { Transform } from 'node:stream';
import { TextDecoder } from 'node:util';
import { extractPromptCandidate } from './prompt-capture.js';

export const REQUEST_METADATA_PREFIX_BYTES = 64 * 1024;

/**
 * How far a caller may raise `prefixLimit` above the default.
 *
 * Claude Code re-sends the whole conversation on every turn, and puts `stream`
 * and the newest user message *after* `system`, `tools` and `messages` — so a
 * 64 KiB prefix never reaches them once a session grows. Measured against a real
 * deployment, only 6.5% of `/v1/messages` bodies fit in 64 KiB; the median is
 * ~292 KB. This ceiling matches proxy.js's MAX_REQUEST_BYTES so that anything we
 * are willing to forward is also something we can read metadata from.
 */
export const REQUEST_METADATA_PREFIX_MAX_BYTES = 32 * 1024 * 1024;

const JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);
const JSON_DELIMITERS = new Set([',', ']', '}']);
const KEY_CAPTURE_LIMIT = 256;

function isWhitespace(character) {
  return JSON_WHITESPACE.has(character);
}

function isDelimiter(character) {
  return isWhitespace(character) || JSON_DELIMITERS.has(character);
}

function isDigit(character) {
  return character >= '0' && character <= '9';
}

function isNonZeroDigit(character) {
  return character >= '1' && character <= '9';
}

function isHexDigit(character) {
  return /^[0-9a-fA-F]$/.test(character);
}

/**
 * Incrementally consumes one JSON value. It deliberately retains no value
 * except a bounded string that belongs to a requested top-level field.
 *
 * `done` with `reprocess: true` means the delimiter belongs to the parent
 * object/array and has not been consumed by this scanner.
 */
class JsonValueScanner {
  constructor({ target = null, maxModelChars = 256 } = {}) {
    this.target = target;
    this.maxModelChars = maxModelChars;
    this.mode = 'start';
    this.stack = [];
    this.stringEscape = false;
    this.stringUnicodeDigits = 0;
    this.stringRaw = '';
    this.stringOverflow = false;
    this.literalExpected = null;
    this.literalIndex = 0;
    this.literalComplete = false;
    this.literalValue = null;
    this.numberState = null;
    this.result = null;
    this.invalid = false;
  }

  fail() {
    this.invalid = true;
    return { type: 'invalid' };
  }

  startString({ capture = false } = {}) {
    this.mode = capture ? 'target-string' : 'string';
    this.stringEscape = false;
    this.stringUnicodeDigits = 0;
    this.stringRaw = '';
    this.stringOverflow = false;
  }

  startLiteral(firstCharacter) {
    const expected = firstCharacter === 't'
      ? 'true'
      : firstCharacter === 'f'
        ? 'false'
        : firstCharacter === 'n'
          ? 'null'
          : null;
    if (!expected) return this.fail();
    this.mode = 'literal';
    this.literalExpected = expected;
    this.literalIndex = 1;
    this.literalComplete = expected.length === 1;
    this.literalValue = expected === 'true' ? true : expected === 'false' ? false : null;
    return { type: 'need' };
  }

  startNumber(firstCharacter) {
    if (firstCharacter === '-') {
      this.numberState = 'minus';
    } else if (firstCharacter === '0') {
      this.numberState = 'zero';
    } else if (isNonZeroDigit(firstCharacter)) {
      this.numberState = 'integer';
    } else {
      return this.fail();
    }
    this.mode = 'number';
    return { type: 'need' };
  }

  startValue(character) {
    if (isWhitespace(character)) return { type: 'need' };
    if (character === '"') {
      this.startString({ capture: this.target === 'model' });
      return { type: 'need' };
    }
    if (character === '{') {
      // A target field whose direct value is a container has the wrong type.
      // Do not let a primitive nested inside that container impersonate the
      // field's own value.
      this.target = null;
      this.stack.push({ type: 'object', state: 'keyOrEnd' });
      this.mode = 'context';
      return { type: 'need' };
    }
    if (character === '[') {
      this.target = null;
      this.stack.push({ type: 'array', state: 'valueOrEnd' });
      this.mode = 'context';
      return { type: 'need' };
    }
    if ('tfn'.includes(character)) return this.startLiteral(character);
    if (character === '-' || isDigit(character)) return this.startNumber(character);
    return this.fail();
  }

  consumeString(character) {
    if (this.stringUnicodeDigits > 0) {
      if (!isHexDigit(character)) return this.fail();
      this.stringUnicodeDigits -= 1;
      if (this.stringUnicodeDigits === 0) this.stringEscape = false;
      if (this.mode === 'target-string' && !this.stringOverflow) {
        this.appendStringRaw(character);
      }
      return { type: 'need' };
    }

    if (this.stringEscape) {
      if (character === 'u') {
        this.stringUnicodeDigits = 4;
        if (this.mode === 'target-string' && !this.stringOverflow) {
          this.appendStringRaw(character);
        }
        return { type: 'need' };
      }
      if (!'"\\/bfnrt'.includes(character)) return this.fail();
      this.stringEscape = false;
      if (this.mode === 'target-string' && !this.stringOverflow) {
        this.appendStringRaw(character);
      }
      return { type: 'need' };
    }

    if (character === '"') {
      if (this.mode === 'target-string') {
        if (this.stringOverflow) {
          this.result = null;
        } else {
          try {
            const value = JSON.parse(`"${this.stringRaw}"`);
            this.result = value.length <= this.maxModelChars ? value : null;
          } catch {
            return this.fail();
          }
        }
      }
      return this.finishValue();
    }
    if (character === '\\') {
      this.stringEscape = true;
      if (this.mode === 'target-string' && !this.stringOverflow) {
        this.appendStringRaw(character);
      }
      return { type: 'need' };
    }
    if (character < ' ') return this.fail();
    if (this.mode === 'target-string' && !this.stringOverflow) {
      this.appendStringRaw(character);
    }
    return { type: 'need' };
  }

  appendStringRaw(character) {
    // A UTF-16 code unit can be represented by a pair of \u escapes. This
    // bound is intentionally a little loose, while still independent of the
    // request body size. The decoded value is checked against maxModelChars.
    const rawLimit = this.maxModelChars * 12 + 2;
    if (this.stringRaw.length >= rawLimit) {
      this.stringOverflow = true;
      return;
    }
    this.stringRaw += character;
  }

  consumeLiteral(character) {
    if (this.literalComplete) {
      if (isDelimiter(character)) {
        if (this.target === 'stream' && this.literalExpected !== 'null') {
          this.result = this.literalValue;
        }
        return this.finishValueAtDelimiter(character);
      }
      return this.fail();
    }
    if (character !== this.literalExpected[this.literalIndex]) return this.fail();
    this.literalIndex += 1;
    if (this.literalIndex === this.literalExpected.length) {
      this.literalComplete = true;
      if (this.target === 'stream' && this.literalExpected !== 'null') {
        this.result = this.literalValue;
      }
    }
    return { type: 'need' };
  }

  consumeNumber(character) {
    const delimiter = isDelimiter(character);
    switch (this.numberState) {
      case 'minus':
        if (character === '0') this.numberState = 'zero';
        else if (isNonZeroDigit(character)) this.numberState = 'integer';
        else return this.fail();
        return { type: 'need' };
      case 'zero':
        if (character === '.') this.numberState = 'fractionDot';
        else if (character === 'e' || character === 'E') this.numberState = 'exponentStart';
        else if (delimiter) return this.finishNumber(character);
        else return this.fail();
        return { type: 'need' };
      case 'integer':
        if (isDigit(character)) this.numberState = 'integer';
        else if (character === '.') this.numberState = 'fractionDot';
        else if (character === 'e' || character === 'E') this.numberState = 'exponentStart';
        else if (delimiter) return this.finishNumber(character);
        else return this.fail();
        return { type: 'need' };
      case 'fractionDot':
        if (!isDigit(character)) return this.fail();
        this.numberState = 'fraction';
        return { type: 'need' };
      case 'fraction':
        if (isDigit(character)) this.numberState = 'fraction';
        else if (character === 'e' || character === 'E') this.numberState = 'exponentStart';
        else if (delimiter) return this.finishNumber(character);
        else return this.fail();
        return { type: 'need' };
      case 'exponentStart':
        if (character === '+' || character === '-') this.numberState = 'exponentSign';
        else if (isDigit(character)) this.numberState = 'exponent';
        else return this.fail();
        return { type: 'need' };
      case 'exponentSign':
        if (!isDigit(character)) return this.fail();
        this.numberState = 'exponent';
        return { type: 'need' };
      case 'exponent':
        if (isDigit(character)) this.numberState = 'exponent';
        else if (delimiter) return this.finishNumber(character);
        else return this.fail();
        return { type: 'need' };
      default:
        return this.fail();
    }
  }

  finishNumber(character) {
    if (!['zero', 'integer', 'fraction', 'exponent'].includes(this.numberState)) {
      return this.fail();
    }
    return this.finishValueAtDelimiter(character);
  }

  finishValueAtDelimiter(character) {
    const result = this.finishValue();
    if (result.type === 'done') {
      result.reprocess = true;
      return result;
    }
    // The delimiter was not part of the primitive. Once the primitive has
    // advanced its parent to `afterValue`, feed that same delimiter to the
    // parent context now. This is what lets `false}` and `1]` close nested
    // values without losing the closing punctuation.
    return this.consumeContext(character);
  }

  finishValue() {
    if (this.stack.length === 0) return { type: 'done', reprocess: false };
    const parent = this.stack[this.stack.length - 1];
    if (parent.state !== 'value' && parent.state !== 'valueOrEnd') return this.fail();
    parent.state = 'afterValue';
    this.mode = 'context';
    return { type: 'need' };
  }

  consumeContext(character) {
    const context = this.stack[this.stack.length - 1];
    if (!context) return this.fail();

    if (context.type === 'object') {
      if (context.state === 'keyOrEnd' || context.state === 'keyRequired') {
        if (isWhitespace(character)) return { type: 'need' };
        if (context.state === 'keyOrEnd' && character === '}') {
          this.stack.pop();
          const result = this.finishValue();
          return result;
        }
        if (character === '"') {
          context.state = 'key';
          this.mode = 'nested-key';
          this.stringEscape = false;
          this.stringUnicodeDigits = 0;
          return { type: 'need' };
        }
        return this.fail();
      }
      if (context.state === 'key') return this.fail();
      if (context.state === 'colon') {
        if (isWhitespace(character)) return { type: 'need' };
        if (character !== ':') return this.fail();
        context.state = 'value';
        return { type: 'need' };
      }
      if (context.state === 'value') return this.startValueInContext(character, context);
      if (context.state === 'afterValue') {
        if (isWhitespace(character)) return { type: 'need' };
        if (character === ',') {
          context.state = 'keyRequired';
          return { type: 'need' };
        }
        if (character === '}') {
          this.stack.pop();
          return this.finishValue();
        }
        return this.fail();
      }
      return this.fail();
    }

    if (context.state === 'valueOrEnd' || context.state === 'valueRequired') {
      if (isWhitespace(character)) return { type: 'need' };
      if (context.state === 'valueOrEnd' && character === ']') {
        this.stack.pop();
        return this.finishValue();
      }
      return this.startValueInContext(character, context);
    }
    if (context.state === 'value') return this.startValueInContext(character, context);
    if (context.state === 'afterValue') {
      if (isWhitespace(character)) return { type: 'need' };
      if (character === ',') {
        context.state = 'valueRequired';
        return { type: 'need' };
      }
      if (character === ']') {
        this.stack.pop();
        return this.finishValue();
      }
      return this.fail();
    }
    return this.fail();
  }

  startValueInContext(character, context) {
    const result = this.startValue(character);
    if (result.type === 'invalid') return result;
    // `startValue` changes mode for a nested container or a primitive. The
    // parent remains in `value` until `finishValue` advances it.
    if (context.state === 'valueOrEnd' || context.state === 'valueRequired') {
      if (!isWhitespace(character)) context.state = 'value';
    }
    return result;
  }

  consumeNestedKey(character) {
    if (this.stringUnicodeDigits > 0) {
      if (!isHexDigit(character)) return this.fail();
      this.stringUnicodeDigits -= 1;
      if (this.stringUnicodeDigits === 0) this.stringEscape = false;
      return { type: 'need' };
    }
    if (this.stringEscape) {
      if (character === 'u') {
        this.stringUnicodeDigits = 4;
        return { type: 'need' };
      }
      if (!'"\\/bfnrt'.includes(character)) return this.fail();
      this.stringEscape = false;
      return { type: 'need' };
    }
    if (character === '"') {
      const context = this.stack[this.stack.length - 1];
      if (!context || context.type !== 'object' || context.state !== 'key') return this.fail();
      context.state = 'colon';
      this.mode = 'context';
      return { type: 'need' };
    }
    if (character === '\\') {
      this.stringEscape = true;
      return { type: 'need' };
    }
    if (character < ' ') return this.fail();
    return { type: 'need' };
  }

  consume(character) {
    if (this.invalid) return { type: 'invalid' };
    if (this.mode === 'start') return this.startValue(character);
    if (this.mode === 'string' || this.mode === 'target-string') return this.consumeString(character);
    if (this.mode === 'nested-key') return this.consumeNestedKey(character);
    if (this.mode === 'literal') return this.consumeLiteral(character);
    if (this.mode === 'number') return this.consumeNumber(character);
    if (this.mode === 'context') return this.consumeContext(character);
    return this.fail();
  }

  finishAtEnd() {
    if (this.invalid) return { type: 'invalid' };
    if (this.mode === 'target-string' || this.mode === 'string' || this.mode === 'nested-key') {
      return { type: 'incomplete' };
    }
    if (this.mode === 'literal' && this.literalComplete) {
      if (this.target === 'stream' && this.literalExpected !== 'null') {
        this.result = this.literalValue;
      }
      return this.finishValue().type === 'done' ? { type: 'done' } : { type: 'incomplete' };
    }
    if (this.mode === 'number' && ['zero', 'integer', 'fraction', 'exponent'].includes(this.numberState)) {
      return this.finishValue().type === 'done' ? { type: 'done' } : { type: 'incomplete' };
    }
    return { type: 'incomplete' };
  }
}

class TopLevelJsonScanner {
  constructor({ maxModelChars }) {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.maxModelChars = maxModelChars;
    this.phase = 'start';
    this.rootCanEnd = true;
    this.keyEscape = false;
    this.keyUnicodeDigits = 0;
    this.keyRaw = '';
    this.keyOverflow = false;
    this.currentKey = null;
    this.valueScanner = null;
    this.rootValueScanner = null;
    this.model = null;
    this.stream = null;
    this.invalid = false;
    this.complete = false;
    this.finished = false;
    this.prefixDecodeIncomplete = false;
  }

  fail() {
    this.invalid = true;
    this.phase = 'invalid';
    this.model = null;
    this.stream = null;
  }

  resetKey() {
    this.keyEscape = false;
    this.keyUnicodeDigits = 0;
    this.keyRaw = '';
    this.keyOverflow = false;
  }

  appendKeyRaw(character) {
    if (this.keyRaw.length >= KEY_CAPTURE_LIMIT) {
      this.keyOverflow = true;
      return;
    }
    this.keyRaw += character;
  }

  finishKey() {
    if (this.keyOverflow) {
      this.currentKey = null;
      return;
    }
    try {
      this.currentKey = JSON.parse(`"${this.keyRaw}"`);
    } catch {
      this.fail();
    }
  }

  consumeKey(character) {
    if (this.keyUnicodeDigits > 0) {
      if (!isHexDigit(character)) return this.fail();
      this.keyUnicodeDigits -= 1;
      this.appendKeyRaw(character);
      if (this.keyUnicodeDigits === 0) this.keyEscape = false;
      return;
    }
    if (this.keyEscape) {
      if (character === 'u') {
        this.keyUnicodeDigits = 4;
        this.appendKeyRaw(character);
      } else if ('"\\/bfnrt'.includes(character)) {
        this.keyEscape = false;
        this.appendKeyRaw(character);
      } else {
        this.fail();
      }
      return;
    }
    if (character === '"') {
      this.finishKey();
      if (!this.invalid) this.phase = 'colon';
      return;
    }
    if (character === '\\') {
      this.keyEscape = true;
      this.appendKeyRaw(character);
      return;
    }
    if (character < ' ') {
      this.fail();
      return;
    }
    this.appendKeyRaw(character);
  }

  applyValueResult() {
    if (!this.valueScanner) return;
    if (this.currentKey === 'model') this.model = this.valueScanner.result;
    if (this.currentKey === 'stream') this.stream = this.valueScanner.result;
  }

  consumeRootValue(character) {
    const result = this.rootValueScanner.consume(character);
    if (result.type === 'invalid') {
      this.fail();
    } else if (result.type === 'done') {
      this.phase = 'rootAfterValue';
      if (result.reprocess) this.consumeCharacter(character);
    }
  }

  consumeCharacter(character) {
    if (this.invalid || this.finished || this.phase === 'not_object') return;
    if (this.phase === 'start') {
      if (isWhitespace(character)) return;
      if (character === '{') {
        this.phase = 'keyOrEnd';
      } else if ('["-0123456789tfn'.includes(character)) {
        this.rootValueScanner = new JsonValueScanner({ maxModelChars: this.maxModelChars });
        this.phase = 'rootValue';
        this.consumeRootValue(character);
      } else {
        this.fail();
      }
      return;
    }
    if (this.phase === 'rootValue') {
      this.consumeRootValue(character);
      return;
    }
    if (this.phase === 'rootAfterValue') {
      if (!isWhitespace(character)) this.fail();
      return;
    }
    if (this.phase === 'keyOrEnd') {
      if (isWhitespace(character)) return;
      if (character === '}' && this.rootCanEnd) {
        this.complete = true;
        this.phase = 'done';
      } else if (character === '"') {
        this.rootCanEnd = false;
        this.resetKey();
        this.phase = 'key';
      } else {
        this.fail();
      }
      return;
    }
    if (this.phase === 'key') {
      this.consumeKey(character);
      return;
    }
    if (this.phase === 'colon') {
      if (isWhitespace(character)) return;
      if (character !== ':') {
        this.fail();
        return;
      }
      this.valueScanner = new JsonValueScanner({
        target: this.currentKey === 'model' || this.currentKey === 'stream' ? this.currentKey : null,
        maxModelChars: this.maxModelChars,
      });
      this.phase = 'value';
      return;
    }
    if (this.phase === 'value') {
      const result = this.valueScanner.consume(character);
      if (result.type === 'invalid') {
        this.fail();
      } else if (result.type === 'done') {
        this.applyValueResult();
        this.phase = 'afterValue';
        if (result.reprocess) this.consumeCharacter(character);
      }
      return;
    }
    if (this.phase === 'afterValue') {
      if (isWhitespace(character)) return;
      if (character === ',') {
        this.rootCanEnd = false;
        this.phase = 'keyOrEnd';
      } else if (character === '}') {
        this.complete = true;
        this.phase = 'done';
      } else {
        this.fail();
      }
      return;
    }
    if (this.phase === 'done') {
      if (!isWhitespace(character)) this.fail();
    }
  }

  push(buffer) {
    if (this.finished || this.invalid || this.phase === 'not_object') return;
    try {
      const text = this.decoder.decode(buffer, { stream: true });
      for (const character of text) this.consumeCharacter(character);
    } catch {
      this.fail();
    }
  }

  finish({ prefixTruncated = false } = {}) {
    if (this.finished) return;
    this.finished = true;
    if (!this.invalid) {
      try {
        const tail = this.decoder.decode();
        for (const character of tail) this.consumeCharacter(character);
      } catch {
        // A fatal decoder error after the observed prefix can mean either an
        // invalid byte sequence (already fully observed) or a valid code point
        // whose continuation bytes lie beyond the 64 KiB observation limit.
        // `push()` catches the former immediately; only the latter reaches
        // this branch with prefixTruncated=true.
        if (prefixTruncated) this.prefixDecodeIncomplete = true;
        else this.fail();
      }
    }
    if (!this.invalid && this.phase === 'rootValue' && this.rootValueScanner) {
      const result = this.rootValueScanner.finishAtEnd();
      if (result.type === 'done') this.phase = 'rootAfterValue';
      else if (result.type === 'invalid') this.fail();
    }
    if (!this.invalid && this.phase === 'value' && this.valueScanner) {
      const result = this.valueScanner.finishAtEnd();
      if (result.type === 'done') {
        this.applyValueResult();
        this.phase = 'afterValue';
      } else if (result.type === 'invalid') {
        this.fail();
      }
    }
  }

  snapshot() {
    let parseState = 'truncated';
    if (this.invalid || this.phase === 'invalid') parseState = 'invalid';
    else if (this.prefixDecodeIncomplete) parseState = 'truncated';
    else if (this.phase === 'not_object' || this.phase === 'rootAfterValue') parseState = 'not_object';
    else if (this.complete || this.phase === 'done') parseState = 'complete';
    return {
      model: this.model,
      stream: this.stream,
      parseState,
    };
  }
}

function normalizedLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(REQUEST_METADATA_PREFIX_MAX_BYTES, Math.max(0, Math.floor(number)));
}

function normalizedModelLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 256;
  return Math.min(256, Math.max(0, Math.floor(number)));
}

export function createRequestMetadataTee({
  prefixLimit = REQUEST_METADATA_PREFIX_BYTES,
  maxModelChars = 256,
  capturePrompt = false,
  budget = null,
} = {}) {
  const boundedPrefixLimit = normalizedLimit(prefixLimit, REQUEST_METADATA_PREFIX_BYTES);
  const boundedModelLimit = normalizedModelLimit(maxModelChars);
  const parser = new TopLevelJsonScanner({ maxModelChars: boundedModelLimit });
  let requestBytes = 0;
  let capturedPrefixBytes = 0;
  const promptPrefix = [];
  let promptCandidate = null;
  // Prompt buffering is the only unbounded-by-concurrency cost here, so it is
  // the only thing the shared budget governs. Losing the reservation stops the
  // buffering but not the scan: model and stream still come back.
  let bufferingPrompt = capturePrompt;
  // The amount the budget charged, not the bytes buffered: the two differ by the
  // amplification factor, and handing back a recomputed figure drifts.
  let reservedCost = 0;

  function releaseReservation() {
    if (reservedCost === 0) return;
    budget?.release(reservedCost);
    reservedCost = 0;
  }

  /** Give up prompt buffering for this request, returning what it held. */
  function abandonPromptBuffer() {
    bufferingPrompt = false;
    promptPrefix.length = 0;
    releaseReservation();
  }

  const stream = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      requestBytes += buffer.length;
      if (capturedPrefixBytes < boundedPrefixLimit) {
        const take = Math.min(boundedPrefixLimit - capturedPrefixBytes, buffer.length);
        if (take > 0) {
          try {
            parser.push(buffer.subarray(0, take));
            if (bufferingPrompt) {
              const charged = budget ? budget.tryReserve(take) : 0;
              if (charged === false) {
                // The pool is exhausted by other in-flight captures. Drop this
                // request's prompt rather than the request itself.
                abandonPromptBuffer();
              } else {
                reservedCost += charged;
                promptPrefix.push(Buffer.from(buffer.subarray(0, take)));
              }
            }
          } catch {
            // Metadata is best effort. Never turn a parser failure into a
            // failure of the byte-for-byte request proxy.
            parser.fail();
          }
          capturedPrefixBytes += take;
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        parser.finish({ prefixTruncated: requestBytes > capturedPrefixBytes });
        if (bufferingPrompt && requestBytes === capturedPrefixBytes) {
          const metadata = parser.snapshot();
          promptCandidate = extractPromptCandidate(Buffer.concat(promptPrefix), {
            parseState: metadata.parseState,
            // Whatever prefix this tee was allowed to buffer, the extractor must
            // be allowed to read — otherwise its own default silently re-imposes
            // the 64 KiB limit that raising `prefixLimit` was meant to lift.
            maxInputBytes: boundedPrefixLimit,
          });
        }
      } catch {
        // A malformed prefix must never turn a pass-through body into a
        // failed request during stream finalization.
        parser.fail();
      }
      promptPrefix.length = 0;
      releaseReservation();
      callback();
    },
  });

  // A body that never reaches flush must still return its reservation, or the
  // shared pool leaks until capture is off process-wide. 'close' covers the
  // paths where this Transform is itself ended or destroyed, and releasing is
  // idempotent so the overlap with flush() is harmless.
  //
  // It does NOT cover an aborted upload: `source.pipe(tee)` only unpipes when
  // the source dies, so this Transform is left open and never closes. Callers
  // must therefore attach the request stream via `trackSource` — verified
  // against a real client abort, where 6 MiB of body left 18 MiB reserved.
  stream.on('close', releaseReservation);

  return {
    stream,

    /**
     * Release this tee's reservation when `source` terminates, however it does.
     * Piping does not propagate a dead source to its destination, so without
     * this an aborted upload holds its share of the pool forever.
     */
    trackSource(source) {
      source?.once?.('close', releaseReservation);
      source?.once?.('error', releaseReservation);
      source?.once?.('aborted', releaseReservation);
    },

    snapshot() {
      const metadata = parser.snapshot();
      return {
        requestBytes,
        capturedPrefixBytes,
        // The limit actually in force after clamping, so callers (and tests)
        // can observe that a request was clamped rather than infer it.
        prefixLimit: boundedPrefixLimit,
        model: metadata.model,
        stream: metadata.stream,
        parseState: metadata.parseState,
      };
    },
    conversationCandidate() {
      return promptCandidate;
    },
  };
}
