import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    res.end(JSON.stringify({
      ok: true,
      usage: {
        input_tokens: 7,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 5,
      },
    }));
  });
  const upstreamUrl = await listen(upstream);

  const home = await mkdtemp(join(tmpdir(), 'credential-console-server-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const usageMonitor = {
    snapshotForAccount: (accountId) => usageSnapshot(store.accountById(accountId)),
    refreshAccount: async (accountId) => usageSnapshot(store.accountById(accountId)),
    stop() {},
  };
  const { server, requestMetrics, sessionCount } = await createCredentialConsole({
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
    requestMetrics,
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
      client_config_version: '1',
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
      client_config_version: '1',
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

test('two members who assert the same label and device name do not evict each other', async () => {
  // The console's Codex path is the one place a member takes a credential without
  // ever running the agent, so nothing on their machine can report a handle. It
  // therefore used to send none, and the dispenser fell back to its pre-handle
  // rule: revoke every active row of that name. The name is
  // `<device>-<sha256(member label)[0:10]>` over a label that is self-asserted and
  // unverified, so two people who both typed `alex` and `shared` silently kicked
  // each other offline — exactly the defect the handle exists to fix.
  const enrollmentRequests = [];
  const app = await fixture({
    adminAuth: 'open',
    codex: {
      codexEndpoint: 'https://203.0.113.10:8443',
      codexCertPin: 'a'.repeat(64),
      codexEnrollmentKey: 'test-enrollment-key-long-enough',
      codexEnroll: async (request) => {
        enrollmentRequests.push(request);
        return { name: request.name, token: `codex-token-${enrollmentRequests.length}` };
      },
    },
  });
  try {
    const page = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());
    const claim = () => fetch(`${app.baseUrl}/codex/self-service`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, device_name: 'shared', member_label: 'alex' }),
    });

    assert.equal((await claim()).status, 200);
    assert.equal((await claim()).status, 200);

    // Same dispenser name, as before — the collision in the name is a property of
    // an unverified label and is not what this fixes.
    assert.equal(enrollmentRequests[0].name, enrollmentRequests[1].name);
    // Different handles, which is what stops the dispenser revoking the first
    // person's row when the second person asks.
    for (const request of enrollmentRequests) {
      assert.match(request.machineId, /^[A-Za-z0-9_-]{16,64}$/);
    }
    assert.notEqual(enrollmentRequests[0].machineId, enrollmentRequests[1].machineId);
    // Nothing that authenticates is used as the handle, and no secret rides along.
    for (const request of enrollmentRequests) {
      assert.equal(request.machineId.includes('alex'), false);
      assert.equal(request.machineId.includes('shared'), false);
      assert.equal(request.machineId, request.machineId.trim());
    }
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
    client_config_version: '1',
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
    assert.deepEqual(await proxied.json(), {
      ok: true,
      usage: {
        input_tokens: 7,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 5,
      },
    });
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

test('request metrics page attributes the device label and excludes count_tokens from consumption', async () => {
  const app = await fixture({ adminAuth: 'open' });
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'metrics-account',
      credential: { oauth_token: 'metrics-provider-token' },
    });
    const issued = await app.store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'self-asserted-member',
      deviceName: 'metrics-device',
    });
    const promptMarker = 'body-marker-that-must-never-enter-sqlite';
    const ordinaryBody = JSON.stringify({
      messages: [{ role: 'user', content: promptMarker }],
      model: 'claude-metrics-model',
      stream: true,
    });
    const ordinary = await fetch(`${app.baseUrl}/claude/v1/messages`, {
      method: 'POST',
      headers: {
        'X-Api-Key': issued.token,
        'Content-Type': 'application/json',
      },
      body: ordinaryBody,
    });
    assert.equal(ordinary.status, 200);
    await ordinary.arrayBuffer();

    const countTokens = await fetch(`${app.baseUrl}/claude/v1/messages/count_tokens?beta=1`, {
      method: 'POST',
      headers: {
        'X-Api-Key': issued.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-metrics-model', messages: [] }),
    });
    assert.equal(countTokens.status, 200);
    await countTokens.arrayBuffer();
    assert.equal(app.requestMetrics.flush().written, 2);

    assert.equal(app.requestMetrics.queryTotals({ scope: 'all' }).requestCount, 2);
    assert.equal(app.requestMetrics.queryTotals({ scope: 'consumption' }).requestCount, 1);
    assert.equal(app.requestMetrics.queryTotals({ scope: 'consumption' }).totalInputTokens, 7);
    assert.equal(app.requestMetrics.queryTotals({ scope: 'consumption' }).totalOutputTokens, 5);
    assert.equal(app.requestMetrics.queryTotals({ scope: 'consumption' }).usageCompleteCount, 1);
    assert.equal(
      app.requestMetrics.queryTotals({ scope: 'all', deviceId: issued.device.id }).requestCount,
      2,
    );
    assert.deepEqual(
      app.requestMetrics.queryBreakdown({ by: 'member', scope: 'all' })
        .map(({ groupValue, requestCount }) => ({ groupValue, requestCount })),
      [{ groupValue: 'self-asserted-member', requestCount: 2 }],
    );

    const metrics = await fetch(
      `${app.baseUrl}/metrics?machine_id=device:${encodeURIComponent(issued.device.id)}&member_label=self-asserted-member&account_id=${encodeURIComponent(account.id)}&model=claude-metrics-model&hours=24`,
    );
    assert.equal(metrics.status, 200);
    const html = await metrics.text();
    assert.match(html, /data-i18n="metrics-total-requests">All requests<\/span><strong>2<\/strong>/);
    assert.match(html, /data-i18n="metrics-consumption-requests">Consumption requests<\/span><strong>1<\/strong>/);
    assert.match(html, /value="self-asserted-member" selected/);
    assert.match(html, /value="claude-metrics-model" selected/);
    assert.match(html, /self-entered and unverified/);
    assert.match(html, /never use them for accountability or billing/);
    assert.match(html, /data-i18n="metrics-token-coverage-complete"/);
    assert.match(html, /data-i18n="metrics-claude-only"/);
    assert.match(html, /id="metrics-tokens-chart-title"/);
    assert.match(html, /id="metrics-device-input-comparison-chart-title"/);
    assert.match(html, /id="metrics-device-output-comparison-chart-title"/);
    assert.match(html, /data-i18n="metrics-device-comparison-scope"/);
    assert.match(html, /data-i18n="metrics-token-input">Input tokens<\/span>\s*<strong>7<\/strong>/);
    assert.match(html, /data-i18n="metrics-token-output">Output tokens<\/span>\s*<strong>5<\/strong>/);
    assert.equal(html.includes(promptMarker), false);
    assert.equal(html.includes(issued.token), false);
    const appScript = await (await fetch(`${app.baseUrl}/assets/app.js`)).text();
    const metricsTranslationKeys = new Set(
      [...html.matchAll(/data-i18n="(metrics-[a-z0-9-]+)"/g)].map((match) => match[1]),
    );
    assert.ok(metricsTranslationKeys.size > 20);
    for (const key of metricsTranslationKeys) {
      assert.match(appScript, new RegExp(`'${key}':`), `missing Chinese translation for ${key}`);
    }

    const comparisonAcrossDevices = await fetch(
      `${app.baseUrl}/metrics?machine_id=device:does-not-match&member_label=self-asserted-member&account_id=${encodeURIComponent(account.id)}&model=claude-metrics-model&hours=24`,
    );
    assert.equal(comparisonAcrossDevices.status, 200);
    const comparisonHtml = await comparisonAcrossDevices.text();
    assert.ok((comparisonHtml.match(/data-device-comparison=/g) ?? []).length >= 1);
    assert.match(comparisonHtml, /data-i18n="metrics-device-comparison-scope"/);

    const databaseBytes = await readFile(join(app.home, 'metrics.sqlite'));
    const walBytes = await readFile(join(app.home, 'metrics.sqlite-wal')).catch(() => Buffer.alloc(0));
    const persisted = Buffer.concat([databaseBytes, walBytes]).toString('utf8');
    assert.equal(persisted.includes(promptMarker), false);
    assert.equal(persisted.includes(issued.token), false);
    assert.equal(persisted.includes('metrics-provider-token'), false);
  } finally {
    await app.close();
  }
});

