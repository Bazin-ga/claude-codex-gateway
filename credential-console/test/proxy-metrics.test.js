import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { MetricsStore } from '../lib/metrics.js';
import { handleClaudeProxy } from '../lib/proxy.js';

const DEVICE_TOKEN = 'device-test-token';
const ACCOUNT_CREDENTIAL = 'upstream-test-credential';
const DEVICE = {
  id: 'device-metrics-test',
  account_id: 'account-metrics-test',
  machine_id: 'machine-metrics-test-0001',
  member_label: 'member@example.com',
};
const ACCOUNT = {
  id: DEVICE.account_id,
  provider: 'claude',
  alias: 'claude-test-account',
  status: 'healthy',
  expires_at: null,
};

function storeFixture({ account = ACCOUNT } = {}) {
  return {
    deviceByToken(token) {
      return token === DEVICE_TOKEN ? DEVICE : null;
    },
    accountById(id) {
      return id === account.id ? account : null;
    },
    accountCredential(id) {
      assert.equal(id, ACCOUNT.id);
      return { oauth_token: ACCOUNT_CREDENTIAL };
    },
    markDeviceSeen() {
      return Promise.resolve();
    },
    updateAccountHealth() {
      return Promise.resolve();
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function startHarness(t, { upstreamHandler, requestMetrics, store = storeFixture() }) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleClaudeProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      requestMetrics,
    })).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await Promise.all([close(proxy), close(upstream)]);
  });
  return { proxyUrl, upstream };
}

function requestHeaders() {
  return {
    'X-Api-Key': DEVICE_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for proxy metric');
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fetchMetricResponse(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders(),
    body,
  });
  return {
    status: response.status,
    body: Buffer.from(await response.arrayBuffer()),
  };
}

async function rawMetricResponse(url, body, { acceptEncoding = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(url), {
      method: 'POST',
      headers: {
        ...requestHeaders(),
        'Content-Length': body.length,
        ...(acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('response aborted')));
    });
    request.once('error', reject);
    request.end(body);
  });
}

const COMPLETE_SSE = Buffer.from([
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":1}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":17}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n'));

const PARTIAL_START_SSE = Buffer.from([
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":13,"cache_creation_input_tokens":0,"cache_read_input_tokens":4,"output_tokens":1}}}',
  '',
  '',
].join('\n'));

test('records successful proxy metadata and forwards the exact request/response bytes', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const responseBody = Buffer.from('upstream-response-bytes');
  let upstreamRequest = null;
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req, res) => {
      upstreamRequest = { url: req.url, authorization: req.headers.authorization, body: await readBody(req) };
      res.writeHead(201, { 'Content-Type': 'application/octet-stream' });
      res.end(responseBody);
    },
  });
  const requestBody = Buffer.from(JSON.stringify({
    messages: [{ model: 'nested-model', stream: false }],
    model: 'root-model',
    stream: true,
  }));

  const response = await fetchMetricResponse(`${proxyUrl}/claude/v1/messages`, requestBody);
  const row = await waitFor(() => sink.rows[0]);

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, responseBody);
  assert.deepEqual(upstreamRequest.body, requestBody);
  assert.equal(upstreamRequest.url, '/v1/messages');
  assert.equal(upstreamRequest.authorization, `Bearer ${ACCOUNT_CREDENTIAL}`);
  assert.equal(row.requestBytes, requestBody.length);
  assert.equal(row.responseBytes, responseBody.length);
  assert.equal(row.model, 'root-model');
  assert.equal(row.stream, true);
  assert.equal(row.deviceId, DEVICE.id);
  assert.equal(row.machineId, DEVICE.machine_id);
  assert.equal(row.memberLabel, DEVICE.member_label);
  assert.equal(row.accountId, ACCOUNT.id);
  assert.equal(row.accountAlias, ACCOUNT.alias);
  assert.equal(row.statusCode, 201);
  assert.equal(row.outcome, 'completed');
  assert.equal(typeof row.ttfbMs, 'number');
  assert.ok(row.ttfbMs >= 0);
  assert.equal(typeof row.durationMs, 'number');
  assert.ok(row.durationMs >= row.ttfbMs);
  assert.equal(sink.rows.length, 1);
});

