import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexUsageParser, normalizeCodexUsage, parseCodexUsage } from '../lib/codex-usage.js';

function sse(...events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const COMPLETED = {
  type: 'response.completed',
  response: { id: 'r1', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 42 } },
};

test('the cached prefix is counted once, not twice', () => {
  const usage = parseCodexUsage(sse(COMPLETED));
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.cacheReadInputTokens, 900);
  assert.equal(usage.outputTokens, 42);
  assert.equal(
    usage.inputTokens + usage.cacheReadInputTokens,
    1000,
    'the two columns still add up to the prompt the vendor billed',
  );
  assert.equal(usage.usageState, 'complete');
});

test('both spellings of the cached-token field are understood', () => {
  const nested = parseCodexUsage(sse({
    type: 'response.completed',
    response: { usage: { input_tokens: 80, input_tokens_details: { cached_tokens: 30 }, output_tokens: 5 } },
  }));
  assert.equal(nested.inputTokens, 50);
  assert.equal(nested.cacheReadInputTokens, 30);

  const flat = parseCodexUsage(sse({
    type: 'response.completed',
    response: { usage: { input_tokens: 80, cached_input_tokens: 30, output_tokens: 5 } },
  }));
  assert.deepEqual(
    [flat.inputTokens, flat.cacheReadInputTokens],
    [nested.inputTokens, nested.cacheReadInputTokens],
  );
});

test('cache writes are recorded, and absent ones stay null rather than zero', () => {
  // Observed live on chatgpt.com/backend-api/codex/responses: the breakdown is
  // nested and carries cache_write_tokens alongside cached_tokens.
  const usage = normalizeCodexUsage({
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 700, cache_write_tokens: 200 },
    output_tokens: 9,
  });
  assert.equal(usage.cacheCreationInputTokens, 200);
  assert.equal(usage.cacheReadInputTokens, 700);
  assert.equal(usage.inputTokens, 100);
  assert.equal(
    usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    1000,
    'the three columns partition the prompt, counting it exactly once',
  );

  // A response that reports no breakdown at all must not claim zero writes.
  assert.equal(normalizeCodexUsage({ input_tokens: 1, output_tokens: 1 }).cacheCreationInputTokens, null);
});

test('the exact usage shape returned by the live endpoint is understood', () => {
  // Copied verbatim from a real turn, so a change in the upstream shape shows up
  // here rather than as silently missing columns on the metrics page.
  const usage = parseCodexUsage(sse({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 13521,
        input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 13526,
      },
    },
  }));
  assert.equal(usage.inputTokens, 13521);
  assert.equal(usage.cacheReadInputTokens, 0);
  assert.equal(usage.cacheCreationInputTokens, 0);
  assert.equal(usage.outputTokens, 5, 'reasoning tokens are already inside output_tokens');
  assert.equal(usage.usageState, 'complete');
});

test('a turn that ran out of room still reports what it burned', () => {
  for (const type of ['response.incomplete', 'response.failed']) {
    const usage = parseCodexUsage(sse({
      type,
      response: { usage: { input_tokens: 10, output_tokens: 4 } },
    }));
    assert.equal(usage.usageState, 'complete', type);
    assert.equal(usage.outputTokens, 4, type);
  }
});

test('usage seen before any terminal event is partial, not complete', () => {
  const usage = parseCodexUsage(sse({
    type: 'response.in_progress',
    response: { usage: { input_tokens: 5, output_tokens: 1 } },
  }));
  assert.equal(usage.parseState, 'partial');
  assert.equal(usage.usageState, 'partial');
  assert.equal(usage.inputTokens, 5, 'the numbers are still kept');
});

test('a stream that dies mid-turn keeps the usage it already saw', () => {
  const parser = new CodexUsageParser({ format: 'sse' });
  parser.push(sse({ type: 'response.in_progress', response: { usage: { input_tokens: 7, output_tokens: 2 } } }));
  const usage = parser.finish({ truncated: true });
  assert.equal(usage.parseState, 'truncated');
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.usageState, 'partial');
});

test('a later terminal event supersedes an earlier partial figure', () => {
  const usage = parseCodexUsage(sse(
    { type: 'response.in_progress', response: { usage: { input_tokens: 10, output_tokens: 1 } } },
    COMPLETED,
  ));
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 42);
});

test('one unparseable event does not discard the rest of the turn', () => {
  const stream = 'data: {not json\n\n' + sse(COMPLETED);
  const usage = parseCodexUsage(stream);
  assert.equal(usage.outputTokens, 42, 'the terminal event was still read');
  assert.equal(usage.usageState, 'complete');
});

test('a response with no usage at all reports unavailable rather than zero', () => {
  const usage = parseCodexUsage(sse({ type: 'response.completed', response: { id: 'r1' } }));
  assert.equal(usage.usageState, 'unavailable');
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null, 'a missing count is not a zero count');
});

test('a non-streaming JSON body is accounted for too', () => {
  const usage = parseCodexUsage(JSON.stringify({
    id: 'resp_1',
    usage: { input_tokens: 60, cached_input_tokens: 20, output_tokens: 9 },
  }));
  assert.equal(usage.inputTokens, 40);
  assert.equal(usage.cacheReadInputTokens, 20);
  assert.equal(usage.outputTokens, 9);
  assert.equal(usage.usageState, 'complete');
});

test('malformed counts cannot produce a value the metrics schema rejects', () => {
  // The token columns carry `CHECK (... >= 0)`; a negative would abort the write.
  const impossible = parseCodexUsage(sse({
    type: 'response.completed',
    response: { usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 } },
  }));
  assert.equal(impossible.inputTokens, 0, 'clamped, not negative');

  for (const bad of [{ input_tokens: -3 }, { input_tokens: 1.5 }, { input_tokens: '10' }]) {
    const usage = normalizeCodexUsage({ ...bad, output_tokens: 2 });
    assert.equal(usage.inputTokens, null, JSON.stringify(bad));
    assert.equal(usage.outputTokens, 2);
  }
  assert.equal(normalizeCodexUsage(null), null);
  assert.equal(normalizeCodexUsage({ id: 'no usage here' }), null);
});

