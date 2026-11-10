import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { chooseFailoverAccount } from '../lib/account-failover.js';
import { createCredentialConsole } from '../server.js';

const MACHINE_A = 'machine-aaaaaaaaaaaaaaaa';
const MACHINE_B = 'machine-bbbbbbbbbbbbbbbb';
const MEMBER = { 'Tailscale-User-Login': 'member@example.com' };
const PASSWORD = 'correct horse battery';

async function newStore() {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-access-'));
  return new CredentialStore(home, { allowKeyInit: true }).init();
}

async function claude(store, alias) {
  return store.addAccount({ provider: 'claude', alias, credential: { oauth_token: `${alias}-token` } });
}

async function issue(store, account, name, machineId = null, admitMachine = false) {
  return store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member@example.com',
    deviceName: name,
    machineId,
    admitMachine,
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function app({ adminAuth = 'password', seed = async () => {} } = {}) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamUrl = await listen(upstream);
  const store = await newStore();
  await seed(store);
  const { server } = await createCredentialConsole({
    store,
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
    adminAuth,
    cookieSecure: false,
    metricsQueryService: false,
    publicBaseUrl: 'http://credential-console.test',
    claudeUpstreamBaseUrl: upstreamUrl,
    codexUpstreamBaseUrl: upstreamUrl,
  });
  const baseUrl = await listen(server);
  let cookie = null;
  const request = async (path, { method = 'GET', form = null, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...MEMBER,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.text() };
  };
  const csrf = async () => {
    const { body } = await request('/');
    return body.match(/name="csrf" value="([^"]+)"/)[1];
  };
  return {
    store,
    baseUrl,
    request,
    csrf,
    async login(username = 'root', password = PASSWORD) {
      const token = (await request('/login')).body.match(/name="csrf" value="([^"]+)"/)[1];
      return request('/login', { method: 'POST', form: { csrf: token, username, password, next: '/admin' } });
    },
    async close() {
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    },
  };
}

test('administrator passwords are stored as scrypt digests and checked in constant shape', async () => {
  const store = await newStore();
  await store.addAdminUser({ username: 'root', password: PASSWORD });
  assert.equal(await store.verifyAdminLogin('root', PASSWORD), 'root');
  assert.equal(await store.verifyAdminLogin('root', 'wrong password'), null);
  assert.equal(await store.verifyAdminLogin('nobody', PASSWORD), null);
  await assert.rejects(store.addAdminUser({ username: 'ROOT', password: PASSWORD }), /already exists/);
  await assert.rejects(store.addAdminUser({ username: 'short', password: 'abc' }), /at least 10/);
  await assert.rejects(store.deleteAdminUser('root'), /last administrator/);
  await store.addAdminUser({ username: 'second', password: PASSWORD });
  await store.setAdminPassword('second', 'another long password');
  assert.equal(await store.verifyAdminLogin('second', 'another long password'), 'second');
  await store.deleteAdminUser('second');
  assert.deepEqual(store.adminUsers().map((user) => user.username), ['root']);
  const state = await readFile(store.statePath, 'utf8');
  assert.equal(state.includes(PASSWORD), false);
  assert.match(state, /"algorithm": "scrypt"/);
});

test('making an account private moves unlisted devices and takes it out of shared chains', async () => {
  const store = await newStore();
  const mine = await claude(store, 'claude-mine');
  const shared = await claude(store, 'claude-shared');
  const other = await claude(store, 'claude-other');
  const listed = await issue(store, mine, 'my-mac', MACHINE_A);
  const kid = await issue(store, mine, 'kid-laptop', MACHINE_B);
  const legacy = await issue(store, mine, 'old-box');
  await store.setAccountFailover(shared.id, { enabled: true, backupAccountIds: [mine.id] });
  await store.setAccountFailover(other.id, { enabled: true, backupAccountIds: [mine.id, shared.id] });

  const plan = store.accountRestrictionPlan(mine.id, { enabled: true, machineIds: [MACHINE_A] });
  assert.deepEqual(plan.affected.map((device) => device.id).sort(), [kid.device.id, legacy.device.id].sort());
  await assert.rejects(
    store.setAccountRestriction(mine.id, { enabled: true, machineIds: [MACHINE_A] }),
    /choose an account/,
  );
  const result = await store.setAccountRestriction(mine.id, {
    enabled: true,
    machineIds: [MACHINE_A],
    migrateToAccountId: shared.id,
    actor: 'admin:root',
  });
  assert.equal(result.moved.length, 2);
  assert.equal(store.resolveDeviceAccount(listed.device.id).account.id, mine.id);
  assert.equal(store.resolveDeviceAccount(kid.device.id).account.id, shared.id);
  assert.equal(store.resolveDeviceAccount(legacy.device.id).account.id, shared.id);
  // Off the chains of shared accounts; an emptied chain is switched off.
  assert.deepEqual(store.accountById(shared.id).failover, {
    ...store.accountById(shared.id).failover, enabled: false, backup_account_ids: [],
  });
  assert.deepEqual(store.accountById(other.id).failover.backup_account_ids, [shared.id]);
  assert.equal(store.accountById(other.id).failover.enabled, true);
  // And the original account stays in the policy but is not offered.
  assert.equal(store.deviceAccountSummary(kid.device.id).allowed_account_ids.includes(mine.id), false);
});

