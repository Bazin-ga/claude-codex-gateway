import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { sha256 } from '../lib/security.js';

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

  const reopened = await new CredentialStore(home).init();
  assert.deepEqual(reopened.accountCredential(account.id), {
    oauth_token: 'persisted-master-token',
  });
  assert.deepEqual(reopened.publicAccounts().map((entry) => entry.alias), ['claude-team-1']);
});

test('a state.json left behind by the removed password mode still opens and is not rewritten', async () => {
  const { home, store } = await newStore();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-1',
    credential: { oauth_token: 'persisted-master-token' },
  });
  // Exactly what the deleted setAdminPassword() used to persist.
  const legacy = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
  legacy.admin = {
    password: { algorithm: 'scrypt', salt: 'synthetic-salt', hash: 'synthetic-hash' },
    changed_at: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(join(home, 'state.json'), `${JSON.stringify(legacy, null, 2)}\n`);

  const reopened = await new CredentialStore(home).init();
  assert.deepEqual(reopened.accountCredential(account.id), {
    oauth_token: 'persisted-master-token',
  });
  // The field survives a write: nothing reads it, and nothing migrates it away.
  await reopened.revokeDevice(
    (await reopened.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'member@example.com',
      deviceName: 'member-laptop',
    })).device.id,
  );
  const rewritten = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
  assert.deepEqual(rewritten.admin, legacy.admin);
});

test('a state.json written before machines existed still opens, decrypts, and is left alone', async () => {
  // The store is built entirely through the pre-machine API — no machineId is
  // passed anywhere — so these rows are byte-for-byte what the deployed code
  // writes today, credential envelope included.
  const { home, store } = await newStore();
  const statePath = join(home, 'state.json');
  const keyPath = join(home, 'master.key');
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-1',
    emailLabel: 'owner@example.com',
    credential: { oauth_token: 'credential-that-cannot-be-reauthorized' },
  });
  const issued = await store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
  });

  // Plus a row spliced in by hand, so nothing here depends on this process
  // having written it during this run.
  const handWritten = JSON.parse(await readFile(statePath, 'utf8'));
  const handWrittenToken = 'sk-ant-api03-synthetic-legacy-device-token';
  handWritten.devices.push({
    id: 'legacy-device-1',
    account_id: account.id,
    member_label: 'other@example.com',
    name: 'desk-tower',
    token_sha256: sha256(handWrittenToken),
    created_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-02T00:00:00.000Z',
    revoked_at: null,
  });
  await writeFile(statePath, `${JSON.stringify(handWritten, null, 2)}\n`);
  const stateBefore = await readFile(statePath);
  const keyBefore = await readFile(keyPath);
  assert.equal(stateBefore.includes('machine_id'), false, 'the fixture must predate machine_id');

  const reopened = await new CredentialStore(home).init();

  // The one thing that must never break: the stored credential still decrypts,
  // under the same key and the same AAD.
  assert.deepEqual(reopened.accountCredential(account.id), {
    oauth_token: 'credential-that-cannot-be-reauthorized',
  });
  // Opening is not a migration. Nothing was rewritten, re-encrypted, or touched.
  assert.deepEqual(await readFile(statePath), stateBefore);
  assert.deepEqual(await readFile(keyPath), keyBefore);

  // Legacy rows load and still work where they are used, not merely parse.
  assert.equal(reopened.deviceByToken(handWrittenToken).id, 'legacy-device-1');
  assert.equal(reopened.deviceByToken(issued.token).id, issued.device.id);
  for (const device of reopened.publicDevices()) {
    assert.equal(Object.hasOwn(device, 'machine_id'), false);
  }

  // And they are reported as legacy: an absent handle is read as "unknown
  // machine", never guessed at from the name or the member label.
  const machines = reopened.publicMachines();
  assert.deepEqual(machines.map((machine) => machine.machine_id), [null, null]);
  assert.deepEqual(machines.map((machine) => machine.legacy), [true, true]);
  assert.deepEqual(
    machines.map((machine) => machine.devices.map((device) => device.id)),
    [[issued.device.id], ['legacy-device-1']],
  );

  // A later write that has nothing to do with them must leave them alone —
  // including the account credential, which is only ever re-encrypted by a fresh
  // authorization.
  const fresh = await reopened.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member@example.com',
    deviceName: 'new-laptop',
    machineId: 'new-machine-handle-ffffffff',
  });
  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(after.devices.slice(0, 2), handWritten.devices);
  assert.deepEqual(after.accounts, handWritten.accounts);
  assert.deepEqual(await readFile(keyPath), keyBefore);
  assert.equal(after.devices[2].machine_id, 'new-machine-handle-ffffffff');
  assert.equal(after.devices[2].id, fresh.device.id);
});

