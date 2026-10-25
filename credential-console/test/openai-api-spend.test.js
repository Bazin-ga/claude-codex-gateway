import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MetricsStore } from '../lib/metrics.js';
import {
  OPENAI_LONG_CONTEXT_ABOVE,
  openaiApiCostUsd,
  openaiApiPrice,
  summarizeApiSpend,
} from '../lib/openai-api-pricing.js';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';

const API_KEY = `sk-proj-${'a'.repeat(40)}`;
const DAY = 86_400_000;

async function tempHome(t, prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function request(overrides = {}) {
  return {
    startedAtMs: Date.now() - 60_000,
    method: 'POST',
    path: '/responses',
    deviceId: 'device-1',
    machineId: 'machine-1',
    memberLabel: 'alice',
    accountId: 'api-account',
    accountAlias: 'openai-api',
    model: 'gpt-6-luna',
    stream: true,
    statusCode: 200,
    outcome: 'completed',
    ttfbMs: 10,
    durationMs: 20,
    requestBytes: 100,
    responseBytes: 200,
    upstreamRequestId: null,
    inputTokens: 1_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 1_000,
    usageState: 'complete',
    ...overrides,
  };
}

test('a request over 272K prompt tokens is priced whole at the long-context rate', () => {
  const tokens = { input: 1e6, cacheWrite: 1e6, cacheRead: 1e6, output: 1e6 };
  // gpt-6-luna short: 0.10 + 0.125 + 0.01 + 0.50; long: 0.20 + 0.25 + 0.02 + 0.75.
  assert.equal(openaiApiCostUsd('gpt-6-luna', tokens).toFixed(3), '0.735');
  assert.equal(openaiApiCostUsd('gpt-6-luna', { ...tokens, longContext: true }).toFixed(3), '1.220');
  assert.equal(openaiApiPrice('gpt-6-luna-2026-09-30'), openaiApiPrice('gpt-6-luna'), 'a dated snapshot prices as its model');
  assert.equal(openaiApiCostUsd('gpt-6-lunatic', tokens), null);
  assert.equal(openaiApiCostUsd('codex-auto-review', tokens), null);
});

test('spend adds each group into its own window and every wider one', () => {
  const group = (period, model, deviceId, extra = {}) => ({
    model,
    device_id: deviceId,
    long_context: 0,
    period,
    requests: 1,
    without_usage: 0,
    input_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 2_000_000, // $1.00 at the short luna rate
    ...extra,
  });
  const spend = summarizeApiSpend([
    group(0, 'gpt-6-luna', 'a'),
    group(1, 'gpt-6-luna', 'b'),
    group(2, 'gpt-6-luna', 'a'),
    group(1, 'mystery-model', 'b', { requests: 3, without_usage: 1 }),
  ], { describeDevice: (id) => ({ label: `device ${id}`, note: 'alice' }) });
  assert.deepEqual(
    Object.fromEntries(Object.entries(spend.totals).map(([key, value]) => [key, value.toFixed(2)])),
    { day: '1.00', week: '2.00', month: '3.00' },
  );
  assert.equal(spend.requests, 6);
  assert.equal(spend.without_usage, 1);
  assert.deepEqual(spend.unpriced_models, ['mystery-model']);
  assert.deepEqual(spend.models.map((entry) => [entry.label, entry.requests]), [['gpt-6-luna', 3], ['mystery-model', 3]]);
  assert.deepEqual(spend.devices.map((entry) => entry.label), ['device a', 'device b']);
});

test('the metrics store groups an account by model, device, context tier and window', async (t) => {
  const home = await tempHome(t, 'api-spend-metrics-');
  const metrics = await new MetricsStore({ home, flushIntervalMs: 60_000 }).init();
  t.after(() => metrics.close());
  const now = Date.now();
  for (const entry of [
    request({ startedAtMs: now - 60_000 }),
    // 300K prompt, nearly all cached: the long-context rate.
    request({ startedAtMs: now - 60_000, inputTokens: 10, cacheReadInputTokens: OPENAI_LONG_CONTEXT_ABOVE + 100 }),
    request({ startedAtMs: now - 3 * DAY, deviceId: 'device-2' }),
    request({ startedAtMs: now - 20 * DAY }),
    request({ startedAtMs: now - 40 * DAY }), // outside the month
    request({ startedAtMs: now - 60_000, accountId: 'someone-else' }),
    request({ startedAtMs: now - 60_000, method: 'GET', path: '/models', model: null }),
    request({
      startedAtMs: now - 60_000,
      usageState: 'unavailable',
      inputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: null,
    }),
  ]) assert.equal(metrics.enqueueRequest(entry), true);
  metrics.flush();

  const groups = metrics.queryApiSpendGroups({
    accountId: 'api-account',
    nowMs: now,
    longContextAbove: OPENAI_LONG_CONTEXT_ABOVE,
  });
  const key = (row) => `${row.device_id}/${row.long_context}/${row.period}`;
  const byKey = Object.fromEntries(groups.map((row) => [key(row), row]));
  assert.deepEqual(Object.keys(byKey).sort(), ['device-1/0/0', 'device-1/0/2', 'device-1/1/0', 'device-2/0/1']);
  assert.equal(byKey['device-1/0/0'].requests, 2, 'the request without usage still counts as a request');
  assert.equal(byKey['device-1/0/0'].without_usage, 1);
  assert.equal(byKey['device-1/1/0'].cache_read_tokens, OPENAI_LONG_CONTEXT_ABOVE + 100);
});

test('an API-key account card shows its estimated spend instead of quota windows', async (t) => {
  const home = await tempHome(t, 'api-spend-console-');
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const account = await store.addAccount({ provider: 'codex', alias: 'openai-api', codexApiKey: API_KEY });
  const metrics = await new MetricsStore({ home, flushIntervalMs: 60_000 }).init();
  // 2M output tokens of luna in the last day: $1.00.
  metrics.enqueueRequest(request({ accountId: account.id, inputTokens: 0, outputTokens: 2_000_000 }));
  const created = await createCredentialConsole({
    store,
    requestMetrics: metrics,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const html = await (await fetch(`http://127.0.0.1:${created.server.address().port}/`)).text();
  const start = html.indexOf(`data-account-row="${account.id}"`);
  assert.notEqual(start, -1);
  // Not up to the first </tr>: the card's own breakdown tables have rows too.
  const end = html.indexOf('data-account-row=', start + 1);
  const row = html.slice(start, end === -1 ? undefined : end);
  assert.match(row, /data-i18n="api-spend-heading"/);
  assert.match(row, /data-i18n="api-spend-day">24 hours<\/span>\s*<strong>\$1\.00<\/strong>/);
  assert.match(row, /data-i18n="api-spend-month">30 days<\/span>\s*<strong>\$1\.00<\/strong>/);
  assert.match(row, /<details class="api-spend-details">[\s\S]*gpt-6-luna/);
  assert.doesNotMatch(row, /data-i18n="usage-five-hour"/, 'an API key has no quota window to show');
  assert.equal(html.includes(API_KEY), false);
});
