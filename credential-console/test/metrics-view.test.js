import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dashboardView, messageView, metricsView } from '../lib/views.js';

const FILTERS = {
  hours: 168,
  machineId: 'machine-01',
  unattributedMachine: false,
  memberLabel: 'alice',
  accountId: 'account-01',
  model: 'claude-test',
};

const OPTIONS = {
  machines: [{ value: 'machine-01', label: 'Alice laptop' }],
  members: [{ value: 'alice', label: 'alice' }],
  accounts: [{ value: 'account-01', label: 'Claude shared' }],
  models: [{ value: 'claude-test', label: 'claude-test' }],
};

const HOURLY = [{
  hourBucketMs: Date.parse('2026-08-17T10:00:00.000Z'),
  requestCount: 4,
  successCount: 3,
  errorCount: 1,
  totalRequestBytes: 400,
  totalResponseBytes: 800,
  avgTtfbMs: 12.5,
  avgDurationMs: 125.75,
}];

const TOKEN_TOTALS = {
  totalInputTokens: 1000,
  totalInputTokensKnownCount: 2,
  totalCacheCreationInputTokens: 120,
  totalCacheCreationInputTokensKnownCount: 1,
  totalCacheReadInputTokens: 80,
  totalCacheReadInputTokensKnownCount: 1,
  totalOutputTokens: 500,
  totalOutputTokensKnownCount: 2,
  usageCompleteCount: 1,
  usagePartialCount: 1,
  usageUnavailableCount: 1,
};

const TOKEN_HOURLY = [{
  hourBucketMs: HOURLY[0].hourBucketMs,
  totalInputTokens: 1000,
  totalInputTokensKnownCount: 2,
  totalCacheCreationInputTokens: 120,
  totalCacheCreationInputTokensKnownCount: 1,
  totalCacheReadInputTokens: 80,
  totalCacheReadInputTokensKnownCount: 1,
  totalOutputTokens: 500,
  totalOutputTokensKnownCount: 2,
  usageCompleteCount: 1,
  usagePartialCount: 1,
  usageUnavailableCount: 1,
}];

function render(overrides = {}) {
  return metricsView({
    filters: FILTERS,
    options: OPTIONS,
    totals: { all: 4, consumption: 3 },
    hourly: HOURLY,
    tokenTotals: TOKEN_TOTALS,
    tokenHourly: TOKEN_HOURLY,
    ...overrides,
  });
}

function selectedMachineOptions(html) {
  const select = html.match(/<select name="machine_id">([\s\S]*?)<\/select>/);
  assert.ok(select, 'machine filter select should be present');
  return select[1].match(/<option\b[^>]*\bselected(?:\s|=|>)/g) ?? [];
}

