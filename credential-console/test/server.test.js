import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { CredentialStore } from '../lib/store.js';
import { CredentialStore as CodexCredentialStore } from '../../codex-credential/refresh-center/lib/credential-store.js';
import { CODEX_AGENT_ASSETS, createCredentialConsole } from '../server.js';
import { syntheticCodexTokens } from './codex-token-fixture.js';

const execFileAsync = promisify(execFile);

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// Mirrors the shipped default, so the bulk of the suite exercises the fail-closed mode.
async function fixture({
  adminAuth = 'tailscale',
  codex = {},
  claudeOauthExchange,
  cookieSecure = false,
  maxSessions,
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
  const usageMonitor = {
    snapshotForAccount: (accountId) => usageSnapshot(store.accountById(accountId)),
    refreshAccount: async (accountId) => usageSnapshot(store.accountById(accountId)),
    stop() {},
  };
  const { server, sessionCount } = await createCredentialConsole({
    store,
    usageMonitor,
    adminAuth,
    cookieSecure,
    ...(maxSessions === undefined ? {} : { maxSessions }),
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
    sessionCount,
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

// Tailscale Serve supplies this header; in the default mode every console request
// needs it, and the session is bound to the identity it carries.
const ADMIN = { 'Tailscale-User-Login': 'admin@example.com' };

function authorizeUrlFrom(html) {
  const match = html.match(/href="(https:\/\/auth\.openai\.com[^"]+)"/);
  assert.ok(match, 'the OpenAI authorization link should be rendered');
  return new URL(match[1].replaceAll('&amp;', '&'));
}

test('tailnet identity mode has no sign-in and binds sessions to the user', async () => {
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

    const health = await fetch(`${app.baseUrl}/health`);
    assert.deepEqual(await health.json(), {
      status: 'ok',
      admin_auth: 'tailscale',
      admin_configured: true,
    });

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

test('open mode issues Claude device configs with no login while still enforcing CSRF', async () => {
  const app = await fixture({
    adminAuth: 'open',
    codex: { claudeGatewayUrl: 'https://public-gateway.example:10000/claude' },
  });
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-open',
      credential: { oauth_token: 'open-mode-master-token' },
    });

    // Open mode authenticates nobody, so it must not report a configured administrator:
    // that field is the one thing a monitor can alert on here.
    const health = await fetch(`${app.baseUrl}/health`);
    assert.deepEqual(await health.json(), {
      status: 'ok',
      admin_auth: 'open',
      admin_configured: false,
    });

    const dashboardResponse = await fetch(`${app.baseUrl}/`, { redirect: 'manual' });
    assert.equal(dashboardResponse.status, 200);
    const cookie = cookieFrom(dashboardResponse);
    const dashboard = await dashboardResponse.text();
    assert.match(dashboard, /No authentication: anyone who can reach this console/);
    assert.match(dashboard, /Member self-service · This is exactly what every member sees/);
    assert.match(dashboard, /Anonymous visitor/);
    assert.match(dashboard, /name="member_label"/);
    assert.match(dashboard, /Get Claude Code setup/);
    assert.equal(dashboard.includes('Tailscale identity'), false);
    assert.equal(dashboard.includes('Sign out'), false);
    assert.equal(dashboard.includes('Administrator password'), false);

    const csrf = csrfFrom(dashboard);
    const forgedToken = await fetch(`${app.baseUrl}/self-service`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf: 'wrong',
        account_id: account.id,
        device_name: 'forged',
        member_label: 'mallory',
      }),
    });
    assert.equal(forgedToken.status, 403);
    assert.equal(app.store.publicDevices().length, 0);

    // A cross-site POST carries no console cookie, so there is no session to check
    // its CSRF token against and none is minted for it.
    const crossSite = await fetch(`${app.baseUrl}/self-service`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf,
        account_id: account.id,
        device_name: 'cross-site',
        member_label: 'mallory',
      }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal(app.store.publicDevices().length, 0);

    const missingLabel = await fetch(`${app.baseUrl}/self-service`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, account_id: account.id, device_name: 'unlabelled' }),
    });
    assert.equal(missingLabel.status, 303);
    assert.match(missingLabel.headers.get('location'), /^\/\?error=member%20label%20must%20use/);
    assert.equal(app.store.publicDevices().length, 0);

    const issued = await fetch(`${app.baseUrl}/self-service`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf,
        account_id: account.id,
        device_name: 'open-macbook',
        member_label: 'alex',
      }),
    });
    assert.equal(issued.status, 200);
    const issuedHtml = await issued.text();
    assert.match(issuedHtml, /Copy or download this configuration now/);
    assert.match(issuedHtml, /No authentication: anyone who can reach this console/);
    assert.match(issuedHtml, /ANTHROPIC_BASE_URL=&#39;https:\/\/public-gateway\.example:10000\/claude&#39;/);
    assert.equal(issuedHtml.includes('open-mode-master-token'), false);
    assert.equal(app.store.publicDevices().length, 1);
    assert.equal(app.store.publicDevices()[0].member_label, 'alex');
    assert.equal(app.store.publicDevices()[0].name, 'open-macbook');
  } finally {
    await app.close();
  }
});

