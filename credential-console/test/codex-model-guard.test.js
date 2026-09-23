import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';
import {
  CODEX_GUARD_DEFAULT_THRESHOLD_PERCENT,
  codexGuardAllowsModel,
  guardRestricts,
  normalizeCodexGuard,
  parseCodexGuardInput,
  readCodexModelPrefix,
} from '../lib/codex-model-guard.js';
import { CodexQuotaSignal } from '../lib/codex-quota-signal.js';

test('a guard nobody configured is off', () => {
  for (const value of [undefined, null, {}, { enabled: true }, { enabled: 'yes', threshold_percent: 15 }]) {
    assert.equal(normalizeCodexGuard(value).enabled, false, `${JSON.stringify(value)} must not block traffic`);
  }
  assert.equal(normalizeCodexGuard(null).threshold_percent, CODEX_GUARD_DEFAULT_THRESHOLD_PERCENT);
});

test('a threshold outside the allowed band disables the guard rather than clamping it', () => {
  // Clamping would leave a stored 0 or 90 silently enforcing something else.
  assert.equal(normalizeCodexGuard({ enabled: true, threshold_percent: 0 }).enabled, false);
  assert.equal(normalizeCodexGuard({ enabled: true, threshold_percent: 90 }).enabled, false);
  assert.equal(normalizeCodexGuard({ enabled: true, threshold_percent: 15 }).enabled, true);
});

test('a submitted threshold is refused rather than quietly replaced', () => {
  assert.throws(() => parseCodexGuardInput({ enabled: true, thresholdPercent: '150' }), /between/);
  assert.throws(() => parseCodexGuardInput({ enabled: true, thresholdPercent: '0' }), /between/);
  assert.throws(() => parseCodexGuardInput({ enabled: true, thresholdPercent: '12.5' }), /whole percentage/);
  assert.throws(() => parseCodexGuardInput({ enabled: true, thresholdPercent: '' }), /whole percentage/);
  assert.deepEqual(
    parseCodexGuardInput({ enabled: true, thresholdPercent: ' 20 ' }),
    { enabled: true, threshold_percent: 20 },
  );
  assert.deepEqual(
    parseCodexGuardInput({ enabled: false, thresholdPercent: '20' }),
    { enabled: false, threshold_percent: 20 },
    'a threshold is still stored when the switch is off, so turning it back on restores it',
  );
});

test('the allowed family is matched as a substring, across versions', () => {
  assert.equal(codexGuardAllowsModel('gpt-5.6-luna'), true);
  assert.equal(codexGuardAllowsModel('gpt-6-luna'), true, 'a future version must not start being refused');
  assert.equal(codexGuardAllowsModel('GPT-5.6-LUNA'), true);
  assert.equal(codexGuardAllowsModel('gpt-5.6-sol'), false);
  assert.equal(codexGuardAllowsModel('gpt-6-astra'), false);
  assert.equal(codexGuardAllowsModel(null), false);
  assert.equal(codexGuardAllowsModel(''), false);
});

test('an unknown quota is not a low quota', () => {
  const guard = { enabled: true, threshold_percent: 15 };
  assert.equal(guardRestricts(guard, null), false);
  assert.equal(guardRestricts(guard, Number.NaN), false);
  assert.equal(guardRestricts(guard, 15), false, 'the threshold itself is still allowed');
  assert.equal(guardRestricts(guard, 14.9), true);
  assert.equal(guardRestricts({ enabled: false, threshold_percent: 15 }, 0), false);
});

function fakeRequest() {
  const stream = new PassThrough();
  return stream;
}

test('the model is read from the head of the body and the bytes are handed back', async () => {
  const req = fakeRequest();
  const body = '{"model":"gpt-5.6-luna","input":[]}';
  const reading = readCodexModelPrefix(req);
  req.write(body);
  const result = await reading;
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.ended, false, 'the rest of the body is still there to forward');
  assert.equal(result.head.toString('utf8'), body);
});

test('a model split across chunks is still found', async () => {
  const req = fakeRequest();
  const reading = readCodexModelPrefix(req);
  req.write('{"stream":true,"mod');
  await new Promise((resolve) => setTimeout(resolve, 5));
  req.write('el":"gpt-5.6-sol","input":[]}');
  const result = await reading;
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.head.toString('utf8'), '{"stream":true,"model":"gpt-5.6-sol","input":[]}');
});

