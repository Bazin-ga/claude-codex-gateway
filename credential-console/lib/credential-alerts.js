/*
 * The dashboard deliberately classifies credentials from a small, public
 * metadata surface.  This module is kept independent from the HTTP server so
 * that the rules can be exercised without creating a credential home (and so
 * that a future API cannot accidentally render an exception or a secret).
 */

export const MAX_CREDENTIAL_ALERTS = 3;
export const HEALTH_FALLBACK_STALE_MS = 36 * 60 * 60 * 1000;
export const HEALTH_MIN_STALE_MS = 15 * 60 * 1000;
export const HEALTH_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_STUCK_MS = 15 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const CREDENTIAL_ALERT_SEVERITIES = Object.freeze([
  'critical',
  'warning',
  'neutral',
  'ok',
]);

const SEVERITY_RANK = Object.freeze({ ok: 0, neutral: 1, warning: 2, critical: 3 });
const HEALTH_STATUSES = new Set(['healthy', 'refreshing', 'failed', 'quarantined']);
const ACTIVE_OUTCOMES = new Set(['refreshing']);
const FAILED_OUTCOMES = new Set([
  'quarantined',
  'pre_mint_rejected',
  'timeout',
  'persist_failed',
  'publish_failed',
  'unreadable',
  'unhandled',
  'operation_blocked',
]);
const SUCCESS_OUTCOMES = new Set([
  'fresh',
  'refreshed',
  'recovered',
]);

// Failure classes are copied from the health contract rather than displayed
// verbatim.  In particular, an operator-controlled path or an exception message
// must never become an HTML string through this boundary.
const SAFE_FAILURE_CLASSES = new Set([
  'quarantine',
  'provider_rejected',
  'persist_failed',
  'publish_failed',
  'unreadable',
  'unhandled',
  'operation_blocked',
  'configuration_invalid',
  'timeout',
]);

const FIXED_CRITICAL_FAILURE_CLASSES = new Set([
  'quarantine',
  'provider_rejected',
  'timeout',
  'persist_failed',
  'publish_failed',
  'unreadable',
  'unhandled',
  'operation_blocked',
  'configuration_invalid',
]);

function numericTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeTimestamp(value) {
  const parsed = numericTime(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function nowMs(value) {
  return numericTime(value) ?? Date.now();
}

function severityMax(left, right) {
  return SEVERITY_RANK[right] > SEVERITY_RANK[left] ? right : left;
}

function issue(severity, code) {
  return Object.freeze({ severity, code });
}

function safeFailureClass(value) {
  return SAFE_FAILURE_CLASSES.has(value) ? value : null;
}

function validObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function healthVersion(health) {
  return validObject(health)?.version === 1 ? 1 : null;
}

function healthAccess(health) {
  return validObject(validObject(health)?.access);
}

function healthQuarantine(health) {
  const quarantine = validObject(validObject(health)?.quarantine);
  return quarantine?.present === true;
}

function healthStatus(health) {
  const value = String(validObject(health)?.status ?? '').toLowerCase();
  if (HEALTH_STATUSES.has(value)) return value;
  if (healthQuarantine(health)) return 'quarantined';

  const started = numericTime(health?.last_cycle_started_at);
  const finished = numericTime(health?.last_cycle_finished_at);
  if (started !== null && (finished === null || finished < started)) return 'refreshing';

  const outcome = String(health?.last_outcome ?? '').toLowerCase();
  if (['quarantined', 'quarantine'].includes(outcome)) return 'quarantined';
  if (FAILED_OUTCOMES.has(outcome)) return 'failed';
  if (ACTIVE_OUTCOMES.has(outcome)) return 'refreshing';
  if (SUCCESS_OUTCOMES.has(outcome)) return 'healthy';
  return null;
}

function healthCheckedAt(health) {
  const source = validObject(health);
  // updated_at is the snapshot timestamp.  The cycle-finished fallback is
  // useful for old version-1 snapshots that predate that field, but never use a
  // failure message or an arbitrary value as a timestamp.
  return numericTime(source?.updated_at)
    ?? numericTime(source?.last_cycle_finished_at);
}

export function staleThresholdMs(health) {
  const seconds = Number(validObject(health)?.expected_interval_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return HEALTH_FALLBACK_STALE_MS;
  return Math.min(
    HEALTH_MAX_STALE_MS,
    Math.max(HEALTH_MIN_STALE_MS, seconds * 2.5 * 1000),
  );
}

function healthExpiry(health) {
  return numericTime(healthAccess(health)?.expires_at);
}

function currentStatus(account) {
  const explicit = account?.current_status ?? account?.external_status;
  return typeof explicit === 'string' ? explicit : null;
}

function expiryFor(account) {
  // For Codex, current.json is the live public credential.  A health snapshot
  // may be delayed and therefore must never replace a valid current expiry.
  const current = currentStatus(account);
  if (account?.provider === 'codex' && current) {
    return numericTime(account.expires_at);
  }
  return numericTime(account?.expires_at)
    ?? (account?.provider === 'codex' ? healthExpiry(account?.refresh_health) : null);
}

function expiryIssue(account, now, expiresAt) {
  if (expiresAt === null) return null;
  const remaining = expiresAt - now;
  if (remaining <= 0) return issue('critical', 'access_expired');
  if (account.provider === 'codex') {
    if (remaining <= DAY_MS) return issue('critical', 'access_expires_24h');
    if (remaining <= 3 * DAY_MS) return issue('warning', 'access_expires_3d');
  } else {
    if (remaining <= DAY_MS) return issue('critical', 'access_expires_24h');
    if (remaining <= 7 * DAY_MS) return issue('warning', 'access_expires_7d');
  }
  return null;
}

function currentIssue(account) {
  const current = currentStatus(account);
  if (account.provider !== 'codex') return null;
  if (current === 'invalid') return issue('critical', 'current_invalid');
  if (current === 'unavailable') return issue('critical', 'current_unavailable');
  return null;
}

function healthReadIssue(account, health) {
  if (account.status === 'login_required' || account.status === 'pending') {
    return issue('neutral', account.status);
  }
  const readStatus = account.refresh_health_status ?? account.health_status;
  if (readStatus === 'unavailable') return issue('warning', 'health_unavailable');
  if (readStatus === 'missing') return issue('warning', 'health_missing');
  if (readStatus === 'invalid') return issue('warning', 'health_invalid');
  if (account.provider !== 'codex' && !health) return null;
  if (!validObject(health) || healthVersion(health) !== 1) {
    return issue('warning', validObject(health) ? 'health_invalid' : 'health_missing');
  }
  return null;
}

function healthIssues(account, now, health) {
  const readIssue = healthReadIssue(account, health);
  if (readIssue) return [readIssue];
  if (!validObject(health) || healthVersion(health) !== 1) return [];

  // A future cycle timestamp must not hold the dashboard in a permanently
  // neutral "refreshing" state. Allow only small wall-clock skew.
  for (const value of [
    health.updated_at,
    health.last_cycle_started_at,
    health.last_cycle_finished_at,
  ]) {
    const parsed = numericTime(value);
    if (parsed !== null && parsed > now + 5 * 60 * 1000) {
      return [issue('warning', 'health_invalid')];
    }
  }

  const issues = [];
  const quarantine = healthQuarantine(health);
  const access = healthAccess(health);
  const failureClass = safeFailureClass(health.failure_class);
  const outcome = String(health.last_outcome ?? '').toLowerCase();
  const status = healthStatus(health);

  if (quarantine) issues.push(issue('critical', 'refresh_quarantined'));
  if (failureClass && FIXED_CRITICAL_FAILURE_CLASSES.has(failureClass)) {
    issues.push(issue('critical', failureClass));
  }
  if (FAILED_OUTCOMES.has(outcome) || status === 'failed') {
    // A failure_class is safe only when it belongs to the fixed vocabulary. An
    // unknown class becomes a generic, non-secret code.
    issues.push(issue('critical', failureClass ?? 'refresh_failed'));
  }

  if (!HEALTH_STATUSES.has(status)) {
    if (!issues.length) issues.push(issue('warning', 'health_invalid'));
    return issues;
  }

  if (status === 'quarantined') {
    if (!quarantine) issues.push(issue('critical', 'refresh_quarantined'));
  } else if (status === 'refreshing') {
    const started = numericTime(health.last_cycle_started_at);
    const duration = started === null ? Number.POSITIVE_INFINITY : now - started;
    issues.push(duration > REFRESH_STUCK_MS
      ? issue('critical', 'refresh_stuck')
      : issue('neutral', 'refreshing'));
  } else if (status === 'healthy') {
    const checkedAt = healthCheckedAt(health);
    const stale = checkedAt === null || now - checkedAt > staleThresholdMs(health);
    if (stale) issues.push(issue('warning', checkedAt === null ? 'health_missing' : 'health_stale'));
    else if (access && (access.present === false || access.valid === false)) {
      issues.push(issue('critical', 'credential_unavailable'));
    } else if (!issues.length) issues.push(issue('ok', 'healthy'));
  }
  return issues;
}

function classifyAccount(account, now, index) {
  const source = validObject(account) ?? {};
  const provider = source.provider === 'codex' ? 'codex' : 'claude';
  const status = typeof source.status === 'string' ? source.status : null;
  const expiresAtMs = expiryFor({ ...source, provider });

  // Unauthorised and not-yet-created accounts are expected states. Keep them
  // neutral even though their public Codex files do not exist yet.
  const loginLike = status === 'login_required' || status === 'pending';
  const issues = loginLike
    ? [issue('neutral', status)]
    : [
      currentIssue({ ...source, provider }),
      expiryIssue({ ...source, provider }, now, expiresAtMs),
      ...healthIssues({ ...source, provider }, now, source.refresh_health),
    ].filter(Boolean);

  if (!loginLike && status === 'unhealthy'
    && !issues.some((entry) => entry.severity === 'critical')) {
    issues.push(issue('critical', 'account_unhealthy'));
  }
  const severity = issues.reduce((current, entry) => severityMax(current, entry.severity), 'ok');
  const codes = [...new Set(
    issues.filter((entry) => entry.severity === severity).map((entry) => entry.code),
  )];
  const expiresAt = expiresAtMs === null ? null : new Date(expiresAtMs).toISOString();
  const result = {
    // The id is retained for server-side correlation only. Views intentionally
    // never print it; no token or filesystem value is copied into this object.
    accountId: typeof source.id === 'string' ? source.id : null,
    alias: typeof source.alias === 'string' ? source.alias : '',
    provider,
    status,
    currentStatus: currentStatus(source),
    severity,
    code: codes[0] ?? 'healthy',
    codes: Object.freeze(codes.length ? codes : ['healthy']),
    expiresAt,
    expiresInMs: expiresAtMs === null ? null : expiresAtMs - now,
    checkedAt: safeTimestamp(source.refresh_health?.updated_at
      ?? source.refresh_health?.last_cycle_finished_at),
    lastSuccessAt: safeTimestamp(source.refresh_health?.last_success_at
      ?? (provider === 'claude' ? source.last_success_at : null)),
    lastRotationAt: safeTimestamp(source.refresh_health?.last_refresh_at
      ?? source.last_refresh_at),
    refreshHealthStatus: healthStatus(source.refresh_health),
    index,
  };
  return Object.freeze(result);
}

export function classifyCredentialAlerts(accounts, { now = Date.now() } = {}) {
  const normalizedNow = nowMs(now);
  const results = (Array.isArray(accounts) ? accounts : []).map((account, index) => (
    classifyAccount(account, normalizedNow, index)
  ));
  const actionable = results.filter((entry) => (
    entry.severity === 'critical' || entry.severity === 'warning'
  ));
  // Critical rows always lead the first-screen summary; within a severity the
  // account order remains stable and deterministic.
  const ordered = [...actionable].sort((left, right) => (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] || left.index - right.index
  ));
  return Object.freeze({
    accounts: Object.freeze(results),
    summary: Object.freeze(ordered.slice(0, MAX_CREDENTIAL_ALERTS)),
    summaryTotal: actionable.length,
    summaryTruncated: actionable.length > MAX_CREDENTIAL_ALERTS,
    criticalCount: results.filter((entry) => entry.severity === 'critical').length,
    warningCount: results.filter((entry) => entry.severity === 'warning').length,
  });
}

export { classifyAccount };
