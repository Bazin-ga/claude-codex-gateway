import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeProxy } from '../lib/proxy.js';
import { MetricsStore } from '../lib/metrics.js';

const DEVICE_TOKEN = 'metrics-concurrency-device-token';
const DEVICE_ID = 'metrics-concurrency-device';
const ACCOUNT_ID = 'metrics-concurrency-account';
const REQUEST_BODY = Buffer.from(JSON.stringify({
  model: 'claude-concurrency-test',
  stream: true,
  messages: [{ role: 'user', content: 'performance test' }],
}));
const TIMED_BODY = (() => {
  const body = Buffer.alloc(128 * 1024, 0x78);
  body.write('event: message_start\ndata: {"ok":true}\n\n');
  return body;
})();
const HOLD_HEAD = Buffer.from('event: message_start\ndata: {"held":true}\n\n');
const HOLD_TAIL = Buffer.from('event: message_stop\ndata: {"done":true}\n\n');
const LARGE_BODY = (() => {
  const body = Buffer.alloc(64 * 1024 * 1024, 0x78);
  body.write('event: large\ndata: {"payload":"');
  body.write('"}\n\n', body.length - 5);
  return body;
})();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('timed out waiting for test state');
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function requestOptions(port) {
  return {
    host: '127.0.0.1',
    port,
    path: '/claude/v1/messages',
    method: 'POST',
    headers: {
      'X-Api-Key': DEVICE_TOKEN,
      'Content-Type': 'application/json',
      'Content-Length': REQUEST_BODY.length,
    },
  };
}

function openResponse(port, { pause = false } = {}) {
  const request = http.request(requestOptions(port));
  const responsePromise = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (response) => {
      const chunks = [];
      const done = new Promise((resolveDone, rejectDone) => {
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => resolveDone({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks),
        }));
        response.once('aborted', () => rejectDone(new Error('gateway response aborted')));
        response.once('error', rejectDone);
      });
      if (pause) response.pause();
      resolve({ response, statusCode: response.statusCode, done });
    });
  });
  request.end(REQUEST_BODY);
  return responsePromise;
}

async function requestAndMeasure(port) {
  const started = performance.now();
  const request = http.request(requestOptions(port));
  return new Promise((resolve, reject) => {
    let firstByteAt = null;
    const chunks = [];
    request.once('error', reject);
    request.once('response', (response) => {
      response.on('data', (chunk) => {
        firstByteAt ??= performance.now();
        chunks.push(Buffer.from(chunk));
      });
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        ttfbMs: firstByteAt === null ? null : firstByteAt - started,
        body: Buffer.concat(chunks),
      }));
      response.once('aborted', () => reject(new Error('gateway response aborted')));
      response.once('error', reject);
    });
    request.end(REQUEST_BODY);
  });
}

async function createHarness(t) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-concurrency-'));
  const metrics = await new MetricsStore({
    home,
    batchSize: 8,
    flushIntervalMs: 5,
    log: () => {},
  }).init();
  const device = {
    id: DEVICE_ID,
    account_id: ACCOUNT_ID,
    member_label: 'performance-test-member',
    machine_id: null,
  };
  const account = {
    id: ACCOUNT_ID,
    alias: 'performance-test-account',
    provider: 'claude',
    status: 'healthy',
    expires_at: null,
  };
  const store = {
    deviceByToken: (token) => token === DEVICE_TOKEN ? device : null,
    accountById: (id) => id === ACCOUNT_ID ? account : null,
    accountCredential: () => ({ oauth_token: 'synthetic-upstream-credential' }),
    markDeviceSeen: async () => {},
    updateAccountHealth: async () => {},
  };
  const state = {
    mode: 'timed',
    upstreamRequests: 0,
    held: [],
    large: null,
  };
  const upstream = http.createServer(async (request, response) => {
    try {
      for await (const _chunk of request) {}
    } catch {
      return;
    }
    if (request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    state.upstreamRequests += 1;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Request-Id': `synthetic-${state.upstreamRequests}`,
    });

    if (state.mode === 'held') {
      const held = { id: state.upstreamRequests, response, released: false, done: null };
      held.done = new Promise((resolve) => response.once('close', resolve));
      state.held.push(held);
      response.once('close', () => {
        const index = state.held.indexOf(held);
        if (index >= 0) state.held.splice(index, 1);
      });
      response.write(HOLD_HEAD);
      held.release = () => {
        if (held.released) return;
        held.released = true;
        response.end(HOLD_TAIL);
      };
      return;
    }

    if (state.mode === 'large') {
      const large = {
        bytesWritten: 0,
        completed: false,
        blocked: false,
        totalBytes: LARGE_BODY.length,
      };
      state.large = large;
      response.once('finish', () => { large.completed = true; });
      let offset = 0;
      const pump = () => {
        while (offset < LARGE_BODY.length) {
          const end = Math.min(offset + 16 * 1024, LARGE_BODY.length);
          const accepted = response.write(LARGE_BODY.subarray(offset, end));
          offset = end;
          large.bytesWritten = offset;
          if (!accepted) {
            large.blocked = true;
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      // Give the gateway client time to receive headers and pause before the
      // large body starts. Otherwise loopback buffers can absorb several MiB
      // before the test has a chance to observe backpressure.
      setTimeout(pump, 100);
      return;
    }

    const chunkSize = 4 * 1024;
    let offset = 0;
    const pump = () => {
      if (offset >= TIMED_BODY.length) {
        response.end();
        return;
      }
      const end = Math.min(offset + chunkSize, TIMED_BODY.length);
      response.write(TIMED_BODY.subarray(offset, end));
      offset = end;
      setTimeout(pump, 1);
    };
    setTimeout(pump, 25);
  });
  const upstreamPort = await listen(upstream);
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  const makeGateway = async (requestMetrics) => {
    const gateway = http.createServer((request, response) => {
      handleClaudeProxy(request, response, {
        store,
        requestMetrics,
        upstreamBaseUrl,
      }).catch((error) => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy(error);
      });
    });
    return { server: gateway, port: await listen(gateway) };
  };
  const off = await makeGateway(null);
  const on = await makeGateway(metrics);

  t.after(async () => {
    for (const held of [...state.held]) held.release?.();
    await Promise.allSettled(state.held.map((held) => held.done));
    await closeServer(off.server);
    await closeServer(on.server);
    await closeServer(upstream);
    metrics.close();
  });
  return { metrics, state, off, on };
}

