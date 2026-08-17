#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomToken } from './lib/security.js';
import {
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
const DEVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SHUTDOWN_DEADLINE_MS = 1_000;
const CODEX_AGENT_ROOT = fileURLToPath(new URL('../codex-credential/client-agent/', import.meta.url));
export const CODEX_AGENT_ASSETS = new Map([
  ['pull.js', 'pull.js'],
  ['package.json', 'package.json'],
  ['lib/pinned-request.js', 'lib/pinned-request.js'],
  ['install/install.sh', 'install/install.sh'],
  ['install/systemd/codex-credential.service', 'install/systemd/codex-credential.service'],
  ['install/systemd/codex-credential.timer', 'install/systemd/codex-credential.timer'],
  ['install/launchd/com.claude-codex-gateway.codex-credential.plist', 'install/launchd/com.claude-codex-gateway.codex-credential.plist'],
  ['install/windows/install.ps1', 'install/windows/install.ps1'],
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

async function externalAccountStatus(account) {
  if (account.external?.kind !== 'codex-credential') return {};
  try {
    const current = JSON.parse(
      await readFile(`${account.external.home}/public/current.json`, 'utf8'),
    );
    let clients = { clients: [] };
    let clientCount = null;
    try {
      clients = JSON.parse(
        await readFile(`${account.external.home}/clients/clients.json`, 'utf8'),
      );
      clientCount = (clients.clients ?? []).filter((client) => !client.revoked).length;
    } catch {
      // The console has no access to the Codex client-token registry once the
      // recommended systemd hardening is applied; the count is then unavailable.
    }
    const expiresAt = Date.parse(current.expires_at);
    return {
      status: Number.isFinite(expiresAt) && expiresAt > Date.now() ? 'healthy' : 'expired',
      expires_at: current.expires_at ?? null,
      active_devices: clientCount,
    };
  } catch (error) {
    return { status: 'unhealthy', last_failure: error.message };
  }
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
  if (!['tailscale', 'open'].includes(adminAuth)) {
    throw new Error('CREDENTIAL_CONSOLE_ADMIN_AUTH must be tailscale or open');
  }
  // Open mode has no login, so every rendered page has to say so.
  const openMode = adminAuth === 'open';
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expires_at <= now) sessions.delete(token);
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
      return {
        ...account,
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

  function metricsPage(url) {
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
      filters: viewFilters,
      options: { machines: [], members: [], accounts: [], models: [] },
      totals: { all: 0, consumption: 0 },
      hourly: [],
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
      const dimensions = { fromMs, toMs: now + 1, scope: 'all' };
      const deviceById = new Map(store.publicDevices().map((device) => [device.id, device]));
      const accountById = new Map(store.publicAccounts().map((account) => [account.id, account]));
      const machineRows = requestMetrics.queryBreakdown({ by: 'machine', ...dimensions });
      const deviceRows = requestMetrics.queryBreakdown({ by: 'device', ...dimensions });
      const memberRows = requestMetrics.queryBreakdown({ by: 'member', ...dimensions });
      const accountRows = requestMetrics.queryBreakdown({ by: 'account', ...dimensions });
      const modelRows = requestMetrics.queryBreakdown({ by: 'model', ...dimensions });
      return {
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
        },
        hourly,
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

  async function handler(req, res) {
    const url = new URL(req.url, publicBaseUrl);
    const path = url.pathname;

    if (path.startsWith(MACHINE_CONTROL_PREFIX)) {
      await handleMachineControl(req, res, { store, log });
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

    if (req.method === 'GET' && path === '/metrics') {
      const session = requireSession(req, res);
      if (!session) return;
      sendHtml(res, 200, metricsView({
        ...metricsPage(url),
        openMode,
      }));
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
  'account-selection-invalid': '账号选择配置无效；系统没有擅自猜测账号。',
  'no-claude-accounts': '尚未登记 Claude 账号。',
  'open-account-switch-warning': 'Open 模式没有可验证的操作人：任何能访问控制台的人都可以切换任意有效设备。操作人记录为 anonymous；成员标签不代表操作人。',
  'ai-onboarding-guide': 'AI 接入指引',
  'ai-onboarding-intro': '这是根据当前部署实时生成的内网 Markdown，包含地址、账号状态和配置版本，但绝不包含 token。',
  'open-onboarding-warning': 'Open 模式下，任何能访问本控制台的人都可以读取这份实时指引及其中的部署/账号元数据。请把控制台保持在私有网络内；成员标签未经验证，也不代表操作人身份。',
  'copy-onboarding-link': '复制指引链接',
  'open-onboarding-guide': '打开指引',
  'metrics-dashboard-link': '查看请求指标',
  'metrics-label': '请求指标',
  'metrics-heading': 'Claude 网关请求指标',
  'metrics-intro': '本页只展示请求元数据；当前阶段不会存储请求正文或回复正文。',
  'metrics-attribution-disclaimer': '使用者标签由本人填写，未经验证；只能用于观察用量趋势，不得作为追责或计费依据。',
  'metrics-filter-heading': '筛选请求指标',
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
  'metrics-request-volume': '每小时请求量',
  'metrics-request-volume-description': '每小时全部请求、成功请求与错误请求的数量。',
  'metrics-latency': '每小时请求延迟',
  'metrics-latency-description': '每小时平均首字节时间与请求总耗时，单位为毫秒。',
  'metrics-no-data': '所选时间范围内没有匹配的请求数据。',
  'metrics-series-total': '全部请求',
  'metrics-series-success': '成功请求',
  'metrics-series-error': '错误请求',
  'metrics-series-ttfb': '平均首字节时间（毫秒）',
  'metrics-series-duration': '平均总耗时（毫秒）',
  'metrics-hourly-table': '每小时明细',
  'metrics-hour': '小时（UTC）',
  'metrics-request-count': '请求数',
  'metrics-success-count': '成功数',
  'metrics-error-count': '错误数',
  'metrics-request-bytes': '请求字节数',
  'metrics-response-bytes': '响应字节数',
  'metrics-avg-ttfb': '平均首字节时间（毫秒）',
  'metrics-avg-duration': '平均总耗时（毫秒）',
  'choose-codex-platform': '选择这台设备的操作系统',
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
  'status-stored': '已保存',
  'status-login-required': '需要登录'
};

function applyLanguage(language) {
  const selected = language === 'zh' ? 'zh' : 'en';
  document.documentElement.lang = selected === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    if (!element.dataset.i18nEn) element.dataset.i18nEn = element.textContent;
    element.textContent = selected === 'zh'
      ? (translations[element.dataset.i18n] ?? element.dataset.i18nEn)
      : element.dataset.i18nEn;
  });
  document.querySelectorAll('[data-account-option], [data-account-label]').forEach((element) => {
    const alias = element.dataset.accountAlias ?? '';
    const status = element.dataset.accountStatus ?? '';
    const key = 'status-' + status.replaceAll('_', '-');
    const englishStatus = status.replaceAll('_', ' ');
    const translatedStatus = selected === 'zh' ? (translations[key] ?? englishStatus) : englishStatus;
    element.textContent = alias + ' · ' + translatedStatus;
  });
  document.querySelectorAll('[data-placeholder-en]').forEach((element) => {
    element.placeholder = selected === 'zh'
      ? (element.dataset.placeholderZh ?? element.dataset.placeholderEn)
      : element.dataset.placeholderEn;
  });
  document.querySelectorAll('[data-language]').forEach((button) => {
    button.classList.toggle('active', button.dataset.language === selected);
    button.setAttribute('aria-pressed', button.dataset.language === selected ? 'true' : 'false');
  });
  localStorage.setItem('credential_console_language', selected);
}

applyLanguage(localStorage.getItem('credential_console_language') ?? 'en');

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
    button.textContent = (localStorage.getItem('credential_console_language') === 'zh') ? translations.copied : 'Copied';
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
        onboardingUrl,
        error: url.searchParams.get('error'),
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
        redirect(res, '/');
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
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true, openMode }));
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
        redirect(res, '/');
      } catch (error) {
        log('device_account_configuration_failed', {
          device_id: switchAccountParams.id,
          actor,
          code: error.code ?? error.name ?? 'unknown',
        });
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
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
    log('privacy_metadata_recording', {
      enabled: metricsEnabled,
      detail: metricsEnabled
        ? 'proxied Claude request metadata is stored and visible to every console member; member labels are self-entered and unverified and must not be used for accountability or billing; request and response bodies are not stored'
        : 'request metadata recording is unavailable, so requests are not currently being stored; request and response bodies are not stored',
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