test('metrics initialization failure is visible but does not prevent the console from serving', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-init-failure-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  await mkdir(join(home, 'metrics.sqlite'));
  const created = await createCredentialConsole({
    store,
    usageMonitor: {
      snapshotForAccount: () => null,
      refreshAccount: async () => null,
      stop() {},
    },
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://credential-console.test',
  });
  const baseUrl = await listen(created.server);
  try {
    assert.equal(created.metricsInitFailed, true);
    assert.equal(created.requestMetrics, null);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const page = await fetch(`${baseUrl}/metrics`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-i18n="metrics-unavailable"/);
  } finally {
    await new Promise((resolve) => created.server.close(resolve));
  }
});

test('P3 console and machine API switch only the authenticated device from the next request', async () => {
  const app = await fixture({ adminAuth: 'open' });
  try {
    const primary = await app.store.addAccount({
      provider: 'claude',
      alias: 'p3-primary',
      credential: { oauth_token: 'p3-primary-upstream-token' },
    });
    const secondary = await app.store.addAccount({
      provider: 'claude',
      alias: 'p3-secondary',
      credential: { oauth_token: 'p3-secondary-upstream-token' },
    });
    const placeholder = await app.store.addAccount({
      provider: 'claude',
      alias: 'p3-placeholder',
      emailLabel: 'placeholder@example.test',
    });
    const first = await app.store.issueDeviceCredential({
      accountId: primary.id,
      memberLabel: 'p3-member-a',
      deviceName: 'p3-device-a',
    });
    const second = await app.store.issueDeviceCredential({
      accountId: primary.id,
      memberLabel: 'p3-member-b',
      deviceName: 'p3-device-b',
    });
    const legacySecond = app.store.state.devices.find((device) => device.id === second.device.id);
    delete legacySecond.allowed_account_ids;
    delete legacySecond.selected_account_id;
    await app.store.persist();

    const dashboard = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(dashboard);
    const dashboardHtml = await dashboard.text();
    const csrf = csrfFrom(dashboardHtml);
    assert.match(dashboardHtml, new RegExp(`action="/devices/${first.device.id}/account"`));
    assert.match(dashboardHtml, new RegExp(`action="/devices/${second.device.id}/account"`));
    assert.match(dashboardHtml, /data-i18n="open-account-switch-warning"/);
    const appScript = await (await fetch(`${app.baseUrl}/assets/app.js`)).text();
    for (const key of [
      'original-account',
      'allowed-accounts',
      'selected-account',
      'switch-account',
      'account-selection-invalid',
      'no-claude-accounts',
      'open-account-switch-warning',
    ]) {
      assert.match(appScript, new RegExp(`'${key}':`), `missing Chinese translation for ${key}`);
    }
    assert.match(appScript, /\[data-account-option\], \[data-account-label\]/);
    assert.match(appScript, /translations\[key\]/);
    const configure = (deviceId, accountId, csrfValue = csrf) => fetch(
      `${app.baseUrl}/devices/${deviceId}/account`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrfValue,
          selected_account_id: accountId,
        }),
      },
    );
    const proxy = (token, marker) => fetch(`${app.baseUrl}/claude/v1/messages`, {
      method: 'POST',
      headers: {
        'X-Api-Key': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'p3-model', messages: [{ role: 'user', content: marker }] }),
    });

    const badCsrf = await configure(first.device.id, secondary.id, 'wrong');
    assert.equal(badCsrf.status, 403);
    assert.equal(app.store.resolveDeviceAccount(first.device.id).effective_account_id, primary.id);

    const toSecondary = await configure(first.device.id, secondary.id);
    assert.equal(toSecondary.status, 303);
    const configured = app.store.deviceAccountSummary(first.device.id);
    assert.equal(configured.original_account_id, primary.id);
    assert.equal(configured.selected_account_id, secondary.id);
    assert.deepEqual(configured.allowed_account_ids, [primary.id, secondary.id]);
    assert.equal(app.store.resolveDeviceAccount(second.device.id).effective_account_id, primary.id);

    const throughSecondary = await proxy(first.token, 'through-secondary');
    assert.equal(throughSecondary.status, 200);
    await throughSecondary.arrayBuffer();
    assert.equal(
      app.upstreamRequests.at(-1).authorization,
      'Bearer p3-secondary-upstream-token',
    );

    const statusResponse = await fetch(`${app.baseUrl}/claude/control/v1/status`, {
      headers: { 'X-Api-Key': first.token },
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.device_id, first.device.id);
    assert.equal(status.machine_id, null);
    assert.equal(status.device_name, 'p3-device-a');
    assert.equal(status.original_account_id, primary.id);
    assert.equal(status.account_id, secondary.id);
    assert.equal(status.selected_account_id, secondary.id);
    assert.deepEqual(status.allowed_account_ids, [primary.id, secondary.id]);
    assert.equal(JSON.stringify(status).includes(first.token), false);
    assert.equal(JSON.stringify(status).includes('upstream-token'), false);

    const backToPrimary = await fetch(`${app.baseUrl}/claude/control/v1/account`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${first.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account_id: primary.id }),
    });
    assert.equal(backToPrimary.status, 200);
    assert.equal((await backToPrimary.json()).account_id, primary.id);
    const throughPrimary = await proxy(first.token, 'through-primary');
    assert.equal(throughPrimary.status, 200);
    await throughPrimary.arrayBuffer();
    assert.equal(app.upstreamRequests.at(-1).authorization, 'Bearer p3-primary-upstream-token');

    const secondStatus = await fetch(`${app.baseUrl}/claude/control/v1/status`, {
      headers: { 'X-Api-Key': second.token },
    });
    assert.equal(secondStatus.status, 200);
    const secondSummary = await secondStatus.json();
    assert.equal(secondSummary.device_id, second.device.id);
    assert.equal(secondSummary.account_id, primary.id);
    assert.equal(secondSummary.selected_account_id, primary.id);
    assert.deepEqual(secondSummary.allowed_account_ids, [primary.id]);
    assert.equal(app.store.resolveDeviceAccount(second.device.id).effective_account_id, primary.id);
    const secondForbidden = await fetch(`${app.baseUrl}/claude/control/v1/account`, {
      method: 'POST',
      headers: {
        'X-Api-Key': second.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account_id: secondary.id }),
    });
    assert.equal(secondForbidden.status, 403);
    const legacyProxy = await proxy(second.token, 'legacy-fallback-primary');
    assert.equal(legacyProxy.status, 200);
    await legacyProxy.arrayBuffer();
    assert.equal(app.upstreamRequests.at(-1).authorization, 'Bearer p3-primary-upstream-token');
    assert.equal(Object.hasOwn(legacySecond, 'allowed_account_ids'), false);
    assert.equal(Object.hasOwn(legacySecond, 'selected_account_id'), false);
    const crossTargetBody = await fetch(`${app.baseUrl}/claude/control/v1/account`, {
      method: 'POST',
      headers: {
        'X-Api-Key': first.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account_id: secondary.id, device_id: second.device.id }),
    });
    assert.equal(crossTargetBody.status, 400);
    assert.equal(app.store.resolveDeviceAccount(second.device.id).effective_account_id, primary.id);

    const toPlaceholder = await configure(first.device.id, placeholder.id);
    assert.equal(toPlaceholder.status, 303);
    const upstreamBeforePlaceholder = app.upstreamRequests.length;
    const unavailable = await proxy(first.token, 'placeholder-must-not-proxy');
    assert.equal(unavailable.status, 503);
    assert.equal(app.upstreamRequests.length, upstreamBeforePlaceholder);
    assert.equal(app.store.resolveDeviceAccount(first.device.id).effective_account_id, placeholder.id);

    const restorePrimary = await configure(first.device.id, primary.id);
    assert.equal(restorePrimary.status, 303);
    const restored = await proxy(first.token, 'restored-primary');
    assert.equal(restored.status, 200);
    await restored.arrayBuffer();
    assert.equal(app.upstreamRequests.at(-1).authorization, 'Bearer p3-primary-upstream-token');
    assert.equal(app.store.deviceByToken(first.token).id, first.device.id);
    await app.store.deleteAccount(placeholder.id);
    assert.deepEqual(
      app.store.deviceAccountSummary(first.device.id).allowed_account_ids,
      [primary.id, secondary.id],
    );

    app.requestMetrics.flush();
    assert.equal(
      app.requestMetrics.queryTotals({ scope: 'all', accountId: secondary.id }).requestCount,
      1,
    );
    assert.equal(
      app.requestMetrics.queryTotals({ scope: 'all', accountId: primary.id }).requestCount,
      3,
    );
    assert.equal(
      app.requestMetrics.queryTotals({ scope: 'all', accountId: placeholder.id }).requestCount,
      1,
    );

    const configureAudit = app.store.state.audit.find((event) => (
      event.event === 'device_account_configured'
      && event.next_account_id === secondary.id
    ));
    assert.equal(configureAudit.actor, 'anonymous');
    assert.equal(configureAudit.actor_kind, 'console');
    const apiAudit = app.store.state.audit.find((event) => (
      event.event === 'device_account_switched'
      && event.next_account_id === primary.id
    ));
    assert.equal(apiAudit.actor, `device:${first.device.id}`);
    assert.equal(apiAudit.actor_device_id, first.device.id);

    await app.store.revokeDevice(first.device.id);
    const revokedStatus = await fetch(`${app.baseUrl}/claude/control/v1/status`, {
      headers: { 'X-Api-Key': first.token },
    });
    assert.equal(revokedStatus.status, 401);
    const unaffected = await fetch(`${app.baseUrl}/claude/control/v1/status`, {
      headers: { 'X-Api-Key': second.token },
    });
    assert.equal(unaffected.status, 200);
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

