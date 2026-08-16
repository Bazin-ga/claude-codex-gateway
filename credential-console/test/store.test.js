import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

async function newStore() {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-store-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  return { home, store };
}

async function runCli(home, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(TEST_DIR, '..', 'cli.js'), ...args], {
      env: { ...process.env, CREDENTIAL_CONSOLE_HOME: home },
    }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('missing master key is refused by default without creating a key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-missing-key-'));
  const keyPath = join(home, 'master.key');

  await assert.rejects(
    new CredentialStore(home).init(),
    (error) => error.message.includes(keyPath) && /restore.*backup.*init-key/i.test(error.message),
  );
  await assert.rejects(access(keyPath), (error) => error.code === 'ENOENT');
});

test('explicit key initialization creates a usable store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-explicit-key-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();

  assert.equal((await stat(join(home, 'master.key'))).mode & 0o777, 0o600);
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'explicit-key-account',
    credential: { oauth_token: 'explicit-key-token' },
  });
  assert.deepEqual(store.accountCredential(account.id), { oauth_token: 'explicit-key-token' });
});

test('init-key refuses to replace an existing master key', async () => {
  const { home } = await newStore();
  const keyPath = join(home, 'master.key');
  const before = await readFile(keyPath);

  const result = await runCli(home, 'init-key');

  assert.notEqual(result.code, 0);
  assert.deepEqual(await readFile(keyPath), before);
});

function emptyState(overrides = {}) {
  return {
    version: 1,
    admin: null,
    accounts: [],
    oauth_flows: [],
    enrollments: [],
    devices: [],
    audit: [],
    ...overrides,
  };
}

async function assertInitKeyRefusesStoredData(overrides) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-init-key-data-'));
  const statePath = join(home, 'state.json');
  const keyPath = join(home, 'master.key');
  const before = Buffer.from(`${JSON.stringify(emptyState(overrides), null, 2)}\n`);
  await writeFile(statePath, before);

  const result = await runCli(home, 'init-key');

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /home already contains data encrypted under a different key/i);
  assert.match(result.stderr, /new key cannot decrypt it/i);
  assert.match(result.stderr, /restore master\.key from backup/i);
  await assert.rejects(access(keyPath), (error) => error.code === 'ENOENT');
  assert.deepEqual(await readFile(statePath), before);
}

test('init-key refuses state containing an encrypted account without writing a key', async () => {
  await assertInitKeyRefusesStoredData({
    accounts: [{
      id: 'account-1',
      credential: { iv: 'iv-envelope', ciphertext: 'encrypted-credential', tag: 'tag-envelope' },
    }],
  });
});

test('init-key refuses state containing only a device without writing a key', async () => {
  await assertInitKeyRefusesStoredData({ devices: [{ id: 'device-1' }] });
});

test('init-key refuses state containing only an enrollment without writing a key', async () => {
  await assertInitKeyRefusesStoredData({ enrollments: [{ id: 'enrollment-1' }] });
});

test('init-key refuses state containing only an OAuth flow without writing a key', async () => {
  await assertInitKeyRefusesStoredData({ oauth_flows: [{ id: 'oauth-flow-1' }] });
});

test('init-key succeeds for a pristine empty home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-init-key-empty-'));

  const result = await runCli(home, 'init-key');

  assert.equal(result.code, 0, result.stderr);
  await access(join(home, 'master.key'));
});

test('init-key succeeds with an empty state file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-init-key-empty-state-'));
  const statePath = join(home, 'state.json');
  const before = Buffer.from(`${JSON.stringify(emptyState(), null, 2)}\n`);
  await writeFile(statePath, before);

  const result = await runCli(home, 'init-key');

  assert.equal(result.code, 0, result.stderr);
  await access(join(home, 'master.key'));
  assert.deepEqual(await readFile(statePath), before);
});

test('init-key refuses an unparsable state file without writing a key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-init-key-invalid-state-'));
  const statePath = join(home, 'state.json');
  const before = Buffer.from('{not valid json\n');
  await writeFile(statePath, before);

  const result = await runCli(home, 'init-key');

  assert.notEqual(result.code, 0);
  await assert.rejects(access(join(home, 'master.key')), (error) => error.code === 'ENOENT');
  assert.deepEqual(await readFile(statePath), before);
});

