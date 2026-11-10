import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { parseRelayRoutes } from '../lib/relay-proxy.js';
import { relayBaseUrl, relayCatalogFromPricing, relayCostUsd } from '../lib/relay.js';
import { withRelayTab } from '../lib/views.js';

const PLATFORM_KEY = 'sk-relay-platform-key-0123456789';
const SSE_MESSAGES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

async function newStore(t) {
  const home = await mkdtemp(join(tmpdir(), 'relay-'));
  // A late seen-write from the proxy can land while the home is being removed; retry then.
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { home, store: await new CredentialStore(home, { allowKeyInit: true }).init() };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return { raw: Buffer.concat(chunks), json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
}

test('the price list is read as dollars per million at the cheapest offered group', () => {
  const rows = relayCatalogFromPricing({
    group_ratio: "{'vip': 0.147473, 'default': 1, 'test-z': 0.01}",
    vendors: [{ id: 1, name: 'DeepSeek' }],
    data: [
      { model_name: 'deepseek-v4-flash', vendor_id: 1, quota_type: 0, model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.02, enable_groups: ['vip', 'test-z'], supported_endpoint_types: ['openai'] },
      { model_name: 'unpriced', quota_type: 0, model_ratio: 37.5, completion_ratio: 1, enable_groups: ['default'], supported_endpoint_types: ['openai'] },
      { model_name: 'image-gen', quota_type: 1, model_price: 0.1, enable_groups: ['vip'], supported_endpoint_types: [] },
    ],
  });
  const flash = rows.find((row) => row.model === 'deepseek-v4-flash');
  assert.equal(flash.group, 'vip', 'an operator-only test group is never the quoted one');
  assert.ok(Math.abs(flash.input_usd_per_m - 0.147473) < 1e-9);
  assert.ok(Math.abs(flash.output_usd_per_m - 0.294946) < 1e-9);
  assert.equal(flash.placeholder, false);
  assert.equal(rows.find((row) => row.model === 'unpriced').placeholder, true);
  const image = rows.find((row) => row.model === 'image-gen');
  assert.equal(image.input_usd_per_m, null);
  assert.ok(Math.abs(image.per_call_usd - 0.0147473) < 1e-9);
  assert.ok(Math.abs(relayCostUsd(flash, { inputTokens: 1e6, outputTokens: 1e6 }) - 0.442419) < 1e-6);
});

test('a platform address is kept as its root, without /v1', () => {
  assert.equal(relayBaseUrl('http://1.2.3.4:3888/v1'), 'http://1.2.3.4:3888');
  assert.equal(relayBaseUrl('https://example.com/api/v1/'), 'https://example.com/api');
  assert.equal(relayBaseUrl('ftp://example.com'), null);
  assert.equal(relayBaseUrl('https://user:pass@example.com'), null);
});

test('the platform key is stored encrypted and the allow-list is audited', async (t) => {
  const { home, store } = await newStore(t);
  await assert.rejects(store.setRelayModelAllowed({ model: 'deepseek-v4-flash', allowed: true }), /configure the platform first/);
  await store.setRelayPlatform({ name: 'boyue', baseUrl: 'http://1.2.3.4:3888/v1', apiKey: PLATFORM_KEY, actor: 'ops' });
  assert.equal((await readFile(join(home, 'state.json'), 'utf8')).includes(PLATFORM_KEY), false);
  assert.equal(store.relayApiKey(), PLATFORM_KEY);
  await store.setRelayPlatform({ name: 'boyue', baseUrl: 'https://relay.example/v1', apiKey: '', actor: 'ops' });
  assert.equal(store.relayApiKey(), PLATFORM_KEY, 'an empty key keeps the stored one');
  await store.setRelayModelAllowed({ model: 'deepseek-v4-flash', allowed: true, actor: 'ops' });
  assert.deepEqual(store.relaySettings().allowed_models, ['deepseek-v4-flash']);
  assert.equal(JSON.stringify(store.relaySettings()).includes(PLATFORM_KEY), false);
  await store.setRelayModelAllowed({ model: 'deepseek-v4-flash', allowed: false, actor: 'ops' });
  assert.deepEqual(store.relaySettings().allowed_models, []);
  assert.equal(store.state.audit.at(-1).event, 'relay_model_disallowed');
});

test('the tab is added once, and marked current only on the relay page', () => {
  const page = '<nav><a href="/" data-tab="overview">x</a><a href="/docs" data-i18n="tab-docs" data-tab="docs">Docs</a></nav>';
  const once = withRelayTab(page);
  assert.match(once, /data-tab="relay"/);
  assert.equal(withRelayTab(once), once);
  assert.equal(once.includes('aria-current'), false);
  assert.match(withRelayTab(`${page}<section data-relay-page>`), /href="\/relay"[^>]*aria-current="page"/);
});

async function relayConsole(t, { relayEnabled = true, routeModel = null, routes = null } = {}) {
  const { store } = await newStore(t);
  const seen = { platform: [], claude: [], codex: [], route: [] };
  const platform = http.createServer(async (req, res) => {
    const body = await readJson(req);
    seen.platform.push({ url: req.url, headers: req.headers, body: body.json });
    if (req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_MESSAGES);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  const anthropic = http.createServer(async (req, res) => {
    const body = await readJson(req);
    seen.claude.push({ url: req.url, raw: body.raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  // A self-hosted endpoint reached through a fixed route, not the platform.
  const routeServer = http.createServer(async (req, res) => {
    const body = await readJson(req);
    seen.route.push({ url: req.url, headers: req.headers, body: body.json });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE_MESSAGES);
  });
  const [platformUrl, anthropicUrl, routeUrl] = await Promise.all([listen(platform), listen(anthropic), listen(routeServer)]);
  const claude = await store.addAccount({ provider: 'claude', alias: 'claude-1', emailLabel: 'o@example.com', credential: { oauth_token: 'sk-ant-oat01-real' } });
  const issued = await store.issueDeviceCredential({ accountId: claude.id, memberLabel: 'm', deviceName: 'laptop' });
  await store.setRelayPlatform({ name: 'boyue', baseUrl: `${platformUrl}/v1`, apiKey: PLATFORM_KEY });
  await store.setRelayModelAllowed({ model: 'deepseek-v4-flash', allowed: true });
  const metrics = [];
  const { createCredentialConsole } = await import('../server.js');
  const created = await createCredentialConsole({
    store,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    relayEnabled,
    ...(routeModel ? { relayRoutes: new Map([[routeModel, { base_url: routeUrl, alias: 'direct' }]]) } : {}),
    // Or the deployment's own `CREDENTIAL_CONSOLE_RELAY_ROUTES` value, given the route server's address.
    ...(routes ? { relayRoutes: parseRelayRoutes(routes(routeUrl)) } : {}),
    relayCatalog: { snapshot: () => ({ rows: [], balance: null, fetched_at: null, error: null }), row: () => null, refresh: async () => {}, stop() {} },
    claudeUpstreamBaseUrl: anthropicUrl,
    requestMetrics: { enqueueRequest: (row) => { metrics.push(row); } },
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  let closed = null;
  // Sockets first, then the servers, then the store's serialized writer, so
  // nothing is still writing into the store home when it is removed.
  const shutdown = () => closed ??= (async () => {
    created.server.closeAllConnections?.();
    platform.closeAllConnections?.();
    anthropic.closeAllConnections?.();
    routeServer.closeAllConnections?.();
    await Promise.all([created.server, platform, anthropic, routeServer].map((server) => (server.listening
      ? new Promise((resolve) => server.close(resolve))
      : null)));
    await created.stop?.();
    await store.serialized(async () => {});
  })();
  t.after(shutdown);
  return { baseUrl, token: issued.token, seen, metrics, store, shutdown };
}

function postJson(url, token, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('a Claude turn naming an allowed model goes to the platform; any other goes to the account untouched', { timeout: 20_000 }, async (t) => {
  const { baseUrl, token, seen, metrics } = await relayConsole(t);

  const relayed = await postJson(`${baseUrl}/claude/v1/messages`, token, { model: 'deepseek-v4-flash', max_tokens: 10, stream: true, messages: [] }, { 'anthropic-version': '2023-06-01' });
  assert.equal(relayed.status, 200);
  assert.equal(await relayed.text(), SSE_MESSAGES);
  assert.equal(seen.platform.length, 1);
  assert.equal(seen.platform[0].url, '/v1/messages');
  assert.equal(seen.platform[0].headers.authorization, `Bearer ${PLATFORM_KEY}`);
  assert.equal(seen.platform[0].headers['x-api-key'], PLATFORM_KEY);
  assert.equal(seen.claude.length, 0, 'the account never saw it');
  const row = metrics.find((entry) => entry.accountId === 'relay');
  assert.equal(row.model, 'deepseek-v4-flash');
  assert.equal(row.inputTokens, 11);
  assert.equal(row.outputTokens, 7);

  // The bytes read to find the model go back in front, so the account gets
  // exactly what the client sent.
  const body = `{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":"${'x'.repeat(200_000)}"}]}`;
  const direct = await postJson(`${baseUrl}/claude/v1/messages`, token, body);
  assert.equal(direct.status, 200);
  await direct.text();
  assert.equal(seen.claude.length, 1);
  assert.equal(seen.claude[0].raw.toString('utf8'), body);
  assert.equal(seen.platform.length, 1);
});

test('the direct route serves scripts and refuses anything off the allow-list', { timeout: 20_000 }, async (t) => {
  const { baseUrl, token, seen, metrics } = await relayConsole(t);
  const models = await fetch(`${baseUrl}/relay/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual((await models.json()).data.map((entry) => entry.id), ['deepseek-v4-flash']);

  const ok = await postJson(`${baseUrl}/relay/v1/chat/completions`, token, { model: 'deepseek-v4-flash', messages: [] });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).choices[0].message.content, 'hi');
  assert.equal(seen.platform.at(-1).url, '/v1/chat/completions');
  assert.equal(metrics.at(-1).inputTokens, 5);

  const other = await postJson(`${baseUrl}/relay/v1/chat/completions`, token, { model: 'kimi-k3', messages: [] });
  assert.equal(other.status, 403);
  // Named allowed first and something else last: the platform would run the last.
  const smuggled = await postJson(`${baseUrl}/relay/v1/chat/completions`, token, '{"model":"deepseek-v4-flash","messages":[],"model":"opus-5"}');
  assert.equal(smuggled.status, 403);
  assert.equal(seen.platform.length, 1);

  const anonymous = await fetch(`${baseUrl}/relay/v1/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(anonymous.status, 401);
});

test('a console without the relay switch has no tab, no page and no route', { timeout: 20_000 }, async (t) => {
  const { baseUrl, token, seen } = await relayConsole(t, { relayEnabled: false });
  const page = await (await fetch(`${baseUrl}/`)).text();
  assert.equal(page.includes('data-tab="relay"'), false);
  assert.equal((await fetch(`${baseUrl}/relay`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/relay/v1/models`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  const turn = await postJson(`${baseUrl}/claude/v1/messages`, token, { model: 'deepseek-v4-flash', messages: [] });
  await turn.text();
  assert.equal(seen.platform.length, 0, 'the stored allow-list is inert');
  assert.equal(seen.claude.length, 1);
});

test('the relay page renders the allow-list, usage and catalog, and changes are CSRF-protected', { timeout: 20_000 }, async (t) => {
  const { baseUrl, store } = await relayConsole(t);
  const response = await fetch(`${baseUrl}/relay`);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  const html = await response.text();
  assert.match(html, /data-tab="relay"[^>]*>|href="\/relay"/);
  assert.match(html, /claude --model deepseek-v4-flash/);
  assert.match(html, /codex -m deepseek-v4-flash/);
  assert.match(html, /http:\/\/console\.test\/relay\/v1/);
  assert.match(html, /data-i18n="relay-plaintext"/);
  assert.equal(html.includes(PLATFORM_KEY), false);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const post = (body) => fetch(`${baseUrl}/relay/models`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  assert.equal((await post({ model: 'kimi-k3', op: 'allow' })).status, 403);
  assert.equal((await post({ csrf, model: 'kimi-k3', op: 'allow' })).status, 303);
  assert.deepEqual(store.relaySettings().allowed_models, ['deepseek-v4-flash', 'kimi-k3']);
});

test('relay routes parse model=url entries and skip malformed ones', () => {
  const routes = parseRelayRoutes(' DeepSeek-V4.1-Flash=http://127.0.0.1:18540/v1 ; bad name=http://x , =http://y, ok=ftp://z, qwen=https://h.example/');
  assert.deepEqual([...routes.keys()], ['DeepSeek-V4.1-Flash', 'qwen']);
  assert.equal(routes.get('DeepSeek-V4.1-Flash').base_url, 'http://127.0.0.1:18540');
  assert.equal(routes.get('qwen').base_url, 'https://h.example');
  assert.equal(parseRelayRoutes(undefined).size, 0);
  const renamed = parseRelayRoutes('DeepSeek-V4.1-Flash=deepseek-v4-flash\nlocal=http://127.0.0.1:1/');
  assert.deepEqual(renamed.get('DeepSeek-V4.1-Flash'), { model: 'deepseek-v4-flash' });
  assert.equal(renamed.get('local').base_url, 'http://127.0.0.1:1');
  assert.equal(parseRelayRoutes('a=http:127.0.0.1:1').get('a').base_url, 'http://127.0.0.1:1', 'still an address, as before');
});

test('a route naming another model sends the turn on as that model, and only while that model is allowed', { timeout: 20_000 }, async (t) => {
  const { baseUrl, token, seen, metrics, store } = await relayConsole(t, {
    routes: (routeUrl) => `DeepSeek-V4.1-Flash=deepseek-v4-flash; qwen-local=qwen-selfhosted; qwen-selfhosted=${routeUrl}; loop=loop; chain=DeepSeek-V4.1-Flash; off=kimi-k3`,
  });

  const turn = { model: 'DeepSeek-V4.1-Flash', max_tokens: 10, stream: true, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: '中文 ✓ "quoted"' }] };
  const renamed = await postJson(`${baseUrl}/claude/v1/messages`, token, turn, { 'anthropic-version': '2023-06-01' });
  assert.equal(renamed.status, 200);
  assert.equal(await renamed.text(), SSE_MESSAGES);
  assert.equal(seen.platform.length, 1);
  assert.equal(seen.platform[0].url, '/v1/messages');
  assert.deepEqual(seen.platform[0].body, { ...turn, model: 'deepseek-v4-flash' }, 'only the model changes');
  assert.equal(seen.platform[0].headers.authorization, `Bearer ${PLATFORM_KEY}`);
  assert.equal(seen.claude.length, 0);
  assert.equal(seen.route.length, 0);
  const row = metrics.at(-1);
  assert.equal(row.model, 'deepseek-v4-flash', 'recorded as the model the platform ran and bills');
  assert.equal(row.accountAlias, 'relay:boyue');
  assert.equal(row.inputTokens, 11);

  // To a self-hosted route: renamed too, and still without the platform key.
  const local = await postJson(`${baseUrl}/relay/v1/messages`, token, { model: 'qwen-local', max_tokens: 10, stream: true, messages: [] });
  assert.equal(local.status, 200);
  await local.text();
  assert.equal(seen.route.length, 1);
  assert.equal(seen.route[0].body.model, 'qwen-selfhosted');
  assert.equal(seen.route[0].headers.authorization, undefined);
  assert.equal(metrics.at(-1).accountAlias, 'relay:direct');

  // One hop only, and never onto a model the platform does not allow.
  for (const model of ['loop', 'chain', 'off']) {
    const refused = await postJson(`${baseUrl}/relay/v1/chat/completions`, token, { model, messages: [] });
    assert.equal(refused.status, 403, model);
  }
  assert.equal(seen.platform.length, 1);
  const models = await fetch(`${baseUrl}/relay/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual((await models.json()).data.map((entry) => [entry.id, entry.owned_by]), [
    ['deepseek-v4-flash', 'boyue'],
    ['DeepSeek-V4.1-Flash', 'boyue'],
    ['qwen-local', 'direct'],
    ['qwen-selfhosted', 'direct'],
  ]);

  // Taken off the platform's allow-list, the model is no longer the relay's
  // under its other name either: the turn carries on to the account.
  await store.setRelayModelAllowed({ model: 'deepseek-v4-flash', allowed: false });
  const after = await postJson(`${baseUrl}/claude/v1/messages`, token, { model: 'DeepSeek-V4.1-Flash', max_tokens: 10, messages: [] });
  assert.equal(after.status, 200);
  await after.text();
  assert.equal(seen.platform.length, 1);
  assert.equal(seen.claude.length, 1);
});

test('a routed model goes to its own endpoint without the platform key; the platform and accounts are untouched', { timeout: 20_000 }, async (t) => {
  const { baseUrl, token, seen, metrics, shutdown } = await relayConsole(t, { routeModel: 'DeepSeek-V4.1-Flash' });

  const routed = await postJson(`${baseUrl}/claude/v1/messages`, token, { model: 'DeepSeek-V4.1-Flash', max_tokens: 10, stream: true, messages: [] }, { 'anthropic-version': '2023-06-01' });
  assert.equal(routed.status, 200);
  assert.equal(await routed.text(), SSE_MESSAGES);
  assert.equal(seen.route.length, 1);
  assert.equal(seen.route[0].url, '/v1/messages');
  assert.equal(seen.route[0].headers.authorization, undefined, 'the platform key never leaves for a routed endpoint');
  assert.equal(seen.route[0].headers['x-api-key'], undefined);
  assert.equal(seen.platform.length, 0);
  assert.equal(seen.claude.length, 0);
  const row = metrics.find((entry) => entry.model === 'DeepSeek-V4.1-Flash');
  assert.equal(row.accountAlias, 'relay:direct');
  assert.equal(row.inputTokens, 11);

  const platformTurn = await postJson(`${baseUrl}/claude/v1/messages`, token, { model: 'deepseek-v4-flash', max_tokens: 10, stream: true, messages: [] }, { 'anthropic-version': '2023-06-01' });
  assert.equal(platformTurn.status, 200);
  await platformTurn.text();
  assert.equal(seen.platform.length, 1);
  assert.equal(seen.platform[0].headers.authorization, `Bearer ${PLATFORM_KEY}`);

  const account = await postJson(`${baseUrl}/claude/v1/messages`, token, { model: 'claude-opus-5-5', max_tokens: 10, messages: [] });
  assert.equal(account.status, 200);
  await account.text();
  assert.equal(seen.claude.length, 1);
  assert.equal(seen.route.length, 1);

  const models = await fetch(`${baseUrl}/relay/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual((await models.json()).data.map((entry) => entry.id), ['deepseek-v4-flash', 'DeepSeek-V4.1-Flash']);
  await shutdown();
});
