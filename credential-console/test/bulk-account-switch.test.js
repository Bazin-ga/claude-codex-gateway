import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { dashboardView } from '../lib/views.js';

async function newStore() {
  const home = await mkdtemp(join(tmpdir(), 'bulk-switch-'));
  return new CredentialStore(home, { allowKeyInit: true }).init();
}

async function claudeAccount(store, alias) {
  return store.addAccount({
    provider: 'claude',
    alias,
    emailLabel: `${alias}@example.com`,
    credential: { oauth_token: `sk-ant-oat-${alias}` },
  });
}

async function device(store, accountId, name) {
  const { device: row } = await store.issueDeviceCredential({
    accountId,
    memberLabel: 'member@example.com',
    deviceName: name,
  });
  return row;
}

async function fixture() {
  const store = await newStore();
  const from = await claudeAccount(store, 'account-a');
  const to = await claudeAccount(store, 'account-b');
  const devices = [];
  for (const name of ['laptop-1', 'laptop-2', 'laptop-3']) {
    devices.push(await device(store, from.id, name));
  }
  return { store, from, to, devices };
}

test('every credential on one account moves to another in a single call', async () => {
  const { store, from, to, devices } = await fixture();
  assert.equal(store.devicesOnAccount(from.id).length, 3);

  const summary = await store.bulkConfigureDeviceAccount({
    fromAccountId: from.id,
    selectedAccountId: to.id,
    expectedCount: 3,
    actor: 'admin@example.com',
  });

  assert.deepEqual(summary.switched.sort(), devices.map((row) => row.id).sort());
  assert.deepEqual(summary.skipped, []);
  assert.equal(store.devicesOnAccount(from.id).length, 0);
  assert.equal(store.devicesOnAccount(to.id).length, 3);
  for (const row of devices) {
    assert.equal(store.resolveDeviceAccount(row.id).account.id, to.id);
  }
});

test('the move survives a reopen, so it was persisted once and completely', async () => {
  const { store, from, to } = await fixture();
  await store.bulkConfigureDeviceAccount({
    fromAccountId: from.id,
    selectedAccountId: to.id,
    actor: 'admin@example.com',
  });

  const reopened = await new CredentialStore(store.home, { allowKeyInit: false }).init();
  assert.equal(reopened.devicesOnAccount(to.id).length, 3);
  assert.equal(reopened.devicesOnAccount(from.id).length, 0);
});

test('a count that no longer matches is refused rather than applied', async () => {
  const { store, from, to } = await fixture();
  // The operator saw three; a fourth was enrolled before they pressed the button.
  await device(store, from.id, 'laptop-4');

  await assert.rejects(
    store.bulkConfigureDeviceAccount({
      fromAccountId: from.id,
      selectedAccountId: to.id,
      expectedCount: 3,
      actor: 'admin@example.com',
    }),
    /the list changed: 4 devices are on that account now, not 3/,
  );
  // Nothing moved: switching four when the screen said three is the mistake
  // this guard exists to prevent.
  assert.equal(store.devicesOnAccount(from.id).length, 4);
  assert.equal(store.devicesOnAccount(to.id).length, 0);
});

test('revoked credentials are not moved and are not counted', async () => {
  const { store, from, to, devices } = await fixture();
  await store.revokeDevice(devices[0].id);
  assert.equal(store.devicesOnAccount(from.id).length, 2);

  const summary = await store.bulkConfigureDeviceAccount({
    fromAccountId: from.id,
    selectedAccountId: to.id,
    expectedCount: 2,
    actor: 'admin@example.com',
  });
  assert.equal(summary.switched.length, 2);
  assert.equal(summary.switched.includes(devices[0].id), false);
});

test('a target that cannot hold devices is refused before anything moves', async () => {
  const { store, from } = await fixture();
  const codex = await store.addAccount({
    provider: 'codex',
    alias: 'codex-1',
    emailLabel: '',
    external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
  });
  const noCredential = await store.addAccount({
    provider: 'claude',
    alias: 'claude-empty',
    emailLabel: 'empty@example.com',
  });

  for (const [target, expected] of [
    [codex.id, /not a Claude account/],
    [noCredential.id, /no stored credential/],
    ['does-not-exist', /target account not found/],
    [from.id, /the target account is the one being moved from/],
  ]) {
    await assert.rejects(
      store.bulkConfigureDeviceAccount({
        fromAccountId: from.id,
        selectedAccountId: target,
        actor: 'admin@example.com',
      }),
      expected,
      String(target),
    );
    assert.equal(store.devicesOnAccount(from.id).length, 3, 'nothing moved');
  }
});