test('devices group into machines, and rows with no handle stay ungrouped', async () => {
  const { store } = await newStore();
  const first = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-1',
    credential: { oauth_token: 'master-token' },
  });
  const second = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-2',
    credential: { oauth_token: 'other-master-token' },
  });
  const handle = 'shared-machine-handle-aaaaaaaa';

  const selfIssued = await store.issueDeviceCredential({
    accountId: first.id,
    memberLabel: 'alex',
    deviceName: 'work-laptop',
    machineId: handle,
  });
  // The same machine moved to another account. `account_id` is fixed at issuance
  // and nothing mutates it, so this can only ever append a second row — the
  // machine view is the only place the two are one thing.
  const { code } = await store.createEnrollment({ accountId: second.id, memberLabel: 'alex' });
  const redeemed = await store.redeemEnrollment({
    code,
    deviceName: 'work-laptop',
    machineId: handle,
  });
  const legacy = await store.issueDeviceCredential({
    accountId: first.id,
    memberLabel: 'sam',
    deviceName: 'old-laptop',
  });
  await store.markDeviceSeen(redeemed.device.id);

  const [machine, unknown] = store.publicMachines();
  assert.equal(store.publicMachines().length, 2);
  assert.equal(machine.machine_id, handle);
  assert.equal(machine.legacy, false);
  assert.deepEqual(machine.devices.map((device) => device.id), [selfIssued.device.id, redeemed.device.id]);
  assert.deepEqual(machine.account_ids, [first.id, second.id]);
  assert.deepEqual(machine.member_labels, ['alex']);
  assert.deepEqual(machine.names, ['work-laptop']);
  assert.deepEqual([machine.active_devices, machine.revoked_devices], [2, 0]);
  // The aggregates span the machine's rows rather than tracking whichever row was
  // read last: the earliest issuance and the most recent contact, across both.
  assert.equal(machine.first_created_at, selfIssued.device.created_at);
  assert.ok(machine.first_created_at <= redeemed.device.created_at);
  assert.equal(machine.last_seen_at, store.publicDevices()[1].last_seen_at);

  // Stamped rather than timed, so the aggregation is pinned to an ordering and
  // not to whichever row happened to be visited last. Both orderings are checked:
  // the later contact wins whether it comes first or second in the list.
  for (const [id, seen, created] of [
    [selfIssued.device.id, '2026-05-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    [redeemed.device.id, '2026-04-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
  ]) {
    const row = store.state.devices.find((device) => device.id === id);
    row.last_seen_at = seen;
    row.created_at = created;
  }
  const [stamped] = store.publicMachines();
  assert.equal(stamped.last_seen_at, '2026-05-01T00:00:00.000Z');
  assert.equal(stamped.first_created_at, '2026-01-01T00:00:00.000Z');

  const older = store.state.devices.find((device) => device.id === selfIssued.device.id);
  older.last_seen_at = '2026-03-01T00:00:00.000Z';
  older.created_at = '2026-03-01T00:00:00.000Z';
  const [reordered] = store.publicMachines();
  assert.equal(reordered.last_seen_at, '2026-04-01T00:00:00.000Z');
  assert.equal(reordered.first_created_at, '2026-02-01T00:00:00.000Z');

  // A row that has never been seen must not erase one that has.
  older.last_seen_at = null;
  assert.equal(store.publicMachines()[0].last_seen_at, '2026-04-01T00:00:00.000Z');
  // One issuance nobody can attribute to a machine is one entry of its own, not
  // a member of some invented group.
  assert.equal(unknown.machine_id, null);
  assert.equal(unknown.legacy, true);
  assert.deepEqual(unknown.devices.map((device) => device.id), [legacy.device.id]);

  // Revocation is a soft delete the flat list never forgets. The inventory drops
  // the row but keeps the count, so a machine's history stays visible.
  await store.revokeDevice(selfIssued.device.id);
  const [afterRevoke] = store.publicMachines();
  assert.deepEqual(afterRevoke.devices.map((device) => device.id), [redeemed.device.id]);
  assert.deepEqual([afterRevoke.active_devices, afterRevoke.revoked_devices], [1, 1]);

  await store.revokeDevice(redeemed.device.id);
  assert.deepEqual(store.publicMachines().map((entry) => entry.machine_id), [null]);
  const [history] = store.publicMachines({ includeRevoked: true });
  assert.equal(history.machine_id, handle);
  assert.deepEqual([history.active_devices, history.revoked_devices], [0, 2]);
  assert.equal(history.devices.length, 2);

  // A handle is stored only if it is one. Anything else is refused rather than
  // written and read back later as if it meant something.
  for (const machineId of ['nope', 'x'.repeat(65), 'has spaces in it', 42, {}]) {
    await assert.rejects(
      store.issueDeviceCredential({
        accountId: first.id,
        memberLabel: 'alex',
        deviceName: 'refused-laptop',
        machineId,
      }),
      /machine id must match/,
      `${JSON.stringify(machineId)} should have been refused`,
    );
  }
});

