import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  CodexManagedDomainRefresher,
  codexSeedHomeForAccount,
  isManagedCodexHome,
  refreshManagedCodexHome,
  validateManagedCodexRoot,
} from '../lib/codex-managed-domains.js';
import { seedCodexCredentialHome } from '../lib/codex-seed.js';
import { syntheticCodexTokens } from './codex-token-fixture.js';

const root = '/var/lib/credential-console/codex-accounts';

function account(id, extra = {}) {
  return { id, provider: 'codex', alias: id, ...extra };
}

test('a bound Codex account keeps its existing home when managed accounts are enabled', () => {
  const existing = account('codex-existing', {
    external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
  });
  assert.equal(codexSeedHomeForAccount(existing, {
    managedRoot: root,
    legacySeedHome: '/legacy/ignored',
  }), '/var/lib/codex-credential');
  assert.equal(isManagedCodexHome(existing, root), false);
});

test('each new Codex account receives a stable distinct managed home', () => {
  const first = account('codex_first');
  const second = account('codex_second');
  assert.equal(codexSeedHomeForAccount(first, { managedRoot: root }), join(root, first.id));
  assert.equal(codexSeedHomeForAccount(second, { managedRoot: root }), join(root, second.id));
  assert.notEqual(
    codexSeedHomeForAccount(first, { managedRoot: root }),
    codexSeedHomeForAccount(second, { managedRoot: root }),
  );
});

test('the legacy single home remains unchanged until a managed root is configured', () => {
  assert.equal(codexSeedHomeForAccount(account('legacy'), {
    legacySeedHome: '/var/lib/./codex-credential',
  }), '/var/lib/codex-credential');
});

test('a managed root must stay inside the credential console state directory', () => {
  assert.equal(
    validateManagedCodexRoot('/var/lib/credential-console/codex-accounts', '/var/lib/credential-console'),
    '/var/lib/credential-console/codex-accounts',
  );
  for (const invalid of [
    '/var/lib/credential-console',
    '/var/lib',
    '/var/lib/credential-console/../other',
  ]) {
    assert.throws(
      () => validateManagedCodexRoot(invalid, '/var/lib/credential-console'),
      /must be a child/,
    );
  }
});

test('managed-home classification requires the exact account path', () => {
  assert.equal(isManagedCodexHome(account('expected', {
    external: { kind: 'codex-credential', home: join(root, 'expected') },
  }), root), true);
  assert.equal(isManagedCodexHome(account('expected', {
    external: { kind: 'codex-credential', home: join(root, 'somewhere-else') },
  }), root), false);
  assert.equal(isManagedCodexHome(account('expected', {
    external: { kind: 'codex-credential', home: join(root, 'expected', 'nested') },
  }), root), false);
});

test('the managed refresher never touches legacy, imported, Claude, or unbound accounts', async () => {
  const calls = [];
  const logs = [];
  const accounts = [
    account('managed', { external: { kind: 'codex-credential', home: join(root, 'managed') } }),
    account('legacy', { external: { kind: 'codex-credential', home: '/var/lib/codex-credential' } }),
    account('unbound'),
    { id: 'claude', provider: 'claude', external: { kind: 'codex-credential', home: join(root, 'claude') } },
  ];
  const refresher = new CodexManagedDomainRefresher({
    accounts: () => accounts,
    managedRoot: root,
    refreshHome: async (home, selected) => calls.push([home, selected.id]),
    log: (event, detail) => logs.push([event, detail]),
  });

  assert.deepEqual(await refresher.runNow(), { refreshed: ['managed'], failed: [] });
  assert.deepEqual(calls, [[resolve(root, 'managed'), 'managed']]);
  assert.equal(logs[0][0], 'codex_managed_refresh_completed');
});

test('one managed refresh failure does not stop the remaining accounts', async () => {
  const accounts = ['first', 'second'].map((id) => account(id, {
    external: { kind: 'codex-credential', home: join(root, id) },
  }));
  const refresher = new CodexManagedDomainRefresher({
    accounts: () => accounts,
    managedRoot: root,
    refreshHome: async (_home, selected) => {
      if (selected.id === 'first') throw Object.assign(new Error('synthetic'), { code: 'REFRESH_FAILED' });
    },
  });

  assert.deepEqual(await refresher.runNow(), { refreshed: ['second'], failed: ['first'] });
});

test('the managed refresher runs the real expiry-aware refresh entrypoint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-managed-refresh-'));
  const tokens = syntheticCodexTokens({ lifetimeSeconds: 10 * 24 * 60 * 60 });
  await seedCodexCredentialHome(home, {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.accountId,
    },
  });
  const credentialPath = join(home, 'secret', 'credential.json');
  const before = await readFile(credentialPath);

  await refreshManagedCodexHome(home);

  assert.deepEqual(await readFile(credentialPath), before, 'a fresh token must not rotate');
  const health = JSON.parse(await readFile(join(home, 'public', 'health.json'), 'utf8'));
  assert.equal(health.last_outcome, 'fresh');
});
