import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODEL_BLOCK_MAX_PATTERNS,
  anyModelBlockRuleEnabled,
  modelBlockMessage,
  modelBlockRuleFor,
  modelPatternMatches,
  normalizeModelBlockRules,
  parseModelBlockRuleInput,
} from '../lib/model-block-rules.js';

test('a pattern without a wildcard matches one model and not its successor', () => {
  assert.equal(modelPatternMatches('claude-opus-5', 'claude-opus-5'), true);
  assert.equal(modelPatternMatches('claude-opus-5', 'claude-opus-5-5'), false,
    'blocking Opus 5 must not block the model everybody is told to move to');
  assert.equal(modelPatternMatches('claude-opus-5', 'CLAUDE-OPUS-5'), true, 'case is ignored');
  assert.equal(modelPatternMatches('claude-opus-5', 'xclaude-opus-5'), false, 'the whole id must match');
});

test('* stands for any run of characters, and nothing else is special', () => {
  assert.equal(modelPatternMatches('gpt-5.6*', 'gpt-5.6-sol'), true);
  assert.equal(modelPatternMatches('gpt-5.6*', 'gpt-5.6'), true);
  assert.equal(modelPatternMatches('gpt-5.6*', 'gpt-6-sol'), false);
  assert.equal(modelPatternMatches('gpt-5.6*', 'gpt-506-sol'), false, 'the dot is a dot, not any character');
  assert.equal(modelPatternMatches('claude-opus-5-2*', 'claude-opus-5-20250930'), true);
  assert.equal(modelPatternMatches('claude-opus-5-2*', 'claude-opus-5-5'), false);
  assert.equal(modelPatternMatches('*luna', 'gpt-6-luna'), true);
});

test('the first enabled rule that matches is the one that speaks', () => {
  const rules = normalizeModelBlockRules([
    { id: 'off', enabled: false, patterns: ['gpt-5.6*'], message_en: 'off' },
    { id: 'a', enabled: true, patterns: ['gpt-5.6-sol'], message_en: 'a' },
    { id: 'b', enabled: true, patterns: ['gpt-5.6*'], message_en: 'b' },
  ]);
  assert.equal(modelBlockRuleFor(rules, 'gpt-5.6-sol').id, 'a');
  assert.equal(modelBlockRuleFor(rules, 'gpt-5.6-luna').id, 'b');
  assert.equal(modelBlockRuleFor(rules, 'gpt-6-sol'), null);
  assert.equal(modelBlockRuleFor(rules, null), null);
  assert.equal(anyModelBlockRuleEnabled(rules), true);
  assert.equal(anyModelBlockRuleEnabled([rules[0]]), false);
});

test('a stored rule that cannot be understood blocks nothing', () => {
  const rules = normalizeModelBlockRules([
    null,
    { id: 'no-patterns', enabled: true, patterns: [], message_en: 'x' },
    { id: 'no-message', enabled: true, patterns: ['gpt-5.6*'] },
    { id: 'star', enabled: true, patterns: ['*', '**'], message_en: 'everything' },
    { enabled: true, patterns: ['gpt-5.6*'], message_en: 'no id' },
    { id: 'ok', enabled: 'yes', patterns: ['gpt-5.6*', 'bad pattern'], message_en: 'kept' },
  ]);
  assert.deepEqual(rules.map((rule) => rule.id), ['ok']);
  assert.equal(rules[0].enabled, false, 'only a literal true switches a rule on');
  assert.deepEqual(rules[0].patterns, ['gpt-5.6*'], 'the unusable pattern is dropped, not guessed at');
  assert.equal(normalizeModelBlockRules('nonsense').length, 0);
});

test('form input is refused rather than quietly repaired', () => {
  const rule = parseModelBlockRuleInput({
    patterns: ' claude-opus-5, claude-opus-5-2*，claude-opus-5\n',
    messageZh: '  建议使用 Opus 5.5。 ',
    messageEn: '',
    enabled: true,
  });
  assert.deepEqual(rule.patterns, ['claude-opus-5', 'claude-opus-5-2*'], 'split on commas of either width, deduplicated');
  assert.equal(rule.message_zh, '建议使用 Opus 5.5。');
  assert.equal(rule.enabled, true);

  assert.throws(() => parseModelBlockRuleInput({ patterns: '', messageEn: 'x' }), /at least one model pattern/);
  assert.throws(() => parseModelBlockRuleInput({ patterns: '*', messageEn: 'x' }), /not a usable model pattern/);
  assert.throws(() => parseModelBlockRuleInput({ patterns: 'gpt<5>', messageEn: 'x' }), /not a usable model pattern/);
  assert.throws(() => parseModelBlockRuleInput({ patterns: 'gpt-5.6*' }), /message in at least one language/);
  const many = Array.from({ length: MODEL_BLOCK_MAX_PATTERNS + 1 }, (_, i) => `m${i}`).join(',');
  assert.throws(() => parseModelBlockRuleInput({ patterns: many, messageEn: 'x' }), /at most/);
});

test('the refusal carries both languages and the model it refused', () => {
  const message = modelBlockMessage({ message_zh: '换 GPT 6。', message_en: 'Use GPT 6.' }, 'gpt-5.6-sol');
  assert.match(message, /gpt-5\.6-sol/);
  assert.match(message, /换 GPT 6。/);
  assert.match(message, /Use GPT 6\./);
  assert.doesNotMatch(modelBlockMessage({ message_zh: '', message_en: 'Only English.' }, 'm'), /网关/);
});