test('two handle-less rows with the same label and name are two machines, not one', async () => {
  // The rule that legacy rows are never grouped by guess, exercised on the one
  // input that can break it. Keying an unattributed row on
  // `${member_label}:${name}` instead of its own id passes every other test in
  // this file, and silently folds two unrelated credential issuances into one
  // fabricated machine.
  //
  // Reachable in production without anyone doing anything unusual:
  // `issueDeviceCredential` rejects duplicates only on (account, member, name,
  // not-revoked), so a second account takes the same pair, and `redeemEnrollment`
  // has no duplicate guard at all. Both are typed by a person and neither is
  // verified — which is the whole reason the handle exists.
  const { store } = await newStore();
  const first = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-1',
    credential: { oauth_token: 'master-token' },
  });
  const second = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-2',
    credential: { oauth_token: 'other-master-token' },
  });

  const issued = await store.issueDeviceCredential({
    accountId: first.id,
    memberLabel: 'alex',
    deviceName: 'work-laptop',
  });
  const { code } = await store.createEnrollment({ accountId: second.id, memberLabel: 'alex' });
  const redeemed = await store.redeemEnrollment({ code, deviceName: 'work-laptop' });

  assert.deepEqual(
    [issued.device, redeemed.device].map((device) => [device.member_label, device.name]),
    [['alex', 'work-laptop'], ['alex', 'work-laptop']],
  );

  const machines = store.publicMachines();
  assert.equal(machines.length, 2, 'a matching label and name is not evidence of one machine');
  assert.deepEqual(machines.map((machine) => machine.legacy), [true, true]);
  assert.deepEqual(machines.map((machine) => machine.machine_id), [null, null]);
  assert.deepEqual(
    machines.map((machine) => machine.devices.map((device) => device.id)),
    [[issued.device.id], [redeemed.device.id]],
  );

  // Filing one of them under a machine moves that one and leaves the other where
  // it was, which is the only way the two are ever joined.
  const handle = 'operator-filed-handle-99999999';
  await store.mergeDeviceIntoMachine({ deviceId: issued.device.id, machineId: handle });
  assert.deepEqual(
    store.publicMachines().map((machine) => [machine.machine_id, machine.devices.length]),
    [[handle, 1], [null, 1]],
  );
});

test('a legacy issuance is filed under a machine by adding one field, and only once', async () => {
  // Written entirely by the pre-machine API, then reopened with the current code:
  // the merge below runs against bytes the deployed console produced, credential
  // envelope and all, not against something this test shaped for it.
  const { home, store } = await newStore();
  const statePath = join(home, 'state.json');
  const keyPath = join(home, 'master.key');
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team-1',
    emailLabel: 'owner@example.com',
    credential: { oauth_token: 'credential-that-cannot-be-reauthorized' },
  });
  // The only way the Claude path can issue: the member's browser is not an agent
  // and has no handle to report.
  const legacy = await store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'alex',
    deviceName: 'work-laptop',
  });
  const handle = 'shared-machine-handle-aaaaaaaa';
  const before = JSON.parse(await readFile(statePath, 'utf8'));
  const keyBefore = await readFile(keyPath);
  assert.equal(before.devices.length, 1);
  assert.equal(Object.hasOwn(before.devices[0], 'machine_id'), false);

  const reopened = await new CredentialStore(home).init();
  // The one thing that must never break, checked before anything is written.
  assert.deepEqual(reopened.accountCredential(account.id), {
    oauth_token: 'credential-that-cannot-be-reauthorized',
  });

  const first = await reopened.mergeDeviceIntoMachine({
    deviceId: legacy.device.id,
    machineId: handle,
  });
  assert.equal(first.changed, true);
  // The same merge again — a double click, a resubmitted form, a retried request.
  // It is already where it is being asked to go, so nothing is written.
  const second = await reopened.mergeDeviceIntoMachine({
    deviceId: legacy.device.id,
    machineId: handle,
  });
  assert.equal(second.changed, false);

  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(after.devices, [{ ...before.devices[0], machine_id: handle }]);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(await readFile(keyPath), keyBefore);
  assert.deepEqual(
    after.audit.filter((event) => event.event === 'device_machine_merged').length,
    1,
    'the second merge must not record a change it did not make',
  );
  // Still decrypts afterwards, under the same key and the same authenticated data.
  assert.deepEqual(reopened.accountCredential(account.id), {
    oauth_token: 'credential-that-cannot-be-reauthorized',
  });
  assert.equal(reopened.deviceByToken(legacy.token).id, legacy.device.id);

  // And it is now one machine, not an unattributable issuance.
  const [machine] = reopened.publicMachines();
  assert.equal(machine.machine_id, handle);
  assert.equal(machine.legacy, false);
  assert.deepEqual(machine.devices.map((device) => device.id), [legacy.device.id]);

  // Re-pointing a row that already carries a handle is refused rather than
  // rewritten: the stored answer was recorded, the new one is merely asserted.
  await assert.rejects(
    reopened.mergeDeviceIntoMachine({
      deviceId: legacy.device.id,
      machineId: 'other-machine-handle-bbbbbbbb',
    }),
    /already attributed to a different machine/,
  );
  for (const [machineId, expected] of [
    ['nope', /machine id must match/],
    [{}, /machine id must match/],
    ['', /machine handle is required/],
    [null, /machine handle is required/],
  ]) {
    await assert.rejects(
      reopened.mergeDeviceIntoMachine({ deviceId: legacy.device.id, machineId }),
      expected,
      `${JSON.stringify(machineId)} should have been refused`,
    );
  }
  await assert.rejects(
    reopened.mergeDeviceIntoMachine({ deviceId: 'no-such-device', machineId: handle }),
    /device not found/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(statePath, 'utf8')).devices,
    after.devices,
    'a refused merge must leave the row exactly as it was',
  );
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

