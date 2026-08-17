import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Writable } from 'node:stream';
import {
  REQUEST_METADATA_PREFIX_BYTES,
  createRequestMetadataTee,
} from '../lib/request-metadata.js';

async function runCapture(input, options = {}, { oneByteChunks = false } = {}) {
  const { stream, snapshot, conversationCandidate } = createRequestMetadataTee(options);
  const output = [];
  stream.on('data', (chunk) => output.push(Buffer.from(chunk)));
  const body = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (oneByteChunks) {
    for (const byte of body) stream.write(Buffer.from([byte]));
    stream.end();
  } else {
    stream.end(body);
  }
  await once(stream, 'end');
  return {
    output: Buffer.concat(output),
    snapshot: snapshot(),
    conversationCandidate: conversationCandidate(),
  };
}

test('exports the fixed 64 KiB observation limit', () => {
  assert.equal(REQUEST_METADATA_PREFIX_BYTES, 64 * 1024);
});

test('extracts root model and stream and preserves bytes', async () => {
  const body = Buffer.from('{"model":"claude-test","stream":true}');
  const result = await runCapture(body);
  assert.deepEqual(result.snapshot, {
    requestBytes: body.length,
    capturedPrefixBytes: body.length,
    model: 'claude-test',
    stream: true,
    parseState: 'complete',
  });
  assert.deepEqual(result.output, body);
  assert.equal(result.conversationCandidate, null);
});

test('the same bounded tee captures only an eligible final human text message when enabled', async () => {
  const body = Buffer.from(JSON.stringify({
    model: 'claude-human',
    stream: true,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '  exact first  ' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'never persist this' },
        { type: 'text', text: '\nsecond\n' },
      ],
    }],
  }));
  const result = await runCapture(body, { capturePrompt: true }, { oneByteChunks: true });
  assert.deepEqual(result.output, body);
  assert.equal(result.snapshot.model, 'claude-human');
  assert.equal(result.snapshot.stream, true);
  assert.deepEqual(result.conversationCandidate, {
    promptText: '  exact first  \n\n\nsecond\n',
    messageIndex: 0,
    contentBlockCount: 3,
    textBlockCount: 2,
  });
  assert.equal(result.conversationCandidate.promptText.includes('never persist this'), false);
});

test('the request tee does not capture tool-only, empty, or truncated bodies', async () => {
  for (const messages of [
    [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool' }] }],
    [{ role: 'user', content: [] }],
  ]) {
    const result = await runCapture(JSON.stringify({ model: 'skip', messages }), {
      capturePrompt: true,
    });
    assert.equal(result.conversationCandidate, null);
  }
  const truncated = await runCapture(JSON.stringify({
    padding: 'x'.repeat(REQUEST_METADATA_PREFIX_BYTES),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'too late' }] }],
  }), { capturePrompt: true });
  assert.equal(truncated.snapshot.parseState, 'truncated');
  assert.equal(truncated.conversationCandidate, null);
});

test('handles every byte as a separate chunk, including escaped strings', async () => {
  const body = Buffer.from(
    '{"model":"claude-\\u00e9-\\ud83d\\ude00-🙂","stream":false}',
  );
  const result = await runCapture(body, {}, { oneByteChunks: true });
  assert.equal(result.snapshot.model, 'claude-é-😀-🙂');
  assert.equal(result.snapshot.stream, false);
  assert.equal(result.snapshot.parseState, 'complete');
  assert.deepEqual(result.output, body);
});

test('handles UTF-8 code points split at every byte boundary', async () => {
  const body = Buffer.from(JSON.stringify({ model: 'hé🙂', stream: true }));
  const result = await runCapture(body, {}, { oneByteChunks: true });
  assert.equal(result.snapshot.model, 'hé🙂');
  assert.equal(result.snapshot.stream, true);
  assert.equal(result.snapshot.parseState, 'complete');
  assert.deepEqual(result.output, body);
});

test('rejects invalid UTF-8 instead of replacing it with U+FFFD', async () => {
  const body = Buffer.concat([
    Buffer.from('{"model":"'),
    Buffer.from([0xff]),
    Buffer.from('","stream":true}'),
  ]);
  const result = await runCapture(body);
  assert.equal(result.snapshot.model, null);
  assert.equal(result.snapshot.stream, null);
  assert.equal(result.snapshot.parseState, 'invalid');
  assert.deepEqual(result.output, body);
});