// A Codex machine never contacts this console: it enrols against the dispenser and
// pulls from it. The dispenser's registry is therefore the only place its existence
// is written down, and this is the shape the console has to read it in.
async function codexClientsHome(clients) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-dispenser-'));
  await mkdir(join(home, 'clients'), { recursive: true });
  await writeFile(
    join(home, 'clients', 'clients.json'),
    `${JSON.stringify({ clients }, null, 2)}\n`,
  );
  return home;
}

function machineArticle(html, key) {
  const anchor = html.indexOf(`data-machine-key="${key}"`);
  assert.notEqual(anchor, -1, `machine ${key} should be rendered`);
  return html.slice(html.lastIndexOf('<article', anchor), html.indexOf('</article>', anchor));
}

function credentialRows(fragment, state) {
  const pattern = new RegExp(`<tr data-credential-state="${state}">([\\s\\S]*?)</tr>`, 'g');
  return [...fragment.matchAll(pattern)].map((match) => match[1]);
}

const MACHINE_HANDLE = 'kZ3nQx7Rw9TmVb2LpYs4Jc6H';

test('the device list renders as a machine inventory, Codex machines included', async () => {
  const digests = {
    codexActive: 'a1'.repeat(32),
    codexRevoked: 'b2'.repeat(32),
    codexLegacy: 'c3'.repeat(32),
  };
  const codexHome = await codexClientsHome([
    {
      name: 'work-laptop',
      machine_id: MACHINE_HANDLE,
      token_sha256: digests.codexActive,
      added_at: '2026-03-01T00:00:00.000Z',
      enrolled: true,
    },
    {
      name: 'work-laptop',
      machine_id: MACHINE_HANDLE,
      token_sha256: digests.codexRevoked,
      added_at: '2026-01-01T00:00:00.000Z',
      revoked: true,
      revoked_at: '2026-03-01T00:00:00.000Z',
      revoked_reason: 're-enrolled',
    },
    // Enrolled before handles existed. The console reads the dispenser's registry
    // and never writes it, so this one cannot be merged from here.
    { name: 'ancient-box', token_sha256: digests.codexLegacy, added_at: '2025-12-01T00:00:00.000Z' },
    // Written by another process across a trust boundary, so a value that is not a
    // handle must not be read as one. Coerced into a grouping key, `42` and `{}`
    // would collapse unrelated machines into one fabricated row (`machine:42`,
    // `machine:[object Object]`) and offer it as a merge target the store then
    // refuses — a machine on the page that exists nowhere else.
    { name: 'malformed-number', machine_id: 42, token_sha256: 'd4'.repeat(32) },
    { name: 'malformed-object', machine_id: {}, token_sha256: 'd5'.repeat(32) },
    { name: 'malformed-short', machine_id: 'short', token_sha256: 'd6'.repeat(32) },
    { name: 'malformed-empty', machine_id: '', token_sha256: 'd7'.repeat(32) },
    { name: 'malformed-charset', machine_id: 'has spaces in it and is long', token_sha256: 'd8'.repeat(32) },
  ]);
  const app = await fixture({ adminAuth: 'open' });
  try {
    const masterToken = 'sk-ant-oat01-master-token-that-must-never-render';
    const claude = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-max-1',
      emailLabel: 'owner@example.com',
      credential: { oauth_token: masterToken },
    });
    const codexAccount = await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      external: { kind: 'codex-credential', home: codexHome },
    });
    const live = await app.store.issueDeviceCredential({
      accountId: claude.id,
      memberLabel: 'alex',
      deviceName: 'work-laptop',
      machineId: MACHINE_HANDLE,
    });
    const retired = await app.store.issueDeviceCredential({
      accountId: claude.id,
      memberLabel: 'alex',
      deviceName: 'work-laptop-old',
      machineId: MACHINE_HANDLE,
    });
    await app.store.revokeDevice(retired.device.id);
    const unattributed = await app.store.issueDeviceCredential({
      accountId: claude.id,
      memberLabel: 'sam',
      deviceName: 'old-desktop',
    });

    const html = await (await fetch(`${app.baseUrl}/`)).text();

    // One machine, four credentials: the Claude issuance and the Codex enrollment
    // are the same box, and only the reported handle can say so.
    const machine = machineArticle(html, `machine:${MACHINE_HANDLE}`);
    assert.match(machine, /data-machine-legacy="false"/);
    assert.equal(credentialRows(machine, 'active').length, 2);
    assert.equal(credentialRows(machine, 'revoked').length, 2);
    assert.match(credentialRows(machine, 'active')[0], /work-laptop/);
    assert.match(credentialRows(machine, 'active')[1], /Codex/);

    // Revoked credentials are the majority of rows over time. They stay in the
    // page — and out of the way.
    const collapsed = machine.indexOf('<details data-revoked-credentials="2"');
    assert.notEqual(collapsed, -1);
    assert.equal(machine.includes('<details data-revoked-credentials="2" open'), false);
    assert.equal(
      machine.slice(0, collapsed).includes('data-credential-state="revoked"'),
      false,
      'a revoked credential belongs inside the collapsed section, not above it',
    );
    assert.match(machine.slice(collapsed), /<strong>work-laptop-old<\/strong>/);

    // Two rows nothing can attribute to a machine: one this console issued, one
    // the dispenser did. Neither is quietly folded into the machine above on the
    // strength of a matching name, and they are kept in a group of their own
    // rather than listed as if they were machines.
    // Seven, not two: the five malformed handles are each their own unattributed
    // row rather than a `machine:42` / `machine:[object Object]` group.
    const legacyGroup = html.indexOf('data-unattributed-credentials="7"');
    assert.notEqual(legacyGroup, -1);
    assert.ok(html.indexOf(`data-machine-key="machine:${MACHINE_HANDLE}"`) < legacyGroup);
    assert.ok(html.indexOf(`data-machine-key="issuance:${unattributed.device.id}"`) > legacyGroup);
    const legacy = machineArticle(html, `issuance:${unattributed.device.id}`);
    assert.match(legacy, /data-machine-legacy="true"/);
    assert.match(legacy, /data-i18n="legacy-no-handle"/);
    assert.match(legacy, new RegExp(`action="/devices/${unattributed.device.id}/machine"`));
    assert.match(legacy, new RegExp(`<option value="${MACHINE_HANDLE}"`));

    // Keyed by its position in the dispenser's registry, because there is nothing
    // else about it that is known to be unique.
    const codexLegacy = machineArticle(html, `codex:${codexAccount.id}:2`);
    assert.match(codexLegacy, /ancient-box/);
    assert.match(codexLegacy, /data-i18n="legacy-no-handle"/);
    assert.match(codexLegacy, /data-i18n="codex-legacy-note"/);
    assert.equal(codexLegacy.includes('/machine"'), false, 'the console cannot write the dispenser registry');

    // A value that is not a handle is read as no handle, never coerced into one.
    // Each malformed row keeps its own key, so nothing is grouped by `42`, and no
    // fabricated machine is offered as a merge target.
    for (const [index, name] of [
      [3, 'malformed-number'], [4, 'malformed-object'], [5, 'malformed-short'],
      [6, 'malformed-empty'], [7, 'malformed-charset'],
    ]) {
      const row = machineArticle(html, `codex:${codexAccount.id}:${index}`);
      assert.match(row, new RegExp(name), `${name} should keep a key of its own`);
      assert.match(row, /data-machine-legacy="true"/);
      assert.match(row, /data-i18n="legacy-no-handle"/);
    }
    assert.equal(html.includes('machine:42'), false);
    assert.equal(html.includes('[object Object]'), false);
    assert.equal(html.includes('machine:short'), false);
    // And the only handle the merge control offers is the one real one.
    assert.equal((legacy.match(/<option value="/g) ?? []).length, 1);

    // Nothing that authenticates anything reaches the page: not the provider
    // credential, not a device token, not even the digest of a dispenser bearer.
    for (const secret of [masterToken, live.token, retired.token, ...Object.values(digests)]) {
      assert.equal(html.includes(secret), false, 'the dashboard must render no credential material');
    }
  } finally {
    await app.close();
  }
});

