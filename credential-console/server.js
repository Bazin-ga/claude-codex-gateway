#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomToken } from './lib/security.js';
import {
  baseHeaders,
  compressFor,
  negotiateEncoding,
  parseCookies,
  readForm,
  redirect,
  sendHtml,
  sendJson,
  sendText,
} from './lib/http.js';
import { CredentialStore, MACHINE_ID_PATTERN } from './lib/store.js';
import { acquireHomeLock } from './lib/home-lock.js';
import { handleClaudeProxy } from './lib/proxy.js';
import { handleMachineControl, MACHINE_CONTROL_PREFIX } from './lib/machine-control.js';
import { MetricsStore } from './lib/metrics.js';
import { CLIENT_CONFIG_VERSION } from './lib/client-config-version.js';
import { buildOnboardingGuideUrl, buildOnboardingMarkdown } from './lib/onboarding.js';
import { UsageMonitor } from './lib/usage.js';
import { safeTimestamp } from './lib/credential-alerts.js';
import { buildMetricsChartPayload } from './lib/metrics-chart-data.js';
import {
  createClaudeAuthorizationRequest,
  exchangeClaudeAuthorization,
  parseClaudeAuthorizationCode,
} from './lib/claude-oauth.js';
import {
  buildCodexAuthJson,
  codexIdentityFrom,
  completeCodexAuthorization as exchangeCodexAuthorization,
  createCodexAuthorizationRequest,
  parseCodexAuthorizationRedirect,
} from './lib/codex-oauth.js';
import { assertCodexSeedHomeWritable, seedCodexCredentialHome } from './lib/codex-seed.js';
import {
  claudeAuthorizationView,
  dashboardView,
  deviceConfiguredView,
  enrollmentCreatedView,
  enrollmentView,
  messageView,
  codexAuthorizationView,
  codexConfiguredView,
  codexCredentialView,
  metricsView,
  conversationsView,
  conversationDetailView,
  conversationSessionsView,
  conversationSessionDetailView,
  conversationRoundDetailView,
} from './lib/views.js';
import { requestEnrollment as requestCodexEnrollment } from '../codex-credential/client-agent/enroll.js';

const HOME = process.env.CREDENTIAL_CONSOLE_HOME ?? '/var/lib/credential-console';
const BIND = process.env.CREDENTIAL_CONSOLE_BIND ?? '127.0.0.1';
const PORT = Number(process.env.CREDENTIAL_CONSOLE_PORT ?? 9443);
const PUBLIC_BASE_URL = process.env.CREDENTIAL_CONSOLE_PUBLIC_URL ?? `https://127.0.0.1:${PORT}`;
const CLAUDE_GATEWAY_URL = process.env.CREDENTIAL_CONSOLE_CLAUDE_GATEWAY_URL;
const TLS_CERT = process.env.CREDENTIAL_CONSOLE_TLS_CERT;
const TLS_KEY = process.env.CREDENTIAL_CONSOLE_TLS_KEY;
const COOKIE_SECURE = process.env.CREDENTIAL_CONSOLE_COOKIE_SECURE !== '0';
// Fail closed: an unconfigured deployment refuses unidentified requests rather than
// handing credential issuance to whoever can route to the listener. `open` is a
// deliberate choice, never a default.
const ADMIN_AUTH = process.env.CREDENTIAL_CONSOLE_ADMIN_AUTH ?? 'tailscale';
const CODEX_ENDPOINT = process.env.CREDENTIAL_CONSOLE_CODEX_ENDPOINT;
const CODEX_CERT_PIN = process.env.CREDENTIAL_CONSOLE_CODEX_CERT_PIN;
const CODEX_ENROLLMENT_KEY_FILE = process.env.CREDENTIAL_CONSOLE_CODEX_ENROLLMENT_KEY_FILE;
// Setting this elevates the console from read-only importer to writer of that
// codex-credential home. See README "Codex account authorization".
const CODEX_SEED_HOME = process.env.CREDENTIAL_CONSOLE_CODEX_SEED_HOME;
const USAGE_REFRESH_INTERVAL_MS = Number(
  process.env.CREDENTIAL_CONSOLE_USAGE_REFRESH_INTERVAL_MS ?? 60 * 60_000,
);
const SESSION_TTL_MS = 12 * 60 * 60_000;
// Open mode mints a session for any visitor, so the map needs a ceiling that does
// not depend on someone authenticating first. The process is capped at 96 MB of
// heap by the shipped unit; an unbounded map is an OOM plus a restart loop.
const MAX_SESSIONS = 4_096;
const METRICS_PAGE_CACHE_TTL_MS = 5_000;
const MAX_METRICS_PAGE_CACHE_ENTRIES = 8;
const MAX_METRICS_PAGE_CACHE_BYTES = 12 * 1024 * 1024;
const METRICS_CHART_RATE_WINDOW_MS = 60_000;
const METRICS_CHART_RATE_LIMIT = 120;
const MAX_METRICS_CHART_RATE_KEYS = 1_024;
const COMPLETED_DRAFTS = new Set([
  'claude-self-service',
  'codex-self-service',
  'register-claude-account',
  'register-codex-account',
]);
const DEVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BOUNDED_CONVERSATION_SEARCH_ERRORS = new Set([
  'search_query_too_short',
  'search_query_requires_indexed_terms',
]);
const CONVERSATION_PERIODS = new Set(['24', '168', '720', 'all']);
const CONVERSATION_LIMITS = new Set([25, 50]);
const CONVERSATION_RESPONSE_STATES = new Set([
  'complete',
  'incomplete',
  'truncated',
  'unavailable',
]);
const CONVERSATION_ROUND_RESPONSE_STATES = new Set([
  'pending',
  'complete',
  'failed',
  'unavailable',
]);
const CONVERSATION_QUERY_MAX_BYTES = 256;
const CONVERSATION_MEMBER_MAX_BYTES = 160;
const CONVERSATION_IDENTIFIER_MAX_BYTES = 128;
const CONVERSATION_MODEL_MAX_BYTES = 256;
export const SHUTDOWN_DEADLINE_MS = 1_000;
const CODEX_AGENT_ROOT = fileURLToPath(new URL('../codex-credential/client-agent/', import.meta.url));
/**
 * Compressed forms of the immutable metrics bundle, built on first use.
 *
 * Keyed by encoding and bounded by the number of encodings we negotiate (two),
 * so this is a couple of hundred kilobytes held for the process lifetime rather
 * than 15 ms of CPU burned per request.
 */
const metricsAssetVariants = new WeakMap();

function metricsAssetVariant(asset, encoding) {
  let byEncoding = metricsAssetVariants.get(asset);
  if (!byEncoding) {
    byEncoding = new Map();
    metricsAssetVariants.set(asset, byEncoding);
  }
  const key = encoding ?? 'identity';
  const cached = byEncoding.get(key);
  if (cached) return cached;

  const raw = Buffer.from(asset.body, 'utf8');
  const body = encoding ? compressFor(encoding, raw) : raw;
  const variant = { body, encoding: body === raw ? null : encoding };
  byEncoding.set(key, variant);
  return variant;
}

const METRICS_ASSET_ROOT = fileURLToPath(new URL('./assets/', import.meta.url));
const METRICS_ASSET_MANIFEST = `${METRICS_ASSET_ROOT}metrics-echarts-manifest.json`;
export const CODEX_AGENT_ASSETS = new Map([
  ['pull.js', 'pull.js'],
  ['profiles.js', 'profiles.js'],
  ['codex-gateway.js', 'codex-gateway.js'],
  ['package.json', 'package.json'],
  ['lib/pinned-request.js', 'lib/pinned-request.js'],
  ['lib/profile-store.js', 'lib/profile-store.js'],
  ['install/install.sh', 'install/install.sh'],
  ['install/systemd/codex-credential.service', 'install/systemd/codex-credential.service'],
  ['install/systemd/codex-credential.timer', 'install/systemd/codex-credential.timer'],
  ['install/systemd/codex-credential-profiles.service', 'install/systemd/codex-credential-profiles.service'],
  ['install/systemd/codex-credential-profiles.timer', 'install/systemd/codex-credential-profiles.timer'],
  ['install/launchd/com.claude-codex-gateway.codex-credential.plist', 'install/launchd/com.claude-codex-gateway.codex-credential.plist'],
  ['install/launchd/com.claude-codex-gateway.codex-credential-profiles.plist', 'install/launchd/com.claude-codex-gateway.codex-credential-profiles.plist'],
  ['install/windows/install.ps1', 'install/windows/install.ps1'],
  ['install/windows/diagnose.ps1', 'install/windows/diagnose.ps1'],
  // install.sh execs both of these. Omitting them produced an installer that
  // completed "successfully" and left the machine unable to renew: with no
  // systemd user session it falls back to start-container-loop.sh, which was not
  // there, so nothing ever pulled again and the credential died days later —
  // exactly the silent, delayed, all-at-once failure this project exists to
  // prevent. `installer embeds every asset install.sh execs` pins the set.
  ['install/start-container-loop.sh', 'install/start-container-loop.sh'],
  ['install/diagnose.sh', 'install/diagnose.sh'],
]);

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

function tailnetIdentity(req) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return null;
  const login = req.headers['tailscale-user-login'];
  return typeof login === 'string' && login.trim() ? login.trim() : null;
}

function routeMatch(path, pattern) {
  const actual = path.split('/').filter(Boolean);
  const expected = pattern.split('/').filter(Boolean);
  if (actual.length !== expected.length) return null;
  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].startsWith(':')) params[expected[index].slice(1)] = actual[index];
    else if (expected[index] !== actual[index]) return null;
  }
  return params;
}

function expectsAsyncJson(req, operation) {
  const requested = req.headers['x-credential-console-async'];
  const accept = String(req.headers.accept ?? '').toLowerCase();
  return requested === operation && accept.split(',').some((entry) => (
    entry.trim().startsWith('application/json')
  ));
}

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

