import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MetricsStore } from '../lib/metrics.js';
import {
  CodexCredentialError,
  handleCodexProxy,
  readPublishedCodexCredential,
} from '../lib/codex-proxy.js';

const DEVICE_TOKEN = 'codex-device-test-token';
const ACCESS_TOKEN = 'codex-upstream-access-token';
const UPSTREAM_ACCOUNT_ID = 'chatgpt-account-9999';

const DEVICE = {
  id: 'device-codex-test',
  account_id: 'account-codex-test',
  machine_id: 'machine-codex-test-0001',
  member_label: 'member@example.com',
};

/** A far-future expiry so the clock is never what a test is really asserting. */
function futureIso(msFromNow = 86_400_000) {
  return new Date(Date.now() + msFromNow).toISOString();
}

async function credentialHome(t, {
  accessToken = ACCESS_TOKEN,
  accountId = UPSTREAM_ACCOUNT_ID,
  expiresAt = futureIso(),
  extra = {},
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'codex-proxy-test-'));
  await mkdir(join(home, 'public'), { recursive: true });
  await writeFile(
    join(home, 'public', 'current.json'),
    JSON.stringify({
      access_token: accessToken,
      id_token: 'id-token-value',
      account_id: accountId,
      expires_at: expiresAt,
      published_at: new Date().toISOString(),
      ...extra,
    }),
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function codexAccount(home, overrides = {}) {
  return {
    id: DEVICE.account_id,
    provider: 'codex',
    alias: 'codex-test-account',
    status: 'stored',
    external: { kind: 'codex-credential', home },
    ...overrides,
  };
}

function storeFixture(account) {
  return {
    deviceByToken(token) {
      return token === DEVICE_TOKEN ? DEVICE : null;
    },
    accountById(id) {
      return id === account?.id ? account : null;
    },
    resolveDeviceAccount() {
      if (!account) throw Object.assign(new Error('no account'), { code: 'DEVICE_CONFIGURATION_INVALID' });
      return { device: DEVICE, account, effective_account_id: account.id };
    },
    markDeviceSeen() { return Promise.resolve(); },
    updateAccountHealth() { return Promise.resolve(); },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function startHarness(t, { upstreamHandler, requestMetrics = null, store, seen = {} }) {
  const upstream = http.createServer((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.headers = req.headers;
    upstreamHandler(req, res);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleCodexProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      requestMetrics,
    })).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await Promise.all([close(proxy), close(upstream)]); });
  return { proxyUrl, seen };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for a metric row');
}

function sink() {
  return { rows: [], enqueueRequest(row) { this.rows.push(row); } };
}

const TURN_SSE = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
  'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":'
    + '{"input_tokens":1000,"cached_input_tokens":900,"output_tokens":42}}}\n\n',
].join('');

function sseUpstream(body = TURN_SSE, status = 200) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-req-1' });
    res.end(body);
  };
}

function post(url, body, headers = {}) {
  return fetch(`${url}/codex-api/responses`, {
    method: 'POST',
    headers: { 'x-api-key': DEVICE_TOKEN, 'content-type': 'application/json', ...headers },
    body,
  });
}

test('a device token is exchanged for the subscription credential', async (t) => {
  const home = await credentialHome(t);
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: sseUpstream(),
    seen,
  });

  const response = await post(proxyUrl, JSON.stringify({ model: 'gpt-5.4', stream: true, input: [] }), {
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs/0.138.0',
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), TURN_SSE, 'the turn is passed through byte for byte');
  assert.equal(seen.url, '/responses', 'the gateway prefix is stripped');
  assert.equal(seen.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(seen.headers['chatgpt-account-id'], UPSTREAM_ACCOUNT_ID);
  assert.equal(seen.headers.originator, 'codex_cli_rs', 'client identity headers survive');
  assert.equal(seen.headers['user-agent'], 'codex_cli_rs/0.138.0');
});

test('the client credential never reaches the upstream', async (t) => {
  const home = await credentialHome(t);
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: sseUpstream(),
    seen,
  });

  await post(proxyUrl, '{}', { authorization: `Bearer ${DEVICE_TOKEN}` });

  assert.equal(seen.headers['x-api-key'], undefined, 'the device token is stripped');
  assert.equal(
    seen.headers.authorization,
    `Bearer ${ACCESS_TOKEN}`,
    'the client Authorization header is replaced, not appended to',
  );
  assert.ok(!JSON.stringify(seen.headers).includes(DEVICE_TOKEN), 'no header carries the device token');
});

