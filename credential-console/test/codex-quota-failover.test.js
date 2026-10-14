import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleCodexProxy } from '../lib/codex-proxy.js';
import { CodexQuotaSignal } from '../lib/codex-quota-signal.js';
import { CredentialStore } from '../lib/store.js';
import { QuotaExhaustion, codexQuotaRejection } from '../lib/account-failover.js';

const PAYLOAD = Buffer.from(JSON.stringify({
  model: 'gpt-6-luna',
  instructions: 'x',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'y'.repeat(256 * 1024) }] }],
  stream: true,
  store: false,
}));

const RESET_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function refusalBody() {
  return JSON.stringify({
    error: {
      type: 'usage_limit_reached',
      message: 'The usage limit has been reached',
      plan_type: 'pro',
      resets_at: RESET_SECONDS,
    },
  });
}

async function codexHome(root, name) {
  const home = join(root, name);
  await mkdir(join(home, 'public'), { recursive: true });
  await writeFile(join(home, 'public', 'current.json'), JSON.stringify({
    access_token: `access-${name}`,
    account_id: `chatgpt-${name}`,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  return home;
}

async function fleet({ backups = ['backup'], failoverEnabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'credential-console-codex-failover-'));
  const store = await new CredentialStore(join(root, 'console'), { allowKeyInit: true }).init();
  const accounts = {};
  for (const name of ['home', 'backup', 'spare']) {
    accounts[name] = await store.addAccount({
      provider: 'codex',
      alias: `codex-${name}`,
      external: { kind: 'codex-credential', home: await codexHome(root, name) },
    });
  }
  if (backups.length) {
    await store.setAccountFailover(accounts.home.id, {
      enabled: failoverEnabled,
      backupAccountIds: backups.map((name) => accounts[name].id),
      actor: 'test',
    });
  }
  const issued = await store.issueDeviceCredential({
    accountId: accounts.home.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
  });
  return { store, accounts, deviceToken: issued.token, deviceId: issued.device.id };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function harness(t, { store, usageSnapshotFor, quotaSignal = new CodexQuotaSignal() }, upstreamHandler) {
  const exhaustion = new QuotaExhaustion();
  const upstream = http.createServer((req, res) => {
    Promise.resolve(upstreamHandler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleCodexProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      exhaustion,
      quotaSignal,
      ...(usageSnapshotFor ? { usageSnapshotFor } : {}),
    })).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    upstream.closeAllConnections?.();
    proxy.closeAllConnections?.();
    await Promise.all([close(proxy), close(upstream)]);
  });
  return { proxyUrl, exhaustion };
}

function post(url, token, { body = PAYLOAD, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        ...headers,
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
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function settled(store) {
  await store.serialized(async () => {});
}

function bearer(req) {
  return String(req.headers.authorization ?? '').replace(/^Bearer /, '');
}

function refuse(res) {
  res.writeHead(429, { 'content-type': 'application/json', 'x-codex-primary-used-percent': '100' });
  res.end(refusalBody());
}

test('a Codex account out of quota is replaced mid-request and the client sees the backup answer', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  const seen = [];
  const { proxyUrl, exhaustion } = await harness(t, { store }, async (req, res) => {
    const body = await readBody(req);
    seen.push({
      token: bearer(req),
      account: req.headers['chatgpt-account-id'],
      turnState: req.headers['x-codex-turn-state'] ?? null,
      body,
    });
    if (bearer(req) === 'access-home') return refuse(res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.completed"}\n\n');
  });

  const response = await post(`${proxyUrl}/codex-api/responses`, deviceToken, {
    headers: { 'x-codex-turn-state': 'issued-by-home' },
  });

  assert.equal(response.status, 200, 'the 429 must never reach the client');
  assert.deepEqual(seen.map((entry) => entry.token), ['access-home', 'access-backup']);
  assert.equal(seen[1].account, 'chatgpt-backup', 'the backup is addressed as its own ChatGPT account');
  assert.equal(seen[0].turnState, 'issued-by-home');
  assert.equal(seen[1].turnState, null, 'turn affinity from the exhausted account is not carried over');
  assert.ok(seen[1].body.equals(PAYLOAD), 'the backup receives the identical body');
  assert.equal(Math.round(exhaustion.exhausted(accounts.home.id).until / 1000), RESET_SECONDS);

  await settled(store);
  const device = store.state.devices.find((entry) => entry.id === deviceId);
  assert.equal(device.selected_account_id, accounts.backup.id);
  assert.equal(device.account_failover.home_account_id, accounts.home.id);
});

test('a compressed refusal is still recognised', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    if (bearer(req) === 'access-home') {
      res.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(refusalBody()));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {}\n\n');
  });

  const response = await post(`${proxyUrl}/codex-api/responses`, deviceToken);

  assert.equal(response.status, 200);
  assert.deepEqual(tokens, ['access-home', 'access-backup']);
});

test('a Codex 429 that is not quota exhaustion reaches the client byte for byte', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet();
  const tokens = [];
  const burst = JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } });
  const { proxyUrl, exhaustion } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
    res.end(burst);
  });

  const response = await post(`${proxyUrl}/codex-api/responses`, deviceToken);

  assert.equal(response.status, 429);
  assert.equal(response.body.toString(), burst);
  assert.equal(response.headers['retry-after'], '3');
  assert.deepEqual(tokens, ['access-home']);
  assert.equal(exhaustion.exhausted(accounts.home.id), null);
});