test('records count_tokens with query under the exact excluded pathname', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  let upstreamUrl = null;
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req, res) => {
      upstreamUrl = req.url;
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    },
  });

  const response = await fetchMetricResponse(
    `${proxyUrl}/claude/v1/messages/count_tokens?probe=query`,
    Buffer.from('{"model":"count-model","stream":false}'),
  );
  const row = await waitFor(() => sink.rows[0]);

  assert.equal(response.status, 200);
  assert.equal(upstreamUrl, '/v1/messages/count_tokens?probe=query');
  assert.equal(row.path, '/v1/messages/count_tokens');
  assert.equal(row.model, 'count-model');
  assert.equal(row.stream, false);
  assert.equal(row.statusCode, 200);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.usageState, 'unavailable');
  assert.equal(row.inputTokens, null);
  assert.equal(row.outputTokens, null);
  assert.equal(sink.rows.length, 1);
});

test('extracts cumulative SSE usage without changing response bytes', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(COMPLETE_SSE.subarray(0, 7));
      res.write(COMPLETE_SSE.subarray(7, 31));
      res.write(COMPLETE_SSE.subarray(31, 149));
      res.end(COMPLETE_SSE.subarray(149));
    },
  });
  const response = await fetchMetricResponse(
    `${proxyUrl}/claude/v1/messages`,
    Buffer.from('{"model":"usage-sse","stream":true}'),
  );
  const row = await waitFor(() => sink.rows[0]);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, COMPLETE_SSE);
  assert.equal(row.inputTokens, 11);
  assert.equal(row.cacheCreationInputTokens, 2);
  assert.equal(row.cacheReadInputTokens, 3);
  assert.equal(row.outputTokens, 17, 'message_delta is cumulative, not 1 + 17');
  assert.equal(row.usageState, 'complete');
  assert.equal(row.responseBytes, COMPLETE_SSE.length);
});

test('extracts nullable cache usage from a non-streaming JSON response', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const responseBody = Buffer.from(JSON.stringify({
    id: 'message-safe-fixture',
    type: 'message',
    content: [{ type: 'text', text: 'hello' }],
    usage: {
      input_tokens: 7,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 0,
      output_tokens: 9,
    },
  }));
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(responseBody);
    },
  });
  const response = await fetchMetricResponse(
    `${proxyUrl}/claude/v1/messages`,
    Buffer.from('{"model":"usage-json","stream":false}'),
  );
  const row = await waitFor(() => sink.rows[0]);
  assert.deepEqual(response.body, responseBody);
  assert.equal(row.inputTokens, 7);
  assert.equal(row.cacheCreationInputTokens, null);
  assert.equal(row.cacheReadInputTokens, 0);
  assert.equal(row.outputTokens, 9);
  assert.equal(row.usageState, 'complete');
});

test('gzip and brotli usage observation preserves compressed client bytes and headers', async (t) => {
  for (const [encoding, encoded] of [
    ['gzip', gzipSync(COMPLETE_SSE)],
    ['br', brotliCompressSync(COMPLETE_SSE)],
  ]) {
    const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
    let upstreamAcceptEncoding = null;
    const { proxyUrl } = await startHarness(t, {
      requestMetrics: sink,
      upstreamHandler: async (req, res) => {
        upstreamAcceptEncoding = req.headers['accept-encoding'];
        await readBody(req);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': encoding,
        });
        res.write(encoded.subarray(0, 5));
        res.end(encoded.subarray(5));
      },
    });
    const response = await rawMetricResponse(
      `${proxyUrl}/claude/v1/messages`,
      Buffer.from('{"model":"usage-compressed","stream":true}'),
      { acceptEncoding: encoding },
    );
    const row = await waitFor(() => sink.rows[0]);
    assert.equal(upstreamAcceptEncoding, encoding);
    assert.equal(response.headers['content-encoding'], encoding);
    assert.deepEqual(response.body, encoded, `${encoding} response bytes changed`);
    assert.equal(row.responseBytes, encoded.length);
    assert.equal(row.inputTokens, 11);
    assert.equal(row.outputTokens, 17);
    assert.equal(row.usageState, 'complete');
  }
});

test('a broken compressed body remains byte-identical and only marks usage unavailable', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const invalid = Buffer.from('not-a-gzip-stream');
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req, res) => {
      await readBody(req);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
      });
      res.end(invalid);
    },
  });
  const response = await rawMetricResponse(
    `${proxyUrl}/claude/v1/messages`,
    Buffer.from('{"model":"usage-invalid-gzip","stream":true}'),
    { acceptEncoding: 'gzip' },
  );
  const row = await waitFor(() => sink.rows[0]);
  assert.deepEqual(response.body, invalid);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.usageState, 'unavailable');
  assert.equal(row.inputTokens, null);
  assert.equal(row.outputTokens, null);
});

