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

function render(store, { accountFilter = null, memberFilter = null, groupFilter = null, deviceGroups = [] } = {}) {
  return dashboardView({
    accounts: store.publicAccounts(),
    devices: store.publicDevices(),
    machines: store.publicMachines({ includeRevoked: true }),
    csrf: 'csrf-token',
    adminIdentity: 'admin@example.com',
    accountFilter,
    memberFilter,
    groupFilter,
    deviceGroups,
  });
}

test('the dashboard offers a Claude account filter', async () => {
  const { store, from, to } = await fixture();
  const html = render(store);
  assert.match(html, /<span>Claude account<\/span>/);
  assert.match(html, /<span>Member<\/span>/);
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
  assert.match(html, /No active credential matches/);
  assert.equal(html.includes('action="/devices/account"'), false);
});

test('an unknown or disabled account in the URL is ignored, not obeyed', async () => {
  const { store } = await fixture();
  const html = render(store, { accountFilter: 'no-such-account' });
  // Falls back to the unfiltered view rather than showing zero machines.
  assert.equal(html.includes('action="/devices/account"'), false);
  assert.match(html, /laptop-1/);
});

async function mixedFixture() {
  const store = await newStore();
  const a = await claudeAccount(store, 'account-a');
  const b = await claudeAccount(store, 'account-b');
  const issue = async (accountId, memberLabel, deviceName) => {
    const { device: row } = await store.issueDeviceCredential({ accountId, memberLabel, deviceName });
    return row;
  };
  // Two people, spread across both accounts.
  const alice1 = await issue(a.id, 'alice@github', 'alice-laptop');
  const alice2 = await issue(b.id, 'alice@github', 'alice-desktop');
  const bob1 = await issue(a.id, 'bob@github', 'bob-laptop');
  return { store, a, b, alice1, alice2, bob1 };
}

test('a member filter selects that person across every account', async () => {
  const { store, a, b, alice1, alice2, bob1 } = await mixedFixture();
  const alice = store.devicesMatching({ memberLabel: 'alice@github' }).map((row) => row.id);
  assert.deepEqual(alice.sort(), [alice1.id, alice2.id].sort());
  assert.equal(alice.includes(bob1.id), false);

  // Combined with an account, both conditions apply.
  const aliceOnA = store.devicesMatching({ accountId: a.id, memberLabel: 'alice@github' });
  assert.deepEqual(aliceOnA.map((row) => row.id), [alice1.id]);
  assert.equal(store.devicesMatching({ accountId: b.id, memberLabel: 'bob@github' }).length, 0);
});

test("one member's credentials all move, wherever they were", async () => {
  const { store, b, alice1, alice2, bob1 } = await mixedFixture();
  const summary = await store.bulkConfigureDeviceAccount({
    memberLabel: 'alice@github',
    selectedAccountId: b.id,
    expectedCount: 2,
    actor: 'admin@example.com',
  });

  // alice2 was already on the target, so it is reported rather than counted as
  // a move; only the one that actually changed is in `switched`.
  assert.deepEqual(summary.switched, [alice1.id]);
  assert.equal(summary.skipped.length, 1);
  assert.match(summary.skipped[0].reason, /already on the target account/);
  assert.equal(store.resolveDeviceAccount(alice1.id).account.id, b.id);
  // Bob is untouched.
  assert.notEqual(store.resolveDeviceAccount(bob1.id).account.id, b.id);
});

test('moving with no filter at all is refused', async () => {
  const { store, b } = await mixedFixture();
  await assert.rejects(
    store.bulkConfigureDeviceAccount({ selectedAccountId: b.id, actor: 'admin@example.com' }),
    /a filter is required before moving anything/,
    'an unfiltered move would take the whole fleet',
  );
  assert.equal(store.devicesMatching({ memberLabel: 'bob@github' }).length, 1);
});

test('the member dropdown lists each active member once, sorted', async () => {
  const { store } = await mixedFixture();
  assert.deepEqual(store.activeMemberLabels(), ['alice@github', 'bob@github']);

  const html = render(store, { memberFilter: 'alice@github' });
  assert.match(html, /<option value="alice@github" selected>/);
  assert.match(html, /name="member_label" value="alice@github"/);
  assert.match(html, /<strong>2<\/strong> active credential\(s\) for <strong>alice@github<\/strong>/);
});

