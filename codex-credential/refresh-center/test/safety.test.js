import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Alerter } from '../lib/alert.js';
import { CredentialStore } from '../lib/credential-store.js';
import { refresh, RefreshError } from '../lib/oauth.js';
import { classifyRefreshAttempt } from '../refresh.js';

test('a non-2xx alert webhook is reported as a delivery failure', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const alerter = new Alerter({
      webhookUrl: 'https://alerts.invalid/hook',
      host: 'test-host',
      fetchImpl: async () => new Response('', { status: 500 }),
    });
    assert.equal(await alerter.send('critical', 'test alert'), false);
    assert.match(errors.at(-1), /webhook returned HTTP 500/);
  } finally {
    console.error = originalError;
  }
});

test('refresh attempt quarantine is exclusive, durable, and clearable', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-refresh-store-'));
  try {
    const store = new CredentialStore(home);
    await store.init();
    await store.beginRefreshAttempt({ refresh_token: 'fingerprint', access_token: 'access-fingerprint' });
    assert.equal((await store.readRefreshAttempt()).refresh_token, 'fingerprint');
    await assert.rejects(
      store.beginRefreshAttempt({ refresh_token: 'second' }),
      (error) => error.code === 'EEXIST',
    );
    await store.clearRefreshAttempt();
    assert.equal(await store.readRefreshAttempt(), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('seed and refresh operations cannot overlap', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-operation-lock-'));
  try {
    const store = new CredentialStore(home);
    await store.init();
    const release = await store.acquireOperation('refresh');
    await assert.rejects(store.acquireOperation('seed'), /already running/);
    await release();
    const releaseSeed = await store.acquireOperation('seed');
    await releaseSeed();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('operation lock reclaims a PID reused after another kernel boot', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-stale-lock-'));
  try {
    const store = new CredentialStore(home);
    await store.init();
    await writeFile(store.operationLockPath, JSON.stringify({
      operation: 'refresh',
      pid: process.pid,
      boot_id: 'different-boot-id',
      process_start_time: '1',
    }));
    const release = await store.acquireOperation('seed');
    await release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('public credential is group-readable and never includes a refresh token', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-public-store-'));
  try {
    const store = new CredentialStore(home);
    await store.init();
    await store.publish({
      tokens: {
        access_token: 'access',
        id_token: 'identity',
        account_id: 'account',
        refresh_token: 'must-not-publish',
      },
    }, new Date(Date.now() + 60_000));
    assert.equal((await stat(store.publicPath)).mode & 0o777, 0o640);
    const published = JSON.parse(await readFile(store.publicPath, 'utf8'));
    assert.equal(Object.hasOwn(published, 'refresh_token'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('only explicit pre-mint OAuth rejections clear quarantine', async () => {
  await assert.rejects(
    refresh('token', {
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'invalid_request' } }), {
        status: 400,
      }),
    }),
    (error) => error instanceof RefreshError && error.tokenLikelyConsumed === false,
  );
  for (const response of [
    new Response(JSON.stringify({ error: { code: 'invalid_grant' } }), { status: 400 }),
    new Response('<html>gateway</html>', { status: 400 }),
    new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 }),
  ]) {
    await assert.rejects(
      refresh('token', { fetchImpl: async () => response }),
      (error) => error instanceof RefreshError && error.tokenLikelyConsumed === true,
    );
  }
});

test('OAuth deadline covers a response body that stalls after headers', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    refresh('token', {
      timeoutMs: 20,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        text: async () => new Promise(() => {}),
      }),
    }),
    (error) => error instanceof RefreshError && error.tokenLikelyConsumed === true,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test('refresh crash recovery distinguishes unchanged from durably committed credentials', () => {
  const oldCredential = { tokens: { refresh_token: 'old-refresh', access_token: 'old-access' } };
  const marker = {
    refresh_token: CredentialStore.fingerprint(oldCredential.tokens.refresh_token),
    access_token: CredentialStore.fingerprint(oldCredential.tokens.access_token),
  };
  assert.equal(classifyRefreshAttempt(marker, oldCredential), 'quarantine');
  assert.equal(classifyRefreshAttempt(marker, {
    tokens: { refresh_token: 'new-refresh', access_token: 'new-access' },
  }), 'committed');
  assert.equal(classifyRefreshAttempt({ refresh_token: marker.refresh_token }, oldCredential), 'quarantine');
});
