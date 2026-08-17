import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESPONSE_CONTENT_MAX_BLOCKS,
  RESPONSE_CONTENT_MAX_BYTES,
  RESPONSE_CONTENT_MAX_SSE_DATA_PARTS,
  RESPONSE_CONTENT_MAX_SSE_LINE_BYTES,
  assembleResponseContent,
  createResponseContentAssembler,
} from '../lib/response-content.js';

function splitBytes(buffer, sizes = [1, 2, 3, 5, 8]) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < buffer.length) {
    const size = sizes[index % sizes.length];
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    offset += size;
    index += 1;
  }
  return chunks;
}

function sseEvent(type, payload, lineEnding = '\r\n') {
  return `event: ${type}${lineEnding}data: ${JSON.stringify(payload)}${lineEnding}${lineEnding}`;
}

function feedChunks(chunks, options = {}) {
  const assembler = createResponseContentAssembler(options);
  for (const chunk of chunks) assembler.write(chunk);
  return assembler.end();
}

test('assembles only ordered assistant text from split CRLF SSE events', () => {
  const body = [
    'event: future_event\r\ndata: {not-json}\r\n\r\n',
    sseEvent('message_start', { type: 'message_start', message: { role: 'assistant', content: [] } }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '开头' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '中' },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', name: 'never-store' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'DO_NOT_STORE' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '文🌍' },
    }),
    sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
    sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 1,
    }),
    sseEvent('message_delta', {
      type: 'message_delta',
      usage: { input_tokens: 99, output_tokens: 99 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');

  const result = feedChunks(splitBytes(Buffer.from(body), [1]), { format: 'sse' });
  assert.equal(result.text, '开头中文🌍');
  assert.equal(result.capturedBytes, Buffer.byteLength(result.text, 'utf8'));
  assert.equal(result.truncated, false);
  assert.equal(result.status, 'complete');
  assert.equal(result.complete, true);
  assert.equal(result.incomplete, false);
  assert.equal(result.format, 'sse');
  assert.equal(result.reason, null);
  assert.equal(result.text.includes('DO_NOT_STORE'), false);
});

test('auto-detects non-streaming JSON and ignores non-text content blocks', () => {
  const body = JSON.stringify({
    id: 'message-id',
    role: 'assistant',
    content: [
      { type: 'tool_use', name: 'secret_tool', input: { value: 'DO_NOT_STORE' } },
      { type: 'thinking', thinking: 'DO_NOT_STORE' },
      { type: 'text', text: '第一' },
      { type: 'signature', signature: 'DO_NOT_STORE' },
      { type: 'text_delta', text: 'DO_NOT_STORE' },
      { type: 'text', text: '第二' },
    ],
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  const result = feedChunks(splitBytes(Buffer.from(body), [1, 4, 2]), { format: 'auto' });

  assert.equal(result.text, '第一第二');
  assert.equal(result.status, 'complete');
  assert.equal(result.complete, true);
  assert.equal(result.format, 'json');
  assert.equal(result.text.includes('DO_NOT_STORE'), false);
});

test('preserves a valid UTF-8 prefix under the capture cap and marks truncation', () => {
  const body = [
    sseEvent('message_start', { type: 'message_start', message: { role: 'assistant', content: [] } }, '\n'),
    sseEvent('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    }, '\n'),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'abc🌍def' },
    }, '\n'),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }, '\n'),
    sseEvent('message_stop', { type: 'message_stop' }, '\n'),
  ].join('');
  const result = feedChunks([Buffer.from(body)], { format: 'sse', maxBytes: 5 });

  assert.equal(result.text, 'abc');
  assert.equal(result.capturedBytes, 3);
  assert.equal(result.capturedBytes <= 5, true);
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'complete');
});