test('ignores nested model and stream fields', async () => {
  const body = Buffer.from(JSON.stringify({
    messages: [{ model: 'nested-model', stream: false }],
    metadata: { model: 'another-nested-model', stream: false },
    model: 'root-model',
    stream: true,
  }));
  const result = await runCapture(body);
  assert.equal(result.snapshot.model, 'root-model');
  assert.equal(result.snapshot.stream, true);
  assert.equal(result.snapshot.parseState, 'complete');
  assert.deepEqual(result.output, body);
});

test('container values cannot lend nested primitives to top-level model or stream', async () => {
  for (const value of [
    { model: ['nested-model'], stream: { nested: true } },
    { model: { nested: 'nested-model' }, stream: [false] },
    { model: [['nested-model']], stream: [{ nested: true }] },
  ]) {
    const body = Buffer.from(JSON.stringify(value));
    const result = await runCapture(body, {}, { oneByteChunks: true });
    assert.equal(result.snapshot.model, null);
    assert.equal(result.snapshot.stream, null);
    assert.equal(result.snapshot.parseState, 'complete');
    assert.deepEqual(result.output, body);
  }
});

test('parses fields when syntax is split around keys, escapes, and delimiters', async () => {
  const chunks = [
    Buffer.from('{"mes'),
    Buffer.from('sages":[{"model":"nested"}],"mo'),
    Buffer.from('del":"root-'),
    Buffer.from('\\u00e9","str'),
    Buffer.from('eam":'),
    Buffer.from('tr'),
    Buffer.from('ue}'),
  ];
  const { stream, snapshot } = createRequestMetadataTee();
  const output = [];
  stream.on('data', (chunk) => output.push(Buffer.from(chunk)));
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await once(stream, 'end');
  const body = Buffer.concat(chunks);
  assert.deepEqual(snapshot(), {
    requestBytes: body.length,
    capturedPrefixBytes: body.length,
    model: 'root-é',
    stream: true,
    parseState: 'complete',
  });
  assert.deepEqual(Buffer.concat(output), body);
});

test('captures at most 64 KiB while forwarding a much larger body unchanged', async () => {
  const body = Buffer.from(JSON.stringify({
    huge: 'x'.repeat(128 * 1024),
    model: 'after-the-prefix',
    stream: true,
  }));
  const result = await runCapture(body);
  assert.equal(result.snapshot.requestBytes, body.length);
  assert.equal(result.snapshot.capturedPrefixBytes, REQUEST_METADATA_PREFIX_BYTES);
  assert.equal(result.snapshot.model, null);
  assert.equal(result.snapshot.stream, null);
  assert.equal(result.snapshot.parseState, 'truncated');
  assert.deepEqual(result.output, body);
});

test('treats a multibyte code point cut at the prefix boundary as truncated', async () => {
  const opening = Buffer.from('{"model":"');
  const filler = Buffer.alloc(REQUEST_METADATA_PREFIX_BYTES - opening.length - 1, 0x61);
  const body = Buffer.concat([
    opening,
    filler,
    Buffer.from('🙂'),
    Buffer.from('","stream":true}'),
  ]);
  assert.ok(body.length > REQUEST_METADATA_PREFIX_BYTES);
  const result = await runCapture(body);
  assert.equal(result.snapshot.requestBytes, body.length);
  assert.equal(result.snapshot.capturedPrefixBytes, REQUEST_METADATA_PREFIX_BYTES);
  assert.equal(result.snapshot.model, null);
  assert.equal(result.snapshot.stream, null);
  assert.equal(result.snapshot.parseState, 'truncated');
  assert.deepEqual(result.output, body);
});

test('does not retain a giant non-target string in the parser', async () => {
  const body = Buffer.from(`{"prefix":"${'z'.repeat(200 * 1024)}","model":"not-seen"}`);
  const result = await runCapture(body);
  assert.equal(result.snapshot.requestBytes, body.length);
  assert.equal(result.snapshot.capturedPrefixBytes, REQUEST_METADATA_PREFIX_BYTES);
  assert.equal(result.snapshot.model, null);
  assert.equal(result.snapshot.stream, null);
  assert.deepEqual(result.output, body);
});

