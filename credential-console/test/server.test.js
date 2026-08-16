import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function fixture({
  adminAuth = 'password',
  codex = {},
  claudeOauthExchange,
  usageSnapshot = () => null,
} = {}) {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamRequests.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'],
      deviceAuthorization: req.headers['x-device-authorization'],
      body,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'request-id': 'upstream-request' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamUrl = await listen(upstream);

  const home = await mkdtemp(join(tmpdir(), 'credential-console-server-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  await store.setAdminPassword('correct-horse-battery-staple');
  const usageMonitor = {
    snapshotForAccount: (accountId) => usageSnapshot(store.accountById(accountId)),
    refreshAccount: async (accountId) => usageSnapshot(store.accountById(accountId)),
    stop() {},
  };
  const { server } = await createCredentialConsole({
    store,
    usageMonitor,
    adminAuth,
    cookieSecure: false,
    publicBaseUrl: 'http://credential-console.test',
    claudeUpstreamBaseUrl: upstreamUrl,
    ...(claudeOauthExchange ? { claudeOauthExchange } : {}),
    ...codex,
  });
  const baseUrl = await listen(server);

  return {
    baseUrl,
    home,
    server,
    store,
    upstream,
    upstreamRequests,
    async close() {
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    },
  };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

function csrfFrom(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, 'csrf field should be present');
  return match[1];
}

test('tailnet identity mode removes password login and binds sessions to the user', async () => {
  const app = await fixture({
    adminAuth: 'tailscale',
    codex: { claudeGatewayUrl: 'https://public-gateway.example:10000/claude' },
    usageSnapshot: () => ({
      provider: 'claude',
      status: 'available',
      fetched_at: '2026-08-05T12:00:00.000Z',
      windows: [
        { kind: 'five_hour', remaining_percent: 75, resets_at: '2026-08-05T16:00:00.000Z' },
        { kind: 'weekly', remaining_percent: 60, resets_at: '2026-08-08T16:00:00.000Z' },
      ],
    }),
  });
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-self-service',
      credential: { oauth_token: 'self-service-master-token' },
    });
    const withoutIdentity = await fetch(`${app.baseUrl}/`, { redirect: 'manual' });
    assert.equal(withoutIdentity.status, 403);

    const first = await fetch(`${app.baseUrl}/`, {
      headers: { 'Tailscale-User-Login': 'admin@example.com' },
    });
    assert.equal(first.status, 200);
    const firstCookie = cookieFrom(first);
    const firstHtml = await first.text();
    assert.match(firstHtml, /Tailscale identity<\/span><br><strong>admin@example\.com<\/strong>/);
    assert.match(firstHtml, /Member self-service · This is exactly what every member sees/);
    assert.match(firstHtml, /Get Claude Code setup/);
    assert.match(firstHtml, /Remaining<\/span> 75%/);
    assert.match(firstHtml, /Remaining<\/span> 60%/);
    assert.equal(firstHtml.includes('Administrator password'), false);
    assert.equal(firstHtml.includes('Sign out'), false);

    const selfService = await fetch(`${app.baseUrl}/self-service`, {
      method: 'POST',
      headers: {
        Cookie: firstCookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Tailscale-User-Login': 'admin@example.com',
      },
      body: new URLSearchParams({
        csrf: csrfFrom(firstHtml),
        account_id: account.id,
        device_name: 'admin-macbook',
      }),
    });
    assert.equal(selfService.status, 200);
    const selfServiceHtml = await selfService.text();
    assert.match(selfServiceHtml, /Copy or download this configuration now/);
    assert.match(selfServiceHtml, /install-claude-claude-self-service-macos-linux\.sh/);
    assert.match(selfServiceHtml, /install-claude-claude-self-service-windows\.ps1/);
    assert.equal((selfServiceHtml.match(/data-download-target=/g) ?? []).length, 2);
    assert.match(selfServiceHtml, /chmod 600/);
    assert.match(selfServiceHtml, /Remove-Item -Force \$installer/);
    assert.match(selfServiceHtml, /ANTHROPIC_BASE_URL=&#39;https:\/\/public-gateway\.example:10000\/claude&#39;/);
    assert.equal(selfServiceHtml.includes('ANTHROPIC_BASE_URL=&#39;http://credential-console.test'), false);
    assert.equal(selfServiceHtml.includes('apiKeyHelper'), false);
    assert.match(selfServiceHtml, /claude-claude-self-service-api-key-helper/);
    assert.match(selfServiceHtml, /claude-gateway-api-key-helper/);
    assert.match(selfServiceHtml, /claude-gateway/);
    assert.match(selfServiceHtml, /export ANTHROPIC_DEFAULT_OPUS_MODEL=&#39;claude-opus-5&#39;/);
    assert.match(selfServiceHtml, /export CLAUDE_CODE_USE_GATEWAY=1/);
    assert.match(selfServiceHtml, /export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1/);
    assert.match(selfServiceHtml, /export ANTHROPIC_AUTH_TOKEN=&quot;\$\(cat/);
    assert.match(selfServiceHtml, /\$env:CLAUDE_CODE_USE_GATEWAY=&#39;1&#39;/);
    assert.match(selfServiceHtml, /\$env:ANTHROPIC_DEFAULT_OPUS_MODEL=&#39;claude-opus-5&#39;/);
    assert.match(selfServiceHtml, /\$env:CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=&#39;1&#39;/);
    assert.match(selfServiceHtml, /\$env:ANTHROPIC_AUTH_TOKEN = \[IO\.File\]::ReadAllText/);
    assert.equal(app.store.state.enrollments.length, 0);
    assert.equal(app.store.publicDevices()[0].member_label, 'admin@example.com');
    assert.equal(app.store.publicDevices()[0].name, 'admin-macbook');

    const passwordLogin = await fetch(`${app.baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Tailscale-User-Login': 'admin@example.com',
      },
      body: new URLSearchParams({ password: 'correct-horse-battery-staple' }),
    });
    assert.equal(passwordLogin.status, 404);

    const second = await fetch(`${app.baseUrl}/`, {
      headers: {
        Cookie: firstCookie,
        'Tailscale-User-Login': 'other@example.com',
      },
    });
    assert.equal(second.status, 200);
    assert.notEqual(cookieFrom(second), firstCookie);
    assert.match(await second.text(), /Tailscale identity<\/span><br><strong>other@example\.com<\/strong>/);
  } finally {
    await app.close();
  }
});

test('Claude owner authorization rejects a different account email before storing a token', async () => {
  const app = await fixture({
    adminAuth: 'tailscale',
    claudeOauthExchange: async () => ({
      accessToken: 'sk-ant-oat01-wrong-account-token',
      emailAddress: 'other@example.com',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }),
  });
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'expected-owner',
      emailLabel: 'owner@example.com',
    });
    const dashboardResponse = await fetch(`${app.baseUrl}/`, {
      headers: { 'Tailscale-User-Login': 'owner@example.com' },
    });
    const cookie = cookieFrom(dashboardResponse);
    const ownerPage = await fetch(
      `${app.baseUrl}/accounts/${account.id}/claude-authorization`,
      {
        headers: {
          Cookie: cookie,
          'Tailscale-User-Login': 'owner@example.com',
        },
      },
    );
    const ownerHtml = await ownerPage.text();
    const started = await fetch(
      `${app.baseUrl}/accounts/${account.id}/claude-authorization/start`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Tailscale-User-Login': 'owner@example.com',
        },
        body: new URLSearchParams({ csrf: csrfFrom(ownerHtml) }),
      },
    );
    const startedHtml = await started.text();
    const state = startedHtml.match(/state=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(state);
    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/claude-authorization/complete`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Tailscale-User-Login': 'owner@example.com',
        },
        body: new URLSearchParams({
          csrf: csrfFrom(startedHtml),
          authorization_code: `browser-code#${state}`,
        }),
      },
    );
    assert.equal(completed.status, 400);
    assert.match(await completed.text(), /authorized account email does not match owner@example\.com/);
    assert.equal(app.store.accountCredential(account.id), null);
    assert.equal(account.status, 'login_required');
  } finally {
    await app.close();
  }
});

test('tailnet members can self-enroll Codex once and choose any platform installer', async () => {
  const enrollmentRequests = [];
  const app = await fixture({
    adminAuth: 'tailscale',
    codex: {
      codexEndpoint: 'https://203.0.113.10:8443',
      codexCertPin: 'a'.repeat(64),
      codexEnrollmentKey: 'test-enrollment-key-long-enough',
      codexEnroll: async (request) => {
        enrollmentRequests.push(request);
        return { name: request.name, token: 'codex-device-token-shown-once' };
      },
    },
  });
  try {
    await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      external: { kind: 'codex-credential', home: '/missing-test-home' },
    });
    const dashboardResponse = await fetch(`${app.baseUrl}/`, {
      headers: { 'Tailscale-User-Login': 'member@example.com' },
    });
    assert.equal(dashboardResponse.status, 200);
    const cookie = cookieFrom(dashboardResponse);
    const dashboard = await dashboardResponse.text();
    assert.match(dashboard, /Get Codex installer/);
    assert.equal(dashboard.includes('name="platform"'), false);

    const enrollment = await fetch(`${app.baseUrl}/codex/self-service`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Tailscale-User-Login': 'member@example.com',
      },
      body: new URLSearchParams({
        csrf: csrfFrom(dashboard),
        device_name: 'team-laptop',
      }),
    });
    assert.equal(enrollment.status, 200);
    const html = await enrollment.text();
    assert.match(html, /install-codex-macos\.sh/);
    assert.match(html, /install-codex-linux\.sh/);
    assert.match(html, /install-codex-windows\.ps1/);
    assert.equal((html.match(/data-download-target=/g) ?? []).length, 3);
    assert.match(html, /Download installer/);
    assert.match(html, /codex-device-token-shown-once/);
    assert.match(html, /https:\/\/203\.0\.113\.10:8443/);
    assert.match(html, /FromBase64String/);
    assert.equal(html.includes('/codex-agent/'), false);
    assert.equal(html.includes('Invoke-WebRequest'), false);
    assert.match(html, /chmod 600/);
    assert.match(html, /Remove-Item -Force \$installer/);
    assert.equal(enrollmentRequests.length, 1);
    assert.match(enrollmentRequests[0].name, /^team-laptop-[a-f0-9]{10}$/);
    assert.equal(enrollmentRequests[0].enrollmentKey, 'test-enrollment-key-long-enough');

    const asset = await fetch(`${app.baseUrl}/codex-agent/pull.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /client-agent/);
  } finally {
    await app.close();
  }
});

test('admin can add account, issue enrollment, proxy traffic, and revoke one device', async () => {
  const masterToken = 'sk-ant-oat01-claude-master-token-visible-only-to-the-upstream';
  const oauthExchanges = [];
  const app = await fixture({
    claudeOauthExchange: async (request) => {
      oauthExchanges.push(request);
      return {
        accessToken: masterToken,
        emailAddress: 'owner@example.com',
        expiresAt: '2027-01-01T00:00:00.000Z',
      };
    },
  });
  try {
    const unauthenticated = await fetch(`${app.baseUrl}/`, { redirect: 'manual' });
    assert.equal(unauthenticated.status, 303);
    assert.equal(unauthenticated.headers.get('location'), '/login');

    const login = await fetch(`${app.baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'correct-horse-battery-staple' }),
    });
    assert.equal(login.status, 303);
    const cookie = cookieFrom(login);

    const dashboardResponse = await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } });
    const dashboard = await dashboardResponse.text();
    const csrf = csrfFrom(dashboard);

    const add = await fetch(`${app.baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrf,
        provider: 'claude',
        alias: 'claude-max-1',
        email_label: 'owner@example.com',
      }),
    });
    assert.equal(add.status, 303);
    const stateText = await readFile(join(app.home, 'state.json'), 'utf8');
    assert.equal(stateText.includes(masterToken), false);

    const account = app.store.state.accounts[0];
    assert.equal(account.status, 'login_required');
    const ownerPage = await fetch(
      `${app.baseUrl}/accounts/${account.id}/claude-authorization`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(ownerPage.status, 200);
    const ownerHtml = await ownerPage.text();
    assert.match(ownerHtml, /This control-page URL is permanent/);
    assert.match(ownerHtml, /owner@example\.com/);

    const startAuthorization = await fetch(
      `${app.baseUrl}/accounts/${account.id}/claude-authorization/start`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrf: csrfFrom(ownerHtml) }),
      },
    );
    assert.equal(startAuthorization.status, 200);
    const startHtml = await startAuthorization.text();
    assert.match(startHtml, /A fresh 15-minute authorization session is ready/);
    assert.match(startHtml, /login_hint=owner%40example\.com/);
    const oauthState = startHtml.match(/state=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(oauthState);

    const completeAuthorization = await fetch(
      `${app.baseUrl}/accounts/${account.id}/claude-authorization/complete`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrfFrom(startHtml),
          authorization_code: `browser-code#${oauthState}`,
        }),
      },
    );
    assert.equal(completeAuthorization.status, 200);
    assert.match(await completeAuthorization.text(), /Claude account authorized/);
    assert.equal(oauthExchanges.length, 1);
    assert.equal(oauthExchanges[0].code, 'browser-code');
    assert.equal(oauthExchanges[0].state, oauthState);
    assert.ok(oauthExchanges[0].verifier.length > 40);
    assert.equal(account.status, 'healthy');
    assert.deepEqual(app.store.accountCredential(account.id), { oauth_token: masterToken });
    assert.equal((await readFile(join(app.home, 'state.json'), 'utf8')).includes(masterToken), false);

    const refreshedDashboard = await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } });
    const refreshedHtml = await refreshedDashboard.text();
    const refreshedCsrf = csrfFrom(refreshedHtml);
    assert.equal(refreshedHtml.includes(masterToken), false);

    const enrollmentResponse = await fetch(
      `${app.baseUrl}/accounts/${account.id}/enrollments`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: refreshedCsrf,
          member_label: 'member@example.com',
        }),
      },
    );
    const enrollmentHtml = await enrollmentResponse.text();
    const code = enrollmentHtml.match(/\/enroll\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);

    const redeem = await fetch(`${app.baseUrl}/enroll/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ device_name: 'member-macbook' }),
    });
    const redeemHtml = await redeem.text();
    const deviceToken = redeemHtml.match(/printf &#39;%s&#39; &#39;([A-Za-z0-9_-]+)&#39;/)?.[1];
    assert.ok(deviceToken, 'one-time device configuration should contain the device token');
    assert.match(deviceToken, /^sk-ant-api03-[A-Za-z0-9_-]{43}$/);
    assert.equal(redeemHtml.includes(masterToken), false);

    const replay = await fetch(`${app.baseUrl}/enroll/${code}`);
    assert.equal(replay.status, 410);

    const apiHello = await fetch(`${app.baseUrl}/claude/api/hello`, { method: 'HEAD' });
    assert.equal(apiHello.status, 200);
    assert.equal(app.upstreamRequests.length, 0);

    const proxied = await fetch(`${app.baseUrl}/claude/v1/messages`, {
      method: 'POST',
      headers: {
        'X-Api-Key': deviceToken,
        'Content-Type': 'application/json',
        'Anthropic-Version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-test', messages: [] }),
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), { ok: true });
    assert.equal(app.upstreamRequests.length, 1);
    assert.equal(app.upstreamRequests[0].authorization, `Bearer ${masterToken}`);
    assert.equal(app.upstreamRequests[0].apiKey, undefined);
    assert.equal(app.upstreamRequests[0].url, '/v1/messages');

    const conflictingAuth = await fetch(`${app.baseUrl}/claude/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer a-different-device-token',
        'X-Api-Key': deviceToken,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(conflictingAuth.status, 401);
    assert.equal(app.upstreamRequests.length, 1);

    const device = app.store.publicDevices()[0];
    const currentDashboard = await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } });
    const currentCsrf = csrfFrom(await currentDashboard.text());
    const revoke = await fetch(`${app.baseUrl}/devices/${device.id}/revoke`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: currentCsrf }),
    });
    assert.equal(revoke.status, 303);

    const afterRevoke = await fetch(`${app.baseUrl}/claude/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(afterRevoke.status, 401);
    assert.equal(app.upstreamRequests.length, 1);
  } finally {
    await app.close();
  }
});

test('rejects CSRF bypass and unsupported gateway paths', async () => {
  const app = await fixture();
  try {
    const login = await fetch(`${app.baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'correct-horse-battery-staple' }),
    });
    const cookie = cookieFrom(login);

    const add = await fetch(`${app.baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrf: 'wrong',
        provider: 'claude',
        alias: 'should-not-exist',
        oauth_token: 'this-token-must-not-be-stored',
      }),
    });
    assert.equal(add.status, 403);
    assert.equal(app.store.publicAccounts().length, 0);

    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-max-1',
      credential: { oauth_token: 'master-token' },
    });
    const { code } = await app.store.createEnrollment({
      accountId: account.id,
      memberLabel: 'member',
    });
    const { token } = await app.store.redeemEnrollment({ code, deviceName: 'device' });

    const unsupported = await fetch(`${app.baseUrl}/claude/private/account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unsupported.status, 404);
    assert.equal(app.upstreamRequests.length, 0);
  } finally {
    await app.close();
  }
});

test('public Claude gateway rate-limits repeated authentication failures by source IP', async () => {
  const app = await fixture();
  try {
    let response;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      response = await fetch(`${app.baseUrl}/claude/v1/models`, {
        headers: {
          Authorization: 'Bearer invalid-device-token',
          'X-Forwarded-For': '203.0.113.81',
        },
      });
      if (attempt < 30) assert.equal(response.status, 401);
    }
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
  } finally {
    await app.close();
  }
});

test('fails closed before proxying an expired provider credential', async () => {
  const app = await fixture();
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'expired-claude',
      credential: { oauth_token: 'expired-master-token' },
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    const { code } = await app.store.createEnrollment({
      accountId: account.id,
      memberLabel: 'member',
    });
    const { token } = await app.store.redeemEnrollment({ code, deviceName: 'device' });

    const response = await fetch(`${app.baseUrl}/claude/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal(app.upstreamRequests.length, 0);
  } finally {
    await app.close();
  }
});