test('metrics view renders exact filter echo, totals, and dashboard-safe values', () => {
  const html = render({
    options: {
      ...OPTIONS,
      machines: [{ value: 'machine-01', label: '<Alice & laptop>' }],
      members: [{ value: 'alice', label: 'Alice & Bob' }],
      accounts: [{ value: 'account-01', label: 'Claude "shared"' }],
      models: [{ value: 'claude-test', label: "model's <name>" }],
    },
  });

  assert.match(html, /<form method="get" action="\/metrics"/);
  assert.match(html, /name="machine_id"/);
  assert.match(html, /name="member_label"/);
  assert.match(html, /name="account_id"/);
  assert.match(html, /name="model"/);
  assert.match(html, /name="hours"/);
  assert.match(html, /value="machine-01" selected/);
  assert.match(html, /value="alice" selected/);
  assert.match(html, /value="account-01" selected/);
  assert.match(html, /value="claude-test" selected/);
  assert.match(html, /value="168" selected/);
  assert.match(html, />4<\/strong>/);
  assert.match(html, />3<\/strong>/);
  assert.match(html, /&lt;Alice &amp; laptop&gt;/);
  assert.match(html, /Claude &quot;shared&quot;/);
  assert.match(html, /model&#39;s &lt;name&gt;/);
  assert.match(html, /data-i18n="metrics-attribution-disclaimer"/);
  assert.match(html, /data-i18n="metrics-claude-only"/);
  assert.match(html, /data-i18n="metrics-token-coverage-lower-bound"/);
  assert.match(html, /self-entered and unverified/);
  assert.match(html, /href="\/metrics"[^>]*data-i18n="metrics-reset-filters"/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.equal(html.includes('<script>alert'), false);
  assert.equal(html.includes('onerror='), false);
  assert.equal(html.includes('onload='), false);
});

test('metrics view has accessible request, latency, and token SVG charts plus a textual data table', () => {
  const html = render();

  assert.equal((html.match(/<svg role="img"/g) ?? []).length, 5);
  assert.match(html, /aria-labelledby="metrics-requests-chart-title metrics-requests-chart-description"/);
  assert.match(html, /aria-labelledby="metrics-latency-chart-title metrics-latency-chart-description"/);
  assert.match(html, /<title id="metrics-requests-chart-title"[^>]*>/);
  assert.match(html, /<desc id="metrics-requests-chart-description"[^>]*>/);
  assert.match(html, /<title id="metrics-latency-chart-title"[^>]*>/);
  assert.match(html, /<desc id="metrics-latency-chart-description"[^>]*>/);
  assert.match(html, /data-i18n="metrics-series-total"/);
  assert.match(html, /data-i18n="metrics-series-ttfb"/);
  assert.match(html, /data-i18n="metrics-series-input-tokens"/);
  assert.match(html, /data-i18n="metrics-series-output-tokens"/);
  assert.match(html, /href="\/conversations" data-i18n="metrics-conversations-link"/);
  assert.match(html, /id="metrics-tokens-chart-title"/);
  assert.match(html, /class="metrics-table"/);
  assert.match(html, /data-i18n="metrics-request-bytes"/);
  assert.match(html, /data-i18n="metrics-total-input-tokens"/);
  assert.match(html, /data-i18n="metrics-total-cache-creation-input-tokens"/);
  assert.match(html, /data-i18n="metrics-total-cache-read-input-tokens"/);
  assert.match(html, /data-i18n="metrics-total-output-tokens"/);
  assert.match(html, /data-i18n="metrics-usage-coverage"/);
  assert.match(html, /2026-08-17 10:00Z/);
  assert.match(html, /12\.5/);
  assert.match(html, /125\.8/);
});

test('metrics view renders safe empty and unavailable states without invalid SVG numbers', () => {
  const html = render({
    totals: { all: 0, consumption: 0 },
    hourly: [],
    tokenTotals: {},
    tokenHourly: [],
    metricsAvailable: false,
    error: '<database unavailable>',
  });

  assert.match(html, /data-i18n="metrics-unavailable"/);
  assert.match(html, /data-i18n="metrics-error"/);
  assert.match(html, /&lt;database unavailable&gt;/);
  assert.equal((html.match(/<svg role="img"/g) ?? []).length, 5);
  assert.match(html, /data-i18n="metrics-no-data"/);
  assert.match(html, /No matching request data for this period/);
  assert.match(html, /colspan="13"/);
  assert.equal(html.includes('NaN'), false);
  assert.equal(html.includes('Infinity'), false);
});

test('token summaries preserve known counts and expose the Claude-only lower-bound coverage', () => {
  const html = render();
  assert.match(html, />1,000<\/strong>/);
  assert.match(html, />120<\/strong>/);
  assert.match(html, />80<\/strong>/);
  assert.match(html, />500<\/strong>/);
  assert.match(html, /Known values<\/span>: 2/);
  assert.match(html, /Complete<\/span>: 1/);
  assert.match(html, /Partial<\/span>: 1/);
  assert.match(html, /Unavailable<\/span>: 1/);
  assert.match(html, /Codex clients connect directly/);
  assert.equal(html.includes('Request and response bodies'), true, 'body-free privacy notice must remain visible');
});

test('unknown token totals render as unknown, not zero, and token SVG leaves missing values blank', () => {
  const html = render({
    tokenTotals: {
      totalInputTokens: null,
      totalInputTokensKnownCount: 0,
      totalCacheCreationInputTokens: null,
      totalCacheReadInputTokens: null,
      totalOutputTokens: null,
      usageCompleteCount: 0,
      usagePartialCount: 0,
      usageUnavailableCount: 2,
    },
    tokenHourly: [{
      hourBucketMs: HOURLY[0].hourBucketMs,
      totalInputTokens: null,
      totalCacheCreationInputTokens: null,
      totalCacheReadInputTokens: null,
      totalOutputTokens: null,
      usageCompleteCount: 0,
      usagePartialCount: 0,
      usageUnavailableCount: 2,
    }],
  });
  assert.match(html, /data-i18n="metrics-token-coverage-unavailable"/);
  assert.match(html, /Token usage is unavailable for this selection/);
  assert.match(html, /<strong>—<\/strong>/);
  assert.equal(html.includes('>0<\/strong>'), false, 'unknown token totals must not render as zero');
  assert.equal(html.includes('NaN'), false);
  assert.equal(html.includes('Infinity'), false);
});

test('known zero token totals remain exact zeros rather than unavailable', () => {
  const html = render({
    tokenTotals: {
      totalInputTokens: 0,
      totalInputTokensKnownCount: 1,
      totalCacheCreationInputTokens: 0,
      totalCacheCreationInputTokensKnownCount: 1,
      totalCacheReadInputTokens: 0,
      totalCacheReadInputTokensKnownCount: 1,
      totalOutputTokens: 0,
      totalOutputTokensKnownCount: 1,
      usageCompleteCount: 1,
      usagePartialCount: 0,
      usageUnavailableCount: 0,
    },
    tokenHourly: [],
  });
  assert.match(html, /data-i18n="metrics-token-coverage-complete"/);
  assert.equal((html.match(/<strong>0<\/strong>/g) ?? []).length >= 4, true);
  assert.equal(html.includes('data-i18n="metrics-token-coverage-unavailable"'), false);
});

test('complete usage with provider-null cache categories stays complete without a false error', () => {
  const completeWithUnknown = {
    totalInputTokens: 10,
    totalInputTokensKnownCount: 1,
    totalCacheCreationInputTokens: null,
    totalCacheCreationInputTokensKnownCount: 0,
    totalCacheReadInputTokens: null,
    totalCacheReadInputTokensKnownCount: 0,
    totalOutputTokens: 5,
    totalOutputTokensKnownCount: 1,
    usageCompleteCount: 1,
    usagePartialCount: 0,
    usageUnavailableCount: 0,
  };
  const html = render({
    tokenTotals: completeWithUnknown,
    tokenHourly: [{ hourBucketMs: HOURLY[0].hourBucketMs, ...completeWithUnknown }],
  });
  assert.match(html, /data-i18n="metrics-token-coverage-complete-with-unknown"/);
  assert.match(html, /data-i18n="metrics-usage-complete-with-unknown"/);
  assert.doesNotMatch(html, /data-i18n="metrics-token-coverage-lower-bound"/);
  const coverage = html.match(/<div class="([^"]*) metrics-token-coverage"/)?.[1] ?? '';
  assert.equal(coverage.includes('error'), false);
});

test('request-only hours are not mislabeled as token parsing failures', () => {
  const html = render({ tokenTotals: {}, tokenHourly: [] });
  assert.match(html, /data-i18n="metrics-usage-not-applicable"/);
  assert.doesNotMatch(html, /data-i18n="metrics-usage-partial"/);
});

test('overflow is explicit instead of rounded or rendered as zero', () => {
  const overflow = {
    totalInputTokens: null,
    totalInputTokensKnownCount: 1025,
    totalCacheCreationInputTokens: 0,
    totalCacheCreationInputTokensKnownCount: 1025,
    totalCacheReadInputTokens: 0,
    totalCacheReadInputTokensKnownCount: 1025,
    totalOutputTokens: null,
    totalOutputTokensKnownCount: 1025,
    usageCompleteCount: 1025,
    usagePartialCount: 0,
    usageUnavailableCount: 0,
    tokenTotalsOverflow: true,
  };
  const html = render({
    tokenTotals: overflow,
    tokenHourly: [{ hourBucketMs: HOURLY[0].hourBucketMs, ...overflow }],
  });
  assert.match(html, /data-i18n="metrics-token-coverage-overflow"/);
  assert.match(html, /data-i18n="metrics-usage-overflow"/);
  assert.doesNotMatch(html, /9,007,199,254,740,99/);
});

test('overflow does not hide simultaneous partial lower-bound coverage', () => {
  const html = render({
    tokenTotals: {
      totalInputTokens: null,
      totalInputTokensKnownCount: 1025,
      totalOutputTokens: 5,
      totalOutputTokensKnownCount: 1,
      usageCompleteCount: 1025,
      usagePartialCount: 1,
      usageUnavailableCount: 1,
      tokenTotalsOverflow: true,
    },
  });
  assert.match(html, /data-i18n="metrics-token-coverage-overflow-lower-bound"/);
  assert.match(html, /lower bounds/i);
});

test('metrics view makes dropped request rows visibly incomplete', () => {
  const html = render({ droppedMetrics: 7 });
  assert.match(html, /data-i18n="metrics-incomplete"/);
  assert.match(html, /charts may be incomplete/);
  assert.match(html, /<strong>7<\/strong>/);
});

test('unattributed machine filter is echoed with the fixed sentinel', () => {
  const html = render({
    filters: {
      ...FILTERS,
      machineId: '',
      unattributedMachine: true,
    },
  });

  assert.match(html, /name="machine_id"/);
  assert.match(html, /value="__unattributed__" selected/);
  assert.equal(selectedMachineOptions(html).length, 1);
});

test('dashboard persistent tabs link to usage metrics', () => {
  const html = dashboardView({
    accounts: [],
    devices: [],
    csrf: 'csrf',
    adminIdentity: 'admin@example.com',
  });

  assert.match(html, /href="\/metrics" data-i18n="tab-metrics"/);
  assert.match(html, /href="\/" data-i18n="tab-overview" aria-current="page"/);
});

test('layout pins stack cards to one responsive column and marks the active usage tab', () => {
  const html = render();
  assert.match(html, /\.stack \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(html, /\.stack > \.card \{ grid-column: auto; min-width: 0; \}/);
  assert.match(html, /\.page-tabs a:focus-visible/);
  assert.match(html, /href="\/metrics" data-i18n="tab-metrics" aria-current="page"/);
  assert.doesNotMatch(html, /href="\/" data-i18n="tab-overview" aria-current="page"/);
  assert.match(html, /conversation-filters \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /machine-list \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(html, /\.machine \{ min-width: 0;/);
  assert.match(html, /\.topbar \{ align-items: flex-start; flex-wrap: wrap; \}/);
  assert.match(html, /button, \.button, input, select \{ min-height: 44px; \}/);
  assert.match(html, /accounts-table \{ min-width: 1100px; \}/);
  assert.match(html, /accounts-table td:last-child input \{ min-width: 140px; \}/);
  assert.doesNotMatch(messageView('Error', 'safe message'), /class="page-tabs"/);
});

test('latency SVG preserves null gaps instead of drawing missing values at zero', () => {
  const html = render({
    hourly: [{
      ...HOURLY[0],
      avgTtfbMs: null,
      avgDurationMs: null,
    }],
  });
  const latency = html.match(/aria-labelledby="metrics-latency-chart-title metrics-latency-chart-description"[\s\S]*?<\/svg>/)?.[0] ?? '';
  assert.doesNotMatch(latency, /metrics-line ttfb/);
  assert.doesNotMatch(latency, /metrics-line duration/);
});

test('cross-device comparison is capped at eight, escapes labels, preserves unknown gaps, and uses two line charts', () => {
  const comparison = {
    devices: Array.from({ length: 9 }, (_, index) => ({
      deviceId: `device-${index}`,
      label: index === 0 ? '<img src=x onerror=alert(1)>' : `Device ${index}`,
    })),
    rows: Array.from({ length: 8 }, (_, index) => ({
      hourBucketMs: HOURLY[0].hourBucketMs + index * 60 * 60 * 1000,
      deviceId: `device-${index}`,
      inputTokens: index === 1 ? null : 10,
      cacheCreationInputTokens: index === 1 ? 1 : 2,
      cacheReadInputTokens: index === 1 ? 2 : 3,
      outputTokens: index === 2 ? null : 4,
      usagePartialCount: index === 1 ? 1 : 0,
      usageUnavailableCount: index === 2 ? 1 : 0,
    })),
    truncated: false,
    hoursTruncated: true,
    unavailableDeviceCount: 2,
  };
  const html = render({ deviceTokenComparison: comparison });
  assert.match(html, /id="metrics-device-input-comparison-chart-title"/);
  assert.match(html, /id="metrics-device-output-comparison-chart-title"/);
  assert.equal((html.match(/data-device-comparison=/g) ?? []).length, 8);
  assert.equal((html.match(/class="metrics-line device-/g) ?? []).length, 16);
  assert.match(html, /data-i18n="metrics-device-comparison-devices-truncated"/);
  assert.match(html, /data-i18n="metrics-device-comparison-hours-truncated"/);
  assert.match(html, /data-i18n="metrics-device-comparison-unavailable-devices"/);
  assert.match(html, /data-i18n="metrics-device-comparison-scope"/);
  assert.match(html, /data-i18n="metrics-device-comparison-unknown-points"/);
  assert.match(html, /<caption[^>]*metrics-device-comparison-table-caption/);
  assert.match(html, /stroke-dasharray="8 5"/);
  const inputChart = html.match(/aria-labelledby="metrics-device-input-comparison-chart-title metrics-device-input-comparison-chart-description"[\s\S]*?<\/svg>/)?.[0] ?? '';
  const outputChart = html.match(/aria-labelledby="metrics-device-output-comparison-chart-title metrics-device-output-comparison-chart-description"[\s\S]*?<\/svg>/)?.[0] ?? '';
  assert.match(inputChart, /class="metrics-line device-1"[^>]*d=""/);
  assert.match(outputChart, /class="metrics-line device-2"[^>]*d=""/);
  assert.match(inputChart, /class="metrics-point device-0"/);
  assert.match(outputChart, /class="metrics-point device-0"/);
  assert.doesNotMatch(inputChart, /class="metrics-point device-1"/);
  assert.doesNotMatch(outputChart, /class="metrics-point device-2"/);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.equal(html.includes('NaN'), false);
  assert.equal(html.includes('Infinity'), false);
});

test('single known points remain visible as markers while unknown points have none', () => {
  const html = render({
    deviceTokenComparison: {
      devices: [
        { deviceId: 'known-device', label: 'Known device' },
        { deviceId: 'unknown-device', label: 'Unknown device' },
      ],
      rows: [
        {
          hourBucketMs: HOURLY[0].hourBucketMs,
          deviceId: 'known-device',
          requestCount: 1,
          inputTokens: 1,
          inputTokensKnownCount: 1,
          cacheCreationInputTokens: 2,
          cacheCreationInputTokensKnownCount: 1,
          cacheReadInputTokens: 3,
          cacheReadInputTokensKnownCount: 1,
          outputTokens: 4,
          outputTokensKnownCount: 1,
        },
        {
          hourBucketMs: HOURLY[0].hourBucketMs,
          deviceId: 'unknown-device',
          requestCount: 1,
          inputTokens: null,
          inputTokensKnownCount: 0,
          cacheCreationInputTokens: null,
          cacheCreationInputTokensKnownCount: 0,
          cacheReadInputTokens: null,
          cacheReadInputTokensKnownCount: 0,
          outputTokens: null,
          outputTokensKnownCount: 0,
        },
      ],
    },
  });
  const inputChart = html.match(/aria-labelledby="metrics-device-input-comparison-chart-title metrics-device-input-comparison-chart-description"[\s\S]*?<\/svg>/)?.[0] ?? '';
  const outputChart = html.match(/aria-labelledby="metrics-device-output-comparison-chart-title metrics-device-output-comparison-chart-description"[\s\S]*?<\/svg>/)?.[0] ?? '';
  assert.match(inputChart, /class="metrics-point device-0"[^>]*aria-hidden="true"/);
  assert.match(outputChart, /class="metrics-point device-0"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(inputChart, /class="metrics-point device-1"/);
  assert.doesNotMatch(outputChart, /class="metrics-point device-1"/);
});

test('known counts prevent a lower-bound hour from becoming a complete chart point', () => {
  const html = render({
    deviceTokenComparison: {
      devices: [{ deviceId: 'device-partial', label: 'Partial device' }],
      rows: [{
        hourBucketMs: HOURLY[0].hourBucketMs,
        deviceId: 'device-partial',
        requestCount: 2,
        inputTokens: 10,
        inputTokensKnownCount: 1,
        cacheCreationInputTokens: 2,
        cacheCreationInputTokensKnownCount: 2,
        cacheReadInputTokens: 3,
        cacheReadInputTokensKnownCount: 2,
        outputTokens: 4,
        outputTokensKnownCount: 1,
        usagePartialCount: 1,
        usageUnavailableCount: 0,
      }],
    },
  });
  const inputChart = html.match(/aria-labelledby="metrics-device-input-comparison-chart-title metrics-device-input-comparison-chart-description"[\s\S]*?<\/svg>/)?.[0] ?? '';
  const outputChart = html.match(/aria-labelledby="metrics-device-output-comparison-chart-title metrics-device-output-comparison-chart-description"[\s\S]*?<\/svg>/)?.[0] ?? '';
  assert.doesNotMatch(inputChart, /metrics-line device-0/);
  assert.doesNotMatch(outputChart, /metrics-line device-0/);
  assert.match(html, /data-i18n="metrics-device-comparison-partial"/);
  assert.match(html, /<td>10<\/td>/);
  assert.match(html, /<td>4<\/td>/);
});

test('P5 metrics labels have Chinese translation entries', async () => {
  const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  for (const key of [
    'tab-overview',
    'tab-metrics',
    'tab-conversations',
    'metrics-conversations-link',
    'metrics-claude-only',
    'metrics-token-input',
    'metrics-token-cache-creation',
    'metrics-token-cache-read',
    'metrics-token-output',
    'metrics-token-known-count',
    'metrics-token-coverage-complete',
    'metrics-token-coverage-complete-with-unknown',
    'metrics-token-coverage-lower-bound',
    'metrics-token-coverage-unavailable',
    'metrics-token-coverage-overflow',
    'metrics-token-coverage-overflow-lower-bound',
    'metrics-token-complete-count',
    'metrics-token-partial-count',
    'metrics-token-unavailable-count',
    'metrics-token-trend',
    'metrics-token-trend-description',
    'metrics-token-no-data',
    'metrics-total-input-tokens',
    'metrics-total-cache-creation-input-tokens',
    'metrics-total-cache-read-input-tokens',
    'metrics-total-output-tokens',
    'metrics-usage-coverage',
    'metrics-usage-complete',
    'metrics-usage-complete-with-unknown',
    'metrics-usage-partial',
    'metrics-usage-unavailable',
    'metrics-usage-not-applicable',
    'metrics-usage-overflow',
    'metrics-device-comparison-heading',
    'metrics-device-comparison-description',
    'metrics-device-comparison-scope',
    'metrics-device-input-comparison-heading',
    'metrics-device-input-comparison-description',
    'metrics-device-output-comparison-heading',
    'metrics-device-output-comparison-description',
    'metrics-device-comparison-known-sum',
    'metrics-device-comparison-known-points',
    'metrics-device-comparison-unknown-points',
    'metrics-device-comparison-coverage',
    'metrics-device-comparison-device',
    'metrics-device-comparison-complete',
    'metrics-device-comparison-partial',
    'metrics-device-comparison-unavailable',
    'metrics-device-comparison-no-data',
    'metrics-device-comparison-truncated',
    'metrics-device-comparison-devices-truncated',
    'metrics-device-comparison-hours-truncated',
    'metrics-device-comparison-unavailable-devices',
    'metrics-device-comparison-table-caption',
  ]) {
    assert.match(serverSource, new RegExp(`'${key}':`), `missing translation key ${key}`);
  }
});