test('returns null for fields beyond a caller-selected prefix cap', async () => {
  const body = Buffer.from('{"model":"after-cap","stream":true}');
  const result = await runCapture(body, { prefixLimit: 8 });
  assert.equal(result.snapshot.requestBytes, body.length);
  assert.equal(result.snapshot.capturedPrefixBytes, 8);
  assert.equal(result.snapshot.model, null);
  assert.equal(result.snapshot.stream, null);
  assert.equal(result.snapshot.parseState, 'truncated');
  assert.deepEqual(result.output, body);
});

test('snapshot is safe and useful before the request body ends', async () => {
  const { stream, snapshot } = createRequestMetadataTee();
  stream.resume();
  const first = Buffer.from('{"model":"partial');
  stream.write(first);
  assert.deepEqual(snapshot(), {
    requestBytes: first.length,
    capturedPrefixBytes: first.length,
    model: null,
    stream: null,
    parseState: 'truncated',
  });
  const rest = Buffer.from('","stream":true}');
  stream.end(rest);
  await once(stream, 'end');
  assert.equal(snapshot().model, 'partial');
  assert.equal(snapshot().stream, true);
  assert.equal(snapshot().parseState, 'complete');
});

test('malformed, non-object, and wrong-typed values never break pass-through', async () => {
  const cases = [
    ['{"model":"unterminated', 'truncated'],
    ['{"model":"ok",}', 'invalid'],
    ['{"model":42,"stream":"true"}', 'complete'],
    ['[{"model":"nested","stream":true}]', 'not_object'],
    ['null', 'not_object'],
    ['not-json', 'invalid'],
  ];
  for (const [text, parseState] of cases) {
    const body = Buffer.from(text);
    const result = await runCapture(body);
    assert.equal(result.snapshot.parseState, parseState, text);
    assert.equal(result.snapshot.model, null, text);
    assert.equal(result.snapshot.stream, null, text);
    assert.deepEqual(result.output, body, text);
  }
});

test('model values above the bounded output size are not retained', async () => {
  const body = Buffer.from(JSON.stringify({ model: 'm'.repeat(257), stream: true }));
  const result = await runCapture(body);
  assert.equal(result.snapshot.model, null);
  assert.equal(result.snapshot.stream, true);
  assert.equal(result.snapshot.parseState, 'complete');
  assert.deepEqual(result.output, body);
});

test('hard-clamps maxModelChars to 256', async () => {
  const body = Buffer.from(JSON.stringify({ model: 'm'.repeat(300), stream: true }));
  const result = await runCapture(body, { maxModelChars: 10_000 });
  assert.equal(result.snapshot.model, null);
  assert.equal(result.snapshot.stream, true);
  assert.equal(result.snapshot.parseState, 'complete');
  assert.deepEqual(result.output, body);
});

test('a parser failure is isolated from the pass-through stream', async () => {
  const body = Buffer.from('{"model":"ok", trailing garbage');
  const result = await runCapture(body);
  assert.equal(result.snapshot.parseState, 'invalid');
  assert.deepEqual(result.output, body);
});

test('Transform backpressure still drains byte-identically', async () => {
  const body = Buffer.from(JSON.stringify({ model: 'backpressure', stream: true })
    .repeat(4_000));
  const { stream, snapshot } = createRequestMetadataTee();
  const output = [];
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      output.push(Buffer.from(chunk, encoding));
      setImmediate(callback);
    },
  });
  stream.pipe(sink);
  for (let offset = 0; offset < body.length;) {
    const end = Math.min(offset + 97, body.length);
    if (!stream.write(body.subarray(offset, end))) await once(stream, 'drain');
    offset = end;
  }
  stream.end();
  await once(sink, 'finish');
  assert.deepEqual(Buffer.concat(output), body);
  assert.equal(snapshot().requestBytes, body.length);
  assert.equal(snapshot().capturedPrefixBytes, REQUEST_METADATA_PREFIX_BYTES);
});
