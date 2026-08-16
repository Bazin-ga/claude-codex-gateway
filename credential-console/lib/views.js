import { escapeHtml } from './http.js';

const styles = `
:root {
  color-scheme: light;
  --ink: #16211d;
  --muted: #60706a;
  --paper: #f3f5ef;
  --card: #fffefa;
  --line: #d9dfd7;
  --green: #1f6b4f;
  --green-dark: #124333;
  --amber: #9a5d16;
  --red: #a33a31;
  --blue: #285e8e;
  --member: #0f5138;
  --member-soft: #e7f6ee;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); }
a { color: var(--green); }
.shell { max-width: 1180px; margin: 0 auto; padding: 28px 22px 64px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 28px; }
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.language-switch { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--line); border-radius: 11px; background: white; }
.language-switch button { min-width: 46px; padding: 6px 9px; background: transparent; color: var(--muted); }
.language-switch button:hover, .language-switch button.active { background: var(--ink); color: white; }
.brand { display: flex; align-items: center; gap: 12px; }
.mark { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; background: var(--ink); color: white; font-weight: 800; }
h1 { font-size: clamp(28px, 4vw, 44px); letter-spacing: -0.04em; margin: 0; }
h2 { font-size: 20px; margin: 0 0 18px; }
p { line-height: 1.55; }
.muted { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 18px; }
.card { grid-column: span 12; background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; box-shadow: 0 14px 34px rgba(22,33,29,.055); }
.summary { grid-column: span 4; }
.summary strong { display: block; font-size: 30px; margin-top: 8px; }
.split { grid-column: span 6; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 13px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
tr:last-child td { border-bottom: 0; }
.badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; background: #e8eee9; color: var(--muted); }
.badge.healthy { background: #dff2e8; color: var(--green); }
.badge.unhealthy, .badge.expired { background: #f8e4e1; color: var(--red); }
.badge.stored { background: #e5edf4; color: var(--blue); }
.badge.login_required { background: #faecd7; color: var(--amber); }
form { margin: 0; }
label { display: block; font-weight: 700; font-size: 13px; margin-bottom: 12px; }
input, select, textarea { width: 100%; margin-top: 6px; border: 1px solid #c7d0c7; background: white; border-radius: 10px; padding: 10px 12px; color: var(--ink); font: inherit; }
textarea { min-height: 112px; resize: vertical; }
button, .button { appearance: none; border: 0; border-radius: 10px; padding: 10px 14px; background: var(--green); color: white; font-weight: 750; cursor: pointer; text-decoration: none; display: inline-block; }
button:hover, .button:hover { background: var(--green-dark); }
button:disabled, select:disabled, input:disabled { cursor: not-allowed; opacity: .58; }
.button.secondary, button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
button.danger { background: var(--red); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.stack { display: grid; gap: 14px; }
.notice { border-left: 4px solid var(--amber); background: #fff7e9; padding: 12px 14px; border-radius: 0 10px 10px 0; }
.success { border-left-color: var(--green); background: #eaf6ef; }
.error { border-left-color: var(--red); background: #faebe9; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
pre { background: #111a17; color: #e9f2ed; border-radius: 12px; padding: 16px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
.login { max-width: 450px; margin: 11vh auto 0; }
.login .card { padding: 30px; }
.empty { color: var(--muted); padding: 18px 0; }
.inline { display: flex; gap: 10px; align-items: end; }
.inline > * { flex: 1; }
.tiny { font-size: 12px; }
.member-zone { background: linear-gradient(135deg, #0d3f2d 0%, #176548 100%); color: white; border-radius: 24px; padding: 28px; box-shadow: 0 18px 48px rgba(15,81,56,.2); }
.member-zone .muted { color: #cce6d9; }
.zone-heading { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 22px; }
.zone-label { display: inline-flex; border-radius: 999px; padding: 6px 10px; margin-bottom: 12px; background: rgba(255,255,255,.14); color: white; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.identity-chip { border: 1px solid rgba(255,255,255,.24); border-radius: 12px; padding: 10px 12px; color: #e2f2ea; font-size: 13px; white-space: nowrap; }
.provider-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.provider-card { background: white; color: var(--ink); border-radius: 18px; padding: 20px; min-height: 230px; }
.provider-title { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
.provider-title h2 { margin: 0; }
.provider-card .muted { color: var(--muted); }
.quota-list { display: grid; gap: 10px; margin: 14px 0; }
.quota-account { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: #fbfcf9; }
.quota-account-name { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
.quota-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.quota-window { border-radius: 9px; padding: 9px 10px; background: #eef3ee; }
.quota-window > span, .quota-window > small { display: block; color: var(--muted); font-size: 11px; }
.quota-window strong { display: block; margin: 3px 0; font-size: 15px; }
.quota-meta { margin-top: 8px; color: var(--muted); font-size: 11px; }
.quota-message { margin: 8px 0 0; color: var(--amber); font-size: 12px; line-height: 1.4; }
.quota-message.error { color: var(--red); background: transparent; border: 0; padding: 0; }
.member-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; margin-top: 18px; }
.member-form.codex-form { grid-template-columns: 1fr auto; }
.member-form label { margin-bottom: 0; }
.admin-zone { border-top: 1px solid var(--line); padding-top: 28px; margin-top: 12px; }
.admin-heading { margin-bottom: 18px; }
.admin-heading h2 { font-size: 26px; margin-bottom: 6px; }
.setup-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.setup-actions > * { flex: 1; text-align: center; }
.installer-list { display: grid; gap: 14px; }
.installer-panel { border: 1px solid var(--line); border-radius: 14px; padding: 16px; background: #fbfcf9; }
.installer-panel h2 { margin-bottom: 12px; }
.installer-panel details { margin-top: 12px; }
.installer-panel summary { cursor: pointer; color: var(--green); font-weight: 750; }
.installer-panel pre { max-height: 320px; font-size: 12px; }
.run-command { background: #e9efea; border-radius: 10px; padding: 12px 14px; font-family: "SFMono-Regular", Consolas, monospace; word-break: break-all; }
@media (max-width: 800px) {
  .summary, .split { grid-column: span 12; }
  .topbar { align-items: flex-start; }
  .table-wrap { overflow-x: auto; }
  .zone-heading { display: grid; }
  .identity-chip { white-space: normal; }
  .provider-grid, .member-form, .member-form.codex-form { grid-template-columns: 1fr; }
}
`;

