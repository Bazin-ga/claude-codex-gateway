import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { externalAccountStatus } from '../server.js';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

async function home({ current = null, health = undefined, clients = undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'credential-alert-status-'));
  await mkdir(join(root, 'public'), { recursive: true });
  if (current !== null) await writeFile(join(root, 'public', 'current.json'), JSON.stringify(current));
  if (health !== undefined) await writeFile(join(root, 'public', 'health.json'), JSON.stringify(health));
  if (clients !== undefined) {
    await mkdir(join(root, 'clients'), { recursive: true });
    await writeFile(join(root, 'clients', 'clients.json'), JSON.stringify(clients));
  }
  return root;
}

function account(path) {
  return { id: 'account-id', provider: 'codex', status: 'stored', external: { kind: 'codex-credential', home: path } };
}

function validHealth() {
  return {
    version: 1,
    updated_at: new Date(NOW - 60_000).toISOString(),
    expected_interval_seconds: 3600,
    last_cycle_started_at: new Date(NOW - 120_000).toISOString(),
    last_cycle_finished_at: new Date(NOW - 60_000).toISOString(),
    last_outcome: 'fresh',
    last_success_at: new Date(NOW - 60_000).toISOString(),
    last_refresh_at: new Date(NOW - 60_000).toISOString(),
    quarantine: { present: false },
    access: { present: true, valid: true, expires_at: new Date(NOW + 30 * 86400_000).toISOString(), remaining_seconds: 30 * 86400 },
  };
}

test('external Codex status validates current metadata and keeps secrets out of its result', async () => {
  const accessToken = 'access-token-never-returned';
  const accountId = 'account-id-never-returned';
  const path = await home({
    current: { access_token: accessToken, account_id: accountId, expires_at: new Date(NOW + 3 * 86400_000).toISOString() },
    health: validHealth(),
    clients: { clients: [{ revoked: false }, { revoked: true }] },
  });
  const result = await externalAccountStatus(account(path), { now: NOW });
  assert.equal(result.status, 'healthy');
  assert.equal(result.current_status, 'healthy');
  assert.equal(result.active_devices, 1);
  assert.equal(result.refresh_health.last_outcome, 'fresh');
  assert.equal(JSON.stringify(result).includes(accessToken), false);
  assert.equal(JSON.stringify(result).includes(accountId), false);
});

test('current expiry is authoritative over a stale health expiry and expired is classified', async () => {
  const path = await home({
    current: { access_token: 'token', account_id: 'id', expires_at: new Date(NOW - 1).toISOString() },
    health: {
      ...validHealth(),
      access: { present: true, valid: true, expires_at: new Date(NOW + 30 * 86400_000).toISOString() },
    },
  });
  const result = await externalAccountStatus(account(path), { now: NOW });
  assert.equal(result.status, 'expired');
  assert.equal(result.expires_at, new Date(NOW - 1).toISOString());
});

test('future expiry without required public fields is invalid, and absent current is unavailable', async () => {
  const invalidPath = await home({
    current: { access_token: '', account_id: '', expires_at: new Date(NOW + 86400_000).toISOString() },
    health: validHealth(),
  });
  const unavailablePath = await home({ health: validHealth() });
  assert.equal((await externalAccountStatus(account(invalidPath), { now: NOW })).status, 'invalid');
  assert.equal((await externalAccountStatus(account(unavailablePath), { now: NOW })).status, 'unavailable');
});

test('missing and malformed health are safe categories with no exception/path leakage', async () => {
  const missing = await home({ current: { access_token: 'token', account_id: 'id', expires_at: new Date(NOW + 86400_000).toISOString() } });
  const malformed = await home({
    current: { access_token: 'token', account_id: 'id', expires_at: new Date(NOW + 86400_000).toISOString() },
    health: { version: 2, last_failure: '/private/path/token' },
  });
  const missingResult = await externalAccountStatus(account(missing), { now: NOW });
  const malformedResult = await externalAccountStatus(account(malformed), { now: NOW });
  assert.equal(missingResult.refresh_health_status, 'missing');
  assert.equal(malformedResult.refresh_health_status, 'invalid');
  for (const result of [missingResult, malformedResult]) {
    assert.equal(JSON.stringify(result).includes('/private/path/token'), false);
    assert.equal(JSON.stringify(result).includes('last_failure'), false);
  }
});

test('health accepts only the refresh-center enum and bounded integer contract', async () => {
  const current = {
    access_token: 'token',
    account_id: 'id',
    expires_at: new Date(NOW + 86400_000).toISOString(),
  };
  for (const badHealth of [
    { ...validHealth(), last_outcome: 'success' },
    { ...validHealth(), expected_interval_seconds: 1.5 },
    { ...validHealth(), expected_interval_seconds: 31 * 86400 },
    { ...validHealth(), access: { ...validHealth().access, remaining_seconds: 1.5 } },
  ]) {
    const path = await home({ current, health: badHealth });
    const result = await externalAccountStatus(account(path), { now: NOW });
    assert.equal(result.refresh_health_status, 'invalid');
    assert.equal(result.refresh_health, null);
  }
});

test('status reads are observational and do not mutate public metadata', async () => {
  const current = { access_token: 'token', account_id: 'id', expires_at: new Date(NOW + 86400_000).toISOString() };
  const health = validHealth();
  const path = await home({ current, health });
  const before = await Promise.all([
    readFile(join(path, 'public', 'current.json'), 'utf8'),
    readFile(join(path, 'public', 'health.json'), 'utf8'),
  ]);
  await externalAccountStatus(account(path), { now: NOW });
  const after = await Promise.all([
    readFile(join(path, 'public', 'current.json'), 'utf8'),
    readFile(join(path, 'public', 'health.json'), 'utf8'),
  ]);
  assert.deepEqual(after, before);
});
