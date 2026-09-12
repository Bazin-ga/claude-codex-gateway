import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import {
  CodexManagedDomainRefresher,
  codexSeedHomeForAccount,
  isManagedCodexHome,
  readPublishedCodexExpiry,
  refreshManagedCodexHome,
  validateManagedCodexRoot,
} from '../lib/codex-managed-domains.js';
import { seedCodexCredentialHome } from '../lib/codex-seed.js';
import { syntheticCodexTokens } from './codex-token-fixture.js';

const root = '/var/lib/credential-console/codex-accounts';

function account(id, extra = {}) {
  return { id, provider: 'codex', alias: id, ...extra };
}

test('a bound Codex account keeps its existing home only when explicit writer mode covers it', () => {
  const existing = account('codex-existing', {
    external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
  });
  assert.equal(codexSeedHomeForAccount(existing, {
    managedRoot: root,
    legacySeedHome: '/var/lib/codex-credential',
  }), '/var/lib/codex-credential');
  assert.equal(isManagedCodexHome(existing, root), false);
});

test('an imported home stays read-only when no explicit writer mode covers it', () => {
  const imported = account('codex-imported', {
    external: { kind: 'codex-credential', home: '/var/lib/imported-codex' },
  });
  assert.equal(codexSeedHomeForAccount(imported), null);
  assert.equal(codexSeedHomeForAccount(imported, { managedRoot: root }), null);
  assert.equal(codexSeedHomeForAccount(imported, {
    legacySeedHome: '/var/lib/different-home',
  }), '/var/lib/different-home');
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

test('the managed refresher never runs against legacy, imported, Claude, or unbound accounts', async () => {
  const calls = [];
  const reads = [];
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
    // Reading the legacy home is expected; running the refresh entrypoint
    // against it is the thing that would race its external owner.
    readPublishedExpiry: async (home) => {
      reads.push(home);
      return '2030-01-02T03:04:05.000Z';
    },
    recordExpiry: async () => true,
    log: (event, detail) => logs.push([event, detail]),
  });

  assert.deepEqual(await refresher.runNow(), {
    refreshed: ['managed'],
    failed: [],
    mirrored: ['legacy'],
  });
  assert.deepEqual(calls, [[resolve(root, 'managed'), 'managed']]);
  assert.deepEqual(reads, ['/var/lib/codex-credential']);
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

  assert.deepEqual(await refresher.runNow(), {
    refreshed: ['second'],
    failed: ['first'],
    mirrored: [],
  });
});

test('the managed refresher persists each refreshed published expiry', async () => {
  const managed = account('expiry', {
    external: { kind: 'codex-credential', home: join(root, 'expiry') },
  });
  const recorded = [];
  const refresher = new CodexManagedDomainRefresher({
    accounts: () => [managed],
    managedRoot: root,
    refreshHome: async () => ({ expiresAt: '2030-01-02T03:04:05.000Z' }),
    recordExpiry: async (id, expiresAt) => recorded.push([id, expiresAt]),
  });

  assert.deepEqual(await refresher.runNow(), {
    refreshed: ['expiry'],
    failed: [],
    mirrored: [],
  });
  assert.deepEqual(recorded, [['expiry', '2030-01-02T03:04:05.000Z']]);
});

