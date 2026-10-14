import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeProxy } from '../lib/proxy.js';
import { CredentialStore } from '../lib/store.js';
import {
  QuotaExhaustion,
  chooseFailoverAccount,
  claudeQuotaRejection,
  normalizeAccountFailover,
  usageShowsExhausted,
} from '../lib/account-failover.js';

// Large enough to span several chunks, so a replay that resent only part of
// the buffered body cannot pass by accident.
const PAYLOAD = Buffer.from(JSON.stringify({
  model: 'claude-opus-5-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }],
}));

const RESET_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function exhaustedHeaders(claim = 'seven_day') {
  return {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': claim,
    'anthropic-ratelimit-unified-reset': String(RESET_SECONDS),
  };
}

function refuse(res, headers = exhaustedHeaders()) {
  res.writeHead(429, headers);
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit reached' } }));
}

async function fleet({ backups = ['backup'], failoverEnabled = true, accountsNamed = ['home', 'backup', 'spare'] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-failover-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const accounts = {};
  for (const name of accountsNamed) {
    accounts[name] = await store.addAccount({
      provider: 'claude',
      alias: `claude-${name}`,
      credential: { oauth_token: `token-${name}` },
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

async function harness(t, { store, exhaustion = new QuotaExhaustion(), usageSnapshotFor }, upstreamHandler) {
  const upstream = http.createServer((req, res) => {
    Promise.resolve(upstreamHandler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleClaudeProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      exhaustion,
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

function post(url, token, body = PAYLOAD) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(url), {
      method: 'POST',
      headers: {
        'X-Api-Key': token,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(body);
  });
}

/** The store persists on its own queue; wait for anything already scheduled. */
async function settled(store) {
  await store.serialized(async () => {});
}

function bearer(req) {
  return String(req.headers.authorization ?? '').replace(/^Bearer /, '');
}

test('an exhausted account is replaced mid-request and the client sees the backup answer', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  const seen = [];
  const { proxyUrl, exhaustion } = await harness(t, { store }, async (req, res) => {
    const body = await readBody(req);
    seen.push({ token: bearer(req), body });
    if (bearer(req) === 'token-home') return refuse(res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, served_by: bearer(req) }));
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.equal(response.status, 200, 'the 429 must never reach the client');
  assert.equal(JSON.parse(response.body).served_by, 'token-backup');
  assert.deepEqual(seen.map((entry) => entry.token), ['token-home', 'token-backup']);
  assert.ok(seen[1].body.equals(PAYLOAD), 'the backup must receive the identical body');
  assert.ok(exhaustion.exhausted(accounts.home.id), 'the exhausted account is remembered');
  assert.equal(
    Math.round(exhaustion.exhausted(accounts.home.id).until / 1000),
    RESET_SECONDS,
    'and believed exhausted until the reset the upstream announced',
  );

  await settled(store);
  const device = store.state.devices.find((entry) => entry.id === deviceId);
  assert.equal(device.selected_account_id, accounts.backup.id, 'the device itself moves to the backup');
  assert.equal(device.account_failover.home_account_id, accounts.home.id);
  assert.equal(Date.parse(device.account_failover.return_after), RESET_SECONDS * 1000);
  assert.ok(store.state.audit.some((entry) => entry.event === 'device_account_failover'
    && entry.previous_account_id === accounts.home.id
    && entry.next_account_id === accounts.backup.id));
});

test('the next request goes straight to the backup without touching the exhausted account', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    if (bearer(req) === 'token-home') return refuse(res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await post(`${proxyUrl}/claude/v1/messages`, deviceToken);
  await settled(store);
  await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.deepEqual(tokens, ['token-home', 'token-backup', 'token-backup']);
});

test('another device on a known-exhausted account fails over before sending anything', { timeout: 20_000 }, async (t) => {
  const { store, accounts } = await fleet();
  const second = await store.issueDeviceCredential({
    accountId: accounts.home.id,
    memberLabel: 'other@example.com',
    deviceName: 'other-laptop',
  });
  const exhaustion = new QuotaExhaustion();
  exhaustion.mark(accounts.home.id, { resetsAtMs: Date.now() + 60_000 });
  const tokens = [];
  const { proxyUrl } = await harness(t, { store, exhaustion }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, second.token);

  assert.equal(response.status, 200);
  assert.deepEqual(tokens, ['token-backup'], 'the exhausted account is not asked again');
  await settled(store);
  assert.equal(
    store.state.devices.find((entry) => entry.id === second.device.id).selected_account_id,
    accounts.backup.id,
  );
});

test('a 429 that is not quota exhaustion is passed through and moves nothing', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  const tokens = [];
  const { proxyUrl, exhaustion } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    refuse(res, { 'content-type': 'application/json', 'retry-after': '5' });
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.equal(response.status, 429);
  assert.deepEqual(tokens, ['token-home']);
  assert.equal(exhaustion.exhausted(accounts.home.id), null);
  await settled(store);
  assert.equal(store.state.devices.find((entry) => entry.id === deviceId).selected_account_id, accounts.home.id);
});

test('with failover off the refusal reaches the client unchanged', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet({ failoverEnabled: false });
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    refuse(res);
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.equal(response.status, 429);
  assert.equal(JSON.parse(response.body).error.message, 'limit reached');
  assert.deepEqual(tokens, ['token-home']);
});

test('backups are tried in order until one answers', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet({ backups: ['backup', 'spare'] });
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    if (bearer(req) !== 'token-spare') return refuse(res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.equal(response.status, 200);
  assert.deepEqual(tokens, ['token-home', 'token-backup', 'token-spare']);
  await settled(store);
  const device = store.state.devices.find((entry) => entry.id === deviceId);
  assert.equal(device.selected_account_id, accounts.spare.id);
  assert.equal(device.account_failover.home_account_id, accounts.home.id);
});

test('when every backup is exhausted the last refusal reaches the client', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet({ backups: ['backup'] });
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    refuse(res);
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.equal(response.status, 429);
  assert.deepEqual(tokens, ['token-home', 'token-backup']);
  await settled(store);
  assert.equal(
    store.state.devices.find((entry) => entry.id === deviceId).selected_account_id,
    accounts.home.id,
    'nothing served the request, so the device is not moved',
  );
});

test('a backup the usage poll shows as exhausted is skipped', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet({ backups: ['backup', 'spare'] });
  const tokens = [];
  const usageSnapshotFor = (id) => (id === accounts.backup.id
    ? { windows: [{ kind: 'weekly', remaining_percent: 0, resets_at: new Date(Date.now() + 3_600_000).toISOString() }] }
    : null);
  const { proxyUrl } = await harness(t, { store, usageSnapshotFor }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    if (bearer(req) === 'token-home') return refuse(res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.deepEqual(tokens, ['token-home', 'token-spare']);
});

test('a refusal sent before the upload finished still replays the whole body', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const seen = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    if (bearer(req) === 'token-home') {
      // Answer at once without reading the body, as a limiter may.
      seen.push({ token: 'token-home', body: null });
      refuse(res);
      req.resume();
      return;
    }
    const body = await readBody(req);
    seen.push({ token: bearer(req), body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  // Uploaded slowly, so the refusal certainly arrives mid-body.
  const response = await new Promise((resolve, reject) => {
    const request = http.request(new URL(`${proxyUrl}/claude/v1/messages`), {
      method: 'POST',
      headers: { 'X-Api-Key': deviceToken, 'Content-Type': 'application/json', 'Content-Length': PAYLOAD.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode }));
    });
    request.once('error', reject);
    const half = Math.floor(PAYLOAD.length / 2);
    request.write(PAYLOAD.subarray(0, half));
    setTimeout(() => request.end(PAYLOAD.subarray(half)), 300);
  });

  assert.equal(response.status, 200);
  assert.equal(seen.at(-1).token, 'token-backup');
  assert.ok(seen.at(-1).body.equals(PAYLOAD));
});

test('a failed-over device returns home once the home account has reset', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  await store.failoverDeviceAccount({
    deviceId,
    homeAccountId: accounts.home.id,
    fromAccountId: accounts.home.id,
    toAccountId: accounts.backup.id,
    returnAfterMs: Date.now() - 1000,
  });
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.deepEqual(tokens, ['token-home']);
  await settled(store);
  const device = store.state.devices.find((entry) => entry.id === deviceId);
  assert.equal(device.selected_account_id, accounts.home.id);
  assert.equal(device.account_failover, undefined);
  assert.deepEqual(device.allowed_account_ids, [accounts.home.id], 'the backup the move added is taken back out');
  assert.ok(store.state.audit.some((entry) => entry.event === 'device_account_failback'));
});

test('a failed-over device stays on the backup until the home account resets', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  await store.failoverDeviceAccount({
    deviceId,
    homeAccountId: accounts.home.id,
    fromAccountId: accounts.home.id,
    toAccountId: accounts.backup.id,
    returnAfterMs: Date.now() + 60_000,
  });
  const tokens = [];
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    tokens.push(bearer(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await post(`${proxyUrl}/claude/v1/messages`, deviceToken);

  assert.deepEqual(tokens, ['token-backup']);
});

test('a manual switch clears the failover marker so nothing switches back later', async () => {
  const { store, accounts, deviceId } = await fleet();
  await store.failoverDeviceAccount({
    deviceId,
    homeAccountId: accounts.home.id,
    fromAccountId: accounts.home.id,
    toAccountId: accounts.backup.id,
    returnAfterMs: Date.now() + 60_000,
  });
  await store.configureDeviceAccount({ deviceId, selectedAccountId: accounts.spare.id, actor: 'operator' });
  const device = store.state.devices.find((entry) => entry.id === deviceId);
  assert.equal(device.selected_account_id, accounts.spare.id);
  assert.equal(device.account_failover, undefined);
});

test('a failover recorded after somebody moved the device is a no-op', async () => {
  const { store, accounts, deviceId } = await fleet();
  await store.configureDeviceAccount({ deviceId, selectedAccountId: accounts.spare.id, actor: 'operator' });
  const result = await store.failoverDeviceAccount({
    deviceId,
    homeAccountId: accounts.home.id,
    fromAccountId: accounts.home.id,
    toAccountId: accounts.backup.id,
  });
  assert.equal(result.outcome, 'moved_elsewhere');
  assert.equal(store.state.devices.find((entry) => entry.id === deviceId).selected_account_id, accounts.spare.id);
});

test('the failover setting is validated and audited', async () => {
  const { store, accounts } = await fleet({ backups: [] });
  await assert.rejects(
    store.setAccountFailover(accounts.home.id, { enabled: true, backupAccountIds: [] }),
    /at least one backup/,
  );
  await assert.rejects(
    store.setAccountFailover(accounts.home.id, { enabled: true, backupAccountIds: [accounts.home.id] }),
    /own backup/,
  );
  const codex = await store.addAccount({ provider: 'codex', alias: 'codex-peer', external: { kind: 'codex-credential', home: '/nonexistent' } });
  await assert.rejects(
    store.setAccountFailover(accounts.home.id, { enabled: true, backupAccountIds: [codex.id] }),
    /same provider/,
  );
  const bedrock = await store.addAccount({ provider: 'bedrock', alias: 'bedrock-peer', credential: { api_key: 'k' }, bedrock: { region: 'us-west-2', model_id: 'm' } });
  await assert.rejects(
    store.setAccountFailover(bedrock.id, { enabled: false, backupAccountIds: [] }),
    /Claude and Codex accounts only/,
  );
  await store.setAccountFailover(accounts.home.id, {
    enabled: true,
    backupAccountIds: [accounts.spare.id, accounts.backup.id, accounts.spare.id],
    actor: 'operator',
  });
  const stored = store.publicAccounts().find((entry) => entry.id === accounts.home.id).failover;
  assert.equal(stored.enabled, true);
  assert.deepEqual(stored.backup_account_ids, [accounts.spare.id, accounts.backup.id]);
  assert.ok(store.state.audit.some((entry) => entry.event === 'account_failover_updated' && entry.actor === 'operator'));
});

test('only an explicit rejected status counts as exhaustion', () => {
  assert.equal(claudeQuotaRejection(429, {}), null);
  assert.equal(claudeQuotaRejection(429, { 'anthropic-ratelimit-unified-status': 'allowed_warning' }), null);
  assert.equal(claudeQuotaRejection(200, exhaustedHeaders()), null);
  assert.deepEqual(claudeQuotaRejection(429, exhaustedHeaders('five_hour')), {
    claim: 'five_hour',
    resetsAtMs: RESET_SECONDS * 1000,
  });
});

test('a model-specific window does not disqualify a backup', () => {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(usageShowsExhausted({ windows: [{ kind: 'fable_weekly', remaining_percent: 0, resets_at: later }] }), false);
  assert.equal(usageShowsExhausted({ windows: [{ kind: 'weekly', remaining_percent: 0, resets_at: later }] }), true);
  const earlier = new Date(Date.now() - 1000).toISOString();
  assert.equal(usageShowsExhausted({ windows: [{ kind: 'weekly', remaining_percent: 0, resets_at: earlier }] }), false,
    'a window past its reset is not exhausted any more');
});

test('an unreadable failover record reads as off', () => {
  assert.deepEqual(normalizeAccountFailover({ enabled: 'yes', backup_account_ids: 'x' }), { enabled: false, backup_account_ids: [] });
  const store = { accountById: () => ({ id: 'b', provider: 'claude', status: 'healthy' }) };
  assert.equal(chooseFailoverAccount({ store, homeAccount: { id: 'a', provider: 'claude', failover: null } }), null);
});

test('the upstream quota headers reach the client so it can say when the limit resets', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet({ backups: [] });
  const { proxyUrl } = await harness(t, { store }, async (req, res) => {
    await readBody(req);
    res.writeHead(429, { ...exhaustedHeaders('seven_day'), 'x-internal-thing': 'not forwarded' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit reached' } }));
  });

  const response = await new Promise((resolve, reject) => {
    const request = http.request(new URL(`${proxyUrl}/claude/v1/messages`), {
      method: 'POST',
      headers: { 'X-Api-Key': deviceToken, 'Content-Type': 'application/json', 'Content-Length': PAYLOAD.length },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    request.once('error', reject);
    request.end(PAYLOAD);
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
  assert.equal(response.headers['anthropic-ratelimit-unified-representative-claim'], 'seven_day');
  assert.equal(response.headers['anthropic-ratelimit-unified-reset'], String(RESET_SECONDS));
  assert.equal(response.headers['x-internal-thing'], undefined, 'the allowlist still holds for everything else');
});
