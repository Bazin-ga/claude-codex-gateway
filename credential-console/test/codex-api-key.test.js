import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleCodexProxy } from '../lib/codex-proxy.js';
import { apiKeyAllowsModel, isCodexGatewayAccount, parseApiKeyModels } from '../lib/codex-api-key.js';
import { CredentialStore } from '../lib/store.js';
import { dashboardView } from '../lib/views.js';

const API_KEY = `sk-proj-${'a'.repeat(40)}`;

async function newStore(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-api-key-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, store: await new CredentialStore(home, { allowKeyInit: true }).init() };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('a Codex account can be registered with an OpenAI API key instead of a credential home', async (t) => {
  const { home, store } = await newStore(t);
  const account = await store.addAccount({ provider: 'codex', alias: 'openai-api-1', codexApiKey: API_KEY });
  assert.equal(account.codex_auth, 'api-key');
  assert.equal(account.status, 'stored');
  assert.equal(store.accountCredential(account.id).api_key, API_KEY);
  assert.equal((await readFile(join(home, 'state.json'), 'utf8')).includes(API_KEY), false, 'stored encrypted');
  const listed = store.publicAccounts().find((entry) => entry.id === account.id);
  assert.equal(listed.codex_auth, 'api-key');
  assert.equal(JSON.stringify(listed).includes(API_KEY), false);
  assert.ok(isCodexGatewayAccount(listed));

  // Usable straight away: members can be issued a device on it.
  const issued = await store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member',
    deviceName: 'laptop',
  });
  assert.equal(store.resolveDeviceAccount(issued.device.id).effective_account_id, account.id);

  await assert.rejects(
    store.addAccount({ provider: 'codex', alias: 'openai-api-2', codexApiKey: 'not-a-key' }),
    /valid OpenAI API key/,
  );
  await assert.rejects(
    store.addAccount({ provider: 'claude', alias: 'openai-api-3', codexApiKey: API_KEY }),
    /only meaningful for a Codex account/,
  );
  await assert.rejects(
    store.addAccount({
      provider: 'codex',
      alias: 'openai-api-4',
      codexApiKey: API_KEY,
      external: { kind: 'codex-credential', home: '/tmp/x' },
    }),
    /not both/,
  );
});

test('the dashboard offers an API-key account to members and never renders the key', async (t) => {
  const { store } = await newStore(t);
  const account = await store.addAccount({ provider: 'codex', alias: 'openai-api-1', codexApiKey: API_KEY });
  const html = dashboardView({
    accounts: store.publicAccounts(),
    devices: [],
    machines: [],
    codexClients: [],
    csrf: 'csrf-token',
    adminIdentity: 'admin@example.com',
    deviceGroups: [],
    codexApiKeyEnabled: true,
  });
  assert.equal(html.includes(API_KEY), false);
  assert.match(html, /data-i18n="codex-api-key-account"/);
  assert.equal(html.includes(`/accounts/${account.id}/codex-authorization`), false);
  assert.match(html, new RegExp(`<option value="${account.id}">openai-api-1`));
  assert.match(html, /name="openai_api_key" type="password"/);
});

