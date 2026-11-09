import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';
import { dashboardView } from '../lib/views.js';
import { fetchClaudeUsage } from '../lib/usage.js';
import {
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_FABLE_RESET_STATUS_URL,
  CLAUDE_PROFILE_URL,
  claimFableReset,
  fableResetEligibility,
  selectFableResetGrant,
  summarizeFableResets,
} from '../lib/claude-fable-reset.js';

const ORG = '3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b';
const CLAIM_URL = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;

/** A cedar_ember block in the shape upstream returned on 2026-11-09. */
function cedarEmber({ fableUsed = 72, grants = null, atLimit = false, eligible = true, cooldownUntil = null } = {}) {
  const grant = (id, endsAt, clears = ['seven_day_overage_included']) => ({
    id,
    label: `label for ${id}`,
    resets_total: 1,
    resets_left: 1,
    starts_at: '2026-11-09T18:00:00+00:00',
    ends_at: endsAt,
    clears,
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    percent_used: { five_hour: 15, seven_day_overage_included: fableUsed, seven_day: 73 },
    blocking: [],
    type: 'full',
    unavailable_reason: null,
    gives_back_weekly: true,
  });
  return {
    eligible,
    ineligible_reason: eligible ? null : 'surface',
    at_limit: atLimit,
    exhausted: [],
    grants: grants ?? [
      grant('launch-2610-fable', '2027-03-09T07:59:00+00:00'),
      grant('launch-2610-fable-6mo', '2027-03-09T07:59:00+00:00'),
    ],
    next_grant_id: 'launch-2610-fable',
    weekly_resets_at: '2026-11-15T03:00:00+00:00',
    cooldown_until: cooldownUntil,
    event_props: { surface: 'claude_code_cli', tier: 'claude_max_20x' },
  };
}

function usageBody(cedar = cedarEmber()) {
  return {
    five_hour: { utilization: 15, resets_at: '2026-11-09T23:20:00+00:00' },
    seven_day: { utilization: 73, resets_at: '2026-11-15T03:00:00+00:00' },
    limits: [{ kind: 'weekly_scoped', percent: 72, resets_at: '2026-11-15T03:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' } } }],
    cedar_ember: cedar,
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('the reset block is summarized to counts, expiry, and grants, and nothing else', () => {
  const summary = summarizeFableResets(cedarEmber());
  assert.equal(summary.eligible, true);
  assert.equal(summary.available, 2);
  assert.equal(summary.next_grant_id, 'launch-2610-fable');
  assert.equal(summary.earliest_expiry, '2027-03-09T07:59:00.000Z');
  assert.equal('event_props' in summary, false, 'telemetry is not carried into the snapshot');
  assert.equal(summarizeFableResets(null), null, 'a missing block is unknown, not zero');

  // What upstream sends to anything that is not the Claude Code CLI.
  const surface = summarizeFableResets({ eligible: false, ineligible_reason: 'surface', grants: [] });
  assert.equal(surface.available, 0);
  assert.equal(surface.ineligible_reason, 'surface');
});

test('the hourly poll asks for the reset block under the CLI identity', async () => {
  let seen;
  const snapshot = await fetchClaudeUsage({
    oauthToken: 'sk-ant-oat-test',
    fetchImpl: async (url, options) => { seen = { url, headers: options.headers }; return json(usageBody()); },
  });
  assert.equal(seen.url, CLAUDE_FABLE_RESET_STATUS_URL);
  assert.equal(seen.headers['User-Agent'], CLAUDE_CLI_USER_AGENT,
    'any other User-Agent is answered with ineligible_reason "surface" and no grants');
  assert.equal(snapshot.fable_resets.available, 2);
  assert.deepEqual(snapshot.windows.map((window) => window.kind), ['five_hour', 'weekly', 'fable_weekly']);
});

test('eligibility needs a usable grant with something to give back', () => {
  const account = { id: 'a', provider: 'claude', alias: 'claude-cheng' };
  const ok = fableResetEligibility(account, summarizeFableResets(cedarEmber()));
  assert.equal(ok.eligible, true);
  assert.equal(ok.grant.id, 'launch-2610-fable', 'the grant upstream recommends is the one used');
  assert.equal(ok.givesBack, 72);

  assert.equal(fableResetEligibility({ ...account, provider: 'codex' }, summarizeFableResets(cedarEmber())).reason, 'not_claude');
  assert.equal(fableResetEligibility(account, null).reason, 'status_unknown');
  assert.equal(fableResetEligibility(account, summarizeFableResets(cedarEmber({ eligible: false, grants: [] }))).reason, 'no_resets');
  assert.equal(fableResetEligibility(account, summarizeFableResets(cedarEmber({ fableUsed: 0 }))).reason, 'nothing_to_restore');
  assert.equal(fableResetEligibility(account, summarizeFableResets(cedarEmber({
    cooldownUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }))).reason, 'cooldown');

  // A grant that only works at the limit is not offered while the account is under it.
  const atLimitOnly = cedarEmber();
  for (const grant of atLimitOnly.grants) grant.use_requires_limit = true;
  assert.equal(fableResetEligibility(account, summarizeFableResets(atLimitOnly)).reason, 'not_usable_now');
  atLimitOnly.at_limit = true;
  assert.equal(fableResetEligibility(account, summarizeFableResets(atLimitOnly)).eligible, true);
});