test('the seed-home guard compares canonical paths, not the spelling it was given', async () => {
  const { store } = await newStore();
  const seedHome = '/var/lib/codex-credential';
  const first = await store.addAccount({
    provider: 'codex',
    alias: 'codex-shared-1',
    // What `cli.js import-codex` records: always resolve()d.
    external: { kind: 'codex-credential', home: seedHome },
  });
  const second = await store.addAccount({ provider: 'codex', alias: 'codex-shared-2' });

  // Every spelling of the home the first account holds must refuse the second,
  // or one account silently overwrites the other's single-use refresh token.
  for (const spelling of [
    seedHome,
    `${seedHome}/`,
    '/var/lib//codex-credential',
    '/var/lib/./codex-credential',
    '/var/lib/codex-credential/public/..',
  ]) {
    assert.throws(
      () => store.assertCodexSeedHome({ accountId: second.id, seedHome: spelling }),
      /codex-shared-1 already holds the credential in/,
      `spelling ${spelling} should have been refused`,
    );
    assert.doesNotThrow(
      () => store.assertCodexSeedHome({ accountId: first.id, seedHome: spelling }),
      `spelling ${spelling} is the owner's own home`,
    );
  }

  // An account bound elsewhere is refused too: seeding would write the credential
  // into a home the dashboard does not read that row's health from.
  assert.throws(
    () => store.assertCodexSeedHome({ accountId: first.id, seedHome: '/var/lib/other-codex-home' }),
    /codex-shared-1 holds its credential in \/var\/lib\/codex-credential, not the configured seed home/,
  );
});

test('a live Codex session is reported without decrypting its verifier', async () => {
  const { store } = await newStore();
  const account = await store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
  assert.equal(store.pendingCodexAuthorization({ accountId: account.id }), null);

  const flow = await store.beginCodexAuthorization({
    accountId: account.id,
    verifier: 'pkce-verifier-value',
    state: 'browser-state-value',
    initiatedBy: 'administrator',
  });
  assert.deepEqual(store.pendingCodexAuthorization({ accountId: account.id }), {
    id: flow.id,
    expires_at: flow.expires_at,
  });

  await store.completeCodexAuthorization({ flowId: flow.id });
  assert.equal(store.pendingCodexAuthorization({ accountId: account.id }), null);
});

test('an account that never authorized can be deleted, one holding a credential cannot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-delete-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();

  const pending = await store.addAccount({ provider: 'claude', alias: 'typo-alias' });
  assert.equal(pending.status, 'login_required');
  await store.deleteAccount(pending.id);
  assert.equal(store.accountById(pending.id), null);
  assert.equal(store.publicAccounts().some((entry) => entry.id === pending.id), false);

  // Keyed off the stored credential, not `status`: a row whose health check has
  // moved it to `unhealthy` is still holding something unrecoverable.
  const authorized = await store.addAccount({
    provider: 'claude',
    alias: 'real-account',
    credential: { oauth_token: 'sk-ant-oat01-not-recreatable' },
  });
  await store.updateAccountHealth(authorized.id, { success: false, error: 'upstream 500' });
  assert.equal(store.accountById(authorized.id).status, 'unhealthy');
  await assert.rejects(
    store.deleteAccount(authorized.id),
    /holds a stored credential/,
    'an account holding a credential must never be deletable, whatever its status says',
  );
  assert.ok(store.accountCredential(authorized.id).oauth_token);

  const imported = await store.addAccount({
    provider: 'codex',
    alias: 'imported-home',
    external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
  });
  await assert.rejects(store.deleteAccount(imported.id), /imported credential home/);

  await assert.rejects(store.deleteAccount('no-such-id'), /account not found/);
});