function layout(title, content, { canSignOut = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} · Credential Console</title>
  <style>${styles}</style>
  <script src="/assets/app.js" defer></script>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><div class="mark">N</div><div><strong>Credential Console</strong><div class="muted tiny" data-i18n="brand-tagline">Private account and device control plane</div></div></div>
      <div class="topbar-actions">
        <div class="language-switch" aria-label="Language">
          <button type="button" data-language="en" aria-pressed="true">EN</button>
          <button type="button" data-language="zh" aria-pressed="false">中文</button>
        </div>
        ${canSignOut ? '<form method="post" action="/logout"><button class="secondary" type="submit" data-i18n="sign-out">Sign out</button></form>' : ''}
      </div>
    </header>
    ${content}
  </main>
</body>
</html>`;
}

export function loginView({ error = null, setupRequired = false } = {}) {
  return layout('Sign in', `
    <section class="login">
      <div class="card">
        <h1>Credential Console</h1>
        <p class="muted" data-i18n="login-intro">Sign in to manage provider accounts and issue one-time device enrollment links.</p>
        ${setupRequired ? '<div class="notice error">No administrator password is configured. Initialize it from the server CLI before exposing this service.</div>' : ''}
        ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
        <form method="post" action="/login" class="stack" autocomplete="off">
          <input name="username" value="admin" autocomplete="username" hidden>
          <label><span data-i18n="admin-password">Administrator password</span>
            <input name="password" type="password" required minlength="14" autocomplete="current-password">
          </label>
          <button type="submit" data-i18n="sign-in">Sign in</button>
        </form>
      </div>
    </section>
  `);
}

function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}" data-i18n="status-${escapeHtml(status.replaceAll('_', '-'))}">${escapeHtml(status.replaceAll('_', ' '))}</span>`;
}

function dateText(value) {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('en-GB', { hour12: false }) : value;
}

function quotaWindowView(usage, kind, label, i18n) {
  const window = usage?.windows?.find((entry) => entry.kind === kind);
  if (!window) {
    return `<div class="quota-window">
      <span data-i18n="${i18n}">${label}</span>
      <strong>—</strong>
      <small data-i18n="usage-not-reported">Not reported by provider</small>
    </div>`;
  }
  return `<div class="quota-window">
    <span data-i18n="${i18n}">${label}</span>
    <strong><span data-i18n="usage-remaining">Remaining</span> ${escapeHtml(window.remaining_percent)}%</strong>
    <small><span data-i18n="usage-resets">Resets</span> ${escapeHtml(dateText(window.resets_at))}</small>
  </div>`;
}