test('open mode self-serves a Codex installer keyed to the self-asserted member label', async () => {
  const enrollmentRequests = [];
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexEndpoint: 'https://203.0.113.10:8443',
      codexCertPin: 'a'.repeat(64),
      codexEnrollmentKey: 'test-enrollment-key-long-enough',
      codexEnroll: async (request) => {
        enrollmentRequests.push(request);
        return { name: request.name, token: 'codex-open-device-token' };
      },
    },
  });
  try {
    await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      external: { kind: 'codex-credential', home: '/missing-test-home' },
    });
    await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-open',
      credential: { oauth_token: 'open-mode-master-token' },
    });
    const dashboardResponse = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(dashboardResponse);
    const dashboard = await dashboardResponse.text();
    assert.match(dashboard, /Get Codex installer/);
    // Both self-service forms carry the label; the admin enrollment form has its own.
    assert.equal((dashboard.match(/name="member_label" required pattern=/g) ?? []).length, 2);
    const csrf = csrfFrom(dashboard);

    const missingLabel = await fetch(`${app.baseUrl}/codex/self-service`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, device_name: 'open-laptop' }),
    });
    assert.equal(missingLabel.status, 303);
    assert.equal(enrollmentRequests.length, 0);

    const enrollment = await fetch(`${app.baseUrl}/codex/self-service`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, device_name: 'open-laptop', member_label: 'dana' }),
    });
    assert.equal(enrollment.status, 200);
    const html = await enrollment.text();
    assert.match(html, /install-codex-macos\.sh/);
    assert.match(html, /install-codex-windows\.ps1/);
    assert.match(html, /codex-open-device-token/);
    assert.match(html, /No authentication: anyone who can reach this console/);
    assert.equal(html.includes('test-enrollment-key-long-enough'), false);
    assert.equal(enrollmentRequests.length, 1);
    const suffix = createHash('sha256').update('dana').digest('hex').slice(0, 10);
    assert.equal(enrollmentRequests[0].name, `open-laptop-${suffix}`);
  } finally {
    await app.close();
  }
});

