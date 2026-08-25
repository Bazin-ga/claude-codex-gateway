import { Buffer } from 'node:buffer';

/**
 * Prompt extraction for the Codex (OpenAI Responses) request shape.
 *
 * A sibling of prompt-capture.js rather than a mode inside it, for the same
 * reason codex-usage.js is a sibling: the two request formats share no
 * structure, and the Claude path carries essentially all of today's traffic.
 *
 * The shapes differ in one way that matters here. Claude Code wraps its
 * environment preamble *around* the user's text in the same message, which is
 * why the Claude path needs `displayPromptText` to strip it and why stripping
 * is only allowed when a correlation header proves the envelope is real. The
 * Codex CLI sends its preamble as *separate* input items — a `developer`
 * message with the permissions text, then a `user` message holding
 * `<environment_context>`, then the person's actual prompt as its own item.
 * Observed live against codex-cli 0.138.0:
 *
 *   input[0] {type:"message", role:"developer", content:[{type:"input_text", …}]}
 *   input[1] {type:"message", role:"user",      content:[{type:"input_text", "<environment_context>…"}]}
 *   input[2] {type:"message", role:"user",      content:[{type:"input_text", "hello there, this is my prompt"}]}
 *
 * So the last user message *is* the prompt, with nothing to unwrap and nothing
 * to guess at. That is why this returns no `source` variants: there is only one.
 */
export const CODEX_PROMPT_MAX_INPUT_BYTES = 64 * 1024;
export const CODEX_PROMPT_MAX_ITEMS = 512;
export const CODEX_PROMPT_MAX_TEXT_BLOCKS = 128;
export const CODEX_PROMPT_MAX_BLOCK_BYTES = 16 * 1024;
export const CODEX_PROMPT_MAX_TEXT_BYTES = 32 * 1024;
export const CODEX_PROMPT_SEPARATOR = '\n\n';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The text-bearing block types. `input_text` is what the CLI sends; the other
 * two appear in Responses payloads generally and carry plain text just the
 * same. Images, audio and tool results are deliberately not text and are
 * skipped rather than stringified into something misleading.
 */
const TEXT_BLOCK_TYPES = new Set(['input_text', 'text', 'output_text']);

/**
 * @returns {{promptText: string, itemIndex: number, contentBlockCount: number,
 *            suffixOmitted: boolean}|null}
 *
 * Null whenever the shape is not confidently a user prompt. A wrong prompt
 * stored against a turn is worse than no prompt: the conversation view is read
 * as a record of what people asked.
 */
export function extractCodexPromptCandidate(input, {
  maxInputBytes = CODEX_PROMPT_MAX_INPUT_BYTES,
  maxItems = CODEX_PROMPT_MAX_ITEMS,
  maxTextBlocks = CODEX_PROMPT_MAX_TEXT_BLOCKS,
  maxBlockBytes = CODEX_PROMPT_MAX_BLOCK_BYTES,
  maxTextBytes = CODEX_PROMPT_MAX_TEXT_BYTES,
} = {}) {
  const text = typeof input === 'string'
    ? input
    : Buffer.isBuffer(input) ? input.toString('utf8') : null;
  if (text === null || !text) return null;
  if (Buffer.byteLength(text, 'utf8') > maxInputBytes) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A truncated prefix is the ordinary case, not an error: the tee hands over
    // whatever fitted in its budget.
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.input) || parsed.input.length === 0) return null;
  if (parsed.input.length > maxItems) return null;

  // Backwards, because the newest user message is the prompt for this turn.
  // Reasoning items, tool calls and tool outputs sit between turns and are not
  // messages, so they are stepped over rather than mistaken for one.
  let itemIndex = -1;
  for (let index = parsed.input.length - 1; index >= 0; index -= 1) {
    const item = parsed.input[index];
    if (!isRecord(item)) continue;
    if (item.type !== undefined && item.type !== 'message') continue;
    if (item.role !== 'user') continue;
    itemIndex = index;
    break;
  }
  if (itemIndex === -1) return null;

  const item = parsed.input[itemIndex];
  if (!Array.isArray(item.content)) return null;
  if (item.content.length > maxTextBlocks) return null;

  const parts = [];
  let bytes = 0;
  let suffixOmitted = false;
  for (const block of item.content) {
    if (!isRecord(block)) return null;
    if (!TEXT_BLOCK_TYPES.has(block.type)) continue;
    if (typeof block.text !== 'string') return null;
    const blockBytes = Buffer.byteLength(block.text, 'utf8');
    if (blockBytes > maxBlockBytes) return null;
    if (bytes + blockBytes > maxTextBytes) {
      // Keep what fits and say so, rather than storing a silently short prompt.
      suffixOmitted = true;
      break;
    }
    parts.push(block.text);
    bytes += blockBytes;
  }
  if (parts.length === 0) return null;
  const promptText = parts.join(CODEX_PROMPT_SEPARATOR);
  if (!promptText) return null;

  return {
    promptText,
    itemIndex,
    contentBlockCount: item.content.length,
    suffixOmitted,
  };
}

/**
 * The turn identity the CLI puts in `x-codex-turn-metadata`.
 *
 * One turn can cost several requests — the model calls a tool, the CLI answers
 * and asks again — and every one of them resends the same user prompt. Without
 * this, each round trip would be filed as a separate thing the person said.
 */
export function codexTurnMetadata(headers) {
  const raw = headers?.['x-codex-turn-metadata'];
  if (typeof raw !== 'string' || raw.length > 8 * 1024) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const field = (name) => (typeof parsed[name] === 'string' && parsed[name] ? parsed[name] : null);
  return {
    sessionId: field('session_id'),
    threadId: field('thread_id'),
    turnId: field('turn_id'),
    requestKind: field('request_kind'),
  };
}