test('with Codex failover off the refusal passes straight through', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet({ failoverEnabled: false });
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    refuse(res);
  });

  const response = await post(`${proxyUrl}/codex-api/responses`, deviceToken);

  assert.equal(response.status, 429);
  assert.equal(JSON.parse(response.body).error.type, 'usage_limit_reached');
  assert.deepEqual(tokens, ['access-home']);
});

test('when no backup is usable the refusal reaches the client unchanged', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    refuse(res);
  });

  const response = await post(`${proxyUrl}/codex-api/responses`, deviceToken);

  assert.equal(response.status, 429);
  assert.equal(response.body.toString(), refusalBody());
  assert.deepEqual(tokens, ['access-home', 'access-backup']);
});

test('an account the quota reading shows used up moves before spending credits', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet();
  const tokens = [];
  const later = new Date(Date.now() + 3_600_000).toISOString();
  // Credits keep an exhausted account answering 200, so no refusal would ever
  // come back; the reading is what has to move it.
  const usageSnapshotFor = (id) => (id === accounts.home.id
    ? { windows: [{ kind: 'weekly', position: 'primary', remaining_percent: 0, resets_at: later }] }
    : null);
  const { proxyUrl } = await harness(t, { store, usageSnapshotFor }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {}\n\n');
  });

  const response = await post(`${proxyUrl}/codex-api/responses`, deviceToken);

  assert.equal(response.status, 200);
  assert.deepEqual(tokens, ['access-backup']);
});

test('a backup whose low-quota guard is biting is not taken', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet({ backups: ['backup', 'spare'] });
  await store.setCodexModelGuard(accounts.backup.id, { enabled: true, thresholdPercent: 50, actor: 'test' });
  const usageSnapshotFor = (id) => (id === accounts.backup.id
    ? { windows: [{ kind: 'weekly', position: 'primary', remaining_percent: 20, resets_at: new Date(Date.now() + 3_600_000).toISOString() }] }
    : null);
  const tokens = [];
  const { proxyUrl } = await harness(t, { store, usageSnapshotFor }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    if (bearer(req) === 'access-home') return refuse(res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {}\n\n');
  });

  await post(`${proxyUrl}/codex-api/responses`, deviceToken);

  assert.deepEqual(tokens, ['access-home', 'access-spare']);
});

test('the model catalog is never failed over', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    tokens.push(bearer(req));
    refuse(res);
  });

  const response = await new Promise((resolve, reject) => {
    http.get(new URL(`${proxyUrl}/codex-api/models`), { headers: { Authorization: `Bearer ${deviceToken}` } }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode }));
    }).once('error', reject);
  });

  assert.equal(response.status, 429);
  assert.deepEqual(tokens, ['access-home']);
});

test('the Codex refusal is recognised only by its type', () => {
  const body = (value) => Buffer.from(JSON.stringify(value));
  assert.equal(codexQuotaRejection(429, body({ error: { type: 'rate_limit_exceeded' } })), null);
  assert.equal(codexQuotaRejection(400, Buffer.from(refusalBody())), null);
  assert.equal(codexQuotaRejection(429, Buffer.from('not json')), null);
  assert.deepEqual(codexQuotaRejection(429, Buffer.from(refusalBody())), { claim: null, resetsAtMs: RESET_SECONDS * 1000 });
  const now = 1_000_000;
  assert.equal(
    codexQuotaRejection(429, body({ error: { type: 'usage_limit_reached', resets_in_seconds: 60 } }), { now }).resetsAtMs,
    now + 60_000,
  );
});

test('a Codex refusal sent before the upload finished still replays the whole body', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const seen = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    if (bearer(req) === 'access-home') {
      seen.push({ token: 'access-home', body: null });
      refuse(res);
      req.resume();
      return;
    }
    const body = await readBody(req);
    seen.push({ token: bearer(req), body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {}\n\n');
  });

  const response = await new Promise((resolve, reject) => {
    const request = http.request(new URL(`${proxyUrl}/codex-api/responses`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json', 'Content-Length': PAYLOAD.length },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode }));
    });
    request.once('error', reject);
    const half = Math.floor(PAYLOAD.length / 2);
    request.write(PAYLOAD.subarray(0, half));
    setTimeout(() => request.end(PAYLOAD.subarray(half)), 300);
  });

  assert.equal(response.status, 200);
  assert.equal(seen.at(-1).token, 'access-backup');
  assert.ok(seen.at(-1).body.equals(PAYLOAD));
});

test('an oversized 429 body is streamed through untouched', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const big = Buffer.alloc(600 * 1024, 'z');
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    res.writeHead(429, { 'content-type': 'text/plain' });
    res.end(big);
  });

  const response = await post(`${proxyUrl}/codex-api/responses`, deviceToken);

  assert.equal(response.status, 429);
  assert.ok(response.body.equals(big));
  assert.deepEqual(tokens, ['access-home']);
});
