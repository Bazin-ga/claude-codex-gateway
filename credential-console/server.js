#!/usr/bin/env node
import { APP_ASSET_SHA256, APP_ASSET_SOURCE, APP_ASSET_URL } from './lib/app-asset.js';
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
import { CODEX_PROXY_PREFIX, handleCodexProxy } from './lib/codex-proxy.js';
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
  parseCodexAuthJson,
} from './lib/codex-oauth.js';
import { assertCodexSeedHomeWritable, seedCodexCredentialHome } from './lib/codex-seed.js';
import {
  claudeAuthorizationView,
  dashboardView,
  codexDeviceConfiguredView,
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
const CODEX_GATEWAY_URL = process.env.CREDENTIAL_CONSOLE_CODEX_GATEWAY_URL;
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
const appAssetVariants = new Map();

/** Compressed forms of the client script, built once per encoding. */
function appAssetVariant(encoding) {
  const key = encoding ?? 'identity';
  const cached = appAssetVariants.get(key);
  if (cached) return cached;
  const raw = Buffer.from(APP_ASSET_SOURCE, 'utf8');
  const body = encoding ? compressFor(encoding, raw) : raw;
  const variant = { body, encoding: body === raw ? null : encoding };
  appAssetVariants.set(key, variant);
  return variant;
}

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
  // Derived from the same base rather than configured separately: the Codex
  // gateway is a route on this very server, so a second setting could only ever
  // be wrong.
  const codexGatewayUrl = options.codexGatewayUrl
    ?? CODEX_GATEWAY_URL
    ?? `${publicBaseUrl.replace(/\/$/, '')}${CODEX_PROXY_PREFIX}`;
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
  // Both providers issue the same kind of device token but need different client
  // instructions; handing a Codex enrollee the Claude launcher would be
  // confidently wrong.
  const configuredDeviceView = (result) => (result.account?.provider === 'codex'
    ? codexDeviceConfiguredView({ ...result, codexGatewayUrl, openMode })
    : deviceConfiguredView({ ...result, claudeGatewayUrl, openMode }));
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
    // Both gateway providers, because both now produce conversation rows. This
    // map is also what turns an account id into a name in the filter: while it
    // held Claude alone, a Codex account fell through to `?? value` and the
    // dropdown offered a raw id — `YfgZbzz1VmxLc40G (1)` instead of
    // `codex-shared-1 (1)`.
    const fallbackAccounts = store.publicAccounts()
      .filter((account) => ['claude', 'codex'].includes(account.provider))
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

    if (path.startsWith(`${CODEX_PROXY_PREFIX}/`)) {
      await handleCodexProxy(req, res, {
        store,
        upstreamBaseUrl: options.codexUpstreamBaseUrl,
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
      // Filters live in the URL. This reverses an earlier decision to keep
      // search terms out of it: with results updating in place, a filter that
      // the address bar does not carry cannot survive a refresh, cannot be
      // reached with Back, and cannot be shared. The cost is that a search term
      // now appears in the URL, in browser history, and in any access log that
      // records query strings — accepted deliberately, not overlooked.
      const formUrl = new URL(path + url.search, url);
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

    if (req.method === 'GET' && path === APP_ASSET_URL) {
      // Content-addressed, so it can be cached forever: a change produces a
      // different URL rather than needing invalidation.
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      const variant = appAssetVariant(encoding);
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
        Vary: 'Accept-Encoding',
        ETag: `"${APP_ASSET_SHA256}${variant.encoding ? `-${variant.encoding}` : ''}"`,
        ...(variant.encoding ? { 'Content-Encoding': variant.encoding } : {}),
        'Content-Length': variant.body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : variant.body);
      return;
    }

    // The unhashed path stays reachable so a page cached before a deploy can
    // still load its script instead of silently losing all enhancement.
    if (req.method === 'GET' && path === '/assets/app.js') {
      redirect(res, APP_ASSET_URL, { 'Cache-Control': 'no-store' });
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
        // Carried in the URL so a filtered view is linkable and survives a
        // reload, the same way the conversation and metrics filters work.
        accountFilter: url.searchParams.get('account'),
        memberFilter: url.searchParams.get('member'),
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
        sendHtml(res, 200, configuredDeviceView(result));
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

    const codexPasteParams = routeMatch(path, '/accounts/:id/codex-authorization/paste');
    if (req.method === 'POST' && codexPasteParams) {
      const session = requireSession(req, res);
      if (!session) return;
      // The body is a credential, so it is never read with the default cap that
      // would silently truncate it into something unparseable.
      const form = await readForm(req, 256 * 1024).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      const account = codexAccountOr404(codexPasteParams.id);
      if (!account) return;
      const identity = session.admin_identity ?? 'administrator';
      try {
        if (!codexSeedHome) {
          throw new Error('no Codex credential home is configured, so there is nowhere to write this');
        }
        const { credential, identity: authorized } = parseCodexAuthJson(form.credential_json);
        const expectedEmail = String(account.email_label ?? '').trim().toLowerCase();
        if (expectedEmail && String(authorized.email ?? '').trim().toLowerCase() !== expectedEmail) {
          throw new Error(`the pasted credential belongs to a different account than ${expectedEmail}`);
        }
        store.assertCodexSeedHome({ accountId: account.id, seedHome: codexSeedHome });
        const seeded = await seedCodexCredentialHome(codexSeedHome, credential);
        await store.recordCodexSeed({
          accountId: account.id,
          seededHome: codexSeedHome,
          expiresAt: seeded?.expiresAt ?? null,
          actor: identity,
        });
        log('codex_credential_pasted', {
          account_id: account.id,
          account_alias: account.alias,
          email: authorized.email,
          plan: authorized.planType,
          seeded_home: codexSeedHome,
          identity,
        });
        sendHtml(res, 200, messageView(
          'Codex credential stored',
          `The credential was written to ${seeded.home} and is not shown here. Any refresh quarantine on that home has been cleared.`,
          { openMode, detail: `${account.alias} → ${seeded.home}` },
        ));
      } catch (error) {
        // The message is shape-only by construction, so it is safe to render and
        // to log. The credential itself is never in either.
        log('codex_credential_paste_failed', {
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

    if (req.method === 'POST' && path === '/devices/account') {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
        return;
      }
      const actor = session.admin_identity ?? 'anonymous';
      const fromAccountId = String(form.from_account_id ?? '');
      try {
        // The count the operator was looking at. The store refuses if the set
        // has changed since, so a bulk move can never be bigger than what was
        // on screen.
        const declared = Number(form.expected_count);
        const summary = await store.bulkConfigureDeviceAccount({
          fromAccountId: fromAccountId || null,
          memberLabel: String(form.member_label ?? '') || null,
          selectedAccountId: String(form.selected_account_id ?? ''),
          expectedCount: Number.isSafeInteger(declared) && declared >= 0 ? declared : null,
          actor,
          actorType: 'console',
        });
        log('device_account_bulk_configured', {
          from_account_id: fromAccountId || null,
          member_label: String(form.member_label ?? '') || null,
          to_account_id: summary.targetAccountId,
          switched: summary.switched.length,
          skipped: summary.skipped.length,
          actor,
        });
        const target = store.accountById(summary.targetAccountId);
        const detail = summary.skipped.length
          ? `${summary.skipped.length} left alone: ${summary.skipped.map((entry) => entry.reason).join('; ')}`
          : null;
        sendHtml(res, 200, messageView(
          'Accounts switched',
          `${summary.switched.length} credential(s) moved to ${target?.alias ?? summary.targetAccountId}.`,
          { openMode, detail },
        ));
      } catch (error) {
        const back = new URLSearchParams();
        if (fromAccountId) back.set('account', fromAccountId);
        if (form.member_label) back.set('member', String(form.member_label));
        back.set('error', error.message);
        redirect(res, `/?${back}`);
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
        sendHtml(res, 200, configuredDeviceView(result));
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
