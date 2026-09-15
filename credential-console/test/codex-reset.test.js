import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';
import { dashboardView } from '../lib/views.js';
import {
  CODEX_RESET_CONSUME_URL,
  CODEX_RESET_CREDITS_URL,
  CODEX_RESET_QUOTA_CEILING,
  codexResetEligibility,
  consumeCodexResetCredit,
  lowestRemainingPercent,
  usableResetCredit,
} from '../lib/codex-reset.js';

const CREDIT_ID = 'RateLimitResetCredit_a48a4ca435f88191810f80cd6c6b97d9';

function codexAccount(overrides = {}) {
  return {
    id: 'account-1',
    provider: 'codex',
    alias: 'codex-shared-1',
    status: 'healthy',
    external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
    ...overrides,
  };
}

function usage({ resetCredits = 1, remaining = 0, status = 'available' } = {}) {
  return {
    provider: 'codex',
    status,
    reset_credits: resetCredits,
    windows: [{ kind: 'weekly', remaining_percent: remaining, resets_at: null }],
  };
}

test('eligibility needs a credit, a readable quota, and a quota that is nearly gone', () => {
  assert.equal(codexResetEligibility(codexAccount(), usage()).eligible, true);
  assert.equal(codexResetEligibility(codexAccount(), usage({ resetCredits: 0 })).reason, 'no_credits');
  // Exactly at the ceiling is not below it.
  assert.equal(
    codexResetEligibility(codexAccount(), usage({ remaining: CODEX_RESET_QUOTA_CEILING })).reason,
    'quota_not_low',
  );
  assert.equal(codexResetEligibility(codexAccount(), usage({ remaining: 4.9 })).eligible, true);
  // A stale reading is not evidence the account is out of quota, and a credit
  // must not be spent on a guess.
  assert.equal(codexResetEligibility(codexAccount(), usage({ status: 'stale' })).reason, 'quota_unknown');
  assert.equal(codexResetEligibility(codexAccount(), null).reason, 'no_credits');
  assert.equal(
    codexResetEligibility(codexAccount({ provider: 'claude' }), usage()).reason,
    'not_codex',
  );
  assert.equal(
    codexResetEligibility(codexAccount({ external: null }), usage()).reason,
    'no_credential_home',
  );
});

// The five-hour window can be fine while the weekly one is exhausted; the
// account is out of quota either way, so the lowest is what decides.
test('the lowest remaining window decides, not the first', () => {
  assert.equal(lowestRemainingPercent({
    windows: [{ remaining_percent: 60 }, { remaining_percent: 2 }],
  }), 2);
  assert.equal(lowestRemainingPercent({ windows: [] }), null);
  assert.equal(lowestRemainingPercent(null), null);
});

test('only an available, unredeemed, Codex-typed credit is spendable', () => {
  const shape = (extra) => ({
    id: CREDIT_ID, status: 'available', reset_type: 'codex_rate_limits', redeemed_at: null, ...extra,
  });
  assert.equal(usableResetCredit([shape()]).id, CREDIT_ID);
  assert.equal(usableResetCredit([shape({ status: 'redeemed' })]), null);
  assert.equal(usableResetCredit([shape({ reset_type: 'something_else' })]), null);
  assert.equal(usableResetCredit([shape({ redeemed_at: '2026-09-01T00:00:00Z' })]), null);
  assert.equal(usableResetCredit([shape({ id: '' })]), null);
  assert.equal(usableResetCredit([]), null);
});

// The idempotency key is the only thing standing between a retried call and a
// second credit, so the request cannot be built without one.
test('a redemption cannot be sent without an idempotency key', async () => {
  await assert.rejects(
    consumeCodexResetCredit({
      accessToken: 't', accountId: 'a', creditId: CREDIT_ID, fetchImpl: async () => {
        throw new Error('upstream must not be called');
      },
    }),
    (error) => error.code === 'redeem_request_id_required',
  );
});

