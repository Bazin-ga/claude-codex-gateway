import { Buffer } from 'node:buffer';

// Prompt display is a bounded, presentation-only boundary.  A request that is
// too large is returned unchanged; it is never partially unwrapped or clipped
// by this module's canonical API.
export const PROMPT_DISPLAY_MAX_BYTES = 32 * 1024;
export const PROMPT_DISPLAY_DEFAULT_MAX_CHARS = 32 * 1024;
export const PROMPT_DISPLAY_SOURCES = Object.freeze({
  CAPTURED_API_USER_TEXT: 'captured_api_user_text',
  WRAPPER_REMOVED: 'wrapper_removed',
  FALLBACK_RAW: 'fallback_raw',
  EMPTY: 'empty',
});

// These aliases make the provenance contract explicit without ever using a
// "human" source label.  The API message role alone cannot prove human origin.
export const PROMPT_DISPLAY_SOURCE = Object.freeze({
  API_USER_TEXT: PROMPT_DISPLAY_SOURCES.CAPTURED_API_USER_TEXT,
  CLIENT_WRAPPER: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
});

const WRAPPER_NAMES = Object.freeze(['session', 'conversation']);

function fallback(text) {
  return Object.freeze({
    text,
    source: PROMPT_DISPLAY_SOURCES.CAPTURED_API_USER_TEXT,
    suffixOmitted: false,
  });
}

function boundedMaximum(value) {
  if (!Number.isSafeInteger(value) || value < 1) return PROMPT_DISPLAY_MAX_BYTES;
  return Math.min(value, PROMPT_DISPLAY_MAX_BYTES);
}

function rootWrapperFor(text) {
  for (const name of WRAPPER_NAMES) {
    if (text.startsWith(`<${name}>\n`) || text.startsWith(`<${name}>\r\n`)) return name;
  }
  return null;
}

/**
 * Find the first closing tag that balances an exact root wrapper.  A nested
 * exact wrapper of the other supported kind makes the structure ambiguous;
 * callers see the original API text in that case instead of a guessed slice.
 */
function matchingClose(text, name, start) {
  const opening = `<${name}>`;
  const closing = `</${name}>`;
  const other = WRAPPER_NAMES.find((candidate) => candidate !== name);
  const otherTokens = [`<${other}>`, `</${other}>`];
  let depth = 1;
  let cursor = start;

  while (cursor < text.length) {
    const nextOpening = text.indexOf(opening, cursor);
    const nextClosing = text.indexOf(closing, cursor);
    const otherPositions = otherTokens
      .map((token) => text.indexOf(token, cursor))
      .filter((index) => index >= 0);
    const nextOther = otherPositions.length ? Math.min(...otherPositions) : -1;

    if (nextOther >= 0 && (nextOpening < 0 || nextOther < nextOpening)
      && (nextClosing < 0 || nextOther < nextClosing)) {
      return -1;
    }
    if (nextClosing < 0 && nextOpening < 0) return -1;

    // A protocol envelope is one flat root. Nested roots are ambiguous user
    // content, so preserve the complete API text instead of guessing.
    if (nextOpening >= 0 && (nextClosing < 0 || nextOpening < nextClosing)) return -1;

    depth -= 1;
    if (depth === 0) return nextClosing;
    cursor = nextClosing + closing.length;
  }
  return -1;
}

/**
 * Unwrap only a complete, attribute-free <session> or <conversation> root.
 * Text after the matched root close is treated as a client suffix and is not
 * returned.  All other input is returned exactly as supplied by the API.
 */