test('a body that never names a model reports the end of the stream', async () => {
  const req = fakeRequest();
  const reading = readCodexModelPrefix(req);
  req.end('{"input":[]}');
  const result = await reading;
  assert.equal(result.model, null);
  assert.equal(result.ended, true, 'the caller must know there is nothing left to pipe');
});

test('a body that is not a JSON object stops the scan immediately', async () => {
  const req = fakeRequest();
  const reading = readCodexModelPrefix(req);
  req.write('[1,2,3]');
  const result = await reading;
  assert.equal(result.model, null);
  assert.equal(result.ended, false, 'nothing is gained by buffering the rest of it');
});

test('a body that hides the model past the limit is bounded, not buffered whole', async () => {
  const req = fakeRequest();
  const reading = readCodexModelPrefix(req, { limitBytes: 1_024 });
  req.write(`{"input":"${'x'.repeat(4_000)}`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  req.write(`${'x'.repeat(4_000)}","model":"gpt-5.6-luna"}`);
  const result = await reading;
  assert.equal(result.model, null, 'unreadable, and the caller will treat that as not allowed');
  assert.ok(result.bytes <= 8_192, `read ${result.bytes} bytes, which is not a bound`);
});

test('the scanner handed on has seen every byte handed back, so the tail stays in step', async () => {
  const req = fakeRequest();
  const reading = readCodexModelPrefix(req, { limitBytes: 1_024 });
  // One read crossing the limit, ending mid-string: the part past the limit
  // must still have been scanned, or the rest of the body parses as garbage.
  req.write(`{"input":"${'x'.repeat(4_000)}`);
  const result = await reading;
  assert.equal(result.model, null);
  assert.equal(result.head.length, result.bytes);
  result.scanner.push(Buffer.from('","model":"gpt-5.6-luna"}'));
  result.scanner.finish();
  const { model, parseState } = result.scanner.snapshot();
  assert.equal(model, 'gpt-5.6-luna');
  assert.equal(parseState, 'complete');
});

test('a client that disappears mid-read is reported as aborted, not as a model', async () => {
  const req = fakeRequest();
  const reading = readCodexModelPrefix(req);
  req.write('{"mod');
  await new Promise((resolve) => setTimeout(resolve, 5));
  req.destroy(new Error('client went away'));
  const result = await reading;
  assert.equal(result.aborted, true);
  assert.equal(result.model, null);
});

test('an observation without the weekly header does not pretend to be one', () => {
  const signal = new CodexQuotaSignal();
  const observation = signal.observe('a1', { 'x-codex-primary-used-percent': '10' });
  assert.equal(observation.primary_used_percent, 10);
  assert.equal(observation.secondary_used_percent, null);
  assert.equal(
    signal.weeklyRemainingPercent('a1', null),
    null,
    'the five-hour window says nothing about the week',
  );
  assert.equal(signal.observe('a1', {}), null, 'headers with nothing in them are not an observation');
});

test('a nonsense header is ignored rather than believed', () => {
  const signal = new CodexQuotaSignal();
  assert.equal(signal.observe('a1', { 'x-codex-secondary-used-percent': 'soon' }), null);
  assert.equal(signal.observe('a1', { 'x-codex-secondary-used-percent': '-4' }), null);
  assert.equal(signal.observe('a1', { 'x-codex-secondary-used-percent': '140' }), null);
  assert.equal(signal.weeklyRemainingPercent('a1', null), null);
});

// The shape that actually broke production. On a Pro plan the provider reports
// the seven-day allowance in `primary_window` and no secondary window at all,
// so the account's weekly window has kind 'weekly' and position 'primary'.
// Pairing kind with the secondary header wrote a figure for a window that does
// not exist onto the one that does: an account at 93% rendered as 100%, and an
// account at 0% also read as 100% -- the guard could never fire on exactly the
// accounts it exists for.
function proPlanSnapshot(remaining, { fetchedAtMs = Date.now() } = {}) {
  return {
    provider: 'codex',
    status: 'available',
    fetched_at: new Date(fetchedAtMs).toISOString(),
    windows: [{
      kind: 'weekly',
      position: 'primary',
      used_percent: 100 - remaining,
      remaining_percent: remaining,
      duration_seconds: 604800,
    }],
  };
}

test('a weekly window reported in the primary slot reads the primary header', () => {
  const signal = new CodexQuotaSignal();
  const now = Date.now();
  // What the upstream sends such an account: the week in primary, and a
  // secondary figure for a window it does not have.
  signal.observe('a1', {
    'x-codex-primary-used-percent': '7',
    'x-codex-secondary-used-percent': '0',
  }, now);

  const snapshot = proPlanSnapshot(93, { fetchedAtMs: now - 600_000 });
  assert.equal(signal.weeklyRemainingPercent('a1', snapshot), 93);
  assert.equal(signal.merge('a1', snapshot).windows[0].remaining_percent, 93);
});

test('the guard still fires on an exhausted week reported in the primary slot', () => {
  const signal = new CodexQuotaSignal();
  const now = Date.now();
  signal.observe('a1', {
    'x-codex-primary-used-percent': '100',
    'x-codex-secondary-used-percent': '0',
  }, now);
  const remaining = signal.weeklyRemainingPercent('a1', proPlanSnapshot(0, { fetchedAtMs: now - 1 }));
  assert.equal(remaining, 0);
  assert.equal(guardRestricts({ enabled: true, threshold_percent: 15 }, remaining), true);
});

test('a window with no recorded slot is left alone rather than guessed at', () => {
  const signal = new CodexQuotaSignal();
  const now = Date.now();
  signal.observe('a1', { 'x-codex-secondary-used-percent': '0' }, now);
  // A snapshot cached before positions were recorded. Ignoring the observation
  // costs an hour of freshness; guessing costs the correctness of the guard.
  const legacy = {
    provider: 'codex',
    status: 'available',
    fetched_at: new Date(now - 600_000).toISOString(),
    windows: [{ kind: 'weekly', used_percent: 7, remaining_percent: 93 }],
  };
  assert.equal(signal.weeklyRemainingPercent('a1', legacy), 93);
  assert.equal(signal.merge('a1', legacy), legacy);
});

test('the newer of the two readings wins, in both directions', () => {
  const signal = new CodexQuotaSignal();
  const snapshot = (fetchedAtMs, remaining) => ({
    provider: 'codex',
    status: 'available',
    fetched_at: new Date(fetchedAtMs).toISOString(),
    windows: [{
      kind: 'weekly',
      position: 'secondary',
      used_percent: 100 - remaining,
      remaining_percent: remaining,
    }],
  });
  const now = Date.now();

  signal.observe('a1', { 'x-codex-secondary-used-percent': '95' }, now - 60_000);
  assert.equal(signal.weeklyRemainingPercent('a1', snapshot(now - 600_000, 40)), 5, 'the observation is newer');
  assert.equal(
    signal.weeklyRemainingPercent('a1', snapshot(now, 40)),
    40,
    'a poll that just ran is not overridden by an older observation',
  );
});

test('a merged snapshot carries the newer numbers and still admits the poll failed', () => {
  const signal = new CodexQuotaSignal();
  const now = Date.now();
  signal.observe('a1', {
    'x-codex-primary-used-percent': '30',
    'x-codex-secondary-used-percent': '90',
  }, now);
  const merged = signal.merge('a1', {
    provider: 'codex',
    status: 'stale',
    last_error: 'timeout',
    fetched_at: new Date(now - 3_600_000).toISOString(),
    windows: [
      { kind: 'five_hour', position: 'primary', used_percent: 10, remaining_percent: 90 },
      { kind: 'weekly', position: 'secondary', used_percent: 50, remaining_percent: 50 },
    ],
  });

  assert.equal(merged.windows[0].remaining_percent, 70);
  assert.equal(merged.windows[1].remaining_percent, 10);
  assert.equal(merged.observed_at, new Date(now).toISOString());
  assert.equal(merged.status, 'stale', 'a working proxy is not evidence the usage poll recovered');
});

test('merging is a no-op when there is nothing newer to say', () => {
  const signal = new CodexQuotaSignal();
  const snapshot = {
    provider: 'codex',
    status: 'available',
    fetched_at: new Date().toISOString(),
    windows: [{ kind: 'weekly', position: 'secondary', used_percent: 50, remaining_percent: 50 }],
  };
  assert.equal(signal.merge('a1', snapshot), snapshot, 'no observation, same object');
  assert.equal(signal.merge('a1', null), null);
  signal.observe('a1', { 'x-codex-secondary-used-percent': '50' }, Date.now());
  assert.equal(signal.merge('a1', snapshot), snapshot, 'same figures, no observed_at claim');
});

// --- the switch, end to end ------------------------------------------------
//
// The dashboard renders from a hand-written allow-list projection of each
// account, and a field left out of it simply vanishes before the page sees it.
// That has now cost this console two features that looked broken while the
// stored state was perfectly correct, so these tests assert on the rendered
// page rather than on the store.

async function guardFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-guard-console-'));
  const credentialHome = await mkdtemp(join(tmpdir(), 'codex-guard-home-'));
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
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
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
    baseUrl,
    async page() {
      const response = await fetch(`${baseUrl}/`);
      const cookie = response.headers.getSetCookie()[0].split(';')[0];
      const html = await response.text();
      return { html, cookie, csrf: /name="csrf" value="([^"]+)"/.exec(html)[1] };
    },
    async save(fields) {
      const { cookie, csrf } = await this.page();
      return fetch(`${baseUrl}/accounts/${account.id}/codex-model-guard`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, ...fields }),
      });
    },
  };
}