test('a legacy row merges into a machine once, however many times it is submitted', async () => {
  const app = await fixture({ adminAuth: 'open' });
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-max-1',
      credential: { oauth_token: 'sk-ant-oat01-must-survive-a-merge' },
    });
    await app.store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'alex',
      deviceName: 'work-laptop',
      machineId: MACHINE_HANDLE,
    });
    const legacy = await app.store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'alex',
      deviceName: 'work-desktop',
    });
    const before = { ...app.store.publicDevices().find((row) => row.id === legacy.device.id) };

    const page = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());
    const merge = (body) => fetch(`${app.baseUrl}/devices/${legacy.device.id}/machine`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });

    // Guarded exactly like revoke and delete.
    const noCsrf = await merge({ machine_id: MACHINE_HANDLE });
    assert.equal(noCsrf.status, 403);
    assert.equal(app.store.publicDevices().find((row) => row.id === legacy.device.id).machine_id, undefined);

    // A handle nobody has reported would file the credential under a machine that
    // does not exist, which is worse than refusing.
    const unknown = await merge({ csrf, machine_id: 'unreported-machine-handle-zz' });
    assert.equal(unknown.status, 303);
    assert.match(unknown.headers.get('location'), /error=.*no%20such%20machine/);
    assert.equal(app.store.publicDevices().find((row) => row.id === legacy.device.id).machine_id, undefined);

    for (const attempt of [1, 2]) {
      const response = await merge({ csrf, machine_id: MACHINE_HANDLE });
      assert.equal(response.status, 303, `merge attempt ${attempt}`);
      assert.equal(response.headers.get('location'), '/');
    }

    // Additive: the handle appears, nothing else about the row moved, and the
    // account's credential is neither touched nor re-encrypted.
    const after = app.store.publicDevices().find((row) => row.id === legacy.device.id);
    assert.deepEqual(after, { ...before, machine_id: MACHINE_HANDLE });
    assert.deepEqual(app.store.accountCredential(account.id), {
      oauth_token: 'sk-ant-oat01-must-survive-a-merge',
    });
    assert.equal(
      app.store.state.audit.filter((event) => event.event === 'device_machine_merged').length,
      1,
      'a repeated merge must not be recorded as a second change',
    );

    // Both credentials now read as one machine, and it is no longer offered a merge.
    const html = await (await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } })).text();
    const machine = machineArticle(html, `machine:${MACHINE_HANDLE}`);
    assert.equal(credentialRows(machine, 'active').length, 2);
    assert.equal(html.includes(`/devices/${legacy.device.id}/machine`), false);
  } finally {
    await app.close();
  }
});

