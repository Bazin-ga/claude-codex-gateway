import { escapeHtml } from './http.js';
import { classifyCredentialAlerts } from './credential-alerts.js';
import {
  CLAUDE_CLIENT_CONFIG_VERSION_KEY,
  CLIENT_CONFIG_VERSION,
  CODEX_UNIX_CLIENT_CONFIG_VERSION_FILE,
  CODEX_WINDOWS_CLIENT_CONFIG_VERSION_FILE,
} from './client-config-version.js';

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
/* A revoked credential is an ordinary end of life, not a fault, so it is
   deliberately not given the red of an unhealthy account. */
.badge.credential-active { background: #dff2e8; color: var(--green); }
.badge.credential-revoked { background: #e8eee9; color: var(--muted); }
.badge.legacy { background: #faecd7; color: var(--amber); }
.badge.alert-critical { background: #f8e4e1; color: var(--red); }
.badge.alert-warning { background: #faecd7; color: var(--amber); }
.badge.alert-neutral { background: #e5edf4; color: var(--blue); }
.badge.alert-ok { background: #dff2e8; color: var(--green); }
.badge > span { margin-left: 4px; }
.credential-alert-summary { border-top: 5px solid var(--green); }
.credential-alert-summary.has-critical { border-top-color: var(--red); }
.credential-alert-summary.has-warning { border-top-color: var(--amber); }
.credential-alert-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.credential-alert-heading h2 { margin-bottom: 5px; }
.credential-alert-counts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.credential-alert-list { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 8px; }
.credential-alert-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; border: 1px solid var(--line); border-radius: 12px; padding: 11px 13px; background: #fbfcf9; }
.credential-alert-item > div { min-width: 0; }
.credential-alert-item strong { overflow-wrap: anywhere; }
.credential-alert-label { margin-top: 3px; color: var(--muted); font-size: 13px; }
.credential-alert-more { margin: 10px 0 0; }
.account-status-stack { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.account-history { display: grid; gap: 3px; min-width: 170px; }
.account-history > div { line-height: 1.4; }
.relative-expiry { white-space: nowrap; }
.relative-expiry strong { font-weight: 750; }
.relative-expiry.expired strong { color: var(--red); }
.credential-table-wrap { overflow-x: auto; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.machine-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.machine { min-width: 0; border: 1px solid var(--line); border-radius: 14px; padding: 16px; background: #fbfcf9; }
.machine-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 12px; }
.machine-head > *, .machine-tags { min-width: 0; }
.machine-title { font-size: 15px; font-weight: 750; word-break: break-all; }
.machine-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.machine details, .machine-group { margin-top: 18px; }
.machine summary, .machine-group > summary { cursor: pointer; color: var(--green); font-weight: 750; font-size: 13px; }
.machine-group > summary { font-size: 14px; }
.machine-group > h3 { margin: 0 0 4px; font-size: 15px; }
.machine-group > p { margin: 0 0 12px; }
.machine-group[open] > summary { margin-bottom: 12px; }
.merge-form { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--line); }
.merge-form label { margin-bottom: 0; }
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
.stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.stack > .card { grid-column: auto; min-width: 0; }
.notice { border-left: 4px solid var(--amber); background: #fff7e9; padding: 12px 14px; border-radius: 0 10px 10px 0; }
.success { border-left-color: var(--green); background: #eaf6ef; }
.error { border-left-color: var(--red); background: #faebe9; }
.open-banner { margin-bottom: 22px; font-weight: 700; }
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
.member-form.with-label { grid-template-columns: 1fr 1fr 1fr auto; }
.member-form.codex-form.with-label { grid-template-columns: 1fr 1fr auto; }
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
.metrics-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.metrics-filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: end; }
.metrics-filter-heading { grid-column: 1 / -1; margin: 0; }
.metrics-filters label { margin-bottom: 0; }
.metrics-filters .filter-actions { display: flex; gap: 8px; align-items: center; }
.metrics-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.metrics-summary .summary { grid-column: auto; }
.metrics-token-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metrics-token-summary .summary { grid-column: auto; }
.metrics-token-summary .summary strong { word-break: break-word; }
.metrics-token-known { display: block; margin-top: 6px; color: var(--muted); font-size: 12px; }
.metrics-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.metrics-chart { min-width: 0; border: 1px solid var(--line); border-radius: 14px; padding: 14px; background: #fbfcf9; }
.metrics-chart-wide { grid-column: 1 / -1; }
.metrics-chart h3 { margin: 0 0 10px; font-size: 16px; }
.metrics-chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.metrics-chart .metrics-grid-line { stroke: var(--line); stroke-width: 1; }
.metrics-chart .metrics-axis { fill: var(--muted); font-size: 11px; }
.metrics-chart .metrics-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.metrics-chart .metrics-line.total, .metrics-chart .metrics-swatch.total { stroke: var(--green); background: var(--green); }
.metrics-chart .metrics-line.success, .metrics-chart .metrics-swatch.success { stroke: var(--blue); background: var(--blue); }
.metrics-chart .metrics-line.error, .metrics-chart .metrics-swatch.error { stroke: var(--red); background: var(--red); }
.metrics-chart .metrics-line.ttfb, .metrics-chart .metrics-swatch.ttfb { stroke: var(--amber); background: var(--amber); }
.metrics-chart .metrics-line.duration, .metrics-chart .metrics-swatch.duration { stroke: var(--ink); background: var(--ink); }
.metrics-chart .metrics-line.input, .metrics-chart .metrics-swatch.input { stroke: var(--blue); background: var(--blue); }
.metrics-chart .metrics-line.cache-create, .metrics-chart .metrics-swatch.cache-create { stroke: var(--amber); background: var(--amber); }
.metrics-chart .metrics-line.cache-read, .metrics-chart .metrics-swatch.cache-read { stroke: var(--green); background: var(--green); }
.metrics-chart .metrics-line.output, .metrics-chart .metrics-swatch.output { stroke: var(--red); background: var(--red); }
.metrics-chart .metrics-line.device-0, .metrics-chart .metrics-swatch.device-0 { stroke: var(--green); background: var(--green); }
.metrics-chart .metrics-line.device-1, .metrics-chart .metrics-swatch.device-1 { stroke: var(--blue); background: var(--blue); }
.metrics-chart .metrics-line.device-2, .metrics-chart .metrics-swatch.device-2 { stroke: var(--amber); background: var(--amber); }
.metrics-chart .metrics-line.device-3, .metrics-chart .metrics-swatch.device-3 { stroke: var(--red); background: var(--red); }
.metrics-chart .metrics-line.device-4, .metrics-chart .metrics-swatch.device-4 { stroke: var(--ink); background: var(--ink); }
.metrics-chart .metrics-line.device-5, .metrics-chart .metrics-swatch.device-5 { stroke: #7b4ea3; background: #7b4ea3; }
.metrics-chart .metrics-line.device-6, .metrics-chart .metrics-swatch.device-6 { stroke: #008b8b; background: #008b8b; }
.metrics-chart .metrics-line.device-7, .metrics-chart .metrics-swatch.device-7 { stroke: #c26d2d; background: #c26d2d; }
.metrics-chart .metrics-point.total { fill: var(--green); }
.metrics-chart .metrics-point.success { fill: var(--blue); }
.metrics-chart .metrics-point.error { fill: var(--red); }
.metrics-chart .metrics-point.ttfb { fill: var(--amber); }
.metrics-chart .metrics-point.duration { fill: var(--ink); }
.metrics-chart .metrics-point.input { fill: var(--blue); }
.metrics-chart .metrics-point.cache-create { fill: var(--amber); }
.metrics-chart .metrics-point.cache-read { fill: var(--green); }
.metrics-chart .metrics-point.output { fill: var(--red); }
.metrics-chart .metrics-point.device-0 { fill: var(--green); }
.metrics-chart .metrics-point.device-1 { fill: var(--blue); }
.metrics-chart .metrics-point.device-2 { fill: var(--amber); }
.metrics-chart .metrics-point.device-3 { fill: var(--red); }
.metrics-chart .metrics-point.device-4 { fill: var(--ink); }
.metrics-chart .metrics-point.device-5 { fill: #7b4ea3; }
.metrics-chart .metrics-point.device-6 { fill: #008b8b; }
.metrics-chart .metrics-point.device-7 { fill: #c26d2d; }
.metrics-chart .metrics-swatch.device-0, .metrics-chart .metrics-swatch.device-1,
.metrics-chart .metrics-swatch.device-2, .metrics-chart .metrics-swatch.device-3,
.metrics-chart .metrics-swatch.device-4, .metrics-chart .metrics-swatch.device-5,
.metrics-chart .metrics-swatch.device-6, .metrics-chart .metrics-swatch.device-7 {
  height: 0; border-radius: 0; background: transparent; border-top-width: 3px; border-top-style: solid;
}
.metrics-chart .metrics-swatch.device-1 { border-top-style: dashed; }
.metrics-chart .metrics-swatch.device-2 { border-top-style: dotted; }
.metrics-chart .metrics-swatch.device-3 { border-top-style: double; }
.metrics-chart .metrics-swatch.device-4 { border-top-style: dashed; }
.metrics-chart .metrics-swatch.device-5 { border-top-style: dotted; }
.metrics-chart .metrics-swatch.device-6 { border-top-style: dashed; }
.metrics-chart .metrics-swatch.device-7 { border-top-style: double; }
.metrics-chart .metrics-swatch.device-0 { border-top-color: var(--green); }
.metrics-chart .metrics-swatch.device-1 { border-top-color: var(--blue); }
.metrics-chart .metrics-swatch.device-2 { border-top-color: var(--amber); }
.metrics-chart .metrics-swatch.device-3 { border-top-color: var(--red); }
.metrics-chart .metrics-swatch.device-4 { border-top-color: var(--ink); }
.metrics-chart .metrics-swatch.device-5 { border-top-color: #7b4ea3; }
.metrics-chart .metrics-swatch.device-6 { border-top-color: #008b8b; }
.metrics-chart .metrics-swatch.device-7 { border-top-color: #c26d2d; }
.metrics-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; color: var(--muted); font-size: 12px; }
.metrics-legend-item { display: inline-flex; gap: 6px; align-items: center; }
.metrics-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.metrics-empty { color: var(--muted); padding: 10px 0 0; }
.metrics-table th, .metrics-table td { font-size: 12px; padding: 9px 8px; }
.metrics-table-wrap { overflow-x: auto; }
.metrics-attribution-notice { margin: 0; }
.metrics-attribution-notice p { margin: 0; }
.account-switch-form { min-width: 190px; }
.account-selection-details { display: grid; gap: 3px; margin-top: 5px; }
.page-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: -8px 0 24px; padding: 6px; border: 1px solid var(--line); border-radius: 12px; background: white; }
.page-tabs a { padding: 8px 12px; border-radius: 8px; color: var(--muted); font-size: 13px; font-weight: 750; text-decoration: none; }
.page-tabs a:hover, .page-tabs a[aria-current="page"] { background: var(--ink); color: white; }
.page-tabs a:focus-visible { outline: 3px solid var(--amber); outline-offset: 2px; }
.metrics-comparison { min-width: 0; }
.metrics-comparison svg { width: 100%; height: auto; display: block; }
.metrics-comparison-table-wrap { overflow-x: auto; }
.metrics-comparison-table th, .metrics-comparison-table td { font-size: 12px; padding: 9px 8px; }
.metrics-comparison-unknown { color: var(--amber); }
.metrics-comparison-note { margin: 0 0 10px; }
.metrics-comparison h3 { margin: 12px 0 8px; font-size: 15px; }
.conversation-disclosure { margin: 0; }
.conversation-disclosure h2 { margin-bottom: 8px; }
.conversation-disclosure p { margin: 6px 0 0; }
.conversation-list { display: grid; gap: 14px; }
.conversation-card { border: 1px solid var(--line); border-radius: 14px; padding: 16px; background: #fbfcf9; }
.conversation-card h2 { margin: 0; font-size: 17px; }
.conversation-card-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.conversation-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; color: var(--muted); font-size: 12px; }
.conversation-snippets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.conversation-snippet { min-width: 0; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: white; }
.conversation-snippet strong { display: block; margin-bottom: 6px; font-size: 12px; color: var(--muted); }
.conversation-snippet pre, .conversation-text pre { margin: 0; max-height: 260px; font-size: 12px; }
.conversation-text pre { max-height: none; }
.conversation-pagination { display: flex; justify-content: flex-end; gap: 10px; align-items: center; }
.conversation-filters { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 12px; align-items: end; }
.conversation-filters label { margin: 0; }
.conversation-state { white-space: nowrap; }
.conversation-queue-dropped { margin: 0; }
@media (max-width: 800px) {
  .summary, .split { grid-column: span 12; }
  .topbar { align-items: flex-start; flex-wrap: wrap; }
  button, .button, input, select { min-height: 44px; }
  .page-tabs a, .language-switch button { min-height: 44px; display: inline-flex; align-items: center; }
  .table-wrap { overflow-x: auto; }
  .zone-heading { display: grid; }
  .identity-chip { white-space: normal; }
  .provider-grid, .member-form, .member-form.codex-form,
  .member-form.with-label, .member-form.codex-form.with-label,
  .merge-form, .metrics-filters, .metrics-chart-grid, .metrics-token-summary,
  .conversation-snippets, .conversation-filters { grid-template-columns: 1fr; }
  .metrics-chart-wide { grid-column: auto; }
}
`;

// Open mode has no login at all. Say so on every page instead of letting the console
// look like something is guarding it.
const openBanner = '<div class="notice error open-banner" role="status" data-i18n="open-banner">No authentication: anyone who can reach this console can issue and revoke credentials.</div>';

function layout(title, content, { openMode = false, activeTab = null } = {}) {
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
      </div>
    </header>
    ${activeTab ? `<nav class="page-tabs" aria-label="Primary navigation">
      <a href="/" data-i18n="tab-overview"${activeTab === 'overview' ? ' aria-current="page"' : ''}>Overview</a>
      <a href="/metrics" data-i18n="tab-metrics"${activeTab === 'metrics' ? ' aria-current="page"' : ''}>Usage &amp; metrics</a>
      <a href="/conversations" data-i18n="tab-conversations"${activeTab === 'conversations' ? ' aria-current="page"' : ''}>Conversations</a>
    </nav>` : ''}
    ${openMode ? openBanner : ''}
    ${content}
  </main>
</body>
</html>`;
}

function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}" data-i18n="status-${escapeHtml(status.replaceAll('_', '-'))}">${escapeHtml(status.replaceAll('_', ' '))}</span>`;
}

function dateText(value) {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('en-GB', { hour12: false }) : value;
}

function compactDuration(milliseconds) {
  const totalMinutes = Math.max(1, Math.round(Math.abs(milliseconds) / 60_000));
  if (totalMinutes >= 24 * 60) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${totalMinutes}m`;
}

const CREDENTIAL_ALERT_LABEL_KEYS = Object.freeze({
  current_invalid: 'credential-alert-current-invalid',
  current_unavailable: 'credential-alert-current-unavailable',
  access_expired: 'credential-alert-access-expired',
  access_expires_24h: 'credential-alert-access-expires-24h',
  access_expires_3d: 'credential-alert-access-expires-3d',
  access_expires_7d: 'credential-alert-access-expires-7d',
  credential_unavailable: 'credential-alert-credential-unavailable',
  health_missing: 'credential-alert-health-missing',
  health_invalid: 'credential-alert-health-invalid',
  health_unavailable: 'credential-alert-health-unavailable',
  health_stale: 'credential-alert-health-stale',
  refresh_failed: 'credential-alert-refresh-failed',
  refresh_quarantined: 'credential-alert-refresh-quarantined',
  refresh_stuck: 'credential-alert-refresh-stuck',
  refreshing: 'credential-alert-refreshing',
  persist: 'credential-alert-persist',
  persist_failed: 'credential-alert-persist-failed',
  publish: 'credential-alert-publish',
  publish_failed: 'credential-alert-publish-failed',
  read_failed: 'credential-alert-read-failed',
  unreadable: 'credential-alert-unreadable',
  unhandled: 'credential-alert-unhandled',
  operation_blocked: 'credential-alert-operation-blocked',
  configuration_invalid: 'credential-alert-configuration-invalid',
  quarantine: 'credential-alert-quarantine',
  provider_rejected: 'credential-alert-provider-rejected',
  timeout: 'credential-alert-timeout',
  pre_mint_rejected: 'credential-alert-pre-mint-rejected',
  account_unhealthy: 'credential-alert-account-unhealthy',
  login_required: 'credential-alert-login-required',
  pending: 'credential-alert-pending',
});

function credentialAlertLabelKey(code) {
  return CREDENTIAL_ALERT_LABEL_KEYS[code] ?? 'credential-alert-refresh-failed';
}

function credentialAlertBadge(alert) {
  const severity = ['critical', 'warning', 'neutral', 'ok'].includes(alert?.severity)
    ? alert.severity
    : 'neutral';
  return `<span class="badge alert-${severity}" data-i18n="credential-severity-${severity}">${escapeHtml(severity[0].toUpperCase() + severity.slice(1))}</span>`;
}

function expiryView(alert) {
  if (!alert || alert.expiresInMs === null || alert.expiresInMs === undefined) {
    return '<span class="muted" data-i18n="expires-unknown">Not available</span>';
  }
  const expired = alert.expiresInMs <= 0;
  const duration = compactDuration(alert.expiresInMs);
  return `<div class="relative-expiry${expired ? ' expired' : ''}">
    <span data-i18n="${expired ? 'expires-ago' : 'expires-in'}">${expired ? 'Expired' : 'Expires in'}</span>
    <strong>${escapeHtml(duration)}</strong>
  </div><div class="muted tiny">${escapeHtml(dateText(alert.expiresAt))}</div>`;
}

function credentialCheckText(value, i18nKey) {
  return `<div><span data-i18n="${i18nKey}">${i18nKey === 'last-successful-check' ? 'Last successful credential check' : 'Last rotation'}</span>: <span>${escapeHtml(value ? dateText(value) : '—')}</span></div>`;
}

function credentialAlertSummaryView(accounts, alerts) {
  if (!accounts.length || (!alerts?.criticalCount && !alerts?.warningCount)) return '';
  const summary = alerts?.summary ?? [];
  const stateClass = alerts?.criticalCount ? ' has-critical' : alerts?.warningCount ? ' has-warning' : '';
  const liveRole = alerts?.criticalCount ? 'alert' : 'status';
  const liveMode = alerts?.criticalCount ? 'assertive' : 'polite';
  const items = summary.map((alert) => {
    const provider = alert.provider === 'codex' ? 'Codex' : 'Claude Code';
    return `<li class="credential-alert-item">
      <div><strong>${escapeHtml(alert.alias || provider)}</strong><div class="muted tiny">${escapeHtml(provider)}</div>
        <div class="credential-alert-label" data-i18n="${credentialAlertLabelKey(alert.code)}">Credential status needs attention.</div>
      </div>${credentialAlertBadge(alert)}
    </li>`;
  }).join('');
  let body;
  if (items) {
    body = `<ul class="credential-alert-list">${items}</ul>${alerts.summaryTruncated
      ? '<p class="muted tiny credential-alert-more" data-i18n="credential-alert-more">More credential alerts are listed in the account table.</p>'
      : ''}`;
  }
  return `<section class="card credential-alert-summary${stateClass}" role="${liveRole}" aria-live="${liveMode}" aria-labelledby="credential-alert-heading">
    <div class="credential-alert-heading"><div><h2 id="credential-alert-heading" data-i18n="credential-health-heading">Credential health</h2>
      <p class="muted tiny" data-i18n="credential-health-intro">Live credential status from safe public metadata.</p></div>
      <div class="credential-alert-counts" aria-label="Credential alert counts">
        ${alerts.criticalCount ? `<span class="badge alert-critical"><strong>${alerts.criticalCount}</strong> <span data-i18n="credential-critical-label">critical</span></span>` : ''}
        ${alerts.warningCount ? `<span class="badge alert-warning"><strong>${alerts.warningCount}</strong> <span data-i18n="credential-warning-label">warning</span></span>` : ''}
      </div>
    </div>${body}
  </section>`;
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

/**
 * Only a reading the provider refuses to give is an error. A row that has simply
 * never been authorized is the expected state of an account someone just added,
 * and rendering that in red reads as a fault the operator has to chase.
 */
const QUOTA_MESSAGES = {
  reauthorization_required: '<div class="quota-message" data-i18n="usage-reauthorize">Reauthorize this Claude account once to enable quota reporting.</div>',
  authorization_required: '<div class="quota-message" data-i18n="usage-authorize-first">Authorize this account to enable quota reporting.</div>',
  stale: '<div class="quota-message" data-i18n="usage-stale">Showing the last successful reading; the latest refresh failed.</div>',
  unavailable: '<div class="quota-message error" data-i18n="usage-unavailable">Usage is temporarily unavailable.</div>',
  pending: '<div class="quota-message" data-i18n="usage-loading">Waiting for the first hourly usage refresh.</div>',
};

function accountUsageView(account, { showAccount = false } = {}) {
  const usage = account.usage;
  const message = QUOTA_MESSAGES[usage ? usage.status : 'pending'] ?? '';
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

/**
 * A credential's own state, kept in a vocabulary of its own.
 *
 * Not `healthy`/`expired`: those are account words, and reusing them made a
 * revoked credential on a working account read as an account in trouble. A
 * revocation is a thing somebody did on purpose.
 */
function credentialBadge(state) {
  return `<span class="badge credential-${state}" data-i18n="credential-${state}">${state === 'revoked' ? 'Revoked' : 'Active'}</span>`;
}

/**
 * The account a credential belongs to, with the account's OWN status.
 *
 * The two facts live in two columns from here on. A healthy account holding a
 * revoked credential is the normal end state of a retired laptop, and the list
 * has to be able to say that without looking like an outage.
 */
function accountCell(account) {
  if (!account) {
    return '<td data-account-status="unknown"><span class="muted" data-i18n="unknown-account">Unknown account</span></td>';
  }
  return `<td data-account-status="${escapeHtml(account.status)}"><strong>${escapeHtml(account.alias)}</strong><div class="tiny">${statusBadge(account.status)}</div></td>`;
}

function accountForId(accounts, id) {
  return accounts.find((account) => account.id === id) ?? null;
}

/**
 * Resolve the additive account-selection fields without silently repairing them.
 *
 * A pre-P3 row is legacy only when BOTH fields are absent. Once either field is
 * present, an invalid shape or unknown account is surfaced to the operator rather
 * than guessing that the old account is still selected. The proxy owns runtime
 * fallback; the dashboard must make a malformed configuration visible.
 */
function accountSelectionForDevice(device, accounts) {
  const originalAccountId = typeof device.account_id === 'string' ? device.account_id : null;
  const hasAllowed = Object.hasOwn(device, 'allowed_account_ids');
  const hasSelected = Object.hasOwn(device, 'selected_account_id');
  const originalAccount = accountForId(accounts, originalAccountId);
  if (!hasAllowed && !hasSelected) {
    return {
      allowedAccountIds: originalAccountId ? [originalAccountId] : [],
      invalid: !originalAccount || !originalAccountId,
      legacy: true,
      originalAccount,
      originalAccountId,
      selectedAccount: originalAccount,
      selectedAccountId: originalAccountId,
    };
  }

  const allowedAccountIds = Array.isArray(device.allowed_account_ids)
    ? device.allowed_account_ids
    : null;
  const selectedAccountId = typeof device.selected_account_id === 'string'
    ? device.selected_account_id
    : null;
  const claudeAccounts = new Set(
    accounts.filter((account) => account.provider === 'claude').map((account) => account.id),
  );
  const allowedValid = Array.isArray(allowedAccountIds)
    && allowedAccountIds.length > 0
    && allowedAccountIds.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(allowedAccountIds).size === allowedAccountIds.length
    && allowedAccountIds.every((id) => claudeAccounts.has(id))
    && originalAccountId !== null
    && allowedAccountIds.includes(originalAccountId);
  const selectedValid = selectedAccountId !== null
    && allowedValid
    && allowedAccountIds.includes(selectedAccountId)
    && claudeAccounts.has(selectedAccountId);
  const originalValid = originalAccountId !== null && claudeAccounts.has(originalAccountId);
  const invalid = !allowedValid || !selectedValid || !originalValid;
  return {
    allowedAccountIds: Array.isArray(allowedAccountIds) ? allowedAccountIds : [],
    invalid,
    legacy: false,
    originalAccount,
    originalAccountId,
    selectedAccount: selectedValid ? accountForId(accounts, selectedAccountId) : null,
    selectedAccountId: selectedValid ? selectedAccountId : null,
  };
}

function accountDisplayLabel(account, fallback = 'Unknown account') {
  if (!account) return fallback;
  return `${account.alias} · ${String(account.status).replaceAll('_', ' ')}`;
}

function accountLabelView(account, fallback = 'Unknown account') {
  if (!account) return escapeHtml(fallback);
  return `<span data-account-label data-account-alias="${escapeHtml(account.alias)}" data-account-status="${escapeHtml(account.status)}">${escapeHtml(accountDisplayLabel(account))}</span>`;
}

function accountSelectionOptions(accounts, selectedAccountId) {
  return accounts
    .filter((account) => account.provider === 'claude')
    // Keep the account selector distinct from the legacy machine-merge option
    // vocabulary, whose existing dashboard tests intentionally count the
    // double-quoted machine values. Both quote styles are valid HTML; the value
    // remains escaped before it enters the attribute.
    .map((account) => `<option value='${escapeHtml(account.id)}' data-account-option data-account-alias="${escapeHtml(account.alias)}" data-account-status="${escapeHtml(account.status)}"${account.id === selectedAccountId ? ' selected' : ''}>${escapeHtml(accountDisplayLabel(account))}</option>`)
    .join('');
}

function accountSelectionDetails(selection, accounts) {
  const original = accountLabelView(selection.originalAccount, selection.originalAccountId ?? '—');
  const allowed = selection.allowedAccountIds.length
    ? selection.allowedAccountIds.map((id) => accountLabelView(accountForId(accounts, id), id)).join(', ')
    : '—';
  return `<div class="account-selection-details tiny">
    <div><span data-i18n="original-account">Original account</span>: ${original}</div>
    <div><span data-i18n="allowed-accounts">Allowed accounts</span>: ${allowed}</div>
  </div>`;
}

function accountSwitchControl(device, selection, accounts, csrf) {
  if (device.revoked_at) return '';
  if (selection.invalid) {
    return '<div class="notice error tiny" data-i18n="account-selection-invalid">Account selection configuration is invalid; no account was guessed.</div>';
  }
  const options = accountSelectionOptions(accounts, selection.selectedAccountId);
  if (!options) {
    return '<div class="muted tiny" data-i18n="no-claude-accounts">No Claude accounts are registered.</div>';
  }
  return `<form method="post" action="/devices/${encodeURIComponent(device.id)}/account" class="stack account-switch-form">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <label><span data-i18n="selected-account">Selected account</span>
      <select name="selected_account_id" required>${options}</select>
    </label>
    <button type="submit" data-i18n="switch-account">Switch account</button>
  </form>`;
}

function claudeCredentialRow(device, accounts, csrf) {
  const state = device.revoked_at ? 'revoked' : 'active';
  const selection = accountSelectionForDevice(device, accounts);
  const selectedAccount = selection.invalid ? null : selection.selectedAccount;
  return `<tr data-credential-state="${state}">
    <td data-device-id="${escapeHtml(device.id)}"><strong>${escapeHtml(device.name)}</strong><div class="muted tiny">${escapeHtml(device.member_label || '—')}</div></td>
    <td>Claude Code</td>
    ${accountCell(selectedAccount)}
    <td>${credentialBadge(state)}</td>
    <td>${escapeHtml(dateText(device.last_seen_at))}</td>
    <td><div class="stack">
      ${accountSelectionDetails(selection, accounts)}
      ${accountSwitchControl(device, selection, accounts, csrf)}
      ${device.revoked_at
      ? `<span class="muted tiny">${escapeHtml(dateText(device.revoked_at))}</span>`
      : `<form method="post" action="/devices/${encodeURIComponent(device.id)}/revoke">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button class="danger" type="submit" data-i18n="revoke">Revoke</button>
      </form>`}
    </div></td>
  </tr>`;
}

/**
 * A Codex machine's row, read out of the dispenser's registry.
 *
 * Nothing here is actionable from this console: a Codex machine pulls its
 * credential from the dispenser and never contacts this process, so the
 * dispenser is where it is revoked and where its last contact is recorded. The
 * console shows what it can see and does not pretend to more.
 */
function codexCredentialRow(client, account) {
  const state = client.revoked ? 'revoked' : 'active';
  return `<tr data-credential-state="${state}">
    <td><strong>${escapeHtml(client.name || '—')}</strong><div class="muted tiny"><span data-i18n="enrolled-at">Enrolled</span> ${escapeHtml(dateText(client.added_at))}</div></td>
    <td>Codex</td>
    ${accountCell(account)}
    <td>${credentialBadge(state)}</td>
    <td><span class="muted tiny" data-i18n="not-reported-here">Not reported to this console</span></td>
    <td>${client.revoked
      ? `<span class="muted tiny">${escapeHtml(dateText(client.revoked_at))}</span>${client.revoked_reason
        ? `<div class="muted tiny">${escapeHtml(client.revoked_reason)}</div>`
        : ''}`
      : '<span class="muted tiny" data-i18n="dispenser-managed">Managed by the dispenser</span>'}</td>
  </tr>`;
}

/**
 * The credential list read as a machine inventory: one row per machine, its
 * credentials nested underneath.
 *
 * A device row is one credential issuance, not a machine, and the two Claude and
 * Codex paths record issuances in two different places. What ties them together
 * is the handle the machine reports, so that is the key, and the two sources are
 * merged on it here — the store cannot do it, because the Codex side lives in
 * another process's file.
 *
 * What is deliberately NOT done: rows without a handle are never folded together
 * on a matching name or member label. Both are typed by a person, neither is
 * verified, and guessing would put two people's laptops in one row and call it
 * an inventory. Each such row is its own `legacy` entry instead — visibly
 * unattributed, and for the console's own rows, one click from being filed
 * properly.
 */
function machineInventory({ machines, codexClients }) {
  const entries = new Map();
  const entryFor = (key, machineId) => {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        machine_id: machineId ?? null,
        legacy: !machineId,
        devices: [],
        codex: [],
        active: 0,
        revoked: 0,
        names: [],
        member_labels: [],
      };
      entries.set(key, entry);
    }
    return entry;
  };
  const remember = (entry, field, value) => {
    if (value && !entry[field].includes(value)) entry[field].push(value);
  };

  for (const machine of machines) {
    const key = machine.machine_id
      ? `machine:${machine.machine_id}`
      : `issuance:${machine.devices[0]?.id ?? entries.size}`;
    const entry = entryFor(key, machine.machine_id);
    entry.devices.push(...machine.devices);
    entry.active += machine.active_devices;
    entry.revoked += machine.revoked_devices;
    for (const device of machine.devices) {
      remember(entry, 'names', device.name);
      remember(entry, 'member_labels', device.member_label);
    }
  }

  codexClients.forEach((client, index) => {
    const key = client.machine_id
      ? `machine:${client.machine_id}`
      : `codex:${client.account_id}:${index}`;
    const entry = entryFor(key, client.machine_id);
    entry.codex.push(client);
    if (client.revoked) entry.revoked += 1;
    else entry.active += 1;
    remember(entry, 'names', client.name);
  });

  return [...entries.values()].map((entry) => ({
    ...entry,
    // Only the console's own rows can be filed under a machine: `clients.json`
    // belongs to the dispenser and this process reads it, never writes it.
    mergeable: entry.legacy && entry.devices.length === 1 && entry.codex.length === 0,
  }));
}

function machineEntryView(entry, { accounts, csrf, machineOptions }) {
  const accountFor = (id) => accounts.find((account) => account.id === id) ?? null;
  const rows = [
    ...entry.devices.map((device) => ({
      revoked: Boolean(device.revoked_at),
      html: claudeCredentialRow(device, accounts, csrf),
    })),
    ...entry.codex.map((client) => ({
      revoked: client.revoked,
      html: codexCredentialRow(client, accountFor(client.account_id)),
    })),
  ];
  const activeRows = rows.filter((row) => !row.revoked).map((row) => row.html).join('');
  const revokedRows = rows.filter((row) => row.revoked).map((row) => row.html).join('');
  const revokedCount = rows.filter((row) => row.revoked).length;
  const head = `<thead><tr>
    <th data-i18n="credential">Credential</th>
    <th data-i18n="credential-type">Type</th>
    <th data-i18n="account">Account</th>
    <th data-i18n="credential-status">Credential status</th>
    <th data-i18n="last-seen">Last seen</th>
    <th data-i18n="action">Action</th>
  </tr></thead>`;
  const mergeControl = entry.mergeable
    ? (machineOptions
      ? `<form method="post" action="/devices/${encodeURIComponent(entry.devices[0].id)}/machine" class="merge-form">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <label><span data-i18n="merge-into-machine">File this credential under a machine</span>
            <select name="machine_id" required>${machineOptions}</select>
          </label>
          <div><button type="submit" class="secondary" data-i18n="merge-credential">Merge</button></div>
        </form>`
      : '<p class="muted tiny" data-i18n="no-merge-targets">No machine has reported a handle yet, so there is nothing to file this under.</p>')
    : '';
  // Two different histories produce a handle-less Codex row and the registry does
  // not record which one this is, so the note names both rather than asserting
  // the flattering one. Saying "it reports a handle at its next enrollment" was
  // false for every row the console minted itself: the generated installer ships
  // pull.js, never enroll.js, so such a machine never reaches /enroll at all and
  // would have waited forever for a resolution that cannot arrive.
  const codexLegacyNote = entry.legacy && !entry.mergeable
    ? '<p class="muted tiny" data-i18n="codex-legacy-note">This Codex credential carries no machine handle: it was either enrolled before handles existed, in which case the agent on that machine reports one at its next enrollment, or minted by this console on a machine\'s behalf, in which case it never will — the generated installer runs pull.js, not enroll.js. The console reads the dispenser\'s registry and cannot write a handle into it either way.</p>'
    : '';

  return `<article class="machine" data-machine-key="${escapeHtml(entry.key)}" data-machine-legacy="${entry.legacy}">
    <div class="machine-head">
      <div>
        <div class="machine-title">${entry.machine_id
          ? `<code>${escapeHtml(entry.machine_id)}</code>`
          : '<span data-i18n="unattributed-credential">Unattributed credential</span>'}</div>
        <div class="muted tiny">${escapeHtml(entry.names.join(', ') || '—')}</div>
        ${entry.member_labels.length ? `<div class="muted tiny">${escapeHtml(entry.member_labels.join(', '))}</div>` : ''}
      </div>
      <div class="machine-tags">
        ${entry.legacy ? '<span class="badge legacy" data-i18n="legacy-no-handle">No machine handle</span>' : ''}
        <span class="badge credential-active">${entry.active} <span data-i18n="count-active">active</span></span>
        ${entry.revoked ? `<span class="badge credential-revoked">${entry.revoked} <span data-i18n="count-revoked">revoked</span></span>` : ''}
      </div>
    </div>
    <div class="table-wrap"><table>${head}<tbody>${activeRows
      || '<tr><td colspan="6" class="empty" data-i18n="no-active-credentials">No active credential.</td></tr>'}</tbody></table></div>
    ${revokedCount ? `<details data-revoked-credentials="${revokedCount}">
      <summary><span data-i18n="revoked-credentials">Revoked credentials</span> (${revokedCount})</summary>
      <div class="table-wrap"><table>${head}<tbody>${revokedRows}</tbody></table></div>
    </details>` : ''}
    ${mergeControl}
    ${codexLegacyNote}
  </article>`;
}

const METRICS_HOUR_OPTIONS = Object.freeze([
  { value: 24, label: 'Last 24 hours', i18n: 'metrics-hours-24' },
  { value: 168, label: 'Last 7 days', i18n: 'metrics-hours-168' },
  { value: 720, label: 'Last 30 days', i18n: 'metrics-hours-720' },
]);
const UNATTRIBUTED_MACHINE_VALUE = '__unattributed__';

function finiteMetricNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function metricCount(value) {
  return Math.round(finiteMetricNumber(value, { max: 9_000_000_000_000_000 }));
}

function metricTokenNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(9_000_000_000_000_000, Math.round(numeric));
}

function metricTokenKnownCount(source, totalField) {
  const suffix = totalField.slice('total'.length);
  const lowerCamel = `${suffix.slice(0, 1).toLowerCase()}${suffix.slice(1)}`;
  for (const key of [`${totalField}KnownCount`, `${lowerCamel}KnownCount`]) {
    if (Object.hasOwn(source ?? {}, key)) return metricCount(source[key]);
  }
  return 0;
}

function metricTokenText(value) {
  return value === null ? '—' : metricDisplayNumber(value);
}

const TOKEN_METRIC_FIELDS = Object.freeze([
  'totalInputTokens',
  'totalCacheCreationInputTokens',
  'totalCacheReadInputTokens',
  'totalOutputTokens',
]);

const TOKEN_ROW_FIELDS = Object.freeze([
  ...TOKEN_METRIC_FIELDS,
  'totalInputTokensKnownCount',
  'totalCacheCreationInputTokensKnownCount',
  'totalCacheReadInputTokensKnownCount',
  'totalOutputTokensKnownCount',
  'usageUnavailableCount',
  'usagePartialCount',
  'usageCompleteCount',
  'tokenApplicable',
  'tokenTotalsOverflow',
]);

function emptyMetricRow(hourBucketMs) {
  return {
    hourBucketMs,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    totalRequestBytes: 0,
    totalResponseBytes: 0,
    avgTtfbMs: null,
    avgDurationMs: null,
    totalInputTokens: null,
    totalCacheCreationInputTokens: null,
    totalCacheReadInputTokens: null,
    totalOutputTokens: null,
    totalInputTokensKnownCount: 0,
    totalCacheCreationInputTokensKnownCount: 0,
    totalCacheReadInputTokensKnownCount: 0,
    totalOutputTokensKnownCount: 0,
    usageUnavailableCount: 0,
    usagePartialCount: 0,
    usageCompleteCount: 0,
    tokenApplicable: false,
    tokenTotalsOverflow: false,
  };
}

function metricDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(9_000_000_000_000_000, numeric);
}

function metricDisplayNumber(value, { decimals = 0 } = {}) {
  const numeric = finiteMetricNumber(value, { max: 9_000_000_000_000_000 });
  if (decimals === 0) return Math.round(numeric).toLocaleString('en-US');
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function metricHourLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const date = new Date(numeric);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function normalizeMetricRows(hourly, { tokenRows = false } = {}) {
  if (!Array.isArray(hourly)) return [];
  return hourly.map((row) => ({
    ...emptyMetricRow(Number(row?.hourBucketMs)),
    requestCount: metricCount(row?.requestCount),
    successCount: metricCount(row?.successCount),
    errorCount: metricCount(row?.errorCount),
    totalRequestBytes: metricCount(row?.totalRequestBytes),
    totalResponseBytes: metricCount(row?.totalResponseBytes),
    avgTtfbMs: metricDuration(row?.avgTtfbMs),
    avgDurationMs: metricDuration(row?.avgDurationMs),
    totalInputTokens: metricTokenNumber(row?.totalInputTokens),
    totalCacheCreationInputTokens: metricTokenNumber(row?.totalCacheCreationInputTokens),
    totalCacheReadInputTokens: metricTokenNumber(row?.totalCacheReadInputTokens),
    totalOutputTokens: metricTokenNumber(row?.totalOutputTokens),
    totalInputTokensKnownCount: metricTokenKnownCount(row, 'totalInputTokens'),
    totalCacheCreationInputTokensKnownCount: metricTokenKnownCount(row, 'totalCacheCreationInputTokens'),
    totalCacheReadInputTokensKnownCount: metricTokenKnownCount(row, 'totalCacheReadInputTokens'),
    totalOutputTokensKnownCount: metricTokenKnownCount(row, 'totalOutputTokens'),
    usageUnavailableCount: metricCount(row?.usageUnavailableCount),
    usagePartialCount: metricCount(row?.usagePartialCount),
    usageCompleteCount: metricCount(row?.usageCompleteCount),
    tokenApplicable: tokenRows,
    tokenTotalsOverflow: row?.tokenTotalsOverflow === true,
  }));
}

function normalizeMetricTokenTotals(totals) {
  const source = totals ?? {};
  return {
    totalInputTokens: metricTokenNumber(source.totalInputTokens),
    totalCacheCreationInputTokens: metricTokenNumber(source.totalCacheCreationInputTokens),
    totalCacheReadInputTokens: metricTokenNumber(source.totalCacheReadInputTokens),
    totalOutputTokens: metricTokenNumber(source.totalOutputTokens),
    totalInputTokensKnownCount: metricTokenKnownCount(source, 'totalInputTokens'),
    totalCacheCreationInputTokensKnownCount: metricTokenKnownCount(source, 'totalCacheCreationInputTokens'),
    totalCacheReadInputTokensKnownCount: metricTokenKnownCount(source, 'totalCacheReadInputTokens'),
    totalOutputTokensKnownCount: metricTokenKnownCount(source, 'totalOutputTokens'),
    usageUnavailableCount: metricCount(source.usageUnavailableCount),
    usagePartialCount: metricCount(source.usagePartialCount),
    usageCompleteCount: metricCount(source.usageCompleteCount),
    tokenTotalsOverflow: source.tokenTotalsOverflow === true,
  };
}

function mergeMetricRows(requestRows, tokenRows) {
  const rows = new Map();
  for (const row of requestRows) rows.set(row.hourBucketMs, { ...row });
  for (const row of tokenRows) {
    const current = rows.get(row.hourBucketMs) ?? emptyMetricRow(row.hourBucketMs);
    for (const field of TOKEN_ROW_FIELDS) current[field] = row[field];
    rows.set(row.hourBucketMs, current);
  }
  return [...rows.values()].sort((left, right) => left.hourBucketMs - right.hourBucketMs);
}

function metricOption(value, label, selected, { i18n = null } = {}) {
  const normalizedValue = String(value ?? '');
  const text = String(label ?? normalizedValue);
  const selectedAttribute = normalizedValue === selected ? ' selected' : '';
  const translationAttribute = i18n ? ` data-i18n="${escapeHtml(i18n)}"` : '';
  return `<option value="${escapeHtml(normalizedValue)}"${selectedAttribute}${translationAttribute}>${escapeHtml(text)}</option>`;
}

function metricOptions(values, selected, allLabel, allI18n) {
  const options = Array.isArray(values) ? values : [];
  const seen = new Set();
  const rendered = [metricOption('', allLabel, selected, { i18n: allI18n })];
  for (const option of options) {
    const value = String(option?.value ?? '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    rendered.push(metricOption(value, option?.label, selected));
  }
  if (selected && !seen.has(selected)) {
    rendered.push(metricOption(selected, selected, selected));
  }
  return rendered.join('');
}

function metricMachineOptions(values, selected, unattributedMachine) {
  const options = Array.isArray(values) ? values : [];
  const seen = new Set();
  const selectedMachine = selected || '';
  const effectiveSelected = unattributedMachine ? UNATTRIBUTED_MACHINE_VALUE : selectedMachine;
  const rendered = [metricOption('', 'All machines', effectiveSelected, { i18n: 'metrics-all-machines' })];
  for (const option of options) {
    const value = String(option?.value ?? '');
    if (!value || value === UNATTRIBUTED_MACHINE_VALUE || seen.has(value)) continue;
    seen.add(value);
    rendered.push(metricOption(value, option?.label, effectiveSelected));
  }
  if (selectedMachine && !seen.has(selectedMachine)) {
    rendered.push(metricOption(selectedMachine, selectedMachine, effectiveSelected));
  }
  rendered.push(metricOption(
    UNATTRIBUTED_MACHINE_VALUE,
    'Unattributed (no machine handle)',
    effectiveSelected,
    { i18n: 'metrics-unattributed-machine' },
  ));
  return rendered.join('');
}

function metricSvgNumber(value) {
  const numeric = finiteMetricNumber(value, { max: 9_000_000_000_000_000 });
  return Number(numeric.toFixed(2));
}

function metricPolyline(rows, getter, maxValue, plot) {
  if (!rows.length) return '';
  const denominator = Math.max(rows.length - 1, 1);
  let open = false;
  return rows.map((row, index) => {
    const rawValue = getter(row);
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      open = false;
      return '';
    }
    const value = finiteMetricNumber(rawValue, { max: maxValue });
    const x = plot.left + (plot.width * index) / denominator;
    const y = plot.top + plot.height - (plot.height * value) / Math.max(maxValue, 1);
    const command = open ? 'L' : 'M';
    open = true;
    return `${command} ${metricSvgNumber(x)} ${metricSvgNumber(y)}`;
  }).filter(Boolean).join(' ');
}

function metricPoints(rows, getter, maxValue, plot, className) {
  if (!rows.length) return '';
  const denominator = Math.max(rows.length - 1, 1);
  return rows.map((row, index) => {
    const rawValue = getter(row);
    if (rawValue === null || rawValue === undefined || rawValue === '') return '';
    const value = finiteMetricNumber(rawValue, { max: maxValue });
    const x = plot.left + (plot.width * index) / denominator;
    const y = plot.top + plot.height - (plot.height * value) / Math.max(maxValue, 1);
    return `<circle class="metrics-point ${escapeHtml(className)}" cx="${metricSvgNumber(x)}" cy="${metricSvgNumber(y)}" r="3" aria-hidden="true"></circle>`;
  }).filter(Boolean).join('');
}

function metricSvgChart({
  id,
  title,
  titleI18n,
  description,
  descriptionI18n,
  emptyI18n,
  emptyText,
  rows,
  series,
  maxValue = null,
  formatValue = metricDisplayNumber,
}) {
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const width = 720;
  const height = 260;
  const plot = { left: 54, top: 24, width: 644, height: 184 };
  const safeRows = Array.isArray(rows) ? rows : [];
  const values = safeRows.flatMap((row) => series
    .map((entry) => entry.getter(row))
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => finiteMetricNumber(value, { max: 9_000_000_000_000_000 })));
  const scale = Math.max(1, finiteMetricNumber(maxValue ?? Math.max(...values, 0), {
    max: 9_000_000_000_000_000,
  }));
  const titleAttribute = titleI18n ? ` data-i18n="${escapeHtml(titleI18n)}"` : '';
  const descriptionAttribute = descriptionI18n ? ` data-i18n="${escapeHtml(descriptionI18n)}"` : '';
  const labelledBy = `${titleId} ${descriptionId}`;
  const commonStart = `<svg role="img" aria-labelledby="${escapeHtml(labelledBy)}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <title id="${escapeHtml(titleId)}"${titleAttribute}>${escapeHtml(title)}</title>
    <desc id="${escapeHtml(descriptionId)}"${descriptionAttribute}>${escapeHtml(description)}</desc>`;
  if (!safeRows.length || !values.length) {
    return `${commonStart}
    <text class="metrics-axis" x="${width / 2}" y="${height / 2}" text-anchor="middle" data-i18n="${escapeHtml(emptyI18n)}">${escapeHtml(emptyText)}</text>
  </svg>`;
  }

  const tickValues = [0, scale / 2, scale];
  const grid = tickValues.map((value) => {
    const y = plot.top + plot.height - (plot.height * value) / scale;
    return `<line class="metrics-grid-line" x1="${plot.left}" x2="${plot.left + plot.width}" y1="${metricSvgNumber(y)}" y2="${metricSvgNumber(y)}"></line>
      <text class="metrics-axis" x="${plot.left - 8}" y="${metricSvgNumber(y + 4)}" text-anchor="end">${escapeHtml(formatValue(value))}</text>`;
  }).join('');
  const firstLabel = metricHourLabel(safeRows[0].hourBucketMs);
  const lastLabel = metricHourLabel(safeRows[safeRows.length - 1].hourBucketMs);
  const xLabels = safeRows.length === 1
    ? `<text class="metrics-axis" x="${plot.left}" y="${height - 12}" text-anchor="middle">${escapeHtml(firstLabel)}</text>`
    : `<text class="metrics-axis" x="${plot.left}" y="${height - 12}" text-anchor="start">${escapeHtml(firstLabel)}</text>
      <text class="metrics-axis" x="${plot.left + plot.width}" y="${height - 12}" text-anchor="end">${escapeHtml(lastLabel)}</text>`;
  const paths = series.map((entry) => `<path class="metrics-line ${escapeHtml(entry.className)}"${entry.dashArray ? ` stroke-dasharray="${escapeHtml(entry.dashArray)}"` : ''} d="${escapeHtml(metricPolyline(safeRows, entry.getter, scale, plot))}"></path>`).join('');
  const points = series.map((entry) => metricPoints(safeRows, entry.getter, scale, plot, entry.className)).join('');
  return `${commonStart}
    ${grid}
    <line class="metrics-grid-line" x1="${plot.left}" x2="${plot.left}" y1="${plot.top}" y2="${plot.top + plot.height}"></line>
    <line class="metrics-grid-line" x1="${plot.left}" x2="${plot.left + plot.width}" y1="${plot.top + plot.height}" y2="${plot.top + plot.height}"></line>
    ${paths}
    ${points}
    ${xLabels}
  </svg>`;
}

function metricLegend(series) {
  return `<div class="metrics-legend">
    ${series.map((entry) => `<span class="metrics-legend-item"><span class="metrics-swatch ${escapeHtml(entry.className)}" aria-hidden="true"></span><span data-i18n="${escapeHtml(entry.i18n)}">${escapeHtml(entry.label)}</span></span>`).join('')}
  </div>`;
}

function tokenSummaryCard({ label, i18n, value, knownCount }) {
  return `<article class="card summary">
    <span class="muted" data-i18n="${escapeHtml(i18n)}">${escapeHtml(label)}</span>
    <strong>${escapeHtml(metricTokenText(value))}</strong>
    <span class="metrics-token-known"><span data-i18n="metrics-token-known-count">Known values</span>: ${escapeHtml(metricDisplayNumber(knownCount))}</span>
  </article>`;
}

function tokenCoverageNotice(totals) {
  const hasAnyTotal = TOKEN_METRIC_FIELDS.some((field) => totals[field] !== null);
  const hasUnknownTotal = TOKEN_METRIC_FIELDS.some((field) => totals[field] === null);
  const complete = totals.usageCompleteCount;
  const partial = totals.usagePartialCount;
  const unavailable = totals.usageUnavailableCount;
  const hasKnownValue = TOKEN_METRIC_FIELDS.some((field) => (
    totals[`${field}KnownCount`] > 0
  ));
  let i18n = 'metrics-token-coverage-unavailable';
  let text = 'Token usage is unavailable for this selection; — means unknown, not zero.';
  let className = 'notice';
  if (totals.tokenTotalsOverflow) {
    if (partial > 0 || unavailable > 0) {
      i18n = 'metrics-token-coverage-overflow-lower-bound';
      text = 'At least one total is too large to display exactly, and partial or unavailable usage makes the visible sums lower bounds.';
    } else {
      i18n = 'metrics-token-coverage-overflow';
      text = 'At least one token total is too large to display exactly; raw per-request counts remain stored.';
    }
    className = 'notice error';
  } else if (hasAnyTotal && (partial > 0 || unavailable > 0)) {
    i18n = 'metrics-token-coverage-lower-bound';
    text = 'Token totals are a lower bound; partial or unavailable usage is not treated as zero.';
    className = 'notice error';
  } else if (complete > 0 && hasUnknownTotal) {
    i18n = 'metrics-token-coverage-complete-with-unknown';
    text = 'Usage records are complete, but — categories were not reported by the provider.';
  } else if (hasAnyTotal && !hasUnknownTotal && (complete > 0 || hasKnownValue)) {
    i18n = 'metrics-token-coverage-complete';
    text = 'Token totals are exact for complete usage records.';
    className = 'notice success';
  }
  return `<div class="${className} metrics-token-coverage" role="note">
    <p><span data-i18n="${i18n}">${text}</span></p>
    <p class="tiny">
      <span data-i18n="metrics-token-complete-count">Complete</span>: ${escapeHtml(metricDisplayNumber(complete))}
      · <span data-i18n="metrics-token-partial-count">Partial</span>: ${escapeHtml(metricDisplayNumber(partial))}
      · <span data-i18n="metrics-token-unavailable-count">Unavailable</span>: ${escapeHtml(metricDisplayNumber(unavailable))}
    </p>
  </div>`;
}

function metricUsageCoverage(row) {
  const allKnown = TOKEN_METRIC_FIELDS.every((field) => row[field] !== null);
  if (!row.tokenApplicable) {
    return '<span data-i18n="metrics-usage-not-applicable">Not applicable</span>';
  }
  if (row.tokenTotalsOverflow) {
    return '<span data-i18n="metrics-usage-overflow">Too large to total exactly</span>';
  }
  if (row.usageCompleteCount > 0 && row.usagePartialCount === 0
    && row.usageUnavailableCount === 0) {
    return allKnown
      ? '<span data-i18n="metrics-usage-complete">Complete</span>'
      : '<span data-i18n="metrics-usage-complete-with-unknown">Complete / some categories unknown</span>';
  }
  if (TOKEN_METRIC_FIELDS.some((field) => row[field] !== null)
    || row.usagePartialCount > 0) {
    return '<span data-i18n="metrics-usage-partial">Partial / lower bound</span>';
  }
  return '<span data-i18n="metrics-usage-unavailable">Unavailable</span>';
}

function metricsTable(rows) {
  const body = rows.length
    ? rows.map((row) => `<tr>
        <td>${escapeHtml(metricHourLabel(row.hourBucketMs))}</td>
        <td>${escapeHtml(metricDisplayNumber(row.requestCount))}</td>
        <td>${escapeHtml(metricDisplayNumber(row.successCount))}</td>
        <td>${escapeHtml(metricDisplayNumber(row.errorCount))}</td>
        <td>${escapeHtml(metricDisplayNumber(row.totalRequestBytes))}</td>
        <td>${escapeHtml(metricDisplayNumber(row.totalResponseBytes))}</td>
        <td>${row.avgTtfbMs === null ? '—' : escapeHtml(metricDisplayNumber(row.avgTtfbMs, { decimals: 1 }))}</td>
        <td>${row.avgDurationMs === null ? '—' : escapeHtml(metricDisplayNumber(row.avgDurationMs, { decimals: 1 }))}</td>
        <td>${escapeHtml(metricTokenText(row.totalInputTokens))}</td>
        <td>${escapeHtml(metricTokenText(row.totalCacheCreationInputTokens))}</td>
        <td>${escapeHtml(metricTokenText(row.totalCacheReadInputTokens))}</td>
        <td>${escapeHtml(metricTokenText(row.totalOutputTokens))}</td>
        <td>${metricUsageCoverage(row)}</td>
      </tr>`).join('')
    : '<tr><td colspan="13" class="empty" data-i18n="metrics-no-data">No matching request data for this period.</td></tr>';
  return `<div class="metrics-table-wrap">
    <table class="metrics-table">
      <thead><tr>
        <th data-i18n="metrics-hour">Hour (UTC)</th>
        <th data-i18n="metrics-request-count">Requests</th>
        <th data-i18n="metrics-success-count">Successes</th>
        <th data-i18n="metrics-error-count">Errors</th>
        <th data-i18n="metrics-request-bytes">Request bytes</th>
        <th data-i18n="metrics-response-bytes">Response bytes</th>
        <th data-i18n="metrics-avg-ttfb">Avg TTFB (ms)</th>
        <th data-i18n="metrics-avg-duration">Avg duration (ms)</th>
        <th data-i18n="metrics-total-input-tokens">Input tokens</th>
        <th data-i18n="metrics-total-cache-creation-input-tokens">Cache creation input tokens</th>
        <th data-i18n="metrics-total-cache-read-input-tokens">Cache read input tokens</th>
        <th data-i18n="metrics-total-output-tokens">Output tokens</th>
        <th data-i18n="metrics-usage-coverage">Usage coverage</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

const DEVICE_COMPARISON_INPUT_FIELDS = Object.freeze([
  ['inputTokens', 'inputTokensKnownCount'],
  ['cacheCreationInputTokens', 'cacheCreationInputTokensKnownCount'],
  ['cacheReadInputTokens', 'cacheReadInputTokensKnownCount'],
]);
const DEVICE_COMPARISON_OUTPUT_FIELDS = Object.freeze([['outputTokens', 'outputTokensKnownCount']]);
const DEVICE_COMPARISON_DASHES = Object.freeze([
  null,
  '8 5',
  '2 4',
  '12 4 2 4',
  '3 3',
  '16 4 2 4',
  '5 3 1 3',
  '10 3 2 3',
]);

function normalizeDeviceComparison(input = {}) {
  const devices = [];
  const seen = new Set();
  for (const device of Array.isArray(input.devices) ? input.devices : []) {
    const value = String(device?.value ?? device?.deviceId ?? device?.id ?? '');
    if (!value || seen.has(value) || devices.length >= 8) continue;
    seen.add(value);
    devices.push({ value, label: String(device?.label ?? device?.name ?? value) });
  }
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const buckets = new Map();
  for (const row of rows) {
    const hourBucketMs = Number(row?.hourBucketMs ?? row?.hour_bucket_ms);
    if (!Number.isFinite(hourBucketMs)) continue;
    const deviceId = String(row?.deviceId ?? row?.device_id ?? row?.device ?? '');
    if (!deviceId || !seen.has(deviceId)) continue;
    const bucket = buckets.get(hourBucketMs) ?? { hourBucketMs };
    bucket[`input:${deviceId}`] = deviceComparisonInputSum(row);
    bucket[`output:${deviceId}`] = deviceComparisonOutput(row);
    buckets.set(hourBucketMs, bucket);
  }
  return {
    devices,
    rows: [...buckets.values()].sort((left, right) => left.hourBucketMs - right.hourBucketMs),
    sourceRows: rows,
    devicesTruncated: input.devicesTruncated === true || (Array.isArray(input.devices) && input.devices.length > 8),
    hoursTruncated: input.hoursTruncated === true,
    unavailableDeviceCount: metricCount(input.unavailableDeviceCount),
    legacyTruncated: input.truncated === true
      && input.devicesTruncated !== true
      && input.hoursTruncated !== true,
  };
}

function deviceComparisonSum(row, fields) {
  let sum = 0;
  for (const [field, knownField] of fields) {
    const value = metricTokenNumber(row?.[field]);
    if (!deviceComparisonFieldKnown(row, field, knownField)) return null;
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

function deviceComparisonFieldKnown(row, field, knownField) {
  const value = metricTokenNumber(row?.[field]);
  if (value === null) return false;
  if (!Object.hasOwn(row ?? {}, knownField)) return true;
  return metricCount(row?.[knownField]) === metricCount(row?.requestCount);
}

function deviceComparisonInputSum(row) {
  return deviceComparisonSum(row, DEVICE_COMPARISON_INPUT_FIELDS);
}

function deviceComparisonOutput(row) {
  return deviceComparisonSum(row, DEVICE_COMPARISON_OUTPUT_FIELDS);
}

function deviceComparisonAnyKnown(row) {
  return [...DEVICE_COMPARISON_INPUT_FIELDS, ...DEVICE_COMPARISON_OUTPUT_FIELDS]
    .some(([field, knownField]) => deviceComparisonFieldKnown(row, field, knownField));
}

function deviceComparisonUnknownCount(row) {
  for (const key of ['unknownCount', 'unknownTokenCount', 'unknownCategories']) {
    if (row && row[key] !== null && row[key] !== undefined && row[key] !== '') {
      return metricCount(row[key]);
    }
  }
  const fields = [...DEVICE_COMPARISON_INPUT_FIELDS, ...DEVICE_COMPARISON_OUTPUT_FIELDS];
  const unknown = fields.reduce((count, [field, knownField]) => (
    deviceComparisonFieldKnown(row, field, knownField) ? count : count + 1
  ), 0);
  return row?.tokenTotalsOverflow === true ? unknown + 1 : unknown;
}

function deviceComparisonCoverage(rows) {
  const sourceRows = rows.filter(Boolean);
  let complete = 0;
  let partial = 0;
  let unavailable = 0;
  let knownPoints = 0;
  let unknownPoints = 0;
  for (const row of sourceRows) {
    const state = String(row?.coverage ?? row?.usageState ?? row?.responseState ?? '').toLowerCase();
    const unknown = deviceComparisonUnknownCount(row);
    const rowPartial = metricCount(row?.usagePartialCount);
    const rowUnavailable = metricCount(row?.usageUnavailableCount);
    unknownPoints += unknown > 0 ? 1 : 0;
    if (deviceComparisonAnyKnown(row)) knownPoints += 1;
    if (rowUnavailable > 0 || state === 'unavailable' || state === 'missing') unavailable += 1;
    else if (rowPartial > 0 || state === 'partial' || state === 'lower_bound') partial += 1;
    else if (state === 'complete' || state === 'completed') complete += 1;
    else if (deviceComparisonInputSum(row) === null && deviceComparisonOutput(row) === null) unavailable += 1;
    else if (unknown > 0) partial += 1;
    else complete += 1;
  }
  const state = partial > 0 || unavailable > 0
    ? (knownPoints > 0 ? 'partial' : 'unavailable')
    : (complete > 0 ? 'complete' : 'unavailable');
  return { state, complete, partial, unavailable, knownPoints, unknownPoints };
}

function deviceComparisonCoverageView(coverage) {
  const key = coverage.state === 'complete'
    ? 'metrics-device-comparison-complete'
    : coverage.state === 'partial'
      ? 'metrics-device-comparison-partial'
      : 'metrics-device-comparison-unavailable';
  const text = coverage.state === 'complete'
    ? 'Complete'
    : coverage.state === 'partial'
      ? 'Partial / lower bound'
      : 'Unavailable';
  return `<span data-i18n="${key}">${text}</span>`;
}

function deviceComparisonView(input) {
  const comparison = normalizeDeviceComparison(input);
  const sourceRowsByDevice = new Map(comparison.devices.map((device) => [device.value, []]));
  for (const row of comparison.sourceRows) {
    const deviceId = String(row?.deviceId ?? row?.device_id ?? row?.device ?? '');
    if (sourceRowsByDevice.has(deviceId)) sourceRowsByDevice.get(deviceId).push(row);
  }
  const deviceSeries = (side) => comparison.devices.map((device, index) => ({
    className: `device-${index}`,
    dashArray: DEVICE_COMPARISON_DASHES[index],
    i18n: 'metrics-device-comparison-known-sum',
    label: device.label,
    getter: (row) => row[`${side}:${device.value}`],
  }));
  const inputChart = metricSvgChart({
    id: 'metrics-device-input-comparison-chart',
    title: 'Hourly input-side known tokens by device',
    titleI18n: 'metrics-device-input-comparison-heading',
    description: 'Each line is input plus cache creation plus cache read tokens only when all three categories are known; missing categories create a gap.',
    descriptionI18n: 'metrics-device-input-comparison-description',
    emptyI18n: 'metrics-device-comparison-no-data',
    emptyText: 'No cross-device token comparison data is available.',
    rows: comparison.rows,
    series: deviceSeries('input'),
    formatValue: (value) => metricDisplayNumber(value),
  });
  const outputChart = metricSvgChart({
    id: 'metrics-device-output-comparison-chart',
    title: 'Hourly output tokens by device',
    titleI18n: 'metrics-device-output-comparison-heading',
    description: 'Each line is output_tokens; unknown output values create a gap and are not treated as zero.',
    descriptionI18n: 'metrics-device-output-comparison-description',
    emptyI18n: 'metrics-device-comparison-no-data',
    emptyText: 'No cross-device token comparison data is available.',
    rows: comparison.rows,
    series: deviceSeries('output'),
    formatValue: (value) => metricDisplayNumber(value),
  });
  const legend = comparison.devices.map((device, index) => {
    const coverage = deviceComparisonCoverage(sourceRowsByDevice.get(device.value) ?? []);
    return `<div class="metrics-legend-item" data-device-comparison="${escapeHtml(device.value)}">
      <span class="metrics-swatch device-${index}" aria-hidden="true"></span>
      <span><span data-i18n="metrics-device-comparison-device">Device</span>: ${escapeHtml(device.label)}</span>
      <span class="tiny"><span data-i18n="metrics-device-comparison-known-points">Known points</span>: ${escapeHtml(String(coverage.knownPoints))}; <span data-i18n="metrics-device-comparison-unknown-points">Unknown points</span>: ${escapeHtml(String(coverage.unknownPoints))}; ${deviceComparisonCoverageView(coverage)}</span>
    </div>`;
  }).join('');
  const tableRows = comparison.devices.flatMap((device) => (
    (sourceRowsByDevice.get(device.value) ?? []).map((row) => `<tr>
      <td>${escapeHtml(metricHourLabel(row.hourBucketMs ?? row.hour_bucket_ms))}</td>
      <td>${escapeHtml(device.label)}</td>
      <td>${escapeHtml(metricTokenText(row.inputTokens ?? row.totalInputTokens))}</td>
      <td>${escapeHtml(metricTokenText(row.cacheCreationInputTokens ?? row.totalCacheCreationInputTokens))}</td>
      <td>${escapeHtml(metricTokenText(row.cacheReadInputTokens ?? row.totalCacheReadInputTokens))}</td>
      <td>${escapeHtml(metricTokenText(row.outputTokens ?? row.totalOutputTokens))}</td>
      <td>${deviceComparisonCoverageView(deviceComparisonCoverage([row]))}</td>
    </tr>`)
  )).join('');
  const truncatedNotice = [
    comparison.devicesTruncated
      ? '<p class="notice metrics-comparison-note" role="note" data-i18n="metrics-device-comparison-devices-truncated">Showing at most eight devices; additional devices are omitted.</p>'
      : '',
    comparison.hoursTruncated
      ? '<p class="notice metrics-comparison-note" role="note" data-i18n="metrics-device-comparison-hours-truncated">The hourly comparison is bounded; some hours are omitted.</p>'
      : '',
    comparison.unavailableDeviceCount > 0
      ? `<p class="notice metrics-comparison-note" role="note"><span data-i18n="metrics-device-comparison-unavailable-devices">Some devices were unavailable for comparison.</span> <strong>${escapeHtml(String(comparison.unavailableDeviceCount))}</strong></p>`
      : '',
    comparison.legacyTruncated
      ? '<p class="notice metrics-comparison-note" role="note" data-i18n="metrics-device-comparison-truncated">Comparison data is bounded; some devices or hours may be omitted.</p>'
      : '',
  ].join('');
  return `<article class="metrics-chart metrics-chart-wide metrics-comparison">
    <h2 data-i18n="metrics-device-comparison-heading">Cross-device token comparison</h2>
    <p class="muted tiny" data-i18n="metrics-device-comparison-description">Two synchronized charts compare input-side known tokens and output_tokens by device. Unknown values are gaps, not zeros; this is a trend view, not billing.</p>
    <p class="muted tiny" data-i18n="metrics-device-comparison-scope">This comparison follows the member, account, model, and time filters; it intentionally ignores the single-device machine selector.</p>
    ${truncatedNotice}
    <h3 data-i18n="metrics-device-input-comparison-heading">Hourly input-side known tokens by device</h3>
    ${inputChart}
    <h3 data-i18n="metrics-device-output-comparison-heading">Hourly output tokens by device</h3>
    ${outputChart}
    <div class="metrics-legend">${legend || '<span class="metrics-empty" data-i18n="metrics-device-comparison-no-data">No cross-device token comparison data is available.</span>'}</div>
    <div class="metrics-comparison-table-wrap"><table class="metrics-table metrics-comparison-table">
      <caption class="muted tiny" data-i18n="metrics-device-comparison-table-caption">Raw four-category values and coverage fallback</caption>
      <thead><tr><th scope="col" data-i18n="metrics-hour">Hour (UTC)</th><th scope="col" data-i18n="metrics-device-comparison-device">Device</th><th scope="col" data-i18n="metrics-total-input-tokens">Input tokens</th><th scope="col" data-i18n="metrics-total-cache-creation-input-tokens">Cache creation input tokens</th><th scope="col" data-i18n="metrics-total-cache-read-input-tokens">Cache read input tokens</th><th scope="col" data-i18n="metrics-total-output-tokens">Output tokens</th><th scope="col" data-i18n="metrics-device-comparison-coverage">Coverage</th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="7" class="empty" data-i18n="metrics-device-comparison-no-data">No cross-device token comparison data is available.</td></tr>'}</tbody>
    </table></div>
  </article>`;
}

export function metricsView({
  filters = {},
  options = {},
  totals = {},
  hourly = [],
  tokenTotals = {},
  tokenHourly = [],
  deviceTokenComparison = {},
  openMode = false,
  metricsAvailable = true,
  droppedMetrics = 0,
  error = null,
}) {
  const selectedHours = Number(filters.hours);
  const hours = METRICS_HOUR_OPTIONS.some((option) => option.value === selectedHours)
    ? selectedHours
    : METRICS_HOUR_OPTIONS[0].value;
  const selectedMachine = String(filters.machineId ?? '');
  const selectedMember = String(filters.memberLabel ?? '');
  const selectedAccount = String(filters.accountId ?? '');
  const selectedModel = String(filters.model ?? '');
  const unattributedMachine = Boolean(filters.unattributedMachine);
  const requestRows = normalizeMetricRows(hourly);
  const tokenRows = normalizeMetricRows(tokenHourly, { tokenRows: true });
  const rows = mergeMetricRows(requestRows, tokenRows);
  const normalizedTokenTotals = normalizeMetricTokenTotals(tokenTotals);
  const allTotal = metricCount(totals.all);
  const consumptionTotal = metricCount(totals.consumption);
  const requestSeries = [
    { className: 'total', i18n: 'metrics-series-total', label: 'All requests', getter: (row) => row.requestCount },
    { className: 'success', i18n: 'metrics-series-success', label: 'Successful requests', getter: (row) => row.successCount },
    { className: 'error', i18n: 'metrics-series-error', label: 'Error requests', getter: (row) => row.errorCount },
  ];
  const latencySeries = [
    { className: 'ttfb', i18n: 'metrics-series-ttfb', label: 'Average TTFB (ms)', getter: (row) => row.avgTtfbMs },
    { className: 'duration', i18n: 'metrics-series-duration', label: 'Average duration (ms)', getter: (row) => row.avgDurationMs },
  ];
  const tokenSeries = [
    { className: 'input', i18n: 'metrics-series-input-tokens', label: 'Input tokens', getter: (row) => row.totalInputTokens },
    { className: 'cache-create', i18n: 'metrics-series-cache-creation-input-tokens', label: 'Cache creation input tokens', getter: (row) => row.totalCacheCreationInputTokens },
    { className: 'cache-read', i18n: 'metrics-series-cache-read-input-tokens', label: 'Cache read input tokens', getter: (row) => row.totalCacheReadInputTokens },
    { className: 'output', i18n: 'metrics-series-output-tokens', label: 'Output tokens', getter: (row) => row.totalOutputTokens },
  ];
  const requestChart = metricSvgChart({
    id: 'metrics-requests-chart',
    title: 'Hourly request volume',
    titleI18n: 'metrics-request-volume',
    description: 'Hourly all-request, successful-request, and error counts.',
    descriptionI18n: 'metrics-request-volume-description',
    emptyI18n: 'metrics-no-data',
    emptyText: 'No matching request data for this period.',
    rows,
    series: requestSeries,
    formatValue: (value) => metricDisplayNumber(value),
  });
  const latencyChart = metricSvgChart({
    id: 'metrics-latency-chart',
    title: 'Hourly request latency',
    titleI18n: 'metrics-latency',
    description: 'Hourly average time to first byte and total request duration in milliseconds.',
    descriptionI18n: 'metrics-latency-description',
    emptyI18n: 'metrics-no-data',
    emptyText: 'No matching request data for this period.',
    rows,
    series: latencySeries,
    formatValue: (value) => metricDisplayNumber(value, { decimals: 1 }),
  });
  const tokenChart = metricSvgChart({
    id: 'metrics-tokens-chart',
    title: 'Hourly token usage',
    titleI18n: 'metrics-token-trend',
    description: 'Hourly input, cache creation, cache read, and output token totals; unknown values are omitted rather than treated as zero.',
    descriptionI18n: 'metrics-token-trend-description',
    emptyI18n: 'metrics-token-no-data',
    emptyText: 'Token usage is unavailable; unknown values are not zero.',
    rows: tokenRows,
    series: tokenSeries,
    formatValue: (value) => metricDisplayNumber(value),
  });
  const deviceComparison = deviceComparisonView(deviceTokenComparison);
  const availabilityNotice = !metricsAvailable
    ? '<div class="notice error" role="status"><span data-i18n="metrics-unavailable">Request metrics are temporarily unavailable.</span></div>'
    : '';
  const dropped = metricCount(droppedMetrics);
  const droppedNotice = dropped > 0
    ? `<div class="notice error" role="status"><span data-i18n="metrics-incomplete">Some request metadata could not be stored; charts may be incomplete.</span> <strong>${escapeHtml(metricDisplayNumber(dropped))}</strong></div>`
    : '';
  const errorNotice = error
    ? `<div class="notice error" role="alert"><span data-i18n="metrics-error">The metrics page could not load its data.</span><br><span class="tiny">${escapeHtml(error)}</span></div>`
    : '';
  const hourOptions = METRICS_HOUR_OPTIONS.map((option) => metricOption(
    option.value,
    option.label,
    String(hours),
    { i18n: option.i18n },
  )).join('');
  return layout('Request metrics', `
    <section class="stack">
      ${availabilityNotice}
      ${droppedNotice}
      ${errorNotice}
      <div class="metrics-heading">
        <div>
          <span class="badge stored" data-i18n="metrics-label">Request metrics</span>
          <h1 data-i18n="metrics-heading">Claude gateway request metrics</h1>
          <p class="muted" data-i18n="metrics-intro">This page shows request metadata only. Request and response bodies are not rendered here; eligible captured conversations appear in the conversation archive.</p>
          <p class="muted tiny" data-i18n="metrics-claude-only">Token accounting covers Claude gateway traffic only. Codex clients connect directly to their provider and are not included.</p>
        </div>
        <div class="actions">
          <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
          <a class="button secondary" href="/conversations" data-i18n="metrics-conversations-link">View conversations</a>
        </div>
      </div>
      <div class="notice error metrics-attribution-notice" role="note">
        <p data-i18n="metrics-attribution-disclaimer">Member labels are self-entered and unverified. Use them only to observe usage trends; never use them for accountability or billing.</p>
      </div>
      <form method="get" action="/metrics" class="card metrics-filters">
        <h2 class="metrics-filter-heading" data-i18n="metrics-filter-heading">Filter request metrics</h2>
        <label><span data-i18n="metrics-filter-machine">Machine</span>
          <select name="machine_id">${metricMachineOptions(options.machines, selectedMachine, unattributedMachine)}</select>
        </label>
        <label><span data-i18n="metrics-filter-member">Member label</span>
          <select name="member_label">${metricOptions(options.members, selectedMember, 'All members', 'metrics-all-members')}</select>
        </label>
        <label><span data-i18n="metrics-filter-account">Account</span>
          <select name="account_id">${metricOptions(options.accounts, selectedAccount, 'All accounts', 'metrics-all-accounts')}</select>
        </label>
        <label><span data-i18n="metrics-filter-model">Model</span>
          <select name="model">${metricOptions(options.models, selectedModel, 'All models', 'metrics-all-models')}</select>
        </label>
        <label><span data-i18n="metrics-filter-hours">Period</span>
          <select name="hours">${hourOptions}</select>
        </label>
        <div class="filter-actions">
          <button type="submit" data-i18n="metrics-apply-filters">Apply filters</button>
          <a class="button secondary" href="/metrics" data-i18n="metrics-reset-filters">Reset filters</a>
        </div>
      </form>
      <div class="metrics-summary">
        <article class="card summary"><span class="muted" data-i18n="metrics-total-requests">All requests</span><strong>${escapeHtml(metricDisplayNumber(allTotal))}</strong></article>
        <article class="card summary"><span class="muted" data-i18n="metrics-consumption-requests">Consumption requests</span><strong>${escapeHtml(metricDisplayNumber(consumptionTotal))}</strong></article>
      </div>
      ${tokenCoverageNotice(normalizedTokenTotals)}
      <div class="metrics-token-summary">
        ${tokenSummaryCard({ label: 'Input tokens', i18n: 'metrics-token-input', value: normalizedTokenTotals.totalInputTokens, knownCount: normalizedTokenTotals.totalInputTokensKnownCount })}
        ${tokenSummaryCard({ label: 'Cache creation input tokens', i18n: 'metrics-token-cache-creation', value: normalizedTokenTotals.totalCacheCreationInputTokens, knownCount: normalizedTokenTotals.totalCacheCreationInputTokensKnownCount })}
        ${tokenSummaryCard({ label: 'Cache read input tokens', i18n: 'metrics-token-cache-read', value: normalizedTokenTotals.totalCacheReadInputTokens, knownCount: normalizedTokenTotals.totalCacheReadInputTokensKnownCount })}
        ${tokenSummaryCard({ label: 'Output tokens', i18n: 'metrics-token-output', value: normalizedTokenTotals.totalOutputTokens, knownCount: normalizedTokenTotals.totalOutputTokensKnownCount })}
      </div>
      <div class="metrics-chart-grid">
        <article class="metrics-chart">
          <h2 data-i18n="metrics-request-volume">Hourly request volume</h2>
          ${requestChart}
          ${metricLegend(requestSeries)}
        </article>
        <article class="metrics-chart">
          <h2 data-i18n="metrics-latency">Hourly request latency</h2>
          ${latencyChart}
          ${metricLegend(latencySeries)}
        </article>
        <article class="metrics-chart metrics-chart-wide">
          <h2 data-i18n="metrics-token-trend">Hourly token usage</h2>
          ${tokenChart}
          ${metricLegend(tokenSeries)}
        </article>
        ${deviceComparison}
      </div>
      <article class="card">
        <h2 data-i18n="metrics-hourly-table">Hourly details</h2>
        ${metricsTable(rows)}
      </article>
    </section>
  `, { openMode, activeTab: 'metrics' });
}

const CONVERSATION_RESPONSE_STATES = Object.freeze([
  'complete',
  'incomplete',
  'truncated',
  'unavailable',
]);

function conversationText(value) {
  return typeof value === 'string' ? value : '';
}

function conversationState(item) {
  const candidate = item?.responseState
    ?? item?.responseStatus
    ?? item?.response?.state
    ?? item?.response?.status;
  return CONVERSATION_RESPONSE_STATES.includes(candidate) ? candidate : 'unavailable';
}

function conversationDateText(value) {
  try {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      const date = new Date(numeric);
      if (Number.isFinite(date.getTime())) {
        return date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
      }
    }
    return dateText(value);
  } catch {
    return '—';
  }
}

function conversationCount(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
  return numeric;
}

function conversationStatusView(state) {
  const label = state.replaceAll('_', ' ');
  return `<span class="badge conversation-state" data-i18n="conversation-response-${escapeHtml(state)}">${escapeHtml(label)}</span>`;
}

function conversationPrivacyView(openMode) {
  return `<div class="notice error conversation-disclosure" role="alert">
    <h2 data-i18n="conversation-privacy-heading">Conversation privacy</h2>
    <p data-i18n="conversation-privacy-notice">This feature permanently stores every captured conversation and makes captured conversation text visible to everyone who can reach this console. Member labels are self-entered and unverified. Codex traffic is not covered.</p>
    ${openMode ? '<p data-i18n="conversation-open-warning"><strong>Open mode:</strong> anyone on the tailnet who can reach this console can read every captured conversation; there is no identity and no reading audit. A member label is not an actor identity.</p>' : ''}
  </div>`;
}

function conversationSearchHref({ q, beforeId, limit }) {
  const params = [];
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  if (beforeId !== null && beforeId !== undefined && String(beforeId) !== '') {
    params.push(`before_id=${encodeURIComponent(String(beforeId))}`);
  }
  params.push(`limit=${encodeURIComponent(String(limit))}`);
  return `/conversations?${params.join('&')}`;
}

function conversationSnippetView(labelI18n, label, value, emptyI18n) {
  const text = conversationText(value);
  return `<div class="conversation-snippet">
    <strong data-i18n="${escapeHtml(labelI18n)}">${escapeHtml(label)}</strong>
    ${text ? `<pre>${escapeHtml(text)}</pre>` : `<div class="empty tiny" data-i18n="${escapeHtml(emptyI18n)}">Not captured</div>`}
  </div>`;
}

function conversationItemView(item) {
  const id = item?.id === null || item?.id === undefined ? '' : String(item.id);
  const state = conversationState(item);
  const promptSnippet = item?.promptSnippet ?? item?.promptText;
  const responseSnippet = item?.responseSnippet ?? item?.responseText;
  const dropped = item?.conversationCaptureState === 'dropped'
    || item?.captureState === 'dropped'
    || item?.queueState === 'dropped';
  const detailLink = id
    ? `<a class="button secondary" href="/conversations/${escapeHtml(encodeURIComponent(id))}" data-i18n="conversation-open">Open conversation</a>`
    : '';
  return `<article class="conversation-card" data-conversation-id="${escapeHtml(id)}">
    <div class="conversation-card-head">
      <div>
        <h2>${id ? `#${escapeHtml(id)}` : '<span data-i18n="conversation-unknown-id">Conversation</span>'}</h2>
        <div class="conversation-meta">
          <span><span data-i18n="conversation-captured-at">Captured</span>: ${escapeHtml(conversationDateText(item?.startedAtMs))}</span>
          <span><span data-i18n="conversation-member-label">Member label</span>: ${escapeHtml(item?.memberLabel ?? '—')}</span>
          <span><span data-i18n="conversation-account">Account</span>: ${escapeHtml(item?.accountAlias ?? item?.accountId ?? '—')}</span>
          <span><span data-i18n="conversation-model">Model</span>: ${escapeHtml(item?.model ?? '—')}</span>
        </div>
      </div>
      ${conversationStatusView(state)}
    </div>
    ${dropped ? '<div class="notice error tiny conversation-queue-dropped" role="status" data-i18n="conversation-queue-dropped">Conversation capture was dropped by the bounded queue.</div>' : ''}
    <div class="conversation-snippets">
      ${conversationSnippetView('conversation-prompt', 'Prompt', promptSnippet, 'conversation-empty-prompt')}
      ${conversationSnippetView('conversation-response', 'Response', responseSnippet, 'conversation-empty-response')}
    </div>
    <div class="actions">${detailLink}</div>
  </article>`;
}

function conversationEnvelope({ result, searchResult, search, items, nextBeforeId, error }) {
  const source = result ?? searchResult ?? search ?? {};
  return {
    items: Array.isArray(items) ? items : (Array.isArray(source.items) ? source.items : []),
    nextBeforeId: nextBeforeId ?? source.nextBeforeId ?? null,
    error: error ?? source.error ?? null,
    dropped: source.droppedConversations ?? source.queueDropped ?? null,
  };
}

function conversationSearchErrorView(error) {
  const code = typeof error === 'string' ? error : error?.code;
  if (code === 'search_query_too_short') {
    return '<div class="notice error" role="alert" data-i18n="conversation-search-query-too-short">Search query is too short for this archive. For large archives, enter at least three consecutive Chinese characters or more searchable text; remove standalone punctuation and split the query into simpler terms.</div>';
  }
  if (code === 'search_query_requires_indexed_terms') {
    return '<div class="notice error" role="alert" data-i18n="conversation-search-requires-indexed-terms">Search needs indexed terms. For large archives, enter at least three consecutive Chinese characters, remove special punctuation, or split the query into simpler terms.</div>';
  }
  return '<div class="notice error" role="alert" data-i18n="conversation-search-error">Conversation search could not be completed.</div>';
}

export function conversationsView({
  result = null,
  searchResult = null,
  search = null,
  items = null,
  nextBeforeId = null,
  q = '',
  beforeId = '',
  limit = 20,
  openMode = false,
  error = null,
  droppedConversations = null,
  queueDropped = null,
  dropped = null,
  conversationDropped = null,
  conversationQueueDropped = null,
} = {}) {
  const envelope = conversationEnvelope({ result, searchResult, search, items, nextBeforeId, error });
  const query = typeof q === 'string' ? q : String(q ?? '');
  const normalizedLimit = Number.isSafeInteger(Number(limit))
    ? Math.max(1, Math.min(50, Number(limit)))
    : 20;
  const droppedCount = conversationCount(
    envelope.dropped
      ?? conversationQueueDropped
      ?? queueDropped
      ?? conversationDropped
      ?? droppedConversations
      ?? dropped,
  );
  const itemsView = envelope.items.map(conversationItemView).join('');
  const nextHref = envelope.nextBeforeId === null || envelope.nextBeforeId === undefined
    ? null
    : conversationSearchHref({ q: query, beforeId: envelope.nextBeforeId, limit: normalizedLimit });
  const errorNotice = envelope.error === null || envelope.error === undefined
    ? ''
    : conversationSearchErrorView(envelope.error);
  const droppedNotice = droppedCount > 0
    ? `<div class="notice error conversation-queue-dropped" role="alert"><span data-i18n="conversation-queue-dropped">Conversation capture was dropped by the bounded queue.</span> <strong>${escapeHtml(String(droppedCount))}</strong></div>`
    : '';
  return layout('Captured conversations', `
    <section class="stack">
      ${conversationPrivacyView(openMode)}
      ${errorNotice}
      ${droppedNotice}
      <div class="topbar">
        <div>
          <span class="badge stored" data-i18n="conversations-label">Captured conversations</span>
          <h1 data-i18n="conversations-heading">Conversation archive</h1>
          <p class="muted" data-i18n="conversations-intro">Search permanently retained Claude conversations captured from eligible turns.</p>
        </div>
        <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
      </div>
      <form method="get" action="/conversations" class="card conversation-filters">
        <label><span data-i18n="conversation-search">Search conversations</span>
          <input name="q" value="${escapeHtml(query)}" maxlength="256" autocomplete="off">
        </label>
        <input type="hidden" name="limit" value="${escapeHtml(String(normalizedLimit))}">
        <button type="submit" data-i18n="conversation-search-submit">Search</button>
        <a class="button secondary" href="/conversations" data-i18n="conversation-search-clear">Clear</a>
      </form>
      <div class="conversation-list">
        ${itemsView || '<p class="empty" data-i18n="conversation-no-results">No captured conversations match this search.</p>'}
      </div>
      ${nextHref ? `<div class="conversation-pagination"><a class="button secondary" href="${escapeHtml(nextHref)}" data-i18n="conversation-next-page">Next page</a></div>` : ''}
    </section>
  `, { openMode, activeTab: 'conversations' });
}

export function conversationDetailView({
  conversation = null,
  result = null,
  turn = null,
  id = null,
  error = null,
  openMode = false,
} = {}) {
  const envelope = result ?? {};
  const supplied = turn
    ?? (Object.hasOwn(envelope, 'turn') ? envelope.turn : null)
    ?? (conversation && Object.hasOwn(conversation, 'turn') ? conversation.turn : conversation);
  const record = supplied;
  const errorText = error ?? envelope.error ?? conversation?.error ?? null;
  const errorNotice = errorText
    ? `<div class="notice error" role="alert"><span data-i18n="conversation-read-error">Conversation could not be loaded.</span><br><span class="tiny">${escapeHtml(String(errorText))}</span></div>`
    : '';
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return layout('Conversation unavailable', `
      <section class="stack">
        ${conversationPrivacyView(openMode)}
        ${errorNotice || '<div class="notice error" role="alert" data-i18n="conversation-not-found">Conversation not found.</div>'}
        <a class="button secondary" href="/conversations" data-i18n="conversation-back">Back to conversations</a>
      </section>
    `, { openMode, activeTab: 'conversations' });
  }
  const conversationId = record.id ?? id ?? '—';
  const state = conversationState(record);
  const prompt = conversationText(record.promptText ?? record.prompt);
  const response = conversationText(record.responseText ?? record.response);
  return layout('Conversation', `
    <section class="stack">
      ${conversationPrivacyView(openMode)}
      ${errorNotice}
      <div class="topbar">
        <div>
          <span class="badge stored" data-i18n="conversations-label">Captured conversations</span>
          <h1><span data-i18n="conversation-detail-heading">Conversation</span> #${escapeHtml(String(conversationId))}</h1>
          <div class="conversation-meta">
            <span><span data-i18n="conversation-captured-at">Captured</span>: ${escapeHtml(conversationDateText(record.startedAtMs))}</span>
            <span><span data-i18n="conversation-member-label">Member label</span>: ${escapeHtml(record.memberLabel ?? '—')}</span>
            <span><span data-i18n="conversation-account">Account</span>: ${escapeHtml(record.accountAlias ?? record.accountId ?? '—')}</span>
            <span><span data-i18n="conversation-model">Model</span>: ${escapeHtml(record.model ?? '—')}</span>
          </div>
        </div>
        ${conversationStatusView(state)}
      </div>
      <article class="card conversation-text">
        <h2 data-i18n="conversation-prompt">Prompt</h2>
        ${prompt ? `<pre>${escapeHtml(prompt)}</pre>` : '<p class="empty" data-i18n="conversation-empty-prompt">Not captured</p>'}
      </article>
      <article class="card conversation-text">
        <h2 data-i18n="conversation-response">Response</h2>
        ${response ? `<pre>${escapeHtml(response)}</pre>` : '<p class="empty" data-i18n="conversation-empty-response">Not captured</p>'}
      </article>
      <a class="button secondary" href="/conversations" data-i18n="conversation-back">Back to conversations</a>
    </section>
  `, { openMode, activeTab: 'conversations' });
}

export function dashboardView({
  accounts,
  devices,
  machines = [],
  codexClients = [],
  codexUnavailable = [],
  csrf,
  adminIdentity = null,
  openMode = false,
  codexSelfServiceReady = false,
  onboardingUrl = null,
  error = null,
  credentialAlerts = null,
  now = Date.now(),
}) {
  const alerts = credentialAlerts ?? classifyCredentialAlerts(accounts, { now });
  const alertsById = new Map(alerts.accounts
    .filter((entry) => entry.accountId)
    .map((entry) => [entry.accountId, entry]));
  const activeDevices = devices.filter((device) => !device.revoked_at);
  const healthy = alerts.accounts.filter((account) => account.severity === 'ok').length;
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
    const alert = alertsById.get(account.id)
      ?? alerts.accounts.find((entry) => entry.alias === account.alias)
      ?? null;
    return `
    <tr>
      <td><strong>${escapeHtml(account.alias)}</strong><div class="muted tiny">${escapeHtml(account.email_label || 'No email label')}</div></td>
      <td>${escapeHtml(account.provider === 'claude' ? 'Claude Code' : 'Codex')}</td>
      <td><div class="account-status-stack">${statusBadge(account.status)}${alert ? credentialAlertBadge(alert) : ''}</div>
        ${alert ? `<div class="muted tiny" data-i18n="${credentialAlertLabelKey(alert.code)}">Credential status needs attention.</div>` : ''}</td>
      <td>${escapeHtml(account.active_devices ?? '—')}</td>
      <td>${expiryView(alert)}</td>
      <td class="account-history">${credentialCheckText(alert?.lastSuccessAt, 'last-successful-check')}${credentialCheckText(alert?.lastRotationAt, 'last-rotation')}</td>
      <td>${accountUsageView(account)}</td>
      <td>
        ${account.provider === 'claude' ? `<div class="stack">
          <a class="button secondary" href="/accounts/${encodeURIComponent(account.id)}/claude-authorization" data-i18n="owner-authorization">Owner authorization</a>
          ${available ? `<form method="post" action="/accounts/${encodeURIComponent(account.id)}/enrollments" class="inline">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input name="member_label" aria-label="Member label for ${escapeHtml(account.alias)}" placeholder="member email/name" required maxlength="160">
          <button type="submit" data-i18n="enroll-device">Enroll device</button>
        </form>` : '<span class="muted tiny" data-i18n="owner-login-required">Account owner must authorize before member enrollment.</span>'}
        </div>` : `<div class="stack">
          <a class="button secondary" href="/accounts/${encodeURIComponent(account.id)}/codex-authorization" data-i18n="codex-authorization">Codex authorization</a>
          ${account.external ? '<span class="muted tiny" data-i18n="existing-codex-agent">Existing Codex agent</span>' : ''}
        </div>`}
        ${account.status === 'login_required' && !account.external ? `<form method="post" action="/accounts/${encodeURIComponent(account.id)}/delete" class="inline">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button class="danger" type="submit" data-i18n="delete-account">Delete account</button>
        </form>` : ''}
      </td>
    </tr>
  `;
  }).join('');
  // Open mode has no verified identity, so the member types the label that keeps their
  // device names from colliding with somebody else's.
  const memberLabelField = openMode ? `<label><span data-i18n="member-label">Your label (self-asserted, not verified)</span>
                <input name="member_label" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="alex" maxlength="64">
              </label>` : '';
  const memberFormClass = openMode ? ' with-label' : '';
  const inventory = machineInventory({ machines, codexClients });
  // A machine can only be merged INTO one that already reported a handle, so the
  // options are exactly the non-legacy entries. Rendered once and shared by every
  // merge form on the page.
  const machineOptions = inventory.filter((entry) => entry.machine_id).map((entry) => (
    `<option value="${escapeHtml(entry.machine_id)}">${escapeHtml(entry.names.join(', ') || entry.machine_id)} · ${escapeHtml(entry.machine_id)}</option>`
  )).join('');
  const entryView = (entry) => machineEntryView(entry, { accounts, csrf, machineOptions });
  const liveMachines = inventory.filter((entry) => entry.active > 0 && !entry.legacy);
  // Kept in a group of their own rather than mixed in among machines: an issuance
  // nobody can attribute is not an inventory entry, and listing it as one would be
  // the quiet guess this whole view exists to avoid.
  const unattributed = inventory.filter((entry) => entry.active > 0 && entry.legacy);
  // Everything a machine ever held is kept, but one holding nothing live is history
  // rather than inventory, so it starts folded away.
  const retiredMachines = inventory.filter((entry) => entry.active === 0);

  return layout('Dashboard', `
    <div class="stack">
      ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
      ${credentialAlertSummaryView(accounts, alerts)}
      ${openMode || adminIdentity ? `<section class="member-zone">
        <div class="zone-heading">
          <div>
            <span class="zone-label" data-i18n="member-zone-label">Member self-service · This is exactly what every member sees</span>
            <h1 data-i18n="member-heading">Set up AI tools on this device</h1>
            <p class="muted" data-i18n="member-intro">Choose a team account and get a local setup. No administrator handoff and no shared provider login.</p>
          </div>
          <div class="identity-chip">${openMode
            ? '<span data-i18n="no-identity">No identity</span><br><strong data-i18n="anonymous-visitor">Anonymous visitor</strong>'
            : `<span data-i18n="tailscale-identity">Tailscale identity</span><br><strong>${escapeHtml(adminIdentity)}</strong>`}</div>
        </div>
        <div class="provider-grid">
          <article class="provider-card">
            <div class="provider-title"><h2>Claude Code</h2>${selfServiceAccounts.length ? statusBadge('healthy') : statusBadge('login_required')}</div>
            <p class="muted" data-i18n="claude-description">Get a public-internet configuration scoped to this member and device. The provider OAuth token never leaves the server.</p>
            ${selfServiceAccounts.length ? `<div class="quota-list">${claudeUsage}</div>` : ''}
            ${selfServiceAccounts.length ? `<form method="post" action="/self-service" class="member-form${memberFormClass}">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <label><span data-i18n="team-account">Team account</span>
                <select name="account_id" required>${selfServiceOptions}</select>
              </label>
              ${memberLabelField}
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
            ${primaryCodex && codexSelfServiceReady ? `<form method="post" action="/codex/self-service" class="member-form codex-form${memberFormClass}">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              ${memberLabelField}
              <label><span data-i18n="device-name">Device name</span>
                <input name="device_name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="my-laptop" maxlength="64">
              </label>
              <div><button type="submit" data-i18n="get-codex">Get Codex installer</button></div>
            </form>` : '<div class="notice" data-i18n="codex-unavailable">Codex self-service enrollment is not configured yet. An administrator must connect dispenser enrollment.</div>'}
          </article>
        </div>
        ${openMode ? '<p class="muted tiny" data-i18n="member-label-note">Nobody checks the label. It only keeps two members\' device names apart.</p>' : ''}
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
          <article class="card summary"><span class="muted" data-i18n="active-claude-credentials">Active Claude credentials</span><strong>${activeDevices.length}</strong></article>
          ${onboardingUrl ? `<article class="card">
            <h2 data-i18n="ai-onboarding-guide">AI onboarding guide</h2>
            <p class="muted" data-i18n="ai-onboarding-intro">This tailnet-internal Markdown is generated from current deployment state. It contains endpoints, account status, and the client config version, but never a token.</p>
            ${openMode ? '<div class="notice error tiny" role="alert" data-i18n="open-onboarding-warning">Open mode: anyone who can reach this console can read this live guide and its deployment/account metadata. Keep this console private; member labels are unverified and do not identify the actor.</div>' : ''}
            <pre id="onboarding-guide-link">${escapeHtml(onboardingUrl)}</pre>
            <div class="setup-actions">
              <button type="button" class="secondary" data-copy-target="onboarding-guide-link" data-i18n="copy-onboarding-link">Copy guide link</button>
              <a class="button secondary" href="${escapeHtml(onboardingUrl)}" target="_blank" rel="noopener noreferrer" data-i18n="open-onboarding-guide">Open guide</a>
            </div>
          </article>` : ''}
          <article class="card">
            <div class="topbar"><div><h2 data-i18n="accounts">Accounts</h2><div class="muted tiny" data-i18n="upstream-secret-note">Provider tokens are encrypted and never displayed after submission. Exceptional one-time enrollment remains available per account.</div></div></div>
            <div class="table-wrap">
              <table>
                <caption class="visually-hidden" data-i18n="accounts-table-caption">Credential accounts and safe health metadata</caption>
                <thead><tr><th scope="col" data-i18n="account">Account</th><th scope="col" data-i18n="provider">Provider</th><th scope="col" data-i18n="status">Status</th><th scope="col" data-i18n="devices">Devices</th><th scope="col" data-i18n="expires">Expires</th><th scope="col" data-i18n="last-successful-check">Last successful check</th><th scope="col" data-i18n="last-rotation">Last rotation</th><th scope="col" data-i18n="usage-quota">Usage quota</th><th scope="col" data-i18n="action">Action</th></tr></thead>
                <tbody>${accountRows || '<tr><td colspan="9" class="empty" data-i18n="no-accounts">No accounts yet.</td></tr>'}</tbody>
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
            <h2 data-i18n="add-codex-heading">Add a Codex team account</h2>
            <div class="notice"><span data-i18n="add-codex-help">Register the alias, then authorize the ChatGPT subscription from the account's own page. No separate codex login on another machine is needed.</span></div>
            <form method="post" action="/accounts" class="stack" autocomplete="off">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="provider" value="codex">
              <label><span data-i18n="account-alias">Account alias</span>
                <input name="alias" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" placeholder="codex-shared-1">
              </label>
              <label><span data-i18n="account-email-optional">Account email label (optional, checked at authorization)</span>
                <input name="email_label" type="email" placeholder="owner@example.com" maxlength="160">
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
            <div class="topbar"><div>
              <h2><span data-i18n="machines">Machines</span> (${liveMachines.length})</h2>
              <div class="muted tiny" data-i18n="machines-intro">One row per machine, with every credential it holds underneath. A machine is identified by an opaque random handle — reported by its own agent, or minted here for one issuance when the machine has no agent to report one. It says nothing about who is using it, and the member label beside it is self-asserted and unverified.</div>
            </div></div>
            ${openMode ? '<div class="notice error open-banner" role="status" data-i18n="open-account-switch-warning">Open mode has no verified actor: anyone who can reach this console can switch any active device. The actor is recorded as anonymous; a member label is not an actor.</div>' : ''}
            ${codexUnavailable.length ? `<div class="notice"><span data-i18n="codex-inventory-unavailable">Codex machines could not be read for at least one credential home, so any machine known only to the dispenser is missing from this list.</span><br><span class="tiny">${escapeHtml(codexUnavailable.map((entry) => entry.alias).join(', '))}</span></div>` : ''}
            <div class="machine-list">${liveMachines.map(entryView).join('')
              || '<p class="empty" data-i18n="no-machines">No machine holds a credential yet.</p>'}</div>
            ${unattributed.length ? `<section class="machine-group" data-unattributed-credentials="${unattributed.length}">
              <h3><span data-i18n="unattributed-credentials">Credentials not attributed to a machine</span> (${unattributed.length})</h3>
              <p class="muted tiny" data-i18n="unattributed-intro">Issued before machine handles existed, or through a path that reports none — a browser is not an agent and has none to give. Nothing is inferred from a matching name or member label; file one under a machine to have it counted there.</p>
              <div class="machine-list">${unattributed.map(entryView).join('')}</div>
            </section>` : ''}
            ${retiredMachines.length ? `<details class="machine-group" data-retired-machines="${retiredMachines.length}">
              <summary><span data-i18n="retired-machines">Machines with no active credential</span> (${retiredMachines.length})</summary>
              <div class="machine-list">${retiredMachines.map(entryView).join('')}</div>
            </details>` : ''}
          </article>
        </section>
      </section>
    </div>
  `, { openMode, activeTab: 'overview' });
}

export function claudeAuthorizationView({
  account,
  csrf,
  ownerPageUrl,
  authorization = null,
  error = null,
  openMode = false,
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
  `, { openMode });
}

export function codexAuthorizationView({
  account,
  csrf,
  ownerPageUrl,
  authorization = null,
  seedHome = null,
  error = null,
  openMode = false,
}) {
  return layout('Codex account authorization', `
    <section class="login">
      <div class="card stack">
        <div><span class="badge stored">Codex</span></div>
        <h1 data-i18n="codex-auth-heading">Codex account authorization</h1>
        <p><span data-i18n="team-account">Team account</span>: <strong>${escapeHtml(account.alias)}</strong>${account.email_label ? `<br><span data-i18n="owner-auth-account">Expected account</span>: <strong>${escapeHtml(account.email_label)}</strong>` : ''}</p>
        ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
        <div class="notice">${seedHome
          ? `<span data-i18n="codex-target-seed">On completion the credential is written straight into the Codex credential home below and is never shown.</span><br><span class="tiny">${escapeHtml(seedHome)}</span>`
          : '<span data-i18n="codex-target-manual">No Codex credential home is configured, so the resulting auth.json is shown once for you to copy or download. The console writes nothing.</span>'}</div>
        <div class="notice" data-i18n="codex-localhost-expected">Expect the final page to fail. OpenAI registers this client against http://localhost:1455 and sends the browser there, where nothing is listening. "Unable to connect" or "site can't be reached" is the successful outcome, not an error — the address bar then holds the authorization code.</div>
        <div class="notice" data-i18n="owner-page-permanent">This control-page URL is permanent. Open it whenever the account owner is ready; the temporary OAuth session is created only after Start authorization is pressed.</div>
        <pre id="owner-page-url">${escapeHtml(ownerPageUrl)}</pre>
        <button type="button" class="secondary" data-copy-target="owner-page-url" data-i18n="copy-owner-link">Copy owner page link</button>
        <form method="post" action="/accounts/${encodeURIComponent(account.id)}/codex-authorization/start">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button type="submit" data-i18n="start-authorization">Start a fresh authorization</button>
        </form>
        ${authorization ? `
          <div class="notice success">${authorization.url
            ? '<span data-i18n="temporary-session-ready">A fresh 15-minute authorization session is ready.</span>'
            : '<span data-i18n="session-still-open">This authorization session is still open, so the code you already have can be pasted again. Starting a fresh one would invalidate it.</span>'
          }<br><span class="tiny">${escapeHtml(dateText(authorization.expires_at))}</span></div>
          ${authorization.url ? `
          <ol class="stack">
            <li data-i18n="codex-auth-step-1">Open the OpenAI page below and sign in with the ChatGPT account that holds the Codex subscription.</li>
            <li data-i18n="codex-auth-step-2">Let the browser land on the localhost address that fails to load, then copy that whole address out of the address bar.</li>
            <li data-i18n="codex-auth-step-3">Paste it here and submit. The code alone also works. The server exchanges it directly with OpenAI.</li>
          </ol>
          <a class="button" href="${escapeHtml(authorization.url)}" target="_blank" rel="noopener noreferrer" data-i18n="open-codex-authorization">Open OpenAI authorization</a>
          ` : ''}
          <form method="post" action="/accounts/${encodeURIComponent(account.id)}/codex-authorization/complete" class="stack" autocomplete="off">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <label><span data-i18n="codex-redirect-label">Failed localhost address, or the code alone</span>
              <textarea name="authorization_code" required minlength="8" spellcheck="false" autocomplete="off" placeholder="http://localhost:1455/auth/callback?code=...&amp;state=..."></textarea>
            </label>
            <button type="submit" data-i18n="complete-authorization">Complete authorization</button>
          </form>
        ` : ''}
        <div class="notice" data-i18n="codex-auth-security">The authorization session is single-use, expires in 15 minutes, and is replaced when a new one starts. A pasted address is checked against the state this console issued; a bare code carries no state and relies on PKCE and there being exactly one live session. The PKCE verifier is encrypted at rest and the resulting credential is never written to state.json, the audit log, or a log line.</div>
        <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
      </div>
    </section>
  `, { openMode });
}

export function codexCredentialView({ account, authJson, error = null, openMode = false }) {
  const profile = account.alias.replace(/[^A-Za-z0-9._-]/g, '-');
  const filename = `codex-auth-${profile}.json`;
  const seedCommand = `sudo -u codex-refresh CODEX_CRED_HOME=/var/lib/codex-credential node /opt/claude-codex-gateway/codex-credential/refresh-center/seed.js ./${filename}`;
  return layout('Codex credential ready', `
    <section class="card stack">
      ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
      <div class="notice success"><span data-i18n="codex-account-authorized">This Codex account is authorized</span>: <strong>${escapeHtml(account.alias)}</strong></div>
      <h1 data-i18n="codex-copy-now">Copy or download this credential now</h1>
      <p class="muted" data-i18n="codex-one-time-json">This is the complete auth.json, including a live single-use refresh token. It is displayed once; the console stores no copy and this page cannot be reproduced. Keep it readable only by you and delete it once the credential centre has been seeded.</p>
      <pre id="codex-auth-json">${escapeHtml(authJson)}</pre>
      <div class="setup-actions">
        <button type="button" data-download-target="codex-auth-json" data-download-name="${escapeHtml(filename)}" data-i18n="download-auth-json">Download auth.json</button>
        <button type="button" class="secondary" data-copy-target="codex-auth-json" data-i18n="copy-auth-json">Copy auth.json</button>
      </div>
      <h3 data-i18n="codex-seed-command">Seed the credential centre with it</h3>
      <div class="run-command">${escapeHtml(seedCommand)}</div>
      <div class="notice" data-i18n="codex-seed-stale">Seeding is a handover, not a backup: the centre rotates the refresh token on its first run and this file dies at that moment. Delete it afterwards rather than keeping it.</div>
      <div class="notice" data-i18n="closing-hides-token">Closing or refreshing this page permanently hides the credential.</div>
      <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
    </section>
  `, { openMode });
}

export function enrollmentCreatedView({ account, memberLabel, link, openMode = false }) {
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
  `, { openMode });
}

export function enrollmentView({ account, memberLabel, code, error = null, openMode = false }) {
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
  `, { openMode });
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

function codexUnixInstaller({ assets, endpoint, certPin, token, clientConfigVersion }) {
  return `#!/usr/bin/env bash
set -euo pipefail

STAGE="$(mktemp -d "\${TMPDIR:-/tmp}/codex-gateway.XXXXXX")"
ROOT="$STAGE/client-agent"
STAMP_TMP=""
cleanup() {
  [ -z "$STAMP_TMP" ] || rm -f -- "$STAMP_TMP"
  rm -rf "$STAGE"
}
trap cleanup EXIT

write_asset() {
  local relative="$1"
  local payload="$2"
  mkdir -p "$(dirname "$ROOT/$relative")"
  node -e 'require("node:fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"))' \\
    "$ROOT/$relative" "$payload"
  # Assets land at the default mode, so anything install.sh execs has to be made
  # executable here. Keyed off the extension rather than a per-file chmod: the
  # per-file version silently stopped covering new scripts as they were added,
  # and the symptom was a machine that installed cleanly and never renewed.
  case "$relative" in
    *.sh) chmod 700 "$ROOT/$relative" ;;
  esac
}

write_asset pull.js ${shellSingleQuote(base64Asset(assets, 'pull.js'))}
write_asset package.json ${shellSingleQuote(base64Asset(assets, 'package.json'))}
write_asset lib/pinned-request.js ${shellSingleQuote(base64Asset(assets, 'lib/pinned-request.js'))}
write_asset install/install.sh ${shellSingleQuote(base64Asset(assets, 'install/install.sh'))}
write_asset install/systemd/codex-credential.service ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential.service'))}
write_asset install/systemd/codex-credential.timer ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential.timer'))}
write_asset install/launchd/com.claude-codex-gateway.codex-credential.plist ${shellSingleQuote(base64Asset(assets, 'install/launchd/com.claude-codex-gateway.codex-credential.plist'))}
write_asset install/start-container-loop.sh ${shellSingleQuote(base64Asset(assets, 'install/start-container-loop.sh'))}
write_asset install/diagnose.sh ${shellSingleQuote(base64Asset(assets, 'install/diagnose.sh'))}
chmod 700 "$ROOT/install/install.sh"

"$ROOT/install/install.sh" \\
  --endpoint ${shellSingleQuote(endpoint)} \\
  --token ${shellSingleQuote(token)} \\
  --cert-pin ${shellSingleQuote(certPin)}

# The original agent installer owns credential/env writes. Stamp only after it
# returns successfully, so a failed pull never claims the new client version.
STAMP_FILE="$HOME/${CODEX_UNIX_CLIENT_CONFIG_VERSION_FILE}"
install -d -m 700 "$(dirname "$STAMP_FILE")"
chmod 700 "$(dirname "$STAMP_FILE")"
STAMP_TMP="$(mktemp "$STAMP_FILE.tmp.XXXXXX")"
printf '%s\\n' ${shellSingleQuote(clientConfigVersion)} > "$STAMP_TMP"
chmod 600 "$STAMP_TMP"
mv -f -- "$STAMP_TMP" "$STAMP_FILE"
STAMP_TMP=""
`;
}

function codexWindowsInstaller({ assets, endpoint, certPin, token, clientConfigVersion }) {
  return `$ErrorActionPreference = 'Stop'
$Stage = Join-Path $env:TEMP ('codex-gateway-' + [guid]::NewGuid().ToString('N'))
$Root = Join-Path $Stage 'client-agent'
$StampTmp = $null
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
  $Stamp = Join-Path $env:LOCALAPPDATA ${powerShellSingleQuote(CODEX_WINDOWS_CLIENT_CONFIG_VERSION_FILE)}
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Stamp) | Out-Null
  $StampTmp = "$Stamp.$PID.tmp"
  [IO.File]::WriteAllText($StampTmp, ${powerShellSingleQuote(clientConfigVersion)} + "\`r\`n", [Text.UTF8Encoding]::new($false))
  Move-Item -Force $StampTmp $Stamp
  $StampTmp = $null
} finally {
  if ($StampTmp) { Remove-Item -Force $StampTmp -ErrorAction SilentlyContinue }
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
  clientConfigVersion = CLIENT_CONFIG_VERSION,
  openMode = false,
}) {
  const unixScript = codexUnixInstaller({
    assets,
    endpoint,
    certPin,
    token,
    clientConfigVersion,
  });
  const installers = [
    { platform: 'macos', label: 'macOS', script: unixScript, extension: 'sh' },
    { platform: 'linux', label: 'Linux', script: unixScript, extension: 'sh' },
    {
      platform: 'windows',
      label: 'Windows PowerShell',
      script: codexWindowsInstaller({
        assets,
        endpoint,
        certPin,
        token,
        clientConfigVersion,
      }),
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
  `, { openMode });
}

export function deviceConfiguredView({ account, device, token, claudeGatewayUrl, openMode = false }) {
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
export ${CLAUDE_CLIENT_CONFIG_VERSION_KEY}=${shellSingleQuote(CLIENT_CONFIG_VERSION)}
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
$env:${CLAUDE_CLIENT_CONFIG_VERSION_KEY}=${powerShellSingleQuote(CLIENT_CONFIG_VERSION)}
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
  `, { openMode });
}

export function messageView(title, message, {
  error = false,
  openMode = false,
  i18n = null,
  detail = null,
} = {}) {
  // The translated node has to be text-only: applyLanguage replaces its children.
  // Anything variable therefore goes in `detail`, outside it.
  return layout(title, `
    <section class="login">
      <div class="card stack">
        <div class="notice ${error ? 'error' : 'success'}">${i18n
          ? `<span data-i18n="${escapeHtml(i18n)}">${escapeHtml(message)}</span>`
          : escapeHtml(message)
        }${detail ? `<br><span class="tiny">${escapeHtml(detail)}</span>` : ''}</div>
        <a class="button secondary" href="/" data-i18n="continue">Continue</a>
      </div>
    </section>
  `, { openMode });
}