test('without a recommendation, the grant that expires first is used', () => {
  const block = cedarEmber();
  block.next_grant_id = null;
  block.grants[1].id = 'launch-2610-fable-week';
  block.grants[1].ends_at = '2026-11-17T07:59:00+00:00';
  assert.equal(selectFableResetGrant(summarizeFableResets(block)).id, 'launch-2610-fable-week');
});

test('a claim posts the program, the grant, and the request id it was given', async () => {
  let seen;
  const result = await claimFableReset({
    oauthToken: 'sk-ant-oat-test',
    organizationUuid: ORG,
    grantId: 'launch-2610-fable',
    requestId: 'req0001',
    fetchImpl: async (url, options) => {
      seen = { url, method: options.method, headers: options.headers, body: JSON.parse(options.body) };
      return json({ result: 'reset', resets_left: 1, cleared: ['seven_day_overage_included'] });
    },
  });
  assert.equal(seen.url, CLAIM_URL);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['User-Agent'], CLAUDE_CLI_USER_AGENT);
  assert.deepEqual(seen.body, { program: 'cedar_ember', grant_id: 'launch-2610-fable', request_id: 'req0001' });
  assert.equal(result.result, 'reset');
  assert.equal(result.resets_left, 1);
});

test('a claim is refused before any call when an id is malformed', async () => {
  const never = async () => { throw new Error('must not be called'); };
  const base = { oauthToken: 't', organizationUuid: ORG, grantId: 'launch-2610-fable', requestId: 'req0001', fetchImpl: never };
  await assert.rejects(claimFableReset({ ...base, requestId: '' }), (error) => error.code === 'request_id_invalid');
  await assert.rejects(claimFableReset({ ...base, grantId: '../x' }), (error) => error.code === 'grant_id_invalid');
  await assert.rejects(claimFableReset({ ...base, organizationUuid: 'nope' }), (error) => error.code === 'organization_unavailable');
});

test('a transport failure on the claim is reported as ambiguous', async () => {
  await assert.rejects(claimFableReset({
    oauthToken: 't', organizationUuid: ORG, grantId: 'launch-2610-fable', requestId: 'req0001',
    fetchImpl: async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); },
  }), (error) => error.code === 'upstream_timeout');
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

test('the button and the count appear only when a reset may be used', () => {
  const account = { id: 'account-1', provider: 'claude', alias: 'claude-cheng', status: 'healthy' };
  const snapshot = (cedar) => ({
    provider: 'claude', status: 'available', windows: [], fable_resets: summarizeFableResets(cedar),
  });
  const offered = renderWith(account, snapshot(cedarEmber()));
  assert.match(offered, /action="\/accounts\/account-1\/claude-fable-reset"/);
  assert.match(offered, /data-i18n="fable-reset-use"/);
  assert.match(offered, /Use one Claude limit reset on claude-cheng\?/);
  assert.match(offered, /cannot be undone/);
  assert.match(offered, /data-i18n="usage-fable-resets"/);

  const none = renderWith(account, snapshot(cedarEmber({ eligible: false, grants: [] })));
  assert.equal(none.includes('/claude-fable-reset"'), false);
  assert.equal(none.includes('data-i18n="usage-fable-resets"'), false);

  const nothing = renderWith(account, snapshot(cedarEmber({ fableUsed: 0 })));
  assert.equal(nothing.includes('/claude-fable-reset"'), false);
  assert.match(nothing, /data-i18n="fable-reset-nothing"/);
});

