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
  await issue(store, mine, 'my-mac-2', MACHINE_A);
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
    const add = await console.request('/accounts', { method: 'POST', form: { csrf, provider: 'claude', alias: 'x-y' } });
    assert.equal(add.response.status, 403);
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
    assert.match(listed.response.headers.get('location'), /^\/#account-/);
    assert.equal(console.store.accountById(accountId).restriction.enabled, true);
  } finally {
    await console.close();
  }
});
