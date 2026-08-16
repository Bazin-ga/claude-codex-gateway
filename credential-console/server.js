#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
import { CredentialStore } from './lib/store.js';
import { acquireHomeLock } from './lib/home-lock.js';
import { handleClaudeProxy } from './lib/proxy.js';
import { UsageMonitor } from './lib/usage.js';
import {
  createClaudeAuthorizationRequest,
  exchangeClaudeAuthorization,
  parseClaudeAuthorizationCode,
} from './lib/claude-oauth.js';
import {
  claudeAuthorizationView,
  dashboardView,
  deviceConfiguredView,
  enrollmentCreatedView,
  enrollmentView,
  loginView,
  messageView,
  codexConfiguredView,
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
const ADMIN_AUTH = process.env.CREDENTIAL_CONSOLE_ADMIN_AUTH ?? 'password';
const CODEX_ENDPOINT = process.env.CREDENTIAL_CONSOLE_CODEX_ENDPOINT;
const CODEX_CERT_PIN = process.env.CREDENTIAL_CONSOLE_CODEX_CERT_PIN;
const CODEX_ENROLLMENT_KEY_FILE = process.env.CREDENTIAL_CONSOLE_CODEX_ENROLLMENT_KEY_FILE;
const USAGE_REFRESH_INTERVAL_MS = Number(
  process.env.CREDENTIAL_CONSOLE_USAGE_REFRESH_INTERVAL_MS ?? 60 * 60_000,
);
const SESSION_TTL_MS = 12 * 60 * 60_000;
export const SHUTDOWN_DEADLINE_MS = 1_000;
const CODEX_AGENT_ROOT = fileURLToPath(new URL('../codex-credential/client-agent/', import.meta.url));
const CODEX_AGENT_ASSETS = new Map([
  ['pull.js', 'pull.js'],
  ['package.json', 'package.json'],
  ['lib/pinned-request.js', 'lib/pinned-request.js'],
  ['install/install.sh', 'install/install.sh'],
  ['install/systemd/codex-credential.service', 'install/systemd/codex-credential.service'],
  ['install/systemd/codex-credential.timer', 'install/systemd/codex-credential.timer'],
  ['install/launchd/com.claude-codex-gateway.codex-credential.plist', 'install/launchd/com.claude-codex-gateway.codex-credential.plist'],
  ['install/windows/install.ps1', 'install/windows/install.ps1'],
]);

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

function clientIp(req) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return peer;
  return String(req.headers['x-forwarded-for'] ?? peer).split(',')[0].trim();
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

export async function createCredentialConsole(options = {}) {
  const store = options.store ?? await new CredentialStore(options.home ?? HOME).init();
  const usageMonitor = options.usageMonitor ?? await new UsageMonitor({
    store,
    home: options.home ?? store.home ?? HOME,
    refreshIntervalMs: options.usageRefreshIntervalMs ?? USAGE_REFRESH_INTERVAL_MS,
    fetchImpl: options.usageFetchImpl,
    log,
  }).init();
  const sessions = new Map();
  const loginAttempts = new Map();
  const publicBaseUrl = options.publicBaseUrl ?? PUBLIC_BASE_URL;
  const claudeGatewayUrl = options.claudeGatewayUrl
    ?? CLAUDE_GATEWAY_URL
    ?? `${publicBaseUrl.replace(/\/$/, '')}/claude`;
  const cookieSecure = options.cookieSecure ?? COOKIE_SECURE;
  const adminAuth = options.adminAuth ?? ADMIN_AUTH;
  const codexEndpoint = options.codexEndpoint ?? CODEX_ENDPOINT;
  const codexCertPin = options.codexCertPin ?? CODEX_CERT_PIN;
  let codexEnrollmentKey = options.codexEnrollmentKey;
  if (codexEnrollmentKey === undefined && CODEX_ENROLLMENT_KEY_FILE) {
    codexEnrollmentKey = (await readFile(CODEX_ENROLLMENT_KEY_FILE, 'utf8')).trim();
  }
  const codexEnroll = options.codexEnroll ?? requestCodexEnrollment;
  const claudeOauthExchange = options.claudeOauthExchange ?? exchangeClaudeAuthorization;
  const codexSelfServiceReady = Boolean(codexEndpoint && codexCertPin && codexEnrollmentKey);
  const codexAgentAssets = Object.fromEntries(await Promise.all(
    [...CODEX_AGENT_ASSETS].map(async ([assetName, relativePath]) => [
      assetName,
      await readFile(`${CODEX_AGENT_ROOT}${relativePath}`, 'utf8'),
    ]),
  ));
  if (!['password', 'tailscale'].includes(adminAuth)) {
    throw new Error('CREDENTIAL_CONSOLE_ADMIN_AUTH must be password or tailscale');
  }
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expires_at <= now) sessions.delete(token);
    }
    for (const [ip, attempt] of loginAttempts) {
      if (now - attempt.since > 15 * 60_000) loginAttempts.delete(ip);
    }
  }, 15 * 60_000);
  cleanupTimer.unref();

  function sessionFor(req, res, { create = false } = {}) {
    const identity = adminAuth === 'tailscale' ? tailnetIdentity(req) : null;
    if (adminAuth === 'tailscale' && !identity) return null;
    const token = parseCookies(req.headers.cookie).credential_console_session;
    const session = token ? sessions.get(token) : null;
    if (session && session.expires_at > Date.now()
      && (adminAuth !== 'tailscale' || session.admin_identity === identity)) {
      return session;
    }
    if (token) sessions.delete(token);
    if (adminAuth !== 'tailscale' || !create) {
      return null;
    }
    const newToken = randomToken(32);
    const newSession = {
      csrf: randomToken(24),
      expires_at: Date.now() + SESSION_TTL_MS,
      admin_identity: identity,
    };
    sessions.set(newToken, newSession);
    if (res) res.setHeader('Set-Cookie', setSessionCookie(newToken));
    log('tailnet_admin_authenticated', { identity });
    return newSession;
  }

  function requireSession(req, res) {
    const session = sessionFor(req, res, { create: true });
    if (!session) {
      if (adminAuth === 'password') {
        redirect(res, '/login');
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

  async function handler(req, res) {
    const url = new URL(req.url, publicBaseUrl);
    const path = url.pathname;

    if (path.startsWith('/claude/')) {
      await handleClaudeProxy(req, res, {
        store,
        upstreamBaseUrl: options.claudeUpstreamBaseUrl,
      });
      return;
    }

    if (req.method === 'GET' && path === '/assets/app.js') {
      sendText(res, 200, `
const translations = {
  'language': '语言',
  'brand-tagline': '私有账号与设备控制平面',
  'sign-out': '退出',
  'login-intro': '登录后可管理提供商账号并创建一次性设备登记。',
  'admin-password': '管理员密码',
  'sign-in': '登录',
  'member-zone-label': '成员自助区 · 所有成员看到的就是这里',
  'member-heading': '给这台设备开通 AI 工具',
  'member-intro': '选择团队账号并领取本机配置，不需要管理员转发令牌，也不需要登录共享的上游账号。',
  'tailscale-identity': 'Tailscale 身份',
  'claude-description': '领取一个只属于当前成员和设备、可通过公网使用的配置。上游 OAuth 令牌不会离开服务器。',
  'team-account': '团队账号',
  'device-name': '本机设备名',
  'get-claude': '领取 Claude Code 配置',
  'no-account': '尚无可用账号',
  'waiting-owner': '等待账号所有者录入',
  'owner-add-once': '账号所有者只需在下方管理员区录入一次，之后所有成员都能自行领取。',
  'codex-description': 'refresh center 会持续轮换主凭据。领取不依赖内网的单文件安装器与独立设备 token。',
  'operating-system': '设备系统',
  'get-codex': '领取 Codex 安装脚本',
  'codex-unavailable': 'Codex 自助登记尚未配置。管理员需要连接 dispenser enrollment。',
  'admin-zone': '管理员区',
  'admin-heading': '账号、设备与特殊登记',
  'admin-intro': '这里用于一次性录入上游账号、查看设备和撤销访问。普通成员的日常领取发生在上方自助区。',
  'accounts': '账号',
  'healthy': '健康',
  'active-devices': '活跃设备',
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
  'member-flow': '成员实际流程',
  'member-step-1': '成员加入 tailnet 后打开本页。',
  'member-step-2': '在上方成员自助区选择工具和账号，并填写设备名。',
  'member-step-3': '复制或下载只显示一次的本机安装脚本并运行。',
  'member-step-4': '设备丢失或停用时，只撤销该设备。',
  'same-self-service': '管理员和成员看到的是同一个自助区，不再需要人工分发授权凭证。',
  'no-devices': '尚无已登记设备。',
  'copy-now': '立即复制或下载此安装脚本',
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
  'copied': '已复制',
  'macos': 'macOS',
  'linux': 'Linux',
  'windows': 'Windows',
  'revoke': '撤销',
  'enroll-device': '登记设备',
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
    await navigator.clipboard.writeText(target.textContent);
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
        admin_configured: adminAuth === 'tailscale' || store.hasAdmin(),
      });
      return;
    }

    if (req.method === 'GET' && path === '/login') {
      if (adminAuth === 'tailscale') {
        const session = sessionFor(req, res, { create: true });
        if (session) redirect(res, '/');
        else sendHtml(res, 403, messageView(
          'Tailnet identity required',
          'Open this page through Tailscale Serve from a user-owned tailnet device.',
          { error: true },
        ));
        return;
      }
      if (sessionFor(req)) {
        redirect(res, '/');
        return;
      }
      sendHtml(res, 200, loginView({ setupRequired: !store.hasAdmin() }));
      return;
    }

    if (req.method === 'POST' && path === '/login') {
      if (adminAuth !== 'password') {
        sendHtml(res, 404, messageView('Not found', 'Password login is disabled.', { error: true }));
        return;
      }
      const ip = clientIp(req);
      const attempt = loginAttempts.get(ip) ?? { since: Date.now(), count: 0 };
      if (Date.now() - attempt.since > 15 * 60_000) {
        attempt.since = Date.now();
        attempt.count = 0;
      }
      attempt.count += 1;
      loginAttempts.set(ip, attempt);
      if (attempt.count > 8) {
        sendHtml(res, 429, loginView({ error: 'Too many login attempts. Try again later.' }));
        return;
      }
      const form = await readForm(req, 16 * 1024).catch(() => ({}));
      if (!store.hasAdmin() || !await store.verifyAdminPassword(form.password ?? '')) {
        log('admin_login_failed', { ip });
        sendHtml(res, 401, loginView({ error: 'Invalid administrator password.' }));
        return;
      }
      loginAttempts.delete(ip);
      const token = randomToken(32);
      sessions.set(token, {
        csrf: randomToken(24),
        expires_at: Date.now() + SESSION_TTL_MS,
      });
      log('admin_login_succeeded', { ip });
      redirect(res, '/', { 'Set-Cookie': setSessionCookie(token) });
      return;
    }

    if (req.method === 'POST' && path === '/logout') {
      const token = parseCookies(req.headers.cookie).credential_console_session;
      if (token) sessions.delete(token);
      redirect(res, '/login', {
        'Set-Cookie': 'credential_console_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      });
      return;
    }

    if (req.method === 'GET' && path === '/') {
      const session = requireSession(req, res);
      if (!session) return;
      sendHtml(res, 200, dashboardView({
        accounts: await accountsWithExternalStatus(),
        devices: store.publicDevices(),
        csrf: session.csrf,
        adminIdentity: session.admin_identity,
        canSignOut: adminAuth === 'password',
        codexSelfServiceReady,
        error: url.searchParams.get('error'),
      }));
      return;
    }

    if (req.method === 'POST' && path === '/codex/self-service') {
      const session = requireSession(req, res);
      if (!session) return;
      if (!session.admin_identity) {
        sendHtml(res, 403, messageView(
          'Tailnet identity required',
          'Codex self-service requires a Tailscale user identity.',
          { error: true },
        ));
        return;
      }
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true }));
        return;
      }
      try {
        if (!codexSelfServiceReady) throw new Error('Codex self-service is not configured');
        const deviceName = String(form.device_name ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(deviceName)) {
          throw new Error('device name must use letters, numbers, dots, underscores, or hyphens');
        }
        const memberSuffix = createHash('sha256')
          .update(session.admin_identity)
          .digest('hex')
          .slice(0, 10);
        const machineName = `${deviceName.slice(0, 53)}-${memberSuffix}`;
        const issued = await codexEnroll({
          endpoint: codexEndpoint,
          enrollmentKey: codexEnrollmentKey,
          pin: codexCertPin,
          name: machineName,
        });
        log('codex_device_self_enrolled', {
          identity: session.admin_identity,
          device_name: deviceName,
          dispenser_name: issued.name,
        });
        sendHtml(res, 200, codexConfiguredView({
          deviceName,
          token: issued.token,
          endpoint: codexEndpoint,
          certPin: codexCertPin,
          assets: codexAgentAssets,
        }));
      } catch (error) {
        log('codex_device_self_enroll_failed', {
          identity: session.admin_identity,
          error: error.message,
        });
        redirect(res, `/?error=${encodeURIComponent(error.message)}`);
      }
      return;
    }

    if (req.method === 'POST' && path === '/self-service') {
      const session = requireSession(req, res);
      if (!session) return;
      if (!session.admin_identity) {
        sendHtml(res, 403, messageView(
          'Tailnet identity required',
          'Self-service access requires a Tailscale user identity.',
          { error: true },
        ));
        return;
      }
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true }));
        return;
      }
      try {
        const result = await store.issueDeviceCredential({
          accountId: String(form.account_id ?? ''),
          memberLabel: session.admin_identity,
          deviceName: String(form.device_name ?? '').trim(),
        });
        sendHtml(res, 200, deviceConfiguredView({
          ...result,
          claudeGatewayUrl,
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
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true }));
        return;
      }
      try {
        if (form.provider !== 'claude') throw new Error('only Claude accounts can be added in the web UI');
        const emailLabel = String(form.email_label ?? '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLabel)) {
          throw new Error('a valid account owner email is required');
        }
        await store.addAccount({
          provider: 'claude',
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
        sendHtml(res, 404, messageView('Account not found', 'Claude account was not found.', { error: true }));
        return;
      }
      sendHtml(res, 200, claudeAuthorizationView({
        account,
        csrf: session.csrf,
        ownerPageUrl: `${publicBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(account.id)}/claude-authorization`,
        canSignOut: adminAuth === 'password',
      }));
      return;
    }

    const claudeAuthorizationStartParams = routeMatch(path, '/accounts/:id/claude-authorization/start');
    if (req.method === 'POST' && claudeAuthorizationStartParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true }));
        return;
      }
      const account = store.accountById(claudeAuthorizationStartParams.id);
      if (!account || account.provider !== 'claude') {
        sendHtml(res, 404, messageView('Account not found', 'Claude account was not found.', { error: true }));
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
          canSignOut: adminAuth === 'password',
        }));
      } catch (error) {
        sendHtml(res, 400, claudeAuthorizationView({
          account,
          csrf: session.csrf,
          ownerPageUrl: `${publicBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(account.id)}/claude-authorization`,
          error: error.message,
          canSignOut: adminAuth === 'password',
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
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true }));
        return;
      }
      const account = store.accountById(claudeAuthorizationCompleteParams.id);
      if (!account || account.provider !== 'claude') {
        sendHtml(res, 404, messageView('Account not found', 'Claude account was not found.', { error: true }));
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
          throw new Error('authorization must be completed by the same signed-in owner who started it');
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
          canSignOut: adminAuth === 'password',
        }));
      }
      return;
    }

    const enrollmentParams = routeMatch(path, '/accounts/:id/enrollments');
    if (req.method === 'POST' && enrollmentParams) {
      const session = requireSession(req, res);
      if (!session) return;
      const form = await readForm(req).catch(() => ({}));
      if (!checkCsrf(session, form)) {
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true }));
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
          canSignOut: adminAuth === 'password',
        }));
      } catch (error) {
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
        sendHtml(res, 403, messageView('Request refused', 'Invalid CSRF token.', { error: true }));
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
        sendHtml(res, 410, messageView('Enrollment unavailable', 'This enrollment link is invalid, expired, or already used.', { error: true }));
        return;
      }
      sendHtml(res, 200, enrollmentView({
        account,
        memberLabel: enrollment.member_label,
        code: redeemParams.code,
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
        }));
      } catch (error) {
        const enrollment = store.enrollmentByCode(redeemParams.code);
        const account = enrollment ? store.accountById(enrollment.account_id) : null;
        if (!enrollment || !account || enrollment.used_at) {
          sendHtml(res, 410, messageView('Enrollment unavailable', error.message, { error: true }));
        } else {
          sendHtml(res, 400, enrollmentView({
            account,
            memberLabel: enrollment.member_label,
            code: redeemParams.code,
            error: error.message,
          }));
        }
      }
      return;
    }

    sendHtml(res, 404, messageView('Not found', 'The requested page does not exist.', { error: true }));
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
  });
  return { server, store, handler, usageMonitor };
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
    const { store } = created;
    server.once('close', () => {
      releaseHomeLock().catch((error) => console.error(error.stack ?? error.message));
    });
    if (ADMIN_AUTH === 'password' && !store.hasAdmin()) {
      log('admin_not_configured', {
        remediation: 'run node cli.js init-admin --password-file <path> before exposing the service',
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
