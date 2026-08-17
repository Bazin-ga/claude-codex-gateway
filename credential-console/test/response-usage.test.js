import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESPONSE_USAGE_MAX_BYTES,
  RESPONSE_USAGE_MAX_EVENTS,
  RESPONSE_USAGE_MAX_EVENT_BYTES,
  createResponseUsageParser,
  parseResponseUsage,
} from '../lib/response-usage.js';

const COMPLETE_USAGE = {
  input_tokens: 11,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: 4,
  output_tokens: 0,
};

function splitBytes(buffer, sizes) {
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

function parseChunks(chunks, options = {}) {
  const parser = createResponseUsageParser(options);
  for (const chunk of chunks) parser.push(chunk);
  return parser.finish();
}

function sseEvent(type, payload, lineEnding = '\n') {
  return `event: ${type}${lineEnding}data: ${JSON.stringify(payload)}${lineEnding}${lineEnding}`;
}

function streamFixture({ input = 11, output = 0, cacheRead = null } = {}) {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        type: 'message',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: input,
          cache_read_input_tokens: cacheRead,
          output_tokens: output,
        },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

test('parses non-streaming JSON across every UTF-8 byte boundary', () => {
  const body = Buffer.from(JSON.stringify({
    id: 'msg-boundary',
    content: [{ type: 'text', text: '雪' }],
    usage: COMPLETE_USAGE,
  }));
  const result = parseChunks(splitBytes(body, [1]), { format: 'json' });

  assert.deepEqual(result, {
    inputTokens: 11,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: 4,
    outputTokens: 0,
    usageState: 'complete',
    completeness: 'complete',
    parseState: 'complete',
    bytesSeen: body.length,
    eventsSeen: 0,
  });
});

test('parses official streaming events with CRLF, multi-data lines, and chunk boundaries', () => {
  const lineEnding = '\r\n';
  const start = JSON.stringify({
    type: 'message_start',
    message: {
      type: 'message',
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 3,
        output_tokens: 0,
      },
    },
  });
  const split = start.indexOf(',"usage"') + 1;
  const body = [
    `event: message_start${lineEnding}`,
    `data: ${start.slice(0, split)}${lineEnding}`,
    `data: ${start.slice(split)}${lineEnding}${lineEnding}`,
    `event: ping${lineEnding}data: {"type":"ping"}${lineEnding}${lineEnding}`,
    `event: message_delta${lineEnding}data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    })}${lineEnding}${lineEnding}`,
    `event: message_delta${lineEnding}data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 9 },
    })}${lineEnding}${lineEnding}`,
    `event: message_stop${lineEnding}data: {"type":"message_stop"}${lineEnding}${lineEnding}`,
  ].join('');

  const result = parseChunks(splitBytes(Buffer.from(body), [1, 2, 3, 5, 8]), { format: 'sse' });
  assert.equal(result.inputTokens, 12);
  assert.equal(result.cacheCreationInputTokens, null);
  assert.equal(result.cacheReadInputTokens, 3);
  assert.equal(result.outputTokens, 9);
  assert.equal(result.usageState, 'complete');
  assert.equal(result.completeness, 'complete');
  assert.equal(result.parseState, 'complete');
  assert.equal(result.eventsSeen, 5);
});

test('uses later cumulative usage snapshots instead of adding duplicate or delta values', () => {
  const body = [
    sseEvent('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 1 } },
    }),
    sseEvent('message_delta', {
      type: 'message_delta',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        output_tokens: 4,
      },
    }),
    sseEvent('message_delta', {
      type: 'message_delta',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        output_tokens: 8,
      },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
  const result = parseResponseUsage(Buffer.from(body), { format: 'sse' });

  assert.equal(result.inputTokens, 10);
  assert.equal(result.cacheCreationInputTokens, 2);
  assert.equal(result.outputTokens, 8);
  assert.equal(result.usageState, 'complete');
});

