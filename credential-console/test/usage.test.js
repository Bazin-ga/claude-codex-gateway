import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import {
  UsageMonitor,
  fetchClaudeUsage,
  fetchCodexUsage,
} from '../lib/usage.js';

test('normalizes Claude five-hour and weekly remaining quota', async () => {
  const requests = [];
  const usage = await fetchClaudeUsage({
    oauthToken: 'sk-ant-oat01-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        five_hour: { utilization: 41.5, resets_at: '2026-08-05T16:00:00Z' },
        seven_day: { utilization: 9, resets_at: '2026-08-08T16:00:00Z' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk-ant-oat01-secret');
  assert.deepEqual(usage.windows.map((window) => ({
    kind: window.kind,
    remaining: window.remaining_percent,
  })), [
    { kind: 'five_hour', remaining: 58.5 },
    { kind: 'weekly', remaining: 91 },
  ]);
});

test('classifies a Claude usage-scope rejection as reauthorization required', async () => {
  await assert.rejects(
    fetchClaudeUsage({
      oauthToken: 'sk-ant-oat01-inference-only',
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: 'OAuth token does not meet scope requirement user:profile' },
      }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    }),
    (error) => error.code === 'reauthorization_required',
  );
});

test('maps Codex windows by duration instead of assuming primary means five hours', async () => {
  const usage = await fetchCodexUsage({
    accessToken: 'codex-secret',
    accountId: 'account-1',
    fetchImpl: async () => new Response(JSON.stringify({
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 9,
          limit_window_seconds: 604800,
          reset_at: 1786162162,
        },
        secondary_window: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });

  assert.equal(usage.plan_type, 'pro');
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'weekly');
  assert.equal(usage.windows[0].remaining_percent, 91);
});

test('hourly monitor caches only normalized usage metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-usage-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-team',
    credential: { oauth_token: 'sk-ant-oat01-never-cache-this' },
  });
  const events = [];
  const monitor = await new UsageMonitor({
    store,
    home,
    refreshIntervalMs: 60_000,
    log: (event, detail) => events.push({ event, detail }),
    fetchImpl: async () => new Response(JSON.stringify({
      five_hour: { utilization: 20, resets_at: '2026-08-05T16:00:00Z' },
      seven_day: { utilization: 30, resets_at: '2026-08-08T16:00:00Z' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  }).init();
  try {
    await monitor.refresh();
    assert.equal(monitor.snapshotForAccount(account.id).status, 'available');
    const cache = await readFile(join(home, 'usage.json'), 'utf8');
    assert.equal(cache.includes('sk-ant-oat01-never-cache-this'), false);
    assert.equal(JSON.parse(cache).accounts[account.id].windows[0].remaining_percent, 80);
    assert.equal(events.some((entry) => entry.event === 'account_usage_refreshed'), true);
  } finally {
    monitor.stop();
  }
});

test('a Codex account awaiting authorization is not reported as a usage failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-usage-codex-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  // What POST /accounts creates: registered, never authorized, no external home.
  const account = await store.addAccount({ provider: 'codex', alias: 'codex-shared-1' });
  const events = [];
  const monitor = await new UsageMonitor({
    store,
    home,
    refreshIntervalMs: 60_000,
    log: (event, detail) => events.push({ event, detail }),
    fetchImpl: async () => {
      throw new Error('a Codex account with no home must not be fetched for');
    },
  }).init();
  try {
    await monitor.refresh();
    assert.equal(monitor.snapshotForAccount(account.id).status, 'authorization_required');
    assert.equal(
      events.find((entry) => entry.event === 'account_usage_refresh_failed').detail.code,
      'authorization_required',
    );
  } finally {
    monitor.stop();
  }
});