test('compressed SSE usage persists through schema v2 without storing response text', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-p5-integration-'));
  const metrics = await new MetricsStore({ home, flushIntervalMs: 60_000 }).init();
  t.after(async () => {
    metrics.close();
    await rm(home, { recursive: true, force: true });
  });
  const responseMarker = 'response-body-marker-must-not-enter-sqlite';
  const body = Buffer.from(COMPLETE_SSE.toString('utf8').replace(
    'event: message_delta',
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${responseMarker}"}}\n\nevent: message_delta`,
  ));
  const encoded = gzipSync(body);
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: metrics,
    upstreamHandler: async (req, res) => {
      await readBody(req);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
      });
      res.end(encoded);
    },
  });
  const response = await rawMetricResponse(
    `${proxyUrl}/claude/v1/messages`,
    Buffer.from('{"model":"p5-schema-integration","stream":true}'),
    { acceptEncoding: 'gzip' },
  );
  assert.deepEqual(response.body, encoded);
  await waitFor(() => metrics.stats.enqueued === 1);
  assert.equal(metrics.flush().written, 1);
  const totals = metrics.queryTotals({ scope: 'consumption' });
  assert.equal(totals.totalInputTokens, 11);
  assert.equal(totals.totalCacheCreationInputTokens, 2);
  assert.equal(totals.totalCacheReadInputTokens, 3);
  assert.equal(totals.totalOutputTokens, 17);
  assert.equal(totals.usageCompleteCount, 1);
  assert.equal(totals.usagePartialCount, 0);
  assert.equal(totals.usageUnavailableCount, 0);

  const database = await readFile(join(home, 'metrics.sqlite'));
  const wal = await readFile(join(home, 'metrics.sqlite-wal')).catch(() => Buffer.alloc(0));
  assert.equal(Buffer.concat([database, wal]).includes(Buffer.from(responseMarker)), false);
});

test('authenticated pre-proxy rejections retain attribution without touching upstream', async (t) => {
  for (const scenario of [
    {
      name: 'expired account',
      path: '/claude/v1/messages',
      status: 503,
      store: storeFixture({ account: { ...ACCOUNT, expires_at: '2020-01-01T00:00:00.000Z' } }),
    },
    {
      name: 'unsupported path',
      path: '/claude/private/account',
      status: 404,
      store: storeFixture(),
    },
  ]) {
    const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
    let upstreamRequests = 0;
    const { proxyUrl } = await startHarness(t, {
      requestMetrics: sink,
      store: scenario.store,
      upstreamHandler: (_req, res) => {
        upstreamRequests += 1;
        res.end('unexpected');
      },
    });
    const response = await fetchMetricResponse(
      `${proxyUrl}${scenario.path}`,
      Buffer.from('{"model":"not-observed-on-rejection"}'),
    );
    const row = await waitFor(() => sink.rows[0]);
    assert.equal(response.status, scenario.status, scenario.name);
    assert.equal(upstreamRequests, 0, scenario.name);
    assert.equal(row.statusCode, scenario.status, scenario.name);
    assert.equal(row.outcome, 'rejected', scenario.name);
    assert.equal(row.deviceId, DEVICE.id, scenario.name);
    assert.equal(row.memberLabel, DEVICE.member_label, scenario.name);
    assert.equal(row.accountId, ACCOUNT.id, scenario.name);
    assert.equal(row.model, null, scenario.name);
    assert.equal(row.ttfbMs, null, scenario.name);
    assert.equal(row.requestBytes, 0, scenario.name);
    assert.equal(sink.rows.length, 1, scenario.name);
  }
});

test('a normal early upstream response waits for the request tee before recording', {
  timeout: 10_000,
}, async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const first = Buffer.from(`{"padding":"${'x'.repeat(1024)}`);
  const rest = Buffer.from(`${'x'.repeat(8 * 1024)}","model":"late-model","stream":true}`);
  const body = Buffer.concat([first, rest]);
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('early-response');
    },
  });

  const request = http.request(new URL(`${proxyUrl}/claude/v1/messages`), {
    method: 'POST',
    headers: {
      ...requestHeaders(),
      'Content-Length': body.length,
    },
  });
  const response = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.once('end', () => resolve({
        status: incoming.statusCode,
        body: Buffer.concat(chunks),
      }));
      incoming.once('error', reject);
    });
  });
  request.write(first);
  await once(request, 'response');
  assert.equal(sink.rows.length, 0, 'response headers alone must not finalize request metadata');
  request.end(rest);
  const received = await response;
  assert.equal(received.status, 200);
  assert.equal(received.body.toString('utf8'), 'early-response');
  const row = await waitFor(() => sink.rows[0]);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.requestBytes, body.length);
  assert.equal(row.model, 'late-model');
  assert.equal(row.stream, true);
  assert.equal(sink.rows.length, 1);
});

