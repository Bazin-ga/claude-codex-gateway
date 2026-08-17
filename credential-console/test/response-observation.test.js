import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import {
  createResponseObservationTee,
  MAX_GLOBAL_OBSERVATION_BUDGET_BYTES,
  MAX_OBSERVED_DECODED_BYTES,
  MAX_OBSERVED_RAW_BYTES,
} from '../lib/response-observation.js';

function observer() {
  const chunks = [];
  return {
    chunks,
    ended: 0,
    aborted: [],
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end() { this.ended += 1; },
    abort(reason) { this.aborted.push(reason); },
    snapshot() {
      return {
        body: Buffer.concat(chunks),
        ended: this.ended,
        aborted: [...this.aborted],
      };
    },
  };
}

async function through(chunks, options = {}) {
  const observed = options.observer ?? observer();
  const tee = createResponseObservationTee({ ...options, observer: observed });
  const received = [];
  await pipeline(
    Readable.from(chunks),
    tee.stream,
    new Writable({
      write(chunk, _encoding, callback) {
        received.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  await tee.done;
  return { tee, observed, received: Buffer.concat(received) };
}

test('identity observation forwards exact chunks and ends independently', async () => {
  const chunks = [Buffer.from('first\0'), Buffer.from([0xff, 0x00, 0x7f])];
  const result = await through(chunks);
  assert.deepEqual(result.received, Buffer.concat(chunks));
  assert.deepEqual(Buffer.concat(result.observed.chunks), Buffer.concat(chunks));
  assert.equal(result.tee.bytes(), Buffer.concat(chunks).length);
  assert.equal(result.observed.ended, 1);
  assert.deepEqual(result.observed.aborted, []);
});

test('gzip, brotli, and deflate decode only the bounded observation side', async () => {
  const plain = Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n'.repeat(50));
  for (const [contentEncoding, encoded] of [
    ['gzip', gzipSync(plain)],
    ['br', brotliCompressSync(plain)],
    ['deflate', deflateSync(plain)],
  ]) {
    const split = [encoded.subarray(0, 3), encoded.subarray(3, 11), encoded.subarray(11)];
    const result = await through(split, { contentEncoding });
    assert.deepEqual(result.received, encoded, `${contentEncoding} raw bytes changed`);
    assert.deepEqual(Buffer.concat(result.observed.chunks), plain, `${contentEncoding} did not decode`);
    assert.equal(result.observed.ended, 1);
    assert.deepEqual(result.observed.aborted, []);
  }
});

test('invalid and unsupported encodings never corrupt or abort raw delivery', async () => {
  const invalid = Buffer.from('not really gzip');
  const bad = await through([invalid], { contentEncoding: 'gzip' });
  assert.deepEqual(bad.received, invalid);
  assert.deepEqual(bad.observed.aborted, ['decode_error']);
  assert.equal(bad.observed.ended, 0);

  const opaque = Buffer.from('opaque future encoding');
  const unsupported = await through([opaque], { contentEncoding: 'zstd' });
  assert.deepEqual(unsupported.received, opaque);
  assert.deepEqual(unsupported.observed.aborted, ['unsupported_encoding']);
  assert.equal(unsupported.observed.chunks.length, 0);
});

test('raw and decoded observation ceilings disable only telemetry', async () => {
  const raw = Buffer.alloc(64, 0x61);
  const rawLimited = await through([raw.subarray(0, 16), raw.subarray(16)], {
    maxObservedRawBytes: 24,
  });
  assert.deepEqual(rawLimited.received, raw);
  assert.deepEqual(rawLimited.observed.aborted, ['raw_limit']);

  const decodedPlain = Buffer.alloc(4096, 0x62);
  const encoded = gzipSync(decodedPlain);
  const decodedLimited = await through([encoded], {
    contentEncoding: 'gzip',
    maxObservedDecodedBytes: 1024,
  });
  assert.deepEqual(decodedLimited.received, encoded);
  assert.deepEqual(decodedLimited.observed.aborted, ['decoded_limit']);
  assert.ok(Buffer.concat(decodedLimited.observed.chunks).length <= 1024);
});

test('an explicit client/upstream abort snapshots partial observation once', async () => {
  const observed = observer();
  const tee = createResponseObservationTee({ observer: observed });
  tee.stream.write(Buffer.from('partial'));
  tee.abort('client_aborted');
  tee.abort('upstream_error');
  tee.stream.end(Buffer.from('-still-forwarded'));
  const raw = [];
  tee.stream.on('data', (chunk) => raw.push(Buffer.from(chunk)));
  await once(tee.stream, 'end');
  await tee.done;
  assert.deepEqual(Buffer.concat(raw), Buffer.from('partial-still-forwarded'));
  assert.deepEqual(Buffer.concat(observed.chunks), Buffer.from('partial'));
  assert.deepEqual(observed.aborted, ['client_aborted']);
  assert.equal(observed.ended, 0);
});

test('an observer can stop itself while raw delivery continues', async () => {
  const chunks = [];
  const observed = {
    aborts: [],
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return false;
    },
    abort(reason) { this.aborts.push(reason); },
    snapshot() { return null; },
  };
  const result = await through([Buffer.from('first'), Buffer.from('second')], { observer: observed });
  assert.deepEqual(result.received, Buffer.from('firstsecond'));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from('first'));
  assert.deepEqual(observed.aborts, ['observer_stopped']);
});

test('telemetry is not a second backpressure authority', async () => {
  const observed = observer();
  const tee = createResponseObservationTee({ observer: observed });
  let writes = 0;
  const sink = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writes += 1;
      setTimeout(callback, 2);
    },
  });
  const source = Readable.from(Array.from({ length: 64 }, () => Buffer.alloc(2048, 0x63)));
  await pipeline(source, tee.stream, sink);
  await tee.done;
  assert.equal(writes, 64);
  assert.equal(tee.bytes(), 64 * 2048);
  assert.equal(Buffer.concat(observed.chunks).length, 64 * 2048);
});

