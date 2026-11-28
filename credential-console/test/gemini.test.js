import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialConsole } from '../server.js';
import { CredentialStore } from '../lib/store.js';
import {
  GeminiTokenCache,
  createGeminiAuthorizationRequest,
  geminiPlanFrom,
  isTermsOfServiceBan,
} from '../lib/gemini-oauth.js';
import {
  geminiUsageSnapshot,
  parseGeminiPath,
  resolveGeminiModel,
  wrapGeminiRequest,
} from '../lib/gemini-proxy.js';
import { geminiUsageSnapshotFrom } from '../lib/usage.js';

const MODELS = [
  { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', remainingFraction: 0.8, resetTime: '2030-01-01T00:00:00Z' },
  { id: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)', remainingFraction: 0.8, resetTime: '2030-01-01T00:00:00Z' },
  { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', remainingFraction: 1, resetTime: null },
  { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', remainingFraction: 1, resetTime: null },
  { id: 'gemini-3-pro-image', displayName: 'Gemini 3 Pro Image', remainingFraction: 1, resetTime: null },
  { id: 'claude-sonnet-5-5-medium', displayName: 'Claude Sonnet 5.5', remainingFraction: 0, resetTime: '2030-01-01T00:00:00Z' },
];

test('the Gemini routes are the public Generative Language API paths', () => {
  assert.deepEqual(parseGeminiPath('/v1beta/models'), { kind: 'list', model: null, method: 'GET' });
  assert.deepEqual(parseGeminiPath('/v1beta/models/gemini-3.5-flash:streamGenerateContent'), {
    kind: 'streamGenerateContent', model: 'gemini-3.5-flash', method: 'POST',
  });
  assert.equal(parseGeminiPath('/v1beta/models/x:countTokens').kind, 'countTokens');
  assert.equal(parseGeminiPath('/v1beta/models/gemini-3.5-flash').kind, 'get');
  assert.equal(parseGeminiPath('/v1beta/models/x:embedContent'), null);
  assert.equal(parseGeminiPath('/v1internal:generateContent'), null);
});

test('a public model name is sent to the newest subscription model of its family', () => {
  assert.equal(resolveGeminiModel('gemini-3.5-flash', MODELS), 'gemini-3.5-flash');
  assert.equal(resolveGeminiModel('models/gemini-2.5-pro', MODELS), 'gemini-3.1-pro-high');
  assert.equal(resolveGeminiModel('gemini-3-pro-preview', MODELS), 'gemini-3.1-pro-high');
  assert.equal(resolveGeminiModel('gemini-2.5-flash', MODELS), 'gemini-3.5-flash');
  // No lite model on the account: lite falls back to flash.
  assert.equal(resolveGeminiModel('gemini-2.5-flash-lite', MODELS), 'gemini-3.5-flash');
  assert.equal(resolveGeminiModel('something-else', MODELS), 'something-else');
  assert.equal(resolveGeminiModel('gemini-2.5-pro', null), 'gemini-2.5-pro');
});

test('Gemini usage is metered with thinking as output and cached reads apart', () => {
  assert.deepEqual(geminiUsageSnapshot({
    promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 30,
  }), {
    inputTokens: 20,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: 100,
    outputTokens: 37,
    usageState: 'complete',
  });
  assert.equal(geminiUsageSnapshot(null).usageState, 'unavailable');
});

test('a request is wrapped in the Cloud Code envelope the Antigravity Hub sends', () => {
  const wrapped = wrapGeminiRequest({
    model: 'ignored',
    systemInstruction: { parts: [{ text: 'client system' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }] },
    ],
    generationConfig: { maxOutputTokens: 10 },
  }, { model: 'gemini-3.5-flash', projectId: 'proj-1', deviceId: 'dev-1' });
  assert.equal(wrapped.project, 'proj-1');
  assert.equal(wrapped.model, 'gemini-3.5-flash');
  assert.equal(wrapped.requestType, 'agent');
  assert.equal(wrapped.userAgent, 'antigravity');
  assert.match(wrapped.requestId, /^agent-[0-9a-f-]{36}$/);
  assert.equal('model' in wrapped.request, false);
  assert.equal(wrapped.request.systemInstruction.role, 'user');
  assert.match(wrapped.request.systemInstruction.parts[0].text, /^You are Antigravity/);
  assert.equal(wrapped.request.systemInstruction.parts[1].text, 'client system');
  // Only the first call of a parallel batch carries the signature.
  assert.equal(wrapped.request.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal('thoughtSignature' in wrapped.request.contents[1].parts[1], false);
  assert.match(wrapped.request.sessionId, /^-\d+$/);
  assert.deepEqual(wrapped.request.generationConfig, { maxOutputTokens: 10 });
});

test('the Google sign-in asks for offline access with PKCE against the Hub redirect', (t) => {
  assert.throws(() => createGeminiAuthorizationRequest(), /Gemini sign-in is not configured/);
  process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_ID = 'test-client.apps.example';
  process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_SECRET = 'test-secret';
  t.after(() => {
    delete process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_ID;
    delete process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_SECRET;
  });
  const request = createGeminiAuthorizationRequest({ emailLabel: 'owner@gmail.com' });
  assert.equal(new URL(request.url).searchParams.get('client_id'), 'test-client.apps.example');
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:51121/oauth-callback');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('login_hint'), 'owner@gmail.com');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(request.verifier).digest('base64url'));
  assert.match(url.searchParams.get('scope'), /cloud-platform/);
});

test('plan and suspension are read from Cloud Code answers', () => {
  assert.equal(geminiPlanFrom({ paidTier: { id: 'g1-ultra-tier' } }), 'ultra');
  assert.equal(geminiPlanFrom({ currentTier: { id: 'standard-tier' } }), 'pro');
  assert.equal(geminiPlanFrom({ currentTier: { id: 'free-tier' } }), 'free');
  assert.equal(isTermsOfServiceBan(403, 'This service has been disabled in this account for violation of Terms of Service.'), true);
  assert.equal(isTermsOfServiceBan(403, 'quota'), false);
});

test('the account card lists per-model quota for Gemini and Claude models, not image models', () => {
  const snapshot = geminiUsageSnapshotFrom(MODELS, 'ultra');
  assert.equal(snapshot.provider, 'gemini');
  assert.equal(snapshot.plan_type, 'ultra');
  assert.deepEqual(snapshot.windows.map((window) => window.model), [
    'claude-sonnet-5-5-medium', 'gemini-3-flash', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'gemini-3.5-flash',
  ]);
  assert.equal(snapshot.windows.find((window) => window.model === 'gemini-3.1-pro-high').remaining_percent, 80);
  assert.equal(snapshot.windows.find((window) => window.model === 'claude-sonnet-5-5-medium').remaining_percent, 0);
});

test('access tokens are minted once and reused until five minutes before expiry', async () => {
  let now = 1_000_000;
  let mints = 0;
  const cache = new GeminiTokenCache({
    store: { accountCredential: () => ({ refresh_token: 'rt', project_id: 'proj' }) },
    now: () => now,
    refresh: async () => {
      mints += 1;
      return { accessToken: `at-${mints}`, expiresAtMs: now + 3600_000 };
    },
  });
  const [first, second] = await Promise.all([cache.credentialFor('a'), cache.credentialFor('a')]);
  assert.deepEqual(first, { accessToken: 'at-1', projectId: 'proj' });
  assert.equal(second.accessToken, 'at-1');
  now += 56 * 60_000;
  assert.equal((await cache.credentialFor('a')).accessToken, 'at-2');
  assert.equal(mints, 2);
});

/** A fake Cloud Code backend: enough of it to answer what the console sends. */
function fakeGoogle() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: target, headers: init.headers ?? {}, body });
    if (target.includes('manifest')) return new Response('version: 2.40.0\n');
    if (target.endsWith(':fetchAvailableModels')) {
      return Response.json({ models: Object.fromEntries(MODELS.map((model) => [model.id, {
        displayName: model.displayName,
        quotaInfo: { remainingFraction: model.remainingFraction, resetTime: model.resetTime ?? undefined },
      }])) });
    }
    if (target.endsWith(':generateContent')) {
      if (body.request.contents[0].parts[0].text === 'banned') {
        return Response.json({ error: { code: 403, message: 'This service has been disabled in this account for violation of Terms of Service.', status: 'PERMISSION_DENIED' } }, { status: 403 });
      }
      return Response.json({
        response: {
          candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2, thoughtsTokenCount: 3 },
          modelVersion: body.model,
        },
        traceId: 'trace-1',
      });
    }
    if (target.includes(':streamGenerateContent')) {
      const events = [
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'hel' }] } }] }, traceId: 't' },
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } }, traceId: 't' },
      ];
      const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
      // Split mid-event, as a real stream may.
      const bytes = new TextEncoder().encode(text);
      const cut = Math.floor(bytes.length / 3);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (target.endsWith(':countTokens')) return Response.json({ error: { code: 404 } }, { status: 404 });
    throw new Error(`unexpected fetch ${target}`);
  };
  return { calls, fetchImpl };
}

