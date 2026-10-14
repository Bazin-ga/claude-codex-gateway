import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';
import { applyFailoverEdit } from '../lib/account-failover.js';

// Asserted on the rendered pages, not only on the store: the first version of
// this setting saved and ran, while every page showed it switched off.

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'admin-failover-console-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const accounts = {};
  for (const name of ['home', 'backup', 'spare']) {
    accounts[name] = await store.addAccount({
      provider: 'claude',
      alias: `claude-${name}`,
      credential: { oauth_token: `token-${name}` },
    });
  }
  const created = await createCredentialConsole({
    store,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
    await rm(home, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  return {
    store,
    accounts,
    async page(path = '/admin') {
      const response = await fetch(`${baseUrl}${path}`);
      const cookie = response.headers.getSetCookie()[0].split(';')[0];
      const html = await response.text();
      return { status: response.status, html, cookie, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] };
    },
    async post(path, fields) {
      const { cookie, csrf } = await this.page();
      return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, ...fields }),
      });
    },
    policy(name) {
      return store.accountById(accounts[name].id).failover;
    },
  };
}

function rowOf(html, accountId) {
  const start = html.indexOf(`id="failover-${accountId}"`);
  assert.notEqual(start, -1, 'the account has a failover row');
  const open = html.lastIndexOf('<li', start);
  return html.slice(open, start + 6000);
}