test('an unset CREDENTIAL_CONSOLE_ADMIN_AUTH defaults to tailscale, not open', async () => {
  // The default is resolved when server.js is imported, so it can only be observed
  // in a process whose environment genuinely lacks the variable.
  const home = await mkdtemp(join(tmpdir(), 'credential-console-default-mode-'));
  await new CredentialStore(home, { allowKeyInit: true }).init();
  // Strip the whole prefix, not just the one name: the probe reads its configuration
  // from the environment at import time, and a runner shell that also configures a
  // real console would otherwise leak (say) CREDENTIAL_CONSOLE_CODEX_ENROLLMENT_KEY_FILE
  // into it and fail this test on a missing file rather than on the mode.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CREDENTIAL_CONSOLE_')) delete env[key];
  }
  env.CREDENTIAL_CONSOLE_HOME = home;
  const probe = `
    import { CredentialStore } from ${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)};
    import { createCredentialConsole } from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};
    const store = await new CredentialStore(process.env.CREDENTIAL_CONSOLE_HOME).init();
    const { server } = await createCredentialConsole({
      store,
      usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
      cookieSecure: false,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const health = await (await fetch(base + '/health')).json();
    const dashboard = await fetch(base, { redirect: 'manual' });
    process.stdout.write(JSON.stringify({ health, dashboard: dashboard.status }));
    server.close();
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', probe],
    { env },
  );
  const observed = JSON.parse(stdout);
  assert.deepEqual(observed.health, {
    status: 'ok',
    admin_auth: 'tailscale',
    admin_configured: true,
  });
  // Fail closed: an unconfigured deployment refuses a visitor with no tailnet identity.
  assert.equal(observed.dashboard, 403);
});

test('neither surviving administrator mode serves a sign-in or sign-out route', async () => {
  for (const adminAuth of ['tailscale', 'open']) {
    const app = await fixture({ adminAuth });
    try {
      for (const path of ['/login', '/logout']) {
        const got = await fetch(`${app.baseUrl}${path}`, {
          redirect: 'manual',
          headers: ADMIN,
        });
        assert.equal(got.status, 404, `GET ${path} in ${adminAuth} mode`);
        const posted = await fetch(`${app.baseUrl}${path}`, {
          method: 'POST',
          redirect: 'manual',
          headers: { ...ADMIN, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ password: 'correct-horse-battery-staple' }),
        });
        assert.equal(posted.status, 404, `POST ${path} in ${adminAuth} mode`);
        assert.equal((await posted.text()).includes('Administrator password'), false);
      }
      // No page offers a way back to a sign-in that no longer exists.
      const dashboard = await fetch(`${app.baseUrl}/`, { headers: ADMIN });
      assert.equal(dashboard.status, 200);
      const html = await dashboard.text();
      assert.equal(html.includes('Sign out'), false);
      assert.equal(html.includes('action="/logout"'), false);
    } finally {
      await app.close();
    }
  }
});

test('an administrator mode outside the surviving two is refused at startup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-bad-mode-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  await assert.rejects(
    createCredentialConsole({
      store,
      usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
      adminAuth: 'password',
    }),
    /must be tailscale or open/,
  );
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

test('an administrator registers a Codex account and authorizes it from the failed localhost address', async () => {
  const exchanges = [];
  const tokens = syntheticCodexTokens();
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexOauthExchange: async (request) => {
        exchanges.push(request);
        return {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        };
      },
    },
  });
  try {
    const firstResponse = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(firstResponse);
    const csrf = csrfFrom(await firstResponse.text());

    const added = await fetch(`${app.baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, provider: 'codex', alias: 'codex-shared-1' }),
    });
    assert.equal(added.status, 303);
    const account = app.store.state.accounts[0];
    assert.equal(account.provider, 'codex');
    assert.equal(account.status, 'login_required');

    const dashboard = await (await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } })).text();
    assert.ok(dashboard.includes(`/accounts/${account.id}/codex-authorization`));
    assert.match(dashboard, /Codex authorization/);

    const page = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {
      headers: { Cookie: cookie },
    });
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /is the successful outcome, not an error/);
    assert.match(pageHtml, /The console writes nothing\./);

    const started = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(started.status, 200);
    const startedHtml = await started.text();
    assert.match(startedHtml, /A fresh 15-minute authorization session is ready/);
    const authorizeUrl = authorizeUrlFrom(startedHtml);
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      'http://localhost:1455/auth/callback',
    );
    assert.equal(authorizeUrl.searchParams.get('scope'), 'openid profile email offline_access');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    const state = authorizeUrl.searchParams.get('state');
    assert.ok(state);

    const flow = app.store.codexAuthorizationByState({ accountId: account.id, state });
    assert.equal(
      authorizeUrl.searchParams.get('code_challenge'),
      createHash('sha256').update(flow.verifier).digest('base64url'),
    );
    const pending = await readFile(join(app.home, 'state.json'), 'utf8');
    assert.equal(pending.includes(flow.verifier), false);
    assert.equal(pending.includes(state), false);
    assert.match(pending, /"ciphertext"/);

    const wrongState = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf,
          authorization_code: `http://localhost:1455/auth/callback?code=stolen&state=${state.slice(0, -1)}x`,
        }),
      },
    );
    assert.equal(wrongState.status, 400);
    assert.match(await wrongState.text(), /authorization session was not found/);
    assert.equal(exchanges.length, 0);

    const pasted = new URLSearchParams({
      csrf,
      authorization_code: `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
    });
    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pasted,
      },
    );
    assert.equal(completed.status, 200);
    const completedHtml = await completed.text();
    assert.deepEqual(exchanges, [{ code: 'browser-code', verifier: flow.verifier }]);
    assert.match(completedHtml, /data-copy-target="codex-auth-json"/);
    assert.match(completedHtml, /data-download-target="codex-auth-json"/);
    assert.match(completedHtml, /refresh-center\/seed\.js/);
    assert.match(completedHtml, /&quot;auth_mode&quot;: &quot;chatgpt&quot;/);
    assert.ok(completedHtml.includes(tokens.refreshToken));
    assert.ok(completedHtml.includes(tokens.accountId));

    // Nothing durable and nothing later-rendered holds the credential.
    const persisted = await readFile(join(app.home, 'state.json'), 'utf8');
    const afterwards = await (await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } })).text();
    for (const secret of [tokens.refreshToken, tokens.accessToken, tokens.idToken]) {
      assert.equal(persisted.includes(secret), false);
      assert.equal(afterwards.includes(secret), false);
    }
    assert.equal(app.store.accountCredential(account.id), null);
    assert.equal(account.status, 'login_required');

    const replay = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pasted,
      },
    );
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /authorization session was already used/);
    assert.equal(exchanges.length, 1);
  } finally {
    await app.close();
  }
});

test('a bare authorization code completes the account\'s one live Codex session', async () => {
  const exchanges = [];
  const tokens = syntheticCodexTokens({ email: 'owner@example.com' });
  const app = await fixture({
    codex: {
      codexOauthExchange: async (request) => {
        exchanges.push(request);
        return {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        };
      },
    },
  });
  try {
    const account = await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      emailLabel: 'owner@example.com',
    });
    const page = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {
      headers: ADMIN,
    });
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    const stale = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { ...ADMIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, authorization_code: 'code-with-no-session' }),
      },
    );
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /no authorization session is waiting for a code/);

    await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { ...ADMIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    // Starting again supersedes the first session, so a bare code stays unambiguous.
    const restarted = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/start`,
      {
        method: 'POST',
        headers: { ...ADMIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf }),
      },
    );
    const live = authorizeUrlFrom(await restarted.text()).searchParams.get('state');
    const liveVerifier = app.store.codexAuthorizationByState({
      accountId: account.id,
      state: live,
    }).verifier;

    // Re-opening the permanent page while a session is live must still offer the
    // paste box, or the operator's only visible move is to supersede their code.
    const revisited = await (await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization`,
      { headers: { ...ADMIN, Cookie: cookie } },
    )).text();
    assert.match(revisited, /textarea name="authorization_code"/);
    assert.match(revisited, /This authorization session is still open/);

    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { ...ADMIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, authorization_code: 'bare-browser-code' }),
      },
    );
    assert.equal(completed.status, 200);
    assert.deepEqual(exchanges, [{ code: 'bare-browser-code', verifier: liveVerifier }]);
    assert.ok((await completed.text()).includes(tokens.refreshToken));
  } finally {
    await app.close();
  }
});

test('a configured seed home receives the credential and publishes it without the refresh token', async () => {
  const seedHome = await mkdtemp(join(tmpdir(), 'credential-console-seed-'));
  const tokens = syntheticCodexTokens();
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexSeedHome: seedHome,
      codexOauthExchange: async () => ({
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }),
    },
  });
  try {
    const account = await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
    // An ambiguous earlier rotation quarantines the home: refresh.js then refuses
    // to refresh forever, and clearing it is the reason to re-seed from a fresh
    // human login at all. A seed that leaves the marker behind is a dead centre.
    const seedStore = new CodexCredentialStore(seedHome);
    await seedStore.init();
    await seedStore.beginRefreshAttempt({ reason: 'test-ambiguous-rotation' });
    assert.notEqual(await seedStore.readRefreshAttempt(), null);

    const page = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {});
    const cookie = cookieFrom(page);
    const pageHtml = await page.text();
    assert.match(pageHtml, /written straight into the Codex credential home/);
    assert.ok(pageHtml.includes(seedHome));
    const csrf = csrfFrom(pageHtml);

    const started = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    const state = authorizeUrlFrom(await started.text()).searchParams.get('state');
    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf,
          authorization_code: `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
        }),
      },
    );
    assert.equal(completed.status, 200);
    const completedHtml = await completed.text();
    assert.match(completedHtml, /The credential was written to/);
    for (const secret of [tokens.refreshToken, tokens.accessToken, tokens.idToken]) {
      assert.equal(completedHtml.includes(secret), false);
    }

    const stored = JSON.parse(await readFile(join(seedHome, 'secret', 'credential.json'), 'utf8'));
    assert.equal(stored.auth_mode, 'chatgpt');
    assert.equal(stored.OPENAI_API_KEY, null);
    assert.equal(stored.tokens.refresh_token, tokens.refreshToken);
    assert.equal(stored.tokens.account_id, tokens.accountId);

    const published = JSON.parse(await readFile(join(seedHome, 'public', 'current.json'), 'utf8'));
    assert.equal('refresh_token' in published, false);
    assert.equal(published.access_token, tokens.accessToken);
    assert.equal(published.expires_at, tokens.expiresAt);

    // Pinned independently of the publish above: both effects are load-bearing.
    assert.equal(await seedStore.readRefreshAttempt(), null);

    assert.equal(account.status, 'stored');
    assert.equal(account.external.home, seedHome);
    const persisted = await readFile(join(app.home, 'state.json'), 'utf8');
    for (const secret of [tokens.refreshToken, tokens.accessToken, tokens.idToken]) {
      assert.equal(persisted.includes(secret), false);
    }

    // A held operation lock means a refresh may be in flight against the same
    // single-use token; the write must stop rather than race it.
    const release = await seedStore.acquireOperation('test-refresh');
    try {
      const restarted = await fetch(
        `${app.baseUrl}/accounts/${account.id}/codex-authorization/start`,
        {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf }),
        },
      );
      const busyState = authorizeUrlFrom(await restarted.text()).searchParams.get('state');
      const busy = await fetch(
        `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
        {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            csrf,
            authorization_code: `http://localhost:1455/auth/callback?code=second-code&state=${busyState}`,
          }),
        },
      );
      assert.equal(busy.status, 400);
      const busyHtml = await busy.text();
      assert.match(busyHtml, /is busy, so nothing was written/);
      // The second code is spent upstream and nothing reached disk, so the
      // credential is handed back rather than destroyed along with the attempt.
      assert.match(busyHtml, /data-download-target="codex-auth-json"/);
      assert.ok(busyHtml.includes(tokens.refreshToken));
    } finally {
      await release();
    }
    // A second account cannot be pointed at a home the first one already holds:
    // that write would replace a credential whose refresh token is single-use.
    const second = await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-2' });
    const refused = await fetch(
      `${app.baseUrl}/accounts/${second.id}/codex-authorization/start`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf }),
      },
    );
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /codex-shared-1 already holds the credential in/);

    const unchanged = JSON.parse(await readFile(join(seedHome, 'secret', 'credential.json'), 'utf8'));
    assert.deepEqual(unchanged, stored);
  } finally {
    await app.close();
  }
});

