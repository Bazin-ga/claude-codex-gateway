import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayPromptText,
  derivePromptDisplay,
  PROMPT_DISPLAY_MAX_BYTES,
  PROMPT_DISPLAY_SOURCES,
} from '../lib/prompt-display.js';

test('unwraps exact complete session and conversation roots and omits client suffixes', () => {
  for (const root of ['session', 'conversation']) {
    const result = displayPromptText(`<${root}>\nhello\nworld\n</${root}>\n\nclient note hidden`);
    assert.deepEqual(result, {
      text: 'hello\nworld',
      source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
      suffixOmitted: true,
    });
  }
  assert.deepEqual(displayPromptText('<session>\nhello\n</session>'), {
    text: 'hello',
    source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    suffixOmitted: false,
  });
  assert.deepEqual(displayPromptText('<session>\n用户原句\n</session>\n\nclient suffix'), {
    text: '用户原句',
    source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    suffixOmitted: true,
  });
  assert.deepEqual(displayPromptText('<conversation>\r\n first\r\nsecond \r\n</conversation>'), {
    text: ' first\r\nsecond ',
    source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    suffixOmitted: false,
  });
});

test('only exact attribute-free matching roots are unwrapped', () => {
  for (const raw of [
    '<session role="user">hello</session>',
    '<conversation id="1">hello</conversation>',
    '<session>hello</conversation>',
    '<conversation>hello</session>',
    '<session>hello',
    'prefix <session>hello</session>',
    '<session><conversation>nested</conversation></session>',
    '<session>literal</session>',
    '<session>\nliteral\n</session> actual trailing user text',
    '<session>\n\n</session>',
    '<session>\nouter <session> nested\n</session>\n</session>',
  ]) {
    const result = displayPromptText(raw);
    assert.equal(result.text, raw);
    assert.equal(result.source, PROMPT_DISPLAY_SOURCES.CAPTURED_API_USER_TEXT);
    assert.equal(result.suffixOmitted, false);
  }
});

test('oversized or unwrapped API text is returned unchanged and never called human text', () => {
  const oversized = 'x'.repeat(PROMPT_DISPLAY_MAX_BYTES + 1);
  const result = displayPromptText(oversized);
  assert.equal(result.text, oversized);
  assert.equal(result.suffixOmitted, false);
  assert.notEqual(result.source, 'human');
  assert.equal(displayPromptText('plain API user text').text, 'plain API user text');
});

test('view adapter accepts stored row input while retaining the strict wrapper contract', () => {
  const result = derivePromptDisplay({
    promptText: '<conversation>\nshown\n</conversation>\n\nhidden client suffix',
    promptBytes: 64,
  }, { maxChars: 100 });
  assert.deepEqual(result, {
    text: 'shown',
    source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    suffixOmitted: true,
  });
});

test('view adapter trusts persisted provenance from a newer capture row', () => {
  const result = derivePromptDisplay({
    promptText: 'already displayed text',
    promptSource: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    promptSuffixOmitted: true,
  });
  assert.deepEqual(result, {
    text: 'already displayed text',
    source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    suffixOmitted: true,
  });
});

test('Claude hook prompts remain exact even when the user types wrapper-shaped text', () => {
  const text = '<session>\nthis is literal user text\n</session>';
  assert.deepEqual(derivePromptDisplay({
    promptText: text,
    promptSource: PROMPT_DISPLAY_SOURCES.CLAUDE_HOOK,
  }), {
    text,
    source: PROMPT_DISPLAY_SOURCES.CLAUDE_HOOK,
    suffixOmitted: false,
  });
});

test('legacy unclassified rows use the strict wrapper heuristic instead of trusting a default', () => {
  assert.deepEqual(derivePromptDisplay({
    promptText: '<session>\nlegacy user body\n</session>\n\nlegacy client suffix',
    promptSource: 'legacy_unclassified',
    promptSuffixOmitted: false,
  }), {
    text: 'legacy user body',
    source: PROMPT_DISPLAY_SOURCES.WRAPPER_REMOVED,
    suffixOmitted: true,
  });
});
