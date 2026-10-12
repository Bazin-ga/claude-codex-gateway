import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';
import {
  codexCreditBalance,
  creditGuardRefusalBody,
  includedQuotaExhaustion,
  normalizeCodexCreditGuard,
} from '../lib/codex-credit-guard.js';
import { fetchCodexUsage } from '../lib/usage.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');

function window(remaining, resetsAt, { kind = 'weekly', position = 'primary' } = {}) {
  return {
    kind,
    position,
    used_percent: 100 - remaining,
    remaining_percent: remaining,
    resets_at: resetsAt,
  };
}

test('a credit guard nobody configured is off', () => {
  for (const value of [undefined, null, {}, { enabled: 'yes' }, { enabled: 1 }]) {
    assert.equal(normalizeCodexCreditGuard(value).enabled, false, `${JSON.stringify(value)} must not block traffic`);
  }
  assert.equal(normalizeCodexCreditGuard({ enabled: true }).enabled, true);
});

test('the balance is read from the decimal string upstream sends', () => {
  assert.deepEqual(
    codexCreditBalance({ has_credits: true, unlimited: false, balance: '44154.6605095000' }),
    { has_credits: true, unlimited: false, balance: 44154.6605095 },
  );
  assert.equal(codexCreditBalance(undefined), null, 'an absent field is unknown, not zero');
  assert.equal(codexCreditBalance({ has_credits: false, balance: null }).balance, null);
});

test('the quota counts as exhausted only while a used-up window has not reset', () => {
  assert.equal(includedQuotaExhaustion({ windows: [window(12, '2026-10-17T05:38:40Z')] }, NOW), null);
  assert.deepEqual(
    includedQuotaExhaustion({ windows: [window(0, '2026-10-17T05:38:40Z')] }, NOW),
    { resetsAtMs: Date.parse('2026-10-17T05:38:40Z') },
  );
  assert.equal(
    includedQuotaExhaustion({ windows: [window(0, '2026-10-12T11:59:59Z')] }, NOW),
    null,
    'a window past its reset is not exhausted, or a blocked account could never see itself recover',
  );
  assert.deepEqual(
    includedQuotaExhaustion({ windows: [window(0, null)] }, NOW),
    { resetsAtMs: null },
    'an unknown reset time still means the quota is gone',
  );
});

test('the earliest reset among used-up windows is the one reported', () => {
  const snapshot = {
    windows: [
      window(0, '2026-10-17T00:00:00Z'),
      window(0, '2026-10-12T15:00:00Z', { kind: 'five_hour', position: 'secondary' }),
    ],
  };
  assert.equal(includedQuotaExhaustion(snapshot, NOW).resetsAtMs, Date.parse('2026-10-12T15:00:00Z'));
});

test('a window without a recognised kind still counts', () => {
  // A free plan reports a thirty-day window, which the usage reader files under
  // its slot name because it is neither five hours nor a week.
  const snapshot = { windows: [window(0, '2026-11-11T00:00:00Z', { kind: 'primary' })] };
  assert.ok(includedQuotaExhaustion(snapshot, NOW));
});

test('no reading is not an exhausted reading', () => {
  assert.equal(includedQuotaExhaustion(null, NOW), null);
  assert.equal(includedQuotaExhaustion({ windows: [] }, NOW), null);
  assert.equal(includedQuotaExhaustion({ windows: [window(null, null)] }, NOW), null);
});

test('the refusal is shaped like the upstream usage-limit error the CLI understands', () => {
  const body = creditGuardRefusalBody({ resetsAtMs: Date.parse('2026-10-17T05:38:40Z') });
  assert.equal(body.error.type, 'usage_limit_reached');
  assert.equal(body.error.resets_at, Date.parse('2026-10-17T05:38:40Z') / 1000);
  assert.equal('plan_type' in body.error, false, 'an unknown plan_type would make the CLI drop the whole error');
  assert.equal('resets_at' in creditGuardRefusalBody({ resetsAtMs: null }).error, false);
});