test('no path puts an unlisted device on a private account', async () => {
  const store = await newStore();
  const mine = await claude(store, 'claude-mine');
  const shared = await claude(store, 'claude-shared');
  const listed = await issue(store, mine, 'my-mac', MACHINE_A);
  // Issued on the account before it went private, so it stays in the device's
  // policy as the original account: the allowlist alone would let it back.
  const kid = await issue(store, mine, 'kid-laptop', MACHINE_B);
  await store.setAccountRestriction(mine.id, {
    enabled: true, machineIds: [MACHINE_A], migrateToAccountId: shared.id,
  });

  await assert.rejects(
    store.configureDeviceAccount({ deviceId: kid.device.id, selectedAccountId: mine.id, actor: 'admin' }),
    (error) => error.code === 'ACCOUNT_RESTRICTED',
  );
  await assert.rejects(
    store.switchDeviceAccount({ deviceId: kid.device.id, selectedAccountId: mine.id, actorDeviceId: kid.device.id }),
    (error) => error.code === 'ACCOUNT_RESTRICTED',
  );
  const bulk = await store.bulkConfigureDeviceAccount({ fromAccountId: shared.id, selectedAccountId: mine.id });
  assert.deepEqual(bulk.switched, []);
  assert.match(bulk.skipped[0].reason, /reserved for other machines/);
  await assert.rejects(
    store.failoverDeviceAccount({
      deviceId: kid.device.id, homeAccountId: shared.id, fromAccountId: shared.id, toAccountId: mine.id,
    }),
    (error) => error.code === 'ACCOUNT_RESTRICTED',
  );
  await assert.rejects(issue(store, mine, 'kid-second', MACHINE_B), (error) => error.code === 'ACCOUNT_RESTRICTED');
  await assert.rejects(store.createEnrollment({ accountId: mine.id, memberLabel: 'kid' }), /enrollment code/);
  await assert.rejects(
    store.setAccountFailover(shared.id, { enabled: true, backupAccountIds: [mine.id] }),
    /cannot back up a shared account/,
  );
  // An administrator issuing on it admits the machine; a listed one needs nothing.
  await issue(store, mine, 'new-mac', MACHINE_B, true);
  assert.deepEqual(store.accountById(mine.id).restriction.machine_ids, [MACHINE_A, MACHINE_B]);
  // Even a listed machine: its handle is derived from a name anyone can type.
  await assert.rejects(issue(store, mine, 'my-mac-2', MACHINE_A), (error) => error.code === 'ACCOUNT_RESTRICTED');
  await assert.rejects(issue(store, mine, 'no-machine', null, true), /needs a machine name/);
  assert.equal(store.resolveDeviceAccount(listed.device.id).account.id, mine.id);

  // Whatever wrote the row, the gateway's own resolution refuses it.
  const device = store.state.devices.find((entry) => entry.id === listed.device.id);
  store.accountById(mine.id).restriction.machine_ids = [MACHINE_B];
  assert.throws(() => store.resolveDeviceAccount(device.id), (error) => error.code === 'ACCOUNT_RESTRICTED');
});

