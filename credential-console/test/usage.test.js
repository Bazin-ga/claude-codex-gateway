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

test('normalizes Claude five-hour, weekly, and Fable-scoped remaining quota', async () => {
  const requests = [];
  const usage = await fetchClaudeUsage({
    oauthToken: 'sk-ant-oat01-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        five_hour: { utilization: 41.5, resets_at: '2026-08-05T16:00:00Z' },
        seven_day: { utilization: 9, resets_at: '2026-08-08T16:00:00Z' },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 27.5,
            resets_at: '2026-08-08T16:00:00Z',
            scope: { model: { display_name: 'Fable' } },
          },
        ],
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
    { kind: 'fable_weekly', remaining: 72.5 },
  ]);
});

test('does not mistake another weekly model scope for Fable quota', async () => {
  const usage = await fetchClaudeUsage({
    oauthToken: 'sk-ant-oat01-secret',
    fetchImpl: async () => new Response(JSON.stringify({
      five_hour: { utilization: 10, resets_at: null },
      seven_day: { utilization: 20, resets_at: null },
      limits: [{
        kind: 'weekly_scoped',
        percent: 80,
        resets_at: null,
        scope: { model: { display_name: 'Opus' } },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });

  assert.equal(usage.windows.some((window) => window.kind === 'fable_weekly'), false);
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
  // Kind says how long the window is; position says which slot the provider
  // sent it in, and on this plan the seven-day window IS the primary one.
  // Anything reading x-codex-primary/secondary-used-percent must line up by
  // position -- conflating the two made a 91% account render as 100%.
  assert.equal(usage.windows[0].position, 'primary');
  // The field is absent on plans that do not report it. Null, not zero: the
  // panel must be able to tell "holds none" from "did not say".
  assert.equal(usage.reset_credits, null);
});

test('Codex reset credits report the stock held, not what is spendable right now', async () => {
  const usage = await fetchCodexUsage({
    accessToken: 'codex-secret',
    accountId: 'account-1',
    fetchImpl: async () => new Response(JSON.stringify({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 44, limit_window_seconds: 604800, reset_at: 1789713572 },
        secondary_window: null,
      },
      // Two credits held; none applicable, because the account is under its
      // limit and there is nothing to reset. Reporting the applicable count
      // would show "no credits" on an account holding two, for as long as it
      // stays healthy.
      rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });

  assert.equal(usage.reset_credits, 2);
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

test('Claude has an independent poll timer while unset preserves the legacy shared schedule', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-usage-timers-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'claude-default-interval',
    credential: { oauth_token: 'default-only-test-token' },
  });
  const codex = await store.addAccount({ provider: 'codex', alias: 'codex-default-interval' });
  const monitor = new UsageMonitor({
    store,
    home,
    refreshIntervalMs: 60_000,
    fetchImpl: async () => new Response(JSON.stringify({
      five_hour: { utilization: 10, resets_at: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  assert.equal(monitor.claudeRefreshIntervalMs, null);
  assert.equal(monitor.timer, null);
  assert.equal(monitor.claudeTimer, null);
  await monitor.refresh();
  assert.equal(monitor.snapshotForAccount(claude.id).status, 'available');
  assert.equal(monitor.snapshotForAccount(codex.id).status, 'authorization_required');

  const independent = new UsageMonitor({
    store,
    home,
    refreshIntervalMs: 60_000,
    claudeRefreshIntervalMs: 60_000,
    fetchImpl: async () => new Response(JSON.stringify({
      five_hour: { utilization: 10, resets_at: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  await independent.init();
  assert.ok(independent.timer);
  assert.ok(independent.claudeTimer);
  independent.stop();
  assert.equal(independent.timer, null);
  assert.equal(independent.claudeTimer, null);
});

test('concurrent provider refreshes share one per-account fetch and keep provider schedules separate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-usage-overlap-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'claude-overlap',
    credential: { oauth_token: 'monitor-only-secret' },
  });
  await store.addAccount({ provider: 'codex', alias: 'codex-overlap' });
  let fetchCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const monitor = new UsageMonitor({
    store,
    home,
    refreshIntervalMs: 60_000,
    claudeRefreshIntervalMs: 60_000,
    fetchImpl: async () => {
      fetchCount += 1;
      await fetchGate;
      return new Response(JSON.stringify({
        five_hour: { utilization: 20, resets_at: null },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const claudeRefresh = monitor.refresh('claude');
  const duplicateRefresh = monitor.refreshAccount(claude.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  releaseFetch();
  await Promise.all([claudeRefresh, duplicateRefresh]);
  assert.equal(fetchCount, 1);
  assert.equal(monitor.snapshotForAccount(claude.id).status, 'available');
  monitor.stop();
});

test('provider-specific refreshes prune snapshots of deleted accounts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-usage-deleted-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-deleted-snapshot',
    credential: { oauth_token: 'deleted-snapshot-test-token' },
  });
  const monitor = new UsageMonitor({
    store,
    home,
    claudeRefreshIntervalMs: 60_000,
    fetchImpl: async () => new Response(JSON.stringify({
      five_hour: { utilization: 20, resets_at: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });

  await monitor.refresh('claude');
  assert.ok(monitor.snapshotForAccount(account.id));
  await store.deleteAccount(account.id, { confirmAlias: account.alias });
  await monitor.refresh('claude');
  assert.equal(monitor.snapshotForAccount(account.id), null);
  const persisted = JSON.parse(await readFile(join(home, 'usage.json'), 'utf8'));
  assert.equal(Object.hasOwn(persisted.accounts, account.id), false);
});

test('a deleted account is not re-added when its in-flight provider refresh completes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-usage-delete-inflight-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-delete-inflight',
    credential: { oauth_token: 'deleted-inflight-test-token' },
  });
  let notifyFetchStarted;
  const fetchStarted = new Promise((resolve) => { notifyFetchStarted = resolve; });
  let finishFetch;
  const fetchGate = new Promise((resolve) => { finishFetch = resolve; });
  const monitor = new UsageMonitor({
    store,
    home,
    claudeRefreshIntervalMs: 60_000,
    fetchImpl: async () => {
      notifyFetchStarted();
      await fetchGate;
      return new Response(JSON.stringify({
        five_hour: { utilization: 20, resets_at: null },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const refresh = monitor.refresh('claude');
  await fetchStarted;
  await store.deleteAccount(account.id, { confirmAlias: account.alias });
  finishFetch();
  await refresh;
  assert.equal(monitor.snapshotForAccount(account.id), null);
  const persisted = JSON.parse(await readFile(join(home, 'usage.json'), 'utf8'));
  assert.equal(Object.hasOwn(persisted.accounts, account.id), false);
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
