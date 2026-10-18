import { modelPatternMatches } from './model-block-rules.js';

/**
 * Which models a Bedrock account may invoke.
 *
 * The pin is stored as one string in `account.bedrock.model_id` — the field the
 * first Bedrock accounts were registered with — and read here as a list: model
 * ids or `*` patterns separated by commas or whitespace. A single exact id, the
 * only thing that field held before, is a one-entry list and keeps meaning
 * exactly what it meant.
 *
 * A list rather than one id because one Bedrock key reaches every model the AWS
 * account can invoke, and the clients worth pointing at it need more than one:
 * Claude Code alone asks for a main model and a small fast one, and the same
 * key carries the OpenAI models Codex uses. The pin still exists for the reason
 * it always did — a device token must not reach models the operator never
 * meant to offer — so a bare `*` has to be typed on purpose.
 *
 * Patterns match the whole id, with the same matcher as the console-wide block
 * rules, so an operator reads both lists the same way.
 */
export const BEDROCK_MODEL_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9._:*-]{0,127}$/;
export const BEDROCK_MAX_MODEL_PATTERNS = 20;

/** The pin's patterns, or null when the value is missing or malformed. */
export function bedrockModelPatterns(value) {
  if (typeof value !== 'string') return null;
  const patterns = value.split(/[\s,]+/).filter(Boolean);
  if (patterns.length === 0 || patterns.length > BEDROCK_MAX_MODEL_PATTERNS) return null;
  if (!patterns.every((pattern) => BEDROCK_MODEL_PATTERN.test(pattern))) return null;
  return [...new Set(patterns)];
}

/** The pin as stored: its patterns joined by a comma and a space. */
export function normalizeBedrockModelPin(value) {
  const patterns = bedrockModelPatterns(String(value ?? ''));
  return patterns ? patterns.join(', ') : null;
}

export function bedrockModelAllowed(pin, model) {
  const patterns = bedrockModelPatterns(pin);
  if (typeof model !== 'string' || !model) return false;
  // The block-rule matcher refuses an all-wildcard pattern, rightly for a block
  // list; here it is the deliberate "any model" and is honoured as such.
  return Boolean(patterns?.some((pattern) => (
    /^\*+$/.test(pattern) || modelPatternMatches(pattern, model)
  )));
}

/** One exact id, for the places that need a concrete model to show. */
export function bedrockExampleModel(pin, preferred = () => true) {
  const exact = (bedrockModelPatterns(pin) ?? []).filter((pattern) => !pattern.includes('*'));
  return exact.find(preferred) ?? null;
}