test('quota failover skips a private backup the device is not listed on, and never fails back onto one', async () => {
  const store = await newStore();
  const home = await claude(store, 'claude-home');
  const privateBackup = await claude(store, 'claude-private-backup');
  const sharedBackup = await claude(store, 'claude-shared-backup');
  const device = (await issue(store, home, 'mac', MACHINE_A)).device;
  await store.setAccountRestriction(home.id, { enabled: true, machineIds: [MACHINE_A] });
  await store.setAccountRestriction(privateBackup.id, { enabled: true, machineIds: [MACHINE_B] });
  await store.setAccountFailover(home.id, { enabled: true, backupAccountIds: [privateBackup.id, sharedBackup.id] });
  const exhaustion = { exhausted: () => false, modelExhausted: () => false };
  const pick = chooseFailoverAccount({ store, homeAccount: store.accountById(home.id), device, exhaustion });
  assert.equal(pick.id, sharedBackup.id);

  await store.failoverDeviceAccount({
    deviceId: device.id, homeAccountId: home.id, fromAccountId: home.id, toAccountId: sharedBackup.id,
  });
  // The home account is taken off this machine while the device is away.
  store.accountById(home.id).restriction = { enabled: true, machine_ids: [MACHINE_B] };
  const back = await store.failbackDeviceAccount({ deviceId: device.id });
  assert.equal(back.outcome, 'cleared');
  assert.equal(store.resolveDeviceAccount(device.id).account.id, sharedBackup.id);
});

test('password mode: a member sees self-service only, private accounts are absent, admin pages need sign-in', async () => {
  const console = await app({
    seed: async (store) => {
      await store.addAdminUser({ username: 'root', password: PASSWORD });
      const mine = await claude(store, 'claude-zefan-private');
      await claude(store, 'claude-team');
      await store.setAccountRestriction(mine.id, { enabled: true, machineIds: [MACHINE_A] });
    },
  });
  try {
    const home = await console.request('/');
    assert.equal(home.response.status, 200);
    assert.match(home.body, /claude-team/);
    assert.doesNotMatch(home.body, /claude-zefan-private/);
    assert.doesNotMatch(home.body, /class="admin-zone"/);
    assert.match(home.body, /href="\/login"/);
    assert.doesNotMatch(home.body, /href="\/admin"/);
    assert.doesNotMatch(home.body, /href="\/conversations"/);

    const guide = await console.request('/onboarding.md');
    assert.doesNotMatch(guide.body, /claude-zefan-private/);
    assert.match(guide.body, /claude-team/);

    for (const path of ['/admin', '/conversations', '/conversation-turns']) {
      const page = await console.request(path);
      assert.equal(page.response.status, 303, path);
      assert.match(page.response.headers.get('location'), /^\/login\?next=/);
    }
    const csrf = await console.csrf();
    // Members may add Claude and Codex accounts now (see the member-accounts
    // tests), but never a Bedrock key.
    const add = await console.request('/accounts', {
      method: 'POST',
      form: { csrf, provider: 'bedrock', alias: 'x-y', region: 'us-west-2', model_id: 'm', api_key: 'k' },
    });
    assert.equal(add.response.status, 303);
    assert.match(decodeURIComponent(add.response.headers.get('location')), /only an administrator can add a Bedrock account/);
    assert.equal(console.store.state.accounts.length, 2);
    const metrics = await console.request('/metrics');
    assert.equal(metrics.response.status, 200);

    const wrong = await console.login('root', 'not the password');
    assert.equal(wrong.response.status, 401);
    const right = await console.login();
    assert.equal(right.response.status, 303);
    assert.equal(right.response.headers.get('location'), '/admin');
    const admin = await console.request('/admin');
    assert.equal(admin.response.status, 200);
    assert.match(admin.body, /id="administrators"/);
    const full = await console.request('/');
    assert.match(full.body, /claude-zefan-private/);
    assert.match(full.body, /class="admin-zone"/);
    assert.match(full.body, /href="\/logout"/);
    assert.match((await console.request('/onboarding.md')).body, /claude-zefan-private/);

    await console.request('/logout');
    assert.equal((await console.request('/admin')).response.status, 303);
  } finally {
    await console.close();
  }
});

test('password mode: repeated wrong passwords are rate limited and a session token is replaced on sign-in', async () => {
  const console = await app({
    seed: async (store) => store.addAdminUser({ username: 'root', password: PASSWORD }),
  });
  try {
    await console.request('/');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await console.login('root', 'wrong password')).response.status, 401);
    }
    const limited = await console.login();
    assert.equal(limited.response.status, 429);
  } finally {
    await console.close();
  }
  const fresh = await app({
    seed: async (store) => store.addAdminUser({ username: 'root', password: PASSWORD }),
  });
  try {
    await fresh.request('/');
    const before = (await fresh.request('/login')).response.headers.get('set-cookie');
    assert.equal(before, null);
    const signedIn = await fresh.login();
    assert.match(signedIn.response.headers.get('set-cookie'), /credential_console_session=/);
  } finally {
    await fresh.close();
  }
});