test('read-only list does not require the credential home lock', async () => {
  const { home } = await newStore();
  const selfStat = process.platform === 'linux' ? await readFile('/proc/self/stat', 'utf8') : null;
  await writeFile(join(home, '.owner.lock'), `${JSON.stringify({
    pid: process.pid,
    role: 'server',
    startIdentity: selfStat ? selfStat.slice(selfStat.lastIndexOf(')') + 2).split(' ')[19] : null,
  })}\n`);
  const result = await runCli(home, 'list');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('encrypts master credentials and restricts storage permissions', async () => {
  const { home, store } = await newStore();
  await store.addAccount({
    provider: 'claude',
    alias: 'claude-max-1',
    emailLabel: 'owner@example.com',
    credential: { oauth_token: 'master-token-that-must-never-appear-in-state' },
  });

  const stateText = await readFile(join(home, 'state.json'), 'utf8');
  assert.equal(stateText.includes('master-token-that-must-never-appear-in-state'), false);
  assert.equal(stateText.includes('owner@example.com'), true);
  assert.deepEqual(store.accountCredential(store.state.accounts[0].id), {
    oauth_token: 'master-token-that-must-never-appear-in-state',
  });
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, 'master.key'))).mode & 0o777, 0o600);
});

test('one-time enrollment creates independently revocable device credentials', async () => {
  const { store } = await newStore();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-max-1',
    credential: { oauth_token: 'master-token' },
  });
  const { code } = await store.createEnrollment({
    accountId: account.id,
    memberLabel: 'member@example.com',
    ttlMinutes: 30,
  });

  const issued = await store.redeemEnrollment({ code, deviceName: 'member-macbook' });
  assert.match(issued.token, /^sk-ant-api03-[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.account.id, account.id);
  assert.equal(store.deviceByToken(issued.token).id, issued.device.id);
  await assert.rejects(
    store.redeemEnrollment({ code, deviceName: 'second-device' }),
    /already used/,
  );

  await store.revokeDevice(issued.device.id);
  assert.equal(store.deviceByToken(issued.token), null);
  assert.equal(store.publicDevices()[0].token_sha256, undefined);
});

test('tailnet members can self-issue one credential per active device name', async () => {
  const { store } = await newStore();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-self-service',
    credential: { oauth_token: 'master-token' },
  });

  const issued = await store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
  });
  assert.match(issued.token, /^sk-ant-api03-[A-Za-z0-9_-]{43}$/);
  assert.equal(store.deviceByToken(issued.token).id, issued.device.id);
  assert.equal(store.publicDevices()[0].member_label, 'member@example.com');
  assert.equal(store.state.enrollments.length, 0);
  await assert.rejects(
    store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'member@example.com',
      deviceName: 'member-laptop',
    }),
    /already exists/,
  );
});

test('re-opening a store preserves encrypted credentials and state', async () => {
  const { home, store } = await newStore();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-1',
    credential: { oauth_token: 'persisted-master-token' },
  });
  await store.setAdminPassword('a-strong-admin-password');

  const reopened = await new CredentialStore(home).init();
  assert.deepEqual(reopened.accountCredential(account.id), {
    oauth_token: 'persisted-master-token',
  });
  assert.equal(await reopened.verifyAdminPassword('a-strong-admin-password'), true);
  assert.equal(await reopened.verifyAdminPassword('wrong-password-value'), false);
});

test('persists PKCE verifiers encrypted and stores a Claude token only after email verification', async () => {
  const { home, store } = await newStore();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'owner-authorized',
    emailLabel: 'owner@example.com',
  });
  assert.equal(account.status, 'login_required');
  const flow = await store.beginClaudeAuthorization({
    accountId: account.id,
    verifier: 'pkce-verifier-that-must-remain-encrypted',
    state: 'browser-state-that-must-be-hashed',
    initiatedBy: 'owner@example.com',
  });
  const stateText = await readFile(join(home, 'state.json'), 'utf8');
  assert.equal(stateText.includes('pkce-verifier-that-must-remain-encrypted'), false);
  assert.equal(stateText.includes('browser-state-that-must-be-hashed'), false);
  const pending = store.claudeAuthorizationByState({
    accountId: account.id,
    state: 'browser-state-that-must-be-hashed',
  });
  assert.equal(pending.id, flow.id);
  assert.equal(pending.verifier, 'pkce-verifier-that-must-remain-encrypted');

  await assert.rejects(
    store.completeClaudeAuthorization({
      flowId: flow.id,
      accessToken: 'sk-ant-oat01-wrong-owner',
      emailAddress: 'other@example.com',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }),
    /does not match owner@example\.com/,
  );
  assert.equal(store.accountCredential(account.id), null);

  await store.completeClaudeAuthorization({
    flowId: flow.id,
    accessToken: 'sk-ant-oat01-correct-owner',
    emailAddress: 'OWNER@example.com',
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  assert.equal(account.status, 'healthy');
  assert.equal(account.expires_at, '2027-01-01T00:00:00.000Z');
  assert.deepEqual(store.accountCredential(account.id), {
    oauth_token: 'sk-ant-oat01-correct-owner',
  });
  assert.throws(
    () => store.claudeAuthorizationByState({
      accountId: account.id,
      state: 'browser-state-that-must-be-hashed',
    }),
    /already used/,
  );
  assert.equal((await readFile(join(home, 'state.json'), 'utf8')).includes('sk-ant-oat01-correct-owner'), false);
});