export function displayPromptText(apiUserText, {
  maxBytes = PROMPT_DISPLAY_MAX_BYTES,
  allowWrapperRemoval = true,
} = {}) {
  if (typeof apiUserText !== 'string') return fallback(apiUserText);
  if (!allowWrapperRemoval) return fallback(apiUserText);
  if (Buffer.byteLength(apiUserText, 'utf8') > boundedMaximum(maxBytes)) {
    return fallback(apiUserText);
  }

  const name = rootWrapperFor(apiUserText);
  if (!name) return fallback(apiUserText);

  const openingLength = name.length + 2;
  const closeIndex = matchingClose(apiUserText, name, openingLength);
  if (closeIndex < openingLength) return fallback(apiUserText);

  const closeLength = name.length + 3;
  const suffix = apiUserText.slice(closeIndex + closeLength);
  let body = apiUserText.slice(openingLength, closeIndex);
  const hasOpeningLineBreak = body.startsWith('\n') || body.startsWith('\r\n');
  const hasClosingLineBreak = body.endsWith('\n') || body.endsWith('\r\n');
  const hasSafeSuffixBoundary = suffix.length === 0
    || suffix.startsWith('\n\n')
    || suffix.startsWith('\r\n\r\n');
  if (!hasOpeningLineBreak || !hasClosingLineBreak || !hasSafeSuffixBoundary) {
    return fallback(apiUserText);
  }
  // The live client envelope places its payload on the lines between the root
  // tags. Remove only those two structural line breaks; preserve every byte of
  // whitespace that belongs to the payload itself.
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\r\n')) body = body.slice(0, -2);
  else if (body.endsWith('\n')) body = body.slice(0, -1);
  if (!body.trim()) return fallback(apiUserText);
  return Object.freeze({
    text: body,
    source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    suffixOmitted: suffix.length > 0,
  });
}

function textFromInput(input) {
  if (typeof input === 'string') {
    return {
      text: input,
      suffixOmitted: false,
      promptSource: null,
      persistedSource: false,
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      text: '',
      suffixOmitted: false,
      promptSource: null,
      persistedSource: false,
    };
  }
  try {
    const text = [input.text, input.promptText, input.promptSnippet]
      .find((candidate) => typeof candidate === 'string') ?? '';
    return {
      text,
      suffixOmitted: input.suffixOmitted === true || input.promptSuffixOmitted === true,
      promptSource: typeof input.promptSource === 'string' ? input.promptSource : null,
      persistedSource: typeof input.promptSource === 'string',
    };
  } catch {
    return {
      text: '',
      suffixOmitted: false,
      promptSource: null,
      persistedSource: false,
    };
  }
}

function looksLikeUnrecognizedWrapper(value) {
  return /^<[A-Za-z][A-Za-z0-9:_-]*(?:\s[^>]*)?>/.test(value)
    || /<\/[A-Za-z][A-Za-z0-9:_-]*>\s*$/.test(value);
}

function clipText(value, maxChars) {
  if (maxChars === Infinity) return { text: value, omitted: false };
  const bounded = Number.isSafeInteger(maxChars) && maxChars >= 1
    ? Math.min(maxChars, PROMPT_DISPLAY_DEFAULT_MAX_CHARS)
    : PROMPT_DISPLAY_DEFAULT_MAX_CHARS;
  const codePoints = Array.from(value);
  if (codePoints.length <= bounded) return { text: value, omitted: false };
  return {
    text: codePoints.slice(0, bounded).join(''),
    omitted: true,
  };
}

/**
 * Compatibility/display adapter for views.  It accepts the stored row shape
 * and applies the same strict wrapper rule as displayPromptText.  maxChars is
 * only a view-level snippet bound; the canonical proxy path uses
 * displayPromptText and therefore keeps the complete bounded text.
 */
export function derivePromptDisplay(input, { maxChars = PROMPT_DISPLAY_DEFAULT_MAX_CHARS } = {}) {
  const normalized = textFromInput(input);
  const persistedSource = normalized.persistedSource
    && Object.values(PROMPT_DISPLAY_SOURCES).includes(normalized.promptSource)
    ? normalized.promptSource
    : null;
  if (!normalized.text) {
    return Object.freeze({
      text: '',
      source: persistedSource ?? PROMPT_DISPLAY_SOURCES.EMPTY,
      suffixOmitted: normalized.suffixOmitted,
    });
  }
  // Newer capture records persist the display text and provenance together.
  // Do not run the legacy wrapper heuristic again: the stored text may already
  // have had a wrapper removed by the capture path.
  const display = persistedSource
    ? { text: normalized.text, source: persistedSource, suffixOmitted: false }
    : displayPromptText(normalized.text);
  let source = display.source;
  if (!persistedSource
    && source === PROMPT_DISPLAY_SOURCES.CAPTURED_API_USER_TEXT
    && looksLikeUnrecognizedWrapper(normalized.text)) {
    source = PROMPT_DISPLAY_SOURCES.FALLBACK_RAW;
  }
  const clipped = clipText(display.text, maxChars);
  return Object.freeze({
    text: clipped.text,
    source,
    suffixOmitted: normalized.suffixOmitted || display.suffixOmitted || clipped.omitted,
  });
}

export const normalizePromptDisplay = displayPromptText;