test('password mode: a member cannot issue on a private account; an administrator issuing admits the machine', async () => {
  let privateId;
  const console = await app({
    seed: async (store) => {
      await store.addAdminUser({ username: 'root', password: PASSWORD });
      await claude(store, 'claude-team');
      const mine = await claude(store, 'claude-private');
      privateId = mine.id;
      await store.setAccountRestriction(mine.id, { enabled: true, machineIds: [MACHINE_A] });
    },
  });
  try {
    const csrf = await console.csrf();
    const refused = await console.request('/self-service', {
      method: 'POST',
      form: { csrf, account_id: privateId, device_name: 'kid-laptop', machine: 'kid-laptop' },
    });
    assert.equal(refused.response.status, 303);
    assert.match(decodeURIComponent(refused.response.headers.get('location')), /reserved for other machines/);
    assert.equal(console.store.state.devices.length, 0);

    await console.login();
    const token = await console.csrf();
    const issued = await console.request('/self-service', {
      method: 'POST',
      form: { csrf: token, account_id: privateId, device_name: 'new-mac', machine: 'new-mac' },
    });
    assert.equal(issued.response.status, 200);
    assert.equal(console.store.state.devices.length, 1);
    assert.equal(console.store.accountById(privateId).restriction.machine_ids.length, 2);
  } finally {
    await console.close();
  }
});

