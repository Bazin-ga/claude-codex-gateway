import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexTurnMetadata,
  extractCodexPromptCandidate,
} from '../lib/codex-prompt-capture.js';
import { createCodexResponseContentAssembler } from '../lib/codex-response-content.js';

const userItem = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const body = (...input) => JSON.stringify({ model: 'gpt-5.4', stream: true, input });

test('the prompt is the last user message, not the preamble before it', () => {
  // Verbatim shape from a live codex-cli 0.138.0 request.
  const candidate = extractCodexPromptCandidate(body(
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…' }] },
    userItem('<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>'),
    userItem('hello there, this is my prompt'),
  ));
  assert.equal(candidate.promptText, 'hello there, this is my prompt');
  assert.equal(candidate.itemIndex, 2);
});

test('a trailing non-user message is stepped over, not mistaken for the prompt', () => {
  // Multi-turn history ends with the assistant's last reply; the prompt is the
  // user message before it, and role is the only thing distinguishing them.
  const candidate = extractCodexPromptCandidate(body(
    userItem('the real question'),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a previous answer' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'a later instruction' }] },
  ));
  assert.equal(candidate.promptText, 'the real question');
});

test('tool traffic between turns is not a prompt', () => {
  const candidate = extractCodexPromptCandidate(body(
    userItem('run the tests'),
    { type: 'function_call', name: 'shell', call_id: 'c1' },
    { type: 'function_call_output', call_id: 'c1', output: '42 passing' },
  ));
  assert.equal(candidate.promptText, 'run the tests');

  // A continuation carrying no user message at all yields nothing rather than
  // repeating whatever came last.
  assert.equal(extractCodexPromptCandidate(body(
    { type: 'function_call_output', call_id: 'c1', output: 'done' },
  )), null);
});

test('non-text content is skipped rather than stringified', () => {
  const candidate = extractCodexPromptCandidate(JSON.stringify({
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        { type: 'input_text', text: 'what is in this picture?' },
      ],
    }],
  }));
  assert.equal(candidate.promptText, 'what is in this picture?');
  assert.equal(candidate.contentBlockCount, 2);
});

test('shapes that are not confidently a prompt yield nothing', () => {
  for (const input of [
    '', 'not json', '{}', JSON.stringify({ input: [] }),
    JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'a string' }] }),
    JSON.stringify({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text' }] }] }),
    JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'anthropic shape' }] }] }),
  ]) {
    assert.equal(extractCodexPromptCandidate(input), null, JSON.stringify(input).slice(0, 40));
  }
});

test('an over-long prompt is trimmed and says so', () => {
  const candidate = extractCodexPromptCandidate(body(userItem('x'.repeat(5000))), {
    maxTextBytes: 1000,
    maxBlockBytes: 10_000,
  });
  assert.equal(candidate, null, 'a single block over the text budget is refused whole');

  const twoBlocks = extractCodexPromptCandidate(JSON.stringify({
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'y'.repeat(600) }, { type: 'input_text', text: 'z'.repeat(600) }],
    }],
  }), { maxTextBytes: 1000, maxBlockBytes: 10_000 });
  assert.equal(twoBlocks.suffixOmitted, true, 'what was dropped is reported, not hidden');
  assert.equal(twoBlocks.promptText.includes('z'), false);
});

test('the turn metadata header is read, and a broken one is ignored', () => {
  const meta = codexTurnMetadata({
    'x-codex-turn-metadata': JSON.stringify({
      session_id: '01a031c6-ed33-7523-8259-13caac4b3e8a',
      thread_id: '01a031c6-ed33-7523-8259-13caac4b3e8a',
      turn_id: '01a031c6-ed4b-7952-b9cf-8de08f5084c4',
      request_kind: 'turn',
    }),
  });
  assert.equal(meta.sessionId, '01a031c6-ed33-7523-8259-13caac4b3e8a');
  assert.equal(meta.turnId, '01a031c6-ed4b-7952-b9cf-8de08f5084c4');
  assert.equal(meta.requestKind, 'turn');

  assert.equal(codexTurnMetadata({}), null);
  assert.equal(codexTurnMetadata({ 'x-codex-turn-metadata': 'not json' }), null);
  assert.equal(codexTurnMetadata({ 'x-codex-turn-metadata': '"a string"' }), null);
});

function assemble(...chunks) {
  const a = createCodexResponseContentAssembler();
  for (const chunk of chunks) a.write(chunk);
  a.end();
  return a.snapshot();
}
const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;

test('the reply is assembled from its deltas', () => {
  const snapshot = assemble(
    sse({ type: 'response.created', response: { id: 'r1' } }),
    sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'Hello ' }),
    sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'world' }),
    sse({ type: 'response.completed', response: { id: 'r1' } }),
  );
  assert.equal(snapshot.text, 'Hello world');
  assert.equal(snapshot.status, 'complete');
});

test('the done event wins over the deltas, which is the point of reading it', () => {
  // A delta lost to a dropped chunk would otherwise leave a silently short
  // reply on record. `response.output_text.done` carries the whole part.
  const snapshot = assemble(
    sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'Hel' }),
    sse({ type: 'response.output_text.done', item_id: 'i1', content_index: 0, text: 'Hello world' }),
    sse({ type: 'response.completed', response: {} }),
  );
  assert.equal(snapshot.text, 'Hello world', 'not the truncated "Hel"');
});

test('a delta arriving after its part settled does not duplicate it', () => {
  const snapshot = assemble(
    sse({ type: 'response.output_text.done', item_id: 'i1', content_index: 0, text: 'Hello world' }),
    sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: ' world' }),
    sse({ type: 'response.completed', response: {} }),
  );
  assert.equal(snapshot.text, 'Hello world', 'the settled text is final');
});

test('separate output items stay separate and keep their order', () => {
  const snapshot = assemble(
    sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'first. ' }),
    sse({ type: 'response.output_text.delta', item_id: 'i2', content_index: 0, delta: 'second.' }),
    sse({ type: 'response.completed', response: {} }),
  );
  assert.equal(snapshot.text, 'first. second.');
});

test('reasoning is not recorded as something the model said', () => {
  const snapshot = assemble(
    sse({ type: 'response.reasoning_summary_text.delta', item_id: 'r1', delta: 'thinking about it' }),
    sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'the answer' }),
    sse({ type: 'response.completed', response: {} }),
  );
  assert.equal(snapshot.text, 'the answer');
});

test('a stream cut short is marked, not passed off as whole', () => {
  const a = createCodexResponseContentAssembler();
  a.write(sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'half a rep' }));
  a.abort();
  const snapshot = a.snapshot();
  assert.equal(snapshot.text, 'half a rep');
  assert.equal(snapshot.status, 'truncated');
  assert.equal(snapshot.truncated, true);
});

test('a terminal event missing its blank line still completes the reply', () => {
  const a = createCodexResponseContentAssembler();
  a.write(sse({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'done' }));
  a.write(`data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n`);
  a.end();
  assert.equal(a.snapshot().status, 'complete');
});

test('multi-byte characters split across chunks survive', () => {
  const bytes = Buffer.from(sse({
    type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: '这是中文回复',
  }), 'utf8');
  const a = createCodexResponseContentAssembler();
  for (let i = 0; i < bytes.length; i += 3) a.write(bytes.subarray(i, i + 3));
  a.write(sse({ type: 'response.completed', response: {} }));
  a.end();
  assert.equal(a.snapshot().text, '这是中文回复');
});