async function routeFixture(t, { cedar = cedarEmber(), claim = () => json({ result: 'reset', resets_left: 1, cleared: ['seven_day_overage_included'] }) } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fable-reset-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-cheng',
    emailLabel: 'cheng@example.com',
    credential: { oauth_token: 'sk-ant-oat-test' },
  });
  const seen = [];
  const originalFetch = globalThis.fetch;
  // Only api.anthropic.com is stubbed. No test here ever reaches the real API.
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://api.anthropic.com/')) return originalFetch(url, options);
    seen.push({ url: target, method: options.method ?? 'GET', body: options.body });
    if (target === CLAUDE_FABLE_RESET_STATUS_URL) return json(usageBody(cedar));
    if (target === CLAUDE_PROFILE_URL) return json({ organization: { uuid: ORG } });
    if (target === CLAIM_URL) return claim();
    throw new Error(`unexpected upstream call: ${target}`);
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
  });
  return { account, store, seen, baseUrl: `http://127.0.0.1:${created.server.address().port}` };
}

async function postReset(baseUrl, accountId) {
  const page = await fetch(`${baseUrl}/`);
  const cookie = page.headers.getSetCookie()[0].split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  return fetch(`${baseUrl}/accounts/${accountId}/claude-fable-reset`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  });
}

test('the route uses exactly one reset and records it before the call', async (t) => {
  const app = await routeFixture(t);
  const response = await postReset(app.baseUrl, app.account.id);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?reset=ok');

  const claims = app.seen.filter((call) => call.url === CLAIM_URL);
  assert.equal(claims.length, 1, 'exactly one claim');
  const body = JSON.parse(claims[0].body);
  assert.equal(body.program, 'cedar_ember');
  assert.equal(body.grant_id, 'launch-2610-fable');
  assert.match(body.request_id, /^[0-9a-f]{32}$/);
  // Status is re-read live before the claim, not taken from the snapshot.
  assert.ok(app.seen.findIndex((call) => call.url === CLAUDE_FABLE_RESET_STATUS_URL)
    < app.seen.findIndex((call) => call.url === CLAIM_URL));

  const audit = app.store.state.audit.filter((entry) => entry.event.startsWith('claude_fable_reset'));
  assert.deepEqual(audit.map((entry) => entry.event), ['claude_fable_reset_started', 'claude_fable_reset_used']);
  assert.equal(audit[0].grant_id, 'launch-2610-fable');
  assert.equal(audit[0].request_id, body.request_id);
  assert.equal(audit[0].fable_used_percent, 72);
  assert.equal(JSON.stringify(app.store.state.audit).includes('sk-ant-oat-test'), false, 'the token never reaches the audit');
});

test('the route refuses without claiming when live status has nothing to give back', async (t) => {
  const app = await routeFixture(t, { cedar: cedarEmber({ fableUsed: 0 }) });
  const response = await postReset(app.baseUrl, app.account.id);
  assert.match(decodeURIComponent(response.headers.get('location')), /no Fable usage this week/);
  assert.equal(app.seen.some((call) => call.url === CLAIM_URL), false);
});

test('an upstream refusal is reported and recorded, not treated as success', async (t) => {
  const app = await routeFixture(t, { claim: () => json({ result: 'already_used', resets_left: 0 }) });
  const response = await postReset(app.baseUrl, app.account.id);
  assert.match(decodeURIComponent(response.headers.get('location')), /did not apply the reset \(already_used\)/);
  assert.ok(app.store.state.audit.some((entry) => entry.event === 'claude_fable_reset_declined'));
});

test('an ambiguous claim failure is recorded as ambiguous and never retried', async (t) => {
  let claims = 0;
  const app = await routeFixture(t, {
    claim: () => { claims += 1; throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }); },
  });
  const response = await postReset(app.baseUrl, app.account.id);
  const message = decodeURIComponent(response.headers.get('location'));
  assert.match(message, /did not complete cleanly/);
  assert.match(message, /NOT retried/);
  assert.equal(claims, 1, 'one attempt, never a second');
  const failure = app.store.state.audit.find((entry) => entry.event === 'claude_fable_reset_failed');
  assert.equal(failure.ambiguous, true);
});

test('the button reaches the rendered dashboard, not just the view function', async (t) => {
  const app = await routeFixture(t);
  const snapshot = await fetchClaudeUsage({ oauthToken: 'sk-ant-oat-test' });
  const created = await createCredentialConsole({
    store: app.store,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: {
      snapshotForAccount: (id) => (id === app.account.id ? snapshot : null),
      refreshAccount: async () => snapshot,
      stop() {},
    },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
  });
  const html = await (await fetch(`http://127.0.0.1:${created.server.address().port}/`)).text();
  assert.match(html, new RegExp(`action="/accounts/${app.account.id}/claude-fable-reset"`));
  assert.match(html, /data-confirm="Use one Claude limit reset on claude-cheng/);
});