test('supports a one-megabyte text ceiling without an unbounded assembled value', () => {
  const text = 'x'.repeat(RESPONSE_CONTENT_MAX_BYTES + 17);
  const body = JSON.stringify({ role: 'assistant', content: [{ type: 'text', text }] });
  const result = assembleResponseContent([Buffer.from(body)], { format: 'json' });

  assert.equal(result.text.length, RESPONSE_CONTENT_MAX_BYTES);
  assert.equal(result.capturedBytes, RESPONSE_CONTENT_MAX_BYTES);
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'complete');
});

test('SSE retained line ceiling stays below the identity observation reservation', () => {
  assert.equal(RESPONSE_CONTENT_MAX_SSE_LINE_BYTES, 2 * 1024 * 1024);
  const assembler = createResponseContentAssembler({ format: 'sse' });
  assembler.write(Buffer.from(`event: future\ndata: ${'x'.repeat(RESPONSE_CONTENT_MAX_SSE_LINE_BYTES + 1)}\n\n`));
  const result = assembler.end();
  assert.equal(result.text, '');
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'incomplete');
});

test('marks a stream incomplete on EOF before message_stop and abort is idempotent', () => {
  const assembler = createResponseContentAssembler({ format: 'sse' });
  assembler.write(Buffer.from(sseEvent('message_start', {
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  })));
  assembler.write(Buffer.from(sseEvent('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })));
  assembler.write(Buffer.from(sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'partial' },
  })));
  const aborted = assembler.abort('upstream_error');
  assert.equal(aborted.status, 'incomplete');
  assert.equal(aborted.reason, 'upstream_error');
  assert.equal(aborted.text, 'partial');
  assert.deepEqual(assembler.abort('another_reason'), aborted);
  assert.deepEqual(assembler.end(), aborted);

  const eof = createResponseContentAssembler({ format: 'sse' });
  eof.write(Buffer.from(sseEvent('message_start', {
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  })));
  eof.write(Buffer.from(sseEvent('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })));
  eof.write(Buffer.from(sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'partial' },
  })));
  const eofResult = eof.end();
  assert.equal(eofResult.status, 'incomplete');
  assert.equal(eofResult.complete, false);
});

test('normal terminal event completes once and later chunks cannot append text', () => {
  const assembler = createResponseContentAssembler({ format: 'sse' });
  const writeResult = assembler.write(Buffer.from([
    sseEvent('message_start', { type: 'message_start', message: { role: 'assistant', content: [] } }, '\n'),
    sseEvent('message_stop', { type: 'message_stop' }, '\n'),
  ].join('')));
  assert.equal(writeResult, false);
  const terminal = assembler.snapshot();
  assert.equal(terminal.status, 'complete');
  assembler.write(Buffer.from(sseEvent('content_block_delta', {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'late' },
  })));
  assert.deepEqual(assembler.end(), terminal);
});

test('malformed and unknown events remain non-throwing and do not become body text', () => {
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n',
    ': keep-alive\n\n',
    'event: unknown\ndata: [not-json]\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"x"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const result = feedChunks([Buffer.from(body)], { format: 'sse' });
  assert.equal(result.text, '');
  assert.equal(result.status, 'complete');
  assert.equal(result.truncated, false);
});

test('message_stop without a valid message_start is incomplete', () => {
  for (const body of [
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    'event: message_stop\ndata: {}\n\n',
  ]) {
    const result = feedChunks([Buffer.from(body)], { format: 'sse' });
    assert.equal(result.text, '');
    assert.equal(result.complete, false);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'protocol_invalid');
  }
});

