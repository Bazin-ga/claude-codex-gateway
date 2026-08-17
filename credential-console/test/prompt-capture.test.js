import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROMPT_CAPTURE_MAX_BLOCK_BYTES,
  PROMPT_CAPTURE_MAX_INPUT_BYTES,
  PROMPT_CAPTURE_MAX_TEXT_BLOCKS,
  PROMPT_CAPTURE_MAX_TEXT_BYTES,
  PROMPT_CAPTURE_SEPARATOR,
  extractPromptCandidate,
} from '../lib/prompt-capture.js';

function request(messages, extra = {}) {
  return { model: 'fixture-model', messages, ...extra };
}

function parse(messages, options = {}) {
  return extractPromptCandidate(Buffer.from(JSON.stringify(request(messages))), options);
}

test('pure tool_result is not a human prompt candidate', () => {
  const result = parse([{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }],
  }]);
  assert.equal(result, null);
});

test('pure text in the final user message is captured', () => {
  const result = parse([{
    role: 'user',
    content: [{ type: 'text', text: '  human question  ' }],
  }]);
  assert.deepEqual(result, {
    promptText: '  human question  ',
    messageIndex: 0,
    contentBlockCount: 1,
    textBlockCount: 1,
  });
});

test('mixed content keeps only text blocks in original order', () => {
  const result = parse([{
    role: 'user',
    content: [
      { type: 'text', text: 'first text' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'secret tool result' }] },
      { type: 'text', text: 'second text' },
    ],
  }]);
  assert.deepEqual(result, {
    promptText: `first text${PROMPT_CAPTURE_SEPARATOR}second text`,
    messageIndex: 0,
    contentBlockCount: 3,
    textBlockCount: 2,
  });
  assert.equal(result.promptText.includes('secret tool result'), false);
});

test('empty content is not a human prompt candidate', () => {
  assert.equal(parse([{ role: 'user', content: [] }]), null);
});

test('only the final message and exact user/array shape qualify', () => {
  assert.equal(parse([
    { role: 'user', content: [{ type: 'text', text: 'earlier turn' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'assistant answer' }] },
  ]), null);
  assert.equal(parse([{ role: 'user', content: 'plain string content' }]), null);
  assert.equal(parse([{ role: 'user', content: [{ type: 'text', text: '   ' }] }]), null);
  assert.equal(parse([{ role: 'user', content: [{ type: 'text', text: 42 }] }]), null);
});

test('P2 parse state must be complete, including through the tee envelope', () => {
  const body = Buffer.from(JSON.stringify(request([
    { role: 'user', content: [{ type: 'text', text: 'should not capture' }] },
  ])));
  assert.equal(extractPromptCandidate(body, { parseState: 'truncated' }), null);
  assert.equal(extractPromptCandidate(body, { parseState: 'invalid' }), null);
  assert.equal(extractPromptCandidate({ prefix: body, parseState: 'pending' }), null);
  assert.deepEqual(extractPromptCandidate({ prefix: body, parseState: 'complete' }), {
    promptText: 'should not capture',
    messageIndex: 0,
    contentBlockCount: 1,
    textBlockCount: 1,
  });
});

test('malformed, truncated, non-object, and invalid UTF-8 inputs return null', () => {
  assert.equal(extractPromptCandidate(Buffer.from('{"messages":[{"role":"user"}')), null);
  assert.equal(extractPromptCandidate(Buffer.from('[{"messages":[]}]')), null);
  assert.equal(extractPromptCandidate(Buffer.from([0x7b, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x73, 0x22, 0x3a, 0xff, 0x7d])), null);
  assert.equal(extractPromptCandidate(Buffer.alloc(0)), null);
});

test('valid UTF-8 split at every byte boundary remains decodable', () => {
  const body = Buffer.from(JSON.stringify(request([
    { role: 'user', content: [{ type: 'text', text: 'hé🙂' }] },
  ])));
  for (let split = 1; split < body.length; split += 1) {
    const first = body.subarray(0, split);
    const second = body.subarray(split);
    // The pure parser receives the complete prefix; concatenating the chunks
    // models P2's captured prefix without introducing a second body consumer.
    assert.equal(extractPromptCandidate(Buffer.concat([first, second])).promptText, 'hé🙂');
  }
});

test('input and output bounds are hard-clamped and never silently truncate text', () => {
  const largeInput = Buffer.from(JSON.stringify(request([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(40 * 1024) }] },
  ])));
  assert.ok(largeInput.length < PROMPT_CAPTURE_MAX_INPUT_BYTES);
  assert.equal(extractPromptCandidate(largeInput, { maxPromptBytes: 100 * 1024 }), null);
  assert.equal(extractPromptCandidate(Buffer.concat([largeInput, Buffer.alloc(40 * 1024)]), {
    maxInputBytes: 100 * 1024,
  }), null);

  assert.equal(extractPromptCandidate(request([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(PROMPT_CAPTURE_MAX_BLOCK_BYTES + 1) }] },
  ]), { maxBlockBytes: 100 * 1024 }), null);
  assert.equal(extractPromptCandidate(request([
    { role: 'user', content: Array.from({ length: PROMPT_CAPTURE_MAX_TEXT_BLOCKS + 1 }, () => ({ type: 'text', text: 'x' })) },
  ]), { maxTextBlocks: 10_000 }), null);
  assert.equal(extractPromptCandidate(request([
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(PROMPT_CAPTURE_MAX_TEXT_BYTES + 1) }] },
  ]), { maxPromptBytes: 100 * 1024 }), null);
});

test('text block order, exact whitespace, and byte accounting are stable', () => {
  const result = extractPromptCandidate(request([
    { role: 'user', content: [
      { type: 'text', text: '\n alpha \n' },
      { type: 'text', text: '\t beta  ' },
    ] },
  ]));
  assert.equal(result.promptText, `\n alpha \n${PROMPT_CAPTURE_SEPARATOR}\t beta  `);
  assert.equal(
    Buffer.byteLength(result.promptText, 'utf8'),
    Buffer.byteLength('\n alpha \n\n\n\t beta  ', 'utf8'),
  );
});

test('structural output excludes headers, tokens, and unrelated request fields', () => {
  const tokenCanary = 'device-token-must-not-be-structural-output';
  const headerCanary = 'authorization-header-must-not-be-structural-output';
  const result = extractPromptCandidate(request([
    { role: 'user', content: [{ type: 'text', text: 'safe prompt' }] },
  ], {
    headers: { authorization: headerCanary },
    token: tokenCanary,
    credential: 'credential-canary',
  }));
  assert.deepEqual(Object.keys(result).sort(), [
    'contentBlockCount',
    'messageIndex',
    'promptText',
    'textBlockCount',
  ]);
  assert.equal(JSON.stringify(result).includes(headerCanary), false);
  assert.equal(JSON.stringify(result).includes(tokenCanary), false);
  assert.equal(JSON.stringify(result).includes('credential-canary'), false);
});

test('hostile parsed objects and unpaired surrogates fail closed', () => {
  const getter = {};
  Object.defineProperty(getter, 'messages', { get() { throw new Error('hostile getter'); } });
  assert.equal(extractPromptCandidate(getter), null);
  assert.equal(extractPromptCandidate(request([
    { role: 'user', content: [{ type: 'text', text: '\ud800' }] },
  ])), null);
});
