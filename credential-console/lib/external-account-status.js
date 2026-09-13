/*
 * The public, non-secret view of an external Codex credential home.
 *
 * This lived in server.js until the account-switch guard needed it too. The
 * guard is in the Store, and the Store cannot import server.js (server.js
 * imports the Store), so the reader moved down here and server.js re-exports
 * it. The logic is unchanged; `externalAccountStatus` is still the only way
 * these files are read, so there remains exactly one sanitizer to audit.
 */
import { readFile } from 'node:fs/promises';
import { classifyAccount, safeTimestamp } from './credential-alerts.js';

const SAFE_HEALTH_OUTCOMES = new Set([
  'fresh', 'refreshed', 'recovered', 'refreshing', 'quarantined',
  'pre_mint_rejected', 'timeout', 'persist_failed', 'publish_failed',
  'unreadable', 'unhandled', 'operation_blocked',
]);
const SAFE_HEALTH_FAILURE_CLASSES = new Set([
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

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmptyMetadata(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalHealthTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  return safeTimestamp(value);
}

function optionalHealthNumber(value, { integer = false, nonNegative = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (integer && !Number.isInteger(number)) return null;
  if (nonNegative && number < 0) return null;
  return number;
}

function sanitizeHealthSnapshot(raw) {
  const source = metadataObject(raw);
  if (!source || source.version !== 1) return null;
  const timestampFields = [
    'updated_at',
    'last_cycle_started_at',
    'last_cycle_finished_at',
    'last_success_at',
    'last_refresh_at',
    'last_failure_at',
  ];
  const timestamps = Object.fromEntries(timestampFields.map((field) => [
    field,
    optionalHealthTimestamp(source[field]),
  ]));
  // A present malformed timestamp is a malformed health snapshot. Missing
  // optional canaries remain null and are intentionally harmless.
  if (timestampFields.some((field) => (
    source[field] !== undefined
      && source[field] !== null
      && source[field] !== ''
      && timestamps[field] === null
  ))) return null;

  const expected = optionalHealthNumber(source.expected_interval_seconds, {
    integer: true,
    nonNegative: true,
  });
  if (source.expected_interval_seconds !== undefined
    && source.expected_interval_seconds !== null
    && source.expected_interval_seconds !== ''
    && (expected === null || expected <= 0 || expected > 30 * 24 * 60 * 60)) return null;
  const consecutive = optionalHealthNumber(source.consecutive_failures, {
    integer: true,
    nonNegative: true,
  });
  if (source.consecutive_failures !== undefined
    && source.consecutive_failures !== null
    && source.consecutive_failures !== ''
    && consecutive === null) return null;

  let lastOutcome = null;
  if (source.last_outcome !== undefined && source.last_outcome !== null && source.last_outcome !== '') {
    if (typeof source.last_outcome !== 'string') return null;
    lastOutcome = source.last_outcome.toLowerCase();
    if (!SAFE_HEALTH_OUTCOMES.has(lastOutcome)) return null;
  }
  let failureClass = null;
  if (source.failure_class !== undefined && source.failure_class !== null && source.failure_class !== '') {
    if (typeof source.failure_class !== 'string') return null;
    failureClass = source.failure_class.toLowerCase();
    if (!SAFE_HEALTH_FAILURE_CLASSES.has(failureClass)) return null;
  }

  const quarantineSource = source.quarantine;
  let quarantine = { present: false, since: null };
  if (quarantineSource !== undefined && quarantineSource !== null) {
    const value = metadataObject(quarantineSource);
    if (!value || typeof value.present !== 'boolean') return null;
    const since = optionalHealthTimestamp(value.since);
    if (value.since !== undefined && value.since !== null && value.since !== '' && since === null) return null;
    quarantine = { present: value.present, since: value.present ? since : null };
  }

  let access = null;
  if (source.access !== undefined && source.access !== null) {
    const value = metadataObject(source.access);
    if (!value || typeof value.present !== 'boolean' || typeof value.valid !== 'boolean') return null;
    const expiresAt = optionalHealthTimestamp(value.expires_at);
    if (value.expires_at !== undefined && value.expires_at !== null && value.expires_at !== '' && expiresAt === null) return null;
    const remaining = optionalHealthNumber(value.remaining_seconds, {
      integer: true,
      nonNegative: true,
    });
    if (value.remaining_seconds !== undefined && value.remaining_seconds !== null && value.remaining_seconds !== '' && remaining === null) return null;
    access = {
      present: value.present,
      valid: value.valid,
      expires_at: expiresAt,
      remaining_seconds: remaining,
    };
  }

  return {
    version: 1,
    ...timestamps,
    expected_interval_seconds: expected,
    last_outcome: lastOutcome,
    failure_class: failureClass,
    consecutive_failures: consecutive,
    quarantine,
    access,
  };
}

async function readPublicJson(path) {
  let body;
  try {
    body = await readFile(path, 'utf8');
  } catch (error) {
    // Keep filesystem details (including paths and permission messages) inside
    // the server log boundary. The dashboard only needs a stable category.
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unavailable', value: null };
  }
  try {
    return { status: 'ok', value: JSON.parse(body) };
  } catch {
    return { status: 'invalid', value: null };
  }
}

/**
 * Read the two public Codex metadata files without ever returning their
 * credential values. current.json is authoritative for expiry; health.json is
 * an observability snapshot and is sanitized field-by-field before it reaches
 * the classifier or a view.
 */
export async function externalAccountStatus(account, { now = Date.now() } = {}) {
  if (account?.external?.kind !== 'codex-credential') return {};
  const parsedNow = typeof now === 'number' && Number.isFinite(now)
    ? now
    : Date.parse(String(now ?? ''));
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const home = account.external.home;
  const currentRead = await readPublicJson(`${home}/public/current.json`);
  const healthRead = await readPublicJson(`${home}/public/health.json`);
  const health = healthRead.status === 'ok' ? sanitizeHealthSnapshot(healthRead.value) : null;
  const healthStatus = healthRead.status === 'ok'
    ? (health ? 'ok' : 'invalid')
    : healthRead.status;

  let currentStatus;
  let expiresAt = null;
  if (currentRead.status !== 'ok') {
    currentStatus = currentRead.status === 'missing' ? 'unavailable' : currentRead.status;
  } else {
    const current = metadataObject(currentRead.value);
    const currentExpiresAt = safeTimestamp(current?.expires_at);
    const valid = current
      && nonEmptyMetadata(current.access_token)
      && nonEmptyMetadata(current.account_id)
      && currentExpiresAt !== null;
    if (!valid) currentStatus = 'invalid';
    else {
      expiresAt = currentExpiresAt;
      currentStatus = Date.parse(currentExpiresAt) <= nowMs ? 'expired' : 'healthy';
    }
  }

  let clientCount = null;
  const clientsRead = await readPublicJson(`${home}/clients/clients.json`);
  if (clientsRead.status === 'ok') {
    const clients = metadataObject(clientsRead.value)?.clients;
    if (Array.isArray(clients)) {
      clientCount = clients.filter((client) => metadataObject(client) && !client.revoked).length;
    }
  }

  return {
    status: currentStatus,
    current_status: currentStatus,
    external_status: currentStatus,
    current_read_status: currentRead.status,
    health_read_status: healthStatus,
    refresh_health: health,
    health_status: healthStatus,
    expires_at: expiresAt,
    active_devices: clientCount,
    refresh_health_status: healthStatus,
    health_read_status: healthStatus,
    // Only timestamps and fixed enums leave this function. In particular there
    // is no access token, account id, exception text, or filesystem path here.
    ...(health ? {
      last_success_at: health.last_success_at,
      last_refresh_at: health.last_refresh_at,
      last_failure_at: health.last_failure_at,
    } : {}),
  };
}

/**
 * The alert codes that make an account an invalid switch target.
 *
 * Every entry means "the credential behind this account is already broken, or
 * is certain to break before anything can renew it". A device pointed at such
 * an account gets a 503 from the proxy on its very next request, which is what
 * this list exists to prevent.
 *
 * Three families of critical code are deliberately absent:
 *
 * - `current_invalid` / `current_unavailable` say the console could not read
 *   the home, not that the credential is bad. The recommended systemd
 *   hardening can legitimately put a home out of reach, and failing closed on
 *   a read error would make those accounts permanently unselectable.
 * - `health_*` codes are read problems too, and are warnings rather than
 *   critical in the classifier. A freshly authorized account has no
 *   health.json until its first refresh cycle and must stay selectable.
 * - `account_unhealthy` derives from the cached `status` column, which is the
 *   very field this guard exists to stop trusting: the proxy only updates it
 *   on requests that reach upstream, so an expired credential rejected at the
 *   gateway leaves it reading `healthy` forever.
 */
export const SWITCH_BLOCKING_ALERT_CODES = Object.freeze(new Set([
  'refresh_quarantined',
  'access_expired',
  'access_expires_24h',
  'credential_unavailable',
  'refresh_stuck',
  'refresh_failed',
  'quarantine',
  'provider_rejected',
  'persist_failed',
  'publish_failed',
  'unreadable',
  'unhandled',
  'operation_blocked',
  'configuration_invalid',
  'timeout',
]));

/**
 * Decide whether an account is too broken to become a device's selected
 * account, using the same classifier the dashboard renders from.
 *
 * Returns `null` when the switch may proceed, or `{ code }` naming the
 * blocking condition. The code always comes from the classifier's fixed
 * vocabulary, so it is safe to put in an error message: it can never carry a
 * path, an exception, or a credential.
 *
 * @param {object} account   the stored account row
 * @param {object} status    the result of `externalAccountStatus(account)`
 */
export function credentialSwitchBlock(account, status, { now = Date.now() } = {}) {
  // Only Codex publishes a refresh health surface. Claude and Bedrock hold a
  // static credential in the store and are already fully judged by the Store's
  // own synchronous checks.
  if (account?.provider !== 'codex') return null;
  const parsedNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const verdict = classifyAccount({ ...account, ...status }, parsedNow, 0);
  if (verdict.severity !== 'critical') return null;
  const blocking = verdict.codes.find((code) => SWITCH_BLOCKING_ALERT_CODES.has(code));
  return blocking ? { code: blocking } : null;
}