test('the usage poll carries the credit balance along with the windows', async () => {
  const usage = await fetchCodexUsage({
    accessToken: 'token',
    accountId: 'account',
    fetchImpl: async () => new Response(JSON.stringify({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1792297120 },
        secondary_window: null,
      },
      credits: { has_credits: true, unlimited: false, balance: '62500.0000000000' },
      rate_limit_reset_credits: { available_count: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual(usage.credits, { has_credits: true, unlimited: false, balance: 62500 });
  assert.equal(usage.reset_credits, 3);
});

// --- the dashboard ---------------------------------------------------------
//
// Asserted on the rendered page, not the store: the page reads accounts through
// hand-written projections, and a field missing from one of them makes a
// working setting look broken.

async function creditFixture(t, { snapshot = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'codex-credit-console-'));
  const credentialHome = await mkdtemp(join(tmpdir(), 'codex-credit-home-'));
  await mkdir(join(credentialHome, 'public'), { recursive: true });
  await writeFile(join(credentialHome, 'public', 'current.json'), JSON.stringify({
    access_token: 'access-token',
    account_id: 'chatgpt-account',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const account = await store.addAccount({
    provider: 'codex',
    alias: 'codex-shared-1',
    external: { kind: 'codex-credential', home: credentialHome },
  });
  const created = await createCredentialConsole({
    store,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: { snapshotForAccount: () => snapshot, refreshAccount: async () => null, stop() {} },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
    await rm(home, { recursive: true, force: true });
    await rm(credentialHome, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  return {
    account,
    store,
    async page() {
      const response = await fetch(`${baseUrl}/`);
      const cookie = response.headers.getSetCookie()[0].split(';')[0];
      const html = await response.text();
      return { html, cookie, csrf: /name="csrf" value="([^"]+)"/.exec(html)[1] };
    },
    async save(fields, accountId = account.id) {
      const { cookie, csrf } = await this.page();
      return fetch(`${baseUrl}/accounts/${accountId}/codex-credit-guard`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, ...fields }),
      });
    },
  };
}

function creditForm(html) {
  const form = /<form[^>]*codex-credit-guard"[\s\S]*?<\/form>/.exec(html);
  assert.ok(form, 'the credit form should be on the page');
  return form[0];
}

test('the credit balance is shown on the account', async (t) => {
  const app = await creditFixture(t, {
    snapshot: {
      provider: 'codex',
      status: 'available',
      fetched_at: new Date().toISOString(),
      credits: { has_credits: true, unlimited: false, balance: 44154.6605095 },
      windows: [window(88, null)],
    },
  });
  const { html } = await app.page();
  assert.match(html, /data-i18n="usage-credits">Credits<\/span> 44,154/);
});

test('an account without credits shows no credit line', async (t) => {
  const app = await creditFixture(t, {
    snapshot: {
      provider: 'codex',
      status: 'available',
      fetched_at: new Date().toISOString(),
      credits: { has_credits: false, unlimited: false, balance: 0 },
      windows: [window(88, null)],
    },
  });
  assert.doesNotMatch((await app.page()).html, /data-i18n="usage-credits"/);
});

test('saving the credit guard is visible on the next page load and audited', async (t) => {
  const app = await creditFixture(t);
  assert.equal(creditForm((await app.page()).html).includes('checked'), false, 'a new account spends credits as before');

  assert.equal((await app.save({ enabled: '1' })).status, 303);
  const { html } = await app.page();
  assert.match(creditForm(html), /name="enabled" value="1" checked/);
  assert.match(html, /data-i18n="codex-credit-guard-active"/, 'members can see why a request was refused');

  // A browser omits an unchecked checkbox; it does not send false.
  assert.equal((await app.save({})).status, 303);
  assert.equal(creditForm((await app.page()).html).includes('checked'), false);

  const entries = app.store.state.audit.filter((entry) => entry.event === 'codex_credit_guard_updated');
  assert.deepEqual(entries.map((entry) => [entry.previous_enabled, entry.enabled]), [[false, true], [true, false]]);
  assert.ok(entries[0].actor, 'the actor is recorded');
});

test('the credit guard belongs to Codex accounts only', async (t) => {
  const app = await creditFixture(t);
  const claude = await app.store.addAccount({
    provider: 'claude',
    alias: 'claude-shared-1',
    emailLabel: 'owner@example.com',
  });
  await assert.rejects(app.store.setCodexCreditGuard(claude.id, { enabled: true }), /not a Codex account/);
  const response = await app.save({ enabled: '1' }, claude.id);
  assert.match(decodeURIComponent(response.headers.get('location')), /not a Codex account/);
});
