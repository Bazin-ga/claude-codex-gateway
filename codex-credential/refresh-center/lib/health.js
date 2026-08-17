import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from './credential-store.js';

/**
 * Public refresh-center health is deliberately a different record from the
 * credential publication.  It contains enough state for an operator to tell a
 * live access token from a live refresh chain, but it never contains a token,
 * account identifier, digest, path, or provider error text.
 */

export const HEALTH_VERSION = 1;
export const PUBLIC_HEALTH_MODE = 0o640;
export const DEFAULT_EXPECTED_INTERVAL_SECONDS = 24 * 60 * 60;
export const MAX_EXPECTED_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

export const HEALTH_OUTCOMES = Object.freeze([
  'refreshing',
  'fresh',
  'refreshed',
  'recovered',
  'quarantined',
  'pre_mint_rejected',
  'timeout',
  'persist_failed',
  'publish_failed',
  'unreadable',
  'unhandled',
  'operation_blocked',
]);

const SUCCESS_OUTCOMES = new Set(['fresh', 'refreshed', 'recovered']);
const FAILURE_CLASSES = new Set([
  'configuration_invalid',
  'quarantine',
  'provider_rejected',
  'timeout',
  'persist_failed',
  'publish_failed',
  'unreadable',
  'unhandled',
  'operation_blocked',
]);

/**
 * The cadence is used only as an observability hint by readers of health.json.
 * Keep it finite and bounded so a malformed environment cannot make a stale
 * heartbeat appear fresh forever or overflow a downstream calculation.
 */
export function validateExpectedIntervalSeconds(value) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error('CODEX_CRED_REFRESH_EXPECTED_INTERVAL_SECONDS must be a finite positive number');
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)
    || numeric <= 0
    || numeric > MAX_EXPECTED_INTERVAL_SECONDS) {
    throw new Error(
      `expected refresh interval must be finite, positive, and <= ${MAX_EXPECTED_INTERVAL_SECONDS} seconds`,
    );
  }
  return numeric;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function finiteNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return fallback;
  return numeric;
}

function normalizeQuarantine(value, fallback = { present: false, since: null }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const present = value.present === true;
  return {
    present,
    since: present ? timestamp(value.since) : null,
  };
}

function normalizeAccess(value, fallback = {
  present: false,
  valid: false,
  expires_at: null,
  remaining_seconds: null,
}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const present = value.present === true;
  const expiresAt = timestamp(value.expires_at);
  const remaining = value.remaining_seconds === null || value.remaining_seconds === undefined
    ? null
    : finiteNonNegativeInteger(value.remaining_seconds, null);
  return {
    present,
    valid: present && value.valid === true,
    expires_at: expiresAt,
    remaining_seconds: remaining,
  };
}

function emptySnapshot(expectedIntervalSeconds) {
  return {
    version: HEALTH_VERSION,
    updated_at: null,
    expected_interval_seconds: expectedIntervalSeconds,
    last_cycle_started_at: null,
    last_cycle_finished_at: null,
    last_outcome: null,
    last_success_at: null,
    last_refresh_at: null,
    last_failure_at: null,
    failure_class: null,
    consecutive_failures: 0,
    quarantine: { present: false, since: null },
    access: {
      present: false,
      valid: false,
      expires_at: null,
      remaining_seconds: null,
    },
  };
}

/**
 * Keep exactly the public schema even when an old or hand-edited health file
 * contains extra properties.  This is also the canary boundary: callers may
 * pass a credential object to accessMetadata(), but no such object reaches
 * this function or the serialized record.
 */
export function sanitizeHealthSnapshot(value, expectedIntervalSeconds) {
  const snapshot = emptySnapshot(expectedIntervalSeconds);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return snapshot;

  snapshot.updated_at = timestamp(value.updated_at);
  snapshot.last_cycle_started_at = timestamp(value.last_cycle_started_at);
  snapshot.last_cycle_finished_at = timestamp(value.last_cycle_finished_at);
  snapshot.last_outcome = HEALTH_OUTCOMES.includes(value.last_outcome)
    ? value.last_outcome
    : null;
  snapshot.last_success_at = timestamp(value.last_success_at);
  snapshot.last_refresh_at = timestamp(value.last_refresh_at);
  snapshot.last_failure_at = timestamp(value.last_failure_at);
  snapshot.failure_class = FAILURE_CLASSES.has(value.failure_class)
    ? value.failure_class
    : null;
  snapshot.consecutive_failures = finiteNonNegativeInteger(value.consecutive_failures);
  snapshot.quarantine = normalizeQuarantine(value.quarantine);
  snapshot.access = normalizeAccess(value.access);
  return snapshot;
}

/**
 * Convert credential state into non-secret access metadata.  `expiresAt` is
 * supplied by the caller because the refresh center already parsed the JWT;
 * this function never needs to inspect or persist the token itself.
 */
