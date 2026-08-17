import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCredentialAlerts,
  DAY_MS,
  HEALTH_FALLBACK_STALE_MS,
  HEALTH_MAX_STALE_MS,
  HEALTH_MIN_STALE_MS,
  MAX_CREDENTIAL_ALERTS,
  staleThresholdMs,
} from '../lib/credential-alerts.js';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

function health(overrides = {}) {
  return {
    version: 1,
    updated_at: new Date(NOW - 60_000).toISOString(),
    expected_interval_seconds: 60 * 60,
    last_cycle_started_at: new Date(NOW - 120_000).toISOString(),
    last_cycle_finished_at: new Date(NOW - 60_000).toISOString(),
    last_outcome: 'fresh',
    last_success_at: new Date(NOW - 60_000).toISOString(),
    last_refresh_at: new Date(NOW - 60_000).toISOString(),
    last_failure_at: null,
    failure_class: null,
    consecutive_failures: 0,
    quarantine: { present: false, since: null },
    access: {
      present: true,
      valid: true,
      expires_at: new Date(NOW + 30 * 24 * 60 * 60_000).toISOString(),
      remaining_seconds: 30 * 24 * 60 * 60,
    },
    ...overrides,
  };
}

function codex(overrides = {}) {
  return {
    id: 'codex-account-id',
    alias: 'codex-main',
    provider: 'codex',
    status: 'healthy',
    current_status: 'healthy',
    expires_at: new Date(NOW + 30 * 24 * 60 * 60_000).toISOString(),
    refresh_health: health(),
    ...overrides,
  };
}

test('healthy Codex and Claude accounts remain OK outside expiry windows', () => {
  const result = classifyCredentialAlerts([
    codex(),
    {
      id: 'claude-account-id',
      alias: 'claude-main',
      provider: 'claude',
      status: 'stored',
      expires_at: new Date(NOW + 30 * 24 * 60 * 60_000).toISOString(),
      last_success_at: new Date(NOW - 60_000).toISOString(),
    },
  ], { now: NOW });
  assert.deepEqual(result.accounts.map(({ severity }) => severity), ['ok', 'ok']);
  assert.equal(result.summary.length, 0);
});

test('provider-specific expiry thresholds and expired state are actionable', () => {
  const result = classifyCredentialAlerts([
    codex({ expires_at: new Date(NOW + 3 * 24 * 60 * 60_000).toISOString() }),
    {
      alias: 'claude-warning',
      provider: 'claude',
      status: 'stored',
      expires_at: new Date(NOW + 7 * 24 * 60 * 60_000).toISOString(),
    },
    {
      alias: 'claude-expired',
      provider: 'claude',
      status: 'stored',
      expires_at: new Date(NOW - 1).toISOString(),
    },
  ], { now: NOW });
  assert.equal(result.accounts[0].code, 'access_expires_3d');
  assert.equal(result.accounts[0].severity, 'warning');
  assert.equal(result.accounts[1].code, 'access_expires_7d');
  assert.equal(result.accounts[2].code, 'access_expired');
  assert.equal(result.accounts[2].severity, 'critical');
});

test('current metadata invalid or unavailable is critical even when health is future-dated', () => {
  const invalid = classifyCredentialAlerts([codex({
    current_status: 'invalid',
    expires_at: null,
    refresh_health: health({
      updated_at: new Date(NOW + 60_000).toISOString(),
      access: { present: true, valid: true, expires_at: new Date(NOW + 20 * DAY_MS).toISOString() },
    }),
  })], { now: NOW });
  const unavailable = classifyCredentialAlerts([codex({
    current_status: 'unavailable',
    expires_at: null,
    refresh_health: health(),
  })], { now: NOW });
  assert.equal(invalid.accounts[0].code, 'current_invalid');
  assert.equal(invalid.accounts[0].severity, 'critical');
  assert.equal(unavailable.accounts[0].code, 'current_unavailable');
  assert.equal(unavailable.accounts[0].severity, 'critical');
});

test('missing, invalid, and stale health are safe warnings without leaking values', () => {
  const result = classifyCredentialAlerts([
    codex({ refresh_health_status: 'missing', refresh_health: null }),
    codex({ refresh_health_status: 'invalid', refresh_health: null }),
    codex({ refresh_health: health({ updated_at: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString() }) }),
  ], { now: NOW });
  assert.deepEqual(result.accounts.map(({ severity }) => severity), ['warning', 'warning', 'warning']);
  assert.deepEqual(result.accounts.map(({ code }) => code), ['health_missing', 'health_invalid', 'health_stale']);
  assert.equal(JSON.stringify(result).includes('credential-account-id'), false);
});