test('an in-flight request keeps its resolved account while the next request uses a switch', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const device = {
    ...DEVICE,
    account_id: 'account-a',
    allowed_account_ids: ['account-a', 'account-b'],
    selected_account_id: 'account-a',
  };
  const accounts = new Map([
    ['account-a', { ...ACCOUNT, id: 'account-a', alias: 'account-a' }],
    ['account-b', { ...ACCOUNT, id: 'account-b', alias: 'account-b' }],
  ]);
  const store = {
    deviceByToken: (token) => token === DEVICE_TOKEN ? device : null,
    resolveDeviceAccount: () => {
      const account = accounts.get(device.selected_account_id);
      return { account, effective_account_id: account.id };
    },
    accountCredential: (id) => ({ oauth_token: `upstream-${id}` }),
    markDeviceSeen: async () => {},
    updateAccountHealth: async () => {},
  };
  const authorizations = [];
  const releases = [];
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    store,
    upstreamHandler: async (req, res) => {
      await readBody(req);
      authorizations.push(req.headers.authorization);
      await new Promise((resolve) => releases.push(resolve));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    },
  });

  const first = fetchMetricResponse(
    `${proxyUrl}/claude/v1/messages`,
    Buffer.from('{"model":"before-switch"}'),
  );
  await waitFor(() => authorizations.length === 1);
  device.selected_account_id = 'account-b';
  const second = fetchMetricResponse(
    `${proxyUrl}/claude/v1/messages`,
    Buffer.from('{"model":"after-switch"}'),
  );
  await waitFor(() => authorizations.length === 2);
  for (const release of releases) release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(authorizations, ['Bearer upstream-account-a', 'Bearer upstream-account-b']);
  await waitFor(() => sink.rows.length === 2);
  assert.deepEqual(sink.rows.map((row) => row.accountId).sort(), ['account-a', 'account-b']);
});

for (const [label, requestMetrics] of [
  ['synchronous throw', { enqueueRequest() { throw new Error('sink unavailable'); } }],
  ['asynchronous reject', { enqueueRequest() { return Promise.reject(new Error('sink unavailable')); } }],
]) {
  test(`metrics ${label} cannot break a successful 200 response`, async (t) => {
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const responseBody = Buffer.from('still-forwarded');
    const { proxyUrl } = await startHarness(t, {
      requestMetrics,
      upstreamHandler: async (req, res) => {
        await readBody(req);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(responseBody);
      },
    });
    try {
      const response = await fetchMetricResponse(
        `${proxyUrl}/claude/v1/messages`,
        Buffer.from('{"model":"sink-test"}'),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, responseBody);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
}

test('upstream disconnect before headers returns 502 and enqueues exactly one row', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  let upstreamSawRequest = false;
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req) => {
      upstreamSawRequest = true;
      await readBody(req);
      req.socket.destroy();
    },
  });

  const response = await fetchMetricResponse(
    `${proxyUrl}/claude/v1/messages`,
    Buffer.from('{"model":"before-headers"}'),
  );
  const row = await waitFor(() => sink.rows[0]);

  assert.equal(upstreamSawRequest, true);
  assert.equal(response.status, 502);
  assert.equal(row.statusCode, 502);
  assert.equal(row.outcome, 'upstream_error_before_headers');
  assert.equal(row.ttfbMs, null);
  assert.equal(row.responseBytes, 0);
  assert.equal(sink.rows.length, 1);
});

test('upstream disconnect after headers records one partial upstream-error row', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const partial = Buffer.from([
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":8}}',
    '',
    '',
  ].join('\n'));
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(partial);
      setTimeout(() => res.destroy(), 20).unref();
    },
  });

  await assert.rejects(
    fetchMetricResponse(`${proxyUrl}/claude/v1/messages`, Buffer.from('{"model":"partial"}')),
  );
  const row = await waitFor(() => sink.rows[0]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(row.statusCode, 200);
  assert.equal(row.outcome, 'upstream_error_after_headers');
  assert.ok(row.ttfbMs >= 0);
  assert.equal(row.responseBytes, partial.length);
  assert.equal(row.inputTokens, 5);
  assert.equal(row.outputTokens, 8);
  assert.equal(row.usageState, 'partial');
  assert.equal(sink.rows.length, 1);
});