test('a redemption posts the credit id and the idempotency key it was given', async () => {
  const calls = [];
  await consumeCodexResetCredit({
    accessToken: 'access-token',
    accountId: 'chatgpt-account',
    creditId: CREDIT_ID,
    redeemRequestId: 'redeem-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.equal(calls[0].url, CODEX_RESET_CONSUME_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token');
  assert.equal(calls[0].options.headers['ChatGPT-Account-Id'], 'chatgpt-account');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    credit_id: CREDIT_ID,
    redeem_request_id: 'redeem-1',
  });
});

// A transport failure on this specific call is the one outcome nobody can
// resolve from the outside, so it gets a code of its own and the caller is
// expected to stop rather than retry.
test('a transport failure is reported as ambiguous, not as a refusal', async () => {
  await assert.rejects(
    consumeCodexResetCredit({
      accessToken: 't',
      accountId: 'a',
      creditId: CREDIT_ID,
      redeemRequestId: 'redeem-1',
      fetchImpl: async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); },
    }),
    (error) => error.code === 'upstream_timeout',
  );
});

function renderWith(account, accountUsage) {
  return dashboardView({
    accounts: [{ ...account, usage: accountUsage }],
    devices: [],
    machines: [],
    codexClients: [],
    csrf: 'csrf-token',
    adminIdentity: 'admin@example.com',
    deviceGroups: [],
  });
}

test('the button appears only when a credit may actually be spent', () => {
  const offered = renderWith(codexAccount(), usage());
  assert.match(offered, /action="\/accounts\/account-1\/codex-reset"/);
  assert.match(offered, /data-i18n="codex-reset-usage"/);
  // The dialog names the account and quotes the numbers the decision rests on.
  assert.match(offered, /Spend one reset credit on codex-shared-1\?/);
  assert.match(offered, /cannot be undone/);

  const noCredits = renderWith(codexAccount(), usage({ resetCredits: 0 }));
  assert.equal(noCredits.includes('/codex-reset"'), false);

  // Holding credits but not eligible: say why rather than leaving an operator
  // wondering where the button went.
  const notLow = renderWith(codexAccount(), usage({ remaining: 40 }));
  assert.equal(notLow.includes('/codex-reset"'), false);
  assert.match(notLow, /data-i18n="codex-reset-quota-not-low"/);

  const unknown = renderWith(codexAccount(), usage({ status: 'stale' }));
  assert.equal(unknown.includes('/codex-reset"'), false);
  assert.match(unknown, /data-i18n="codex-reset-quota-unknown"/);
});

async function routeFixture(t, { upstream, remainingPercent = 0, resetCredits = 1 }) {
  const home = await mkdtemp(join(tmpdir(), 'codex-reset-'));
  const credentialHome = await mkdtemp(join(tmpdir(), 'codex-reset-home-'));
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
  const seen = [];
  const originalFetch = globalThis.fetch;
  // Only chatgpt.com is stubbed; the test's own calls to the console under test
  // go through untouched.
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith('https://chatgpt.com/')) return originalFetch(url, options);
    seen.push({ url: String(url), method: options.method ?? 'GET', body: options.body });
    return upstream(String(url), options, { remainingPercent, resetCredits });
  };
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
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
    await rm(home, { recursive: true, force: true });
    await rm(credentialHome, { recursive: true, force: true });
  });
  return { account, store, seen, baseUrl: `http://127.0.0.1:${created.server.address().port}` };
}