test('nullable cumulative delta input/cache fields retain earlier known values', () => {
  const body = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 1,
        },
      },
    }),
    sseEvent('message_delta', {
      type: 'message_delta',
      usage: {
        input_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens: 8,
      },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
  const result = parseResponseUsage(Buffer.from(body), { format: 'sse' });
  assert.equal(result.inputTokens, 10);
  assert.equal(result.cacheCreationInputTokens, 2);
  assert.equal(result.cacheReadInputTokens, 3);
  assert.equal(result.outputTokens, 8);
  assert.equal(result.usageState, 'complete');
});

test('ignores unknown events, including unknown malformed JSON, without poisoning usage', () => {
  const body = [
    'event: future_event\ndata: {not-json}\n\n',
    sseEvent('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 4, output_tokens: 0 } },
    }),
    'event: future_event\ndata: [not-json]\n\n',
    sseEvent('message_delta', { type: 'message_delta', usage: { output_tokens: 2 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
  const result = parseResponseUsage(Buffer.from(body), { format: 'sse' });

  assert.equal(result.inputTokens, 4);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.usageState, 'complete');
  assert.equal(result.parseState, 'complete');
  assert.equal(result.eventsSeen, 5);
});

test('accepts a data-only SSE event when its JSON type is known', () => {
  const body = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ].join('');
  const result = parseResponseUsage(Buffer.from(body), { format: 'sse' });
  assert.equal(result.usageState, 'complete');
  assert.equal(result.inputTokens, 2);
  assert.equal(result.outputTokens, 0);
});

test('keeps partial usage nullable when a stream has no terminal event', () => {
  const body = [
    sseEvent('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 12, output_tokens: 0 } },
    }),
    sseEvent('message_delta', { type: 'message_delta', usage: { output_tokens: 3 } }),
  ].join('');
  const result = parseResponseUsage(Buffer.from(body), { format: 'sse' });

  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.usageState, 'partial');
  assert.equal(result.completeness, 'partial');
  assert.equal(result.parseState, 'partial');
});

