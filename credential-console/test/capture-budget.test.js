import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  CAPTURE_BUDGET_DEFAULT_BYTES,
  CAPTURE_MEMORY_AMPLIFICATION,
  createCaptureBudget,
} from '../lib/capture-budget.js';
import {
  REQUEST_METADATA_PREFIX_MAX_BYTES,
  createRequestMetadataTee,
} from '../lib/request-metadata.js';

function bodyWithTrailingPrompt(padBytes, text) {
  return Buffer.from(`{"system":[{"type":"text","text":"${'x'.repeat(padBytes)}"}],`
    + `"messages":[{"role":"user","content":[{"type":"text","text":"${text}"}]}],`
    + '"model":"claude-test","stream":true}');
}

async function drain(tee, body) {
  const seen = [];
  tee.stream.on('data', (chunk) => seen.push(Buffer.from(chunk)));
  tee.stream.end(body);
  await once(tee.stream, 'end');
  return Buffer.concat(seen);
}

test('exports a positive default ceiling', () => {
  assert.ok(CAPTURE_BUDGET_DEFAULT_BYTES > 0);
  assert.equal(createCaptureBudget().maxBytes(), CAPTURE_BUDGET_DEFAULT_BYTES);
});

test('reserves against estimated peak memory, not raw buffered bytes', () => {
  assert.ok(CAPTURE_MEMORY_AMPLIFICATION > 1, 'buffering costs more than it holds');
  const budget = createCaptureBudget({ maxBytes: 100, amplification: 4 });
  assert.equal(budget.tryReserve(25), true);
  assert.equal(budget.inFlightBytes(), 100, '25 buffered bytes cost 100');
  assert.equal(budget.tryReserve(1), false, 'the ceiling counts amplified cost');
  budget.release(25);
  assert.equal(budget.inFlightBytes(), 0);
});

test('reserves up to the ceiling and refuses past it', () => {
  const budget = createCaptureBudget({ maxBytes: 100, amplification: 1 });
  assert.equal(budget.tryReserve(60), true);
  assert.equal(budget.tryReserve(40), true);
  assert.equal(budget.tryReserve(1), false, 'exceeding the ceiling is refused');
  budget.release(40);
  assert.equal(budget.tryReserve(40), true, 'released bytes become available again');
  assert.equal(budget.inFlightBytes(), 100);
});

test('release never drives the pool negative', () => {
  const budget = createCaptureBudget({ maxBytes: 100, amplification: 1 });
  budget.tryReserve(10);
  budget.release(999);
  assert.equal(budget.inFlightBytes(), 0);
  assert.equal(budget.tryReserve(100), true);
});

test('a request that exhausts the budget still proxies and still reports metadata', async () => {
  const budget = createCaptureBudget({ maxBytes: 1024 });
  const body = bodyWithTrailingPrompt(8 * 1024, 'squeezed out');
  const tee = createRequestMetadataTee({
    capturePrompt: true,
    prefixLimit: REQUEST_METADATA_PREFIX_MAX_BYTES,
    budget,
  });

  const output = await drain(tee, body);

  assert.deepEqual(output, body, 'body is forwarded byte-for-byte regardless');
  assert.equal(tee.conversationCandidate(), null, 'prompt capture is dropped');
  assert.equal(tee.snapshot().stream, true, 'scanning continues without buffering');
  assert.equal(tee.snapshot().model, 'claude-test');
  assert.equal(budget.inFlightBytes(), 0, 'the abandoned reservation is returned');
});

test('a request within budget still captures, and returns its reservation', async () => {
  const budget = createCaptureBudget({ maxBytes: 8 * 1024 * 1024 });
  const body = bodyWithTrailingPrompt(200 * 1024, 'kept intact');
  const tee = createRequestMetadataTee({
    capturePrompt: true,
    prefixLimit: REQUEST_METADATA_PREFIX_MAX_BYTES,
    budget,
  });

  await drain(tee, body);

  assert.match(tee.conversationCandidate().promptText, /kept intact/);
  assert.equal(budget.inFlightBytes(), 0, 'the pool is fully returned after flush');
});

test('an aborted body returns its reservation instead of leaking the pool', async () => {
  const budget = createCaptureBudget({ maxBytes: 8 * 1024 * 1024 });
  const tee = createRequestMetadataTee({
    capturePrompt: true,
    prefixLimit: REQUEST_METADATA_PREFIX_MAX_BYTES,
    budget,
  });

  tee.stream.on('data', () => {});
  tee.stream.on('error', () => {});
  tee.stream.write(bodyWithTrailingPrompt(64 * 1024, 'never finished').subarray(0, 4096));
  assert.ok(budget.inFlightBytes() > 0, 'bytes are held while the body is in flight');

  // Client hung up mid-upload: flush() never runs.
  tee.stream.destroy();
  await once(tee.stream, 'close');

  assert.equal(budget.inFlightBytes(), 0, 'destroy releases what flush would have');
});

test('concurrent captures share one ceiling', async () => {
  const body = bodyWithTrailingPrompt(200 * 1024, 'contended');
  // Room for exactly one of these bodies once amplification is accounted for.
  const budget = createCaptureBudget({
    maxBytes: Math.ceil(body.length * CAPTURE_MEMORY_AMPLIFICATION * 1.5),
  });
  const make = () => createRequestMetadataTee({
    capturePrompt: true,
    prefixLimit: REQUEST_METADATA_PREFIX_MAX_BYTES,
    budget,
  });

  const first = make();
  const second = make();

  // Interleave: the first claims most of the pool before the second starts.
  first.stream.on('data', () => {});
  second.stream.on('data', () => {});
  first.stream.write(body);
  second.stream.write(body);
  first.stream.end();
  second.stream.end();
  await Promise.all([once(first.stream, 'end'), once(second.stream, 'end')]);

  const captured = [first, second].filter((t) => t.conversationCandidate() !== null);
  assert.equal(captured.length, 1, 'the pool admits one and sheds the other');
  assert.equal(budget.inFlightBytes(), 0, 'both reservations are returned');
});