test('a seed that fails after the credential lands still binds the home to that account', async () => {
  const seedHome = await mkdtemp(join(tmpdir(), 'credential-console-seed-partial-'));
  const tokens = syntheticCodexTokens();
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexSeedHome: seedHome,
      codexOauthExchange: async () => ({
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }),
    },
  });
  try {
    const account = await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
    const page = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {});
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    const started = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    const state = authorizeUrlFrom(await started.text()).searchParams.get('state');

    // publish() renames its temp file over current.json; a directory there makes
    // that fail *after* writeCredential has already replaced the credential.
    await mkdir(join(seedHome, 'public', 'current.json'), { recursive: true });
    const pasted = new URLSearchParams({
      csrf,
      authorization_code: `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
    });
    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pasted,
      },
    );
    assert.equal(completed.status, 400);
    const completedHtml = await completed.text();
    assert.match(completedHtml, /Codex credential written, publish incomplete/);
    // Already safe on disk, so it is not re-rendered into an HTTP response.
    for (const secret of [tokens.refreshToken, tokens.accessToken, tokens.idToken]) {
      assert.equal(completedHtml.includes(secret), false);
    }

    const stored = JSON.parse(await readFile(join(seedHome, 'secret', 'credential.json'), 'utf8'));
    assert.equal(stored.tokens.refresh_token, tokens.refreshToken);

    // The home now holds this account's live credential, so the console has to
    // know that — otherwise the next account is free to overwrite it.
    assert.equal(account.external.home, seedHome);
    const second = await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-2' });
    const refused = await fetch(
      `${app.baseUrl}/accounts/${second.id}/codex-authorization/start`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf }),
      },
    );
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /codex-shared-1 already holds the credential in/);

    // The session is retired before the seed failure is reported: the code was
    // spent upstream, so replaying it can only fail, never re-seed.
    const replay = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pasted,
      },
    );
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /authorization session was already used/);
  } finally {
    await app.close();
  }
});

test('an unwritable seed home is refused before an authorization is spent on it', async () => {
  // The home itself cannot be created, which is what a systemd InaccessiblePaths
  // mount or a missing ACL looks like from inside the process.
  const seedRoot = await mkdtemp(join(tmpdir(), 'credential-console-seed-readonly-'));
  const seedHome = join(seedRoot, 'codex-credential');
  const exchanges = [];
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexSeedHome: seedHome,
      codexOauthExchange: async (request) => {
        exchanges.push(request);
        throw new Error('the exchange must never be reached');
      },
    },
  });
  try {
    await chmod(seedRoot, 0o500);
    const account = await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
    const page = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {});
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    const started = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(started.status, 400);
    assert.match(await started.text(), /is not writable by this console \(EACCES\)/);
    // Nothing was started, so nothing was spent and nothing needs retiring.
    assert.equal(app.store.pendingCodexAuthorization({ accountId: account.id }), null);
    assert.equal(app.store.state.oauth_flows.length, 0);
    assert.equal(exchanges.length, 0);
  } finally {
    await chmod(seedRoot, 0o700).catch(() => {});
    await app.close();
  }
});

test('a Codex account bound to another home is refused before a session is opened', async () => {
  const seedHome = await mkdtemp(join(tmpdir(), 'credential-console-seed-elsewhere-'));
  const otherHome = await mkdtemp(join(tmpdir(), 'credential-console-other-home-'));
  const app = await fixture({
    adminAuth: 'open',
    codex: { codexSeedHome: seedHome },
  });
  try {
    const account = await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-imported-1',
      external: { kind: 'codex-credential', home: otherHome },
    });
    const page = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {});
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    const refused = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /codex-imported-1 holds its credential in .*, not the configured seed home/);
    // Refused before anything was opened: the dashboard would otherwise read this
    // row's health from a home nobody is writing.
    assert.equal(app.store.pendingCodexAuthorization({ accountId: account.id }), null);
    assert.equal(app.store.state.oauth_flows.length, 0);
  } finally {
    await app.close();
  }
});

test('a Codex authorization is refused when the id_token names a different account', async () => {
  const someoneElse = syntheticCodexTokens({ email: 'someone-else@example.com' });
  const seedHome = await mkdtemp(join(tmpdir(), 'credential-console-seed-email-'));
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexSeedHome: seedHome,
      codexOauthExchange: async () => ({
        idToken: someoneElse.idToken,
        accessToken: someoneElse.accessToken,
        refreshToken: someoneElse.refreshToken,
      }),
    },
  });
  try {
    const account = await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      emailLabel: 'expected@example.com',
    });
    const page = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {});
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    const started = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    const state = authorizeUrlFrom(await started.text()).searchParams.get('state');

    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf,
          authorization_code: `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
        }),
      },
    );
    assert.equal(completed.status, 400);
    const completedHtml = await completed.text();
    assert.match(completedHtml, /does not match expected@example\.com/);
    assert.equal(completedHtml.includes(someoneElse.refreshToken), false);
    assert.equal(completedHtml.includes('codex-auth-json'), false);
    await assert.rejects(readFile(join(seedHome, 'secret', 'credential.json')), { code: 'ENOENT' });
    assert.equal(account.external, undefined);

    // The wrong login costs the code but not the session: the paste box survives
    // so the right account can be authorized without a fresh round trip.
    assert.match(completedHtml, /textarea name="authorization_code"/);
    assert.match(completedHtml, /This authorization session is still open/);
  } finally {
    await app.close();
  }
});