// The bug this mirror exists for: an externally refreshed home rotates its
// credential on its own timer and tells nobody, so the console's copy of the
// expiry ages past `now` while the credential is still good for another week.
// `#assertSwitchableAccount` gates on that copy, so the dashboard — which reads
// current.json — kept offering the account as a healthy switch target that the
// store then refused.
test('an externally refreshed account becomes switchable again once its published expiry is mirrored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-external-home-'));
  const consoleHome = await mkdtemp(join(tmpdir(), 'codex-mirror-console-'));
  const published = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  await mkdir(join(home, 'public'), { recursive: true });
  await writeFile(join(home, 'public', 'current.json'), JSON.stringify({
    access_token: 'synthetic-access-token',
    account_id: 'synthetic-account',
    expires_at: published,
  }));

  const store = await new CredentialStore(consoleHome, { allowKeyInit: true }).init();
  const managed = await store.addAccount({
    provider: 'codex',
    alias: 'codex-managed',
    external: { kind: 'codex-credential', home: join(root, 'codex-managed') },
    expiresAt: published,
  });
  const external = await store.addAccount({
    provider: 'codex',
    alias: 'codex-external',
    external: { kind: 'codex-credential', home },
    // What the console recorded when the account was bound, days ago.
    expiresAt: new Date(Date.now() - 4 * 24 * 60 * 60_000).toISOString(),
  });
  const issued = await store.issueDeviceCredential({
    accountId: managed.id,
    memberLabel: 'member',
    deviceName: 'laptop',
  });

  await assert.rejects(
    store.configureDeviceAccount({
      deviceId: issued.device.id,
      selectedAccountId: external.id,
      actor: 'admin',
    }),
    (error) => error.code === 'ACCOUNT_UNAVAILABLE',
  );

  const refresher = new CodexManagedDomainRefresher({
    accounts: () => store.state.accounts,
    managedRoot: root,
    refreshHome: async () => { throw new Error('the external home must not be refreshed here'); },
    recordExpiry: (id, expiresAt) => store.updateExternalAccountExpiry(id, expiresAt),
  });
  const outcome = await refresher.runNow();
  assert.deepEqual(outcome.mirrored, [external.id]);
  assert.equal(store.accountById(external.id).expires_at, published);

  const summary = await store.configureDeviceAccount({
    deviceId: issued.device.id,
    selectedAccountId: external.id,
    actor: 'admin',
  });
  assert.equal(summary.selected_account_id, external.id);

  await rm(home, { recursive: true, force: true });
  await rm(consoleHome, { recursive: true, force: true });
});

test('the expiry mirror runs on a deployment that configures no managed root at all', async () => {
  const recorded = [];
  const refresher = new CodexManagedDomainRefresher({
    accounts: () => [account('external', {
      external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
    })],
    managedRoot: null,
    readPublishedExpiry: async () => '2030-01-02T03:04:05.000Z',
    recordExpiry: async (id, expiresAt) => {
      recorded.push([id, expiresAt]);
      return true;
    },
  });

  assert.deepEqual(await refresher.runNow(), {
    refreshed: [],
    failed: [],
    mirrored: ['external'],
  });
  assert.deepEqual(recorded, [['external', '2030-01-02T03:04:05.000Z']]);
});

// Conservative on purpose: the previous value is what the console believed a
// moment ago, and a home it cannot read is already reported by the credential
// alert panel. Overwriting the expiry with nothing would turn an unreadable
// directory into an account that silently stops being switchable.
test('a home whose published expiry cannot be read leaves the stored value alone', async () => {
  const logs = [];
  const refresher = new CodexManagedDomainRefresher({
    accounts: () => [account('external', {
      external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
    })],
    managedRoot: root,
    readPublishedExpiry: async () => {
      throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    },
    recordExpiry: async () => { throw new Error('an unreadable home must record nothing'); },
    log: (event, detail) => logs.push([event, detail]),
  });

  assert.deepEqual(await refresher.runNow(), { refreshed: [], failed: [], mirrored: [] });
  assert.deepEqual(logs, [['codex_published_expiry_read_failed', {
    account_id: 'external',
    code: 'EACCES',
  }]]);
});

test('a published expiry that is missing or unparseable records nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-bad-expiry-'));
  await mkdir(join(home, 'public'), { recursive: true });
  await writeFile(join(home, 'public', 'current.json'), JSON.stringify({ expires_at: 'soon' }));
  assert.equal(await readPublishedCodexExpiry(home), null);
  await rm(home, { recursive: true, force: true });
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

  const refreshed = await refreshManagedCodexHome(home);

  assert.deepEqual(await readFile(credentialPath), before, 'a fresh token must not rotate');
  assert.equal(refreshed.expiresAt, tokens.expiresAt);
  const health = JSON.parse(await readFile(join(home, 'public', 'health.json'), 'utf8'));
  assert.equal(health.last_outcome, 'fresh');
});