function accountUsageView(account, { showAccount = false } = {}) {
  const usage = account.usage;
  const message = usage?.status === 'reauthorization_required'
    ? '<div class="quota-message" data-i18n="usage-reauthorize">Reauthorize this Claude account once to enable quota reporting.</div>'
    : usage?.status === 'stale'
      ? '<div class="quota-message" data-i18n="usage-stale">Showing the last successful reading; the latest refresh failed.</div>'
      : usage?.status === 'unavailable'
        ? '<div class="quota-message error" data-i18n="usage-unavailable">Usage is temporarily unavailable.</div>'
        : !usage
          ? '<div class="quota-message" data-i18n="usage-loading">Waiting for the first hourly usage refresh.</div>'
          : '';
  const updatedAt = usage?.fetched_at ?? usage?.attempted_at;
  return `<div class="quota-account">
    ${showAccount ? `<div class="quota-account-name"><strong>${escapeHtml(account.alias)}</strong>${usage?.plan_type ? `<span class="badge stored">${escapeHtml(usage.plan_type)}</span>` : ''}</div>` : ''}
    <div class="quota-grid">
      ${quotaWindowView(usage, 'five_hour', '5-hour window', 'usage-five-hour')}
      ${quotaWindowView(usage, 'weekly', 'Weekly window', 'usage-weekly')}
    </div>
    ${message}
    ${updatedAt ? `<div class="quota-meta"><span data-i18n="usage-updated">Updated</span> ${escapeHtml(dateText(updatedAt))}</div>` : ''}
  </div>`;
}