function guardField(html) {
  const form = /<form[^>]*codex-model-guard"[\s\S]*?<\/form>/.exec(html);
  assert.ok(form, 'the guard form should be on the page');
  return form[0];
}

test('saving the guard is visible on the next page load, not just in the store', async (t) => {
  const app = await guardFixture(t);

  const before = guardField((await app.page()).html);
  assert.equal(before.includes('checked'), false, 'a new account starts unguarded');

  const response = await app.save({ enabled: '1', threshold_percent: '20' });
  assert.equal(response.status, 303);

  const { html } = await app.page();
  const form = guardField(html);
  assert.match(form, /name="enabled" value="1" checked/);
  assert.match(form, /name="threshold_percent"[^>]*value="20"/);
  // The rule also has to appear where members read quota, or a refusal looks
  // like an outage rather than a setting.
  assert.match(html, /data-i18n="codex-guard-active"/);
  assert.match(html, /data-i18n="codex-guard-luna-only"/);
});

test('an unchecked box turns the guard off and keeps the threshold', async (t) => {
  const app = await guardFixture(t);
  await app.save({ enabled: '1', threshold_percent: '25' });

  // A browser omits an unchecked checkbox entirely; it does not send false.
  const response = await app.save({ threshold_percent: '25' });
  assert.equal(response.status, 303);

  const form = guardField((await app.page()).html);
  assert.equal(form.includes('checked'), false);
  assert.match(form, /name="threshold_percent"[^>]*value="25"/);
  const stored = app.store.accountById(app.account.id).codex_guard;
  assert.deepEqual(
    { enabled: stored.enabled, threshold_percent: stored.threshold_percent },
    { enabled: false, threshold_percent: 25 },
  );
});

