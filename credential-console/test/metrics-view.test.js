import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardView, metricsView } from '../lib/views.js';

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

function render(overrides = {}) {
  return metricsView({
    filters: FILTERS,
    options: OPTIONS,
    totals: { all: 4, consumption: 3 },
    hourly: HOURLY,
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
  assert.match(html, /self-entered and unverified/);
  assert.match(html, /href="\/metrics"[^>]*data-i18n="metrics-reset-filters"/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.equal(html.includes('<script>alert'), false);
  assert.equal(html.includes('onerror='), false);
  assert.equal(html.includes('onload='), false);
});

test('metrics view has two accessible inline SVG charts and a textual data table', () => {
  const html = render();

  assert.equal((html.match(/<svg role="img"/g) ?? []).length, 2);
  assert.match(html, /aria-labelledby="metrics-requests-chart-title metrics-requests-chart-description"/);
  assert.match(html, /aria-labelledby="metrics-latency-chart-title metrics-latency-chart-description"/);
  assert.match(html, /<title id="metrics-requests-chart-title"[^>]*>/);
  assert.match(html, /<desc id="metrics-requests-chart-description"[^>]*>/);
  assert.match(html, /<title id="metrics-latency-chart-title"[^>]*>/);
  assert.match(html, /<desc id="metrics-latency-chart-description"[^>]*>/);
  assert.match(html, /data-i18n="metrics-series-total"/);
  assert.match(html, /data-i18n="metrics-series-ttfb"/);
  assert.match(html, /class="metrics-table"/);
  assert.match(html, /data-i18n="metrics-request-bytes"/);
  assert.match(html, /2026-08-17 10:00Z/);
  assert.match(html, /12\.5/);
  assert.match(html, /125\.8/);
});

test('metrics view renders safe empty and unavailable states without invalid SVG numbers', () => {
  const html = render({
    totals: { all: 0, consumption: 0 },
    hourly: [],
    metricsAvailable: false,
    error: '<database unavailable>',
  });

  assert.match(html, /data-i18n="metrics-unavailable"/);
  assert.match(html, /data-i18n="metrics-error"/);
  assert.match(html, /&lt;database unavailable&gt;/);
  assert.equal((html.match(/<svg role="img"/g) ?? []).length, 2);
  assert.match(html, /data-i18n="metrics-no-data"/);
  assert.match(html, /No matching request data for this period/);
  assert.match(html, /colspan="8"/);
  assert.equal(html.includes('NaN'), false);
  assert.equal(html.includes('Infinity'), false);
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

test('dashboard management area links to request metrics', () => {
  const html = dashboardView({
    accounts: [],
    devices: [],
    csrf: 'csrf',
    adminIdentity: 'admin@example.com',
  });

  assert.match(html, /href="\/metrics"/);
  assert.match(html, /data-i18n="metrics-dashboard-link"/);
});