test('a chain is built from the Administration tab one step at a time', async (t) => {
  const app = await fixture(t);
  const action = `/admin/failover/${app.accounts.home.id}`;

  let response = await app.post(action, { op: 'add', add: 'claude-spare' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `/admin#failover-${app.accounts.home.id}`);
  // Added by id as well as by name, and case does not matter for a name.
  await app.post(action, { op: 'add', add: 'CLAUDE-BACKUP' });
  assert.deepEqual(app.policy('home').backup_account_ids, [app.accounts.spare.id, app.accounts.backup.id]);
  assert.equal(app.policy('home').enabled, false, 'adding does not switch it on');

  await app.post(action, { op: `up:${app.accounts.backup.id}` });
  assert.deepEqual(app.policy('home').backup_account_ids, [app.accounts.backup.id, app.accounts.spare.id]);

  await app.post(action, { op: 'enable' });
  assert.equal(app.policy('home').enabled, true);

  await app.post(action, { op: `remove:${app.accounts.spare.id}` });
  assert.deepEqual(app.policy('home').backup_account_ids, [app.accounts.backup.id]);
  assert.equal(app.policy('home').enabled, true);

  await app.post(action, { op: `remove:${app.accounts.backup.id}` });
  assert.deepEqual(app.policy('home').backup_account_ids, []);
  assert.equal(app.policy('home').enabled, false, 'an empty chain cannot stay on');

  const audit = app.store.state.audit.filter((entry) => entry.event === 'account_failover_updated');
  assert.equal(audit.length, 6);
  assert.ok(audit.every((entry) => entry.actor));
});

test('a bad edit is refused with a message and changes nothing', async (t) => {
  const app = await fixture(t);
  const action = `/admin/failover/${app.accounts.home.id}`;
  for (const [fields, message] of [
    [{ op: 'add', add: 'no-such-account' }, /no claude account is called/],
    [{ op: 'add', add: 'claude-home' }, /own backup/],
    [{ op: 'add', add: '' }, /type the name/],
    [{ op: 'enable' }, /at least one backup/],
    [{ op: 'explode' }, /unknown failover change/],
  ]) {
    const response = await app.post(action, fields);
    assert.equal(response.status, 303);
    const location = decodeURIComponent(response.headers.get('location'));
    assert.match(location, message);
    assert.ok(location.endsWith(`#failover-${app.accounts.home.id}`), 'the page comes back to the row');
  }
  assert.equal(app.policy('home') ?? null, null);
});

test('the pages show the chain that is stored', async (t) => {
  const app = await fixture(t);
  await app.store.setAccountFailover(app.accounts.home.id, {
    enabled: true,
    backupAccountIds: [app.accounts.backup.id, app.accounts.spare.id],
    actor: 'test',
  });

  const admin = await app.page('/admin');
  const row = rowOf(admin.html, app.accounts.home.id);
  assert.match(row, /class="failover-row is-on"/);
  assert.match(row, /aria-checked="true"/);
  assert.ok(row.indexOf('claude-backup') < row.indexOf('claude-spare'), 'in the stored order');
  assert.match(row, new RegExp(`value="remove:${app.accounts.spare.id}"`));
  assert.match(admin.html, /<datalist id="failover-options-claude">/);

  const overview = await app.page('/');
  assert.match(overview.html, /data-i18n="failover-summary-on"/, 'the account row says it is on');
  assert.match(overview.html, /claude-backup › claude-spare/);
  assert.match(overview.html, new RegExp(`href="/admin#failover-${app.accounts.home.id}"`));
});

test('a moved device is listed and can be returned by hand', async (t) => {
  const app = await fixture(t);
  const issued = await app.store.issueDeviceCredential({
    accountId: app.accounts.home.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
  });
  await app.store.failoverDeviceAccount({
    deviceId: issued.device.id,
    homeAccountId: app.accounts.home.id,
    fromAccountId: app.accounts.home.id,
    toAccountId: app.accounts.backup.id,
    returnAfterMs: Date.now() + 3_600_000,
  });

  const admin = await app.page('/admin');
  assert.match(admin.html, /member-laptop/);
  assert.match(admin.html, /data-i18n="failover-moved-devices"/, 'the home account row counts it');

  const response = await app.post(`/admin/failover/devices/${issued.device.id}/failback`, {});
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin#failover-devices');
  const device = app.store.state.devices.find((entry) => entry.id === issued.device.id);
  assert.equal(device.selected_account_id, app.accounts.home.id);
  assert.equal(device.account_failover, undefined);
  const audit = app.store.state.audit.filter((entry) => entry.event === 'device_account_failback');
  assert.equal(audit.length, 1);
  assert.notEqual(audit[0].actor, 'gateway:quota-failover', 'a hand return is recorded as the person who did it');

  const after = await app.page('/admin');
  assert.match(after.html, /data-i18n="failover-devices-none"/);
});

test('chain edits are pure and bounded', () => {
  assert.deepEqual(applyFailoverEdit(null, { op: 'add', accountId: 'a' }), { enabled: false, backup_account_ids: ['a'] });
  assert.throws(() => applyFailoverEdit({ backup_account_ids: ['a'] }, { op: 'add', accountId: 'a' }), /already a backup/);
  assert.deepEqual(
    applyFailoverEdit({ enabled: true, backup_account_ids: ['a', 'b'] }, { op: 'up', accountId: 'a' }).backup_account_ids,
    ['a', 'b'],
    'the first one cannot move further up',
  );
  const full = { enabled: true, backup_account_ids: ['1', '2', '3', '4', '5', '6', '7', '8'] };
  assert.throws(() => applyFailoverEdit(full, { op: 'add', accountId: '9' }), /at most 8/);
});

test('a chain can be moved later and reordered whole by dragging', async (t) => {
  const app = await fixture(t);
  const { home, backup, spare } = app.accounts;
  await app.store.setAccountFailover(home.id, { enabled: true, backupAccountIds: [backup.id, spare.id], actor: 'test' });
  const action = `/admin/failover/${home.id}`;

  await app.post(action, { op: `down:${backup.id}` });
  assert.deepEqual(app.policy('home').backup_account_ids, [spare.id, backup.id]);

  await app.post(action, { op: 'order', order: `${backup.id},${spare.id}` });
  assert.deepEqual(app.policy('home').backup_account_ids, [backup.id, spare.id]);
  assert.equal(app.policy('home').enabled, true, 'reordering leaves the switch alone');

  // An order from a stale page — one that adds or drops an account — is refused.
  const response = await app.post(action, { op: 'order', order: `${backup.id}` });
  assert.match(decodeURIComponent(response.headers.get('location')), /changed meanwhile/);
  assert.deepEqual(app.policy('home').backup_account_ids, [backup.id, spare.id]);

  const { html } = await app.page('/admin');
  const row = rowOf(html, home.id);
  assert.match(row, /data-chain>/, 'the chain is marked draggable');
  assert.match(row, new RegExp(`value="down:${spare.id}" class="chain-btn" disabled`), 'the last one cannot move later');
  assert.match(row, new RegExp(`value="up:${backup.id}" class="chain-btn" disabled`), 'the first one cannot move earlier');
});

test('every page section the server names has a tab the client can highlight', async () => {
  const { readFile } = await import('node:fs/promises');
  const views = await readFile(new URL('../lib/views.js', import.meta.url), 'utf8');
  const named = new Set([...views.matchAll(/activeTab: '([a-z]+)'/g)].map((match) => match[1]));
  const tabs = new Set([...views.matchAll(/data-tab="([a-z]+)"/g)].map((match) => match[1]));
  assert.ok(named.has('admin'));
  for (const name of named) assert.ok(tabs.has(name), `the "${name}" section has a tab link with data-tab`);
});

test('no translation key is defined twice', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../web/console-client.js', import.meta.url), 'utf8');
  const start = source.indexOf('const translations = {');
  const body = source.slice(start, source.indexOf('\n};', start));
  const keys = [...body.matchAll(/^ {2}'([a-z0-9-]+)':/gm)].map((match) => match[1]);
  const seen = new Set();
  const twice = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
  assert.deepEqual(twice, [], 'a later definition silently replaces the earlier one');
});