test('only named headers are forwarded, so widening the list stays deliberate', async (t) => {
  const home = await credentialHome(t);
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: sseUpstream(),
    seen,
  });

  await post(proxyUrl, '{}', {
    cookie: 'console_session=secret-session-value',
    'x-forwarded-for': '203.0.113.9',
    'x-console-internal': 'internal-only',
  });

  for (const header of ['cookie', 'x-forwarded-for', 'x-console-internal']) {
    assert.equal(seen.headers[header], undefined, `${header} is not forwarded`);
  }
  assert.ok(!JSON.stringify(seen.headers).includes('secret-session-value'));
});

test('Codex token accounting is normalised to the columns this console sums', async (t) => {
  const home = await credentialHome(t);
  const metrics = sink();
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: sseUpstream(),
    requestMetrics: metrics,
  });

  await post(proxyUrl, JSON.stringify({ model: 'gpt-5.4-codex', stream: true }));
  const row = await waitFor(() => metrics.rows[0]);

  assert.equal(row.model, 'gpt-5.4-codex');
  assert.equal(row.stream, true);
  assert.equal(row.statusCode, 200);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.accountId, DEVICE.account_id);
  assert.equal(row.upstreamRequestId, 'upstream-req-1');
  // Upstream reported input_tokens=1000 *including* 900 cached. Storing 1000
  // beside a 900 cache read would count the cached prefix twice.
  assert.equal(row.inputTokens, 100);
  assert.equal(row.cacheReadInputTokens, 900);
  assert.equal(row.outputTokens, 42);
  assert.equal(row.cacheCreationInputTokens, null, 'the Responses API has no cache-creation figure');
  assert.equal(row.inputTokens + row.cacheReadInputTokens, 1000, 'the prompt is still accounted for once');
  assert.equal(row.usageState, 'complete');
});

test('a recorded Codex turn satisfies the real metrics schema', async (t) => {
  const home = await credentialHome(t);
  const metricsHome = await mkdtemp(join(tmpdir(), 'codex-metrics-'));
  t.after(() => rm(metricsHome, { recursive: true, force: true }));
  const metrics = await new MetricsStore({ home: metricsHome, flushIntervalMs: 60_000 }).init();
  t.after(() => metrics.close?.());

  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: sseUpstream(),
    requestMetrics: metrics,
  });

  const response = await post(proxyUrl, JSON.stringify({ model: 'gpt-5.4', stream: true }));
  assert.equal(response.status, 200);
  await response.text();
  // The CHECK constraints on the token columns are the point here: a negative
  // or non-integer count would be rejected by SQLite rather than by a mock.
  await metrics.flush();
  const rows = metrics.db.prepare(
    'SELECT model, input_tokens, cache_read_input_tokens, output_tokens, usage_state'
    + ' FROM request_metrics ORDER BY id DESC LIMIT 1',
  ).all();
  assert.equal(rows.length, 1, 'the Codex turn reached the database');
  assert.equal(rows[0].model, 'gpt-5.4');
  assert.equal(rows[0].input_tokens, 100);
  assert.equal(rows[0].cache_read_input_tokens, 900);
  assert.equal(rows[0].output_tokens, 42);
  assert.equal(rows[0].usage_state, 'complete');
});