async function loadMetricsAsset() {
  const manifest = JSON.parse(await readFile(METRICS_ASSET_MANIFEST, 'utf8'));
  if (manifest?.version !== 1
    || typeof manifest.file !== 'string'
    || !/^metrics-echarts\.[0-9a-f]{12}\.js$/.test(manifest.file)
    || manifest.url !== `/assets/${manifest.file}`
    || typeof manifest.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(manifest.sha256)
    || typeof manifest.integrity !== 'string'
    || !/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(manifest.integrity)
    || !Number.isSafeInteger(manifest.bytes)
    || manifest.bytes < 1
    || manifest.bytes > 700 * 1024) {
    throw new Error('metrics asset manifest is invalid');
  }
  const body = await readFile(`${METRICS_ASSET_ROOT}${manifest.file}`);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const integrity = `sha384-${createHash('sha384').update(body).digest('base64')}`;
  if (body.length !== manifest.bytes || sha256 !== manifest.sha256 || integrity !== manifest.integrity) {
    throw new Error('metrics asset digest does not match its manifest');
  }
  return { ...manifest, body };
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
 * The Codex machines a dispenser knows about, read out of the credential home
 * this console imported.
 *
 * A Codex machine never talks to the console: it enrols against the dispenser and
 * pulls from it directly, so `clients.json` is the only place its existence is
 * recorded and this read is the only way the inventory can show it. Read-only and
 * best-effort, exactly like the expiry read beside it — the recommended systemd
 * hardening puts `clients/` out of the console's reach, and an inventory that
 * 500s because of that would be worse than one that says so.
 *
 * `token_sha256` is dropped here rather than at the view. It is a digest of a
 * live bearer token; nothing downstream needs it, and the surest way to keep it
 * out of a rendered page is for the page never to be handed it.
 *
 * A missing file is "no machine has enrolled yet", not a home this console could
 * not read. `clients/` is created by the first `/enroll` or `add-client.js`, and
 * a home the console seeded itself has only `secret/` and `public/` until then —
 * so reporting ENOENT as degradation put a permanent warning on every freshly
 * authorized Codex account and taught operators to ignore the banner that flags
 * a genuinely unreadable one. The sibling read in `externalAccountStatus` has
 * always treated it this way.
 *
 * @returns {Promise<{clients: object[], error: string|null}>}
 */
async function codexClientsFor(account) {
  try {
    const parsed = JSON.parse(
      await readFile(`${account.external.home}/clients/clients.json`, 'utf8'),
    );
    const clients = Array.isArray(parsed.clients) ? parsed.clients : [];
    return {
      error: null,
      clients: clients.map((client) => ({
        account_id: account.id,
        name: typeof client.name === 'string' ? client.name : '',
        // Validated on the way in, like every other handle: this file is written
        // by another process and a malformed value must not be rendered as if it
        // identified something.
        machine_id: typeof client.machine_id === 'string' && MACHINE_ID_PATTERN.test(client.machine_id)
          ? client.machine_id
          : null,
        revoked: Boolean(client.revoked),
        added_at: typeof client.added_at === 'string' ? client.added_at : null,
        revoked_at: typeof client.revoked_at === 'string' ? client.revoked_at : null,
        revoked_reason: typeof client.revoked_reason === 'string' ? client.revoked_reason : null,
      })),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { clients: [], error: null };
    return { clients: [], error: error.message };
  }
}

export async function createCredentialConsole(options = {}) {
  const store = options.store ?? await new CredentialStore(options.home ?? HOME).init();
  const metricsHome = options.home ?? store.home ?? HOME;
  let requestMetrics = null;
  let metricsInitFailed = false;
  if (Object.hasOwn(options, 'requestMetrics')) {
    requestMetrics = options.requestMetrics;
  } else {
    try {
      requestMetrics = await new MetricsStore({
        home: metricsHome,
        log,
      }).init();
    } catch (error) {
      metricsInitFailed = true;
      log('metrics_init_failed', {
        code: error?.code ?? error?.name ?? 'unknown',
      });
    }
  }
  const usageMonitor = options.usageMonitor ?? await new UsageMonitor({
    store,
    home: options.home ?? store.home ?? HOME,
    refreshIntervalMs: options.usageRefreshIntervalMs ?? USAGE_REFRESH_INTERVAL_MS,
    fetchImpl: options.usageFetchImpl,
    log,
  }).init();
  const sessions = new Map();
  const metricsPageCache = new Map();
  let metricsPageCacheBytes = 0;
  const metricsChartRate = new Map();
  const publicBaseUrl = options.publicBaseUrl ?? PUBLIC_BASE_URL;
  const onboardingUrl = buildOnboardingGuideUrl(publicBaseUrl);
  const claudeGatewayUrl = options.claudeGatewayUrl
    ?? CLAUDE_GATEWAY_URL
    ?? `${publicBaseUrl.replace(/\/$/, '')}/claude`;
  const cookieSecure = options.cookieSecure ?? COOKIE_SECURE;
  const adminAuth = options.adminAuth ?? ADMIN_AUTH;
  // Overridable only so a test can drive the eviction path without minting the real
  // ceiling's worth of sessions.
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const metricsChartRateLimit = Number.isSafeInteger(options.metricsChartRateLimit)
    && options.metricsChartRateLimit > 0
    ? options.metricsChartRateLimit
    : METRICS_CHART_RATE_LIMIT;
  const codexEndpoint = options.codexEndpoint ?? CODEX_ENDPOINT;
  const codexCertPin = options.codexCertPin ?? CODEX_CERT_PIN;
  let codexEnrollmentKey = options.codexEnrollmentKey;
  if (codexEnrollmentKey === undefined && CODEX_ENROLLMENT_KEY_FILE) {
    codexEnrollmentKey = (await readFile(CODEX_ENROLLMENT_KEY_FILE, 'utf8')).trim();
  }
  const codexEnroll = options.codexEnroll ?? requestCodexEnrollment;
  // Canonical from here on, so it compares equal to the `resolve()`d home that
  // `cli.js import-codex` records against an account.
  const configuredSeedHome = options.codexSeedHome ?? CODEX_SEED_HOME ?? null;
  const codexSeedHome = configuredSeedHome ? resolvePath(configuredSeedHome) : null;
  const claudeOauthExchange = options.claudeOauthExchange ?? exchangeClaudeAuthorization;
  const codexOauthExchange = options.codexOauthExchange ?? exchangeCodexAuthorization;
  const codexSelfServiceReady = Boolean(codexEndpoint && codexCertPin && codexEnrollmentKey);
  const codexAgentAssets = Object.fromEntries(await Promise.all(
    [...CODEX_AGENT_ASSETS].map(async ([assetName, relativePath]) => [
      assetName,
      await readFile(`${CODEX_AGENT_ROOT}${relativePath}`, 'utf8'),
    ]),
  ));
  let metricsAsset = options.metricsAsset;
  if (metricsAsset === undefined) {
    try {
      metricsAsset = await loadMetricsAsset();
    } catch (error) {
      metricsAsset = null;
      log('metrics_asset_unavailable', { code: error?.code ?? error?.name ?? 'invalid' });
    }
  }
  if (!['tailscale', 'open'].includes(adminAuth)) {
    throw new Error('CREDENTIAL_CONSOLE_ADMIN_AUTH must be tailscale or open');
  }
  // Open mode has no login, so every rendered page has to say so.
  const openMode = adminAuth === 'open';
  const deleteMetricsPageCache = (key) => {
    const entry = metricsPageCache.get(key);
    if (!entry) return false;
    metricsPageCache.delete(key);
    metricsPageCacheBytes = Math.max(0, metricsPageCacheBytes - entry.bytes);
    return true;
  };
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expires_at <= now) sessions.delete(token);
    }
    for (const [key, entry] of metricsPageCache) {
      if (now - entry.createdAtMs > METRICS_PAGE_CACHE_TTL_MS) deleteMetricsPageCache(key);
    }
    for (const [key, entry] of metricsChartRate) {
      if (now - entry.sinceMs > METRICS_CHART_RATE_WINDOW_MS) metricsChartRate.delete(key);
    }
  }, 15 * 60_000);
  cleanupTimer.unref();

  // The cap is a memory bound, not a fairness guarantee: in open mode nothing stops a
  // visitor from asking for more sessions, so at the ceiling something has to go.
  // Expired entries go first, then the least recently used, which keeps a flood of
  // anonymous page loads away from the session an administrator is mid-form with for
  // as long as there is anything staler to take.
  function evictUntilBelowCap() {
    if (sessions.size < maxSessions) return;
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (sessions.size < maxSessions) return;
      if (session.expires_at <= now) sessions.delete(token);
    }
    while (sessions.size >= maxSessions) {
      const stalest = sessions.keys().next().value;
      if (stalest === undefined) break;
      sessions.delete(stalest);
    }
  }

  function sessionFor(req, res) {
    const identity = adminAuth === 'tailscale' ? tailnetIdentity(req) : null;
    if (adminAuth === 'tailscale' && !identity) return null;
    const token = parseCookies(req.headers.cookie).credential_console_session;
    const session = token ? sessions.get(token) : null;
    if (session && session.expires_at > Date.now()
      && (adminAuth !== 'tailscale' || session.admin_identity === identity)) {
      // Re-insert so the map reads least-recently-used first: a session a browser is
      // still presenting moves behind the ones nobody has come back for. The expiry is
      // deliberately not extended; this only reorders eviction.
      sessions.delete(token);
      sessions.set(token, session);
      return session;
    }
    if (token) sessions.delete(token);
    // Open mode authenticates nobody, so a page request gets a session unconditionally;
    // the CSRF token it carries is the only thing left that another origin cannot forge.
    // A cookieless state-changing request cannot carry a matching CSRF token and is
    // therefore already refused, so minting it a 12-hour session would only let an
    // anonymous caller grow this map one entry per request.
    if (adminAuth === 'open' && req.method !== 'GET') return null;
    const newToken = randomToken(32);
    const newSession = {
      csrf: randomToken(24),
      expires_at: Date.now() + SESSION_TTL_MS,
      admin_identity: identity,
    };
    evictUntilBelowCap();
    sessions.set(newToken, newSession);
    res.setHeader('Set-Cookie', setSessionCookie(newToken));
    if (adminAuth === 'tailscale') log('tailnet_admin_authenticated', { identity });
    return newSession;
  }

  function requireSession(req, res) {
    const session = sessionFor(req, res);
    if (!session) {
      if (adminAuth === 'open') {
        sendHtml(res, 403, messageView(
          'Request refused',
          'That request carried no console session, so its CSRF token could not be checked. Reload the page and submit it again.',
          { error: true, openMode: true },
        ));
      } else {
        sendHtml(res, 403, messageView(
          'Tailnet identity required',
          'Open this page through Tailscale Serve from a user-owned tailnet device.',
          { error: true },
        ));
      }
      return null;
    }
    return session;
  }

  function metricsReadRateLimited(session) {
    const now = Date.now();
    const key = adminAuth === 'tailscale'
      ? `identity:${createHash('sha256').update(String(session.admin_identity ?? 'unknown')).digest('hex')}`
      : 'open-console-global';
    const previous = metricsChartRate.get(key);
    const next = !previous || now - previous.sinceMs >= METRICS_CHART_RATE_WINDOW_MS
      ? { sinceMs: now, count: 1 }
      : { sinceMs: previous.sinceMs, count: previous.count + 1 };
    metricsChartRate.delete(key);
    metricsChartRate.set(key, next);
    while (metricsChartRate.size > MAX_METRICS_CHART_RATE_KEYS) {
      const oldest = metricsChartRate.keys().next().value;
      if (oldest === undefined) break;
      metricsChartRate.delete(oldest);
    }
    return next.count > metricsChartRateLimit;
  }

  function checkCsrf(session, form) {
    return session && typeof form.csrf === 'string' && form.csrf === session.csrf;
  }

  // Device names are namespaced per member so that two people who both enroll "laptop"
  // do not revoke each other. Open mode has no verified identity, so the member asserts
  // a label: it keeps names apart, it proves nothing.
  function memberLabelFor(session, form) {
    if (adminAuth !== 'open') return session.admin_identity;
    const label = String(form.member_label ?? '').trim();
    if (!DEVICE_NAME_PATTERN.test(label)) {
      throw new Error('member label must use letters, numbers, dots, underscores, or hyphens');
    }
    return label;
  }

  function setSessionCookie(token) {
    return `credential_console_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${cookieSecure ? '; Secure' : ''}`;
  }

  async function accountsWithExternalStatus() {
    return Promise.all(store.publicAccounts().map(async (account) => {
      const internal = store.accountById(account.id);
      // publicAccounts intentionally contains a legacy last_failure string for
      // API compatibility. Do not pass it to a page or to the alert classifier:
      // it may contain an exception, URL, or filesystem path.
      const safeAccount = {
        id: account.id,
        provider: account.provider,
        alias: account.alias,
        email_label: account.email_label,
        status: account.status,
        created_at: safeTimestamp(account.created_at),
        expires_at: safeTimestamp(account.expires_at),
        last_success_at: safeTimestamp(account.last_success_at),
        last_failure_at: safeTimestamp(account.last_failure_at),
        external: account.external ? { kind: account.external.kind } : null,
        active_devices: account.active_devices,
      };
      return {
        ...safeAccount,
        ...await externalAccountStatus(internal),
        usage: usageMonitor.snapshotForAccount(account.id),
      };
    }));
  }

  /**
   * Every Codex machine row this console can currently see, plus the homes it
   * could not read. A home that refuses the read costs its own machines from the
   * list and nothing else; the page still renders everything else it knows.
   */
  async function codexMachineReport() {
    const clients = [];
    const unavailable = [];
    for (const account of store.state.accounts) {
      if (account.external?.kind !== 'codex-credential') continue;
      const read = await codexClientsFor(account);
      if (read.error) unavailable.push({ alias: account.alias, reason: read.error });
      else clients.push(...read.clients);
    }
    return { clients, unavailable };
  }

  /**
   * The handles a merge is allowed to name.
   *
   * Restricted to machines that already exist, so a stale form or a mistyped
   * handle cannot invent a machine nobody can see and file a credential under
   * it. A device row that already carries the handle keeps it in this set, which
   * is what makes re-submitting the same merge a no-op rather than an error.
   */
  function knownMachineIds(codexClients) {
    const known = new Set();
    for (const device of store.publicDevices()) {
      if (device.machine_id) known.add(device.machine_id);
    }
    for (const client of codexClients) {
      if (client.machine_id) known.add(client.machine_id);
    }
    return known;
  }

  function queryMetricsPage(url) {
    const allowedHours = new Set([24, 168, 720]);
    const requestedHours = Number(url.searchParams.get('hours'));
    const hours = allowedHours.has(requestedHours) ? requestedHours : 24;
    const now = Date.now();
    const fromMs = now - hours * 60 * 60_000;
    const machineSelection = String(url.searchParams.get('machine_id') ?? '').slice(0, 256);
    const memberLabel = String(url.searchParams.get('member_label') ?? '').slice(0, 160);
    const accountId = String(url.searchParams.get('account_id') ?? '').slice(0, 128);
    const model = String(url.searchParams.get('model') ?? '').slice(0, 256);
    let machineId = null;
    let deviceId = null;
    let unattributedMachine = false;
    if (machineSelection === '__unattributed__') unattributedMachine = true;
    else if (machineSelection.startsWith('machine:')) machineId = machineSelection.slice('machine:'.length);
    else if (machineSelection.startsWith('device:')) deviceId = machineSelection.slice('device:'.length);
    else if (machineSelection) machineId = machineSelection;

    const filters = {
      fromMs,
      toMs: now + 1,
      ...(machineId ? { machineId } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(unattributedMachine ? { unattributedMachine: true } : {}),
      ...(memberLabel ? { memberLabel } : {}),
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
    };
    const viewFilters = {
      hours,
      machineId: unattributedMachine ? '' : machineSelection,
      unattributedMachine,
      memberLabel,
      accountId,
      model,
    };
    const empty = {
      range: { fromMs, toMs: now + 1, hours, timezone: 'UTC' },
      filters: viewFilters,
      options: { machines: [], members: [], accounts: [], models: [] },
      totals: { all: 0, consumption: 0, success: 0, errors: 0 },
      hourly: [],
      tokenTotals: {},
      tokenHourly: [],
      accountTokenBreakdown: [],
      modelTokenBreakdown: [],
      deviceTokenComparison: {
        devices: [], rows: [], truncated: false, devicesTruncated: false, hoursTruncated: false,
        unavailableDeviceCount: 0,
      },
      metricsAvailable: false,
      droppedMetrics: 0,
      error: null,
    };
    if (!requestMetrics?.queryTotals
      || !requestMetrics?.queryHourly
      || !requestMetrics?.queryBreakdown) {
      return empty;
    }

    try {
      // A dashboard read may flush one queued batch: this is outside every
      // proxy completion callback, so request delivery never waits on SQLite.
      requestMetrics.flush?.();
      const allTotals = requestMetrics.queryTotals({ ...filters, scope: 'all' });
      const consumptionTotals = requestMetrics.queryTotals({ ...filters, scope: 'consumption' });
      const hourly = requestMetrics.queryHourly({ ...filters, scope: 'all' });
      const tokenHourly = requestMetrics.queryHourly({ ...filters, scope: 'consumption' });
      const dimensions = { fromMs, toMs: now + 1, scope: 'all' };
      const deviceById = new Map(store.publicDevices().map((device) => [device.id, device]));
      const accountById = new Map(store.publicAccounts().map((account) => [account.id, account]));
      const machineRows = requestMetrics.queryBreakdown({ by: 'machine', ...dimensions });
      const deviceRows = requestMetrics.queryBreakdown({ by: 'device', ...dimensions });
      const memberRows = requestMetrics.queryBreakdown({ by: 'member', ...dimensions });
      const accountRows = requestMetrics.queryBreakdown({ by: 'account', ...dimensions });
      const modelRows = requestMetrics.queryBreakdown({ by: 'model', ...dimensions });
      const tokenBreakdown = typeof requestMetrics.queryTokenBreakdown === 'function'
        ? requestMetrics.queryTokenBreakdown.bind(requestMetrics)
        : requestMetrics.queryBreakdown.bind(requestMetrics);
      const accountTokenBreakdown = tokenBreakdown({
        by: 'account',
        ...filters,
        scope: 'consumption',
      }).map((row) => ({
        ...row,
        label: accountById.get(row.groupValue)?.alias ?? row.groupValue ?? 'Unattributed',
      }));
      const modelTokenBreakdown = tokenBreakdown({
        by: 'model',
        ...filters,
        scope: 'consumption',
      }).map((row) => ({
        ...row,
        label: row.groupValue ?? 'Unattributed',
      }));
      let deviceTokenComparison = {
        devices: [], rows: [], truncated: false, devicesTruncated: false, hoursTruncated: false,
        unavailableDeviceCount: 0,
      };
      if (typeof requestMetrics.queryDeviceTokenHourly === 'function') {
        try {
          const comparison = requestMetrics.queryDeviceTokenHourly({
            fromMs,
            toMs: now + 1,
            ...(memberLabel ? { memberLabel } : {}),
            ...(accountId ? { accountId } : {}),
            ...(model ? { model } : {}),
          });
          deviceTokenComparison = {
            devices: (Array.isArray(comparison?.devices) ? comparison.devices : []).map((device) => {
              const publicDevice = deviceById.get(device.deviceId);
              return {
                ...device,
                value: device.deviceId,
                name: publicDevice?.name ?? null,
                revoked: Boolean(publicDevice?.revoked_at),
                label: publicDevice?.name
                  ? `${publicDevice.name} · ${device.memberLabel ?? device.deviceId}${publicDevice.revoked_at ? ' · revoked' : ''}`
                  : (device.memberLabel ?? device.deviceId),
              };
            }),
            rows: Array.isArray(comparison?.rows) ? comparison.rows : [],
            truncated: comparison?.truncated === true,
            devicesTruncated: comparison?.devicesTruncated === true,
            hoursTruncated: comparison?.hoursTruncated === true,
            unavailableDeviceCount: Number.isSafeInteger(comparison?.unavailableDeviceCount)
              ? comparison.unavailableDeviceCount
              : 0,
          };
        } catch (comparisonError) {
          log('metrics_device_comparison_failed', {
            code: comparisonError?.code ?? comparisonError?.name ?? 'unknown',
          });
        }
      }
      return {
        range: { fromMs, toMs: now + 1, hours, timezone: 'UTC' },
        filters: viewFilters,
        options: {
          machines: [
            ...machineRows.filter((row) => row.groupValue).map((row) => ({
              value: `machine:${row.groupValue}`,
              label: `Machine ${row.groupValue}`,
            })),
            ...deviceRows.filter((row) => row.groupValue).map((row) => {
              const device = deviceById.get(row.groupValue);
              return {
                value: `device:${row.groupValue}`,
                label: device
                  ? `${device.member_label} · ${device.name} · credential ${row.groupValue}`
                  : `Credential ${row.groupValue}`,
              };
            }),
          ],
          members: memberRows.filter((row) => row.groupValue).map((row) => ({
            value: row.groupValue,
            label: row.groupValue,
          })),
          accounts: accountRows.filter((row) => row.groupValue).map((row) => ({
            value: row.groupValue,
            label: accountById.get(row.groupValue)?.alias ?? row.groupValue,
          })),
          models: modelRows.filter((row) => row.groupValue).map((row) => ({
            value: row.groupValue,
            label: row.groupValue,
          })),
        },
        totals: {
          all: allTotals.requestCount,
          consumption: consumptionTotals.requestCount,
          success: allTotals.successCount,
          errors: allTotals.errorCount,
        },
        hourly,
        tokenTotals: consumptionTotals,
        tokenHourly,
        accountTokenBreakdown,
        modelTokenBreakdown,
        deviceTokenComparison,
        metricsAvailable: true,
        droppedMetrics: requestMetrics.stats?.dropped ?? 0,
        error: null,
      };
    } catch (error) {
      log('metrics_query_failed', { code: error?.code ?? error?.name ?? 'unknown' });
      return {
        ...empty,
        error: 'Request metrics could not be read.',
      };
    }
  }

  function metricsPage(url) {
    const requestedHours = Number(url.searchParams.get('hours'));
    const hours = new Set([24, 168, 720]).has(requestedHours) ? requestedHours : 24;
    const cacheKey = JSON.stringify([
      hours,
      String(url.searchParams.get('machine_id') ?? '').slice(0, 256),
      String(url.searchParams.get('member_label') ?? '').slice(0, 160),
      String(url.searchParams.get('account_id') ?? '').slice(0, 128),
      String(url.searchParams.get('model') ?? '').slice(0, 256),
    ]);
    const now = Date.now();
    const cached = metricsPageCache.get(cacheKey);
    if (cached && now - cached.createdAtMs <= METRICS_PAGE_CACHE_TTL_MS) {
      metricsPageCache.delete(cacheKey);
      metricsPageCache.set(cacheKey, cached);
      return cached.page;
    }
    if (cached) deleteMetricsPageCache(cacheKey);
    const page = queryMetricsPage(url);
    let bytes = MAX_METRICS_PAGE_CACHE_BYTES + 1;
    try {
      bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    } catch {
      // A query result that cannot be measured is still safe to render once,
      // but it must never enter a memory cache with an unknown cost.
    }
    while (metricsPageCache.size >= MAX_METRICS_PAGE_CACHE_ENTRIES
      || (metricsPageCache.size > 0 && metricsPageCacheBytes + bytes > MAX_METRICS_PAGE_CACHE_BYTES)) {
      const oldest = metricsPageCache.keys().next().value;
      if (oldest === undefined) break;
      deleteMetricsPageCache(oldest);
    }
    if (bytes <= MAX_METRICS_PAGE_CACHE_BYTES) {
      metricsPageCache.set(cacheKey, { createdAtMs: now, page, bytes });
      metricsPageCacheBytes += bytes;
    }
    return page;
  }

  function conversationSearchPage(url, { mode = 'rounds' } = {}) {
    const reliableRounds = mode === 'rounds';
    const searchMethod = mode === 'turns'
      ? 'searchConversations'
      : 'searchConversationRoundSessions';
    const facetMethod = mode === 'turns'
      ? 'queryConversationFacets'
      : null;
    const allowedResponseStates = reliableRounds
      ? CONVERSATION_ROUND_RESPONSE_STATES
      : CONVERSATION_RESPONSE_STATES;
    const q = String(url.searchParams.get('q') ?? '');
    const beforeValue = url.searchParams.get('before_id');
    const beforeActivityValue = reliableRounds
      ? url.searchParams.get('before_activity_ms')
      : null;
    const limitValue = Number(url.searchParams.get('limit') ?? 25);
    const beforeId = beforeValue === null || beforeValue === ''
      ? null
      : Number(beforeValue);
    const beforeActivityMs = beforeActivityValue === null || beforeActivityValue === ''
      ? null
      : Number(beforeActivityValue);
    // Keep the old one-row route fixture usable while the public UI offers the
    // bounded 25/50 choices. MetricsStore clamps again at its own boundary.
    const limit = limitValue === 1 || CONVERSATION_LIMITS.has(limitValue) ? limitValue : 25;
    const requestedPeriod = String(url.searchParams.get('period') ?? 'all');
    const period = CONVERSATION_PERIODS.has(requestedPeriod) ? requestedPeriod : 'all';
    let invalidFilterLength = Buffer.byteLength(q, 'utf8') > CONVERSATION_QUERY_MAX_BYTES;
    const boundedParam = (name, maxBytes) => {
      const value = url.searchParams.get(name);
      if (value === null || value === '') return null;
      const text = String(value);
      if (Buffer.byteLength(text, 'utf8') > maxBytes) invalidFilterLength = true;
      return text;
    };
    const memberLabel = boundedParam('member_label', CONVERSATION_MEMBER_MAX_BYTES);
    const deviceId = boundedParam('device_id', CONVERSATION_IDENTIFIER_MAX_BYTES);
    const accountId = boundedParam('account_id', CONVERSATION_IDENTIFIER_MAX_BYTES);
    const model = boundedParam('model', CONVERSATION_MODEL_MAX_BYTES);
    const requestedResponseState = boundedParam('response_state', CONVERSATION_QUERY_MAX_BYTES);
    const responseState = allowedResponseStates.has(requestedResponseState)
      ? requestedResponseState
      : null;
    const hasBeforeId = beforeValue !== null && beforeValue !== '';
    const hasBeforeActivity = beforeActivityValue !== null && beforeActivityValue !== '';
    const invalidCursor = reliableRounds
      ? hasBeforeId !== hasBeforeActivity
        || (hasBeforeId && (
          !Number.isSafeInteger(beforeId)
          || beforeId < 1
          || !Number.isSafeInteger(beforeActivityMs)
          || beforeActivityMs < 0
        ))
      : hasBeforeId && (!Number.isSafeInteger(beforeId) || beforeId < 1);
    const invalidPeriod = requestedPeriod !== 'all' && !CONVERSATION_PERIODS.has(requestedPeriod);
    const invalidLimit = !Number.isSafeInteger(limitValue)
      || (limitValue !== 1 && !CONVERSATION_LIMITS.has(limitValue));
    const invalidResponseState = requestedResponseState !== null
      && requestedResponseState !== ''
      && !allowedResponseStates.has(requestedResponseState);
    const hasExtendedFilters = url.searchParams.has('period')
      || memberLabel !== null
      || deviceId !== null
      || accountId !== null
      || model !== null
      || responseState !== null;
    const now = Date.now();
    const fromMs = period === 'all' ? null : now - Number(period) * 60 * 60 * 1000;
    const fallbackDevices = store.publicDevices().map((device) => ({
      value: device.id,
      label: device.name || device.id,
    }));
    const fallbackMembers = [...new Map(store.publicDevices()
      .filter((device) => device.member_label)
      .map((device) => [device.member_label, { value: device.member_label, label: device.member_label }]))
      .values()];
    const fallbackAccounts = store.publicAccounts()
      .filter((account) => account.provider === 'claude')
      .map((account) => ({
      value: account.id,
      label: account.alias,
      }));
    const fallbackFacets = {
      members: fallbackMembers,
      devices: fallbackDevices,
      accounts: fallbackAccounts,
      models: [],
      responseStates: [...allowedResponseStates].map((value) => ({ value, label: value })),
    };
    if (invalidCursor || invalidPeriod || invalidLimit || invalidResponseState || invalidFilterLength) {
      return {
        statusCode: 400,
        result: {
          items: [],
          nextBeforeId: null,
          nextBeforeActivityMs: null,
          error: 'conversation_filter_invalid',
          totalMatches: null,
          standaloneCount: null,
          facets: fallbackFacets,
        },
        q: '',
        beforeId: null,
        beforeActivityMs: null,
        limit: 25,
        period: 'all',
        memberLabel: null,
        deviceId: null,
        accountId: null,
        model: null,
        responseState: null,
        queueDropped: reliableRounds
          ? requestMetrics?.stats?.conversationRounds?.dropped ?? 0
          : requestMetrics?.stats?.conversation?.dropped ?? 0,
      };
    }
    const enrichItems = (items) => {
      const devices = new Map(store.publicDevices().map((device) => [device.id, device]));
      const accounts = new Map(store.publicAccounts().map((account) => [account.id, account.alias]));
      return (Array.isArray(items) ? items : []).map((item) => {
        const device = devices.get(item?.deviceId);
        return {
          ...item,
          accountAlias: typeof item?.accountAlias === 'string' && item.accountAlias
            ? item.accountAlias
            : (accounts.get(item?.accountId) ?? null),
          deviceName: typeof item?.deviceName === 'string'
            ? item.deviceName
            : (typeof device?.name === 'string' ? device.name : null),
        };
      });
    };
    const empty = {
      statusCode: 503,
      result: {
        items: [],
        nextBeforeId: null,
        nextBeforeActivityMs: null,
        error: 'conversation_archive_unavailable',
        totalMatches: null,
        standaloneCount: null,
        facets: fallbackFacets,
      },
      q,
      beforeId,
      beforeActivityMs,
      limit,
      period,
      memberLabel,
      deviceId,
      accountId,
      model,
      responseState,
      queueDropped: reliableRounds
        ? requestMetrics?.stats?.conversationRounds?.dropped ?? 0
        : requestMetrics?.stats?.conversation?.dropped ?? 0,
    };
    if (typeof requestMetrics?.[searchMethod] !== 'function') return empty;
    try {
      // Like the metrics dashboard, a read is allowed to flush a bounded batch.
      // The proxy completion path itself never waits on SQLite.
      requestMetrics.flush?.();
      const searchOptions = { q, beforeId, limit };
      if (reliableRounds && beforeId !== null) searchOptions.beforeActivityMs = beforeActivityMs;
      if (hasExtendedFilters) {
        if (fromMs !== null) {
          searchOptions.fromMs = fromMs;
          searchOptions.toMs = now;
        }
        if (memberLabel !== null) searchOptions.memberLabel = memberLabel;
        if (deviceId !== null) searchOptions.deviceId = deviceId;
        if (accountId !== null) searchOptions.accountId = accountId;
        if (model !== null) searchOptions.model = model;
        if (responseState !== null) searchOptions.responseState = responseState;
      }
      const rawResult = requestMetrics[searchMethod](searchOptions);
      const source = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
        ? rawResult
        : { items: [], nextBeforeId: null, error: 'conversation_archive_unavailable' };
      let facetSource = null;
      if (facetMethod && typeof requestMetrics?.[facetMethod] === 'function') {
        const facetOptions = { q };
        if (fromMs !== null) {
          facetOptions.fromMs = fromMs;
          facetOptions.toMs = now;
        }
        if (memberLabel !== null) facetOptions.memberLabel = memberLabel;
        if (deviceId !== null) facetOptions.deviceId = deviceId;
        if (accountId !== null) facetOptions.accountId = accountId;
        if (model !== null) facetOptions.model = model;
        if (responseState !== null) facetOptions.responseState = responseState;
        try {
          const queried = requestMetrics[facetMethod](facetOptions);
          if (queried && typeof queried === 'object' && !Array.isArray(queried)) facetSource = queried;
        } catch {
          // Facets are an enhancement. A search result remains useful when a
          // metrics implementation has not deployed the facet query yet.
        }
      }
      const devicesById = new Map(fallbackDevices.map((device) => [device.value, device.label]));
      const accountsById = new Map(fallbackAccounts.map((account) => [account.value, account.label]));
      const facetEntries = (name, labels = new Map()) => (Array.isArray(facetSource?.[name])
        ? facetSource[name].map((entry) => {
          const value = entry?.value === null || entry?.value === undefined
            ? ''
            : String(entry.value);
          if (!value) return null;
          return {
            value,
            label: labels.get(value) ?? value,
            count: Number.isSafeInteger(entry?.count) ? entry.count : null,
          };
        }).filter(Boolean)
        : null);
      const mappedFacets = facetSource ? {
        members: facetEntries('members'),
        devices: facetEntries('devices', devicesById),
        accounts: facetEntries('accounts', accountsById),
        models: facetEntries('models'),
        responseStates: facetEntries('responseStates'),
        facetTruncated: facetSource.facetTruncated ?? {},
        truncated: facetSource.truncated === true,
      } : fallbackFacets;
      const result = {
        items: enrichItems(source.items),
        nextBeforeId: source.nextBeforeId ?? null,
        nextBeforeActivityMs: reliableRounds
          ? source.nextBeforeActivityMs ?? null
          : null,
        error: source.error ?? null,
        droppedConversations: source.droppedConversations ?? null,
        standaloneCount: Number.isSafeInteger(source.standaloneCount)
          ? source.standaloneCount
          : null,
        legacyFragmentCount: Number.isSafeInteger(source.legacyFragmentCount)
          ? source.legacyFragmentCount
          : null,
        totalMatches: Number.isSafeInteger(source.totalMatches)
          ? source.totalMatches
          : (mode === 'turns' && Number.isSafeInteger(facetSource?.totalStored)
            ? facetSource.totalStored
            : null),
        facets: mappedFacets,
      };
      const statusCode = result?.error
        ? BOUNDED_CONVERSATION_SEARCH_ERRORS.has(result.error) ? 400 : 503
        : 200;
      return {
        statusCode,
        result,
        q,
        beforeId,
        beforeActivityMs,
        limit,
        period,
        memberLabel,
        deviceId,
        accountId,
        model,
        responseState,
        queueDropped: reliableRounds
          ? requestMetrics.stats?.conversationRounds?.dropped ?? 0
          : requestMetrics.stats?.conversation?.dropped ?? 0,
      };
    } catch (error) {
      log('conversation_search_route_failed', {
        code: error?.code ?? error?.name ?? 'unknown',
      });
      return empty;
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, publicBaseUrl);
    const path = url.pathname;

    if (path.startsWith(MACHINE_CONTROL_PREFIX)) {
      await handleMachineControl(req, res, { store, requestMetrics, log });
      return;
    }

    if (path.startsWith('/claude/')) {
      await handleClaudeProxy(req, res, {
        store,
        upstreamBaseUrl: options.claudeUpstreamBaseUrl,
        requestMetrics,
      });
      return;
    }

    if (path === '/onboarding.md') {
      if (req.method !== 'GET') {
        sendText(
          res,
          405,
          'method not allowed\n',
          'text/plain; charset=utf-8',
          { Allow: 'GET' },
        );
        return;
      }
      const session = requireSession(req, res);
      if (!session) return;
      const markdown = buildOnboardingMarkdown({
        consoleUrl: publicBaseUrl,
        claudeGatewayUrl,
        clientConfigVersion: CLIENT_CONFIG_VERSION,
        accounts: await accountsWithExternalStatus(),
        codexEndpoint,
        codexCertPin,
        adminAuth,
      });
      sendText(res, 200, markdown, 'text/markdown; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && path === '/metrics/chart-data') {
      const session = requireSession(req, res);
      if (!session) return;
      if (metricsReadRateLimited(session)) {
        sendJson(res, 429, { error: 'metrics_chart_rate_limited' }, { 'Retry-After': '60' });
        return;
      }
      const page = metricsPage(url);
      sendJson(res, page.error || !page.metricsAvailable ? 503 : 200, buildMetricsChartPayload(page));
      return;
    }

    if (req.method === 'GET' && path === '/metrics') {
      const session = requireSession(req, res);
      if (!session) return;
      if (metricsReadRateLimited(session)) {
        sendHtml(res, 429, messageView(
          'Metrics temporarily rate limited',
          'Too many metrics reads were requested. Wait one minute and try again.',
          { error: true, openMode },
        ), { 'Retry-After': '60' });
        return;
      }
      sendHtml(res, 200, metricsView({
        ...metricsPage(url),
        openMode,
        metricsAsset: metricsAsset ? {
          url: metricsAsset.url,
          integrity: metricsAsset.integrity,
        } : null,
      }));
      return;
    }

    const conversationCollection = path === '/conversations'
      ? { mode: 'rounds', view: conversationSessionsView }
      : path === '/conversation-turns'
        ? { mode: 'turns', view: conversationsView }
        : null;
    if (conversationCollection && !['GET', 'POST'].includes(req.method)) {
      sendText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, POST' });
      return;
    }

    if (conversationCollection && ['GET', 'POST'].includes(req.method)) {
      const session = requireSession(req, res);
      if (!session) return;
      // Search state stays out of URLs: GET is the default landing page, while
      // the read-only filter form submits a bounded POST.
      const formUrl = new URL(path, url);
      if (req.method === 'POST') {
        let form;
        try {
          form = await readForm(req, 8 * 1024);
        } catch {
          sendText(res, 413, 'conversation filter form too large\n');
          return;
        }
        for (const [key, value] of Object.entries(form)) {
          if (typeof value === 'string') formUrl.searchParams.set(key, value);
        }
      }
      const page = conversationSearchPage(formUrl, { mode: conversationCollection.mode });
      // A browser with scripting asks for just the results region. Everything
      // else — including that same browser with scripting disabled — gets the
      // whole document from this same code path, so the two cannot drift.
      const wantsFragment = req.headers['x-fragment'] === 'conversation-results';
      sendHtml(res, page.statusCode ?? 200, conversationCollection.view({
        ...page,
        openMode,
        fragment: wantsFragment,
      }));
      return;
    }

    const sessionParams = routeMatch(path, '/conversations/session/:id');
    if (sessionParams && req.method !== 'GET') {
      sendText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET' });
      return;
    }
    if (req.method === 'GET' && sessionParams) {
      const adminSession = requireSession(req, res);
      if (!adminSession) return;
      const sessionId = Number(sessionParams.id);
      let result = { session: null, error: null };
      if (Number.isSafeInteger(sessionId) && sessionId > 0
        && typeof requestMetrics?.readConversationRoundSession === 'function') {
        try {
          requestMetrics.flush?.();
          const rawResult = requestMetrics.readConversationRoundSession(sessionId);
          result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
            ? rawResult
            : { session: null, error: 'conversation_unavailable' };
        } catch (error) {
          log('conversation_session_read_route_failed', {
            code: error?.code ?? error?.name ?? 'unknown',
          });
          result = { session: null, error: 'conversation_unavailable' };
        }
      } else if (typeof requestMetrics?.readConversationRoundSession !== 'function') {
        result = { session: null, error: 'conversation_archive_unavailable' };
      }
      const statusCode = result?.error ? 503 : (result?.session ? 200 : 404);
      sendHtml(res, statusCode, conversationSessionDetailView({
        result,
        id: sessionParams.id,
        openMode,
      }));
      return;
    }

    const roundParams = routeMatch(path, '/conversation-rounds/:id');
    if (roundParams && req.method !== 'GET') {
      sendText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET' });
      return;
    }
    if (req.method === 'GET' && roundParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const roundId = Number(roundParams.id);
      let result = { round: null, error: null };
      if (Number.isSafeInteger(roundId) && roundId > 0
        && typeof requestMetrics?.readConversationRound === 'function') {
        try {
          requestMetrics.flush?.();
          const rawResult = requestMetrics.readConversationRound(roundId);
          result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
            ? rawResult
            : { round: null, error: 'round_unavailable' };
          if (result.round) {
            const device = store.publicDevices().find((entry) => entry.id === result.round.deviceId);
            result = {
              ...result,
              round: {
                ...result.round,
                deviceName: typeof device?.name === 'string' ? device.name : null,
              },
            };
          }
        } catch (error) {
          log('conversation_round_read_route_failed', {
            code: error?.code ?? error?.name ?? 'unknown',
          });
          result = { round: null, error: 'round_unavailable' };
        }
      } else if (typeof requestMetrics?.readConversationRound !== 'function') {
        result = { round: null, error: 'conversation_archive_unavailable' };
      }
      const statusCode = result?.error ? 503 : (result?.round ? 200 : 404);
      sendHtml(res, statusCode, conversationRoundDetailView({
        result,
        id: roundParams.id,
        openMode,
      }));
      return;
    }

    // `/conversations/:id` remains a compatibility alias for old bookmarks;
    // all newly rendered turn links use the explicit `/conversation-turns/:id`.
    const conversationParams = routeMatch(path, '/conversation-turns/:id')
      ?? routeMatch(path, '/conversations/:id');
    if (conversationParams && req.method !== 'GET') {
      sendText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET' });
      return;
    }
    if (req.method === 'GET' && conversationParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const conversationId = Number(conversationParams.id);
      let result = { turn: null, error: null };
      if (Number.isSafeInteger(conversationId) && conversationId > 0
        && typeof requestMetrics?.readConversation === 'function') {
        try {
          requestMetrics.flush?.();
          const rawResult = requestMetrics.readConversation(conversationId);
          result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
            ? rawResult
            : { turn: null, error: 'conversation_unavailable' };
        } catch (error) {
          log('conversation_read_route_failed', {
            code: error?.code ?? error?.name ?? 'unknown',
          });
          result = { turn: null, error: 'conversation_unavailable' };
        }
      } else if (typeof requestMetrics?.readConversation !== 'function') {
        result = { turn: null, error: 'conversation_archive_unavailable' };
      }
      const statusCode = result?.error ? 503 : (result?.turn ? 200 : 404);
      sendHtml(res, statusCode, conversationDetailView({
        result,
        id: conversationParams.id,
        openMode,
      }));
      return;
    }

    if (req.method === 'GET' && metricsAsset && path === metricsAsset.url) {
      // This asset is 612 KB and immutable, so compressing it per request cost
      // ~15 ms of synchronous brotli every time — on the same event loop that
      // carries the Claude proxy. Compress each encoding once and reuse it.
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      const variant = metricsAssetVariant(metricsAsset, encoding);
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
        Vary: 'Accept-Encoding',
        // A strong validator must identify the representation, not just the
        // resource, or a revalidating cache can hand one encoding's bytes to a
        // client that asked for another.
        ETag: `"${metricsAsset.sha256}${variant.encoding ? `-${variant.encoding}` : ''}"`,
        ...(variant.encoding ? { 'Content-Encoding': variant.encoding } : {}),
        'Content-Length': variant.body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : variant.body);
      return;
    }

    if (req.method === 'GET' && path.startsWith('/assets/metrics-echarts.')) {
      sendText(res, 404, 'not found\n');
      return;
    }

    if (req.method === 'GET' && path === '/assets/app.js') {
      sendText(res, 200, `
const translations = {
  'brand-tagline': '私有账号与设备控制平面',
  'member-zone-label': '成员自助区 · 所有成员看到的就是这里',
  'member-heading': '给这台设备开通 AI 工具',
  'member-intro': '选择团队账号并领取本机配置，不需要管理员转发令牌，也不需要登录共享的上游账号。',
  'tailscale-identity': 'Tailscale 身份',
  'open-banner': '本控制台没有任何认证：任何能访问它的人都可以签发和撤销凭据。',
  'no-identity': '无身份',
  'anonymous-visitor': '匿名访问者',
  'member-label': '你的标签（自己填写，不做校验）',
  'member-label-note': '没有人会校验这个标签，它只用来区分不同成员的设备名。',
  'claude-description': '领取一个只属于当前成员和设备、可通过公网使用的配置。上游 OAuth 令牌不会离开服务器。',
  'team-account': '团队账号',
  'device-name': '本机设备名',
  'get-claude': '领取 Claude Code 配置',
  'no-account': '尚无可用账号',
  'waiting-owner': '等待账号所有者录入',
  'owner-add-once': '账号所有者只需在下方管理员区录入一次，之后所有成员都能自行领取。',
  'codex-description': 'refresh center 会持续轮换主凭据。领取不依赖内网的单文件安装器与独立设备 token。',
  'get-codex': '领取 Codex 安装脚本',
  'codex-unavailable': 'Codex 自助登记尚未配置。管理员需要连接 dispenser enrollment。',
  'admin-zone': '管理员区',
  'admin-heading': '账号、设备与特殊登记',
  'admin-intro': '这里用于一次性录入上游账号、查看设备和撤销访问。普通成员的日常领取发生在上方自助区。',
  'accounts': '账号',
  'healthy': '健康',
  'active-claude-credentials': '有效的 Claude 凭据',
  'account': '账号',
  'provider': '提供商',
  'status': '状态',
  'devices': '设备',
  'expires': '过期时间',
  'usage-quota': '用量额度',
  'usage-five-hour': '5 小时窗口',
  'usage-weekly': '周窗口',
  'usage-remaining': '剩余',
  'usage-resets': '重置于',
  'usage-updated': '更新于',
  'usage-not-reported': '上游未提供',
  'usage-loading': '正在等待首次每小时用量刷新。',
  'usage-reauthorize': '需要为该 Claude 账号重新授权一次，才能显示额度。',
  'usage-authorize-first': '完成该账号的授权后才能显示额度。',
  'usage-stale': '最新刷新失败，当前显示上一次成功结果。',
  'usage-unavailable': '当前暂时无法取得用量。',
  'action': '操作',
  'last-seen': '最后使用',
  'no-accounts': '尚无账号。',
  'upstream-secret-note': '上游令牌加密保存，提交后不再展示。特殊情况可在账号行生成一次性登记链接。',
  'add-claude-heading': '录入 Claude Code 团队账号',
  'add-claude-help': '只需登记预期的账号所有者邮箱。所有者之后在该账号的固定授权页面自行完成 OAuth，无需把 token 交给管理员。',
  'account-alias': '账号别名',
  'account-email': '账号邮箱标签',
  'register-account': '登记账号',
  'owner-authorization': '账号所有者授权',
  'owner-login-required': '账号所有者完成授权后才能登记成员设备。',
  'owner-auth-heading': '账号所有者授权',
  'owner-auth-account': '预期账号',
  'owner-page-permanent': '这个控制页网址长期有效。账号所有者有空时再打开即可；只有点击“开始授权”后才会创建临时 OAuth 会话。',
  'copy-owner-link': '复制所有者页面链接',
  'start-authorization': '开始一次新的授权',
  'temporary-session-ready': '新的 15 分钟授权会话已准备好。',
  'owner-auth-step-1': '打开下面的 Claude 页面，并使用预期账号登录。',
  'owner-auth-step-2': '同意推理与用量查看权限，然后复制完整 code，包括 # 以及后面的全部内容。',
  'owner-auth-step-3': '返回本页粘贴 code 并提交；服务器会自动兑换和保存凭据。',
  'open-claude-authorization': '打开 Claude 授权页面',
  'authorization-code': '完整 authorization code',
  'complete-authorization': '完成授权',
  'owner-auth-security': '密码、浏览器 Cookie、authorization code 和上游 token 都不会展示给管理员；账号邮箱不匹配时会在保存前拒绝。',
  'codex-authorization': 'Codex 账号授权',
  'codex-auth-heading': 'Codex 账号授权',
  'codex-target-seed': '完成后凭据会直接写入下方的 Codex 凭据目录，不在页面上展示。',
  'codex-target-manual': '未配置 Codex 凭据目录，因此生成的 auth.json 只展示一次供你复制或下载。控制台不写入任何文件。',
  'codex-localhost-expected': '最后一步浏览器打不开是正常的。OpenAI 把这个客户端注册在 http://localhost:1455，会把浏览器跳到那里，而本机并没有程序在监听。出现“无法访问”正是成功的表现，不是故障——此时地址栏里就是 authorization code。',
  'codex-auth-step-1': '打开下面的 OpenAI 页面，使用拥有 Codex 订阅的 ChatGPT 账号登录。',
  'codex-auth-step-2': '等浏览器跳到打不开的 localhost 地址，然后从地址栏复制整条地址。',
  'codex-auth-step-3': '粘贴回本页并提交；只粘 code 也可以。服务器会直接与 OpenAI 兑换。',
  'open-codex-authorization': '打开 OpenAI 授权页面',
  'codex-redirect-label': '打不开的 localhost 地址，或仅 code',
  'codex-auth-security': '授权会话一次性使用、15 分钟过期，并在开始新会话时作废。粘贴整条地址时会校验本控制台签发的 state；只粘 code 时没有 state，依赖 PKCE 和「同时只有一个存活会话」。PKCE verifier 加密保存，生成的凭据不会写入 state.json、审计记录或日志。',
  'session-still-open': '这个授权会话仍然有效，你手上的 code 可以再粘贴一次。开始新的授权会让它作废。',
  'codex-account-authorized': '该 Codex 账号已授权',
  'codex-seeded-ok': '凭据已写入配置的 Codex 凭据目录，不在此展示。',
  'continue': '继续',
  'codex-copy-now': '立即复制或下载此凭据',
  'codex-one-time-json': '这是完整的 auth.json，含一个可用的一次性 refresh token。只展示一次，控制台不保留副本，本页无法再次生成。请限制为仅自己可读，凭据中心播种完成后删除。',
  'download-auth-json': '下载 auth.json',
  'copy-auth-json': '复制 auth.json',
  'codex-seed-command': '用它给凭据中心播种',
  'codex-seed-stale': '播种是交接，不是备份：中心第一次轮换就会换掉 refresh token，这个文件当场失效。用完请删除，不要留存。',
  'add-codex-heading': '录入 Codex 团队账号',
  'add-codex-help': '先登记别名，再在该账号自己的页面完成 ChatGPT 订阅授权，不需要另一台机器上的 codex login。',
  'account-email-optional': '账号邮箱标签（可选，授权时校验）',
  'member-flow': '成员实际流程',
  'member-step-1': '成员加入 tailnet 后打开本页。',
  'member-step-2': '在上方成员自助区选择工具和账号，并填写设备名。',
  'member-step-3': '复制或下载只显示一次的本机安装脚本并运行。',
  'member-step-4': '设备丢失或停用时，只撤销该设备。',
  'same-self-service': '管理员和成员看到的是同一个自助区，不再需要人工分发授权凭证。',
  'machines': '机器',
  'machines-intro': '每台机器一行，其持有的全部凭据折叠在下方。机器由一个不透明的随机句柄标识——由机器上的代理上报，或者在机器没有代理可上报时，由本控制台为该次签发生成。这个句柄不说明使用者是谁，旁边的成员标签是自己填写的、不做校验。',
  'no-machines': '还没有任何机器持有凭据。',
  'unattributed-credential': '无法归属的凭据',
  'unattributed-credentials': '未归属到机器的凭据',
  'unattributed-intro': '这些凭据签发于机器句柄出现之前，或者来自不会上报句柄的路径——浏览器不是代理，没有句柄可报。这里不会根据设备名或成员标签相同就自动合并；把某条凭据归入一台机器后，它才会计入那台机器。',
  'legacy-no-handle': '没有机器句柄',
  'count-active': '个有效',
  'count-revoked': '个已撤销',
  'credential': '凭据',
  'credential-type': '类型',
  'credential-status': '凭据状态',
  'credential-active': '有效',
  'credential-revoked': '已撤销',
  'unknown-account': '未知账号',
  'enrolled-at': '登记于',
  'not-reported-here': '不会上报到本控制台',
  'dispenser-managed': '由 dispenser 管理',
  'no-active-credentials': '没有有效凭据。',
  'revoked-credentials': '已撤销的凭据',
  'retired-machines': '没有有效凭据的机器',
  'merge-into-machine': '把这条凭据归入某台机器',
  'merge-credential': '归并',
  'no-merge-targets': '还没有任何机器上报过句柄，因此没有可归入的对象。',
  'codex-legacy-note': '这条 Codex 凭据没有机器句柄：要么它登记于机器句柄出现之前——那台机器上的代理会在下次登记时上报句柄；要么它是本控制台代为签发的——那种凭据永远不会上报，因为生成的安装脚本运行的是 pull.js，不含 enroll.js。无论哪种情况，控制台只读取 dispenser 的注册表，无法把句柄写进去。',
  'codex-inventory-unavailable': '至少有一个凭据目录的 Codex 机器列表读不到，因此只有 dispenser 知道的机器不会出现在这个列表里。',
  'original-account': '原始账号',
  'allowed-accounts': '允许切换的账号',
  'selected-account': '当前所选账号',
  'switch-account': '切换账号',
  'account-switch-working': '正在切换…',
  'account-switch-saved': '已切换到',
  'account-switch-failed': '切换失败，当前页面未刷新；请重试或重新载入页面。',
  'account-selection-invalid': '账号选择配置无效；系统没有擅自猜测账号。',
  'no-claude-accounts': '尚未登记 Claude 账号。',
  'open-account-switch-warning': 'Open 模式没有可验证的操作人：任何能访问控制台的人都可以切换任意有效设备。操作人记录为 anonymous；成员标签不代表操作人。',
  'ai-onboarding-guide': 'AI 接入指引',
  'ai-onboarding-intro': '这是根据当前部署实时生成的内网 Markdown，包含地址、账号状态和配置版本，但绝不包含 token。',
  'open-onboarding-warning': 'Open 模式下，任何能访问本控制台的人都可以读取这份实时指引及其中的部署/账号元数据。请把控制台保持在私有网络内；成员标签未经验证，也不代表操作人身份。',
  'copy-onboarding-link': '复制指引链接',
  'open-onboarding-guide': '打开指引',
  'metrics-dashboard-link': '查看请求指标',
  'metrics-label': '用量洞察',
  'metrics-heading': 'Token 使用量',
  'metrics-intro': '按小时查看 Claude 网关的 Token 消耗、请求健康和设备趋势，并严格区分未知值与零。',
  'metrics-intro-long': '本页只渲染请求元数据，不展示请求正文或回复正文；符合条件的已捕获 API 轮次会在「对话」中展示。',
  'metrics-claude-only': 'Token 核算只覆盖 Claude 网关流量。Codex 客户端直接连接服务商，不在此统计范围内。',
  'metrics-attribution-disclaimer': '使用者标签由本人填写，未经验证；只能用于观察用量趋势，不得作为追责或计费依据。',
  'metrics-status-coverage': '完整覆盖率',
  'metrics-unknown-zero': '— 表示未知，绝不表示零',
  'metrics-filter-toggle': '筛选条件',
  'metrics-filter-heading': '筛选用量',
  'metrics-filter-machine': '机器',
  'metrics-filter-member': '使用者标签',
  'metrics-filter-account': '账号',
  'metrics-filter-model': '模型',
  'metrics-filter-hours': '时间范围',
  'metrics-all-machines': '全部机器',
  'metrics-all-members': '全部使用者',
  'metrics-all-accounts': '全部账号',
  'metrics-all-models': '全部模型',
  'metrics-unattributed-machine': '未归属（没有机器句柄）',
  'metrics-hours-24': '最近 24 小时',
  'metrics-hours-168': '最近 7 天',
  'metrics-hours-720': '最近 30 天',
  'metrics-apply-filters': '应用筛选',
  'metrics-reset-filters': '重置筛选',
  'metrics-unavailable': '请求指标暂时不可用。',
  'metrics-incomplete': '部分请求元数据未能保存，图表可能不完整。',
  'metrics-error': '指标页面无法载入数据。',
  'metrics-total-requests': '全部请求',
  'metrics-consumption-requests': '消耗请求',
  'metrics-known-total': '已知 Token 总量',
  'metrics-known-total-lower-bound': '所选时间范围的下界',
  'metrics-known-total-exact': '完整上报类别的精确总和',
  'metrics-request-outcomes': '成功 / 错误',
  'metrics-request-volume': '请求健康',
  'metrics-request-volume-description': '每小时全部请求、成功请求与错误请求的数量。',
  'metrics-latency': '延迟',
  'metrics-latency-description': '每小时平均首字节时间与请求总耗时，单位为毫秒。',
  'metrics-no-data': '所选时间范围内没有匹配的请求数据。',
  'metrics-series-total': '全部请求',
  'metrics-series-success': '成功请求',
  'metrics-series-error': '错误请求',
  'metrics-series-ttfb': '平均首字节时间（毫秒）',
  'metrics-series-duration': '平均总耗时（毫秒）',
  'metrics-series-input-tokens': '输入 token',
  'metrics-series-cache-creation-input-tokens': '缓存创建输入 token',
  'metrics-series-cache-read-input-tokens': '缓存读取输入 token',
  'metrics-series-output-tokens': '输出 token',
  'metrics-token-input': '输入 token 总量',
  'metrics-token-cache-creation': '缓存创建输入 token 总量',
  'metrics-token-cache-read': '缓存读取输入 token 总量',
  'metrics-token-output': '输出 token 总量',
  'metrics-token-known-count': '已知值条数',
  'metrics-token-coverage-complete': 'Token 总量来自完整的用量记录，可视为精确值。',
  'metrics-token-coverage-complete-with-unknown': '用量记录完整，但 — 类别未由服务商报告。',
  'metrics-token-coverage-lower-bound': 'Token 总量是下界；部分或不可用的用量不会被当作零。',
  'metrics-token-coverage-unavailable': '所选范围的 token 用量不可用；— 表示未知，不是零。',
  'metrics-token-coverage-overflow': '至少一类 token 总量过大，无法精确显示；每请求原始计数仍保留。',
  'metrics-token-coverage-overflow-lower-bound': '至少一类总量过大，无法精确显示；同时部分或不可用记录使可见总和仍只是下界。',
  'metrics-token-complete-count': '完整',
  'metrics-token-partial-count': '部分',
  'metrics-token-unavailable-count': '不可用',
  'metrics-token-trend': '每小时 Token 构成',
  'metrics-token-trend-description': '在真实 UTC 时间轴上堆叠四类已知 Token；未知值保留为空档。',
  'metrics-token-no-data': '所选范围没有可用的 token 用量。',
  'metrics-total-input-tokens': '输入 token',
  'metrics-total-cache-creation-input-tokens': '缓存创建输入 token',
  'metrics-total-cache-read-input-tokens': '缓存读取输入 token',
  'metrics-total-output-tokens': '输出 token',
  'metrics-usage-coverage': '用量覆盖情况',
  'metrics-usage-complete': '完整',
  'metrics-usage-complete-with-unknown': '完整 / 部分类别未知',
  'metrics-usage-partial': '部分 / 下界',
  'metrics-usage-unavailable': '不可用',
  'metrics-usage-not-applicable': '不适用',
  'metrics-usage-overflow': '总量过大，无法精确显示',
  'metrics-hourly-table': '每小时明细',
  'metrics-hour': '小时（UTC）',
  'metrics-request-count': '请求数',
  'metrics-success-count': '成功数',
  'metrics-error-count': '错误数',
  'metrics-request-bytes': '请求字节数',
  'metrics-response-bytes': '响应字节数',
  'metrics-avg-ttfb': '平均首字节时间（毫秒）',
  'metrics-avg-duration': '平均总耗时（毫秒）',
  'tab-overview': '总览',
  'tab-metrics': '用量与指标',
  'tab-conversations': '对话',
  'metrics-conversations-link': '查看对话',
  'metrics-account-breakdown-heading': '按账号查看用量',
  'metrics-account-breakdown-description': '按已知 Token 总量排列用量最高的账号。',
  'metrics-model-breakdown-heading': '按模型查看用量',
  'metrics-model-breakdown-description': '按已知 Token 总量排列用量最高的模型。',
  'metrics-breakdown-no-data': '当前没有可用的 Token 分布数据。',
  'metrics-device-comparison-heading': '设备用量洞察',
  'metrics-device-comparison-description': '比较最活跃设备的已知 Token 总量与每小时趋势；未知值保留为空档，绝不补零。',
  'metrics-device-comparison-scope': '此比较沿用成员、账号、模型和时间筛选；有意忽略单设备机器选择器。',
  'metrics-device-input-comparison-heading': '每小时按设备的输入侧已知 token',
  'metrics-device-input-comparison-description': '仅当 input、缓存创建 input、缓存读取 input 三类都已知时绘制；缺一类就留出空档。',
  'metrics-device-output-comparison-heading': '每小时按设备的输出 token',
  'metrics-device-output-comparison-description': '每条线是 output_tokens；未知输出留空，不当作零。',
  'metrics-device-ranking-heading': '按设备的已知 Token',
  'metrics-device-ranking-description': '所选范围内的输入侧已知 Token 与输出 Token。',
  'metrics-device-trend-heading': '每小时设备趋势',
  'metrics-device-trend-description': '在完整输入侧已知 Token 与输出 Token 之间切换。',
  'metrics-device-toggle-input': '输入侧',
  'metrics-device-toggle-output': '输出',
  'metrics-static-fallback-toggle': '显示静态图表备用视图',
  'metrics-device-comparison-known-sum': '设备趋势线',
  'metrics-device-comparison-known-points': '已知点',
  'metrics-device-comparison-unknown-points': '未知点',
  'metrics-device-comparison-coverage': '覆盖情况',
  'metrics-device-comparison-device': '设备',
  'metrics-device-comparison-complete': '完整',
  'metrics-device-comparison-partial': '部分 / 下界',
  'metrics-device-comparison-unavailable': '不可用',
  'metrics-device-comparison-no-data': '没有可用的跨设备 token 比较数据。',
  'metrics-device-comparison-truncated': '最多显示八台设备；其余设备已省略。',
  'metrics-device-comparison-devices-truncated': '最多显示八台设备；其余设备已省略。',
  'metrics-device-comparison-hours-truncated': '每小时比较有界；部分小时已省略。',
  'metrics-device-comparison-unavailable-devices': '部分设备无法用于比较。',
  'metrics-device-comparison-table-caption': '四类原始 token 值与覆盖情况备用表',
  'metrics-device-comparison-table-toggle': '显示原始比较表',
  'metrics-device-comparison-table-truncated': '原始表只显示最新 200 行；更早的行已省略。',
  'metrics-hourly-table-caption': '每小时请求与 token 明细',
  'metrics-hourly-table-toggle': '显示每小时明细',
  'metrics-hourly-table-truncated': '每小时表只显示最新 200 行；更早的行已省略。',
  'metrics-scroll-table-hint': '可横向滑动查看全部列。',
  'metrics-methodology-toggle': '统计范围、隐私与归因说明',
  'conversations-dashboard-link': '查看对话',
  'conversations-label': 'API 片段诊断',
  'conversations-heading': 'API 片段诊断',
  'conversations-intro': '这里保留按请求捕获的 Claude API 片段用于诊断；它们可能是包装、提醒或工具循环中间态，不是用户回合，也不会被猜测拼成对话。',
  'conversation-subnav-sessions': '对话',
  'conversation-subnav-turns': 'API 片段诊断',
  'conversation-sessions-label': '可靠的 Hook 对话',
  'conversation-sessions-heading': '对话',
  'conversation-sessions-intro': '每一轮把 Claude Code UserPromptSubmit 提交的原始文字与同一 prompt 的最终 Stop 回复配对；工具循环 API 请求不会再伪装成用户轮次。session/prompt 标识只保存设备绑定的 HMAC。',
  'conversation-session-heading': '对话',
  'conversation-session-open': '打开对话',
  'conversation-session-open-turn': '打开本轮',
  'conversation-session-turn-count': '轮次数',
  'conversation-session-first-at': '首次提问',
  'conversation-session-last-at': '最近活动',
  'conversation-session-latest-preview': '轮次预览',
  'conversation-session-total-matches': '个匹配对话',
  'conversation-session-no-results': '没有符合当前筛选条件的可靠对话。',
  'conversation-session-pagination-hint': '对话按最近活动时间从新到旧排列。',
  'conversation-session-filter-hint': '筛选只匹配 Hook 支持的可靠用户轮次；API 片段请在诊断页单独搜索。',
  'conversation-session-search': '搜索对话',
  'conversation-session-filter-invalid': '一个或多个对话筛选值无效或过长。请清除筛选条件后重试。',
  'conversation-session-search-query-too-short': '搜索词对当前对话归档太短。大库中至少输入连续 3 个中文字符或更多可检索文字；请去掉单独特殊标点，并拆开查询。',
  'conversation-session-search-requires-indexed-terms': '对话搜索需要可建立索引的词。大库中请输入至少连续 3 个中文字符，去掉特殊标点，或拆开查询。',
  'conversation-session-search-error': '对话搜索无法完成。',
  'conversation-session-read-error': '对话无法载入。',
  'conversation-session-not-found': '找不到这个对话。',
  'conversation-session-back': '返回对话列表',
  'conversation-session-detail-intro': '以下轮次按同一 Claude Code session 的提问顺序排列；每个面板把 UserPromptSubmit 与同一 prompt 的 Stop 终态配对。原始标识不入库，设备上报也不等于真人身份认证。',
  'conversation-session-turn': '轮',
  'conversation-session-incomplete-turn': '这个 API 轮次结束时，尚未捕获到完整的助手回复。',
  'conversation-session-truncated-turn': '助手正文达到有界上限，当前捕获内容并不完整。',
  'conversation-session-empty-assistant': '未捕获助手正文。这个轮次可能包含工具活动，或者回复正文当时不可用。',
  'conversation-session-timeline-clipped': '时间线会缩短过长的助手正文；请打开对应单轮查看完整的已捕获文本。',
  'conversation-session-truncated': '此对话超过时间线的有界预算；仅显示最早的连续前缀（最多 200 轮、8 MiB 已存文本），完整正文可逐轮打开查看。',
  'conversation-session-empty': '这个对话中没有可显示的可靠轮次。',
  'conversation-legacy-fragments-heading': '保留用于诊断的旧 API 片段',
  'conversation-legacy-fragments-notice': '这些旧行来自单个 API 请求，不是用户回合，系统绝不会按时间把它们猜测成对话。',
  'conversation-legacy-fragments-link': '打开 API 片段诊断',
  'conversation-round-privacy-heading': '可靠对话隐私告知',
  'conversation-round-privacy-notice': '启用 Hook 的 Claude Code profile 会把客户端提交的原始提问与最终显示的助手回复永久发送到本控制台，并向所有控制台成员公开。Hook 不会拒绝或终止 Claude，但同步命令 Hook 失败时可能产生有界延迟。数据由设备上报，网关不认证真人身份；Codex 流量不在范围内。',
  'conversation-round-empty-heading': '还没有可靠的用户轮次',
  'conversation-round-empty-copy': '安装 Claude Code 对话采集更新后，UserPromptSubmit 与 Stop 才会组成可靠对话。现有 API 片段只保留在诊断页，绝不会被猜测归组。',
  'conversation-round-install-hooks': '安装对话采集更新',
  'conversation-user-message': '用户提交的消息',
  'conversation-final-response': '最终回复',
  'conversation-hook-prompt-disclaimer': '直接取自 Claude Code UserPromptSubmit，是客户端提交的原始文字；但设备上报不等于真人身份认证。',
  'conversation-prompt-source-hook': '来源：Claude Code UserPromptSubmit Hook',
  'conversation-round-prompt-at': '提问时间',
  'conversation-round-pending': '已收到提问，正在等待最终 Stop Hook。',
  'conversation-round-failed': 'Claude Code 报告本轮失败。',
  'conversation-round-unavailable': '提问已保留，但 session 结束前没有收到最终回复 Hook。',
  'conversation-round-response-pending': '正在等待最终回复。',
  'conversation-round-empty-response': '本轮没有上报最终助手文字。',
  'conversation-round-prompt-truncated': '提问超过存储上限；仅保留完整 UTF-8 前缀。',
  'conversation-round-response-truncated': '最终回复超过存储上限；仅保留完整 UTF-8 前缀。',
  'conversation-round-not-found': '找不到这条可靠对话轮次。',
  'conversation-round-read-error': '对话轮次无法载入。',
  'conversation-round-label': '可靠用户轮次',
  'conversation-failure-rate-limit': '受到速率限制',
  'conversation-failure-overloaded': '服务商负载过高',
  'conversation-failure-authentication-failed': '认证失败',
  'conversation-failure-oauth-org-not-allowed': '当前组织不允许使用',
  'conversation-failure-billing-error': '计费状态错误',
  'conversation-failure-invalid-request': '请求无效',
  'conversation-failure-model-not-found': '找不到模型',
  'conversation-failure-server-error': '服务商服务器错误',
  'conversation-failure-max-output-tokens': '已达到最大输出长度',
  'conversation-failure-session-end': 'Session 在最终回复前结束',
  'conversation-failure-unavailable': '回复不可用',
  'conversation-failure-unknown': '未知失败',
  'conversation-standalone-heading': '未归组的已捕获轮次',
  'conversation-standalone-notice': '这些旧轮次或无法关联的 API 轮次没有格式校验通过的会话标识，系统绝不会按时间猜测归组。',
  'conversation-standalone-link': '查看未归组轮次和全部已捕获 API 轮次',
  'conversation-privacy-heading': 'API 片段隐私告知',
  'conversation-privacy-notice': '此诊断归档会永久保存有界的 Claude API 请求/响应片段。它们可能包含客户端包装、提醒或工具中间态，不是经过验证的人类对话；所有控制台成员都可读取。Codex 流量不在范围内。',
  'conversation-open-warning': 'Open 模式：tailnet 中任何能访问本控制台的人都可以读取所有对话与 API 片段；没有身份识别，也没有阅读审计。成员标签不代表操作人身份。',
  'conversation-search': '搜索已捕获 API 轮次',
  'conversation-search-submit': '搜索',
  'conversation-search-clear': '清除',
  'conversation-next-page': '下一页',
  'conversation-filters-heading': '筛选条件',
  'conversation-filter-hint': '输入文字可搜索成员建议；留空表示全部成员。',
  'conversation-filter-period-label': '时间范围',
  'conversation-filter-member-label': '成员',
  'conversation-filter-device-label': '设备',
  'conversation-filter-account-label': '账号',
  'conversation-filter-model-label': '模型',
  'conversation-filter-state-label': '回复状态',
  'conversation-filter-limit-label': '每页行数',
  'conversation-period-all': '全部时间',
  'conversation-period-24': '最近 24 小时',
  'conversation-period-168': '最近 7 天',
  'conversation-period-720': '最近 30 天',
  'conversation-all-members': '全部成员',
  'conversation-all-devices': '全部设备',
  'conversation-all-accounts': '全部账号',
  'conversation-all-models': '全部模型',
  'conversation-all-states': '全部回复状态',
  'conversation-total-matches': '条匹配 API 片段',
  'conversation-pagination-hint': 'API 片段按最新时间优先排列。',
  'conversation-facets-truncated': '部分筛选值未列出；当前选中的值仍然可用。',
  'conversation-filter-query': '查询',
  'conversation-filter-period': '时间',
  'conversation-filter-member': '成员',
  'conversation-filter-device': '设备',
  'conversation-filter-account': '账号',
  'conversation-filter-model': '模型',
  'conversation-filter-state': '状态',
  'conversation-device': '设备',
  'conversation-open': '打开 API 片段',
  'conversation-no-results': '没有符合此搜索条件的 API 片段。',
  'conversation-search-error': 'API 轮次搜索无法完成。',
  'conversation-search-query-too-short': '搜索词对当前 API 轮次归档太短。大库中至少输入连续 3 个中文字符或更多可检索文字；请去掉单独特殊标点，并拆开查询。',
  'conversation-search-requires-indexed-terms': 'API 轮次搜索需要可建立索引的词。大库中请输入至少连续 3 个中文字符，去掉特殊标点，或拆开查询。',
  'conversation-filter-invalid': '一个或多个 API 轮次筛选值无效或过长。请清除筛选条件后重试。',
  'conversation-read-error': '已捕获 API 轮次无法载入。',
  'conversation-not-found': '找不到这条已捕获 API 轮次。',
  'conversation-detail-heading': 'API 片段',
  'conversation-back': '返回 API 片段诊断',
  'conversation-unknown-id': 'API 片段',
  'conversation-captured-at': '捕获时间',
  'conversation-member-label': '成员标签',
  'conversation-account': '账号',
  'conversation-model': '模型',
  'conversation-prompt': '已捕获的 API 用户文本',
  'conversation-prompt-disclaimer': '文本取自 API 最后一条 user 消息，可能包含 Claude Code 或其他客户端包装，不保证就是用户原话。',
  'conversation-prompt-source-captured': '来源：捕获的 API 用户文本',
  'conversation-prompt-source-wrapper': '来源：已去除可识别的客户端包装',
  'conversation-prompt-source-fallback': '来源：捕获原文（未识别包装，采用安全备用显示）',
  'conversation-prompt-source-empty': '来源：不可用',
  'conversation-prompt-suffix-omitted': '当前显示已省略有界尾部；被省略的文本不会显示。',
  'conversation-response': '回复',
  'conversation-empty-prompt': '未捕获 API 用户文本',
  'conversation-empty-response': '未捕获回复正文',
  'conversation-queue-dropped': '有 API 轮次采集任务被有界队列丢弃。',
  'conversation-round-dropped': '有可靠对话轮次未能写入持久化存储。',
  'conversation-response-complete': '回复完整',
  'conversation-response-pending': '等待回复',
  'conversation-response-failed': '本轮失败',
  'conversation-response-incomplete': '回复不完整',
  'conversation-response-truncated': '回复已截断',
  'conversation-response-unavailable': '回复不可用',
  'conversation-hook-upgrade-heading': '为现有 Claude profile 启用可靠对话',
  'conversation-hook-upgrade-copy': '这个不含 Token 的更新器会保留现有设置并安装同步 Claude Code 命令 Hook。它只在发送事件时读取 profile 已有的 mode-600 设备 Token；不会登录、轮换、打印或替换任何凭证。',
  'conversation-hook-upgrade-privacy': '安装后，本控制台会永久保存 Claude 用户提交的提示词与最终可见助手回复，并向所有控制台成员公开。Hook 不会拒绝或终止 Claude，但同步命令 Hook 失败时可能产生有界延迟。',
  'conversation-hook-version-note': '可靠配对要求 Claude Code 2.1.196 或更高版本；旧版本没有形成可靠轮次所需的 prompt ID。',
  'conversation-hook-download': '下载 Hook 更新器',
  'conversation-hook-copy': '复制更新器源码',
  'conversation-hook-run-heading': '在本机对每个已安装 profile 各运行一次',
  'conversation-hook-restart-note': '更新完成后重启 Claude Code。Hook 失败不会拒绝或终止 Claude，但同步命令 Hook 失败时可能增加有界延迟；其他投递失败会静默退出。',
  'conversation-hook-installer-privacy': '此 profile 会在控制台永久保存 Claude 用户提交的提示词与最终可见助手回复，所有控制台成员均可读取。Hook 不会拒绝或终止 Claude，也不会修改设备 Token，但同步命令 Hook 失败时可能产生有界延迟。',
  'choose-codex-platform': '选择这台设备的操作系统',
  'codex-profile-ready': '此安装器会新增一个隔离的 Codex profile，不会修改默认的 ~/.codex 账号。',
  'one-platform-only': '请只在刚登记的这台设备上选择一种安装器使用，不要把这些脚本复用到其他机器。',
  'view-script': '查看脚本',
  'one-time-token': '此单文件脚本包含仅属于当前设备的 token，只显示一次；运行时不需要访问内网控制台。请限制为仅自己可读，并在安装成功后删除。',
  'download-installer': '下载安装脚本',
  'copy-installer': '复制安装脚本',
  'run-instructions': '运行方法',
  'back-dashboard': '返回控制台',
  'claude-copy-now': '立即复制或下载此配置',
  'claude-one-time-token': '此设备 token 只显示一次，之后无法从控制台恢复。启动器只会将它注入 Claude Code 的显式网关模式，并由 Claude Code 从子进程环境中清除，因此不要求本机安装沙箱软件。丢失时请重新登记，并在使用后删除下载的安装器。',
  'download-unix-setup': '下载 macOS/Linux 配置',
  'copy-unix-setup': '复制 macOS/Linux 配置',
  'download-windows-setup': '下载 PowerShell 配置',
  'copy-windows-setup': '复制 PowerShell 配置',
  'closing-hides-token': '关闭或刷新本页后，凭据将永久隐藏。',
  'do-not-codex-login': '安装后不要运行 codex login。代理会写入订阅凭据并自动更新。',
  'enroll-heading': '登记设备',
  'create-device-credential': '创建设备凭据',
  'device-scope-note': '生成的凭据仅属于此设备，可单独撤销而不影响其他人。',
  // Read by name from the copy button below, not through a data-i18n attribute.
  'copied': '已复制',
  'revoke': '撤销',
  'enroll-device': '登记设备',
  'delete-account': '删除账号',
  'existing-codex-agent': '现有 Codex 代理',
  'status-healthy': '健康',
  'status-unhealthy': '异常',
  'status-expired': '已过期',
  'status-invalid': '无效',
  'status-unavailable': '不可用',
  'status-stored': '已保存',
  'status-login-required': '需要登录',
  'status-pending': '等待中',
  'credential-health-heading': '凭据健康度',
  'credential-health-intro': '来自安全公开元数据的实时凭据状态。',
  'credential-critical-label': '个严重问题',
  'credential-warning-label': '个警告',
  'credential-all-clear-badge': '一切正常',
  'credential-all-clear': '没有活跃的凭据警报。',
  'credential-no-accounts': '尚未登记提供商账号。',
  'credential-alert-more': '更多凭据警报见下方账号表。',
  'credential-severity-critical': '严重',
  'credential-severity-warning': '警告',
  'credential-severity-neutral': '处理中',
  'credential-severity-ok': '正常',
  'credential-alert-current-invalid': '当前 Codex 凭据元数据无效。',
  'credential-alert-current-unavailable': '当前 Codex 凭据无法读取。',
  'credential-alert-access-expired': '凭据已过期。',
  'credential-alert-access-expires-24h': '凭据将在 24 小时内过期。',
  'credential-alert-access-expires-3d': '凭据将在 3 天内过期。',
  'credential-alert-access-expires-7d': '凭据将在 7 天内过期。',
  'credential-alert-credential-unavailable': '凭据当前不可用。',
  'credential-alert-health-missing': '刷新健康快照缺失。',
  'credential-alert-health-invalid': '刷新健康快照无效。',
  'credential-alert-health-unavailable': '刷新健康快照暂时无法读取。',
  'credential-alert-health-stale': '刷新健康快照已过时。',
  'credential-alert-refresh-failed': '最近一次凭据刷新失败。',
  'credential-alert-refresh-quarantined': '凭据刷新已进入隔离状态。',
  'credential-alert-refresh-stuck': '凭据刷新周期运行时间过长。',
  'credential-alert-refreshing': '凭据刷新正在进行中。',
  'credential-alert-persist': '凭据刷新持久化失败。',
  'credential-alert-persist-failed': '凭据刷新持久化失败。',
  'credential-alert-publish': '凭据发布失败。',
  'credential-alert-publish-failed': '凭据发布失败。',
  'credential-alert-read-failed': '凭据状态读取失败。',
  'credential-alert-unreadable': '凭据状态不可读。',
  'credential-alert-unhandled': '凭据刷新发生未处理故障。',
  'credential-alert-operation-blocked': '凭据刷新操作被阻止。',
  'credential-alert-configuration-invalid': '凭据刷新配置无效。',
  'credential-alert-quarantine': '凭据刷新已隔离。',
  'credential-alert-provider-rejected': '提供商拒绝了凭据刷新。',
  'credential-alert-timeout': '凭据刷新超时。',
  'credential-alert-pre-mint-rejected': '凭据刷新在签发前被拒绝。',
  'credential-alert-account-unhealthy': '账号当前不健康。',
  'credential-alert-login-required': '需要完成账号登录。',
  'credential-alert-pending': '账号仍在等待授权。',
  'expires-unknown': '不可用',
  'expires-in': '将在',
  'expires-ago': '已过期',
  'last-successful-check': '最近成功凭据检查',
  'last-rotation': '最近轮换',
  'credential-history': '凭证历史',
  'accounts-table-caption': '账号及安全健康元数据'
};

const LANGUAGE_STORAGE_KEY = 'credential_console_language';
const LANGUAGE_UPDATED_STORAGE_KEY = 'credential_console_language_updated_at';
const LANGUAGE_COOKIE = 'credential_console_language';

function languageCookie() {
  try {
    for (const entry of document.cookie.split(';')) {
      const index = entry.indexOf('=');
      if (index < 1 || entry.slice(0, index).trim() !== LANGUAGE_COOKIE) continue;
      const value = decodeURIComponent(entry.slice(index + 1).trim());
      const parts = value.split('.');
      if (parts.length > 2 || (parts[0] !== 'zh' && parts[0] !== 'en')) return null;
      if (parts[1] !== undefined && !/^[0-9]{1,16}$/.test(parts[1])) return null;
      const updatedAt = Number(parts[1] ?? 0);
      return {
        language: parts[0],
        updatedAt: Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
      };
    }
  } catch {
    // Cookies can be unavailable in sandboxed or hardened browser contexts.
  }
  return null;
}

function localLanguage() {
  try {
    const language = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (language !== 'zh' && language !== 'en') return null;
    const updatedAt = Number(localStorage.getItem(LANGUAGE_UPDATED_STORAGE_KEY) ?? 0);
    return {
      language,
      updatedAt: Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function storedLanguage() {
  const local = localLanguage();
  const cookie = languageCookie();
  if (local && cookie) {
    // Timestamped writes resolve partial/silently ignored browser storage. A
    // tie keeps the legacy localStorage preference for backward compatibility.
    return cookie.updatedAt > local.updatedAt ? cookie.language : local.language;
  }
  if (local) return local.language;
  if (cookie) return cookie.language;
  return String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function persistLanguage(language) {
  const updatedAt = Date.now();
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    localStorage.setItem(LANGUAGE_UPDATED_STORAGE_KEY, String(updatedAt));
  } catch {
    // Cookie fallback still applies.
  }
  try {
    document.cookie = LANGUAGE_COOKIE + '=' + encodeURIComponent(language + '.' + updatedAt)
      + '; Path=/; Max-Age=31536000; SameSite=Strict';
  } catch {
    // A language preference is optional; never break the rest of the UI.
  }
}

function currentLanguage() {
  return document.documentElement.lang === 'zh-CN' ? 'zh' : 'en';
}

// Translate one subtree. Needed as a unit because results are re-rendered in
// place: freshly inserted nodes carry data-i18n and would otherwise stay English
// on a Chinese page.
function translateSubtree(root, selected) {
  root.querySelectorAll('[data-i18n]').forEach((element) => {
    if (!element.dataset.i18nEn) element.dataset.i18nEn = element.textContent;
    element.textContent = selected === 'zh'
      ? (translations[element.dataset.i18n] ?? element.dataset.i18nEn)
      : element.dataset.i18nEn;
  });
  root.querySelectorAll('[data-placeholder-en]').forEach((element) => {
    element.placeholder = selected === 'zh'
      ? (element.dataset.placeholderZh ?? element.dataset.placeholderEn)
      : element.dataset.placeholderEn;
  });
}

function applyLanguage(language) {
  const selected = language === 'zh' ? 'zh' : 'en';
  document.documentElement.lang = selected === 'zh' ? 'zh-CN' : 'en';
  translateSubtree(document, selected);
  document.querySelectorAll('[data-account-option], [data-account-label]').forEach((element) => {
    const alias = element.dataset.accountAlias ?? '';
    const status = element.dataset.accountStatus ?? '';
    const key = 'status-' + status.replaceAll('_', '-');
    const englishStatus = status.replaceAll('_', ' ');
    const translatedStatus = selected === 'zh' ? (translations[key] ?? englishStatus) : englishStatus;
    element.textContent = alias + ' · ' + translatedStatus;
  });

  document.querySelectorAll('[data-metric-point-title]').forEach((element) => {
    if (!element.dataset.metricPointTitleEn) element.dataset.metricPointTitleEn = element.textContent;
    const key = element.dataset.metricSeriesKey ?? '';
    const tail = element.dataset.metricPointTail ?? '';
    element.textContent = selected === 'zh'
      ? (translations[key] ?? element.dataset.metricPointTitleEn.split(' · ')[0]) + ' · ' + tail
      : element.dataset.metricPointTitleEn;
  });
  document.querySelectorAll('[data-language]').forEach((button) => {
    button.classList.toggle('active', button.dataset.language === selected);
    button.setAttribute('aria-pressed', button.dataset.language === selected ? 'true' : 'false');
  });
  document.querySelectorAll('[data-account-switch-status][data-account-switch-result]').forEach((node) => {
    renderAccountSwitchStatus(
      node,
      node.dataset.accountSwitchResult,
      node.dataset.accountAlias ?? '',
    );
  });
  persistLanguage(selected);
  document.documentElement.removeAttribute('data-language-pending');
  window.dispatchEvent(new CustomEvent('credential-console-language', { detail: { language: selected } }));
}

applyLanguage(storedLanguage());

function sessionStateGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionStateSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // State restoration is progressive enhancement only.
  }
}

function sessionStateRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // State restoration is progressive enhancement only.
  }
}

const pageStateUrl = new URL(location.href);
pageStateUrl.searchParams.delete('draft_completed');
const pageStateKey = pageStateUrl.pathname + pageStateUrl.search;
const conversationFilterMedia = window.matchMedia?.('(max-width: 800px)');
const metricsFilterMedia = window.matchMedia?.('(max-width: 640px)');

function detailsStateKey(details) {
  return 'credential_console_details:' + pageStateKey + ':' + details.dataset.persistDetails;
}

function forcedDesktopFilter(details) {
  return (details.classList.contains('conversation-filter-details')
      && conversationFilterMedia && !conversationFilterMedia.matches)
    || (details.classList.contains('metrics-filter-details')
      && metricsFilterMedia && !metricsFilterMedia.matches);
}

function mobileFilterDefault(details) {
  return (details.classList.contains('conversation-filter-details')
      && conversationFilterMedia?.matches)
    || (details.classList.contains('metrics-filter-details')
      && metricsFilterMedia?.matches);
}

function restoreDetails(details) {
  const stored = sessionStateGet(detailsStateKey(details));
  if (forcedDesktopFilter(details)) details.open = true;
  else if (stored === 'open' || stored === 'closed') details.open = stored === 'open';
  else if (mobileFilterDefault(details)) details.open = false;
}

document.querySelectorAll('details[data-persist-details]').forEach((details) => {
  restoreDetails(details);
  details.addEventListener('toggle', () => {
    // Desktop filter rails are forced open by layout. Do not let that
    // temporary presentation overwrite the member's mobile preference.
    if (!forcedDesktopFilter(details)) {
      sessionStateSet(detailsStateKey(details), details.open ? 'open' : 'closed');
    }
  });
});

function syncResponsiveDetails(selector) {
  document.querySelectorAll(selector).forEach(restoreDetails);
}
conversationFilterMedia?.addEventListener?.('change', () => {
  syncResponsiveDetails('.conversation-filter-details[data-persist-details]');
});
metricsFilterMedia?.addEventListener?.('change', () => {
  syncResponsiveDetails('.metrics-filter-details[data-persist-details]');
});

const SAFE_DRAFT_FIELDS = new Set([
  'account_id',
  'alias',
  'device_name',
  'email_label',
  'member_label',
]);
const SAFE_DRAFT_KEYS = new Set([
  'claude-self-service',
  'codex-self-service',
  'register-claude-account',
  'register-codex-account',
]);

const completedDraft = document.documentElement.dataset.completedDraft ?? '';
if (SAFE_DRAFT_KEYS.has(completedDraft)) {
  sessionStateRemove('credential_console_draft:/:' + completedDraft);
  try {
    const canonical = new URL(location.href);
    if (canonical.searchParams.get('draft_completed') === completedDraft) {
      canonical.searchParams.delete('draft_completed');
      history.replaceState(history.state, '', canonical.pathname + canonical.search + canonical.hash);
    }
  } catch {
    // The draft is already cleared; URL cleanup is cosmetic.
  }
}

function formDraftKey(form) {
  return 'credential_console_draft:' + location.pathname + ':' + form.dataset.persistDraft;
}

function formDraftFields(form) {
  return [...form.querySelectorAll('[data-draft-field][name]')]
    .filter((field) => SAFE_DRAFT_FIELDS.has(field.name));
}

function saveFormDraft(form) {
  const values = {};
  formDraftFields(form).forEach((field) => {
    values[field.name] = String(field.value ?? '').slice(0, 256);
  });
  sessionStateSet(formDraftKey(form), JSON.stringify(values));
}

function restoreFormDraft(form) {
  const stored = sessionStateGet(formDraftKey(form));
  if (!stored || stored.length > 4096) return;
  let values;
  try {
    values = JSON.parse(stored);
  } catch {
    return;
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  formDraftFields(form).forEach((field) => {
    if (typeof values[field.name] !== 'string') return;
    const value = values[field.name].slice(0, 256);
    if (field instanceof HTMLSelectElement
      && ![...field.options].some((option) => option.value === value)) return;
    field.value = value;
  });
}

document.querySelectorAll('form[data-persist-draft]').forEach((form) => {
  restoreFormDraft(form);
  form.addEventListener('input', () => saveFormDraft(form));
  form.addEventListener('change', () => saveFormDraft(form));
});

const scrollStateKey = 'credential_console_scroll:' + pageStateKey;
const skipScrollStateKey = 'credential_console_skip_scroll:' + pageStateKey;
const skipScrollRestore = sessionStateGet(skipScrollStateKey) === 'true';
if (skipScrollRestore) {
  sessionStateRemove(skipScrollStateKey);
  sessionStateSet(scrollStateKey, '0');
}
const navigationType = performance.getEntriesByType?.('navigation')?.[0]?.type;
if (!skipScrollRestore && navigationType !== 'back_forward') {
  const savedScroll = Number(sessionStateGet(scrollStateKey));
  if (Number.isFinite(savedScroll) && savedScroll > 0) {
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: savedScroll })));
  }
}
window.addEventListener('pagehide', () => {
  sessionStateSet(scrollStateKey, String(Math.max(0, Math.round(window.scrollY))));
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest?.('form[data-reset-scroll]');
  if (!form) return;
  try {
    const destination = new URL(form.action, location.href);
    if (String(form.method).toLowerCase() === 'get') {
      destination.search = new URLSearchParams(new FormData(form)).toString();
    }
    sessionStateSet(
      'credential_console_skip_scroll:' + destination.pathname + destination.search,
      'true',
    );
  } catch {
    // Navigation remains functional without scroll-state enhancement.
  }
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP-only private overlays are not always a secure browser context.
      // Fall through to a user-gesture copy that does not need Clipboard API.
    }
  }
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  fallback.style.pointerEvents = 'none';
  document.body.appendChild(fallback);
  let copied = false;
  try {
    fallback.focus();
    fallback.select();
    copied = document.execCommand('copy');
  } finally {
    fallback.remove();
  }
  if (!copied) throw new Error('copy failed');
}

function translatedText(key, english) {
  return currentLanguage() === 'zh' ? (translations[key] ?? english) : english;
}

function safeAccountStatus(value) {
  const status = String(value ?? 'unavailable');
  return /^[a-z][a-z0-9_]{0,31}$/.test(status) ? status : 'unavailable';
}

function accountStatusText(status) {
  const key = 'status-' + status.replaceAll('_', '-');
  return translatedText(key, status.replaceAll('_', ' '));
}

function renderAccountSwitchStatus(node, state, alias = '') {
  if (!node) return;
  node.dataset.accountSwitchResult = state;
  node.dataset.accountAlias = alias;
  node.className = 'tiny account-switch-status';
  if (state === 'saved') {
    node.classList.add('success');
    node.textContent = translatedText('account-switch-saved', 'Switched to') + ' ' + alias;
  } else if (state === 'failed') {
    node.classList.add('error');
    node.textContent = translatedText(
      'account-switch-failed',
      'Switch failed without refreshing this page. Try again or reload.',
    );
  } else {
    node.textContent = translatedText('account-switch-working', 'Switching…');
  }
}

function updateAllowedAccounts(form, accounts) {
  const target = form.closest('[data-device-row]')?.querySelector('[data-allowed-account-list]');
  if (!target || !Array.isArray(accounts)) return;
  const fragment = document.createDocumentFragment();
  accounts.forEach((account, index) => {
    if (index > 0) fragment.append(document.createTextNode(', '));
    const span = document.createElement('span');
    const status = safeAccountStatus(account?.status);
    span.dataset.accountLabel = '';
    span.dataset.accountAlias = String(account?.alias ?? account?.id ?? '');
    span.dataset.accountStatus = status;
    span.textContent = span.dataset.accountAlias + ' · ' + accountStatusText(status);
    fragment.append(span);
  });
  if (!accounts.length) fragment.append(document.createTextNode('—'));
  target.replaceChildren(fragment);
}

function updateAccountOptions(form, accounts) {
  if (!Array.isArray(accounts)) return;
  const byId = new Map(accounts.map((account) => [String(account?.id ?? ''), account]));
  form.querySelectorAll('[data-account-option]').forEach((option) => {
    const account = byId.get(option.value);
    if (!account) return;
    option.dataset.accountAlias = String(account.alias ?? account.id ?? '');
    option.dataset.accountStatus = safeAccountStatus(account.status);
    option.textContent = option.dataset.accountAlias + ' · ' + accountStatusText(option.dataset.accountStatus);
  });
}

function updateAccountCounts(counts) {
  if (!Array.isArray(counts)) return;
  counts.forEach((entry) => {
    const id = String(entry?.id ?? '');
    const count = Number(entry?.active_devices);
    if (!id || !Number.isSafeInteger(count) || count < 0) return;
    document.querySelectorAll('[data-account-row]').forEach((row) => {
      if (row.dataset.accountRow !== id) return;
      const target = row.querySelector('[data-account-device-count]');
      if (target) target.textContent = String(count);
    });
  });
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest?.('form[data-account-switch]');
  if (!form || typeof fetch !== 'function' || typeof FormData !== 'function') return;
  event.preventDefault();
  if (form.dataset.submitting === 'true') return;
  const row = form.closest('[data-device-row]');
  const select = form.elements.selected_account_id;
  const button = form.querySelector('button[type="submit"]');
  const statusNode = form.querySelector('[data-account-switch-status]');
  const committedAccountId = row?.dataset.selectedAccountId ?? '';
  form.dataset.submitting = 'true';
  form.setAttribute('aria-busy', 'true');
  renderAccountSwitchStatus(statusNode, 'working');
  try {
    const submittedForm = new FormData(form);
    if (button) button.disabled = true;
    if (select) select.disabled = true;
    const body = new URLSearchParams();
    for (const [key, value] of submittedForm) body.append(key, String(value));
    const response = await fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Credential-Console-Async': 'account-switch',
      },
      body,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const result = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok || result?.ok !== true || !result.account) throw new Error('account switch failed');
    const accountId = String(result.selected_account_id ?? '');
    const alias = String(result.account.alias ?? '');
    const accountStatus = safeAccountStatus(result.account.status);
    if (!accountId || !alias || accountId !== String(result.account.id ?? '')) {
      throw new Error('account switch response invalid');
    }
    if (row) row.dataset.selectedAccountId = accountId;
    if (select) select.value = accountId;
    const cell = row?.querySelector('[data-selected-account-cell]');
    if (cell) {
      cell.dataset.accountStatus = accountStatus;
      const aliasNode = cell.querySelector('[data-selected-account-alias]');
      if (aliasNode) aliasNode.textContent = alias;
      const statusTarget = cell.querySelector('[data-selected-account-status]');
      if (statusTarget) {
        const badge = document.createElement('span');
        badge.className = 'badge ' + accountStatus;
        badge.dataset.i18n = 'status-' + accountStatus.replaceAll('_', '-');
        badge.textContent = accountStatus.replaceAll('_', ' ');
        statusTarget.replaceChildren(badge);
      }
    }
    updateAllowedAccounts(form, result.allowed_accounts);
    updateAccountOptions(form, result.account_options);
    updateAccountCounts(result.account_device_counts);
    applyLanguage(currentLanguage());
    renderAccountSwitchStatus(statusNode, 'saved', alias);
  } catch {
    if (select && committedAccountId) select.value = committedAccountId;
    renderAccountSwitchStatus(statusNode, 'failed');
  } finally {
    form.dataset.submitting = 'false';
    form.removeAttribute('aria-busy');
    if (button) button.disabled = false;
    if (select) select.disabled = false;
  }
});

document.addEventListener('click', async (event) => {
  const languageButton = event.target.closest('[data-language]');
  if (languageButton) {
    applyLanguage(languageButton.dataset.language);
    return;
  }
  const button = event.target.closest('[data-copy-target]');
  if (button) {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    await copyText(target.textContent);
    const previous = button.textContent;
    button.textContent = currentLanguage() === 'zh' ? translations.copied : 'Copied';
    setTimeout(() => { button.textContent = previous; }, 1600);
    return;
  }
  const download = event.target.closest('[data-download-target]');
  if (download) {
    const target = document.getElementById(download.dataset.downloadTarget);
    if (!target) return;
    const blob = new Blob([target.textContent], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = download.dataset.downloadName;
    anchor.click();
    URL.revokeObjectURL(href);
  }
});

// ---------------------------------------------------------------------------
// Boosted navigation
//
// Tabs, sub-nav and detail links were full document loads. Over a ~207 ms round
// trip that means re-downloading and re-parsing the shell, the styles and the
// script to change the part of the page that actually differs.
//
// A click now fetches only the page region and swaps it into the existing
// document. Progressive enhancement throughout: anything unexpected falls back
// to the navigation the browser would have done anyway.
// ---------------------------------------------------------------------------

function navigationSupported() {
  return typeof window.fetch === 'function'
    && typeof window.AbortController === 'function'
    && typeof history.pushState === 'function';
}

/** Scripts the shell loads lazily, e.g. the metrics bundle on /metrics only. */
function ensureScripts(descriptors) {
  const present = new Set(
    Array.from(document.querySelectorAll('script[src]')).map((s) => s.src),
  );
  return Promise.all(descriptors
    .filter((d) => d && d.src && !present.has(new URL(d.src, location.href).href))
    .map((d) => new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = d.src;
      if (d.integrity) script.integrity = d.integrity;
      if (d.crossorigin) script.crossOrigin = d.crossorigin;
      script.defer = true;
      // Never block navigation on an asset that fails to load.
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
    })));
}

let navigationRequest = null;

async function navigateTo(url, { push = true } = {}) {
  const region = document.querySelector('[data-page-content]');
  if (!region) return false;

  navigationRequest?.abort();
  const controller = new AbortController();
  navigationRequest = controller;

  document.documentElement.setAttribute('data-navigating', '');
  try {
    const response = await fetch(url, {
      headers: { 'X-Fragment': 'page' },
      credentials: 'same-origin',
      signal: controller.signal,
      redirect: 'follow',
    });
    // A redirect to a different page (login, error) is a real navigation.
    if (!response.ok || new URL(response.url).pathname !== new URL(url, location.href).pathname) {
      return false;
    }
    const html = await response.text();
    const title = decodeURIComponent(response.headers.get('X-Page-Title') ?? '');

    region.innerHTML = html;
    if (title) document.title = title;
    if (push) history.pushState({ boosted: true }, '', url);

    // The shell stays, so anything the shell set up for the old page has to be
    // re-applied to the new one.
    translateSubtree(region, currentLanguage());
    stampTableCardLabels(region);
    markActiveTab(url);
    region.querySelectorAll('details[data-persist-details]').forEach(restoreDetails);

    let scripts = [];
    try {
      scripts = JSON.parse(decodeURIComponent(response.headers.get('X-Page-Scripts') ?? '[]'));
    } catch {
      scripts = [];
    }
    await ensureScripts(scripts);
    // Tell page-specific scripts (the metrics dashboard) to bind to the new DOM.
    window.dispatchEvent(new CustomEvent('credential-console-navigated', {
      detail: { url: String(url) },
    }));

    window.scrollTo({ top: 0 });
    document.querySelector('[data-page-content] h1')?.setAttribute('tabindex', '-1');
    document.querySelector('[data-page-content] h1')?.focus({ preventScroll: true });
    return true;
  } catch (error) {
    return Boolean(error && error.name === 'AbortError');
  } finally {
    if (navigationRequest === controller) navigationRequest = null;
    document.documentElement.removeAttribute('data-navigating');
  }
}

function markActiveTab(url) {
  const path = new URL(url, location.href).pathname;
  document.querySelectorAll('.page-tabs a').forEach((link) => {
    const target = new URL(link.getAttribute('href'), location.href).pathname;
    if (target === path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function boostableLink(event) {
  if (event.defaultPrevented) return null;
  // Let the browser handle anything the user asked to open differently.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target.closest?.('a[href]');
  if (!link) return null;
  if (link.target && link.target !== '_self') return null;
  if (link.hasAttribute('download') || link.dataset.noBoost !== undefined) return null;
  let url;
  try {
    url = new URL(link.getAttribute('href'), location.href);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  // A same-page anchor is the browser's job.
  if (url.pathname === location.pathname && url.hash) return null;
  return url;
}

if (navigationSupported()) {
  document.addEventListener('click', (event) => {
    const url = boostableLink(event);
    if (!url) return;
    event.preventDefault();
    navigateTo(url.href).then((handled) => {
      if (!handled) location.assign(url.href);
    });
  });

  window.addEventListener('popstate', (event) => {
    if (!event.state?.boosted && !document.querySelector('[data-page-content]')) return;
    navigateTo(location.href, { push: false }).then((handled) => {
      if (!handled) location.reload();
    });
  });

  // So the first Back after a boosted navigation returns here rather than
  // leaving the console.
  history.replaceState({ boosted: true }, '', location.href);
}

// ---------------------------------------------------------------------------
// In-place conversation results
//
// Filtering and paging used to be full navigations. Over the ~207 ms round trip
// to a remote console that meant re-sending and re-parsing the entire document
// for a list that is a few KB. The same request now asks for just the results
// region and swaps it in.
//
// Strictly progressive enhancement: without scripting, or if anything here
// fails, the form performs its normal POST and the server returns a full page
// from the identical code path.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Card labels for wide tables on narrow screens
//
// Below 720px the account and metrics tables render as cards, one labelled row
// per cell. The label is copied from the header cell rather than written into
// the markup, so it is whatever the header currently says — which means it
// follows the language switch instead of being frozen in English at render
// time. Setting display:block on table elements also drops their implicit
// semantics, so the roles are restored explicitly.
// ---------------------------------------------------------------------------

const CARD_TABLE_SELECTOR = '.table-wrap table, .metrics-table';

function stampTableCardLabels(root) {
  root.querySelectorAll?.(CARD_TABLE_SELECTOR).forEach((table) => {
    const headers = Array.from(table.querySelectorAll('thead th'))
      .map((cell) => cell.textContent.trim());
    if (!headers.length) return;

    table.setAttribute('role', 'table');
    table.querySelectorAll('thead, tbody').forEach((group) => group.setAttribute('role', 'rowgroup'));
    table.querySelectorAll('tr').forEach((row) => row.setAttribute('role', 'row'));
    table.querySelectorAll('thead th').forEach((cell) => cell.setAttribute('role', 'columnheader'));

    table.querySelectorAll('tbody tr').forEach((row) => {
      Array.from(row.children).forEach((cell, index) => {
        cell.setAttribute('role', 'cell');
        // A colspan cell (the empty-state row) spans every column, so no single
        // header describes it.
        const spans = Number(cell.getAttribute('colspan') ?? 1) > 1;
        const label = headers[index];
        if (spans || !label) {
          cell.removeAttribute('data-label');
          return;
        }
        cell.dataset.label = label;
      });
    });
  });
}

stampTableCardLabels(document);
// Re-stamp after a language switch so the labels are translated too.
window.addEventListener('credential-console-language', () => stampTableCardLabels(document));

const CONVERSATION_RESULT_ACTIONS = new Set(['/conversations', '/conversation-turns']);

function conversationFragmentSupported() {
  return typeof window.fetch === 'function'
    && typeof window.FormData === 'function'
    && typeof window.URLSearchParams === 'function'
    && typeof window.AbortController === 'function';
}

// A live region that survives every swap, so announcements are content changes
// inside a node the screen reader is already watching.
function conversationAnnouncer() {
  let node = document.getElementById('conversation-live-status');
  if (node) return node;
  node = document.createElement('p');
  node.id = 'conversation-live-status';
  node.className = 'visually-hidden';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  document.body.appendChild(node);
  return node;
}

function announceConversationResults(region) {
  const summary = region.querySelector('.conversation-result-summary');
  const empty = region.querySelector('.conversation-list .empty');
  const text = (empty ?? summary)?.textContent?.trim().replace(/\s+/g, ' ');
  if (!text) return;
  const node = conversationAnnouncer();
  // Re-setting identical text is not a change; nudge it so a repeat search
  // with the same result count is still announced.
  node.textContent = node.textContent === text ? text + ' ' : text;
}

let conversationRequest = null;

async function swapConversationResults(form, submitter) {
  const region = document.querySelector('.conversation-results');
  if (!region) return false;

  const action = new URL(form.action, location.href);
  if (!CONVERSATION_RESULT_ACTIONS.has(action.pathname)) return false;

  const body = new URLSearchParams(new FormData(form));
  // A submit button can carry the cursor for the next page; FormData omits it.
  if (submitter && submitter.name) body.set(submitter.name, submitter.value ?? '');

  // Only the newest filter matters; abandon whatever is still in flight.
  conversationRequest?.abort();
  const controller = new AbortController();
  conversationRequest = controller;

  region.setAttribute('aria-busy', 'true');
  region.classList.add('is-loading');
  try {
    const response = await fetch(action.pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Fragment': 'conversation-results',
      },
      body: body.toString(),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const html = await response.text();

    const holder = document.createElement('div');
    holder.innerHTML = html;
    const replacement = holder.querySelector('.conversation-results');
    if (!replacement) return false;

    translateSubtree(replacement, currentLanguage());

    // Remember whether focus was inside the region we are about to remove.
    const paging = Boolean(submitter && submitter.closest('.conversation-pagination'));
    const hadFocus = region.contains(document.activeElement);

    region.replaceWith(replacement);

    // A live region only announces changes that happen *inside* it. Replacing
    // the region wholesale inserts a node with its content already present,
    // which screen readers treat as initial content and stay silent about — so
    // the announcement goes through a region that is never replaced.
    announceConversationResults(replacement);

    if (paging) {
      // The control that was clicked has just been removed from the document,
      // so focus would otherwise fall back to <body> and a keyboard user would
      // restart the tab order from the top of the page on every page turn.
      const next = replacement.querySelector('.conversation-pagination button')
        ?? replacement.querySelector('[id$="results-heading"]');
      if (next) {
        if (!next.hasAttribute('tabindex') && next.tagName !== 'BUTTON') {
          next.setAttribute('tabindex', '-1');
        }
        next.focus({ preventScroll: true });
      }
      replacement.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (hadFocus) {
      const heading = replacement.querySelector('[id$="results-heading"]');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }
    return true;
  } catch (error) {
    // An aborted request was superseded on purpose; do not fall back to a
    // navigation that would undo the newer one.
    return error && error.name === 'AbortError';
  } finally {
    if (conversationRequest === controller) conversationRequest = null;
    region.removeAttribute('aria-busy');
    region.classList.remove('is-loading');
  }
}

if (conversationFragmentSupported()) {
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    const form = event.target.closest?.('form');
    if (!form) return;
    let action;
    try {
      action = new URL(form.action, location.href);
    } catch {
      return;
    }
    if (String(form.method).toLowerCase() !== 'post') return;
    if (!CONVERSATION_RESULT_ACTIONS.has(action.pathname)) return;
    if (!document.querySelector('.conversation-results')) return;

    event.preventDefault();
    swapConversationResults(form, event.submitter).then((handled) => {
      // Anything unexpected: let the browser do what it would have done.
      if (!handled) form.submit();
    });
  });
}
`, 'text/javascript; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && path.startsWith('/codex-agent/')) {
      const assetName = decodeURIComponent(path.slice('/codex-agent/'.length));
      const relativePath = CODEX_AGENT_ASSETS.get(assetName);
      if (!relativePath) {
        sendText(res, 404, 'not found');
        return;
      }
      const body = codexAgentAssets[assetName];
      sendText(res, 200, body, assetName.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && path === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        admin_auth: adminAuth,
        client_config_version: CLIENT_CONFIG_VERSION,
        // Whether an administrator is identified at all. `tailscale` authenticates
        // one; `open` deliberately authenticates nobody, and reporting that as
        // configured would hide the only fact worth alerting on here.
        admin_configured: adminAuth === 'tailscale',
      });
      return;
    }

    // Neither surviving mode has a sign-in. Answering these two paths explicitly
    // tells an operator following an old bookmark or runbook why, instead of
    // leaving them with a bare "page does not exist".
    if (path === '/login' || path === '/logout') {
      sendHtml(res, 404, messageView(
        'Not found',
        'This console has no sign-in and no session to end.',
        { error: true, openMode },
      ));
      return;
    }

    if (req.method === 'GET' && path === '/') {
      const session = requireSession(req, res);
      if (!session) return;
      const codex = await codexMachineReport();
      const completedDraft = url.searchParams.get('draft_completed');
      sendHtml(res, 200, dashboardView({
        accounts: await accountsWithExternalStatus(),
        devices: store.publicDevices(),
        // Revoked rows are carried into the page and collapsed there, rather than
        // filtered out here: they are the majority of rows over time, they are
        // why the flat list stopped being readable, and they are still the record
        // of what a machine used to hold.
        machines: store.publicMachines({ includeRevoked: true }),
        codexClients: codex.clients,
        codexUnavailable: codex.unavailable,
        csrf: session.csrf,
        adminIdentity: session.admin_identity,
        openMode,
        codexSelfServiceReady,
        claudeGatewayUrl,
        onboardingUrl,
        error: url.searchParams.get('error'),
        completedDraft: COMPLETED_DRAFTS.has(completedDraft) ? completedDraft : null,
      }));
      return;
    }

    if (req.method === 'POST' && path === '/codex/self-service') {
      const session = requireSession(req, res);
      if (!session) return;
      if (!openMode && !session.admin_identity) {
        sendHtml(res, 403, messageView(
          'Tailnet identity required',
          'Codex self-service requires a Tailscale user identity.',
          { error: true },
        ));
        return;
      }
      const identity = session.admin_identity ?? 'anonymous';
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      try {
        if (!codexSelfServiceReady) throw new Error('Codex self-service is not configured');
        const memberLabel = memberLabelFor(session, form);
        const deviceName = String(form.device_name ?? '').trim();
        if (!DEVICE_NAME_PATTERN.test(deviceName)) {
          throw new Error('device name must use letters, numbers, dots, underscores, or hyphens');
        }
        const memberSuffix = createHash('sha256')
          .update(memberLabel)
          .digest('hex')
          .slice(0, 10);
        const machineName = `${deviceName.slice(0, 53)}-${memberSuffix}`;
        // A handle per issuance, minted here because the machine cannot mint one
        // for itself: the generated installer carries pull.js, not enroll.js, so
        // a console-configured machine never reaches /enroll and never reports
        // anything of its own.
        //
        // Without it every console row went to the dispenser with no handle, and
        // the dispenser then applied its pre-handle rule: revoke every active row
        // of that name. The name is `<device>-<sha256(member label)[0:10]>` and
        // the label is self-asserted and unverified (D-010), so two people who
        // both typed `alex` and `shared` produced the same name and silently
        // evicted each other — exactly the defect the handle exists to fix, still
        // fully live on the one member-facing Codex path.
        //
        // The cost, stated plainly: a member re-requesting a config for the same
        // device gets a new handle too, so their previous console-minted token
        // stays active instead of being revoked. That is deliberate. The console
        // cannot tell "the same person again" from "a second person asserting the
        // same label", and evicting the wrong one is silent while a surplus row
        // is visible in the inventory and revocable with `add-client.js --revoke`.
        const machineId = randomToken(24);
        const codexAccount = store.publicAccounts().find((account) => account.provider === 'codex');
        const issued = await codexEnroll({
          endpoint: codexEndpoint,
          enrollmentKey: codexEnrollmentKey,
          pin: codexCertPin,
          name: machineName,
          machineId,
        });
        log('codex_device_self_enrolled', {
          identity,
          member_label: memberLabel,
          device_name: deviceName,
          dispenser_name: issued.name,
          // Opaque and safe to log: it identifies this issuance's machine and
          // nothing else. The minted token never appears here.
          machine_id: machineId,
        });
        sendHtml(res, 200, codexConfiguredView({
          deviceName,
          token: issued.token,
          endpoint: codexEndpoint,
          certPin: codexCertPin,
          profileName: codexAccount?.alias ?? 'codex-team',
          assets: codexAgentAssets,
          openMode,
        }));
      } catch (error) {
        log('codex_device_self_enroll_failed', {
          identity,
          error: error.message,
        });
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    if (req.method === 'POST' && path === '/self-service') {
      const session = requireSession(req, res);
      if (!session) return;
      if (!openMode && !session.admin_identity) {
        sendHtml(res, 403, messageView(
          'Tailnet identity required',
          'Self-service access requires a Tailscale user identity.',
          { error: true },
        ));
        return;
      }
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      try {
        const result = await store.issueDeviceCredential({
          accountId: String(form.account_id ?? ''),
          memberLabel: memberLabelFor(session, form),
          deviceName: String(form.device_name ?? '').trim(),
        });
        sendHtml(res, 200, deviceConfiguredView({
          ...result,
          claudeGatewayUrl,
          openMode,
        }));
      } catch (error) {
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    if (req.method === 'POST' && path === '/accounts') {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      try {
        const provider = String(form.provider ?? '');
        if (!['claude', 'codex'].includes(provider)) {
          throw new Error('only Claude and Codex accounts can be added in the web UI');
        }
        const emailLabel = String(form.email_label ?? '').trim().toLowerCase();
        // Claude matches this email against the authorized account before storing
        // a token, so it is mandatory there. Codex treats it as an optional check.
        if (emailLabel || provider === 'claude') {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLabel)) {
            throw new Error('a valid account owner email is required');
          }
        }
        await store.addAccount({
          provider,
          alias: String(form.alias ?? '').trim(),
          emailLabel,
        });
        redirect(res, `/?draft_completed=${encodeURIComponent(`register-${provider}-account`)}`);
      } catch (error) {
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    const claudeAuthorizationParams = routeMatch(path, '/accounts/:id/claude-authorization');
    if (req.method === 'GET' && claudeAuthorizationParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const account = store.accountById(claudeAuthorizationParams.id);
      if (!account || account.provider !== 'claude') {
        sendHtml(res, 404, messageView('Account not found', 'Claude account was not found.', { error: true, openMode }));
        return;
      }
      sendHtml(res, 200, claudeAuthorizationView({
        account,
        csrf: session.csrf,
        ownerPageUrl: `${publicBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(account.id)}/claude-authorization`,
        openMode,
      }));
      return;
    }

    const claudeAuthorizationStartParams = routeMatch(path, '/accounts/:id/claude-authorization/start');
    if (req.method === 'POST' && claudeAuthorizationStartParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      const account = store.accountById(claudeAuthorizationStartParams.id);
      if (!account || account.provider !== 'claude') {
        sendHtml(res, 404, messageView('Account not found', 'Claude account was not found.', { error: true, openMode }));
        return;
      }
      try {
        const request = createClaudeAuthorizationRequest({ emailLabel: account.email_label });
        const flow = await store.beginClaudeAuthorization({
          accountId: account.id,
          verifier: request.verifier,
          state: request.state,
          initiatedBy: session.admin_identity ?? 'administrator',
        });
        sendHtml(res, 200, claudeAuthorizationView({
          account,
          csrf: session.csrf,
          ownerPageUrl: `${publicBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(account.id)}/claude-authorization`,
          authorization: { url: request.url, expires_at: flow.expires_at },
          openMode,
        }));
      } catch (error) {
        sendHtml(res, 400, claudeAuthorizationView({
          account,
          csrf: session.csrf,
          ownerPageUrl: `${publicBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(account.id)}/claude-authorization`,
          error: error.message,
          openMode,
        }));
      }
      return;
    }

    const claudeAuthorizationCompleteParams = routeMatch(path, '/accounts/:id/claude-authorization/complete');
    if (req.method === 'POST' && claudeAuthorizationCompleteParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      const account = store.accountById(claudeAuthorizationCompleteParams.id);
      if (!account || account.provider !== 'claude') {
        sendHtml(res, 404, messageView('Account not found', 'Claude account was not found.', { error: true, openMode }));
        return;
      }
      try {
        const submitted = parseClaudeAuthorizationCode(form.authorization_code);
        const flow = store.claudeAuthorizationByState({
          accountId: account.id,
          state: submitted.state,
        });
        const identity = session.admin_identity ?? 'administrator';
        if (flow.initiated_by !== identity) {
          throw new Error('authorization must be completed by the same administrator who started it');
        }
        const exchanged = await claudeOauthExchange({
          code: submitted.code,
          state: submitted.state,
          verifier: flow.verifier,
        });
        await store.completeClaudeAuthorization({
          flowId: flow.id,
          accessToken: exchanged.accessToken,
          emailAddress: exchanged.emailAddress,
          expiresAt: exchanged.expiresAt,
          scope: exchanged.scope,
        });
        usageMonitor.refreshAccount(account.id).catch(() => {});
        log('claude_account_authorized', {
          account_id: account.id,
          account_alias: account.alias,
          email: exchanged.emailAddress,
          identity,
        });
        sendHtml(res, 200, messageView(
          'Claude account authorized',
          `${account.alias} is ready. Existing and new device credentials now use ${exchanged.emailAddress}.`,
          { openMode },
        ));
      } catch (error) {
        log('claude_account_authorization_failed', {
          account_id: account.id,
          account_alias: account.alias,
          identity: session.admin_identity ?? 'administrator',
          error: error.message,
        });
        sendHtml(res, 400, claudeAuthorizationView({
          account,
          csrf: session.csrf,
          ownerPageUrl: `${publicBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(account.id)}/claude-authorization`,
          error: error.message,
          openMode,
        }));
      }
      return;
    }

    function codexAuthorizationPage(account, session, extra = {}) {
      // A session that is still live keeps the paste box on the page, so a
      // mistyped paste costs a retry rather than a whole new trip through OpenAI.
      // Without the authorize URL, which is never persisted, only the box renders.
      const pending = store.pendingCodexAuthorization({ accountId: account.id });
      return codexAuthorizationView({
        account,
        csrf: session.csrf,
        ownerPageUrl: `${publicBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(account.id)}/codex-authorization`,
        seedHome: codexSeedHome,
        openMode,
        ...(pending ? { authorization: { expires_at: pending.expires_at } } : {}),
        ...extra,
      });
    }

    function codexAccountOr404(id) {
      const account = store.accountById(id);
      if (!account || account.provider !== 'codex') {
        sendHtml(res, 404, messageView('Account not found', 'Codex account was not found.', { error: true, openMode }));
        return null;
      }
      return account;
    }

    const codexAuthorizationParams = routeMatch(path, '/accounts/:id/codex-authorization');
    if (req.method === 'GET' && codexAuthorizationParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const account = codexAccountOr404(codexAuthorizationParams.id);
      if (!account) return;
      sendHtml(res, 200, codexAuthorizationPage(account, session));
      return;
    }

    const codexAuthorizationStartParams = routeMatch(path, '/accounts/:id/codex-authorization/start');
    if (req.method === 'POST' && codexAuthorizationStartParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      const account = codexAccountOr404(codexAuthorizationStartParams.id);
      if (!account) return;
      try {
        store.assertCodexSeedHome({ accountId: account.id, seedHome: codexSeedHome });
        // Refuse an unwritable seed home here, where nothing has been spent yet.
        // Discovering it after the exchange costs a browser login that cannot be
        // replayed, because the authorization code is single-use upstream.
        if (codexSeedHome) await assertCodexSeedHomeWritable(codexSeedHome);
        const request = createCodexAuthorizationRequest();
        const flow = await store.beginCodexAuthorization({
          accountId: account.id,
          verifier: request.verifier,
          state: request.state,
          initiatedBy: session.admin_identity ?? 'administrator',
        });
        sendHtml(res, 200, codexAuthorizationPage(account, session, {
          authorization: { url: request.url, expires_at: flow.expires_at },
        }));
      } catch (error) {
        sendHtml(res, 400, codexAuthorizationPage(account, session, { error: error.message }));
      }
      return;
    }

    const codexAuthorizationCompleteParams = routeMatch(path, '/accounts/:id/codex-authorization/complete');
    if (req.method === 'POST' && codexAuthorizationCompleteParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      const account = codexAccountOr404(codexAuthorizationCompleteParams.id);
      if (!account) return;
      const identity = session.admin_identity ?? 'administrator';
      try {
        const submitted = parseCodexAuthorizationRedirect(form.authorization_code);
        const flow = submitted.state
          ? store.codexAuthorizationByState({ accountId: account.id, state: submitted.state })
          : store.liveCodexAuthorization({ accountId: account.id });
        if (flow.initiated_by !== identity) {
          throw new Error('authorization must be completed by the same administrator who started it');
        }
        const exchanged = await codexOauthExchange({
          code: submitted.code,
          verifier: flow.verifier,
        });
        const authorized = codexIdentityFrom(exchanged.idToken);
        const expectedEmail = String(account.email_label ?? '').trim().toLowerCase();
        if (expectedEmail && String(authorized.email ?? '').trim().toLowerCase() !== expectedEmail) {
          throw new Error(`authorized account email does not match ${expectedEmail}`);
        }
        const credential = buildCodexAuthJson(exchanged);
        // The code is spent upstream from here on, so the session is retired
        // whatever the seed write does, and a write that landed still binds the
        // home to this account — otherwise the next account would be allowed to
        // authorize into it and overwrite a live credential.
        let seeded = null;
        let seedFailure = null;
        if (codexSeedHome) {
          try {
            store.assertCodexSeedHome({ accountId: account.id, seedHome: codexSeedHome });
            seeded = await seedCodexCredentialHome(codexSeedHome, credential);
          } catch (error) {
            seedFailure = error;
            if (error.progress?.wroteCredential) seeded = error.progress;
          }
        }
        await store.completeCodexAuthorization({
          flowId: flow.id,
          seededHome: seeded ? codexSeedHome : null,
          expiresAt: seeded?.expiresAt ?? null,
        });
        if (seedFailure) {
          log('codex_account_seed_failed', {
            account_id: account.id,
            account_alias: account.alias,
            seeded_home: codexSeedHome,
            wrote_credential: Boolean(seeded),
            identity,
            error: seedFailure.message,
          });
          // The credential exists and the code cannot be replayed, so it is handed
          // back rather than dropped. Once it reached disk it is already safe
          // there, and re-rendering it would be exposure that buys nothing.
          sendHtml(res, 400, seeded
            ? messageView(
              'Codex credential written, publish incomplete',
              `The credential was written to ${seeded.home}, but finishing the seed failed: ${seedFailure.message}. Re-publish it with refresh-center/seed.js from that home's own credential.json.`,
              { error: true, openMode },
            )
            : codexCredentialView({
              account,
              authJson: `${JSON.stringify(credential, null, 2)}\n`,
              error: `Nothing was written to ${codexSeedHome}: ${seedFailure.message}`,
              openMode,
            }));
          return;
        }
        log('codex_account_authorized', {
          account_id: account.id,
          account_alias: account.alias,
          email: authorized.email,
          plan: authorized.planType,
          seeded_home: codexSeedHome,
          identity,
        });
        if (seeded) {
          sendHtml(res, 200, messageView(
            'Codex account authorized',
            `The credential was written to ${seeded.home} and is not shown here.`,
            {
              openMode,
              i18n: 'codex-seeded-ok',
              detail: `${account.alias} → ${seeded.home}`,
            },
          ));
        } else {
          sendHtml(res, 200, codexCredentialView({
            account,
            authJson: `${JSON.stringify(credential, null, 2)}\n`,
            openMode,
          }));
        }
      } catch (error) {
        log('codex_account_authorization_failed', {
          account_id: account.id,
          account_alias: account.alias,
          identity,
          error: error.message,
        });
        sendHtml(res, 400, codexAuthorizationPage(account, session, { error: error.message }));
      }
      return;
    }

    const enrollmentParams = routeMatch(path, '/accounts/:id/enrollments');
    if (req.method === 'POST' && enrollmentParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      try {
        const account = store.accountById(enrollmentParams.id);
        if (!account) throw new Error('account not found');
        if (account.provider !== 'claude') throw new Error('Codex enrollment remains on the existing client agent');
        const { code } = await store.createEnrollment({
          accountId: account.id,
          memberLabel: form.member_label,
        });
        const link = `${publicBaseUrl.replace(/\/$/, '')}/enroll/${code}`;
        sendHtml(res, 200, enrollmentCreatedView({
          account,
          memberLabel: form.member_label,
          link,
          openMode,
        }));
      } catch (error) {
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    // Removing an account that never finished authorizing. The store decides what
    // is safe to delete; this route deliberately does not re-derive that rule,
    // because two copies of a "safe to delete" test drift apart.
    const deleteAccountParams = routeMatch(path, '/accounts/:id/delete');
    if (req.method === 'POST' && deleteAccountParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      try {
        await store.deleteAccount(deleteAccountParams.id);
        redirect(res, '/');
      } catch (error) {
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    // Filing a legacy issuance under a machine. CSRF-protected like revoke and
    // delete, and refusing rather than half-doing it: the store writes one absent
    // field or nothing at all, and this route will not name a machine that does
    // not already exist.
    const mergeMachineParams = routeMatch(path, '/devices/:id/machine');
    if (req.method === 'POST' && mergeMachineParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      try {
        const machineId = String(form.machine_id ?? '').trim();
        const codex = await codexMachineReport();
        if (!knownMachineIds(codex.clients).has(machineId)) {
          // Including the case where the handle is real but lives only in a
          // dispenser home that has become unreadable since the page rendered.
          // Refusing is recoverable; writing an unverifiable handle is not.
          throw new Error('no such machine is currently listed; reload the dashboard and choose one of the machines it shows');
        }
        const { changed } = await store.mergeDeviceIntoMachine({
          deviceId: mergeMachineParams.id,
          machineId,
        });
        log('device_machine_merged', {
          device_id: mergeMachineParams.id,
          machine_id: machineId,
          identity: session.admin_identity ?? 'anonymous',
          // A repeat submission is success with nothing written; say which it was.
          changed,
        });
        redirect(res, '/');
      } catch (error) {
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    const switchAccountParams = routeMatch(path, '/devices/:id/account');
    if (req.method === 'POST' && switchAccountParams) {
      const asyncJson = expectsAsyncJson(req, 'account-switch');
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        if (asyncJson) sendJson(res, 403, { ok: false, error: 'invalid_csrf' });
        else sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      const actor = session.admin_identity ?? 'anonymous';
      try {
        const summary = await store.configureDeviceAccount({
          deviceId: switchAccountParams.id,
          selectedAccountId: String(form.selected_account_id ?? ''),
          actor,
          actorType: 'console',
        });
        log('device_account_configured', {
          device_id: summary.device_id,
          machine_id: summary.machine_id,
          original_account_id: summary.original_account_id,
          selected_account_id: summary.selected_account_id,
          actor,
        });
        if (asyncJson) {
          const accountOptions = store.publicAccounts()
            .filter((account) => account.provider === 'claude')
            .map((account) => ({
              id: account.id,
              alias: account.alias,
              status: account.status,
              active_devices: account.active_devices,
            }));
          const accountById = new Map(accountOptions.map((account) => [account.id, account]));
          const allowedAccounts = summary.allowed_account_ids
            .map((id) => accountById.get(id))
            .filter(Boolean)
            .map(({ id, alias, status }) => ({ id, alias, status }));
          sendJson(res, 200, {
            ok: true,
            device_id: summary.device_id,
            selected_account_id: summary.selected_account_id,
            account: {
              id: summary.account.id,
              alias: summary.account.alias,
              status: summary.account.status,
            },
            allowed_accounts: allowedAccounts,
            account_options: accountOptions.map(({ id, alias, status }) => ({ id, alias, status })),
            account_device_counts: accountOptions
              .map(({ id, active_devices }) => ({ id, active_devices })),
          });
        } else {
          redirect(res, '/');
        }
      } catch (error) {
        log('device_account_configuration_failed', {
          device_id: switchAccountParams.id,
          actor,
          code: error.code ?? error.name ?? 'unknown',
        });
        if (asyncJson) {
          const code = String(error.code ?? '');
          const status = code === 'ACCOUNT_NOT_ALLOWED'
            ? 403
            : (code === 'ACCOUNT_UNAVAILABLE' || code.startsWith('DEVICE_') ? 409 : 500);
          sendJson(res, status, { ok: false, error: 'account_switch_failed' });
        } else {
          redirect(res, `/?error=${encodeURIComponent(error.message)}`);
        }
      }
      return;
    }

    const revokeParams = routeMatch(path, '/devices/:id/revoke');
    if (req.method === 'POST' && revokeParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      try {
        await store.revokeDevice(revokeParams.id);
        redirect(res, '/');
      } catch (error) {
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    const redeemParams = routeMatch(path, '/enroll/:code');
    if (req.method === 'GET' && redeemParams) {
      const enrollment = store.enrollmentByCode(redeemParams.code);
      const account = enrollment ? store.accountById(enrollment.account_id) : null;
      if (!enrollment || !account || enrollment.used_at || Date.parse(enrollment.expires_at) <= Date.now()) {
        sendHtml(res, 410, messageView('Enrollment unavailable', 'This enrollment link is invalid, expired, or already used.', { error: true, openMode }));
        return;
      }
      sendHtml(res, 200, enrollmentView({
        account,
        memberLabel: enrollment.member_label,
        code: redeemParams.code,
        openMode,
      }));
      return;
    }

    if (req.method === 'POST' && redeemParams) {
      const form = await readForm(req).catch(() => ({}));
      try {
        const result = await store.redeemEnrollment({
          code: redeemParams.code,
          deviceName: String(form.device_name ?? '').trim(),
        });
        sendHtml(res, 200, deviceConfiguredView({
          ...result,
          claudeGatewayUrl,
          openMode,
        }));
      } catch (error) {
        const enrollment = store.enrollmentByCode(redeemParams.code);
        const account = enrollment ? store.accountById(enrollment.account_id) : null;
        if (!enrollment || !account || enrollment.used_at) {
          sendHtml(res, 410, messageView('Enrollment unavailable', error.message, { error: true, openMode }));
        } else {
          sendHtml(res, 400, enrollmentView({
            account,
            memberLabel: enrollment.member_label,
            code: redeemParams.code,
            error: error.message,
            openMode,
          }));
        }
      }
      return;
    }

    sendHtml(res, 404, messageView('Not found', 'The requested page does not exist.', { error: true, openMode }));
  }

  let server;
  if (options.server) {
    server = options.server(handler);
  } else if (options.tls) {
    server = https.createServer(options.tls, handler);
  } else {
    server = http.createServer(handler);
  }
  server.once('close', () => {
    clearInterval(cleanupTimer);
    usageMonitor.stop?.();
    try {
      const closing = requestMetrics?.close?.();
      if (closing && typeof closing.then === 'function') {
        closing.catch((error) => log('metrics_close_failed', {
          code: error?.code ?? error?.name ?? 'unknown',
        }));
      }
    } catch (error) {
      log('metrics_close_failed', { code: error?.code ?? error?.name ?? 'unknown' });
    }
  });
  // sessionCount is exposed only so a test can prove the map stays bounded.
  return {
    server,
    store,
    handler,
    usageMonitor,
    requestMetrics,
    metricsInitFailed,
    sessionCount: () => sessions.size,
  };
}

async function main() {
  const homeLock = await acquireHomeLock(HOME, { role: 'server' });
  let server;
  let shuttingDown = false;
  let releasePromise;
  const releaseHomeLock = () => {
    releasePromise ??= homeLock.release();
    return releasePromise;
  };
  const releaseAndExit = async () => {
    try {
      await releaseHomeLock();
    } catch (error) {
      console.error(error.stack ?? error.message);
    }
    process.exit(0);
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(releaseAndExit, SHUTDOWN_DEADLINE_MS);
    if (server?.listening) {
      server.close(() => {
        clearTimeout(deadline);
        releaseAndExit();
      });
    } else {
      clearTimeout(deadline);
      releaseAndExit();
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const tls = TLS_CERT && TLS_KEY
      ? {
          cert: await readFile(TLS_CERT),
          key: await readFile(TLS_KEY),
          minVersion: 'TLSv1.2',
        }
      : null;
    if (!tls && BIND !== '127.0.0.1' && BIND !== '::1') {
      throw new Error('refusing non-loopback bind without CREDENTIAL_CONSOLE_TLS_CERT and _TLS_KEY');
    }
    const created = await createCredentialConsole({ tls });
    ({ server } = created);
    const metricsEnabled = Boolean(created.requestMetrics);
    // Keep the D-013 event name stable for existing log monitors; its detail now
    // covers the P6 conversation disclosure as well as the P2/P5 metadata rows.
    log('privacy_metadata_recording', {
      enabled: metricsEnabled,
      detail: metricsEnabled
        ? 'proxied Claude request metadata, including four provider-reported token counts, is stored; hook-enabled Claude profiles permanently store exact Claude user-submitted prompts and final visible assistant responses as paired rounds visible to every console member; reliable pairing requires Claude Code 2.1.196+; these synchronous command hooks never deny or terminate Claude but a failed delivery may add bounded delay; legacy bounded API request/response fragments remain in a separate diagnostic archive and are not represented as human conversations; in open mode anyone on the tailnet who can reach the console can read both archives with no identity and no reading audit; member labels are self-entered and unverified and must not be used for accountability or billing; hook events are device-asserted and do not authenticate a human; Codex traffic is not captured'
        : 'request metadata and Claude API-turn capture are unavailable, so requests and captured API text are not currently being stored',
    });
    server.once('close', () => {
      releaseHomeLock().catch((error) => console.error(error.stack ?? error.message));
    });
    if (ADMIN_AUTH === 'open') {
      log('admin_auth_open', {
        detail: 'no console authentication; reachability is the entire authorization boundary',
      });
    }
    server.listen(PORT, BIND, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : PORT;
      log('credential_console_listening', {
        bind: BIND,
        port: boundPort,
        public_url: process.env.CREDENTIAL_CONSOLE_PUBLIC_URL
          ?? `https://127.0.0.1:${boundPort}`,
        tls: Boolean(tls),
      });
    });
  } catch (error) {
    await homeLock.release();
    throw error;
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