test('active refreshes are neutral for 15 minutes and critical after that', () => {
  const recent = classifyCredentialAlerts([codex({
    refresh_health: health({
      last_outcome: 'refreshing',
      last_cycle_started_at: new Date(NOW - 15 * 60_000).toISOString(),
      last_cycle_finished_at: null,
    }),
  })], { now: NOW });
  const stuck = classifyCredentialAlerts([codex({
    refresh_health: health({
      last_outcome: 'refreshing',
      last_cycle_started_at: new Date(NOW - 15 * 60_000 - 1).toISOString(),
      last_cycle_finished_at: null,
    }),
  })], { now: NOW });
  assert.equal(recent.accounts[0].severity, 'neutral');
  assert.equal(recent.accounts[0].code, 'refreshing');
  assert.equal(stuck.accounts[0].severity, 'critical');
  assert.equal(stuck.accounts[0].code, 'refresh_stuck');
});

test('future cycle timestamps are invalid, not indefinitely neutral', () => {
  const result = classifyCredentialAlerts([codex({
    refresh_health: health({
      updated_at: new Date(NOW + 60 * 60_000).toISOString(),
      last_cycle_started_at: new Date(NOW + 60 * 60_000).toISOString(),
      last_cycle_finished_at: null,
      last_outcome: 'refreshing',
    }),
  })], { now: NOW });
  assert.equal(result.accounts[0].severity, 'warning');
  assert.equal(result.accounts[0].code, 'health_invalid');
});

test('fixed refresh failures and quarantine remain critical, while recovery clears them', () => {
  const failed = classifyCredentialAlerts([codex({
    refresh_health: health({
      last_outcome: 'publish_failed',
      failure_class: 'publish_failed',
      quarantine: { present: true, since: new Date(NOW - 1000).toISOString() },
    }),
  })], { now: NOW });
  const recovered = classifyCredentialAlerts([codex({
    refresh_health: health({
      last_outcome: 'fresh',
      failure_class: null,
      quarantine: { present: false, since: null },
    }),
  })], { now: NOW });
  assert.equal(failed.accounts[0].severity, 'critical');
  assert.ok(failed.accounts[0].codes.includes('refresh_quarantined'));
  assert.equal(recovered.accounts[0].severity, 'ok');
});

test('refresh-center outcome canaries are classified without treating them as malformed', () => {
  for (const outcome of ['fresh', 'refreshed', 'recovered']) {
    const healthy = classifyCredentialAlerts([codex({
      refresh_health: health({ last_outcome: outcome }),
    })], { now: NOW });
    assert.equal(healthy.accounts[0].severity, 'ok', outcome);
  }
  for (const outcome of [
    'quarantined',
    'pre_mint_rejected',
    'timeout',
    'persist_failed',
    'publish_failed',
    'unreadable',
    'unhandled',
    'operation_blocked',
  ]) {
    const failed = classifyCredentialAlerts([codex({
      refresh_health: health({ last_outcome: outcome }),
    })], { now: NOW });
    assert.equal(failed.accounts[0].severity, 'critical', outcome);
  }
  for (const failureClass of [
    'quarantine',
    'provider_rejected',
    'timeout',
    'persist_failed',
    'publish_failed',
    'unreadable',
    'unhandled',
    'operation_blocked',
    'configuration_invalid',
  ]) {
    const failed = classifyCredentialAlerts([codex({
      refresh_health: health({ last_outcome: 'unhandled', failure_class: failureClass }),
    })], { now: NOW });
    assert.equal(failed.accounts[0].severity, 'critical', failureClass);
  }
});

test('optional health canaries may be absent and login/pending have neutral status', () => {
  const canaryless = classifyCredentialAlerts([codex({
    refresh_health: {
      version: 1,
      updated_at: new Date(NOW - 60_000).toISOString(),
      expected_interval_seconds: 3600,
      last_outcome: 'fresh',
    },
  })], { now: NOW });
  const pending = classifyCredentialAlerts([
    { alias: 'new-codex', provider: 'codex', status: 'pending', current_status: 'unavailable' },
    { alias: 'new-claude', provider: 'claude', status: 'login_required' },
  ], { now: NOW });
  assert.equal(canaryless.accounts[0].severity, 'ok');
  assert.deepEqual(pending.accounts.map(({ severity, code }) => [severity, code]), [
    ['neutral', 'pending'],
    ['neutral', 'login_required'],
  ]);
});

test('summary is capped at three and stale threshold uses documented clamps', () => {
  const result = classifyCredentialAlerts([
    codex({ current_status: 'invalid', expires_at: null }),
    codex({ current_status: 'unavailable', expires_at: null }),
    codex({ expires_at: new Date(NOW - 1).toISOString() }),
    { alias: 'claude-expired', provider: 'claude', status: 'stored', expires_at: new Date(NOW - 1).toISOString() },
  ], { now: NOW });
  assert.equal(result.summary.length, MAX_CREDENTIAL_ALERTS);
  assert.equal(result.summaryTotal, 4);
  assert.equal(result.summaryTruncated, true);
  assert.equal(staleThresholdMs({ expected_interval_seconds: 1 }), HEALTH_MIN_STALE_MS);
  assert.equal(staleThresholdMs({ expected_interval_seconds: 365 * 24 * 3600 }), HEALTH_MAX_STALE_MS);
  assert.equal(staleThresholdMs({}), HEALTH_FALLBACK_STALE_MS);
});