test('a Codex authorization cannot be completed by a different tailnet administrator', async () => {
  const exchanges = [];
  const tokens = syntheticCodexTokens();
  const app = await fixture({
    adminAuth: 'tailscale',
    codex: {
      codexOauthExchange: async (request) => {
        exchanges.push(request);
        return {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        };
      },
    },
  });
  try {
    const account = await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
    const alice = { 'Tailscale-User-Login': 'alice@example.com' };
    const bob = { 'Tailscale-User-Login': 'bob@example.com' };

    const alicePage = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {
      headers: alice,
    });
    const aliceCookie = cookieFrom(alicePage);
    const aliceCsrf = csrfFrom(await alicePage.text());
    const started = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { ...alice, Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: aliceCsrf }),
    });
    const state = authorizeUrlFrom(await started.text()).searchParams.get('state');

    const bobPage = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`, {
      headers: bob,
    });
    const bobCookie = cookieFrom(bobPage);
    const bobCsrf = csrfFrom(await bobPage.text());
    const stolen = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { ...bob, Cookie: bobCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf: bobCsrf,
          authorization_code: `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
        }),
      },
    );
    assert.equal(stolen.status, 400);
    assert.match(await stolen.text(), /same administrator who started it/);
    assert.equal(exchanges.length, 0);

    // Alice's own session is untouched by the attempt.
    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { ...alice, Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf: aliceCsrf,
          authorization_code: `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
        }),
      },
    );
    assert.equal(completed.status, 200);
    assert.equal(exchanges.length, 1);
  } finally {
    await app.close();
  }
});

test('open mode does not mint a session for a request that cannot carry a CSRF token', async () => {
  const app = await fixture({ adminAuth: 'open' });
  try {
    const first = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(first);
    const csrf = csrfFrom(await first.text());
    const baseline = app.sessionCount();

    // A cookieless POST is refused on CSRF grounds either way; what must not
    // happen is that each one leaves a 12-hour session behind.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const forged = await fetch(`${app.baseUrl}/self-service`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, device_name: 'forged', member_label: 'mallory' }),
      });
      assert.equal(forged.status, 403);
    }
    assert.equal(app.sessionCount(), baseline);

    // The session a real visitor holds still works.
    const dashboard = await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);
    assert.equal(csrfFrom(await dashboard.text()), csrf);
  } finally {
    await app.close();
  }
});

test('open mode bounds the session map and evicts the least recently used session', async () => {
  // The real ceiling is 4096; drive the same path with a small one so the eviction
  // is exercised rather than assumed. Open mode mints a session for any page load,
  // so nothing but this cap stands between an anonymous crawler and the heap.
  const app = await fixture({ adminAuth: 'open', maxSessions: 8 });
  try {
    const active = await fetch(`${app.baseUrl}/`);
    const activeCookie = cookieFrom(active);
    const activeCsrf = csrfFrom(await active.text());
    const idle = await fetch(`${app.baseUrl}/`);
    const idleCookie = cookieFrom(idle);
    const idleCsrf = csrfFrom(await idle.text());

    for (let visit = 0; visit < 40; visit += 1) {
      const anonymous = await fetch(`${app.baseUrl}/`);
      assert.equal(anonymous.status, 200);
      assert.ok(
        app.sessionCount() <= 8,
        `session map reached ${app.sessionCount()} against a ceiling of 8`,
      );
      // Presenting the cookie is what keeps this session at the recently-used end.
      await fetch(`${app.baseUrl}/`, { headers: { Cookie: activeCookie } });
    }
    assert.equal(app.sessionCount(), 8);

    // The session that kept being used survived the flood, CSRF token included.
    const accepted = await fetch(`${app.baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: activeCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf: activeCsrf,
        provider: 'claude',
        alias: 'claude-open-1',
        email_label: 'owner@example.com',
      }),
    });
    assert.equal(accepted.status, 303);
    assert.equal(app.store.publicAccounts().length, 1);

    // The one nobody came back for was recycled. The cap is a memory bound, not a
    // promise that an untouched session outlives an anonymous flood.
    const stale = await fetch(`${app.baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: idleCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf: idleCsrf,
        provider: 'claude',
        alias: 'claude-open-2',
        email_label: 'owner@example.com',
      }),
    });
    assert.equal(stale.status, 403);
    assert.match(await stale.text(), /carried no console session/);
    assert.equal(app.store.publicAccounts().length, 1);
  } finally {
    await app.close();
  }
});

test('the session cookie is HttpOnly, SameSite=Strict, and Secure when configured', async () => {
  // README "Security boundaries" advertises these attributes, and in open mode the
  // cookie is handed to every anonymous page load and carries the only CSRF token.
  const plain = await fixture({ adminAuth: 'open' });
  try {
    const raw = (await fetch(`${plain.baseUrl}/`)).headers.get('set-cookie');
    assert.match(raw, /^credential_console_session=/);
    assert.match(raw, /; Path=\//);
    assert.match(raw, /; HttpOnly/);
    assert.match(raw, /; SameSite=Strict/);
    assert.match(raw, /; Max-Age=43200/);
    // The rest of the suite pins this off so it can speak plain HTTP to the fixture.
    assert.equal(/; Secure/.test(raw), false);
  } finally {
    await plain.close();
  }

  const secure = await fixture({ adminAuth: 'tailscale', cookieSecure: true });
  try {
    const raw = (await fetch(`${secure.baseUrl}/`, { headers: ADMIN })).headers.get('set-cookie');
    assert.match(raw, /; HttpOnly/);
    assert.match(raw, /; SameSite=Strict/);
    assert.match(raw, /; Secure$/);
  } finally {
    await secure.close();
  }
});

test('open mode cannot bind an authorization session to the visitor who started it', async () => {
  const exchanges = [];
  const tokens = syntheticCodexTokens();
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexOauthExchange: async (request) => {
        exchanges.push(request);
        return {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        };
      },
    },
  });
  try {
    const account = await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
    const starterPage = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`);
    const starterCookie = cookieFrom(starterPage);
    const starterCsrf = csrfFrom(await starterPage.text());
    const started = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization/start`, {
      method: 'POST',
      headers: { Cookie: starterCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: starterCsrf }),
    });
    const state = authorizeUrlFrom(await started.text()).searchParams.get('state');

    // A second visitor, with their own session and their own CSRF token.
    const otherPage = await fetch(`${app.baseUrl}/accounts/${account.id}/codex-authorization`);
    const otherCookie = cookieFrom(otherPage);
    const otherCsrf = csrfFrom(await otherPage.text());
    assert.notEqual(otherCookie, starterCookie);
    assert.notEqual(otherCsrf, starterCsrf);

    const completed = await fetch(
      `${app.baseUrl}/accounts/${account.id}/codex-authorization/complete`,
      {
        method: 'POST',
        headers: { Cookie: otherCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf: otherCsrf,
          authorization_code: `http://localhost:1455/auth/callback?code=browser-code&state=${state}`,
        }),
      },
    );
    // Documented in README "Security boundaries" and DEPLOY "Administrator
    // authentication": open mode has no identity, so every visitor is recorded as the
    // same `administrator` and the tailscale-mode refusal cannot fire here. PKCE, the
    // single live session, and the 15-minute expiry are what is left.
    assert.equal(completed.status, 200);
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].code, 'browser-code');
    assert.equal((await completed.text()).includes('same administrator who started it'), false);
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
    assert.equal(unauthenticated.status, 403);
    assert.match(await unauthenticated.text(), /Tailnet identity required/);

    const dashboardResponse = await fetch(`${app.baseUrl}/`, { headers: ADMIN });
    assert.equal(dashboardResponse.status, 200);
    const cookie = cookieFrom(dashboardResponse);
    const dashboard = await dashboardResponse.text();
    const csrf = csrfFrom(dashboard);

    const add = await fetch(`${app.baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...ADMIN,
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
      { headers: { ...ADMIN, Cookie: cookie } },
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
          ...ADMIN,
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
          ...ADMIN,
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

    const refreshedDashboard = await fetch(`${app.baseUrl}/`, { headers: { ...ADMIN, Cookie: cookie } });
    const refreshedHtml = await refreshedDashboard.text();
    const refreshedCsrf = csrfFrom(refreshedHtml);
    assert.equal(refreshedHtml.includes(masterToken), false);

    const enrollmentResponse = await fetch(
      `${app.baseUrl}/accounts/${account.id}/enrollments`,
      {
        method: 'POST',
        headers: {
          ...ADMIN,
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
    const currentDashboard = await fetch(`${app.baseUrl}/`, { headers: { ...ADMIN, Cookie: cookie } });
    const currentCsrf = csrfFrom(await currentDashboard.text());
    const revoke = await fetch(`${app.baseUrl}/devices/${device.id}/revoke`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...ADMIN,
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
    const cookie = cookieFrom(await fetch(`${app.baseUrl}/`, { headers: ADMIN }));

    const add = await fetch(`${app.baseUrl}/accounts`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...ADMIN,
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

test('a Codex account awaiting authorization renders as pending, not as a red failure', async () => {
  const app = await fixture({
    adminAuth: 'open',
    usageSnapshot: (account) => (account.provider === 'codex'
      ? { provider: 'codex', windows: [], status: 'authorization_required', last_error: 'authorization_required' }
      : null),
  });
  try {
    await app.store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
    const dashboard = await (await fetch(`${app.baseUrl}/`)).text();
    assert.match(dashboard, /data-i18n="usage-authorize-first"/);
    assert.equal(dashboard.includes('quota-message error'), false);
  } finally {
    await app.close();
  }
});

// The generated installer is self-contained: it base64-embeds the agent, then
// execs install.sh. An asset install.sh runs but the manifest omits does not
// fail loudly — install.sh reports success and the machine is simply left
// unable to renew, so the credential dies days later with no signal. Derive the
// requirement from install.sh itself rather than restating it, so adding a new
// dependency there cannot silently outrun the manifest.
test('installer embeds every asset install.sh execs', async () => {
  const installSh = await readFile(
    new URL('../../codex-credential/client-agent/install/install.sh', import.meta.url),
    'utf8',
  );
  // install.sh writes this one itself, as a heredoc, so it is deliberately not
  // shipped. Everything else it names under $DEST has to arrive embedded.
  const GENERATED_BY_INSTALLER = new Set(['run.sh']);
  const referenced = new Set(
    [...installSh.matchAll(/\$DEST\/([A-Za-z0-9/_.-]+\.(?:sh|js|json|ps1|plist|service|timer))/g)]
      .map((match) => match[1])
      .filter((path) => !GENERATED_BY_INSTALLER.has(path)),
  );
  assert.ok(referenced.size > 0, 'expected install.sh to reference at least one embedded asset');
  for (const path of GENERATED_BY_INSTALLER) {
    assert.match(
      installSh,
      new RegExp(`cat > "\\$(?:DEST/${path.replace('.', '\\.')}|RUNNER)"`),
      `${path} is exempted as installer-generated, but install.sh no longer creates it`,
    );
  }
  const notLoaded = [...referenced].filter((path) => !CODEX_AGENT_ASSETS.has(path)).sort();
  assert.deepEqual(
    notLoaded,
    [],
    `install.sh needs these, but server.js does not load them: ${notLoaded.join(', ')}`,
  );

  // Loading an asset is not the same as shipping it. views.js keeps its own list
  // of write_asset lines, and the first version of this test passed while the
  // generated installer was still missing two files, because it only checked the
  // map. Assert on the emitter too — that is what the machine actually receives.
  const views = await readFile(new URL('../lib/views.js', import.meta.url), 'utf8');
  const notEmitted = [...referenced]
    .filter((path) => !views.includes(`write_asset ${path} `))
    .sort();
  assert.deepEqual(
    notEmitted,
    [],
    `server.js loads these but the generated installer never writes them: ${notEmitted.join(', ')}`,
  );
});

test('an unauthorized account row can be deleted from the console, a credentialed one cannot', async () => {
  const app = await fixture({ adminAuth: 'open' });
  try {
    const pending = await app.store.addAccount({ provider: 'claude', alias: 'wrong-email' });
    const authorized = await app.store.addAccount({
      provider: 'claude',
      alias: 'in-use',
      credential: { oauth_token: 'sk-ant-oat01-keep-me' },
    });

    const page = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(page);
    const html = await page.text();
    const csrf = csrfFrom(html);
    // Offered only for the row that has nothing to lose.
    assert.match(html, new RegExp(`/accounts/${pending.id}/delete`));
    assert.equal(html.includes(`/accounts/${authorized.id}/delete`), false);

    const noCsrf = await fetch(`${app.baseUrl}/accounts/${pending.id}/delete`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });
    assert.equal(noCsrf.status, 403);
    assert.ok(app.store.accountById(pending.id), 'a CSRF-less delete must change nothing');

    const ok = await fetch(`${app.baseUrl}/accounts/${pending.id}/delete`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(ok.status, 303);
    assert.equal(app.store.accountById(pending.id), null);

    // Forging the route against a credentialed account is refused by the store.
    const forged = await fetch(`${app.baseUrl}/accounts/${authorized.id}/delete`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(forged.status, 303);
    assert.match(forged.headers.get('location'), /error=.*credential/);
    assert.ok(app.store.accountCredential(authorized.id).oauth_token, 'the credential must survive');
  } finally {
    await app.close();
  }
});
