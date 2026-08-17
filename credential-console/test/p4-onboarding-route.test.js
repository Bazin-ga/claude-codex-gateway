import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';

const ADMIN = { 'Tailscale-User-Login': 'p4-admin@example.com' };
const TOKEN_CANARY = 'sk-ant-api03-p4-route-token-canary';
const DIGEST_CANARY = 'p4-route-digest-canary';
const CREDENTIAL_CANARY = 'p4-route-credential-canary';
const ENROLLMENT_CANARY = 'p4-route-enrollment-key-canary';
const EXTERNAL_CANARY = '/var/lib/codex-credential/p4-route-canary';

async function createHarness(t, { adminAuth, publicBaseUrl }) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-p4-onboarding-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  await store.addAccount({
    provider: 'claude',
    alias: 'p4-route-primary',
    credential: {
      oauth_token: CREDENTIAL_CANARY,
      token: TOKEN_CANARY,
      token_sha256: DIGEST_CANARY,
      audit: [{ secret: ENROLLMENT_CANARY }],
      external: { home: EXTERNAL_CANARY },
    },
  });
  const usageMonitor = {
    snapshotForAccount: () => null,
    refreshAccount: async () => null,
    stop() {},
  };
  const created = await createCredentialConsole({
    store,
    adminAuth,
    publicBaseUrl,
    requestMetrics: null,
    usageMonitor,
    claudeGatewayUrl: 'https://configured-gateway.example:10000/claude',
    codexEndpoint: 'https://configured-codex.example:8443',
    codexCertPin: 'ab'.repeat(32),
  });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return { baseUrl, created, store };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] ?? null;
}

async function bodyOf(response) {
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

function assertNoCanaries(markdown) {
  for (const canary of [
    TOKEN_CANARY,
    DIGEST_CANARY,
    CREDENTIAL_CANARY,
    ENROLLMENT_CANARY,
    EXTERNAL_CANARY,
  ]) assert.equal(markdown.includes(canary), false, canary);
  for (const forbidden of ['token_sha256', 'oauth_token', 'audit', 'external', 'enrollment_key']) {
    assert.equal(markdown.includes(forbidden), false, forbidden);
  }
}

test('open mode serves live Markdown without leaking canaries', async (t) => {
  const { baseUrl, store } = await createHarness(t, {
    adminAuth: 'open',
    publicBaseUrl: 'https://configured-console.example/private',
  });
  const first = await fetch(`${baseUrl}/onboarding.md`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const firstMarkdown = await bodyOf(first);
  assert.match(firstMarkdown, /# Internal AI onboarding guide/);
  assert.match(firstMarkdown, /p4-route-primary/);
  assert.match(firstMarkdown, /configured-console\.example\/private/);
  assert.match(firstMarkdown, /configured-gateway\.example:10000\/claude/);
  assertNoCanaries(firstMarkdown);
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.client_config_version, '2');
  assert.match(firstMarkdown, /"client_config_version":"2"/);

  await store.addAccount({
    provider: 'claude',
    alias: 'p4-route-added-live',
    credential: { oauth_token: 'second-account-credential-canary' },
  });
  const second = await fetch(`${baseUrl}/onboarding.md`);
  const secondMarkdown = await bodyOf(second);
  assert.match(secondMarkdown, /p4-route-added-live/);
  assertNoCanaries(secondMarkdown);
});

test('tailscale mode requires identity, then serves Markdown with the bound session', async (t) => {
  const { baseUrl } = await createHarness(t, {
    adminAuth: 'tailscale',
    publicBaseUrl: 'https://configured-console.example',
  });
  const noIdentity = await fetch(`${baseUrl}/onboarding.md`);
  assert.equal(noIdentity.status, 403);

  const dashboard = await fetch(`${baseUrl}/`, { headers: ADMIN });
  assert.equal(dashboard.status, 200);
  const cookie = cookieFrom(dashboard);
  assert.ok(cookie);
  const guide = await fetch(`${baseUrl}/onboarding.md`, {
    headers: { ...ADMIN, Cookie: cookie },
  });
  assert.equal(guide.status, 200);
  assert.equal(guide.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assertNoCanaries(await bodyOf(guide));
});

test('non-GET guide requests return 405 and Allow without minting a guide', async (t) => {
  const { baseUrl } = await createHarness(t, {
    adminAuth: 'open',
    publicBaseUrl: 'https://configured-console.example',
  });
  const response = await fetch(`${baseUrl}/onboarding.md`, {
    method: 'POST',
    body: 'ignored',
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal((response.headers.get('content-type') ?? '').startsWith('text/markdown'), false);
  assert.equal((await bodyOf(response)).includes('# Internal AI onboarding guide'), false);
});

test('configured URLs win over a hostile Host header and /claude/onboarding.md does not leak guide content', async (t) => {
  const { baseUrl } = await createHarness(t, {
    adminAuth: 'open',
    publicBaseUrl: 'https://configured-console.example/private',
  });
  const guide = await fetch(`${baseUrl}/onboarding.md`, {
    headers: { Host: 'evil.example/host-injection' },
  });
  const markdown = await bodyOf(guide);
  assert.equal(guide.status, 200);
  assert.match(markdown, /configured-console\.example\/private/);
  assert.equal(markdown.includes('evil.example'), false);
  assert.equal(markdown.includes('host-injection'), false);

  const publicMount = await fetch(`${baseUrl}/claude/onboarding.md`);
  const publicBody = await bodyOf(publicMount);
  assert.notEqual(publicMount.status, 200);
  assert.equal(publicBody.includes('# Internal AI onboarding guide'), false);
});

test('guide response marks live route as non-cacheable and nosniff', async (t) => {
  const { baseUrl } = await createHarness(t, {
    adminAuth: 'open',
    publicBaseUrl: 'https://configured-console.example',
  });
  const response = await fetch(`${baseUrl}/onboarding.md`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('dashboard copy link reuses URL sanitization and hides unusable localhost fallbacks', async (t) => {
  const passwordCanary = 'copy-link-password-canary';
  const queryCanary = 'copy-link-query-canary';
  const sanitized = await createHarness(t, {
    adminAuth: 'open',
    publicBaseUrl: `https://user:${passwordCanary}@configured-console.example/private?secret=${queryCanary}#fragment-canary`,
  });
  const safeDashboard = await fetch(`${sanitized.baseUrl}/`);
  const safeHtml = await bodyOf(safeDashboard);
  assert.equal(safeDashboard.status, 200);
  assert.match(safeHtml, /https:\/\/configured-console\.example\/private\/onboarding\.md/);
  assert.equal(safeHtml.includes(passwordCanary), false);
  assert.equal(safeHtml.includes(queryCanary), false);
  assert.equal(safeHtml.includes('fragment-canary'), false);
  const appScript = await (await fetch(`${sanitized.baseUrl}/assets/app.js`)).text();
  assert.doesNotThrow(() => new Function(appScript), 'copy-link browser script must parse');
  assert.match(appScript, /document\.execCommand\('copy'\)/);

  const localhost = await createHarness(t, {
    adminAuth: 'open',
    publicBaseUrl: 'http://127.0.0.1:9080',
  });
  const localDashboard = await fetch(`${localhost.baseUrl}/`);
  const localHtml = await bodyOf(localDashboard);
  assert.equal(localDashboard.status, 200);
  assert.equal(localHtml.includes('id="onboarding-guide-link"'), false);
  assert.equal(localHtml.includes('127.0.0.1:9080/onboarding.md'), false);
});
