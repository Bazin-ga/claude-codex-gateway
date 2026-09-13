import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { credentialSwitchBlock, externalAccountStatus } from '../lib/external-account-status.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

async function newStore() {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-switch-guard-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  return { home, store };
}

/**
 * A Codex credential home as the refresh centre publishes it. `current` carries
 * the expiry the console treats as authoritative; `health` is the observability
 * snapshot the switch guard now consults.
 */
async function credentialHome({ current = {}, health = undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-credential-home-'));
  await mkdir(join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public', 'current.json'), JSON.stringify({
    access_token: 'token-never-read-by-the-guard',
    account_id: 'upstream-account-id',
    expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString(),
    ...current,
  }));
  if (health !== undefined) {
    await writeFile(join(root, 'public', 'health.json'), JSON.stringify(health));
  }
  return root;
}

function healthySnapshot(overrides = {}) {
  const now = Date.now();
  return {
    version: 1,
    updated_at: new Date(now - 60_000).toISOString(),
    expected_interval_seconds: 86400,
    last_cycle_started_at: new Date(now - 120_000).toISOString(),
    last_cycle_finished_at: new Date(now - 60_000).toISOString(),
    last_outcome: 'fresh',
    last_success_at: new Date(now - 60_000).toISOString(),
    last_refresh_at: new Date(now - 60_000).toISOString(),
    consecutive_failures: 0,
    quarantine: { present: false },
    access: {
      present: true,
      valid: true,
      expires_at: new Date(now + 7 * DAY_MS).toISOString(),
      remaining_seconds: 7 * 86400,
    },
    ...overrides,
  };
}

/**
 * The exact shape that took the Chicago console down for two days: the refresh
 * centre quarantined itself on day one, the console row kept a future expiry
 * and a `healthy` status, and the switch guard had no way to tell.
 */
function quarantinedSnapshot() {
  const now = Date.now();
  return healthySnapshot({
    last_outcome: 'quarantined',
    failure_class: 'quarantine',
    consecutive_failures: 5,
    last_failure_at: new Date(now - 60_000).toISOString(),
    quarantine: { present: true, since: new Date(now - 4 * DAY_MS).toISOString() },
    access: {
      present: true,
      valid: false,
      expires_at: new Date(now - DAY_MS).toISOString(),
      remaining_seconds: 0,
    },
  });
}

async function codexAccountWithHome(store, alias, homeOptions) {
  const home = await credentialHome(homeOptions);
  const account = await store.addAccount({
    provider: 'codex',
    alias,
    external: { kind: 'codex-credential', home },
  });
  return { account, home };
}

async function deviceOn(store, account, name) {
  return store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'switch-guard-member',
    deviceName: name,
  });
}