test('an unauthenticated caller is refused before any credential is read', async (t) => {
  const home = await credentialHome(t);
  let upstreamCalls = 0;
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: (req, res) => { upstreamCalls += 1; res.writeHead(200).end(); },
  });

  const response = await fetch(`${proxyUrl}/codex-api/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.type, 'authentication_error');
  assert.equal(upstreamCalls, 0);
});

test('a Claude account cannot be spent through the Codex route', async (t) => {
  const home = await credentialHome(t);
  let upstreamCalls = 0;
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home, { provider: 'claude' })),
    upstreamHandler: (req, res) => { upstreamCalls += 1; res.writeHead(200).end(); },
  });

  const response = await post(proxyUrl, '{}');
  assert.equal(response.status, 403);
  assert.equal(upstreamCalls, 0);
});

test('only the inference endpoint is reachable', async (t) => {
  const home = await credentialHome(t);
  let upstreamCalls = 0;
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: (req, res) => { upstreamCalls += 1; res.writeHead(200).end(); },
  });

  for (const path of ['/codex-api/wham/usage', '/codex-api/analytics-events/events', '/codex-api/']) {
    const response = await fetch(`${proxyUrl}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': DEVICE_TOKEN, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404, `${path} is not proxied`);
  }
  assert.equal(upstreamCalls, 0, 'no unlisted path reached the upstream');
});

test('an expired credential is reported here rather than as an opaque upstream failure', async (t) => {
  const home = await credentialHome(t, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  let upstreamCalls = 0;
  const metrics = sink();
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: (req, res) => { upstreamCalls += 1; res.writeHead(200).end(); },
    requestMetrics: metrics,
  });

  const response = await post(proxyUrl, '{}');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /expired/);
  assert.equal(upstreamCalls, 0, 'an expired token is not spent on a doomed upstream call');
  const row = await waitFor(() => metrics.rows[0]);
  assert.equal(row.outcome, 'rejected');
  assert.equal(row.statusCode, 503);
});

test('a missing or unauthorised credential home fails closed', async (t) => {
  await assert.rejects(
    () => readPublishedCodexCredential({ external: { kind: 'codex-credential', home: '/nonexistent-home' } }),
    (error) => error instanceof CodexCredentialError && error.code === 'credential_unavailable',
  );
  await assert.rejects(
    () => readPublishedCodexCredential({ id: 'a', provider: 'codex' }),
    (error) => error instanceof CodexCredentialError && error.code === 'authorization_required',
    'an account that was never authorised is distinguishable from a broken one',
  );
});

test('the reader returns only the two fields it needs, never a refresh token', async (t) => {
  // The published file has no refresh_token by construction. Should a malformed
  // one ever appear, the reader must still not carry it forward.
  const home = await credentialHome(t, { extra: { refresh_token: 'must-never-be-read' } });
  const credential = await readPublishedCodexCredential({
    external: { kind: 'codex-credential', home },
  });
  assert.deepEqual(
    Object.keys(credential).sort(),
    ['accessToken', 'accountId', 'expiresAtMs'],
    'the returned shape cannot carry a refresh token',
  );
  assert.ok(!JSON.stringify(credential).includes('must-never-be-read'));
});

test('an upstream rejection of the subscription token is recorded against the account', async (t) => {
  const home = await credentialHome(t);
  const health = [];
  const store = storeFixture(codexAccount(home));
  store.updateAccountHealth = (id, detail) => { health.push({ id, ...detail }); return Promise.resolve(); };
  const { proxyUrl } = await startHarness(t, {
    store,
    upstreamHandler: (req, res) => {
      // 451 is how this upstream answers a dead subscription credential.
      res.writeHead(451, { 'content-type': 'application/json' });
      res.end('{"error":"no_biscuit_no_service"}');
    },
  });

  const response = await post(proxyUrl, '{}');
  assert.equal(response.status, 451, 'the upstream status reaches the client unchanged');
  await response.text();
  const recorded = await waitFor(() => health[0]);
  assert.equal(recorded.success, false);
  assert.match(recorded.error, /451/);
});

test('a large streamed turn arrives intact', async (t) => {
  const home = await credentialHome(t);
  const deltas = Array.from({ length: 500 }, (_, i) => `data: {"type":"response.output_text.delta","delta":"chunk-${i}"}\n\n`);
  const body = deltas.join('') + TURN_SSE;
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(codexAccount(home)),
    upstreamHandler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Written in pieces so the response is genuinely streamed, not buffered.
      let index = 0;
      const write = () => {
        if (index >= deltas.length) { res.end(TURN_SSE); return; }
        res.write(deltas[index++]);
        setImmediate(write);
      };
      write();
    },
  });

  const response = await post(proxyUrl, JSON.stringify({ model: 'gpt-5.4', stream: true }));
  assert.equal(await response.text(), body, 'every chunk survives the proxy in order');
});