export function dashboardView({
  accounts,
  devices,
  csrf,
  adminIdentity = null,
  canSignOut = true,
  codexSelfServiceReady = false,
  error = null,
}) {
  const activeDevices = devices.filter((device) => !device.revoked_at);
  const healthy = accounts.filter((account) => account.status === 'healthy').length;
  const selfServiceAccounts = accounts.filter((account) => (
    account.provider === 'claude'
    && ['stored', 'healthy'].includes(account.status)
    && (!account.expires_at || Date.parse(account.expires_at) > Date.now())
  ));
  const selfServiceOptions = selfServiceAccounts.map((account) => (
    `<option value="${escapeHtml(account.id)}">${escapeHtml(account.alias)}${account.email_label ? ` · ${escapeHtml(account.email_label)}` : ''}</option>`
  )).join('');
  const codexAccounts = accounts.filter((account) => account.provider === 'codex');
  const primaryCodex = codexAccounts[0] ?? null;
  const claudeUsage = selfServiceAccounts.map((account) => accountUsageView(account, {
    showAccount: selfServiceAccounts.length > 1,
  })).join('');
  const accountRows = accounts.map((account) => {
    const available = ['stored', 'healthy'].includes(account.status);
    return `
    <tr>
      <td><strong>${escapeHtml(account.alias)}</strong><div class="muted tiny">${escapeHtml(account.email_label || 'No email label')}</div></td>
      <td>${escapeHtml(account.provider === 'claude' ? 'Claude Code' : 'Codex')}</td>
      <td>${statusBadge(account.status)}</td>
      <td>${escapeHtml(account.active_devices ?? '—')}</td>
      <td>${escapeHtml(dateText(account.expires_at))}</td>
      <td>${accountUsageView(account)}</td>
      <td>
        ${account.provider === 'claude' ? `<div class="stack">
          <a class="button secondary" href="/accounts/${encodeURIComponent(account.id)}/claude-authorization" data-i18n="owner-authorization">Owner authorization</a>
          ${available ? `<form method="post" action="/accounts/${encodeURIComponent(account.id)}/enrollments" class="inline">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input name="member_label" aria-label="Member label for ${escapeHtml(account.alias)}" placeholder="member email/name" required maxlength="160">
          <button type="submit" data-i18n="enroll-device">Enroll device</button>
        </form>` : '<span class="muted tiny" data-i18n="owner-login-required">Account owner must authorize before member enrollment.</span>'}
        </div>` : '<span class="muted tiny" data-i18n="existing-codex-agent">Existing Codex agent</span>'}
      </td>
    </tr>
  `;
  }).join('');
  const deviceRows = devices.map((device) => {
    const account = accounts.find((entry) => entry.id === device.account_id);
    return `<tr>
      <td><strong>${escapeHtml(device.name)}</strong><div class="muted tiny">${escapeHtml(device.member_label)}</div></td>
      <td>${escapeHtml(account?.alias ?? 'unknown')}</td>
      <td>${device.revoked_at ? statusBadge('expired') : statusBadge('healthy')}</td>
      <td>${escapeHtml(dateText(device.last_seen_at))}</td>
      <td>${device.revoked_at ? escapeHtml(dateText(device.revoked_at)) : `<form method="post" action="/devices/${encodeURIComponent(device.id)}/revoke">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button class="danger" type="submit" data-i18n="revoke">Revoke</button>
      </form>`}</td>
    </tr>`;
  }).join('');

  return layout('Dashboard', `
    <div class="stack">
      ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
      ${adminIdentity ? `<section class="member-zone">
        <div class="zone-heading">
          <div>
            <span class="zone-label" data-i18n="member-zone-label">Member self-service · This is exactly what every member sees</span>
            <h1 data-i18n="member-heading">Set up AI tools on this device</h1>
            <p class="muted" data-i18n="member-intro">Choose a team account and get a local setup. No administrator handoff and no shared provider login.</p>
          </div>
          <div class="identity-chip"><span data-i18n="tailscale-identity">Tailscale identity</span><br><strong>${escapeHtml(adminIdentity)}</strong></div>
        </div>
        <div class="provider-grid">
          <article class="provider-card">
            <div class="provider-title"><h2>Claude Code</h2>${selfServiceAccounts.length ? statusBadge('healthy') : statusBadge('login_required')}</div>
            <p class="muted" data-i18n="claude-description">Get a public-internet configuration scoped to this member and device. The provider OAuth token never leaves the server.</p>
            ${selfServiceAccounts.length ? `<div class="quota-list">${claudeUsage}</div>` : ''}
            ${selfServiceAccounts.length ? `<form method="post" action="/self-service" class="member-form">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <label><span data-i18n="team-account">Team account</span>
                <select name="account_id" required>${selfServiceOptions}</select>
              </label>
              <label><span data-i18n="device-name">Device name</span>
                <input name="device_name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="my-macbook" maxlength="64">
              </label>
              <div><button type="submit" data-i18n="get-claude">Get Claude Code setup</button></div>
            </form>` : `<div class="member-form">
              <label><span data-i18n="team-account">Team account</span><select disabled><option data-i18n="no-account">No account available</option></select></label>
              <label><span data-i18n="device-name">Device name</span><input disabled data-placeholder-en="Available after account enrollment" data-placeholder-zh="账号录入后即可填写" placeholder="Available after account enrollment"></label>
              <div><button type="button" disabled data-i18n="waiting-owner">Waiting for account owner</button></div>
            </div><p class="muted tiny" data-i18n="owner-add-once">An account owner adds it once below; every member can then self-serve.</p>`}
          </article>
          <article class="provider-card">
            <div class="provider-title"><h2>Codex</h2>${primaryCodex ? statusBadge(primaryCodex.status) : statusBadge('login_required')}</div>
            ${primaryCodex ? `<p><strong>${escapeHtml(primaryCodex.alias)}</strong></p>` : ''}
            <p class="muted" data-i18n="codex-description">The refresh center rotates the master credential. Get a self-contained installer and independent device token that do not require tailnet access.</p>
            ${primaryCodex ? `<div class="quota-list">${accountUsageView(primaryCodex)}</div>` : ''}
            ${primaryCodex && codexSelfServiceReady ? `<form method="post" action="/codex/self-service" class="member-form codex-form">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <label><span data-i18n="device-name">Device name</span>
                <input name="device_name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="my-laptop" maxlength="64">
              </label>
              <div><button type="submit" data-i18n="get-codex">Get Codex installer</button></div>
            </form>` : '<div class="notice" data-i18n="codex-unavailable">Codex self-service enrollment is not configured yet. An administrator must connect dispenser enrollment.</div>'}
          </article>
        </div>
      </section>` : ''}

      <section class="admin-zone">
        <div class="admin-heading">
          <span class="badge stored" data-i18n="admin-zone">Administrator area</span>
          <h2 data-i18n="admin-heading">Accounts, devices, and exceptional enrollment</h2>
          <p class="muted" data-i18n="admin-intro">Use this area to add provider accounts once, inspect devices, and revoke access. Routine member setup happens above.</p>
        </div>
        <section class="grid">
          <article class="card summary"><span class="muted" data-i18n="accounts">Accounts</span><strong>${accounts.length}</strong></article>
          <article class="card summary"><span class="muted" data-i18n="healthy">Healthy</span><strong>${healthy}</strong></article>
          <article class="card summary"><span class="muted" data-i18n="active-devices">Active devices</span><strong>${activeDevices.length}</strong></article>
          <article class="card">
            <div class="topbar"><div><h2 data-i18n="accounts">Accounts</h2><div class="muted tiny" data-i18n="upstream-secret-note">Provider tokens are encrypted and never displayed after submission. Exceptional one-time enrollment remains available per account.</div></div></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th data-i18n="account">Account</th><th data-i18n="provider">Provider</th><th data-i18n="status">Status</th><th data-i18n="devices">Devices</th><th data-i18n="expires">Expires</th><th data-i18n="usage-quota">Usage quota</th><th data-i18n="action">Action</th></tr></thead>
                <tbody>${accountRows || '<tr><td colspan="7" class="empty" data-i18n="no-accounts">No accounts yet.</td></tr>'}</tbody>
              </table>
            </div>
          </article>
          <article class="card split">
            <h2 data-i18n="add-claude-heading">Add a Claude Code team account</h2>
            <div class="notice"><span data-i18n="add-claude-help">Register the expected owner email once. The owner completes OAuth later from the account's permanent authorization page; no token is handed to an administrator.</span></div>
            <form method="post" action="/accounts" class="stack" autocomplete="off">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="provider" value="claude">
              <label><span data-i18n="account-alias">Account alias</span>
                <input name="alias" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" placeholder="claude-max-1">
              </label>
              <label><span data-i18n="account-email">Account email label</span>
                <input name="email_label" type="email" placeholder="owner@example.com" maxlength="160" required>
              </label>
              <button type="submit" data-i18n="register-account">Register account</button>
            </form>
          </article>
          <article class="card split">
            <h2 data-i18n="member-flow">What members actually do</h2>
            <div class="stack">
              <p><strong>1.</strong> <span data-i18n="member-step-1">Join the tailnet and open this page.</span></p>
              <p><strong>2.</strong> <span data-i18n="member-step-2">Choose a tool and account, then enter a device name.</span></p>
              <p><strong>3.</strong> <span data-i18n="member-step-3">Copy or download the one-time local installer and run it.</span></p>
              <p><strong>4.</strong> <span data-i18n="member-step-4">Revoke only that device if it is lost or retired.</span></p>
            </div>
            <div class="notice success" data-i18n="same-self-service">Administrators and members see the same self-service area. No manual credential delivery is required.</div>
          </article>
          <article class="card">
            <h2 data-i18n="devices">Devices</h2>
            <div class="table-wrap">
              <table>
                <thead><tr><th data-i18n="device-name">Device</th><th data-i18n="account">Account</th><th data-i18n="status">Status</th><th data-i18n="last-seen">Last seen</th><th data-i18n="action">Action</th></tr></thead>
                <tbody>${deviceRows || '<tr><td colspan="5" class="empty" data-i18n="no-devices">No devices enrolled yet.</td></tr>'}</tbody>
              </table>
            </div>
          </article>
        </section>
      </section>
    </div>
  `, { canSignOut });
}