export function accessMetadata(credential, expiresAt, now = Date.now()) {
  const present = typeof credential?.tokens?.access_token === 'string'
    && credential.tokens.access_token.length > 0;
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt ?? NaN);
  const expiryMs = expiry.getTime();
  const hasExpiry = Number.isFinite(expiryMs);
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return {
    present,
    valid: present && hasExpiry && expiryMs > nowMs,
    expires_at: hasExpiry ? expiry.toISOString() : null,
    remaining_seconds: hasExpiry
      ? Math.max(0, Math.floor((expiryMs - nowMs) / 1000))
      : null,
  };
}

/** Convert an in-flight marker into the public quarantine shape. */
export function quarantineMetadata(marker, fallbackSince = null) {
  const present = marker === true || (marker && typeof marker === 'object');
  if (!present) return { present: false, since: null };
  const since = timestamp(
    marker && typeof marker === 'object' ? marker.started_at : fallbackSince,
  ) ?? timestamp(fallbackSince);
  return { present: true, since };
}

function normalizeFailureClass(value, outcome) {
  if (FAILURE_CLASSES.has(value)) return value;
  if (outcome === 'pre_mint_rejected') return 'provider_rejected';
  if (outcome === 'quarantined') return 'quarantine';
  if (FAILURE_CLASSES.has(outcome)) return outcome;
  return 'unhandled';
}

/**
 * Best-effort writer for public/health.json.  A write failure is intentionally
 * represented by `false`, never thrown: the credential refresh result is more
 * important than this observability side channel.
 */
export class HealthPublisher {
  /**
   * @param {object|string} storeOrOptions A CredentialStore, a health path, or
   *   `{healthPath, expectedIntervalSeconds, writeImpl, readImpl, logger}`.
   * @param {object} [options] Optional overrides when the first argument is a
   *   store or path.
   */
  constructor(storeOrOptions = {}, options = {}) {
    const source = typeof storeOrOptions === 'string'
      ? { healthPath: storeOrOptions, ...options }
      : {
        ...(storeOrOptions ?? {}),
        ...options,
        healthPath: options.healthPath ?? storeOrOptions?.healthPath,
      };
    if (!source.healthPath) throw new Error('health path is required');
    this.healthPath = source.healthPath;
    this.expectedIntervalSeconds = validateExpectedIntervalSeconds(
      source.expectedIntervalSeconds ?? DEFAULT_EXPECTED_INTERVAL_SECONDS,
    );
    this.readImpl = source.readImpl ?? readFile;
    this.writeImpl = source.writeImpl ?? writeFileAtomic;
    this.logger = source.logger ?? ((message) => console.error(message));
  }

  async start({ access, quarantine } = {}) {
    const previous = await this.#read();
    const now = new Date().toISOString();
    const next = sanitizeHealthSnapshot(previous, this.expectedIntervalSeconds);
    next.updated_at = now;
    next.last_cycle_started_at = now;
    next.last_outcome = 'refreshing';
    if (access !== undefined) next.access = normalizeAccess(access, next.access);
    if (quarantine !== undefined) next.quarantine = normalizeQuarantine(quarantine, next.quarantine);
    return this.#write(next);
  }

  async terminal(outcome, {
    access,
    quarantine,
    failureClass,
    lastRefreshAt,
  } = {}) {
    if (!HEALTH_OUTCOMES.includes(outcome) || outcome === 'refreshing') {
      throw new Error(`invalid terminal health outcome: ${outcome}`);
    }
    const previous = await this.#read();
    const now = new Date().toISOString();
    const next = sanitizeHealthSnapshot(previous, this.expectedIntervalSeconds);
    const success = SUCCESS_OUTCOMES.has(outcome);
    next.updated_at = now;
    next.last_cycle_finished_at = now;
    next.last_outcome = outcome;
    next.consecutive_failures = success
      ? 0
      : Math.min(Number.MAX_SAFE_INTEGER, next.consecutive_failures + 1);
    if (success) {
      next.last_success_at = now;
      next.failure_class = null;
    } else {
      next.last_failure_at = now;
      next.failure_class = normalizeFailureClass(failureClass, outcome);
    }
    if (lastRefreshAt === true) next.last_refresh_at = now;
    else if (lastRefreshAt !== undefined) next.last_refresh_at = timestamp(lastRefreshAt);
    if (access !== undefined) next.access = normalizeAccess(access, next.access);
    if (quarantine !== undefined) next.quarantine = normalizeQuarantine(quarantine, next.quarantine);
    return this.#write(next);
  }

  async #read() {
    try {
      const parsed = JSON.parse(await this.readImpl(this.healthPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && parsed.version === HEALTH_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  async #write(snapshot) {
    try {
      await this.writeImpl(
        this.healthPath,
        `${JSON.stringify(sanitizeHealthSnapshot(snapshot, this.expectedIntervalSeconds), null, 2)}\n`,
        PUBLIC_HEALTH_MODE,
      );
      return true;
    } catch {
      // Deliberately do not include the error, path, or any caller detail.  A
      // health publication failure must not become a second secret-leak path.
      try {
        this.logger('[refresh-center] WARN public health publication failed');
      } catch {
        // A logger is an observability convenience, never part of the outcome.
      }
      return false;
    }
  }
}
