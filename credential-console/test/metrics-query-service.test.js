import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MetricsStore } from '../lib/metrics.js';
import { MetricsQueryService } from '../lib/metrics-query-service.js';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';

const BASE_MS = 1_700_000_000_000;

test('metrics query worker reads a live WAL database without owning writes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'metrics-query-worker-'));
  const writer = await new MetricsStore({ home, flushIntervalMs: 60_000 }).init();
  t.after(() => writer.close());
  assert.equal(writer.enqueueRequest({
    startedAtMs: BASE_MS,
    method: 'POST',
    path: '/v1/messages',
    deviceId: 'worker-device',
    machineId: null,
    memberLabel: 'worker-member',
    accountId: 'worker-account',
    accountAlias: 'worker-account',
    model: 'worker-model',
    stream: true,
    statusCode: 200,
    outcome: 'completed',
    ttfbMs: 12,
    durationMs: 34,
    requestBytes: 56,
    responseBytes: 78,
    upstreamRequestId: 'worker-upstream',
    inputTokens: 9,
    cacheCreationInputTokens: 8,
    cacheReadInputTokens: 7,
    outputTokens: 6,
    usageState: 'complete',
  }), true);
  assert.equal(writer.flush().written, 1);

  const service = await new MetricsQueryService({ dbPath: writer.dbPath }).init();
  t.after(() => service.close());
  const result = await service.query({
    fromMs: BASE_MS - 1,
    toMs: BASE_MS + 1,
  });
  assert.equal(result.allTotals.requestCount, 1);
  assert.equal(result.consumptionTotals.totalInputTokens, 9);
  assert.equal(result.hourly.length, 1);
  assert.equal(result.memberRows[0].groupValue, 'worker-member');
  assert.equal(result.deviceTokenComparison.devices[0].deviceId, 'worker-device');

  // A later WAL write is visible without recreating the worker connection.
  assert.equal(writer.enqueueRequest({
    startedAtMs: BASE_MS + 1,
    method: 'POST',
    path: '/responses',
    deviceId: 'worker-device',
    machineId: null,
    memberLabel: 'worker-member',
    accountId: 'worker-account',
    accountAlias: 'worker-account',
    model: 'worker-model',
    stream: true,
    statusCode: 200,
    outcome: 'completed',
    ttfbMs: 10,
    durationMs: 20,
    requestBytes: 30,
    responseBytes: 40,
    upstreamRequestId: 'worker-upstream-2',
    inputTokens: 5,
    outputTokens: 4,
    usageState: 'complete',
  }), true);
  assert.equal(writer.flush().written, 1);
  const later = await service.query({
    fromMs: BASE_MS - 1,
    toMs: BASE_MS + 2,
  });
  assert.equal(later.allTotals.requestCount, 2);
  assert.equal(later.consumptionTotals.totalOutputTokens, 10);
});

test('the console enables its read-only metrics worker by default', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'metrics-query-console-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const created = await createCredentialConsole({
    store,
    adminAuth: 'open',
    cookieSecure: false,
    enableMetricsQueryWorker: true,
    usageMonitor: { snapshotForAccount: () => null, stop() {} },
  });
  assert.equal(created.metricsQueryService instanceof MetricsQueryService, true);
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (created.server.listening) {
      await new Promise((resolve) => created.server.close(resolve));
    }
  });
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  const metrics = await fetch(`${baseUrl}/metrics?hours=24`);
  assert.equal(metrics.status, 200);
  const chart = await fetch(`${baseUrl}/metrics/chart-data?hours=24`);
  assert.equal(chart.status, 200);
});

test('an unavailable production worker fails metrics closed without taking down health', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'metrics-query-unavailable-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const created = await createCredentialConsole({
    store,
    adminAuth: 'open',
    cookieSecure: false,
    enableMetricsQueryWorker: true,
    metricsQueryService: null,
    usageMonitor: { snapshotForAccount: () => null, stop() {} },
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (created.server.listening) {
      await new Promise((resolve) => created.server.close(resolve));
    }
  });
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/metrics/chart-data?hours=24`)).status, 503);
});