export function claudeAuthorizationView({
  account,
  csrf,
  ownerPageUrl,
  authorization = null,
  error = null,
  canSignOut = true,
}) {
  return layout('Claude account authorization', `
    <section class="login">
      <div class="card stack">
        <div><span class="badge stored">Claude Code</span></div>
        <h1 data-i18n="owner-auth-heading">Account owner authorization</h1>
        <p><span data-i18n="owner-auth-account">Expected account</span>: <strong>${escapeHtml(account.email_label)}</strong><br>
          <span data-i18n="team-account">Team account</span>: <strong>${escapeHtml(account.alias)}</strong></p>
        ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
        <div class="notice" data-i18n="owner-page-permanent">This control-page URL is permanent. Open it whenever the account owner is ready; the temporary OAuth session is created only after Start authorization is pressed.</div>
        <pre id="owner-page-url">${escapeHtml(ownerPageUrl)}</pre>
        <button type="button" class="secondary" data-copy-target="owner-page-url" data-i18n="copy-owner-link">Copy owner page link</button>
        <form method="post" action="/accounts/${encodeURIComponent(account.id)}/claude-authorization/start">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button type="submit" data-i18n="start-authorization">Start a fresh authorization</button>
        </form>
        ${authorization ? `
          <div class="notice success"><span data-i18n="temporary-session-ready">A fresh 15-minute authorization session is ready.</span><br><span class="tiny">${escapeHtml(dateText(authorization.expires_at))}</span></div>
          <ol class="stack">
            <li data-i18n="owner-auth-step-1">Open the Claude page below and sign in with the expected account.</li>
            <li data-i18n="owner-auth-step-2">Approve inference and usage-view access, then copy the complete code including # and everything after it.</li>
            <li data-i18n="owner-auth-step-3">Return here, paste the code, and submit. The server exchanges and stores the credential automatically.</li>
          </ol>
          <a class="button" href="${escapeHtml(authorization.url)}" target="_blank" rel="noopener noreferrer" data-i18n="open-claude-authorization">Open Claude authorization</a>
          <form method="post" action="/accounts/${encodeURIComponent(account.id)}/claude-authorization/complete" class="stack" autocomplete="off">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <label><span data-i18n="authorization-code">Complete authorization code</span>
              <textarea name="authorization_code" required minlength="20" spellcheck="false" autocomplete="off" placeholder="code#state"></textarea>
            </label>
            <button type="submit" data-i18n="complete-authorization">Complete authorization</button>
          </form>
        ` : ''}
        <div class="notice" data-i18n="owner-auth-security">Passwords, browser cookies, authorization codes, and provider tokens are never shown to an administrator. A mismatched account email is rejected before storage.</div>
        <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
      </div>
    </section>
  `, { canSignOut });
}

export function enrollmentCreatedView({ account, memberLabel, link, canSignOut = true }) {
  return layout('Enrollment created', `
    <section class="login">
      <div class="card stack">
        <div class="notice success">One-time enrollment created for <strong>${escapeHtml(memberLabel)}</strong>.</div>
        <h1>${escapeHtml(account.alias)}</h1>
        <p class="muted">This link expires in 30 minutes and can be used exactly once. Send it through a private channel.</p>
        <pre id="enrollment-link">${escapeHtml(link)}</pre>
        <button type="button" data-copy-target="enrollment-link">Copy enrollment link</button>
        <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
      </div>
    </section>
  `, { canSignOut });
}

