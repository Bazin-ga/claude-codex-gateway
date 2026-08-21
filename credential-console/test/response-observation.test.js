import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import {
  createResponseObservationTee,
  createCompositeResponseObserver,
  MAX_GLOBAL_OBSERVATION_BUDGET_BYTES,
  MAX_OBSERVATION_CHARGE_BYTES,
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

test('composite observers isolate a stopped child and merge bounded snapshots', async () => {
  const firstChunks = [];
  const secondChunks = [];
  const first = {
    aborted: null,
    write(chunk) { firstChunks.push(Buffer.from(chunk)); return false; },
    abort(reason) { this.aborted = reason; },
    snapshot() { return { first: Buffer.concat(firstChunks).toString('utf8') }; },
  };
  const second = {
    ended: false,
    write(chunk) { secondChunks.push(Buffer.from(chunk)); },
    end() { this.ended = true; },
    snapshot() { return { second: Buffer.concat(secondChunks).toString('utf8') }; },
  };
  const composite = createCompositeResponseObserver([first, second]);
  const result = await through([Buffer.from('one'), Buffer.from('two')], { observer: composite });
  assert.deepEqual(result.received, Buffer.from('onetwo'));
  assert.equal(first.aborted, 'observer_stopped');
  assert.equal(second.ended, true);
  assert.deepEqual(result.tee.snapshot(), { first: 'one', second: 'onetwo' });
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

test('many concurrent observers coexist while their actual bytes stay small', async () => {
  // The pool is charged for observed bytes, not for a per-response ceiling, so
  // ordinary small responses no longer evict each other. Reserving the ceiling
  // up front capped this at two concurrent compressed responses.
  const observers = Array.from({ length: 16 }, () => observer());
  const tees = observers.map((o) => createResponseObservationTee({
    contentEncoding: 'gzip',
    observer: o,
  }));
  assert.equal(
    observers.every((o) => o.aborted.length === 0),
    true,
    'creating an observation reserves nothing by itself',
  );

  const payload = gzipSync(Buffer.from('hello'));
  await Promise.all(tees.map((tee) => pipeline(
    Readable.from([payload]),
    tee.stream,
    new Writable({ write(_c, _e, cb) { cb(); } }),
  )));
  await Promise.all(tees.map((tee) => tee.done));

  assert.equal(
    observers.every((o) => o.aborted.length === 0),
    true,
    'all sixteen keep their observation',
  );
});

test('the shared pool sheds with global_budget once concurrent holders fill it', async () => {
  // The pool is a *concurrency* bound, so one stream can never demonstrate it:
  // a single stream hits the 16 MiB raw ceiling before the 32 MiB pool. Hold
  // several open at once instead, each charged up to MAX_OBSERVATION_CHARGE_BYTES.
  const holders = Math.ceil(MAX_GLOBAL_OBSERVATION_BUDGET_BYTES / MAX_OBSERVATION_CHARGE_BYTES);
  const chunk = Buffer.alloc(MAX_OBSERVATION_CHARGE_BYTES, 0x61);

  const open = [];
  for (let i = 0; i < holders; i += 1) {
    const observed = observer();
    const tee = createResponseObservationTee({ observer: observed });
    tee.stream.on('data', () => {});
    tee.stream.write(chunk);
    open.push({ observed, tee });
  }
  assert.equal(
    open.every(({ observed }) => observed.aborted.length === 0),
    true,
    'holders that fit are all admitted',
  );

  // One more, while they are still open, must be refused by the pool itself.
  const extra = observer();
  const extraTee = createResponseObservationTee({ observer: extra });
  extraTee.stream.on('data', () => {});
  extraTee.stream.write(Buffer.alloc(1024, 0x62));
  assert.deepEqual(
    extra.aborted,
    ['global_budget'],
    'the pool refuses, and says so — not raw_limit or any other reason',
  );

  for (const { tee } of open) tee.abort('test_cleanup');
  await Promise.all(open.map(({ tee }) => tee.done));

  const after = observer();
  const afterTee = createResponseObservationTee({ observer: after });
  await pipeline(
    Readable.from([Buffer.from('small')]),
    afterTee.stream,
    new Writable({ write(_c, _e, cb) { cb(); } }),
  );
  await afterTee.done;
  assert.deepEqual(after.aborted, [], 'the pool was returned once the holders settled');
  assert.equal(Buffer.concat(after.chunks).toString(), 'small');
});

test('an identity stream is charged once, not once per path', async () => {
  // raw and decoded are the same bytes for identity. Sizes must sit below the
  // per-observation cap, or that cap absorbs the double charge and hides it.
  const each = 2 * 1024 * 1024;
  assert.ok(each * 2 <= MAX_OBSERVATION_CHARGE_BYTES, 'double charge must stay under the cap');
  const holders = Math.floor(MAX_GLOBAL_OBSERVATION_BUDGET_BYTES / each);

  const open = [];
  for (let i = 0; i < holders; i += 1) {
    const observed = observer();
    const tee = createResponseObservationTee({ observer: observed });
    tee.stream.on('data', () => {});
    tee.stream.write(Buffer.alloc(each, 0x61));
    open.push({ observed, tee });
  }

  assert.equal(
    open.filter(({ observed }) => observed.aborted.length > 0).length,
    0,
    `${holders} identity streams of ${each} bytes exactly fill the pool once; `
      + 'charging raw and decoded separately would shed half of them',
  );

  for (const { tee } of open) tee.abort('test_cleanup');
  await Promise.all(open.map(({ tee }) => tee.done));
});

test('a long stream stops accruing charge once it can hold no more', async () => {
  // Observers retain bounded prefixes, so a long stream must stop costing once
  // it passes the cap. Charging its whole throughput would starve the pool.
  const long = observer();
  const longTee = createResponseObservationTee({ observer: long });
  longTee.stream.on('data', () => {});
  const piece = Buffer.alloc(1024 * 1024, 0x61);
  for (let sent = 0; sent < MAX_OBSERVED_RAW_BYTES; sent += piece.length) {
    longTee.stream.write(piece);
  }
  assert.deepEqual(long.aborted, [], 'a single long stream is never shed by the pool');

  // With the cap it holds MAX_OBSERVATION_CHARGE_BYTES; without it, far more.
  // Fill almost all of the remainder and require every one to be admitted.
  const remaining = MAX_GLOBAL_OBSERVATION_BUDGET_BYTES - MAX_OBSERVATION_CHARGE_BYTES;
  const holders = Math.floor(remaining / MAX_OBSERVATION_CHARGE_BYTES);
  const open = [];
  for (let i = 0; i < holders; i += 1) {
    const observed = observer();
    const tee = createResponseObservationTee({ observer: observed });
    tee.stream.on('data', () => {});
    tee.stream.write(Buffer.alloc(MAX_OBSERVATION_CHARGE_BYTES, 0x62));
    open.push({ observed, tee });
  }
  assert.equal(
    open.filter(({ observed }) => observed.aborted.length > 0).length,
    0,
    'the long stream was charged its cap, not its throughput',
  );

  longTee.abort('test_cleanup');
  for (const { tee } of open) tee.abort('test_cleanup');
  await Promise.all([longTee.done, ...open.map(({ tee }) => tee.done)]);
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