async function geminiConsole(t, { openMode = true } = {}) {
  process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_ID = 'test-client.apps.example';
  process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_SECRET = 'test-secret';
  t.after(() => {
    delete process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_ID;
    delete process.env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_SECRET;
  });
  const home = await mkdtemp(join(tmpdir(), 'gemini-console-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const google = fakeGoogle();
  const metrics = [];
  const tokens = {
    async credentialFor() { return { accessToken: 'upstream-access-token', projectId: 'proj-1' }; },
    forget() {},
  };
  const { server } = await createCredentialConsole({
    store,
    home,
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
    requestMetrics: { enqueueRequest: (row) => metrics.push(row), stats: {} },
    metricsQueryService: false,
    adminAuth: openMode ? 'open' : 'tailscale',
    cookieSecure: false,
    publicBaseUrl: 'http://credential-console.test',
    geminiFetchImpl: google.fetchImpl,
    geminiUpstreamBaseUrl: 'https://cloudcode.test',
    geminiTokens: tokens,
    geminiOauthExchange: async ({ code, verifier }) => {
      assert.equal(code, 'google-code');
      assert.ok(verifier);
      return { refreshToken: 'google-refresh-token', accessToken: 'fresh-access', expiresAtMs: Date.now() + 3600_000 };
    },
    geminiUserEmail: async () => 'owner@gmail.com',
    geminiDiscoverProject: async () => ({ projectId: 'proj-1', plan: 'ultra' }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return { baseUrl, store, google, metrics, home };
}

test('a Gemini account is registered, signed in, issued to a device and carries turns', async (t) => {
  const app = await geminiConsole(t);
  const first = await fetch(`${app.baseUrl}/`);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const firstHtml = await first.text();
  const csrf = firstHtml.match(/name="csrf" value="([^"]+)"/)[1];
  // The card is on the home page beside Claude and Codex before any account exists.
  assert.match(firstHtml, /<h2>Gemini<\/h2>/);
  assert.match(firstHtml, /Add a Gemini \(Google AI Pro \/ Ultra\) account/);
  const form = (fields) => ({
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, ...fields }),
  });

  const added = await fetch(`${app.baseUrl}/accounts`, form({ provider: 'gemini', alias: 'gemini-ultra-1', email_label: 'owner@gmail.com' }));
  assert.equal(added.status, 303);
  const account = app.store.state.accounts[0];
  assert.equal(account.provider, 'gemini');
  assert.equal(account.status, 'login_required');

  const started = await fetch(`${app.baseUrl}/accounts/${account.id}/gemini-authorization/start`, form({}));
  assert.equal(started.status, 200);
  const startedHtml = await started.text();
  const authorizeUrl = new URL(startedHtml.match(/href="(https:\/\/accounts\.google\.com[^"]+)"/)[1].replaceAll('&amp;', '&'));
  const state = authorizeUrl.searchParams.get('state');
  assert.match(startedHtml, /Google may suspend|suspended accounts/);

  const completed = await fetch(`${app.baseUrl}/accounts/${account.id}/gemini-authorization/complete`, form({
    authorization_code: `http://localhost:51121/oauth-callback?state=${state}&code=google-code&scope=x`,
  }));
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal(account.status, 'healthy');
  assert.deepEqual(app.store.accountCredential(account.id), { refresh_token: 'google-refresh-token', project_id: 'proj-1' });
  assert.deepEqual(account.gemini, { plan: 'ultra' });
  const persisted = await readFile(join(app.home, 'state.json'), 'utf8');
  assert.equal(persisted.includes('google-refresh-token'), false);

  const dashboard = await (await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } })).text();
  assert.match(dashboard, /Get Gemini setup/);
  const issued = await fetch(`${app.baseUrl}/self-service`, form({ account_id: account.id, device_name: 'laptop', member_label: 'member' }));
  assert.equal(issued.status, 200);
  const issuedHtml = await issued.text();
  assert.match(issuedHtml, /GOOGLE_GEMINI_BASE_URL=&#39;http:\/\/credential-console\.test\/gemini&#39;/);
  assert.match(issuedHtml, /&quot;extends&quot;: &quot;acp&quot;/);
  const token = issuedHtml.match(/GEMINI_API_KEY=&#39;([^&]+)&#39;/)[1];

  // Non-streaming turn: wrapped on the way in, unwrapped on the way out.
  const turn = await fetch(`${app.baseUrl}/gemini/v1beta/models/gemini-2.5-pro:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });
  assert.equal(turn.status, 200);
  const answer = await turn.json();
  assert.equal(answer.candidates[0].content.parts[0].text, 'hello');
  assert.equal(answer.modelVersion, 'gemini-3.1-pro-high');
  const sent = app.google.calls.find((call) => call.url === 'https://cloudcode.test/v1internal:generateContent');
  assert.equal(sent.headers.Authorization, 'Bearer upstream-access-token');
  assert.equal(sent.headers['User-Agent'], 'antigravity/hub/2.40.0 (aidev_client; os_type=darwin; arch=arm64)');
  assert.equal(sent.body.project, 'proj-1');
  assert.equal(sent.body.model, 'gemini-3.1-pro-high');
  assert.equal(JSON.stringify(sent).includes(token), false);
  const row = app.metrics.at(-1);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.model, 'gemini-3.1-pro-high');
  assert.equal(row.inputTokens, 11);
  assert.equal(row.outputTokens, 5);

  // Streaming turn, keyed by ?key= as REST examples do.
  const streamed = await fetch(`${app.baseUrl}/gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });
  assert.equal(streamed.status, 200);
  const sse = await streamed.text();
  const events = sse.split('\r\n\r\n').filter(Boolean).map((event) => JSON.parse(event.replace(/^data: /, '')));
  assert.deepEqual(events.map((event) => event.candidates[0].content.parts[0].text), ['hel', 'lo']);
  assert.equal('response' in events[0], false);
  assert.equal(app.metrics.at(-1).stream, true);
  assert.equal(app.metrics.at(-1).outputTokens, 4);

  // Model list in the public shape; countTokens estimated when refused upstream.
  const listed = await (await fetch(`${app.baseUrl}/gemini/v1beta/models`, { headers: { 'x-goog-api-key': token } })).json();
  assert.ok(listed.models.some((model) => model.name === 'models/gemini-3.5-flash'));
  const counted = await (await fetch(`${app.baseUrl}/gemini/v1beta/models/gemini-3.5-flash:countTokens`, {
    method: 'POST',
    headers: { 'x-goog-api-key': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello there' }] }] }),
  })).json();
  assert.ok(counted.totalTokens > 0);

  // A suspension upstream marks the account on the card.
  const banned = await fetch(`${app.baseUrl}/gemini/v1beta/models/gemini-3.5-flash:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'banned' }] }] }),
  });
  assert.equal(banned.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(account.status, 'unhealthy');
  assert.match(account.last_failure, /terms of service/);
});

test('the Gemini route refuses an unknown key and a token for another provider', async (t) => {
  const app = await geminiConsole(t);
  const unknown = await fetch(`${app.baseUrl}/gemini/v1beta/models/gemini-3.5-flash:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': 'nope', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error.status, 'UNAUTHENTICATED');

  const claude = await app.store.addAccount({ provider: 'claude', alias: 'claude-1', emailLabel: 'a@b.co', credential: { oauth_token: 'sk-ant-oat01-x' } });
  const issued = await app.store.issueDeviceCredential({ accountId: claude.id, memberLabel: 'm', deviceName: 'd' });
  const wrongProvider = await fetch(`${app.baseUrl}/gemini/v1beta/models/gemini-3.5-flash:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': issued.token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrongProvider.status, 403);
  assert.equal(app.google.calls.filter((call) => call.url.includes('GenerateContent') || call.url.includes('generateContent')).length, 0);
});

test('a signed-in Gemini email that does not match the registered one is refused before anything is stored', async (t) => {
  const app = await geminiConsole(t);
  const first = await fetch(`${app.baseUrl}/`);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const csrf = (await first.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const form = (fields) => ({
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, ...fields }),
  });
  await fetch(`${app.baseUrl}/accounts`, form({ provider: 'gemini', alias: 'gemini-2', email_label: 'someone-else@gmail.com' }));
  const account = app.store.state.accounts[0];
  const started = await (await fetch(`${app.baseUrl}/accounts/${account.id}/gemini-authorization/start`, form({}))).text();
  const state = new URL(started.match(/href="(https:\/\/accounts\.google\.com[^"]+)"/)[1].replaceAll('&amp;', '&')).searchParams.get('state');
  const completed = await fetch(`${app.baseUrl}/accounts/${account.id}/gemini-authorization/complete`, form({
    authorization_code: `http://localhost:51121/oauth-callback?state=${state}&code=google-code`,
  }));
  assert.equal(completed.status, 400);
  assert.match(await completed.text(), /does not match someone-else@gmail\.com/);
  assert.equal(app.store.accountCredential(account.id), null);
  assert.equal(account.status, 'login_required');
});
