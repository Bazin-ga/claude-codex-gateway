import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMetricsChartPayload } from '../lib/metrics-chart-data.js';

const hour = Date.parse('2026-08-18T00:00:00.000Z');

test('chart payload uses a real hourly axis and preserves unknown separately from explicit zero', () => {
  const payload = buildMetricsChartPayload({
    range: { fromMs: hour, toMs: hour + 3 * 60 * 60_000, hours: 3 },
    totals: { all: 2, consumption: 1 },
    hourly: [{
      hourBucketMs: hour,
      requestCount: 2,
      successCount: 1,
      errorCount: 1,
      avgTtfbMs: null,
      avgDurationMs: 25.5,
    }],
    tokenHourly: [{
      hourBucketMs: hour,
      totalInputTokens: 0,
      totalInputTokensKnownCount: 1,
      totalCacheCreationInputTokens: null,
      totalCacheCreationInputTokensKnownCount: 0,
      totalCacheReadInputTokens: 5,
      totalCacheReadInputTokensKnownCount: 1,
      totalOutputTokens: null,
      totalOutputTokensKnownCount: 0,
    }],
  });

  assert.deepEqual(payload.hourly.timestamps, [hour, hour + 3600000, hour + 7200000]);
  assert.deepEqual(payload.hourly.requests.all, [2, 0, 0]);
  assert.deepEqual(payload.hourly.tokens.input, [[hour, 0], [hour + 3600000, null], [hour + 7200000, null]]);
  assert.deepEqual(payload.hourly.tokens.cacheCreation[0], [hour, null]);
  assert.deepEqual(payload.hourly.tokens.cacheRead[0], [hour, 5]);
  assert.deepEqual(payload.hourly.latency.ttfb[0], [hour, null]);
  assert.deepEqual(payload.hourly.latency.duration[0], [hour, 25.5]);
  assert.equal(JSON.stringify(payload).includes('NaN'), false);
  assert.equal(JSON.stringify(payload).includes('Infinity'), false);
});

test('device input series requires all three input categories and full known-count coverage', () => {
  const payload = buildMetricsChartPayload({
    range: { fromMs: hour, toMs: hour + 2 * 3600000, hours: 2 },
    deviceTokenComparison: {
      devices: [
        { deviceId: 'complete', label: 'Complete device' },
        { deviceId: 'partial', label: '<partial device>' },
      ],
      rows: [
        {
          hourBucketMs: hour,
          deviceId: 'complete',
          requestCount: 2,
          inputTokens: 10,
          inputTokensKnownCount: 2,
          cacheCreationInputTokens: 3,
          cacheCreationInputTokensKnownCount: 2,
          cacheReadInputTokens: 4,
          cacheReadInputTokensKnownCount: 2,
          outputTokens: 0,
          outputTokensKnownCount: 2,
        },
        {
          hourBucketMs: hour,
          deviceId: 'partial',
          requestCount: 2,
          inputTokens: 10,
          inputTokensKnownCount: 1,
          cacheCreationInputTokens: 3,
          cacheCreationInputTokensKnownCount: 2,
          cacheReadInputTokens: 4,
          cacheReadInputTokensKnownCount: 2,
          outputTokens: 5,
          outputTokensKnownCount: 1,
        },
      ],
    },
  });

  assert.deepEqual(payload.devices.input[0].data, [[hour, 17], [hour + 3600000, null]]);
  assert.deepEqual(payload.devices.output[0].data, [[hour, 0], [hour + 3600000, null]]);
  assert.deepEqual(payload.devices.input[1].data, [[hour, null], [hour + 3600000, null]]);
  assert.deepEqual(payload.devices.output[1].data, [[hour, null], [hour + 3600000, null]]);
  assert.equal(payload.devices.ranking[0].label, 'Complete device');
  assert.equal(payload.devices.ranking[0].input, 17);
  assert.equal(payload.devices.ranking[0].output, 0);
});

test('breakdowns are bounded, token-sorted lower bounds and overflow never becomes a number', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    label: index === 9 ? '<img src=x onerror=alert(1)>' : `Account ${index}`,
    totalInputTokens: index,
    totalInputTokensKnownCount: 1,
    totalCacheCreationInputTokens: null,
    totalCacheCreationInputTokensKnownCount: 0,
    totalCacheReadInputTokens: 0,
    totalCacheReadInputTokensKnownCount: 1,
    totalOutputTokens: index,
    totalOutputTokensKnownCount: 1,
    usagePartialCount: 1,
  }));
  rows[9].tokenTotalsOverflow = true;
  const payload = buildMetricsChartPayload({
    tokenTotals: {
      totalInputTokens: Number.MAX_SAFE_INTEGER,
      totalInputTokensKnownCount: 1,
      totalOutputTokens: 1,
      totalOutputTokensKnownCount: 1,
      tokenTotalsOverflow: true,
    },
    accountTokenBreakdown: rows,
  });

  assert.equal(payload.totals.knownTotal, null);
  assert.equal(payload.totals.coverage.overflow, true);
  assert.equal(payload.breakdowns.accounts.length, 8);
  assert.deepEqual(payload.breakdowns.accounts.map((row) => row.value), [16, 14, 12, 10, 8, 6, 4, 2]);
  assert.equal(payload.breakdowns.accounts.some((row) => row.label.includes('<img')), false);
});

test('payload exposes aggregates only and drops unrelated or secret-looking fields', () => {
  const payload = buildMetricsChartPayload({
    range: { fromMs: hour, toMs: hour + 3600000, hours: 1 },
    hourly: [{
      hourBucketMs: hour,
      requestCount: 1,
      promptText: 'must-not-escape',
      access_token: 'must-not-escape',
    }],
    deviceTokenComparison: {
      devices: [{ deviceId: 'device', label: 'Device' }],
      rows: [{ hourBucketMs: hour, deviceId: 'device', responseText: 'must-not-escape' }],
    },
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('must-not-escape'), false);
  assert.equal(serialized.includes('promptText'), false);
  assert.equal(serialized.includes('responseText'), false);
  assert.equal(serialized.includes('access_token'), false);
});

test('maximum eight-device thirty-day payload stays bounded', () => {
  const devices = Array.from({ length: 8 }, (_, index) => ({
    deviceId: `device-${index}`,
    label: `Device ${index}`,
  }));
  const rows = [];
  for (let hourIndex = 0; hourIndex < 720; hourIndex += 1) {
    for (let deviceIndex = 0; deviceIndex < devices.length; deviceIndex += 1) {
      rows.push({
        hourBucketMs: hour + hourIndex * 3600000,
        deviceId: devices[deviceIndex].deviceId,
        requestCount: 1,
        inputTokens: hourIndex + deviceIndex,
        inputTokensKnownCount: 1,
        cacheCreationInputTokens: 1,
        cacheCreationInputTokensKnownCount: 1,
        cacheReadInputTokens: 2,
        cacheReadInputTokensKnownCount: 1,
        outputTokens: 3,
        outputTokensKnownCount: 1,
      });
    }
  }
  const payload = buildMetricsChartPayload({
    range: { fromMs: hour, toMs: hour + 720 * 3600000, hours: 720 },
    deviceTokenComparison: { devices, rows },
  });
  assert.equal(payload.devices.input.length, 8);
  assert.equal(payload.devices.input[0].data.length, 720);
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < 512 * 1024);
});
