/**
 * Gateway-wide model block rules: models the operators have decided nobody
 * should be spending on through this console, each with the message a caller
 * gets instead of an answer.
 *
 * These are edited from the console, not written here, because the reason for
 * a rule is almost always "a newer model is cheaper and better" — which stops
 * being true, or starts being true of a different model, every few weeks.
 *
 * A rule names models by pattern rather than by keyword. A substring would be
 * the obvious shape and is wrong for exactly the case these rules exist for:
 * `claude-opus-5` is a substring of `claude-opus-5-5`, so blocking the old
 * model by keyword would also block the one everybody is being told to move
 * to. A pattern matches the whole id; `*` stands for any run of characters.
 */

/** How many rules the console will hold. Far past any real list. */
export const MODEL_BLOCK_MAX_RULES = 50;
export const MODEL_BLOCK_MAX_PATTERNS = 20;
export const MODEL_BLOCK_MAX_PATTERN_CHARS = 128;
export const MODEL_BLOCK_MAX_MESSAGE_CHARS = 500;

// The characters model ids are actually made of, plus the wildcard. Anything
// else in a pattern is a typo, and a typo in a block rule is a rule that
// silently never matches.
const PATTERN_SHAPE = /^[A-Za-z0-9._:@/[\]*-]+$/;

function normalizedMessage(value) {
  return typeof value === 'string'
    ? value.trim().slice(0, MODEL_BLOCK_MAX_MESSAGE_CHARS)
    : '';
}

function patternRegExp(pattern) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

function usablePattern(pattern) {
  return typeof pattern === 'string'
    && pattern.length <= MODEL_BLOCK_MAX_PATTERN_CHARS
    && PATTERN_SHAPE.test(pattern)
    // A pattern of nothing but wildcards blocks every model on the gateway.
    // That is a shutdown, not a rule, and should not be one keystroke away.
    && /[^*]/.test(pattern);
}

/**
 * The stored list, normalized. A rule that cannot be understood is dropped
 * rather than guessed at: a malformed record must not be able to block
 * traffic nobody asked to block.
 */
export function normalizeModelBlockRules(value) {
  if (!Array.isArray(value)) return [];
  const rules = [];
  for (const rule of value.slice(0, MODEL_BLOCK_MAX_RULES)) {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !rule.id) continue;
    const patterns = Array.isArray(rule.patterns)
      ? rule.patterns.filter(usablePattern).slice(0, MODEL_BLOCK_MAX_PATTERNS)
      : [];
    const messageZh = normalizedMessage(rule.message_zh);
    const messageEn = normalizedMessage(rule.message_en);
    if (!patterns.length || (!messageZh && !messageEn)) continue;
    rules.push({
      id: rule.id,
      enabled: rule.enabled === true,
      patterns,
      message_zh: messageZh,
      message_en: messageEn,
      created_at: typeof rule.created_at === 'string' ? rule.created_at : null,
      updated_at: typeof rule.updated_at === 'string' ? rule.updated_at : null,
      updated_by: typeof rule.updated_by === 'string' ? rule.updated_by : null,
    });
  }
  return rules;
}

/**
 * Validate what a form submitted. Unlike the normalizer this refuses rather
 * than drops: quietly discarding a mistyped pattern would leave somebody
 * believing a model is blocked when it is not.
 */
export function parseModelBlockRuleInput({ patterns, messageZh, messageEn, enabled }) {
  const list = String(patterns ?? '')
    .split(/[\s,，]+/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (!list.length) throw new Error('a block rule needs at least one model pattern');
  if (list.length > MODEL_BLOCK_MAX_PATTERNS) {
    throw new Error(`a block rule holds at most ${MODEL_BLOCK_MAX_PATTERNS} patterns`);
  }
  for (const pattern of list) {
    if (!usablePattern(pattern)) {
      throw new Error(
        `"${pattern.slice(0, MODEL_BLOCK_MAX_PATTERN_CHARS)}" is not a usable model pattern: `
        + 'use letters, digits, . _ - : / @ and * as the wildcard, and name at least one character',
      );
    }
  }
  const zh = normalizedMessage(messageZh);
  const en = normalizedMessage(messageEn);
  if (!zh && !en) throw new Error('a block rule needs a message in at least one language');
  return {
    enabled: enabled === true,
    patterns: [...new Set(list)],
    message_zh: zh,
    message_en: en,
  };
}

/** Whether one pattern matches a model id, whole and case-insensitively. */
export function modelPatternMatches(pattern, model) {
  if (typeof model !== 'string' || !model || !usablePattern(pattern)) return false;
  return patternRegExp(pattern).test(model);
}

/** The first enabled rule that blocks this model, or null. */
export function modelBlockRuleFor(rules, model) {
  if (typeof model !== 'string' || !model) return null;
  for (const rule of rules ?? []) {
    if (!rule?.enabled) continue;
    if (rule.patterns.some((pattern) => modelPatternMatches(pattern, model))) return rule;
  }
  return null;
}

/** Whether any rule is switched on, which is what decides if bodies are read at all. */
export function anyModelBlockRuleEnabled(rules) {
  return (rules ?? []).some((rule) => rule?.enabled);
}

/** What a caller reads when a rule stops their request. */
export function modelBlockMessage(rule, model) {
  const name = typeof model === 'string' && model ? model : 'this model';
  const parts = [];
  if (rule?.message_zh) parts.push(`网关已禁用 ${name}：${rule.message_zh}`);
  if (rule?.message_en) parts.push(`${name} is blocked by this gateway: ${rule.message_en}`);
  return parts.join(' / ');
}

/**
 * What a caller reads when the body could not be checked at all — a second
 * `model` key, or syntax this parser cannot follow. Neither comes from a real
 * client, so the message is about the request rather than any rule.
 */
export const MODEL_POLICY_UNCHECKABLE_MESSAGE = 'the request body could not be checked against this gateway\'s model rules '
  + '(请求体无法通过网关的模型规则检查)';