test('reports unavailable when a valid response has no token usage object', () => {
  const json = parseResponseUsage(Buffer.from(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } })), {
    format: 'json',
  });
  const sse = parseResponseUsage(Buffer.from([
    sseEvent('message_start', { type: 'message_start', message: { content: [] } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')), { format: 'sse' });

  assert.equal(json.usageState, 'unavailable');
  assert.equal(json.completeness, 'incomplete');
  assert.equal(json.parseState, 'partial');
  assert.equal(sse.usageState, 'unavailable');
  assert.equal(sse.parseState, 'partial');
});

test('requires non-null input and output for complete usage while cache null remains valid', () => {
  const missingOutput = parseResponseUsage(Buffer.from(JSON.stringify({
    usage: { input_tokens: 5, cache_creation_input_tokens: null },
  })), { format: 'json' });
  const complete = parseResponseUsage(Buffer.from(JSON.stringify({
    usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: null },
  })), { format: 'json' });

  assert.equal(missingOutput.usageState, 'partial');
  assert.equal(missingOutput.parseState, 'partial');
  assert.equal(complete.usageState, 'complete');
  assert.equal(complete.cacheCreationInputTokens, null);
});

test('malformed JSON and invalid field types become non-throwing invalid states', () => {
  const malformed = createResponseUsageParser({ format: 'json' });
  assert.doesNotThrow(() => malformed.push(Buffer.from('{"usage":{"input_tokens":7}')));
  const malformedResult = malformed.finish();
  assert.equal(malformedResult.parseState, 'invalid');
  assert.equal(malformedResult.usageState, 'unavailable');

  const wrongType = parseResponseUsage(Buffer.from(JSON.stringify({
    usage: { input_tokens: '7', output_tokens: 1 },
  })), { format: 'json' });
  assert.equal(wrongType.parseState, 'invalid');
  assert.equal(wrongType.usageState, 'unavailable');
});

test('rejects malformed UTF-8, including an incomplete multibyte sequence at EOF', () => {
  const invalidBody = Buffer.concat([
    Buffer.from('{"usage":{"input_tokens":1,"output_tokens":0,"note":"'),
    Buffer.from([0xff]),
    Buffer.from('"}}'),
  ]);
  const invalid = parseChunks([invalidBody], { format: 'json' });
  const split = createResponseUsageParser({ format: 'json' });
  split.push(Buffer.from('{"usage":{"input_tokens":1,"output_tokens":0,"note":"'));
  split.push(Buffer.from([0xe9, 0x9b]));
  split.push(Buffer.from('"}}'));
  const splitResult = split.finish();

  assert.equal(invalid.parseState, 'invalid');
  assert.equal(invalid.usageState, 'unavailable');
  assert.equal(splitResult.parseState, 'invalid');
});

test('marks an unfinished SSE event partial rather than dispatching parseable EOF data', () => {
  const body = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}';
  const result = parseResponseUsage(Buffer.from(body), { format: 'sse' });
  assert.equal(result.parseState, 'partial');
  assert.equal(result.usageState, 'unavailable');
  assert.equal(result.inputTokens, null);
});

test('marks a byte-truncated response incomplete while retaining bounded partial usage', () => {
  const body = Buffer.from(streamFixture({ input: 9, output: 0 }));
  const parser = createResponseUsageParser({ format: 'sse', maxBytes: body.indexOf(Buffer.from('message_stop')) + 4 });
  parser.push(body);
  const result = parser.finish();

  assert.equal(result.parseState, 'truncated');
  assert.equal(result.completeness, 'incomplete');
  assert.equal(result.usageState, 'partial');
  assert.equal(result.inputTokens, 9);
  assert.equal(result.bytesSeen, parser.maxBytes);
});

test('explicit upstream truncation never claims complete usage', () => {
  const parser = createResponseUsageParser({ format: 'sse' });
  parser.push(Buffer.from(streamFixture({ input: 6, output: 0 })));
  const result = parser.finish({ truncated: true });
  assert.equal(result.parseState, 'truncated');
  assert.equal(result.usageState, 'partial');
  assert.notEqual(result.completeness, 'complete');
});

test('enforces event and per-event bounds and keeps limits finite', () => {
  assert.ok(Number.isSafeInteger(RESPONSE_USAGE_MAX_BYTES) && RESPONSE_USAGE_MAX_BYTES > 0);
  assert.ok(Number.isSafeInteger(RESPONSE_USAGE_MAX_EVENTS) && RESPONSE_USAGE_MAX_EVENTS > 0);
  assert.ok(Number.isSafeInteger(RESPONSE_USAGE_MAX_EVENT_BYTES) && RESPONSE_USAGE_MAX_EVENT_BYTES > 0);

  const eventLimited = createResponseUsageParser({ format: 'sse', maxEvents: 1 });
  eventLimited.push(Buffer.from([
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
  ].join('')));
  assert.equal(eventLimited.finish().parseState, 'limit');

  const lineLimited = createResponseUsageParser({ format: 'sse', maxEventBytes: 32 });
  lineLimited.push(Buffer.from(`event: future\ndata: ${'x'.repeat(128)}`));
  assert.equal(lineLimited.finish().parseState, 'limit');

  const byteLimited = createResponseUsageParser({ format: 'json', maxBytes: 8 });
  byteLimited.push(Buffer.from('{"usage":{"input_tokens":1}}'));
  assert.equal(byteLimited.finish().parseState, 'truncated');
  assert.equal(byteLimited.bytesSeen, 8);
});

test('large network chunks containing many small SSE events do not hit event-data limits', () => {
  const body = Array.from({ length: 100 }, () => 'event: ping\ndata: {"type":"ping"}\n\n').join('');
  const result = parseResponseUsage(Buffer.from(body), {
    format: 'sse',
    maxEvents: 100,
    maxEventBytes: 64,
  });
  assert.equal(result.parseState, 'partial');
  assert.equal(result.eventsSeen, 100);
});

test('auto mode selects SSE or JSON without retaining more than the configured bound', () => {
  const sse = parseResponseUsage(Buffer.from(streamFixture({ input: 3, output: 0 })), { format: 'auto' });
  const jsonBody = Buffer.from(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 1 } }));
  const json = parseChunks(splitBytes(jsonBody, [2, 1]), { format: 'auto' });
  assert.equal(sse.usageState, 'complete');
  assert.equal(json.usageState, 'complete');
});