test('the gateway refuses a device on a private account it is not listed on', async () => {
  let listedToken;
  let kidToken;
  const console = await app({
    adminAuth: 'tailscale',
    seed: async (store) => {
      const mine = await claude(store, 'claude-mine');
      listedToken = (await issue(store, mine, 'my-mac', MACHINE_A)).token;
      kidToken = (await issue(store, mine, 'kid', MACHINE_B)).token;
      // Written straight into the row, as a hand edit or a bug might: the
      // proxy's own check is what is under test.
      store.accountById(mine.id).restriction = { enabled: true, machine_ids: [MACHINE_A] };
    },
  });
  try {
    const send = (token) => fetch(`${console.baseUrl}/claude/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const kid = await send(kidToken);
    assert.equal(kid.status, 403);
    assert.match(await kid.text(), /reserved for other machines/);
    const listed = await send(listedToken);
    assert.notEqual(listed.status, 403);
    await listed.text();
  } finally {
    await console.close();
  }
});

test('tailscale mode is unchanged: every visitor is an administrator and there is no sign-in', async () => {
  const console = await app({ adminAuth: 'tailscale' });
  try {
    const admin = await console.request('/admin');
    assert.equal(admin.response.status, 200);
    assert.doesNotMatch(admin.body, /id="administrators"/);
    const home = await console.request('/');
    assert.doesNotMatch(home.body, /href="\/login"/);
    assert.match(home.body, /href="\/conversations"/);
    assert.equal((await console.request('/login')).response.status, 404);
  } finally {
    await console.close();
  }
});

test('password mode: parallel guesses still hit the limit, and a hostile next cannot break the redirect', async () => {
  const console = await app({
    seed: async (store) => store.addAdminUser({ username: 'root', password: PASSWORD }),
  });
  try {
    const csrf = (await console.request('/login')).body.match(/name="csrf" value="([^"]+)"/)[1];
    const statuses = await Promise.all(Array.from({ length: 12 }, () => console.request('/login', {
      method: 'POST', form: { csrf, username: 'root', password: 'wrong password' },
    }).then(({ response }) => response.status)));
    assert.equal(statuses.filter((status) => status === 401).length, 5);
    assert.equal(statuses.filter((status) => status === 429).length, 7);
  } finally {
    await console.close();
  }
  const other = await app({
    seed: async (store) => store.addAdminUser({ username: 'root', password: PASSWORD }),
  });
  try {
    const csrf = (await other.request('/login?next=/%C4%80')).body.match(/name="csrf" value="([^"]+)"/)[1];
    const signedIn = await other.request('/login', {
      method: 'POST', form: { csrf, username: 'root', password: PASSWORD, next: '/\u0100' },
    });
    assert.equal(signedIn.response.headers.get('location'), '/');
    const again = await other.request('/login?next=/%C4%80');
    assert.equal(again.response.headers.get('location'), '/');
    assert.equal((await other.request('/login?next=//evil.example')).response.headers.get('location'), '/');
  } finally {
    await other.close();
  }
});

test('password mode: changing a password ends the administrator\'s other sessions', async () => {
  const first = await app({
    seed: async (store) => store.addAdminUser({ username: 'root', password: PASSWORD }),
  });
  try {
    await first.login();
    assert.equal((await first.request('/admin')).response.status, 200);
    await first.store.setAdminPassword('root', 'a brand new password');
    assert.equal((await first.request('/admin')).response.status, 303);
    await first.login('root', 'a brand new password');
    const csrf = (await first.request('/admin')).body.match(/name="csrf" value="([^"]+)"/)[1];
    await first.request('/admin/password', {
      method: 'POST', form: { csrf, current_password: 'a brand new password', password: 'yet another password' },
    });
    // The session that made the change carries on.
    assert.equal((await first.request('/admin')).response.status, 200);
  } finally {
    await first.close();
  }
});

test('a Codex account with a live unlisted dispenser machine cannot be made private', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'credential-console-dispenser-'));
  await mkdir(join(codexHome, 'clients'));
  await writeFile(join(codexHome, 'clients', 'clients.json'), JSON.stringify({
    clients: [{ name: 'old-box', machine_id: MACHINE_B, revoked: false }],
  }));
  let accountId;
  const console = await app({
    adminAuth: 'tailscale',
    seed: async (store) => {
      accountId = (await store.addAccount({
        provider: 'codex', alias: 'codex-mine', external: { kind: 'codex-credential', home: codexHome },
      })).id;
    },
  });
  try {
    const csrf = await console.csrf();
    const refused = await console.request(`/accounts/${accountId}/restriction`, {
      method: 'POST', form: { csrf, enabled: '1', [`machine:${MACHINE_A}`]: '1' },
    });
    assert.match(decodeURIComponent(refused.response.headers.get('location')), /dispenser machines first: old-box/);
    assert.equal(console.store.accountById(accountId).restriction, undefined);
    const listed = await console.request(`/accounts/${accountId}/restriction`, {
      method: 'POST', form: { csrf, enabled: '1', [`machine:${MACHINE_B}`]: '1' },
    });
    assert.match(listed.response.headers.get('location'), /^\/\?notice=restriction-private[^#]*#account-/);
    assert.equal(console.store.accountById(accountId).restriction.enabled, true);
  } finally {
    await console.close();
  }
});

test('an administrator gives a legacy credential a new machine, which a private account can then list', async () => {
  let deviceId;
  let accountId;
  const console = await app({
    adminAuth: 'tailscale',
    seed: async (store) => {
      const mine = await claude(store, 'claude-mine');
      accountId = mine.id;
      deviceId = (await issue(store, mine, 'zefan-mac-studio')).device.id;
    },
  });
  try {
    const home = await console.request('/');
    assert.match(home.body, new RegExp(`action="/devices/${deviceId}/machine"`));
    const csrf = home.body.match(/name="csrf" value="([^"]+)"/)[1];
    const named = await console.request(`/devices/${deviceId}/machine`, {
      method: 'POST', form: { csrf, machine_name: 'zefan-mac-studio' },
    });
    assert.equal(named.response.headers.get('location'), '/');
    const machineId = console.store.state.devices[0].machine_id;
    assert.match(machineId, /^[0-9a-f]{40}$/);
    await console.store.setAccountRestriction(accountId, { enabled: true, machineIds: [machineId] });
    assert.equal(console.store.resolveDeviceAccount(deviceId).account.id, accountId);
  } finally {
    await console.close();
  }
});

test('a request that throws is answered 500 and the console keeps serving', async () => {
  const console = await app({ adminAuth: 'tailscale' });
  try {
    const broken = await fetch(`${console.baseUrl}/codex-agent/%E0`);
    assert.equal(broken.status, 500);
    await broken.text();
    const next = await fetch(`${console.baseUrl}/health`);
    assert.equal(next.status, 200);
    await next.text();
  } finally {
    await console.close();
  }
});

test('making an account private can disconnect the unlisted devices instead of moving them', async () => {
  const store = await newStore();
  const mine = await claude(store, 'claude-mine');
  const kid = await issue(store, mine, 'kid-laptop', MACHINE_B);
  await issue(store, mine, 'my-mac', MACHINE_A);
  // The only account there is: nowhere to move the kid's device to.
  const result = await store.setAccountRestriction(mine.id, {
    enabled: true, machineIds: [MACHINE_A], disconnect: true,
  });
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.disconnected, [kid.device.id]);
  assert.throws(() => store.resolveDeviceAccount(kid.device.id), (error) => error.code === 'ACCOUNT_RESTRICTED');
});

test('password mode: saves say what they did, and members move devices between shared accounts only', async () => {
  let ids;
  const console = await app({
    seed: async (store) => {
      await store.addAdminUser({ username: 'root', password: PASSWORD });
      const team = await claude(store, 'claude-team');
      const spare = await claude(store, 'claude-spare');
      const mine = await claude(store, 'claude-mine');
      const kid = (await issue(store, team, 'kid-laptop', MACHINE_B)).device;
      const mac = (await issue(store, mine, 'zefan-studio', MACHINE_A)).device;
      // Shared too, but not shown to members: it stays off their list.
      const hidden = (await issue(store, team, 'admin-box', MACHINE_A)).device;
      await store.setDeviceMemberVisible(kid.id, true);
      await store.setDeviceMemberVisible(mac.id, true);
      await store.setAccountRestriction(mine.id, { enabled: true, machineIds: [MACHINE_A] });
      ids = { team: team.id, spare: spare.id, mine: mine.id, kid: kid.id, mac: mac.id, hidden: hidden.id };
    },
  });
  try {
    const home = await console.request('/');
    assert.match(home.body, /id="member-devices"/);
    assert.match(home.body, /kid-laptop/);
    assert.doesNotMatch(home.body, /zefan-studio/);
    assert.doesNotMatch(home.body, /admin-box/);
    // The way in is a faint link at the foot of the page, not a topbar button.
    assert.doesNotMatch(home.body, /<div class="topbar-actions"><a class="button secondary" href="\/login"/);
    assert.match(home.body, /<footer[^>]*><a href="\/login"/);
    const csrf = home.body.match(/name="csrf" value="([^"]+)"/)[1];
    const moved = await console.request(`/member/devices/${ids.kid}/account`, {
      method: 'POST', form: { csrf, selected_account_id: ids.spare },
    });
    assert.match(moved.response.headers.get('location'), /notice=member-switched/);
    assert.equal(console.store.resolveDeviceAccount(ids.kid).account.id, ids.spare);
    for (const [device, target] of [[ids.kid, ids.mine], [ids.mac, ids.team]]) {
      const refused = await console.request(`/member/devices/${device}/account`, {
        method: 'POST', form: { csrf, selected_account_id: target },
      });
      assert.match(decodeURIComponent(refused.response.headers.get('location')), /only devices on shared accounts/);
    }
    assert.equal(console.store.resolveDeviceAccount(ids.mac).account.id, ids.mine);
    const notShown = await console.request(`/member/devices/${ids.hidden}/account`, {
      method: 'POST', form: { csrf, selected_account_id: ids.spare },
    });
    assert.match(decodeURIComponent(notShown.response.headers.get('location')), /device not found/);
    assert.equal(console.store.resolveDeviceAccount(ids.hidden).account.id, ids.team);
    // A member's own issuance shows up on their list straight away.
    await console.request('/self-service', {
      method: 'POST', form: { csrf, account_id: ids.team, device_name: 'kid-new', machine: 'kid-new' },
    });
    assert.equal(console.store.state.devices.find((device) => device.name === 'kid-new').member_visible, true);

    await console.login();
    const admin = await console.request('/');
    const token = admin.body.match(/name="csrf" value="([^"]+)"/)[1];
    // An administrator shows the hidden device to members.
    assert.match(admin.body, new RegExp(`action="/devices/${ids.hidden}/member-visible"`));
    await console.request(`/devices/${ids.hidden}/member-visible`, { method: 'POST', form: { csrf: token, visible: '1' } });
    assert.equal(console.store.state.devices.find((device) => device.id === ids.hidden).member_visible, true);
    // The kid's machine is not on the private account's list, so the switch
    // control does not offer it, and a forced switch says why.
    const kidRow = admin.body.slice(admin.body.indexOf(`/devices/${ids.kid}/account`));
    assert.doesNotMatch(kidRow.slice(0, kidRow.indexOf('</form>')), new RegExp(`value="${ids.mine}"`));
    const forced = await console.request(`/devices/${ids.kid}/account`, {
      method: 'POST', form: { csrf: token, selected_account_id: ids.mine },
    });
    assert.match(decodeURIComponent(forced.response.headers.get('location')), /is not on claude-mine's list/);
    const asyncForced = await console.request(`/devices/${ids.kid}/account`, {
      method: 'POST',
      form: { csrf: token, selected_account_id: ids.mine },
      headers: { Accept: 'application/json', 'X-Credential-Console-Async': 'account-switch' },
    });
    assert.equal(asyncForced.response.status, 403);
    assert.equal(JSON.parse(asyncForced.body).error, 'account_restricted');

    // Machines ticked but the account left shared: saved, and the page says so.
    const ticked = await console.request(`/accounts/${ids.team}/restriction`, {
      method: 'POST', form: { csrf: token, enabled: '0', [`machine:${MACHINE_B}`]: '1' },
    });
    assert.match(ticked.response.headers.get('location'), /notice=restriction-shared-ticked/);
    const after = await console.request(ticked.response.headers.get('location'));
    assert.match(after.body, /data-i18n="notice-restriction-shared-ticked"/);
    // Made private with the kid's device disconnected rather than moved.
    const plan = await console.request(`/accounts/${ids.spare}/restriction`, {
      method: 'POST', form: { csrf: token, enabled: '1', [`machine:${MACHINE_A}`]: '1' },
    });
    assert.match(plan.body, /value="__disconnect__"/);
    assert.match(plan.body, /data-i18n="restriction-confirm-unsaved"/);
    const cut = await console.request(`/accounts/${ids.spare}/restriction`, {
      method: 'POST',
      form: { csrf: token, enabled: '1', [`machine:${MACHINE_A}`]: '1', migrate_to: '__disconnect__' },
    });
    assert.match(cut.response.headers.get('location'), /notice=restriction-private.*disconnected=1/);
    assert.throws(() => console.store.resolveDeviceAccount(ids.kid), (error) => error.code === 'ACCOUNT_RESTRICTED');
  } finally {
    await console.close();
  }
});

test('password mode: a member adds a Claude and a Codex account and lands on its authorization page', async () => {
  const console = await app({
    seed: async (store) => { await store.addAdminUser({ username: 'root', password: PASSWORD }); },
  });
  try {
    const home = await console.request('/');
    assert.match(home.body, /id="member-accounts"/);
    assert.match(home.body, /data-persist-draft="member-register-claude-account"/);
    assert.doesNotMatch(home.body, /name="openai_api_key"/, 'no platform-key field on the member form');

    const csrf = await console.csrf();
    const claudeAdd = await console.request('/accounts', {
      method: 'POST', form: { csrf, provider: 'claude', alias: 'claude-alex', email_label: 'alex@example.com' },
    });
    assert.equal(claudeAdd.response.status, 303);
    const claudeRow = console.store.state.accounts.find((entry) => entry.alias === 'claude-alex');
    assert.ok(claudeRow);
    assert.equal(claudeAdd.response.headers.get('location'), `/accounts/${claudeRow.id}/claude-authorization`);
    assert.deepEqual(claudeRow.created_by, { role: 'member', identity: 'member@example.com' });
    assert.equal(claudeRow.status, 'login_required');

    const codexAdd = await console.request('/accounts', {
      method: 'POST', form: { csrf, provider: 'codex', alias: 'codex-alex' },
    });
    const codexRow = console.store.state.accounts.find((entry) => entry.alias === 'codex-alex');
    assert.equal(codexAdd.response.headers.get('location'), `/accounts/${codexRow.id}/codex-authorization`);

    // The member reaches the authorization pages of the rows they added.
    assert.equal((await console.request(`/accounts/${claudeRow.id}/claude-authorization`)).response.status, 200);
    assert.equal((await console.request(`/accounts/${codexRow.id}/codex-authorization`)).response.status, 200);

    // And sees them on their page with the next step.
    const after = await console.request('/');
    assert.match(after.body, /Accounts you added/);
    assert.match(after.body, new RegExp(`href="/accounts/${claudeRow.id}/claude-authorization"`));
    assert.match(after.body, new RegExp(`href="/accounts/${codexRow.id}/codex-authorization"`));

    const audit = console.store.state.audit.filter((entry) => entry.event === 'account_added');
    assert.ok(audit.every((entry) => entry.created_by_role === 'member' && entry.created_by === 'member@example.com'));
  } finally {
    await console.close();
  }
});

test('password mode: a member cannot authorize an account someone else added', async () => {
  let teamClaude;
  let teamCodex;
  const console = await app({
    seed: async (store) => {
      await store.addAdminUser({ username: 'root', password: PASSWORD });
      // A row from before creators were recorded, and one another member added.
      teamClaude = await store.addAccount({ provider: 'claude', alias: 'claude-team', emailLabel: 'team@example.com' });
      teamCodex = await store.addAccount({
        provider: 'codex', alias: 'codex-other', createdBy: { role: 'member', identity: 'someone-else@example.com' },
      });
    },
  });
  try {
    const csrf = await console.csrf();
    for (const path of [
      `/accounts/${teamClaude.id}/claude-authorization`,
      `/accounts/${teamCodex.id}/codex-authorization`,
    ]) {
      const page = await console.request(path);
      assert.equal(page.response.status, 403, path);
      assert.match(page.body, /only the accounts they added themselves/);
    }
    for (const path of [
      `/accounts/${teamClaude.id}/claude-authorization/start`,
      `/accounts/${teamClaude.id}/claude-authorization/complete`,
      `/accounts/${teamCodex.id}/codex-authorization/start`,
      `/accounts/${teamCodex.id}/codex-authorization/complete`,
      `/accounts/${teamCodex.id}/codex-authorization/paste`,
    ]) {
      const post = await console.request(path, { method: 'POST', form: { csrf, authorization_code: 'x', credential_json: '{}' } });
      assert.equal(post.response.status, 403, path);
    }
    // No authorization flow was opened on either row.
    assert.equal(console.store.state.oauth_flows.length, 0);

    // Everything else about accounts stays administrator-only.
    for (const path of [`/accounts/${teamClaude.id}/delete`, `/accounts/${teamClaude.id}/failover`, `/accounts/${teamClaude.id}/enrollments`]) {
      const post = await console.request(path, { method: 'POST', form: { csrf } });
      assert.equal(post.response.status, 403, path);
      assert.match(post.body, /Only an administrator can do this/, path);
    }

    // An administrator may authorize any row.
    await console.login();
    assert.equal((await console.request(`/accounts/${teamClaude.id}/claude-authorization`)).response.status, 200);
    assert.equal((await console.request(`/accounts/${teamCodex.id}/codex-authorization`)).response.status, 200);
  } finally {
    await console.close();
  }
});

test('password mode: a member may not add a platform key and may not pile up unauthorized rows', async () => {
  const console = await app({
    seed: async (store) => { await store.addAdminUser({ username: 'root', password: PASSWORD }); },
  });
  try {
    const csrf = await console.csrf();
    const keyed = await console.request('/accounts', {
      method: 'POST', form: { csrf, provider: 'codex', alias: 'codex-key', openai_api_key: 'sk-abcdefghijklmnopqrstuvwxyz' },
    });
    assert.match(decodeURIComponent(keyed.response.headers.get('location')), /only an administrator can add an OpenAI API key account/);
    assert.equal(console.store.state.accounts.length, 0);

    for (let index = 1; index <= 3; index += 1) {
      await console.request('/accounts', { method: 'POST', form: { csrf, provider: 'codex', alias: `codex-pending-${index}` } });
    }
    assert.equal(console.store.state.accounts.length, 3);
    const fourth = await console.request('/accounts', { method: 'POST', form: { csrf, provider: 'codex', alias: 'codex-pending-4' } });
    assert.match(decodeURIComponent(fourth.response.headers.get('location')), /already have 3 accounts waiting for authorization/);
    assert.equal(console.store.state.accounts.length, 3);

    // An administrator is not held to the member limit.
    await console.login();
    const adminCsrf = await console.csrf();
    const adminAdd = await console.request('/accounts', { method: 'POST', form: { csrf: adminCsrf, provider: 'codex', alias: 'codex-admin' } });
    assert.match(adminAdd.response.headers.get('location'), /draft_completed=register-codex-account/);
    assert.equal(console.store.state.accounts.find((entry) => entry.alias === 'codex-admin').created_by.role, 'admin');
  } finally {
    await console.close();
  }
});

test('tailscale mode shows no member add-account section: everyone already has the administrator forms', async () => {
  const console = await app({ adminAuth: 'tailscale' });
  try {
    const home = await console.request('/');
    assert.doesNotMatch(home.body, /id="member-accounts"/);
    assert.match(home.body, /data-persist-draft="register-claude-account"/);
  } finally {
    await console.close();
  }
});