test('a legacy row files under a machine only the dispenser knows about', async () => {
  // The headline use case. A Claude credential is issued from a browser, which has
  // no handle to report, while the same box enrolled with the Codex agent and does
  // — in the dispenser's registry, which this console reads and never writes. If
  // the allowlist were built from Claude devices alone the documented workflow
  // would fail closed with "no such machine is currently listed" and there would
  // be nothing else to merge into.
  const codexOnlyHandle = 'dispenser-only-handle-77777777';
  const codexHome = await codexClientsHome([
    { name: 'codex-box', machine_id: codexOnlyHandle, token_sha256: 'e1'.repeat(32), added_at: '2026-02-01T00:00:00.000Z' },
  ]);
  const app = await fixture({ adminAuth: 'open' });
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-max-1',
      credential: { oauth_token: 'sk-ant-oat01-must-survive-a-merge' },
    });
    await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      external: { kind: 'codex-credential', home: codexHome },
    });
    const legacy = await app.store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'alex',
      deviceName: 'work-laptop',
    });
    // No Claude device carries this handle, so it can only have come from
    // clients.json.
    assert.deepEqual(app.store.publicDevices().map((row) => row.machine_id), [undefined]);

    const page = await fetch(`${app.baseUrl}/`);
    const cookie = cookieFrom(page);
    const rendered = await page.text();
    const csrf = csrfFrom(rendered);
    assert.match(
      machineArticle(rendered, `issuance:${legacy.device.id}`),
      new RegExp(`<option value="${codexOnlyHandle}"`),
    );

    const merged = await fetch(`${app.baseUrl}/devices/${legacy.device.id}/machine`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, machine_id: codexOnlyHandle }),
    });
    assert.equal(merged.status, 303);
    assert.equal(merged.headers.get('location'), '/');
    assert.equal(
      app.store.publicDevices().find((row) => row.id === legacy.device.id).machine_id,
      codexOnlyHandle,
    );

    // And the two credentials now read as one machine.
    const html = await (await fetch(`${app.baseUrl}/`, { headers: { Cookie: cookie } })).text();
    assert.equal(credentialRows(machineArticle(html, `machine:${codexOnlyHandle}`), 'active').length, 2);
  } finally {
    await app.close();
  }
});