test('a long turn still reports its usage, because usage arrives last', () => {
  // The expensive turns are the long ones. With the Anthropic parser's 1 MiB /
  // 8192-event budget this stream exceeded both and reported nothing at all —
  // a one-sided undercount of exactly the traffic worth metering. 25k deltas is
  // about what a 21,756-output-token turn produces, the largest seen in a
  // 143k-turn corpus.
  const parser = new CodexUsageParser({ format: 'sse' });
  const delta = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(40) })}\n\n`;
  for (let i = 0; i < 25_000; i += 1) parser.push(delta);
  parser.push(sse(COMPLETED));
  const usage = parser.finish();

  assert.ok(usage.bytesSeen > 1024 * 1024, `stream exceeded the old cap (${usage.bytesSeen} bytes)`);
  assert.ok(usage.eventsSeen > 8192, `stream exceeded the old event cap (${usage.eventsSeen} events)`);
  assert.equal(usage.parseState, 'complete', 'the terminal event was still reached');
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 42);
  assert.equal(usage.usageState, 'complete');
});

test('a terminal event missing its blank line is still counted', () => {
  // Upstream closing right after the last `data:` line would otherwise discard
  // the only event that carries usage.
  const usage = parseCodexUsage(`data: ${JSON.stringify(COMPLETED)}\n`);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 42);
});

test('a later partial figure does not erase an earlier known one', () => {
  const usage = parseCodexUsage(sse(
    COMPLETED,
    { type: 'response.completed', response: { usage: { output_tokens: 7 } } },
  ));
  assert.equal(usage.outputTokens, 7, 'the newer figure wins where present');
  assert.equal(usage.inputTokens, 100, 'the older input count survives');
  assert.equal(usage.cacheReadInputTokens, 900);
});

test("usage whose own totals do not add up is never reported as complete", () => {
  // The normalisation assumes input_tokens is the whole prompt. If the vendor
  // changed that, total_tokens would stop closing — better a partial row than a
  // silent undercount of every turn.
  const usage = parseCodexUsage(sse({
    type: 'response.completed',
    response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 999 } },
  }));
  assert.equal(usage.usageState, 'partial');

  const consistent = parseCodexUsage(sse({
    type: 'response.completed',
    response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } },
  }));
  assert.equal(consistent.usageState, 'complete');
});

test('one oversized event is skipped without costing the turn its usage', () => {
  const parser = new CodexUsageParser({ format: 'sse', maxEventBytes: 4096 });
  parser.push(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'y'.repeat(20_000) })}\n\n`);
  parser.push(sse(COMPLETED));
  const usage = parser.finish();
  assert.equal(usage.parseState, 'complete', 'the stream survived the oversized event');
  assert.equal(usage.outputTokens, 42);
});

test('the event budget bounds what a hostile stream can cost', () => {
  const parser = new CodexUsageParser({ format: 'sse', maxEvents: 3 });
  parser.push(sse(
    { type: 'response.output_text.delta', delta: 'a' },
    { type: 'response.output_text.delta', delta: 'b' },
    { type: 'response.output_text.delta', delta: 'c' },
    { type: 'response.output_text.delta', delta: 'd' },
  ));
  assert.equal(parser.finish().parseState, 'limit');

  const byBytes = new CodexUsageParser({ format: 'sse', maxBytes: 32 });
  byBytes.push(sse(COMPLETED));
  assert.equal(byBytes.finish().parseState, 'truncated');
});

test('events split across chunk boundaries are reassembled', () => {
  const stream = sse(COMPLETED);
  const parser = new CodexUsageParser({ format: 'sse' });
  for (const byte of Buffer.from(stream, 'utf8')) parser.push(Buffer.from([byte]));
  const usage = parser.finish();
  assert.equal(usage.inputTokens, 100, 'byte-at-a-time delivery parses identically');
  assert.equal(usage.outputTokens, 42);
  assert.equal(usage.usageState, 'complete');
});

test('multi-byte characters split across chunks do not corrupt the parse', () => {
  const bytes = Buffer.from(sse({
    type: 'response.completed',
    response: { id: '中文标识', usage: { input_tokens: 12, output_tokens: 3 } },
  }), 'utf8');
  const parser = new CodexUsageParser({ format: 'sse' });
  for (let i = 0; i < bytes.length; i += 3) parser.push(bytes.subarray(i, i + 3));
  const usage = parser.finish();
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 3);
});

test('the format is detected without being told', () => {
  assert.equal(parseCodexUsage(sse(COMPLETED)).outputTokens, 42);
  assert.equal(parseCodexUsage('{"usage":{"input_tokens":3,"output_tokens":1}}').outputTokens, 1);
  assert.equal(parseCodexUsage('   \n{"usage":{"output_tokens":1}}').outputTokens, 1, 'leading whitespace');
});

test('a [DONE] sentinel is not mistaken for an event payload', () => {
  const usage = parseCodexUsage(sse(COMPLETED) + 'data: [DONE]\n\n');
  assert.equal(usage.outputTokens, 42);
  assert.equal(usage.usageState, 'complete');
});

test('comments and CRLF framing are handled', () => {
  const stream = ': keep-alive\r\n\r\n'
    + `data: ${JSON.stringify(COMPLETED)}\r\n\r\n`;
  const usage = parseCodexUsage(stream);
  assert.equal(usage.outputTokens, 42);
});
