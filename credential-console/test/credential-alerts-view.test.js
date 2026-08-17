import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dashboardView } from '../lib/views.js';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

function render(accounts) {
  return dashboardView({
    accounts,
    devices: [],
    machines: [],
    codexClients: [],
    csrf: 'view-csrf',
    openMode: true,
    now: NOW,
  });
}

function codex(alias, overrides = {}) {
  return {
    id: `${alias}-id`,
    alias,
    provider: 'codex',
    status: 'healthy',
    current_status: 'healthy',
    expires_at: new Date(NOW + 30 * 86400_000).toISOString(),
    refresh_health: {
      version: 1,
      updated_at: new Date(NOW - 60_000).toISOString(),
      expected_interval_seconds: 3600,
      last_outcome: 'fresh',
      quarantine: { present: false },
    },
    ...overrides,
  };
}

test('no account and healthy/pending dashboards do not render alert fatigue', () => {
  for (const accounts of [
    [],
    [codex('healthy')],
    [{ id: 'pending-id', alias: 'pending', provider: 'codex', status: 'pending' }],
  ]) {
    const html = render(accounts);
    assert.equal((html.match(/<section class="card credential-alert-summary/g) ?? []).length, 0);
  }
});

test('critical first-screen summary is capped at three and account rows show safe history', () => {
  const html = render([
    codex('invalid', { current_status: 'invalid', expires_at: null }),
    codex('unavailable', { current_status: 'unavailable', expires_at: null }),
    codex('expired', { expires_at: new Date(NOW - 1).toISOString() }),
    {
      id: 'claude-warning-id',
      alias: 'claude-warning',
      provider: 'claude',
      status: 'stored',
      expires_at: new Date(NOW + 3 * 86400_000).toISOString(),
      last_success_at: new Date(NOW - 5 * 60_000).toISOString(),
      last_refresh_at: new Date(NOW - 10 * 60_000).toISOString(),
      last_failure: '/secret/provider/path should not render',
    },
  ]);
  assert.equal((html.match(/class="credential-alert-item"/g) ?? []).length, 3);
  assert.match(html, /role="alert" aria-live="assertive"/);
  assert.match(html, /credential-alert-current-invalid/);
  assert.match(html, /credential-alert-current-unavailable/);
  assert.match(html, /Expires in/);
  assert.match(html, /Last successful credential check/);
  assert.match(html, /Last rotation/);
  assert.equal(html.includes('/secret/provider/path should not render'), false);
  assert.equal(html.includes('account-id'), false);
  assert.equal(html.includes('access_token'), false);
});

test('warning-only summary uses polite status semantics and action text stays translated', async () => {
  const html = render([codex('stale', {
    refresh_health: {
      version: 1,
      updated_at: new Date(NOW - 3 * 86400_000).toISOString(),
      expected_interval_seconds: 3600,
      last_outcome: 'fresh',
    },
  })]);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /credential-alert-health-stale/);
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const viewSource = await readFile(new URL('../lib/views.js', import.meta.url), 'utf8');
  for (const key of [
    'credential-health-heading',
    'credential-alert-health-stale',
    'credential-alert-current-invalid',
    'last-successful-check',
    'last-rotation',
  ]) {
    assert.match(source, new RegExp(`'${key}':`));
  }
  assert.match(viewSource, /max-width: 800px/);
});