test('client disconnect records client_aborted, destroys upstream, and enqueues once', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const upstreamClosed = new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    t.upstreamClosed = finish;
  });
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(PARTIAL_START_SSE);
      const timer = setInterval(() => res.write(': keepalive\n\n'), 5);
      res.on('close', () => {
        clearInterval(timer);
        t.upstreamClosed?.();
      });
    },
  });

  await new Promise((resolve, reject) => {
    const request = http.request(new URL(`${proxyUrl}/claude/v1/messages`), {
      method: 'POST',
      headers: requestHeaders(),
    }, (response) => {
      response.once('data', () => {
        request.destroy();
        resolve();
      });
      response.on('error', () => {});
    });
    request.on('error', () => {});
    request.once('socket', () => {});
    request.end('{"model":"client-abort","stream":true}');
    setTimeout(() => reject(new Error('client did not receive a streaming response')), 3_000).unref();
  });

  await upstreamClosed;
  const row = await waitFor(() => sink.rows[0]);
  assert.equal(row.outcome, 'client_aborted');
  assert.equal(row.statusCode, 200);
  assert.ok(row.ttfbMs >= 0);
  assert.ok(row.responseBytes > 0);
  assert.equal(row.inputTokens, 13);
  assert.equal(row.cacheCreationInputTokens, 0);
  assert.equal(row.cacheReadInputTokens, 4);
  assert.equal(row.outputTokens, 1);
  assert.equal(row.usageState, 'partial');
  assert.equal(sink.rows.length, 1);
});

test('chunked body over 32MiB returns 413 without forwarding the complete body', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  const bodySize = 32 * 1024 * 1024 + 128 * 1024;
  let upstreamBytes = 0;
  let upstreamEnded = false;
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: (req, res) => {
      req.on('data', (chunk) => { upstreamBytes += chunk.length; });
      req.on('end', () => {
        upstreamEnded = true;
        res.end('unexpected-complete-upstream-body');
      });
    },
  });

  const result = await new Promise((resolve, reject) => {
    const request = http.request(new URL(`${proxyUrl}/claude/v1/messages`), {
      method: 'POST',
      headers: requestHeaders(),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', (error) => {
      // The proxy is allowed to close the upload after emitting 413. If no
      // response made it back, surface that as a test failure.
      if (!request.reusedSocket) reject(error);
    });
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let sent = 0;
    const write = () => {
      while (sent < bodySize) {
        const length = Math.min(chunk.length, bodySize - sent);
        const writable = request.write(length === chunk.length ? chunk : chunk.subarray(0, length));
        sent += length;
        if (!writable) {
          request.once('drain', write);
          return;
        }
      }
      request.end();
    };
    write();
  });
  const row = await waitFor(() => sink.rows[0]);

  assert.equal(result.status, 413);
  assert.equal(row.statusCode, 413);
  assert.equal(row.outcome, 'request_too_large');
  assert.ok(row.requestBytes > 32 * 1024 * 1024);
  assert.ok(row.requestBytes <= bodySize);
  assert.ok(upstreamBytes <= 32 * 1024 * 1024);
  assert.equal(upstreamEnded, false);
  assert.equal(sink.rows.length, 1);
});

test('declared oversized body is rejected and its idle upload connection is closed', async (t) => {
  const sink = { rows: [], enqueueRequest(row) { this.rows.push(row); } };
  let upstreamRequests = 0;
  const { proxyUrl } = await startHarness(t, {
    requestMetrics: sink,
    upstreamHandler: (_req, res) => {
      upstreamRequests += 1;
      res.end('unexpected');
    },
  });

  const result = await new Promise((resolve, reject) => {
    const request = http.request(new URL(`${proxyUrl}/claude/v1/messages`), {
      method: 'POST',
      headers: {
        ...requestHeaders(),
        'Content-Length': 32 * 1024 * 1024 + 1,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode,
        connection: response.headers.connection,
        body: Buffer.concat(chunks),
        request,
      }));
    });
    request.once('error', reject);
    request.end();
  });

  assert.equal(result.status, 413);
  assert.equal(result.connection, 'close');
  assert.match(result.body.toString('utf8'), /request body too large/);
  await waitFor(() => result.request.destroyed);
  assert.equal(upstreamRequests, 0);
  const row = await waitFor(() => sink.rows[0]);
  assert.equal(row.statusCode, 413);
  assert.equal(row.outcome, 'request_too_large');
  assert.equal(row.requestBytes, 0);
  assert.equal(sink.rows.length, 1);
});