test('the audit says who changed it and what it was before', async (t) => {
  const app = await guardFixture(t);
  await app.save({ enabled: '1', threshold_percent: '15' });
  await app.save({ threshold_percent: '15' });

  const entries = app.store.state.audit.filter((entry) => entry.event === 'codex_model_guard_updated');
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => [entry.previous_enabled, entry.enabled]),
    [[false, true], [true, false]],
    'a shared switch is only manageable if turning it off leaves a trace',
  );
  assert.ok(entries[0].actor, 'the actor is recorded');
});

test('an impossible threshold is refused and nothing is stored', async (t) => {
  const app = await guardFixture(t);
  const response = await app.save({ enabled: '1', threshold_percent: '90' });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /between 1% and 50%/);
  assert.equal(app.store.accountById(app.account.id).codex_guard, undefined);
});

test('the guard belongs to Codex accounts only', async (t) => {
  const app = await guardFixture(t);
  const claude = await app.store.addAccount({
    provider: 'claude',
    alias: 'claude-shared-1',
    emailLabel: 'owner@example.com',
  });
  // Bedrock, not just Claude. It shares the action cell with Codex, so it is
  // the one that actually slipped through: a guard form rendered on an account
  // billed per token, where the store can only refuse it.
  await app.store.addAccount({
    provider: 'bedrock',
    alias: 'bedrock-astra-1',
    bedrock: { region: 'us-west-2', modelId: 'us.openai.gpt-6-astra' },
    credential: { api_key: 'secret-key-value' },
  });
  await assert.rejects(
    app.store.setCodexModelGuard(claude.id, { enabled: true, thresholdPercent: '15' }),
    /not a Codex account/,
  );
  const html = (await app.page()).html;
  assert.equal(
    (html.match(/codex-model-guard"/g) ?? []).length,
    1,
    'only the Codex account carries the control',
  );
});