test('requests on an API-key account go to the OpenAI API with the key, not to chatgpt.com', async (t) => {
  const { store } = await newStore(t);
  const account = await store.addAccount({ provider: 'codex', alias: 'openai-api-1', codexApiKey: API_KEY });
  const issued = await store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member',
    deviceName: 'laptop',
  });

  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    handleCodexProxy(req, res, {
      store,
      upstreamBaseUrl: `${upstreamUrl}/chatgpt-backend`,
      openaiApiBaseUrl: `${upstreamUrl}/v1`,
      credentialReader: () => { throw new Error('the credential home must not be read'); },
    }).catch(() => res.destroy());
  });
  const proxyUrl = await listen(proxy);
  // Same teardown as below: sockets and the store's late seen-write first.
  const shutdown = async () => {
    upstream.closeAllConnections?.();
    proxy.closeAllConnections?.();
    await Promise.all([proxy, upstream].map((server) => (server.listening
      ? new Promise((resolve) => server.close(resolve))
      : null)));
    await store.serialized(async () => {});
  };
  t.after(shutdown);

  const response = await fetch(`${proxyUrl}/codex-api/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'chatgpt-account-id': 'client-sent-this',
    },
    body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, store: false, input: [] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/responses');
  assert.equal(seen[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(seen[0].headers['chatgpt-account-id'], undefined);
  assert.equal(seen[0].headers['content-encoding'], undefined, 'the OpenAI API is sent the body as the client wrote it');
  await shutdown();
});

test('a console without the API-key switch neither shows the field nor accepts it', async (t) => {
  const { createCredentialConsole } = await import('../server.js');
  for (const codexApiKeyEnabled of [false, true]) {
    const { store } = await newStore(t);
    const created = await createCredentialConsole({
      store,
      adminAuth: 'open',
      cookieSecure: false,
      publicBaseUrl: 'http://console.test',
      codexApiKeyEnabled,
      usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
      codexManagedRefresher: false,
    });
    await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await new Promise((resolve) => created.server.close(resolve));
      await created.stop?.();
    });
    const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    assert.equal(html.includes('name="openai_api_key"'), codexApiKeyEnabled);
    assert.equal(html.includes('codex-api-key-optional'), codexApiKeyEnabled);
    const cookie = page.headers.getSetCookie()[0].split(';')[0];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const registered = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, provider: 'codex', alias: 'sneaked-in', openai_api_key: API_KEY }),
    });
    assert.equal(registered.status, 303);
    const added = store.publicAccounts().find((entry) => entry.alias === 'sneaked-in');
    if (codexApiKeyEnabled) {
      assert.equal(added?.codex_auth, 'api-key');
    } else {
      assert.match(decodeURIComponent(registered.headers.get('location')), /not enabled on this console/);
      assert.equal(added, undefined);
    }
  }
});

test('the guard on an API-key account is a plain on/off switch', async (t) => {
  const { store } = await newStore(t);
  const account = await store.addAccount({ provider: 'codex', alias: 'openai-api-1', codexApiKey: API_KEY });
  await store.setCodexModelGuard(account.id, { enabled: true, thresholdPercent: 10 });
  const html = dashboardView({
    accounts: store.publicAccounts(),
    devices: [],
    machines: [],
    codexClients: [],
    csrf: 'csrf-token',
    adminIdentity: 'admin@example.com',
    deviceGroups: [],
  });
  assert.match(html, /data-i18n="codex-api-guard-enable"/);
  assert.match(html, /data-i18n="codex-api-guard-active"/);
  assert.equal(html.includes(`/accounts/${account.id}/codex-credit-guard`), false);
});

test('the API-key model list is configurable and fails closed to Luna', () => {
  assert.deepEqual(parseApiKeyModels(undefined), ['luna']);
  assert.deepEqual(parseApiKeyModels(''), ['luna']);
  assert.deepEqual(parseApiKeyModels(' , ;; '), ['luna']);
  assert.deepEqual(parseApiKeyModels('luna, Terra,terra'), ['luna', 'terra']);
  assert.equal(apiKeyAllowsModel('gpt-6.1-terra', ['luna', 'terra']), true);
  assert.equal(apiKeyAllowsModel('gpt-6.1-sol', ['luna', 'terra']), false);
  assert.equal(apiKeyAllowsModel('gpt-6.1-terra'), false, 'the default still allows Luna only');
  assert.equal(apiKeyAllowsModel(null, ['luna', 'terra']), false);
});

test('a guarded API-key account takes exactly the configured model families', async (t) => {
  const { store } = await newStore(t);
  const account = await store.addAccount({ provider: 'codex', alias: 'openai-api-1', codexApiKey: API_KEY });
  await store.setCodexModelGuard(account.id, { enabled: true, thresholdPercent: 10 });
  const issued = await store.issueDeviceCredential({ accountId: account.id, memberLabel: 'member', deviceName: 'laptop' });
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body).model);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    });
  });
  const upstreamUrl = await listen(upstream);
  let apiKeyModels;
  const proxy = http.createServer((req, res) => {
    handleCodexProxy(req, res, {
      store,
      openaiApiBaseUrl: `${upstreamUrl}/v1`,
      credentialReader: () => { throw new Error('the credential home must not be read'); },
      ...(apiKeyModels ? { apiKeyModels } : {}),
    }).catch(() => res.destroy());
  });
  const proxyUrl = await listen(proxy);
  // The proxy marks the device seen after it answers, through the store's
  // serialized writer: wait for that and for every socket before the store
  // home is removed, or the cleanup races a late write.
  const shutdown = async () => {
    upstream.closeAllConnections?.();
    proxy.closeAllConnections?.();
    await Promise.all([proxy, upstream].map((server) => (server.listening
      ? new Promise((resolve) => server.close(resolve))
      : null)));
    await store.serialized(async () => {});
  };
  t.after(shutdown);
  const send = async (model) => {
    const response = await fetch(`${proxyUrl}/codex-api/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true, store: false, input: [] }),
    });
    return { status: response.status, text: await response.text() };
  };

  const before = await send('gpt-6.1-terra');
  assert.equal(before.status, 403, 'without configuration Terra is refused as before');
  assert.match(before.text, /only \\"luna\\" models|only "luna" models/);

  apiKeyModels = ['luna', 'terra'];
  assert.equal((await send('gpt-6.1-terra')).status, 200);
  assert.equal((await send('gpt-6-luna')).status, 200);
  const sol = await send('gpt-6.1-sol');
  assert.equal(sol.status, 403);
  assert.match(sol.text, /only \\"luna\\", \\"terra\\" models|only "luna", "terra" models/);
  assert.deepEqual(seen, ['gpt-6.1-terra', 'gpt-6-luna'], 'only allowed models reach the paid API');
  await shutdown();
});
