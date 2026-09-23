import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';

// Asserted on the rendered page and the stored state, not on the store method
// alone: a setting that saves but never shows up again looks broken.

async function adminFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'admin-block-console-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
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
    home,
    store,
    baseUrl,
    async page(path = '/admin') {
      const response = await fetch(`${baseUrl}${path}`);
      const cookie = response.headers.getSetCookie()[0].split(';')[0];
      const html = await response.text();
      return { status: response.status, html, cookie, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] };
    },
    async post(path, fields, { csrf: overrideCsrf } = {}) {
      const { cookie, csrf } = await this.page();
      return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: overrideCsrf ?? csrf, ...fields }),
      });
    },
  };
}

const OPUS5 = {
  patterns: 'claude-opus-5, claude-opus-5-2*',
  message_zh: '建议使用 Opus 5.5，更便宜且模型能力更强。',
  message_en: 'Use Opus 5.5 instead: cheaper and more capable.',
  enabled: '1',
};

test('the Administration tab is in the navigation and opens an empty rule list', async (t) => {
  const app = await adminFixture(t);
  const overview = await app.page('/');
  assert.match(overview.html, /<a href="\/admin" data-i18n="tab-admin">Administration<\/a>/);

  const admin = await app.page();
  assert.equal(admin.status, 200);
  assert.match(admin.html, /<a href="\/admin" data-i18n="tab-admin" aria-current="page">/);
  assert.match(admin.html, /data-i18n="admin-block-none"/);
  assert.match(admin.html, /action="\/admin\/model-block-rules"/, 'the add form is there');
});

test('an added rule is stored, audited, shown again and enforced by the store', async (t) => {
  const app = await adminFixture(t);
  const response = await app.post('/admin/model-block-rules', OPUS5);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin');

  const [rule] = app.store.modelBlockRules();
  assert.deepEqual(rule.patterns, ['claude-opus-5', 'claude-opus-5-2*']);
  assert.equal(rule.enabled, true);
  assert.equal(rule.message_zh, OPUS5.message_zh);
  assert.ok(rule.updated_by, 'who made it is recorded on the rule');

  const { html } = await app.page();
  assert.match(html, /value="claude-opus-5, claude-opus-5-2\*"/);
  assert.match(html, /建议使用 Opus 5\.5/);
  assert.match(html, /data-i18n="admin-rule-on"/);

  const audit = app.store.state.audit.filter((entry) => entry.event === 'model_block_rule_added');
  assert.equal(audit.length, 1);
  assert.ok(audit[0].actor);

  // Survives a restart: the rules live in state, not in memory.
  const reopened = await new CredentialStore(app.home).init();
  assert.equal(reopened.modelBlockRules()[0].id, rule.id);
});

test('an unchecked box switches a rule off, and the audit keeps what it was', async (t) => {
  const app = await adminFixture(t);
  await app.post('/admin/model-block-rules', OPUS5);
  const [rule] = app.store.modelBlockRules();

  const { enabled, ...off } = OPUS5;
  const response = await app.post(`/admin/model-block-rules/${rule.id}`, { ...off, patterns: 'claude-opus-5' });
  assert.equal(response.status, 303);

  const [updated] = app.store.modelBlockRules();
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.patterns, ['claude-opus-5']);
  const entry = app.store.state.audit.find((item) => item.event === 'model_block_rule_updated');
  assert.equal(entry.previous_enabled, true);
  assert.equal(entry.enabled, false);
  assert.deepEqual(entry.previous_patterns, ['claude-opus-5', 'claude-opus-5-2*']);
  assert.match((await app.page()).html, /data-i18n="admin-rule-off"/);
});

test('a rule can be deleted, and the deletion is audited', async (t) => {
  const app = await adminFixture(t);
  await app.post('/admin/model-block-rules', OPUS5);
  const [rule] = app.store.modelBlockRules();

  const response = await app.post(`/admin/model-block-rules/${rule.id}/delete`, {});
  assert.equal(response.status, 303);
  assert.deepEqual(app.store.modelBlockRules(), []);
  assert.ok(app.store.state.audit.some((entry) => entry.event === 'model_block_rule_deleted'
    && entry.rule_id === rule.id));
});

test('an unusable pattern is refused with its reason and nothing is stored', async (t) => {
  const app = await adminFixture(t);
  const response = await app.post('/admin/model-block-rules', { ...OPUS5, patterns: '*' });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /\/admin\?error=.*not a usable model pattern/);
  assert.deepEqual(app.store.modelBlockRules(), []);

  const missing = await app.post('/admin/model-block-rules/nope', OPUS5);
  assert.match(decodeURIComponent(missing.headers.get('location')), /block rule not found/);
});

test('a forged form without the CSRF token changes nothing', async (t) => {
  const app = await adminFixture(t);
  const response = await app.post('/admin/model-block-rules', OPUS5, { csrf: 'forged' });
  assert.equal(response.status, 403);
  assert.deepEqual(app.store.modelBlockRules(), []);
});