test('a revoked credential does not make its account read as a problem', async () => {
  const app = await fixture({ adminAuth: 'open' });
  try {
    const account = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-max-1',
      credential: { oauth_token: 'sk-ant-oat01-healthy' },
    });
    await app.store.updateAccountHealth(account.id, { success: true });
    const device = await app.store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'alex',
      deviceName: 'lost-laptop',
      machineId: MACHINE_HANDLE,
    });
    await app.store.revokeDevice(device.device.id);

    const html = await (await fetch(`${app.baseUrl}/`)).text();
    const machine = machineArticle(html, `machine:${MACHINE_HANDLE}`);
    const [revoked] = credentialRows(machine, 'revoked');

    // Two facts, two columns: the credential is gone, the account behind it is not.
    assert.match(revoked, /data-account-status="healthy"/);
    assert.match(revoked, /data-i18n="status-healthy"/);
    assert.match(revoked, /data-i18n="credential-revoked"/);
    // And the account's own vocabulary is no longer borrowed to describe a device,
    // which is what made a retired laptop read as an outage.
    assert.equal(revoked.includes('badge expired'), false);
    assert.equal(app.store.publicAccounts()[0].status, 'healthy');
  } finally {
    await app.close();
  }
});

test('a Codex credential home the console cannot read costs its machines, not the page', async () => {
  // A registry that exists and cannot be parsed. This is the case the banner is
  // for: something is there, and the console genuinely does not know what.
  const unreadableHome = await codexClientsHome([]);
  await writeFile(join(unreadableHome, 'clients', 'clients.json'), 'not json at all\n');
  const app = await fixture({ adminAuth: 'open' });
  try {
    const claude = await app.store.addAccount({
      provider: 'claude',
      alias: 'claude-max-1',
      credential: { oauth_token: 'sk-ant-oat01-master' },
    });
    await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      external: { kind: 'codex-credential', home: unreadableHome },
    });
    await app.store.issueDeviceCredential({
      accountId: claude.id,
      memberLabel: 'alex',
      deviceName: 'work-laptop',
      machineId: MACHINE_HANDLE,
    });

    const response = await fetch(`${app.baseUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-i18n="codex-inventory-unavailable"/);
    assert.match(html, /codex-shared-1/);
    // Degraded, not blank: everything the console knows on its own still renders.
    assert.match(machineArticle(html, `machine:${MACHINE_HANDLE}`), /work-laptop/);
  } finally {
    await app.close();
  }
});

test('a Codex home nothing has enrolled against yet is not reported as unreadable', async () => {
  // Exactly what `seedCodexCredentialHome` leaves behind: CodexCredentialStore.init()
  // creates secret/ and public/, and clients/ does not exist until the first
  // /enroll or add-client.js. Reporting that as a home the console could not read
  // put a permanent degradation banner on every freshly authorized Codex account,
  // which is how an operator learns to ignore the banner that means something.
  const seededHome = await mkdtemp(join(tmpdir(), 'credential-console-seeded-'));
  await mkdir(join(seededHome, 'secret'), { recursive: true, mode: 0o700 });
  await mkdir(join(seededHome, 'public'), { recursive: true, mode: 0o750 });
  await writeFile(
    join(seededHome, 'public', 'current.json'),
    JSON.stringify({
      access_token: 'a',
      account_id: 'fixture-account',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  const app = await fixture({ adminAuth: 'open' });
  try {
    const codexAccount = await app.store.addAccount({
      provider: 'codex',
      alias: 'codex-shared-1',
      external: { kind: 'codex-credential', home: seededHome },
    });

    const html = await (await fetch(`${app.baseUrl}/`)).text();

    assert.equal(
      html.includes('data-i18n="codex-inventory-unavailable"'),
      false,
      'no machine has enrolled yet — that is not a home the console failed to read',
    );
    // And the account itself reads as what it is, rather than degraded — the two
    // readers of that same file used to disagree about this one home, one of them
    // silently and one of them in a banner.
    assert.match(html, /codex-shared-1/);
    assert.match(html, /data-i18n="status-healthy"/);
    assert.equal(html.includes('data-i18n="status-unhealthy"'), false);
    assert.equal(codexAccount.external.home, seededHome);
  } finally {
    await app.close();
  }
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