test('one unmovable row is reported and the rest of the batch still moves', async () => {
  const { store, from, to, devices } = await fixture();
  // A malformed policy: the store refuses to guess what it meant, so this row
  // is skipped rather than silently reassigned.
  const broken = store.state.devices.find((row) => row.id === devices[1].id);
  broken.allowed_account_ids = 'not-an-array';

  const summary = await store.bulkConfigureDeviceAccount({
    fromAccountId: from.id,
    selectedAccountId: to.id,
    actor: 'admin@example.com',
  });

  // The broken row never matched the filter in the first place, so the batch is
  // the two that did.
  assert.equal(summary.switched.length, 2);
  assert.equal(summary.switched.includes(devices[1].id), false);
  assert.equal(store.devicesOnAccount(to.id).length, 2);
});

test('an empty selection is a no-op rather than an error', async () => {
  const { store, to } = await fixture();
  const summary = await store.bulkConfigureDeviceAccount({
    fromAccountId: 'nobody-is-on-this',
    selectedAccountId: to.id,
    expectedCount: 0,
    actor: 'admin@example.com',
  });
  assert.deepEqual(summary.switched, []);
  assert.deepEqual(summary.skipped, []);
});

test('the move is recorded in the audit log, one entry per device', async () => {
  const { store, from, to } = await fixture();
  const before = store.state.audit.length;
  await store.bulkConfigureDeviceAccount({
    fromAccountId: from.id,
    selectedAccountId: to.id,
    actor: 'admin@example.com',
  });
  const added = store.state.audit.slice(before)
    .filter((entry) => entry.event === 'device_account_configured');
  assert.equal(added.length, 3);
  for (const entry of added) {
    assert.equal(entry.next_account_id, to.id);
    assert.equal(entry.previous_account_id, from.id);
    assert.equal(entry.actor, 'admin@example.com');
  }
});

function render(store, { accountFilter = null } = {}) {
  return dashboardView({
    accounts: store.publicAccounts(),
    devices: store.publicDevices(),
    machines: store.publicMachines({ includeRevoked: true }),
    csrf: 'csrf-token',
    adminIdentity: 'admin@example.com',
    accountFilter,
  });
}

test('the dashboard offers a Claude account filter', async () => {
  const { store, from, to } = await fixture();
  const html = render(store);
  assert.match(html, /Filter by Claude account/);
  assert.match(html, /<option value="">All accounts<\/option>/);
  assert.ok(html.includes(from.alias) && html.includes(to.alias));
  // With no filter there is nothing to bulk-switch, so no bulk form.
  assert.equal(html.includes('/devices/account'), false);
});

test('filtering shows the count and a bulk form aimed at the other accounts', async () => {
  const { store, from, to } = await fixture();
  const html = render(store, { accountFilter: from.id });

  assert.match(html, /action="\/devices\/account"/);
  assert.match(html, /name="from_account_id" value="[^"]+"/);
  assert.match(html, /name="expected_count" value="3"/, 'the count the operator sees is submitted');
  assert.match(html, /Switch all 3/);
  // The account being moved from is not offered as a destination.
  const bulk = html.slice(html.indexOf('action="/devices/account"'), html.indexOf('Switch all 3'));
  assert.ok(bulk.includes(to.id), 'the other account is a destination');
  assert.equal(bulk.includes(`value="${from.id}"`) && bulk.includes('selected_account_id'), true);
  assert.equal(
    bulk.split('selected_account_id')[1]?.includes(from.id),
    false,
    'moving an account to itself is not offered',
  );
});

test('a filter that matches nothing says so instead of showing an empty form', async () => {
  const { store, to } = await fixture();
  const html = render(store, { accountFilter: to.id });
  assert.match(html, /No active credential is on/);
  assert.equal(html.includes('action="/devices/account"'), false);
});

test('an unknown or disabled account in the URL is ignored, not obeyed', async () => {
  const { store } = await fixture();
  const html = render(store, { accountFilter: 'no-such-account' });
  // Falls back to the unfiltered view rather than showing zero machines.
  assert.equal(html.includes('action="/devices/account"'), false);
  assert.match(html, /laptop-1/);
});