export function enrollmentView({ account, memberLabel, code, error = null }) {
  return layout('Enroll device', `
    <section class="login">
      <div class="card stack">
        <div><span class="badge stored">${escapeHtml(account.provider === 'claude' ? 'Claude Code' : 'Codex')}</span></div>
        <h1 data-i18n="enroll-heading">Enroll a device</h1>
        <p>Account: <strong>${escapeHtml(account.alias)}</strong><br>Member: <strong>${escapeHtml(memberLabel || 'Unlabelled member')}</strong></p>
        ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
        <form method="post" action="/enroll/${encodeURIComponent(code)}" class="stack">
          <label><span data-i18n="device-name">Device name</span>
            <input name="device_name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="work-laptop" maxlength="64">
          </label>
          <button type="submit" data-i18n="create-device-credential">Create device credential</button>
        </form>
        <p class="muted tiny" data-i18n="device-scope-note">The resulting credential is scoped to this device and can be revoked without affecting anyone else.</p>
      </div>
    </section>
  `);
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function powerShellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function base64Asset(assets, name) {
  const source = assets?.[name];
  if (typeof source !== 'string') throw new Error(`missing Codex installer asset: ${name}`);
  return Buffer.from(source, 'utf8').toString('base64');
}

function codexUnixInstaller({ assets, endpoint, certPin, token }) {
  return `#!/usr/bin/env bash
set -euo pipefail

STAGE="$(mktemp -d "\${TMPDIR:-/tmp}/codex-gateway.XXXXXX")"
ROOT="$STAGE/client-agent"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

write_asset() {
  local relative="$1"
  local payload="$2"
  mkdir -p "$(dirname "$ROOT/$relative")"
  node -e 'require("node:fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"))' \\
    "$ROOT/$relative" "$payload"
}

write_asset pull.js ${shellSingleQuote(base64Asset(assets, 'pull.js'))}
write_asset package.json ${shellSingleQuote(base64Asset(assets, 'package.json'))}
write_asset lib/pinned-request.js ${shellSingleQuote(base64Asset(assets, 'lib/pinned-request.js'))}
write_asset install/install.sh ${shellSingleQuote(base64Asset(assets, 'install/install.sh'))}
write_asset install/systemd/codex-credential.service ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential.service'))}
write_asset install/systemd/codex-credential.timer ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential.timer'))}
write_asset install/launchd/com.claude-codex-gateway.codex-credential.plist ${shellSingleQuote(base64Asset(assets, 'install/launchd/com.claude-codex-gateway.codex-credential.plist'))}
chmod 700 "$ROOT/install/install.sh"

"$ROOT/install/install.sh" \\
  --endpoint ${shellSingleQuote(endpoint)} \\
  --token ${shellSingleQuote(token)} \\
  --cert-pin ${shellSingleQuote(certPin)}
`;
}

function codexWindowsInstaller({ assets, endpoint, certPin, token }) {
  return `$ErrorActionPreference = 'Stop'
$Stage = Join-Path $env:TEMP ('codex-gateway-' + [guid]::NewGuid().ToString('N'))
$Root = Join-Path $Stage 'client-agent'
$Assets = @{
  'pull.js' = ${powerShellSingleQuote(base64Asset(assets, 'pull.js'))}
  'package.json' = ${powerShellSingleQuote(base64Asset(assets, 'package.json'))}
  'lib/pinned-request.js' = ${powerShellSingleQuote(base64Asset(assets, 'lib/pinned-request.js'))}
  'install/windows/install.ps1' = ${powerShellSingleQuote(base64Asset(assets, 'install/windows/install.ps1'))}
}

try {
  foreach ($Relative in $Assets.Keys) {
    $Target = Join-Path $Root ($Relative -replace '/', '\\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
    [System.IO.File]::WriteAllBytes($Target, [Convert]::FromBase64String($Assets[$Relative]))
  }
  & (Join-Path $Root 'install\\windows\\install.ps1') -Endpoint ${powerShellSingleQuote(endpoint)} -Token ${powerShellSingleQuote(token)} -CertPin ${powerShellSingleQuote(certPin)}
} finally {
  Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
}
`;
}

export function codexConfiguredView({
  deviceName,
  token,
  endpoint,
  certPin,
  assets,
}) {
  const unixScript = codexUnixInstaller({ assets, endpoint, certPin, token });
  const installers = [
    { platform: 'macos', label: 'macOS', script: unixScript, extension: 'sh' },
    { platform: 'linux', label: 'Linux', script: unixScript, extension: 'sh' },
    {
      platform: 'windows',
      label: 'Windows PowerShell',
      script: codexWindowsInstaller({ assets, endpoint, certPin, token }),
      extension: 'ps1',
    },
  ];
  const installerPanels = installers.map(({ platform, label, script, extension }) => {
    const filename = `install-codex-${platform}.${extension}`;
    const targetId = `codex-installer-${platform}`;
    const runCommand = platform === 'windows'
      ? `$installer = "$HOME\\Downloads\\${filename}"; powershell -ExecutionPolicy Bypass -File $installer; if ($LASTEXITCODE -eq 0) { Remove-Item -Force $installer }`
      : `chmod 600 "$HOME/Downloads/${filename}" && bash "$HOME/Downloads/${filename}" && rm "$HOME/Downloads/${filename}"`;
    return `<section class="installer-panel">
      <h2>${escapeHtml(label)}</h2>
      <div class="setup-actions">
        <button type="button" data-download-target="${targetId}" data-download-name="${escapeHtml(filename)}" data-i18n="download-installer">Download installer</button>
        <button type="button" class="secondary" data-copy-target="${targetId}" data-i18n="copy-installer">Copy installer</button>
      </div>
      <details>
        <summary data-i18n="view-script">View script</summary>
        <pre id="${targetId}">${escapeHtml(script)}</pre>
      </details>
      <h3 data-i18n="run-instructions">How to run it</h3>
      <div class="run-command">${escapeHtml(runCommand)}</div>
    </section>`;
  }).join('');

  return layout('Codex device ready', `
    <section class="card stack">
      <div class="notice success">Codex device <strong>${escapeHtml(deviceName)}</strong> is enrolled.</div>
      <h1 data-i18n="choose-codex-platform">Choose this device's operating system</h1>
      <p class="muted" data-i18n="one-time-token">This self-contained script has a token scoped to this device and is displayed once. It does not need the private console when it runs. Keep it readable only by you and delete it after installation succeeds.</p>
      <div class="notice" data-i18n="one-platform-only">Use exactly one installer on the device you just enrolled. Do not reuse these scripts on another machine.</div>
      <div class="installer-list">${installerPanels}</div>
      <div class="notice"><span data-i18n="do-not-codex-login">Do not run codex login after installation. The agent writes the subscription credential and refreshes it automatically.</span></div>
      <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
    </section>
  `);
}

export function deviceConfiguredView({ account, device, token, claudeGatewayUrl }) {
  const gateway = claudeGatewayUrl.replace(/\/$/, '');
  const profile = account.alias.replace(/[^A-Za-z0-9._-]/g, '-');
  const unix = `#!/usr/bin/env bash
set -euo pipefail

CONFIG_ROOT="$HOME/.config/claude-codex-gateway"
TOKEN_FILE="$CONFIG_ROOT/claude-${profile}.token"
HELPER_FILE="$CONFIG_ROOT/claude-${profile}-api-key-helper"
DEFAULT_HELPER="$CONFIG_ROOT/claude-gateway-api-key-helper"
SETTINGS_FILE="$CONFIG_ROOT/claude-${profile}.settings.json"
PROFILE_FILE="$CONFIG_ROOT/claude-${profile}.env"
LAUNCHER_FILE="$HOME/.local/bin/claude-${profile}"
DEFAULT_LAUNCHER="$HOME/.local/bin/claude-gateway"

install -d -m 700 "$CONFIG_ROOT" "$HOME/.local/bin"
umask 077
printf '%s' ${shellSingleQuote(token)} > "$TOKEN_FILE"
cat > "$HELPER_FILE" <<'HELPER'
#!/usr/bin/env sh
set -eu
exec cat "$HOME/.config/claude-codex-gateway/claude-${profile}.token"
HELPER
chmod 700 "$HELPER_FILE"
ln -sfn "$HELPER_FILE" "$DEFAULT_HELPER"
printf '{}\n' > "$SETTINGS_FILE"
cat > "$PROFILE_FILE" <<'PROFILE'
export ANTHROPIC_BASE_URL=${shellSingleQuote(gateway)}
export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-5'
export CLAUDE_CODE_API_KEY_HELPER_TTL_MS=300000
export CLAUDE_CODE_USE_GATEWAY=1
export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
PROFILE
cat > "$LAUNCHER_FILE" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
. "$HOME/.config/claude-codex-gateway/claude-${profile}.env"
export ANTHROPIC_AUTH_TOKEN="$(cat "$HOME/.config/claude-codex-gateway/claude-${profile}.token")"
exec claude --settings "$HOME/.config/claude-codex-gateway/claude-${profile}.settings.json" "$@"
LAUNCHER
chmod 600 "$TOKEN_FILE" "$SETTINGS_FILE" "$PROFILE_FILE"
chmod 700 "$LAUNCHER_FILE"
ln -sfn "$LAUNCHER_FILE" "$DEFAULT_LAUNCHER"
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
exec "$DEFAULT_LAUNCHER"`;
  const windows = `$dir = Join-Path $HOME '.config\\claude-codex-gateway'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tokenFile = Join-Path $dir 'claude-${profile}.token'
$helper = Join-Path $dir 'claude-${profile}-api-key-helper.ps1'
$defaultHelper = Join-Path $dir 'claude-gateway-api-key-helper.ps1'
$settings = Join-Path $dir 'claude-${profile}.settings.json'
$wrapper = Join-Path $dir 'claude-${profile}.ps1'
$defaultWrapper = Join-Path $dir 'claude-gateway.ps1'
[IO.File]::WriteAllText($tokenFile, ${powerShellSingleQuote(token)}, [Text.UTF8Encoding]::new($false))
@'
[Console]::Out.Write([IO.File]::ReadAllText((Join-Path $HOME '.config\\claude-codex-gateway\\claude-${profile}.token')))
'@ | Set-Content -Encoding UTF8 $helper
Copy-Item -Force $helper $defaultHelper
@{} | ConvertTo-Json | Set-Content -Encoding UTF8 $settings
@'
$tokenFile = [IO.Path]::Combine($HOME, '.config', 'claude-codex-gateway', 'claude-${profile}.token')
$env:ANTHROPIC_BASE_URL=${powerShellSingleQuote(gateway)}
$env:ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-5'
$env:CLAUDE_CODE_USE_GATEWAY='1'
$env:CLAUDE_CODE_SUBPROCESS_ENV_SCRUB='1'
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
$env:ANTHROPIC_AUTH_TOKEN = [IO.File]::ReadAllText($tokenFile)
$settings = Join-Path $HOME '.config\\claude-codex-gateway\\claude-${profile}.settings.json'
& claude --settings $settings @args
exit $LASTEXITCODE
'@ | Set-Content -Encoding UTF8 $wrapper
Copy-Item -Force $wrapper $defaultWrapper
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
& $defaultWrapper`;

  return layout('Device ready', `
    <section class="card stack">
      <div class="notice success">Device <strong>${escapeHtml(device.name)}</strong> is enrolled for <strong>${escapeHtml(account.alias)}</strong>.</div>
      <h1 data-i18n="claude-copy-now">Copy or download this configuration now</h1>
      <p class="muted" data-i18n="claude-one-time-token">This device token is displayed once and cannot be recovered from the control plane. The launcher injects it only into Claude Code's explicit gateway mode, which scrubs it from child-process environments, so no local sandbox package is required. Re-enroll if it is lost, and delete the downloaded installer after use.</p>
      <h2>macOS / Linux</h2>
      <pre id="unix-config">${escapeHtml(unix)}</pre>
      <div class="setup-actions">
        <button type="button" data-download-target="unix-config" data-download-name="install-claude-${escapeHtml(profile)}-macos-linux.sh" data-i18n="download-unix-setup">Download macOS/Linux setup</button>
        <button type="button" class="secondary" data-copy-target="unix-config" data-i18n="copy-unix-setup">Copy macOS/Linux setup</button>
      </div>
      <h3 data-i18n="run-instructions">How to run it</h3>
      <div class="run-command">${escapeHtml(`chmod 600 "$HOME/Downloads/install-claude-${profile}-macos-linux.sh" && bash "$HOME/Downloads/install-claude-${profile}-macos-linux.sh" && rm "$HOME/Downloads/install-claude-${profile}-macos-linux.sh"`)}</div>
      <h2>Windows PowerShell</h2>
      <pre id="windows-config">${escapeHtml(windows)}</pre>
      <div class="setup-actions">
        <button type="button" data-download-target="windows-config" data-download-name="install-claude-${escapeHtml(profile)}-windows.ps1" data-i18n="download-windows-setup">Download PowerShell setup</button>
        <button type="button" class="secondary" data-copy-target="windows-config" data-i18n="copy-windows-setup">Copy PowerShell setup</button>
      </div>
      <h3 data-i18n="run-instructions">How to run it</h3>
      <div class="run-command">${escapeHtml(`$installer = "$HOME\\Downloads\\install-claude-${profile}-windows.ps1"; powershell -ExecutionPolicy Bypass -File $installer; if ($LASTEXITCODE -eq 0) { Remove-Item -Force $installer }`)}</div>
      <div class="notice" data-i18n="closing-hides-token">Closing or refreshing this page permanently hides the credential.</div>
      <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
    </section>
  `);
}

export function messageView(title, message, { error = false } = {}) {
  return layout(title, `
    <section class="login">
      <div class="card stack">
        <div class="notice ${error ? 'error' : 'success'}">${escapeHtml(message)}</div>
        <a class="button secondary" href="/">Continue</a>
      </div>
    </section>
  `);
}