test('eight concurrent SSE streams keep TTFB close with metrics on and off', {
  timeout: 20_000,
}, async (t) => {
  const { metrics, off, on } = await createHarness(t);
  const offTtfb = [];
  const onTtfb = [];
  const rounds = 3;
  for (let round = 0; round < rounds; round += 1) {
    const offResults = await Promise.all(
      Array.from({ length: 8 }, () => requestAndMeasure(off.port)),
    );
    const onResults = await Promise.all(
      Array.from({ length: 8 }, () => requestAndMeasure(on.port)),
    );
    for (const result of offResults) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.ttfbMs === null, false);
      assert.deepEqual(result.body, TIMED_BODY);
      offTtfb.push(result.ttfbMs);
    }
    for (const result of onResults) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.ttfbMs === null, false);
      assert.deepEqual(result.body, TIMED_BODY);
      onTtfb.push(result.ttfbMs);
    }
    metrics.flush();
  }
  const diagnostic = {
    rounds,
    streamsPerRound: 8,
    off: {
      min: Math.min(...offTtfb),
      median: percentile(offTtfb, 0.5),
      p95: percentile(offTtfb, 0.95),
      max: Math.max(...offTtfb),
    },
    on: {
      min: Math.min(...onTtfb),
      median: percentile(onTtfb, 0.5),
      p95: percentile(onTtfb, 0.95),
      max: Math.max(...onTtfb),
    },
  };
  t.diagnostic(JSON.stringify(diagnostic));
  assert.ok(diagnostic.on.max < 2_000, `metrics-on TTFB outlier: ${JSON.stringify(diagnostic)}`);
  assert.ok(
    diagnostic.on.p95 <= Math.max(diagnostic.off.p95 + 500, diagnostic.off.p95 * 8),
    `metrics-on p95 diverged from metrics-off: ${JSON.stringify(diagnostic)}`,
  );
  assert.equal(metrics.queryTotals({ scope: 'all' }).requestCount, rounds * 8);
});

test('the ninth stream is rejected until one of eight active streams finishes', {
  timeout: 20_000,
}, async (t) => {
  const { state, on } = await createHarness(t);
  state.mode = 'held';
  const held = await Promise.all(
    Array.from({ length: 8 }, () => openResponse(on.port)),
  );
  await waitFor(() => state.held.length === 8);
  assert.equal(held.every((entry) => entry.statusCode === 200), true);
  const initialHeldIds = new Set(state.held.map((entry) => entry.id));

  const upstreamBeforeNinth = state.upstreamRequests;
  const ninth = await openResponse(on.port);
  const ninthResult = await ninth.done;
  assert.equal(ninth.statusCode, 429);
  assert.equal(state.upstreamRequests, upstreamBeforeNinth);

  state.held[0].release();
  const firstResult = await held[0].done;
  assert.equal(firstResult.statusCode, 200);
  const replacement = await openResponse(on.port);
  assert.equal(replacement.statusCode, 200);
  await waitFor(() => state.held.some((entry) => !initialHeldIds.has(entry.id)));
  const replacementHeld = state.held.find((entry) => !initialHeldIds.has(entry.id));
  assert.ok(replacementHeld);
  replacementHeld.release();
  assert.equal((await replacement.done).statusCode, 200);

  for (const entry of [...state.held]) entry.release?.();
  await Promise.all(held.slice(1).map((entry) => entry.done));
  assert.equal(ninthResult.body.length > 0, true);
  assert.equal(state.upstreamRequests, upstreamBeforeNinth + 1);
  t.diagnostic(JSON.stringify({
    initialStreams: 8,
    rejectedStatus: ninth.statusCode,
    upstreamBeforeNinth,
    upstreamAfterReplacement: state.upstreamRequests,
  }));
});

test('a paused slow client applies backpressure before the large upstream SSE body finishes', {
  timeout: 20_000,
}, async (t) => {
  const { state, on } = await createHarness(t);
  state.mode = 'large';
  const paused = await openResponse(on.port, { pause: true });
  assert.equal(paused.statusCode, 200);
  await delay(150);
  assert.ok(state.large, 'large upstream state should be initialized');
  const snapshot = {
    bytesWritten: state.large.bytesWritten,
    totalBytes: state.large.totalBytes,
    completed: state.large.completed,
    blocked: state.large.blocked,
  };
  t.diagnostic(JSON.stringify(snapshot));
  paused.response.resume();
  const result = await paused.done;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, LARGE_BODY);
  assert.equal(snapshot.completed, false, 'upstream must not finish while client is paused');
  assert.ok(snapshot.bytesWritten < snapshot.totalBytes, 'upstream must stop before writing the full body');
  assert.equal(snapshot.blocked, true, 'upstream write should observe backpressure');
  await waitFor(() => state.large.completed);
});