function runCli(home, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(TEST_DIR, '..', 'cli.js'), ...args], {
      env: { ...process.env, CREDENTIAL_CONSOLE_HOME: home },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

test('a quarantined Codex credential is refused as a switch target on both paths', async () => {
  const { store } = await newStore();
  const healthy = await codexAccountWithHome(store, 'guard-healthy', {
    health: healthySnapshot(),
  });
  const quarantined = await codexAccountWithHome(store, 'guard-quarantined', {
    health: quarantinedSnapshot(),
  });
  const issued = await deviceOn(store, healthy.account, 'guard-device');

  // The stored row still looks fine, which is exactly why the synchronous
  // guard let this through before: nothing in state.json is wrong.
  assert.equal(store.accountById(quarantined.account.id).status, 'stored');

  await assert.rejects(
    store.configureDeviceAccount({
      deviceId: issued.device.id,
      selectedAccountId: quarantined.account.id,
      actor: 'console-admin',
    }),
    (error) => error.code === 'ACCOUNT_UNAVAILABLE'
      && error.message.includes('refresh_quarantined'),
  );

  // The device must not have been moved, and the allowlist must not have grown
  // a reference to an account the device can never use.
  const row = store.state.devices.find((device) => device.id === issued.device.id);
  assert.equal(row.selected_account_id, healthy.account.id);
  assert.equal(row.allowed_account_ids.includes(quarantined.account.id), false);

  // Pre-authorize it, then prove the device-token path refuses it too: an
  // allowlist entry that was healthy when it was added must not become a
  // standing permission to switch onto a dead credential.
  row.allowed_account_ids = [...row.allowed_account_ids, quarantined.account.id];
  await assert.rejects(
    store.switchDeviceAccount({
      deviceId: issued.device.id,
      selectedAccountId: quarantined.account.id,
      actorDeviceId: issued.device.id,
    }),
    (error) => error.code === 'ACCOUNT_UNAVAILABLE'
      && error.message.includes('refresh_quarantined'),
  );
  assert.equal(
    store.state.devices.find((device) => device.id === issued.device.id).selected_account_id,
    healthy.account.id,
  );
});

test('a healthy Codex credential still switches, and the refusal message carries no path', async () => {
  const { store } = await newStore();
  const first = await codexAccountWithHome(store, 'guard-first', { health: healthySnapshot() });
  const second = await codexAccountWithHome(store, 'guard-second', { health: healthySnapshot() });
  const issued = await deviceOn(store, first.account, 'guard-happy-device');

  const configured = await store.configureDeviceAccount({
    deviceId: issued.device.id,
    selectedAccountId: second.account.id,
    actor: 'console-admin',
  });
  assert.equal(configured.selected_account_id, second.account.id);

  const switched = await store.switchDeviceAccount({
    deviceId: issued.device.id,
    selectedAccountId: first.account.id,
    actorDeviceId: issued.device.id,
  });
  assert.equal(switched.selected_account_id, first.account.id);

  // A blocked switch must never leak the credential home's path.
  const dead = await codexAccountWithHome(store, 'guard-dead', { health: quarantinedSnapshot() });
  const error = await store.configureDeviceAccount({
    deviceId: issued.device.id,
    selectedAccountId: dead.account.id,
    actor: 'console-admin',
  }).then(() => null, (caught) => caught);
  assert.ok(error, 'the switch should have been refused');
  assert.equal(error.message.includes(dead.home), false);
  assert.equal(error.message.includes('/'), false);
});

test('an expired access snapshot blocks even while the stored row still reads healthy', async () => {
  const { store } = await newStore();
  const healthy = await codexAccountWithHome(store, 'expiry-healthy', { health: healthySnapshot() });
  const expired = await codexAccountWithHome(store, 'expiry-expired', {
    current: { expires_at: new Date(Date.now() - 1000).toISOString() },
    health: healthySnapshot({
      access: {
        present: true,
        valid: false,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        remaining_seconds: 0,
      },
    }),
  });
  const issued = await deviceOn(store, healthy.account, 'expiry-device');

  // The row carries no expiry at all, so the synchronous guard has nothing to
  // check; current.json is what makes this account unusable.
  assert.equal(store.accountById(expired.account.id).expires_at ?? null, null);
  await assert.rejects(
    store.configureDeviceAccount({
      deviceId: issued.device.id,
      selectedAccountId: expired.account.id,
      actor: 'console-admin',
    }),
    (error) => error.code === 'ACCOUNT_UNAVAILABLE'
      && error.message.includes('access_expired'),
  );
});

test('unreadable and not-yet-written health surfaces stay switchable', async () => {
  const { store } = await newStore();
  const anchor = await codexAccountWithHome(store, 'failopen-anchor', { health: healthySnapshot() });
  // A freshly authorized account: current.json exists, the first refresh cycle
  // has not run, so there is no health.json yet.
  const fresh = await codexAccountWithHome(store, 'failopen-fresh', {});
  const issued = await deviceOn(store, anchor.account, 'failopen-device');

  const configured = await store.configureDeviceAccount({
    deviceId: issued.device.id,
    selectedAccountId: fresh.account.id,
    actor: 'console-admin',
  });
  assert.equal(configured.selected_account_id, fresh.account.id);

  // A home the console cannot read at all must not become unselectable either.
  const unreadable = await codexAccountWithHome(store, 'failopen-unreadable', {
    health: healthySnapshot(),
  });
  await chmod(join(unreadable.home, 'public'), 0o000);
  try {
    const moved = await store.configureDeviceAccount({
      deviceId: issued.device.id,
      selectedAccountId: unreadable.account.id,
      actor: 'console-admin',
    });
    assert.equal(moved.selected_account_id, unreadable.account.id);
  } finally {
    await chmod(join(unreadable.home, 'public'), 0o700);
  }
});

test('non-Codex providers are untouched by the health guard', async () => {
  const { store } = await newStore();
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'guard-claude',
    credential: { oauth_token: 'guard-claude-token' },
  });
  const other = await store.addAccount({
    provider: 'claude',
    alias: 'guard-claude-2',
    credential: { oauth_token: 'guard-claude-2-token' },
  });
  const issued = await deviceOn(store, claude, 'guard-claude-device');
  const configured = await store.configureDeviceAccount({
    deviceId: issued.device.id,
    selectedAccountId: other.id,
    actor: 'console-admin',
  });
  assert.equal(configured.selected_account_id, other.id);
  assert.equal(credentialSwitchBlock(claude, await externalAccountStatus(claude)), null);
});

test('the device status summary reports the real condition while the cached column is kept', async () => {
  const { store } = await newStore();
  // The end state of a quarantine: the last minted token has since lapsed, so
  // current.json is expired too. This is what codex-lin looked like while the
  // status endpoint was still answering `healthy`.
  const account = await codexAccountWithHome(store, 'summary-account', {
    current: { expires_at: new Date(Date.now() - DAY_MS).toISOString() },
    health: quarantinedSnapshot(),
  });
  const issued = await deviceOn(store, account.account, 'summary-device');
  // Mimic the proxy's last successful request, which is the only thing that
  // ever writes this column.
  await store.updateAccountHealth(account.account.id, { success: true });
  assert.equal(store.accountById(account.account.id).status, 'healthy');

  const cached = store.deviceAccountSummary(issued.device.id);
  assert.equal(cached.account.status, 'healthy');

  const live = await store.deviceAccountSummaryWithHealth(issued.device.id);
  assert.equal(live.account_status, 'expired');
  assert.equal(live.account.status, 'expired');
  assert.equal(live.account.cached_status, 'healthy');
  assert.equal(live.account.quarantined, true);
  assert.equal(live.account.refresh_health_status, 'ok');
});

test('cli list overlays the live status and keeps the stored one as cached_status', async () => {
  const { home, store } = await newStore();
  const account = await codexAccountWithHome(store, 'cli-account', {
    current: { expires_at: new Date(Date.now() - DAY_MS).toISOString() },
    health: quarantinedSnapshot(),
  });
  await store.updateAccountHealth(account.account.id, { success: true });

  const result = await runCli(home, 'list');
  assert.equal(result.code, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  const row = rows.find((entry) => entry.alias === 'cli-account');
  assert.equal(row.status, 'expired');
  assert.equal(row.cached_status, 'healthy');
  assert.equal(row.quarantined, true);
  // The listing is a public projection: no credential home path may appear.
  assert.equal(result.stdout.includes(account.home), false);
});