test('observer finalization never delays client EOF', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const observed = observer();
  observed.end = () => gate;
  const tee = createResponseObservationTee({ observer: observed });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const delivered = pipeline(Readable.from([Buffer.from('done')]), tee.stream, sink);
  await Promise.race([
    delivered,
    new Promise((_, reject) => setTimeout(() => reject(new Error('client EOF waited on observer')), 100)),
  ]);
  let observationDone = false;
  tee.done.then(() => { observationDone = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observationDone, false);
  release();
  await tee.done;
  assert.equal(observationDone, true);
});

test('compressed observers share a global reservation budget and release it', async () => {
  const firstObserver = observer();
  const secondObserver = observer();
  const thirdObserver = observer();
  const first = createResponseObservationTee({ contentEncoding: 'gzip', observer: firstObserver });
  const second = createResponseObservationTee({ contentEncoding: 'gzip', observer: secondObserver });
  const third = createResponseObservationTee({ contentEncoding: 'gzip', observer: thirdObserver });
  assert.deepEqual(firstObserver.aborted, []);
  assert.deepEqual(secondObserver.aborted, []);
  assert.deepEqual(thirdObserver.aborted, ['global_budget']);
  first.abort('test_cleanup');
  await first.done;

  const replacementObserver = observer();
  const replacement = createResponseObservationTee({
    contentEncoding: 'gzip',
    observer: replacementObserver,
  });
  assert.deepEqual(replacementObserver.aborted, []);
  second.abort('test_cleanup');
  replacement.abort('test_cleanup');
  await Promise.all([second.done, third.done, replacement.done]);
});

test('callers cannot raise per-response observation ceilings above the hard cap', async () => {
  const observed = observer();
  const tee = createResponseObservationTee({
    observer: observed,
    maxObservedRawBytes: Number.MAX_SAFE_INTEGER,
    maxObservedDecodedBytes: Number.MAX_SAFE_INTEGER,
  });
  const chunk = Buffer.alloc(1024 * 1024, 0x64);
  const received = [];
  tee.stream.on('data', (value) => received.push(Buffer.from(value)));
  for (let index = 0; index < 17; index += 1) tee.stream.write(chunk);
  tee.stream.end();
  await once(tee.stream, 'end');
  await tee.done;
  assert.equal(Buffer.concat(received).length, 17 * 1024 * 1024);
  assert.deepEqual(observed.aborted, ['raw_limit']);
});

test('default ceilings remain explicit finite contracts', () => {
  assert.equal(MAX_OBSERVED_RAW_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_OBSERVED_DECODED_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_GLOBAL_OBSERVATION_BUDGET_BYTES, 32 * 1024 * 1024);
});