test('an unknown member in the URL is ignored rather than obeyed', async () => {
  const { store } = await mixedFixture();
  const html = render(store, { memberFilter: 'nobody@github' });
  assert.equal(html.includes('action="/devices/account"'), false, 'no bulk form for a filter that is not real');
  assert.match(html, /alice-laptop/, 'the unfiltered list is shown instead');
});

test('a Codex gateway credential is labelled Codex, not Claude Code', async () => {
  const store = await newStore();
  const codex = await store.addAccount({
    provider: 'codex',
    alias: 'codex-shared-1',
    emailLabel: '',
    external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
  });
  await store.issueDeviceCredential({
    accountId: codex.id,
    memberLabel: 'member@example.com',
    deviceName: 'codex-laptop',
  });

  const html = render(store);
  const row = /<tr[^>]*data-device-row[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
  assert.ok(row.includes('codex-laptop'), 'the row is rendered');
  assert.match(row, /<td>Codex<\/td>/, 'the client it belongs to is named correctly');
  assert.equal(row.includes('Claude Code'), false, 'the row used to say Claude Code for everything');
});

test('a Claude credential is still labelled Claude Code', async () => {
  const { store } = await fixture();
  const html = render(store);
  const row = /<tr[^>]*data-device-row[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
  assert.match(row, /<td>Claude Code<\/td>/);
});

test('no switch form is offered when there is nowhere to switch to', async () => {
  const store = await newStore();
  const only = await claudeAccount(store, 'only-account');
  await store.issueDeviceCredential({
    accountId: only.id,
    memberLabel: 'member@example.com',
    deviceName: 'lonely-laptop',
  });

  const html = render(store);
  assert.match(html, /Only one Claude account is registered/);
  assert.equal(
    html.includes('action="/devices/'),
    true,
    'the revoke form is still there',
  );
  const switchForms = html.match(/data-account-switch\b/g) ?? [];
  assert.deepEqual(switchForms, [], 'a button whose only effect is a refusal is not offered');
});

test('the switch form returns as soon as there is a second account', async () => {
  const { store } = await fixture();
  const html = render(store);
  assert.ok((html.match(/data-account-switch\b/g) ?? []).length > 0);
  assert.equal(html.includes('Only one Claude account is registered'), false);
});

async function machineGroupFixture() {
  const store = await newStore();
  const main = await claudeAccount(store, 'main-account');
  const spare = await claudeAccount(store, 'spare-account');
  const issue = async (name) => {
    const { device: row } = await store.issueDeviceCredential({
      accountId: main.id, memberLabel: 'member@example.com', deviceName: name,
    });
    return row;
  };
  const a = await issue('laptop-a');
  const b = await issue('laptop-b');
  const c = await issue('laptop-c');
  await store.createDeviceGroup('team-a');
  await store.createDeviceGroup('on-call');
  await store.setDeviceGroups(a.id, ['team-a']);
  await store.setDeviceGroups(b.id, ['team-a', 'on-call']);
  return { store, main, spare, a, b, c };
}

test('a machine group selects its members, and a machine can be in several', async () => {
  const { store, a, b, c } = await machineGroupFixture();
  assert.deepEqual(
    store.devicesMatching({ group: 'team-a' }).map((row) => row.id).sort(),
    [a.id, b.id].sort(),
  );
  // b is in both; asking for either finds it.
  assert.deepEqual(store.devicesMatching({ group: 'on-call' }).map((row) => row.id), [b.id]);
  assert.equal(store.devicesMatching({ group: 'team-a' }).some((row) => row.id === c.id), false);
});

test('a whole group moves in one press, and combines with the other filters', async () => {
  const { store, spare, a, b } = await machineGroupFixture();
  const summary = await store.bulkConfigureDeviceAccount({
    group: 'team-a',
    selectedAccountId: spare.id,
    expectedCount: 2,
    actor: 'admin@example.com',
  });
  assert.deepEqual(summary.switched.sort(), [a.id, b.id].sort());
  assert.equal(store.resolveDeviceAccount(a.id).account.id, spare.id);

  // group + member narrow together
  assert.equal(store.devicesMatching({ group: 'on-call', memberLabel: 'member@example.com' }).length, 1);
  assert.equal(store.devicesMatching({ group: 'on-call', memberLabel: 'nobody@example.com' }).length, 0);
});

test('only registered names can be assigned', async () => {
  const { store, c } = await machineGroupFixture();
  await assert.rejects(
    () => store.setDeviceGroups(c.id, ['team-a', 'invented']),
    /no such group: invented/,
    'silently dropping it would look like the assignment worked',
  );
  assert.equal(store.state.devices.find((row) => row.id === c.id).groups, undefined);
});

test('renaming a group carries its members with it', async () => {
  const { store, a, b } = await machineGroupFixture();
  await store.renameDeviceGroup('team-a', 'team-alpha');
  assert.deepEqual(store.deviceGroups(), ['on-call', 'team-alpha']);
  assert.deepEqual(
    store.devicesMatching({ group: 'team-alpha' }).map((row) => row.id).sort(),
    [a.id, b.id].sort(),
  );
  assert.deepEqual(store.devicesMatching({ group: 'team-a' }), [], 'the old name is gone');
  // b keeps its other group.
  assert.deepEqual(store.state.devices.find((row) => row.id === b.id).groups.sort(), ['on-call', 'team-alpha']);
});

test('deleting a group releases its members and leaves everything else alone', async () => {
  const { store, b } = await machineGroupFixture();
  const result = await store.deleteDeviceGroup('team-a');
  assert.equal(result.membersReleased, 2);
  assert.deepEqual(store.deviceGroups(), ['on-call']);
  assert.deepEqual(store.state.devices.find((row) => row.id === b.id).groups, ['on-call']);
  assert.deepEqual(store.devicesMatching({ group: 'team-a' }), []);
});

test('group names are validated, and duplicates refused', async () => {
  const { store } = await machineGroupFixture();
  for (const bad of ['<script>', '-dash-first', 'x'.repeat(65), '']) {
    await assert.rejects(() => store.createDeviceGroup(bad), /group name/, JSON.stringify(bad));
  }
  await assert.rejects(() => store.createDeviceGroup('team-a'), /already exists/);
  await assert.rejects(() => store.renameDeviceGroup('team-a', 'on-call'), /already exists/);
  assert.deepEqual(store.deviceGroups(), ['on-call', 'team-a'], 'nothing changed');
});

test('a group with no members moves nothing rather than everything', async () => {
  const { store, spare } = await machineGroupFixture();
  await store.createDeviceGroup('empty-group');
  assert.deepEqual(store.devicesMatching({ group: 'empty-group' }), []);
  await assert.rejects(
    store.bulkConfigureDeviceAccount({
      group: 'empty-group', selectedAccountId: spare.id, expectedCount: 2, actor: 'a',
    }),
    /the list changed: 0 devices/,
  );
});

test('the dashboard offers the registry, the per-row picker and the filter', async () => {
  const { store, a } = await machineGroupFixture();
  const groups = store.deviceGroups();
  const plain = render(store, { deviceGroups: groups });

  assert.match(plain, /<summary>Machine groups \(2\)<\/summary>/, 'names are managed in one place');
  assert.match(plain, /action="\/device-groups"/);
  assert.match(plain, new RegExp(`action="/devices/${a.id}/groups"`), 'each machine picks from the list');
  assert.match(plain, /<select name="groups" multiple/, 'a list to choose from, not a box to type in');
  assert.match(plain, /<span>Machine group<\/span>/, 'and the filter is offered');

  const filtered = render(store, { deviceGroups: groups, groupFilter: 'team-a' });
  assert.match(filtered, /name="group" value="team-a"/, 'the bulk form carries the group');
  assert.match(filtered, /<strong>2<\/strong> active credential\(s\) in <strong>team-a<\/strong>/);
});

test('an unknown group in the URL falls back to the unfiltered list', async () => {
  const { store } = await machineGroupFixture();
  const html = render(store, { deviceGroups: store.deviceGroups(), groupFilter: 'nope' });
  assert.equal(html.includes('action="/devices/account"'), false);
  assert.match(html, /laptop-c/);
});