test('requires assistant role and tracks block index/type lifecycle without capturing tools', () => {
  const wrongRole = feedChunks([Buffer.from([
    sseEvent('message_start', { type: 'message_start', message: { role: 'user', content: [] } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join(''))], { format: 'sse' });
  assert.equal(wrongRole.status, 'incomplete');
  assert.equal(wrongRole.reason, 'protocol_invalid');

  const tool = feedChunks([Buffer.from([
    sseEvent('message_start', { type: 'message_start', message: { role: 'assistant', content: [] } }),
    sseEvent('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'tool_use' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tool secret' },
    }),
  ].join(''))], { format: 'sse' });
  assert.equal(tool.text, '');
  assert.equal(tool.status, 'incomplete');
  assert.equal(tool.reason, 'protocol_invalid');

  const late = feedChunks([Buffer.from([
    sseEvent('message_start', { type: 'message_start', message: { role: 'assistant', content: [] } }),
    sseEvent('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before stop' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'after stop' },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join(''))], { format: 'sse' });
  assert.equal(late.text, 'before stop');
  assert.equal(late.text.includes('after stop'), false);
  assert.equal(late.status, 'incomplete');
  assert.equal(late.reason, 'protocol_invalid');
});

test('caps content block and SSE data-part cardinality', () => {
  const start = sseEvent('message_start', {
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  });
  const starts = Array.from({ length: RESPONSE_CONTENT_MAX_BLOCKS + 1 }, (_, index) => sseEvent(
    'content_block_start',
    { type: 'content_block_start', index, content_block: { type: 'tool_use' } },
  )).join('');
  const blocks = feedChunks([Buffer.from(start + starts)], { format: 'sse' });
  assert.equal(blocks.truncated, true);
  assert.equal(blocks.status, 'incomplete');

  const dataParts = [
    'event: future\n',
    ...Array.from({ length: RESPONSE_CONTENT_MAX_SSE_DATA_PARTS + 1 }, () => 'data:\n'),
    '\n',
  ].join('');
  const parts = feedChunks([Buffer.from(dataParts)], { format: 'sse' });
  assert.equal(parts.truncated, true);
  assert.equal(parts.status, 'incomplete');
});

test('caps non-streaming JSON content block cardinality before traversal', () => {
  const body = JSON.stringify({
    role: 'assistant',
    content: Array.from({ length: RESPONSE_CONTENT_MAX_BLOCKS + 1 }, () => ({
      type: 'tool_use',
      input: { secret: 'must not be visited' },
    })),
  });
  const result = assembleResponseContent([Buffer.from(body)], { format: 'json' });
  assert.equal(result.text, '');
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'incomplete');
});

test('one-byte SSE chunks without a newline remain bounded and near-linear', {
  timeout: 10_000,
}, () => {
  const body = Buffer.from('x'.repeat(512 * 1024));
  const result = feedChunks(splitBytes(body, [1]), { format: 'sse' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.text, '');
});

test('one-byte JSON chunks use the incremental byte counter', {
  timeout: 10_000,
}, () => {
  const body = Buffer.from(JSON.stringify({
    role: 'assistant',
    content: [],
    padding: 'x'.repeat(256 * 1024),
  }));
  const result = feedChunks(splitBytes(body, [1]), { format: 'json' });
  assert.equal(result.status, 'complete');
  assert.equal(result.text, '');
});

test('non-assistant JSON and malformed UTF-8 fail closed without replacement text', () => {
  const wrongRole = feedChunks([Buffer.from(JSON.stringify({
    role: 'user',
    content: [{ type: 'text', text: 'DO_NOT_STORE' }],
  }))], { format: 'json' });
  assert.equal(wrongRole.text, '');
  assert.equal(wrongRole.status, 'incomplete');

  const invalid = createResponseContentAssembler({ format: 'json' });
  invalid.write(Buffer.concat([
    Buffer.from('{"role":"assistant","content":[{"type":"text","text":"'),
    Buffer.from([0xff]),
    Buffer.from('"}]}'),
  ]));
  assert.equal(invalid.abort('observer_stopped').reason, 'invalid_utf8');
  const result = invalid.end();
  assert.equal(result.text, '');
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'invalid_utf8');

  const surrogate = feedChunks([Buffer.from(JSON.stringify({
    role: 'assistant',
    content: [{ type: 'text', text: '\ud800' }],
  }))], { format: 'json' });
  assert.equal(surrogate.text, '');
  assert.equal(surrogate.status, 'incomplete');
  assert.equal(surrogate.reason, 'invalid_text');
});