function upstreamFor({ remainingPercent, resetCredits, consumeStatus = 200 }) {
  return (url) => {
    if (url.includes('/wham/usage')) {
      return new Response(JSON.stringify({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 100 - remainingPercent,
            limit_window_seconds: 604800,
            reset_at: Math.floor(Date.now() / 1000) + 600,
          },
          secondary_window: null,
        },
        rate_limit_reset_credits: { available_count: resetCredits, applicable_available_count: resetCredits },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === CODEX_RESET_CREDITS_URL) {
      return new Response(JSON.stringify({
        credits: [{
          id: CREDIT_ID, status: 'available', reset_type: 'codex_rate_limits', redeemed_at: null,
        }],
        available_count: resetCredits,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === CODEX_RESET_CONSUME_URL) {
      return new Response(JSON.stringify({ ok: true }), {
        status: consumeStatus, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected upstream call: ${url}`);
  };
}

async function postReset(baseUrl, accountId) {
  const page = await fetch(`${baseUrl}/`);
  const cookie = page.headers.getSetCookie()[0].split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  return fetch(`${baseUrl}/accounts/${accountId}/codex-reset`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  });
}

test('the route spends exactly one credit and records it before the call', async (t) => {
  const app = await routeFixture(t, { upstream: upstreamFor({ remainingPercent: 0, resetCredits: 1 }) });
  const response = await postReset(app.baseUrl, app.account.id);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?reset=ok');

  const consumes = app.seen.filter((call) => call.url === CODEX_RESET_CONSUME_URL);
  assert.equal(consumes.length, 1, 'exactly one redemption');
  const body = JSON.parse(consumes[0].body);
  assert.equal(body.credit_id, CREDIT_ID);
  assert.match(body.redeem_request_id, /^[0-9a-f-]{36}$/);

  const audit = app.store.state.audit.filter((entry) => entry.event.startsWith('codex_reset_credit'));
  assert.deepEqual(audit.map((entry) => entry.event), [
    'codex_reset_credit_redeem_started',
    'codex_reset_credit_redeemed',
  ]);
  // The staked credit and the idempotency key are on record before the call,
  // which is what makes an ambiguous failure reconcilable by hand.
  assert.equal(audit[0].credit_id, CREDIT_ID);
  assert.equal(audit[0].redeem_request_id, body.redeem_request_id);
});

// The button is rendered from a snapshot that can be nearly an hour old. The
// route must not trust it: an account that recovered in the meantime would have
// a credit burned on a full quota.
test('the route re-reads quota from upstream and refuses a recovered account', async (t) => {
  const app = await routeFixture(t, { upstream: upstreamFor({ remainingPercent: 80, resetCredits: 1 }) });
  const response = await postReset(app.baseUrl, app.account.id);
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /still has 80% quota left/);
  assert.equal(app.seen.some((call) => call.url === CODEX_RESET_CONSUME_URL), false);
  assert.equal(app.store.state.audit.some((e) => e.event.startsWith('codex_reset_credit')), false);
});

test('the route refuses when upstream reports no credits, without listing or posting', async (t) => {
  const app = await routeFixture(t, { upstream: upstreamFor({ remainingPercent: 0, resetCredits: 0 }) });
  const response = await postReset(app.baseUrl, app.account.id);
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /not eligible/);
  assert.equal(app.seen.some((call) => call.url === CODEX_RESET_CREDITS_URL), false);
  assert.equal(app.seen.some((call) => call.url === CODEX_RESET_CONSUME_URL), false);
});

test('an ambiguous redemption failure is recorded as ambiguous and never retried', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codex-reset-amb-'));
  const credentialHome = await mkdtemp(join(tmpdir(), 'codex-reset-amb-home-'));
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
  const base = upstreamFor({ remainingPercent: 0, resetCredits: 1 });
  let consumeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith('https://chatgpt.com/')) return originalFetch(url, options);
    if (String(url) === CODEX_RESET_CONSUME_URL) {
      consumeCalls += 1;
      throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    }
    return base(String(url), options);
  };
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
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
    await rm(home, { recursive: true, force: true });
    await rm(credentialHome, { recursive: true, force: true });
  });

  const response = await postReset(`http://127.0.0.1:${created.server.address().port}`, account.id);
  assert.equal(response.status, 303);
  const message = decodeURIComponent(response.headers.get('location'));
  assert.match(message, /did not complete cleanly/);
  assert.match(message, /NOT retried/);
  assert.equal(consumeCalls, 1, 'one attempt, never a second');

  const failure = store.state.audit.find((entry) => entry.event === 'codex_reset_credit_redeem_failed');
  assert.equal(failure.ambiguous, true);
  assert.equal(failure.credit_id, CREDIT_ID);
});

test('a Claude account cannot be reset through this route', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codex-reset-claude-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'claude-a',
    emailLabel: 'a@example.com',
    credential: { oauth_token: 'sk-ant-oat-a' },
  });
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
  const response = await postReset(`http://127.0.0.1:${created.server.address().port}`, claude.id);
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /not a Codex account/);
});
