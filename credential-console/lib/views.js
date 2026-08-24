import { APP_ASSET_URL } from './app-asset.js';
import { PAGE_CONTENT_END, PAGE_CONTENT_START, escapeHtml } from './http.js';
import { classifyCredentialAlerts } from './credential-alerts.js';
import { derivePromptDisplay } from './prompt-display.js';
import {
  buildClaudeConversationHookEndpoint,
  CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME,
  renderClaudeConversationHookUpdaterSource,
} from './claude-conversation-hooks.js';
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
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 22px;
  --space-6: 28px;
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 18px;
  --shadow-soft: 0 10px 26px rgba(22,33,29,.06);
  --focus: #d78226;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
html[data-language-pending] body {
  visibility: hidden;
  animation: language-failsafe 0s 1500ms forwards;
}
@keyframes language-failsafe { to { visibility: visible; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); line-height: 1.45; }
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
.card { min-width: 0; grid-column: span 12; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--shadow-soft); }
.summary { grid-column: span 4; }
.summary strong { display: block; font-size: 30px; margin-top: 8px; }
.split { grid-column: span 6; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
.table-wrap { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; }
th, td { text-align: left; padding: 13px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
tr:last-child td { border-bottom: 0; }
.badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; background: #e8eee9; color: var(--muted); }
.badge.healthy { background: #dff2e8; color: var(--green); }
.badge.unhealthy, .badge.expired { background: #f8e4e1; color: var(--red); }
.badge.stored { background: #e5edf4; color: var(--blue); }
.badge.login_required { background: #faecd7; color: var(--amber); }
.badge.pending { background: #faecd7; color: var(--amber); }
.badge.failed { background: #f8e4e1; color: var(--red); }
.badge.unavailable { background: #e8eee9; color: var(--muted); }
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
label { display: block; min-width: 0; font-weight: 700; font-size: 13px; margin-bottom: 12px; }
input, select, textarea { width: 100%; min-width: 0; max-width: 100%; margin-top: 6px; border: 1px solid #c7d0c7; background: white; border-radius: 10px; padding: 10px 12px; color: var(--ink); font: inherit; }
textarea { min-height: 112px; resize: vertical; }
button, .button { appearance: none; border: 0; border-radius: 10px; padding: 10px 14px; background: var(--green); color: white; font-weight: 750; cursor: pointer; text-decoration: none; display: inline-block; }
button:hover, .button:hover { background: var(--green-dark); }
button:disabled, select:disabled, input:disabled { cursor: not-allowed; opacity: .58; }
.button.secondary, button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
button.danger { background: var(--red); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.stack > .card { grid-column: auto; min-width: 0; }
.notice { min-width: 0; overflow-wrap: anywhere; border-left: 4px solid var(--amber); background: #fff7e9; padding: 12px 14px; border-radius: 0 10px 10px 0; }
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
.metrics-summary .summary strong { font-size: clamp(22px, 6vw, 30px); overflow-wrap: anywhere; }
.metrics-token-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metrics-token-summary .summary { grid-column: auto; }
.metrics-token-summary .summary strong { word-break: break-word; }
.metrics-token-known { display: block; margin-top: 6px; color: var(--muted); font-size: 12px; }
.metrics-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.metrics-chart { min-width: 0; border: 1px solid var(--line); border-radius: 14px; padding: 14px; background: #fbfcf9; }
.metrics-chart-wide { grid-column: 1 / -1; }
.metrics-chart h3 { margin: 0 0 10px; font-size: 16px; }
.metrics-chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.metrics-chart .metrics-grid-line { stroke: var(--line); stroke-width: 1; opacity: .9; }
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
.metrics-chart .metrics-point { stroke: white; stroke-width: 1.5; vector-effect: non-scaling-stroke; cursor: help; }
.metrics-chart .metrics-point:hover, .metrics-chart .metrics-point:focus { stroke: var(--ink); stroke-width: 2.5; }
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
.metrics-legend { display: flex; min-width: 0; gap: 12px; flex-wrap: wrap; margin-top: 8px; color: var(--muted); font-size: 12px; }
.metrics-legend-item { display: inline-flex; min-width: 0; max-width: 100%; gap: 6px; align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
.metrics-legend-item > span { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.metrics-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.metrics-empty { color: var(--muted); padding: 10px 0 0; }
.metrics-table th, .metrics-table td { font-size: 12px; padding: 9px 8px; }
.metrics-table-wrap { overflow-x: auto; }
.metrics-hourly-details > summary, .metrics-comparison-raw > summary { cursor: pointer; color: var(--green); font-weight: 800; padding: 8px 0; }
.metrics-hourly-details[open] > summary, .metrics-comparison-raw[open] > summary { margin-bottom: 8px; }
.metrics-attribution-notice { margin: 0; }
.metrics-attribution-notice p { margin: 0; }
.metrics-dashboard { gap: 18px; }
.metrics-page-hero { position: relative; overflow: hidden; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 26px; border: 1px solid #cfd9d1; border-radius: 22px; background: linear-gradient(135deg, #fdfefa 0%, #edf5ef 56%, #e7eff4 100%); box-shadow: var(--shadow-soft); }
.metrics-page-hero::after { content: ''; position: absolute; width: 260px; height: 260px; right: -110px; top: -150px; border-radius: 50%; background: rgba(0,114,178,.09); pointer-events: none; }
.metrics-page-hero > * { position: relative; z-index: 1; min-width: 0; }
.metrics-page-hero h1 { font-size: clamp(30px, 4vw, 46px); }
.metrics-page-hero p { max-width: 760px; margin: 8px 0 0; }
.metrics-eyebrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; color: var(--green); font-size: 12px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
.metrics-status-strip { display: flex; align-items: center; gap: 8px 18px; flex-wrap: wrap; padding: 11px 14px; border: 1px solid var(--line); border-radius: 13px; background: rgba(255,255,255,.78); color: var(--muted); font-size: 12px; }
.metrics-status-strip strong { color: var(--ink); }
.metrics-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 4px rgba(31,107,79,.1); }
.metrics-status-dot.partial { background: var(--amber); box-shadow: 0 0 0 4px rgba(154,93,22,.1); }
.metrics-token-coverage { margin: 0; padding: 10px 13px; }
.metrics-token-coverage p { margin: 0; }
.metrics-token-coverage p + p { margin-top: 4px; }
.metrics-filter-details { min-width: 0; }
.metrics-filter-details > summary { display: none; }
.metrics-filter-details .metrics-filters { border-radius: 16px; padding: 16px; box-shadow: none; }
.metrics-filters { grid-template-columns: repeat(5, minmax(0, 1fr)) auto; }
.metrics-filters .filter-actions { justify-content: flex-end; }
.metrics-filters .filter-actions > * { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
.metrics-kpi-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.metrics-kpi { position: relative; overflow: hidden; min-width: 0; border: 1px solid var(--line); border-radius: 16px; padding: 16px; background: var(--card); box-shadow: 0 8px 22px rgba(22,33,29,.045); }
.metrics-kpi::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--kpi-color, var(--green)); }
.metrics-kpi-primary { background: linear-gradient(145deg, #173c31 0%, #235e4b 100%); color: white; border-color: transparent; }
.metrics-kpi-primary .muted, .metrics-kpi-primary small { color: #cfe3da; }
.metrics-kpi > span { display: block; color: var(--muted); font-size: 12px; font-weight: 750; }
.metrics-kpi strong { display: block; margin: 7px 0 4px; font-size: clamp(22px, 2vw, 28px); line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.metrics-kpi small { display: block; color: var(--muted); font-size: 11px; }
.metrics-kpi-input { --kpi-color: #0072b2; }
.metrics-kpi-cache-create { --kpi-color: #e69f00; }
.metrics-kpi-cache-read { --kpi-color: #009e73; }
.metrics-kpi-output { --kpi-color: #cc79a7; }
.metrics-analytics-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
.metrics-chart-panel { min-width: 0; grid-column: span 6; border: 1px solid var(--line); border-radius: 18px; padding: 18px; background: var(--card); box-shadow: var(--shadow-soft); }
.metrics-chart-panel-wide { grid-column: 1 / -1; }
.metrics-chart-panel h2 { margin-bottom: 5px; font-size: 18px; }
.metrics-chart-panel h3 { margin: 0; font-size: 15px; }
.metrics-chart-copy { margin: 0 0 8px; color: var(--muted); font-size: 12px; }
.metrics-chart-heading { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 4px; }
.metrics-chart-host { width: 100%; height: clamp(260px, 28vw, 370px); min-height: 260px; }
.metrics-chart-host-compact { height: clamp(240px, 24vw, 320px); min-height: 240px; }
.metrics-chart-host[hidden] { display: none; }
.metrics-chart-panel.metrics-chart-empty .metrics-chart-host { height: 170px; min-height: 170px; }
.metrics-echarts-ready > .metrics-chart-fallback { display: none; }
.metrics-chart-fallback { min-width: 0; }
.metrics-chart-fallback svg { width: 100%; height: auto; display: block; overflow: visible; }
.metrics-chart-fallback summary { cursor: pointer; color: var(--green); font-size: 12px; font-weight: 800; }
.metrics-chart-fallback-list { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
.metrics-chart-fallback-list li { display: flex; justify-content: space-between; gap: 12px; padding: 9px 10px; border-radius: 9px; background: #f3f6f2; font-size: 12px; }
.metrics-chart-fallback-list span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.metrics-chart-fallback-list strong { flex: 0 0 auto; }
.metrics-device-section { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.metrics-device-section > .metrics-section-heading, .metrics-device-section > .metrics-device-notes, .metrics-device-section > .metrics-comparison-raw { grid-column: 1 / -1; }
.metrics-section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.metrics-section-heading h2 { margin-bottom: 5px; }
.metrics-section-heading p { margin: 0; max-width: 780px; }
.metrics-segmented { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: #f3f6f2; }
.metrics-segmented button { min-height: 36px; padding: 7px 11px; border-radius: 7px; background: transparent; color: var(--muted); font-size: 12px; }
.metrics-segmented button.active { background: var(--ink); color: white; }
.metrics-device-chips { display: flex; gap: 6px; overflow-x: auto; padding: 8px 0 2px; scrollbar-width: thin; }
.metrics-device-chip { flex: 0 0 auto; max-width: 220px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; background: #f5f7f3; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.metrics-device-notes { display: grid; gap: 8px; }
.metrics-device-notes .notice { margin: 0; }
.metrics-table-card { min-width: 0; border: 1px solid var(--line); border-radius: 18px; padding: 18px; background: var(--card); box-shadow: var(--shadow-soft); }
.metrics-table-card > summary { cursor: pointer; color: var(--green); font-weight: 850; }
.metrics-table-card[open] > summary { margin-bottom: 12px; }
.metrics-scroll-hint { display: none; margin: 8px 0; color: var(--muted); font-size: 11px; }
.metrics-table-wrap, .metrics-comparison-table-wrap { overscroll-behavior-inline: contain; -webkit-overflow-scrolling: touch; }
.metrics-privacy-details > summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 750; }
.metrics-privacy-details p { margin: 8px 0 0; }
@media (max-width: 1100px) {
  .metrics-kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .metrics-page-hero { align-items: flex-start; padding: 20px; }
  .metrics-page-hero, .metrics-section-heading { display: grid; }
  .metrics-page-hero .actions > * { flex: 1; text-align: center; }
  .metrics-chart-panel { grid-column: 1 / -1; padding: 15px; }
  .metrics-device-section { grid-template-columns: 1fr; }
  .metrics-device-section > * { grid-column: 1 / -1; }
}
@media (max-width: 640px) {
  .metrics-dashboard { gap: 14px; }
  .metrics-page-hero { padding: 17px; border-radius: 18px; }
  .metrics-page-hero h1 { font-size: 31px; }
  .metrics-page-hero .actions { display: grid; grid-template-columns: 1fr; width: 100%; }
  .metrics-filter-details > summary { display: block; cursor: pointer; padding: 12px 14px; border: 1px solid var(--line); border-radius: 13px; background: white; color: var(--green); font-weight: 850; }
  .metrics-filter-details[open] > summary { margin-bottom: 8px; }
  .metrics-filter-details .metrics-filters { padding: 13px; }
  .metrics-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .metrics-kpi { padding: 13px; border-radius: 14px; }
  .metrics-kpi-primary { grid-column: 1 / -1; }
  .metrics-kpi strong { font-size: 23px; }
  .metrics-chart-host, .metrics-chart-host-compact { height: 240px; min-height: 240px; }
  .metrics-chart-panel { padding: 13px; border-radius: 15px; }
  .metrics-chart-panel h2 { font-size: 16px; }
  .metrics-status-strip { gap: 8px 12px; }
  .metrics-scroll-hint { display: block; }
  .metrics-table-card { padding: 14px; border-radius: 15px; }
}
.account-switch-form { min-width: 190px; }
.account-switch-form[aria-busy="true"] { opacity: .72; }
.account-switch-status { min-height: 1.4em; color: var(--muted); overflow-wrap: anywhere; }
.account-switch-status.success { color: var(--green); }
.account-switch-status.error { color: var(--red); }
.account-selection-details { display: grid; gap: 3px; margin-top: 5px; }
.accounts-table { width: 100%; min-width: 1000px; table-layout: fixed; }
.accounts-table th:nth-child(1) { width: 16%; }
.accounts-table th:nth-child(2) { width: 13%; }
.accounts-table th:nth-child(3) { width: 13%; }
.accounts-table th:nth-child(4) { width: 18%; }
.accounts-table th:nth-child(5) { width: 20%; }
.accounts-table th:nth-child(6) { width: 20%; }
.accounts-table th:last-child, .accounts-table td:last-child { min-width: 240px; }
.accounts-table td:last-child input { min-width: 140px; }
.accounts-table td:last-child .button { white-space: normal; }
.page-tabs { position: sticky; top: 10px; z-index: 3; display: flex; gap: var(--space-2); flex-wrap: wrap; margin: -8px 0 24px; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgba(255,255,255,.94); box-shadow: 0 6px 18px rgba(22,33,29,.06); backdrop-filter: blur(8px); }
.page-tabs a { padding: 8px 12px; border-radius: 8px; color: var(--muted); font-size: 13px; font-weight: 750; text-decoration: none; }
.page-tabs a:hover, .page-tabs a[aria-current="page"] { background: var(--ink); color: white; }
.page-tabs a:focus-visible, button:focus-visible, a.button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
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
.conversation-subnav { display: inline-flex; width: fit-content; max-width: 100%; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: white; }
.conversation-subnav a { min-width: 0; padding: 8px 12px; border-radius: 8px; color: var(--muted); font-size: 13px; font-weight: 800; text-decoration: none; overflow-wrap: anywhere; }
.conversation-subnav a[aria-current="page"], .conversation-subnav a:hover { background: var(--ink); color: white; }
.conversation-layout { display: grid; grid-template-columns: minmax(220px, 260px) minmax(0, 1fr); gap: 22px; align-items: start; }
.conversation-filter-details { position: sticky; top: 72px; min-width: 0; }
.conversation-filter-details > summary { display: none; }
.conversation-rail { display: grid; gap: 14px; min-width: 0; }
.conversation-rail h2 { margin: 0; font-size: 17px; }
.conversation-filter-hint { margin: 0; }
.conversation-rail label { margin: 0; }
.conversation-rail .filter-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
/* Selects apply as soon as they change, so the button is only needed for the
   free-text field; Clear is a way out, not a peer of the primary action. */
.conversation-rail .filter-actions .button.secondary,
.conversation-rail .filter-actions a.button {
  background: none;
  border: 0;
  padding: 0 2px;
  color: var(--muted);
  text-decoration: underline;
  font-weight: 600;
  box-shadow: none;
}
/* Eight equally-weighted fields made a rail taller than the viewport. */
.conversation-rail label { display: grid; gap: 4px; }
.conversation-rail label > span { font-size: 12px; font-weight: 700; color: var(--muted); }
.conversation-rail { gap: 10px; }
.conversation-rows { display: inline-flex; align-items: center; gap: 6px; }
.conversation-rows select { padding: 2px 6px; font-size: 12px; }
/* Compact only where there is a pointer; a touch target keeps its size. */
@media (hover: hover) and (pointer: fine) {
  .conversation-rows select { min-height: 0; }
}
.conversation-rail .filter-actions > * { width: 100%; text-align: center; }
/* The results region while a filter is in flight. Without this the only
   feedback during a ~250 ms round trip was nothing at all: the full navigation
   this replaced at least moved the browser's own progress indicator. */
.conversation-results.is-loading { opacity: 0.55; pointer-events: none; }
/* Same idea for a whole-page navigation: without it a boosted click over a
   ~207 ms link looks like nothing happened, because the browser's own progress
   indicator no longer runs. */
[data-navigating] [data-page-content] { opacity: 0.55; pointer-events: none; }
@media (prefers-reduced-motion: no-preference) {
  [data-page-content] { transition: opacity 120ms ease-out; }
}
.conversation-results.is-loading * { cursor: progress; }
@media (prefers-reduced-motion: no-preference) {
  .conversation-results { transition: opacity 120ms ease-out; }
}
.conversation-results { display: grid; gap: 14px; min-width: 0; }
.conversation-results-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.conversation-results-head h1 { margin: 0; }
.conversation-result-summary { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
.conversation-chip-list { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.conversation-filter-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; border: 1px solid var(--line); border-radius: 999px; padding: 5px 9px; background: #eef3ee; color: var(--ink); font-size: 12px; overflow-wrap: anywhere; }
.conversation-filter-chip a { color: inherit; font-weight: 800; text-decoration: none; }
.conversation-list { display: grid; gap: 10px; }
.conversation-card, .conversation-result-row { border: 1px solid var(--line); border-radius: 14px; padding: 16px; background: #fbfcf9; }
.conversation-result-row { min-width: 0; box-shadow: 0 7px 18px rgba(22,33,29,.035); }
.conversation-session-row { border-left: 5px solid var(--green); }
.conversation-card h2, .conversation-result-row h2 { margin: 0; font-size: 17px; }
.conversation-card-head, .conversation-result-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.conversation-result-head { align-items: center; }
.conversation-result-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.conversation-meta, .conversation-result-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; color: var(--muted); font-size: 12px; }
.conversation-result-meta { margin-top: 4px; white-space: normal; }
.conversation-result-meta span { overflow-wrap: anywhere; }
.conversation-snippets, .conversation-result-snippets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.conversation-snippet, .conversation-result-snippet { min-width: 0; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: white; }
.conversation-snippet strong, .conversation-result-snippet strong { display: block; margin-bottom: 6px; font-size: 12px; color: var(--muted); }
.conversation-result-snippet p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin: 0; min-height: 2.7em; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.35; font-size: 13px; }
.conversation-prompt-meta { display: flex; gap: 6px 10px; flex-wrap: wrap; margin-top: 8px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.conversation-prompt-meta span { min-width: 0; overflow-wrap: anywhere; }
.conversation-snippet pre, .conversation-text pre { margin: 0; max-height: 260px; font-size: 12px; }
.conversation-text pre { max-height: none; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.conversation-pagination { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
.conversation-pagination form { margin: 0; }
.conversation-filters { display: grid; gap: 12px; align-items: end; }
.conversation-filters label { margin: 0; }
.conversation-state { flex: 0 0 auto; white-space: nowrap; }
.conversation-queue-dropped { margin: 0; }
.conversation-legacy-notice { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; }
.conversation-legacy-notice > div { min-width: 0; }
.conversation-legacy-notice p { margin: 3px 0 0; }
.conversation-legacy-notice .button { flex: 0 0 auto; }
.conversation-detail-shell { width: min(100%, 900px); margin: 0 auto; }
.conversation-detail-meta { display: flex; gap: 8px 14px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
.conversation-detail-meta span { min-width: 0; overflow-wrap: anywhere; }
.conversation-detail-shell .topbar > * { min-width: 0; }
.conversation-detail-shell .conversation-text { max-width: 900px; }
.conversation-session-detail-shell { width: min(100%, 980px); margin: 0 auto; }
.conversation-session-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.conversation-session-summary .summary { grid-column: auto; }
.conversation-session-summary .summary strong { font-size: 20px; overflow-wrap: anywhere; }
.conversation-round-state-counts { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 10px; color: var(--muted); }
.conversation-round-state-counts span { white-space: nowrap; }
.conversation-round-empty { border-style: dashed; background: #fbfcf9; }
.conversation-round-empty h2 { margin-bottom: 8px; }
.conversation-timeline { display: grid; gap: 16px; min-width: 0; }
.conversation-timeline-turn { min-width: 0; border: 1px solid var(--line); border-radius: 16px; padding: 16px; background: #fbfcf9; box-shadow: var(--shadow-soft); }
.conversation-timeline-turn-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.conversation-timeline-turn-head h2 { margin: 0; font-size: 16px; }
.conversation-turn-messages { display: grid; gap: 12px; min-width: 0; }
.conversation-message { width: min(92%, 820px); min-width: 0; border-radius: 14px; padding: 13px 15px; overflow-wrap: anywhere; }
.conversation-message-user { margin-left: auto; background: #e8f2ec; border: 1px solid #cadfd2; }
.conversation-message-assistant { margin-right: auto; background: white; border: 1px solid var(--line); }
.conversation-message h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
.conversation-message pre { margin: 0; padding: 13px; max-width: 100%; color: var(--ink); background: rgba(255,255,255,.78); border: 1px solid rgba(22,33,29,.1); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.conversation-message .conversation-prompt-disclaimer { margin: 0 0 8px; }
.conversation-session-state-note { margin: 8px 0 0; }
/* Wide data tables become cards on a phone.

   These tables are 6-9 columns and .accounts-table carries min-width: 1000px,
   so on a 390px screen the only previous option was dragging a 1000px table
   sideways. Each cell instead becomes a labelled row; the label text is stamped
   from the (already translated) header by app.js, so it follows the language
   switch instead of being frozen at render time. Without scripting the table
   keeps its original scrolling layout, which still works. */
@media (max-width: 720px) {
  .table-wrap table:has(td[data-label]), .metrics-table:has(td[data-label]) {
    min-width: 0;
    display: block;
    table-layout: auto;
  }
  .table-wrap table:has(td[data-label]) thead, .metrics-table:has(td[data-label]) thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .table-wrap table:has(td[data-label]) tbody, .metrics-table:has(td[data-label]) tbody { display: block; }
  .table-wrap table:has(td[data-label]) tr, .metrics-table:has(td[data-label]) tr {
    display: block;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: white;
    padding: 4px 14px;
    margin-bottom: 12px;
  }
  .table-wrap table:has(td[data-label]) td, .metrics-table:has(td[data-label]) td {
    display: grid;
    grid-template-columns: minmax(0, 40%) minmax(0, 1fr);
    gap: 12px;
    align-items: baseline;
    padding: 9px 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    width: auto;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .table-wrap table:has(td[data-label]) tr td:last-child, .metrics-table:has(td[data-label]) tr td:last-child { border-bottom: 0; }
  /* Only label a cell once app.js has supplied one, so a scripting-off page
     never shows an empty label column. */
  .table-wrap table:has(td[data-label]) td[data-label]::before, .metrics-table:has(td[data-label]) td[data-label]::before {
    content: attr(data-label);
    font-weight: 700;
    color: var(--muted);
    font-size: 12px;
  }
  .accounts-table td[data-label] { grid-template-columns: minmax(0, 40%) minmax(0, 1fr); }
  .table-wrap table:has(td[data-label]) td:not([data-label]), .metrics-table:has(td[data-label]) td:not([data-label]) {
    display: block;
  }
  /* A cell holding its own multi-column widget cannot survive being squeezed
     into 60% of a 390px card: the usage-quota cell rendered one character per
     line. Any cell with nested structure spans the card, not just the last. */
  .table-wrap table:has(td[data-label]) td:has(.quota-grid, .quota-window, form),
  .metrics-table:has(td[data-label]) td:has(.quota-grid, form) { display: block; }
  .table-wrap table:has(td[data-label]) td:has(.quota-grid, .quota-window, form)::before,
  .metrics-table:has(td[data-label]) td:has(.quota-grid, form)::before {
    display: block;
    margin-bottom: 6px;
  }
  /* The last cell holds the row's controls — a select, buttons, sometimes a
     whole form. At 60% of a 390px screen those get clipped, so it spans the
     card and its controls are held inside it. */
  .table-wrap table:has(td[data-label]) td:last-child, .metrics-table:has(td[data-label]) td:last-child { display: block; }
  .table-wrap table:has(td[data-label]) td:last-child::before, .metrics-table:has(td[data-label]) td:last-child::before {
    display: block;
    margin-bottom: 6px;
  }
  .table-wrap table:has(td[data-label]) td input, .table-wrap table:has(td[data-label]) td select, .table-wrap table:has(td[data-label]) td .button,
  .table-wrap table:has(td[data-label]) td button, .table-wrap table:has(td[data-label]) td form {
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
  .table-wrap table:has(td[data-label]) td:last-child input, .table-wrap table:has(td[data-label]) td:last-child select,
  .table-wrap table:has(td[data-label]) td:last-child button, .table-wrap table:has(td[data-label]) td:last-child .button {
    width: 100%;
  }
  .table-wrap table:has(td[data-label]) td.empty, .metrics-table:has(td[data-label]) td.empty { display: block; text-align: left; }
  /* Cards manage their own width, so the horizontal scroller is dead weight. */
  .table-wrap:has(td[data-label]) { overflow-x: visible; }
}

/* Desktop needs this too: the bar is ~49px there and still covers a section
   heading scrolled to by an anchor or by paging. */
:root { --sticky-nav-desktop: 70px; }
h1, h2, h3, [id], [tabindex], input, select, textarea, button, a.button, summary, label,
.conversation-results, [data-page-content] { scroll-margin-top: var(--sticky-nav-desktop); }

/* The sticky tab bar wraps to two lines on a phone (~110px) and then covers
   whatever you scroll to — measured, it hid the Model select and the Apply
   button on /metrics. Anything scrolled to keeps clear of it. */
@media (max-width: 800px) {
  /* The bar sticks at top: 10px and wraps to ~110px, so it occupies up to
     120px; the rest is breathing room rather than a flush fit. */
  :root { --sticky-nav: 132px; }
  /* On the elements themselves rather than their containers: the control that
     gets scrolled to is the one that must clear the bar, and enumerating
     containers missed the rows-per-page select sitting with the result count. */
  input, select, textarea, button, a.button, summary, label,
  h1, h2, h3, [id], [tabindex], .conversation-results, [data-page-content] {
    scroll-margin-top: var(--sticky-nav);
  }
}

@media (max-width: 800px) {
  .summary, .split { grid-column: span 12; }
  .topbar { align-items: flex-start; flex-wrap: wrap; }
  button, .button, input, select { min-height: 44px; }
  /* <summary> is a real control on touch; it was left at ~19px. */
  summary { min-height: 44px; display: flex; align-items: center; }
  /* Named explicitly because specificity, not cascade order, is the problem:
     a 0,1,1 rule outside this query beats the 0,0,1 rule inside it. */
  .metrics-segmented button, .metrics-segmented .button { min-height: 44px; }
  .page-tabs a, .language-switch button { min-height: 44px; display: inline-flex; align-items: center; }
  .table-wrap { overflow-x: auto; }
  .zone-heading { display: grid; }
  .identity-chip { white-space: normal; }
  .provider-grid, .member-form, .member-form.codex-form,
  .member-form.with-label, .member-form.codex-form.with-label,
  .merge-form, .metrics-filters, .metrics-chart-grid, .metrics-token-summary,
  .conversation-snippets, .conversation-result-snippets { grid-template-columns: 1fr; }
  .conversation-filters { grid-template-columns: 1fr; }
  .conversation-layout { grid-template-columns: 1fr; }
  .conversation-filter-details > summary { display: block; cursor: pointer; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: white; color: var(--green); font-weight: 800; }
  .conversation-filter-details[open] > summary { margin-bottom: 10px; }
  .conversation-filter-details { position: static; }
  .conversation-results-head { display: grid; }
  .conversation-result-actions { justify-content: flex-start; }
  .conversation-subnav { display: grid; width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .conversation-subnav a { text-align: center; }
  .conversation-legacy-notice { align-items: stretch; flex-direction: column; }
  .conversation-legacy-notice .button { width: 100%; text-align: center; }
  .conversation-session-summary { grid-template-columns: 1fr; }
  .conversation-message { width: 100%; }
  .conversation-timeline-turn { padding: 12px; }
  .metrics-chart-wide { grid-column: auto; }
}
`;

// Open mode has no login at all. Say so on every page instead of letting the console
// look like something is guarding it.
const openBanner = '<div class="notice error open-banner" role="status" data-i18n="open-banner">No authentication: anyone who can reach this console can issue and revoke credentials.</div>';

function layout(title, content, {
  openMode = false,
  activeTab = null,
  metricsAsset = null,
  completedDraft = null,
} = {}) {
  const metricsScript = metricsAsset?.url && metricsAsset?.integrity
    ? `<script src="${escapeHtml(metricsAsset.url)}" integrity="${escapeHtml(metricsAsset.integrity)}" crossorigin="anonymous" defer></script>`
    : '';
  return `<!doctype html>
<html lang="en" data-language-pending${completedDraft ? ` data-completed-draft="${escapeHtml(completedDraft)}"` : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} · Credential Console</title>
  <style>${styles}</style>
  <noscript><style>html[data-language-pending] body { visibility: visible; animation: none; }</style></noscript>
  <script src="${escapeHtml(APP_ASSET_URL)}" defer></script>
  ${metricsScript}
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
    <div data-page-content data-active-tab="${escapeHtml(activeTab ?? '')}">${PAGE_CONTENT_START}${openMode ? openBanner : ''}
    ${content}${PAGE_CONTENT_END}</div>
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
function accountCell(account, { selected = false } = {}) {
  const selectedAttribute = selected ? ' data-selected-account-cell' : '';
  if (!account) {
    return `<td data-account-status="unknown"${selectedAttribute}><strong class="muted" data-selected-account-alias data-i18n="unknown-account">Unknown account</strong></td>`;
  }
  return `<td data-account-status="${escapeHtml(account.status)}"${selectedAttribute}><strong data-selected-account-alias>${escapeHtml(account.alias)}</strong><div class="tiny" data-selected-account-status>${statusBadge(account.status)}</div></td>`;
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
  // Mirrors the store's rule (see #deviceAccountPolicy): an allowlist may hold
  // either provider, but not both. Judging validity by "is Claude" would paint
  // every Codex device as misconfigured and then offer, as the remedy, the one
  // action the store refuses.
  const gatewayProvider = new Map(
    accounts
      .filter((account) => ['claude', 'codex'].includes(account.provider))
      .map((account) => [account.id, account.provider]),
  );
  const allowedProviders = new Set(
    Array.isArray(allowedAccountIds)
      ? allowedAccountIds.map((id) => gatewayProvider.get(id))
      : [],
  );
  const allowedValid = Array.isArray(allowedAccountIds)
    && allowedAccountIds.length > 0
    && allowedAccountIds.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(allowedAccountIds).size === allowedAccountIds.length
    && allowedAccountIds.every((id) => gatewayProvider.has(id))
    && allowedProviders.size === 1
    && originalAccountId !== null
    && allowedAccountIds.includes(originalAccountId);
  const selectedValid = selectedAccountId !== null
    && allowedValid
    && allowedAccountIds.includes(selectedAccountId)
    && gatewayProvider.has(selectedAccountId);
  const originalValid = originalAccountId !== null && gatewayProvider.has(originalAccountId);
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

function accountSelectionOptions(accounts, selectedAccountId, provider = 'claude') {
  return accounts
    // Only same-provider accounts: the store refuses a cross-provider switch,
    // so offering one would present an action guaranteed to fail.
    .filter((account) => account.provider === provider)
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
    <div><span data-i18n="allowed-accounts">Allowed accounts</span>: <span data-allowed-account-list>${allowed}</span></div>
  </div>`;
}

function accountSwitchControl(device, selection, accounts, csrf) {
  if (device.revoked_at) return '';
  if (selection.invalid) {
    return '<div class="notice error tiny" data-i18n="account-selection-invalid">Account selection configuration is invalid; no account was guessed.</div>';
  }
  const deviceProvider = accountForId(accounts, selection.selectedAccountId ?? selection.originalAccountId)
    ?.provider ?? 'claude';
  const options = accountSelectionOptions(accounts, selection.selectedAccountId, deviceProvider);
  if (!options) {
    return '<div class="muted tiny" data-i18n="no-claude-accounts">No Claude accounts are registered.</div>';
  }
  return `<form method="post" action="/devices/${encodeURIComponent(device.id)}/account" class="stack account-switch-form" data-account-switch data-device-id="${escapeHtml(device.id)}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <label><span data-i18n="selected-account">Selected account</span>
      <select name="selected_account_id" required>${options}</select>
    </label>
    <button type="submit" data-i18n="switch-account">Switch account</button>
    <span class="tiny account-switch-status" data-account-switch-status role="status" aria-live="polite"></span>
  </form>`;
}

function claudeCredentialRow(device, accounts, csrf) {
  const state = device.revoked_at ? 'revoked' : 'active';
  const selection = accountSelectionForDevice(device, accounts);
  const selectedAccount = selection.invalid ? null : selection.selectedAccount;
  return `<tr data-credential-state="${state}" data-device-row="${escapeHtml(device.id)}" data-selected-account-id="${escapeHtml(selection.selectedAccountId ?? '')}">
    <td data-device-id="${escapeHtml(device.id)}"><strong>${escapeHtml(device.name)}</strong><div class="muted tiny">${escapeHtml(device.member_label || '—')}</div></td>
    <td>Claude Code</td>
    ${accountCell(selectedAccount, { selected: true })}
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
    ${revokedCount ? `<details data-revoked-credentials="${revokedCount}" data-persist-details="revoked-${escapeHtml(entry.key)}">
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
const MAX_METRIC_MARKERS = 16;
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

/** The same value abbreviated for a headline, keeping `—` for unknown. */
function metricTokenHeadline(value) {
  return value === null ? '—' : metricCompactNumber(value);
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

/**
 * A KPI headline that fits its card.
 *
 * The grouped integer does not: at 1440px each of six KPI cards has ~145px of
 * inner width, and a 7-digit figure needs ~158px. Five of the six token cards
 * were being clipped to `1,887,…`, which cannot be told apart from 1.8 million
 * or 1.8 billion — the page's headline number carried no information at all.
 * The charts on this same page already abbreviate; this matches them, and the
 * exact figure stays in the title attribute and the line beneath.
 */
function metricCompactNumber(value) {
  const numeric = finiteMetricNumber(value, { max: 9_000_000_000_000_000 });
  const abs = Math.abs(numeric);
  const scale = abs >= 1e12 ? [1e12, 'T']
    : abs >= 1e9 ? [1e9, 'B']
      : abs >= 1e6 ? [1e6, 'M']
        : abs >= 10_000 ? [1e3, 'K']
          : null;
  // Below 10,000 the exact number is both short enough and more useful.
  if (!scale) return Math.round(numeric).toLocaleString('en-US');
  const scaled = numeric / scale[0];
  return `${scaled.toLocaleString('en-US', {
    minimumFractionDigits: scaled < 100 ? 1 : 0,
    maximumFractionDigits: scaled < 100 ? 1 : 0,
  })}${scale[1]}`;
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

function metricPoints(rows, getter, maxValue, plot, className, {
  label = className,
  labelI18n = '',
  formatValue = metricDisplayNumber,
} = {}) {
  if (!rows.length) return '';
  const denominator = Math.max(rows.length - 1, 1);
  // Sample known values, not raw row positions. Otherwise a sparse singleton
  // between two sampled positions has only an SVG moveto and becomes invisible.
  const knownIndexes = rows
    .map((row, index) => {
      const value = getter(row);
      return value === null || value === undefined || value === '' ? null : index;
    })
    .filter((index) => index !== null);
  const indexes = knownIndexes.length <= MAX_METRIC_MARKERS
    ? knownIndexes
    : [...new Set(Array.from({ length: MAX_METRIC_MARKERS }, (_, marker) => (
      knownIndexes[Math.round((marker * (knownIndexes.length - 1)) / (MAX_METRIC_MARKERS - 1))]
    )))];
  return indexes.map((index) => {
    const row = rows[index];
    const rawValue = getter(row);
    if (rawValue === null || rawValue === undefined || rawValue === '') return '';
    const value = finiteMetricNumber(rawValue, { max: maxValue });
    const x = plot.left + (plot.width * index) / denominator;
    const y = plot.top + plot.height - (plot.height * value) / Math.max(maxValue, 1);
    const pointTail = `${metricHourLabel(row.hourBucketMs)} · ${formatValue(value)}`;
    const pointLabel = `${label} · ${pointTail}`;
    return `<circle class="metrics-point ${escapeHtml(className)}" cx="${metricSvgNumber(x)}" cy="${metricSvgNumber(y)}" r="3" aria-hidden="true"><title data-metric-point-title data-metric-series-key="${escapeHtml(labelI18n)}" data-metric-point-tail="${escapeHtml(pointTail)}">${escapeHtml(pointLabel)}</title></circle>`;
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
  const points = series.map((entry) => metricPoints(
    safeRows,
    entry.getter,
    scale,
    plot,
    entry.className,
    { label: entry.label, labelI18n: entry.i18n, formatValue },
  )).join('');
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

function metricsTable(rows, { wrapped = true } = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const tableRows = sourceRows.slice(-200);
  const truncated = sourceRows.length > tableRows.length;
  const body = tableRows.length
    ? tableRows.map((row) => `<tr>
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
  const contents = `${truncated ? '<p class="notice metrics-comparison-note" role="note" data-i18n="metrics-hourly-table-truncated">The hourly table shows the latest 200 rows; older rows are omitted.</p>' : ''}
    <div class="metrics-table-wrap">
      <table class="metrics-table">
        <caption class="muted tiny" data-i18n="metrics-hourly-table-caption">Hourly request and token details</caption>
        <thead><tr>
        <th scope="col" data-i18n="metrics-hour">Hour (UTC)</th>
        <th scope="col" data-i18n="metrics-request-count">Requests</th>
        <th scope="col" data-i18n="metrics-success-count">Successes</th>
        <th scope="col" data-i18n="metrics-error-count">Errors</th>
        <th scope="col" data-i18n="metrics-request-bytes">Request bytes</th>
        <th scope="col" data-i18n="metrics-response-bytes">Response bytes</th>
        <th scope="col" data-i18n="metrics-avg-ttfb">Avg TTFB (ms)</th>
        <th scope="col" data-i18n="metrics-avg-duration">Avg duration (ms)</th>
        <th scope="col" data-i18n="metrics-total-input-tokens">Input tokens</th>
        <th scope="col" data-i18n="metrics-total-cache-creation-input-tokens">Cache creation input tokens</th>
        <th scope="col" data-i18n="metrics-total-cache-read-input-tokens">Cache read input tokens</th>
        <th scope="col" data-i18n="metrics-total-output-tokens">Output tokens</th>
        <th scope="col" data-i18n="metrics-usage-coverage">Usage coverage</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  return wrapped
    ? `<details class="metrics-hourly-details"${truncated ? '' : ' open'}>
      <summary data-i18n="metrics-hourly-table-toggle">Show hourly details</summary>
      ${contents}
    </details>`
    : contents;
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
  if (!comparison.devices.length) {
    return `<section class="metrics-device-section metrics-device-section-empty">
      <div class="metrics-section-heading">
        <div><h2 data-i18n="metrics-device-comparison-heading">Device intelligence</h2>
        <p class="muted tiny" data-i18n="metrics-device-comparison-description">Compare known token volume and hourly trends across the busiest devices. Unknown values stay as gaps, never zero.</p></div>
      </div>
      <article class="metrics-chart-panel metrics-chart-panel-wide metrics-chart-empty">
        <p class="metrics-empty" data-i18n="metrics-device-comparison-no-data">No cross-device token comparison data is available.</p>
      </article>
    </section>`;
  }
  const comparisonTableSource = [...comparison.sourceRows]
    .sort((left, right) => Number(right.hourBucketMs ?? right.hour_bucket_ms) - Number(left.hourBucketMs ?? left.hour_bucket_ms))
    .slice(0, 200);
  const comparisonTableBounded = comparison.sourceRows.length > comparisonTableSource.length;
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
    comparisonTableSource.filter((row) => String(row?.deviceId ?? row?.device_id ?? row?.device ?? '') === device.value).map((row) => `<tr>
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
    comparisonTableBounded
      ? '<p class="notice metrics-comparison-note" role="note" data-i18n="metrics-device-comparison-table-truncated">The raw table shows the latest 200 rows; older rows are omitted.</p>'
      : '',
    comparison.unavailableDeviceCount > 0
      ? `<p class="notice metrics-comparison-note" role="note"><span data-i18n="metrics-device-comparison-unavailable-devices">Some devices were unavailable for comparison.</span> <strong>${escapeHtml(String(comparison.unavailableDeviceCount))}</strong></p>`
      : '',
    comparison.legacyTruncated
      ? '<p class="notice metrics-comparison-note" role="note" data-i18n="metrics-device-comparison-truncated">Comparison data is bounded; some devices or hours may be omitted.</p>'
      : '',
  ].join('');
  const chips = comparison.devices.map((device) => (
    `<span class="metrics-device-chip" title="${escapeHtml(device.label)}">${escapeHtml(device.label)}</span>`
  )).join('');
  return `<section class="metrics-device-section">
    <div class="metrics-section-heading">
      <div>
        <h2 data-i18n="metrics-device-comparison-heading">Device intelligence</h2>
        <p class="muted tiny" data-i18n="metrics-device-comparison-description">Compare known token volume and hourly trends across the busiest devices. Unknown values stay as gaps, never zero.</p>
        <p class="muted tiny" data-i18n="metrics-device-comparison-scope">This comparison follows the member, account, model, and time filters; it intentionally ignores the single-device machine selector.</p>
      </div>
      <div class="metrics-device-chips" aria-label="Compared devices">${chips}</div>
    </div>
    <article class="metrics-chart-panel metrics-chart-panel-compact">
      <h3 data-i18n="metrics-device-ranking-heading">Known tokens by device</h3>
      <p class="metrics-chart-copy" data-i18n="metrics-device-ranking-description">Input-side known tokens and output tokens for this period.</p>
      <div class="metrics-chart-host metrics-chart-host-compact" data-metrics-chart="device-ranking" hidden></div>
      <div class="metrics-chart-fallback">
        <div class="metrics-legend">${legend || '<span class="metrics-empty" data-i18n="metrics-device-comparison-no-data">No cross-device token comparison data is available.</span>'}</div>
      </div>
    </article>
    <article class="metrics-chart-panel metrics-chart-panel-compact">
      <div class="metrics-chart-heading">
        <div>
          <h3 data-i18n="metrics-device-trend-heading">Hourly device trend</h3>
          <p class="metrics-chart-copy" data-i18n="metrics-device-trend-description">Toggle between complete input-side known tokens and output tokens.</p>
        </div>
        <div class="metrics-segmented" aria-label="Device token metric">
          <button type="button" class="active" data-device-metric="input" aria-pressed="true" data-i18n="metrics-device-toggle-input">Input side</button>
          <button type="button" data-device-metric="output" aria-pressed="false" data-i18n="metrics-device-toggle-output">Output</button>
        </div>
      </div>
      <div class="metrics-chart-host metrics-chart-host-compact" data-metrics-chart="device-trend" hidden></div>
      <details class="metrics-chart-fallback" data-persist-details="device-static-fallback">
        <summary data-i18n="metrics-static-fallback-toggle">Show static chart fallback</summary>
        <h3 data-i18n="metrics-device-input-comparison-heading">Hourly input-side known tokens by device</h3>
        ${inputChart}
        <h3 data-i18n="metrics-device-output-comparison-heading">Hourly output tokens by device</h3>
        ${outputChart}
      </details>
    </article>
    <div class="metrics-device-notes">${truncatedNotice}</div>
    <details class="metrics-comparison-raw metrics-table-card" data-persist-details="device-raw-table">
      <summary data-i18n="metrics-device-comparison-table-toggle">Show raw comparison table</summary>
      <p class="metrics-scroll-hint" data-i18n="metrics-scroll-table-hint">Swipe horizontally to inspect every column.</p>
      <div class="metrics-comparison-table-wrap"><table class="metrics-table metrics-comparison-table">
        <caption class="muted tiny" data-i18n="metrics-device-comparison-table-caption">Raw four-category values and coverage fallback</caption>
        <thead><tr><th scope="col" data-i18n="metrics-hour">Hour (UTC)</th><th scope="col" data-i18n="metrics-device-comparison-device">Device</th><th scope="col" data-i18n="metrics-total-input-tokens">Input tokens</th><th scope="col" data-i18n="metrics-total-cache-creation-input-tokens">Cache creation input tokens</th><th scope="col" data-i18n="metrics-total-cache-read-input-tokens">Cache read input tokens</th><th scope="col" data-i18n="metrics-total-output-tokens">Output tokens</th><th scope="col" data-i18n="metrics-device-comparison-coverage">Coverage</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="7" class="empty" data-i18n="metrics-device-comparison-no-data">No cross-device token comparison data is available.</td></tr>'}</tbody>
      </table></div>
    </details>
  </section>`;
}

function metricKnownTokenTotal(totals) {
  if (totals?.tokenTotalsOverflow === true) return null;
  const values = [
    totals?.totalInputTokens,
    totals?.totalCacheCreationInputTokens,
    totals?.totalCacheReadInputTokens,
    totals?.totalOutputTokens,
  ].map(metricTokenNumber).filter((value) => value !== null);
  if (!values.length) return null;
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

function metricsBreakdownFallback(rows, emptyKey, emptyText) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => ({
    label: String(row?.label ?? row?.groupValue ?? '—'),
    value: metricKnownTokenTotal(row),
  })).filter((row) => row.value !== null)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 8);
  if (!normalized.length) {
    return `<p class="metrics-empty" data-i18n="${escapeHtml(emptyKey)}">${escapeHtml(emptyText)}</p>`;
  }
  return `<ol class="metrics-chart-fallback-list">${normalized.map((row) => `<li>
    <span title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span>
    <strong>${escapeHtml(metricDisplayNumber(row.value))}</strong>
  </li>`).join('')}</ol>`;
}

function metricsChartPanel({
  kind,
  title,
  titleI18n,
  description,
  descriptionI18n,
  fallback,
  wide = false,
  compact = false,
}) {
  return `<article class="metrics-chart-panel${wide ? ' metrics-chart-panel-wide' : ''}">
    <h2 data-i18n="${escapeHtml(titleI18n)}">${escapeHtml(title)}</h2>
    <p class="metrics-chart-copy" data-i18n="${escapeHtml(descriptionI18n)}">${escapeHtml(description)}</p>
    <div class="metrics-chart-host${compact ? ' metrics-chart-host-compact' : ''}" data-metrics-chart="${escapeHtml(kind)}" hidden></div>
    <div class="metrics-chart-fallback">${fallback}</div>
  </article>`;
}

export function metricsView({
  range = {},
  filters = {},
  options = {},
  totals = {},
  hourly = [],
  tokenTotals = {},
  tokenHourly = [],
  deviceTokenComparison = {},
  accountTokenBreakdown = [],
  modelTokenBreakdown = [],
  openMode = false,
  metricsAvailable = true,
  droppedMetrics = 0,
  error = null,
  metricsAsset = null,
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
  const knownTokenTotal = metricKnownTokenTotal(normalizedTokenTotals);
  const coverageCount = normalizedTokenTotals.usageCompleteCount
    + normalizedTokenTotals.usagePartialCount
    + normalizedTokenTotals.usageUnavailableCount;
  const coveragePercent = coverageCount > 0
    ? Math.round((normalizedTokenTotals.usageCompleteCount / coverageCount) * 1000) / 10
    : null;
  const coveragePartial = normalizedTokenTotals.usagePartialCount > 0
    || normalizedTokenTotals.usageUnavailableCount > 0
    || normalizedTokenTotals.tokenTotalsOverflow;
  const chartParams = new URLSearchParams();
  chartParams.set('hours', String(hours));
  const effectiveMachine = unattributedMachine ? UNATTRIBUTED_MACHINE_VALUE : selectedMachine;
  if (effectiveMachine) chartParams.set('machine_id', effectiveMachine);
  if (selectedMember) chartParams.set('member_label', selectedMember);
  if (selectedAccount) chartParams.set('account_id', selectedAccount);
  if (selectedModel) chartParams.set('model', selectedModel);
  const metricsEndpoint = `/metrics/chart-data?${chartParams.toString()}`;
  const rangeLabel = METRICS_HOUR_OPTIONS.find((option) => option.value === hours)?.label ?? `${hours} hours`;
  const accountFallback = metricsBreakdownFallback(
    accountTokenBreakdown,
    'metrics-breakdown-no-data',
    'No account token totals are available.',
  );
  const modelFallback = metricsBreakdownFallback(
    modelTokenBreakdown,
    'metrics-breakdown-no-data',
    'No model token totals are available.',
  );
  const accountBreakdownAvailable = accountTokenBreakdown.some((row) => metricKnownTokenTotal(row) !== null);
  const modelBreakdownAvailable = modelTokenBreakdown.some((row) => metricKnownTokenTotal(row) !== null);
  const breakdownPanels = [
    accountBreakdownAvailable ? metricsChartPanel({
      kind: 'accounts',
      title: 'Usage by account',
      titleI18n: 'metrics-account-breakdown-heading',
      description: 'Top accounts ranked by known token total.',
      descriptionI18n: 'metrics-account-breakdown-description',
      fallback: accountFallback,
      compact: true,
    }) : '',
    modelBreakdownAvailable ? metricsChartPanel({
      kind: 'models',
      title: 'Usage by model',
      titleI18n: 'metrics-model-breakdown-heading',
      description: 'Top models ranked by known token total.',
      descriptionI18n: 'metrics-model-breakdown-description',
      fallback: modelFallback,
      compact: true,
    }) : '',
  ].join('');
  return layout('Token usage', `
    <section class="stack metrics-dashboard" data-metrics-dashboard data-metrics-endpoint="${escapeHtml(metricsEndpoint)}">
      ${availabilityNotice}
      ${droppedNotice}
      ${errorNotice}
      <header class="metrics-page-hero">
        <div>
          <div class="metrics-eyebrow"><span class="metrics-status-dot${coveragePartial ? ' partial' : ''}" aria-hidden="true"></span><span data-i18n="metrics-label">Usage intelligence</span></div>
          <h1 data-i18n="metrics-heading">Token usage</h1>
          <p class="muted" data-i18n="metrics-intro">Explore hourly Claude gateway token consumption, request health, and device trends with exact unknown-value handling.</p>
        </div>
        <div class="actions">
          <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
          <a class="button secondary" href="/conversations" data-i18n="metrics-conversations-link">View conversations</a>
        </div>
      </header>
      <div class="metrics-status-strip" role="status">
        <span><strong>${escapeHtml(rangeLabel)}</strong> · UTC</span>
        <span><span data-i18n="metrics-total-requests">All requests</span>: <strong>${escapeHtml(metricDisplayNumber(allTotal))}</strong></span>
        <span><span data-i18n="metrics-consumption-requests">Consumption requests</span>: <strong>${escapeHtml(metricDisplayNumber(consumptionTotal))}</strong></span>
        <span><span data-i18n="metrics-status-coverage">Complete coverage</span>: <strong>${coveragePercent === null ? '—' : `${escapeHtml(metricDisplayNumber(coveragePercent, { decimals: 1 }))}%`}</strong></span>
        <span data-i18n="metrics-unknown-zero">— means unknown, never zero</span>
      </div>
      <details class="metrics-filter-details" data-persist-details="filters" open>
        <summary data-i18n="metrics-filter-toggle">Filters</summary>
        <form method="get" action="/metrics" class="card metrics-filters" data-reset-scroll>
          <h2 class="metrics-filter-heading" data-i18n="metrics-filter-heading">Filter usage</h2>
          <label><span data-i18n="metrics-filter-hours">Period</span>
            <select name="hours">${hourOptions}</select>
          </label>
          <label><span data-i18n="metrics-filter-machine">Machine</span>
            <select name="machine_id">${metricMachineOptions(options.machines, selectedMachine, unattributedMachine)}</select>
          </label>
          <label><span data-i18n="metrics-filter-member">Member label</span>
            <select name="member_label">${metricOptions(options.members, selectedMember, 'All members', 'metrics-all-members')}</select>
          </label>
          <label><span data-i18n="metrics-filter-account">Account</span>
            <select name="account_id" data-autoapply>${metricOptions(options.accounts, selectedAccount, 'All accounts', 'metrics-all-accounts')}</select>
          </label>
          <label><span data-i18n="metrics-filter-model">Model</span>
            <select name="model" data-autoapply>${metricOptions(options.models, selectedModel, 'All models', 'metrics-all-models')}</select>
          </label>
          <div class="filter-actions">
            <button type="submit" data-i18n="metrics-apply-filters">Apply</button>
            <a class="button secondary" href="/metrics" data-i18n="metrics-reset-filters">Reset</a>
          </div>
        </form>
      </details>
      <div class="metrics-kpi-grid">
        <article class="metrics-kpi metrics-kpi-primary">
          <span data-i18n="metrics-known-total">Known token total</span>
          <strong title="${escapeHtml(metricTokenText(knownTokenTotal))}">${escapeHtml(metricTokenHeadline(knownTokenTotal))}</strong>
          <small data-i18n="${coveragePartial ? 'metrics-known-total-lower-bound' : 'metrics-known-total-exact'}">${coveragePartial ? 'Lower bound for the selected period' : 'Exact across complete reported categories'}</small>
        </article>
        <article class="metrics-kpi metrics-kpi-input"><span data-i18n="metrics-token-input">Input tokens</span>
          <strong title="${escapeHtml(metricTokenText(normalizedTokenTotals.totalInputTokens))}">${escapeHtml(metricTokenHeadline(normalizedTokenTotals.totalInputTokens))}</strong>
          <small><span data-i18n="metrics-token-known-count">Known values</span>: ${escapeHtml(metricDisplayNumber(normalizedTokenTotals.totalInputTokensKnownCount))}</small>
        </article>
        <article class="metrics-kpi metrics-kpi-output"><span data-i18n="metrics-token-output">Output tokens</span>
          <strong title="${escapeHtml(metricTokenText(normalizedTokenTotals.totalOutputTokens))}">${escapeHtml(metricTokenHeadline(normalizedTokenTotals.totalOutputTokens))}</strong>
          <small><span data-i18n="metrics-token-known-count">Known values</span>: ${escapeHtml(metricDisplayNumber(normalizedTokenTotals.totalOutputTokensKnownCount))}</small>
        </article>
        <article class="metrics-kpi metrics-kpi-cache-read"><span data-i18n="metrics-token-cache-read">Cache read input tokens</span>
          <strong title="${escapeHtml(metricTokenText(normalizedTokenTotals.totalCacheReadInputTokens))}">${escapeHtml(metricTokenHeadline(normalizedTokenTotals.totalCacheReadInputTokens))}</strong>
          <small><span data-i18n="metrics-token-known-count">Known values</span>: ${escapeHtml(metricDisplayNumber(normalizedTokenTotals.totalCacheReadInputTokensKnownCount))}</small>
        </article>
        <article class="metrics-kpi metrics-kpi-cache-create"><span data-i18n="metrics-token-cache-creation">Cache creation input tokens</span>
          <strong title="${escapeHtml(metricTokenText(normalizedTokenTotals.totalCacheCreationInputTokens))}">${escapeHtml(metricTokenHeadline(normalizedTokenTotals.totalCacheCreationInputTokens))}</strong>
          <small><span data-i18n="metrics-token-known-count">Known values</span>: ${escapeHtml(metricDisplayNumber(normalizedTokenTotals.totalCacheCreationInputTokensKnownCount))}</small>
        </article>
        <article class="metrics-kpi"><span data-i18n="metrics-consumption-requests">Consumption requests</span>
          <strong title="${escapeHtml(metricDisplayNumber(consumptionTotal))}">${escapeHtml(metricCompactNumber(consumptionTotal))}</strong>
          <small><span data-i18n="metrics-request-outcomes">Successful / errors</span>: ${escapeHtml(metricDisplayNumber(metricCount(totals.success)))} / ${escapeHtml(metricDisplayNumber(metricCount(totals.errors)))}</small>
        </article>
      </div>
      ${tokenCoverageNotice(normalizedTokenTotals)}
      <div class="metrics-analytics-grid">
        ${metricsChartPanel({
          kind: 'tokens',
          title: 'Hourly token composition',
          titleI18n: 'metrics-token-trend',
          description: 'Stacked known token categories on a real UTC time axis; gaps stay unknown.',
          descriptionI18n: 'metrics-token-trend-description',
          fallback: `${tokenChart}${metricLegend(tokenSeries)}`,
          wide: true,
        })}
        ${metricsChartPanel({
          kind: 'requests',
          title: 'Request health',
          titleI18n: 'metrics-request-volume',
          description: 'Hourly total, successful, and error requests.',
          descriptionI18n: 'metrics-request-volume-description',
          fallback: `${requestChart}${metricLegend(requestSeries)}`,
          compact: true,
        })}
        ${metricsChartPanel({
          kind: 'latency',
          title: 'Latency',
          titleI18n: 'metrics-latency',
          description: 'Average time to first byte and total duration.',
          descriptionI18n: 'metrics-latency-description',
          fallback: `${latencyChart}${metricLegend(latencySeries)}`,
          compact: true,
        })}
        ${breakdownPanels}
        ${deviceComparison}
      </div>
      <details class="metrics-table-card metrics-hourly-details" data-persist-details="hourly-table">
        <summary data-i18n="metrics-hourly-table-toggle">Show hourly details</summary>
        <p class="metrics-scroll-hint" data-i18n="metrics-scroll-table-hint">Swipe horizontally to inspect every column.</p>
        ${metricsTable(rows, { wrapped: false })}
      </details>
      <details class="metrics-privacy-details" data-persist-details="methodology">
        <summary data-i18n="metrics-methodology-toggle">Scope, privacy, and attribution</summary>
        <p class="muted tiny" data-i18n="metrics-claude-only">Token accounting covers Claude gateway traffic only. Codex clients connect directly to their provider and are not included.</p>
        <p class="muted tiny" data-i18n="metrics-intro-long">This page renders request metadata only. Request and response bodies are not shown here; eligible captured API turns appear under Conversations.</p>
        <p class="muted tiny" data-i18n="metrics-attribution-disclaimer">Member labels are self-entered and unverified. Use them only to observe usage trends; never use them for accountability or billing.</p>
      </details>
    </section>
  `, { openMode, activeTab: 'metrics', metricsAsset });
}

const API_FRAGMENT_RESPONSE_STATES = Object.freeze([
  'complete',
  'incomplete',
  'truncated',
  'unavailable',
]);
const CONVERSATION_RESPONSE_STATES = Object.freeze([
  'pending',
  'complete',
  'failed',
  'unavailable',
]);
const ALL_CONVERSATION_RESPONSE_STATES = new Set([
  ...API_FRAGMENT_RESPONSE_STATES,
  ...CONVERSATION_RESPONSE_STATES,
]);
const CONVERSATION_PERIOD_OPTIONS = Object.freeze([
  { value: 'all', label: 'All time', i18n: 'conversation-period-all' },
  { value: '24', label: 'Last 24 hours', i18n: 'conversation-period-24' },
  { value: '168', label: 'Last 7 days', i18n: 'conversation-period-168' },
  { value: '720', label: 'Last 30 days', i18n: 'conversation-period-720' },
]);
const CONVERSATION_LIMIT_OPTIONS = Object.freeze([25, 50]);
const MAX_CONVERSATION_FACETS = 100;
const MAX_CONVERSATION_SNIPPET_CHARS = 600;
const MAX_CONVERSATION_TIMELINE_TEXT_CHARS = 16 * 1024;

function conversationText(value) {
  return typeof value === 'string' ? value : '';
}

function conversationState(item) {
  const candidate = item?.responseState
    ?? item?.responseStatus
    ?? item?.response?.state
    ?? item?.response?.status;
  return ALL_CONVERSATION_RESPONSE_STATES.has(candidate) ? candidate : 'unavailable';
}

function conversationDateText(value) {
  try {
    if (value === null || value === undefined || value === '') return '—';
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
  return `<span class="badge conversation-state ${escapeHtml(state)}" data-i18n="conversation-response-${escapeHtml(state)}">${escapeHtml(label)}</span>`;
}

const CONVERSATION_FAILURE_LABELS = Object.freeze({
  rate_limit: 'Rate limited',
  overloaded: 'Provider overloaded',
  authentication_failed: 'Authentication failed',
  oauth_org_not_allowed: 'Organization not allowed',
  billing_error: 'Billing error',
  invalid_request: 'Invalid request',
  model_not_found: 'Model not found',
  server_error: 'Provider server error',
  max_output_tokens: 'Maximum output reached',
  session_end: 'Session ended before final response',
  unavailable: 'Response unavailable',
  unknown: 'Unknown failure',
});

function conversationFailureView(value) {
  const code = Object.hasOwn(CONVERSATION_FAILURE_LABELS, value) ? value : 'unknown';
  return `<span class="tiny" data-i18n="conversation-failure-${code.replaceAll('_', '-')}">${CONVERSATION_FAILURE_LABELS[code]}</span>`;
}

function conversationPrivacyView(openMode, { reliable = false } = {}) {
  const heading = reliable
    ? '<h2 data-i18n="conversation-round-privacy-heading">Reliable conversation privacy</h2>'
    : '<h2 data-i18n="conversation-privacy-heading">Captured API fragment privacy</h2>';
  const notice = reliable
    ? '<p data-i18n="conversation-round-privacy-notice">Hook-enabled Claude Code profiles permanently store the exact Claude user-submitted prompt and final visible assistant response in this console. Every console member can read it. Hooks do not deny or terminate Claude, but a failed synchronous command hook may cause bounded delay. The device asserts this data; the gateway does not authenticate the human identity. Codex traffic is not covered.</p>'
    : '<p data-i18n="conversation-privacy-notice">This diagnostic archive permanently stores bounded Claude API request/response fragments. They may be client wrappers, reminders, or tool-loop intermediates and are not verified human conversations. Every console member can read them. Codex traffic is not covered.</p>';
  return `<div class="notice error conversation-disclosure" role="note">
    ${heading}
    ${notice}
    ${openMode ? '<p data-i18n="conversation-open-warning"><strong>Open mode:</strong> anyone on the tailnet who can reach this console can read every captured API turn; there is no identity and no reading audit. A member label is not an actor identity.</p>' : ''}
  </div>`;
}

function conversationSubnav(active) {
  return `<nav class="conversation-subnav" aria-label="Conversation views">
    <a href="/conversations" data-i18n="conversation-subnav-sessions"${active === 'sessions' ? ' aria-current="page"' : ''}>Conversations</a>
    <a href="/conversation-turns" data-i18n="conversation-subnav-turns"${active === 'turns' ? ' aria-current="page"' : ''}>API fragment diagnostics</a>
  </nav>`;
}

function conversationFormField(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}">`;
}

function conversationFormFields({
  q,
  period,
  memberLabel,
  deviceId,
  accountId,
  model,
  responseState,
  limit,
  beforeId = null,
  beforeActivityMs = null,
}) {
  return [
    conversationFormField('q', q),
    conversationFormField('period', period),
    conversationFormField('member_label', memberLabel),
    conversationFormField('device_id', deviceId),
    conversationFormField('account_id', accountId),
    conversationFormField('model', model),
    conversationFormField('response_state', responseState),
    conversationFormField('limit', limit),
    beforeId === null || beforeId === undefined ? '' : conversationFormField('before_id', beforeId),
    beforeActivityMs === null || beforeActivityMs === undefined
      ? ''
      : conversationFormField('before_activity_ms', beforeActivityMs),
  ].join('');
}

function conversationSnippetText(value) {
  const text = conversationText(value);
  if (text.length <= MAX_CONVERSATION_SNIPPET_CHARS) return text;
  return `${Array.from(text).slice(0, MAX_CONVERSATION_SNIPPET_CHARS).join('')}…`;
}

function conversationTimelineText(value) {
  const text = conversationText(value);
  const points = Array.from(text);
  if (points.length <= MAX_CONVERSATION_TIMELINE_TEXT_CHARS) {
    return { text, omitted: false };
  }
  return {
    text: points.slice(0, MAX_CONVERSATION_TIMELINE_TEXT_CHARS).join(''),
    omitted: true,
  };
}

function promptSourceI18n(source) {
  if (source === 'claude_hook') {
    return ['conversation-prompt-source-hook', 'Source: Claude Code UserPromptSubmit hook'];
  }
  if (source === 'wrapper_removed') {
    return ['conversation-prompt-source-wrapper', 'Source: recognized client wrapper removed'];
  }
  if (source === 'fallback_raw') {
    return ['conversation-prompt-source-fallback', 'Source: raw captured text (wrapper not recognized)'];
  }
  if (source === 'empty') {
    return ['conversation-prompt-source-empty', 'Source: unavailable'];
  }
  return ['conversation-prompt-source-captured', 'Source: captured API user text'];
}

function promptDisplayMetaView(display) {
  const [sourceI18n, sourceLabel] = promptSourceI18n(display?.source);
  return `<div class="conversation-prompt-meta" data-prompt-source="${escapeHtml(display?.source ?? 'empty')}" data-prompt-suffix-omitted="${display?.suffixOmitted === true ? 'true' : 'false'}" role="note">
    <span data-i18n="${sourceI18n}">${sourceLabel}</span>
    ${display?.suffixOmitted === true
      ? '<span data-i18n="conversation-prompt-suffix-omitted">A bounded suffix is omitted from this display; the omitted text is not shown.</span>'
      : ''}
  </div>`;
}

function promptDisplayInput(item, value) {
  return {
    text: value,
    promptBytes: item?.promptBytes,
    promptSource: item?.promptSource ?? item?.source ?? item?.promptDisplay?.source,
    promptSuffixOmitted: item?.promptSuffixOmitted === true
      || item?.promptDisplay?.suffixOmitted === true,
  };
}

function conversationFacetOptions(values, selected, allLabel, allI18n) {
  const options = Array.isArray(values) ? values : [];
  const seen = new Set();
  const selectedValue = String(selected ?? '');
  const rendered = [`<option value=""${selectedValue ? '' : ' selected'} data-i18n="${escapeHtml(allI18n)}">${escapeHtml(allLabel)}</option>`];
  for (const entry of options.slice(0, MAX_CONVERSATION_FACETS)) {
    const value = String(entry?.value ?? '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = String(entry?.label ?? value);
    const count = Number.isSafeInteger(entry?.count) ? ` (${entry.count})` : '';
    const countAttribute = Number.isSafeInteger(entry?.count) ? ` data-facet-count="${entry.count}"` : '';
    rendered.push(`<option value="${escapeHtml(value)}"${value === selectedValue ? ' selected' : ''}${countAttribute}>${escapeHtml(`${label}${count}`)}</option>`);
  }
  if (selectedValue && !seen.has(selectedValue)) {
    rendered.push(`<option value="${escapeHtml(selectedValue)}" selected>${escapeHtml(selectedValue)}</option>`);
  }
  return rendered.join('');
}

function conversationFacetDatalist(values, selected) {
  const options = Array.isArray(values) ? values : [];
  const seen = new Set();
  const selectedValue = String(selected ?? '');
  const rendered = [];
  for (const entry of options.slice(0, MAX_CONVERSATION_FACETS)) {
    const value = String(entry?.value ?? '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = String(entry?.label ?? value);
    const count = Number.isSafeInteger(entry?.count) ? ` (${entry.count})` : '';
    const countAttribute = Number.isSafeInteger(entry?.count) ? ` data-facet-count="${entry.count}"` : '';
    rendered.push(`<option value="${escapeHtml(value)}" label="${escapeHtml(`${label}${count}`)}"${countAttribute}></option>`);
  }
  if (selectedValue && !seen.has(selectedValue)) {
    rendered.push(`<option value="${escapeHtml(selectedValue)}" label="${escapeHtml(selectedValue)}"></option>`);
  }
  return rendered.join('');
}

function conversationActiveChips({ q, period, memberLabel, deviceId, accountId, model, responseState }) {
  const entries = [
    q ? ['conversation-filter-query', 'Query', q] : null,
    period && period !== 'all' ? ['conversation-filter-period', 'Period', period] : null,
    memberLabel ? ['conversation-filter-member', 'Member', memberLabel] : null,
    deviceId ? ['conversation-filter-device', 'Device', deviceId] : null,
    accountId ? ['conversation-filter-account', 'Account', accountId] : null,
    model ? ['conversation-filter-model', 'Model', model] : null,
    responseState ? ['conversation-filter-state', 'State', responseState] : null,
  ].filter(Boolean);
  if (!entries.length) return '';
  return `<div class="conversation-chip-list" aria-label="Active filters">
    ${entries.map(([i18n, label, value]) => `<span class="conversation-filter-chip"><span data-i18n="${i18n}">${label}</span>: ${escapeHtml(value)}</span>`).join('')}
  </div>`;
}

function conversationSnippetView(labelI18n, label, value, emptyI18n) {
  const text = conversationSnippetText(value);
  return `<div class="conversation-result-snippet">
    <strong data-i18n="${escapeHtml(labelI18n)}">${escapeHtml(label)}</strong>
    ${text ? `<p>${escapeHtml(text)}</p>` : `<div class="empty tiny" data-i18n="${escapeHtml(emptyI18n)}">Not captured</div>`}
  </div>`;
}

function conversationPromptSnippetView(item, { reliable = false } = {}) {
  // Schema v4 returns the bounded complete prompt alongside any FTS snippet so
  // legacy wrapper suffixes can be removed before display. Older callers only
  // have promptSnippet and keep the previous bounded fallback.
  const raw = item?.promptText ?? item?.promptSnippet;
  const display = derivePromptDisplay(promptDisplayInput(item, raw), {
    maxChars: MAX_CONVERSATION_SNIPPET_CHARS,
  });
  return `<div class="conversation-result-snippet">
    <strong data-i18n="${reliable ? 'conversation-user-message' : 'conversation-prompt'}">${reliable ? 'User-submitted message' : 'Captured API user text'}</strong>
    ${display.text
      ? `<p>${escapeHtml(display.text)}</p>`
      : '<div class="empty tiny" data-i18n="conversation-empty-prompt">Not captured</div>'}
    <p class="conversation-prompt-disclaimer" data-i18n="${reliable ? 'conversation-hook-prompt-disclaimer' : 'conversation-prompt-disclaimer'}">${reliable
      ? 'Captured directly from Claude Code UserPromptSubmit. It is exact client-submitted text, but the device does not authenticate the human identity.'
      : 'Captured from the final API user message; it may include client wrappers and is not guaranteed to be the user\'s original words.'}</p>
    ${promptDisplayMetaView(display)}
  </div>`;
}

function conversationItemView(item) {
  const id = item?.id === null || item?.id === undefined ? '' : String(item.id);
  const state = conversationState(item);
  const responseSnippet = item?.responseSnippet ?? item?.responseText;
  const dropped = item?.conversationCaptureState === 'dropped'
    || item?.captureState === 'dropped'
    || item?.queueState === 'dropped';
  const detailLink = id
    ? `<a class="button secondary" href="/conversation-turns/${escapeHtml(encodeURIComponent(id))}" data-i18n="conversation-open">Open API fragment</a>`
    : '';
  const device = item?.deviceName ?? item?.deviceId ?? '—';
  return `<article class="conversation-result-row" data-conversation-id="${escapeHtml(id)}">
    <div class="conversation-result-head">
      <div>
        <h2>${id ? `#${escapeHtml(id)}` : '<span data-i18n="conversation-unknown-id">API fragment</span>'}</h2>
        <div class="conversation-result-meta">
          <span><span data-i18n="conversation-captured-at">Captured</span>: ${escapeHtml(conversationDateText(item?.startedAtMs))}</span>
          <span><span data-i18n="conversation-member-label">Member label</span>: ${escapeHtml(item?.memberLabel ?? '—')}</span>
          <span><span data-i18n="conversation-device">Device</span>: ${escapeHtml(device)}</span>
          <span><span data-i18n="conversation-account">Account</span>: ${escapeHtml(item?.accountAlias ?? '—')}</span>
          ${item?.model ? `<span><span data-i18n="conversation-model">Model</span>: ${escapeHtml(item.model)}</span>` : ''}
        </div>
      </div>
      <div class="conversation-result-actions">${conversationStatusView(state)}${detailLink}</div>
    </div>
    ${dropped ? '<div class="notice error tiny conversation-queue-dropped" role="status" data-i18n="conversation-queue-dropped">API-turn capture was dropped by the bounded queue.</div>' : ''}
    <div class="conversation-result-snippets">
      ${conversationPromptSnippetView(item)}
      ${conversationSnippetView('conversation-response', 'Response', responseSnippet, 'conversation-empty-response')}
    </div>
  </article>`;
}

function conversationEnvelope({
  result,
  searchResult,
  search,
  items,
  nextBeforeId,
  nextBeforeActivityMs,
  error,
}) {
  const source = result ?? searchResult ?? search ?? {};
  return {
    items: Array.isArray(items) ? items : (Array.isArray(source.items) ? source.items : []),
    nextBeforeId: nextBeforeId ?? source.nextBeforeId ?? null,
    nextBeforeActivityMs: nextBeforeActivityMs ?? source.nextBeforeActivityMs ?? null,
    error: error ?? source.error ?? null,
    dropped: source.droppedConversations ?? source.queueDropped ?? null,
    facets: source.facets && typeof source.facets === 'object' && !Array.isArray(source.facets)
      ? source.facets
      : {},
    totalMatches: Number.isSafeInteger(source.totalMatches) ? source.totalMatches : null,
  };
}

function conversationSearchErrorView(error) {
  const code = typeof error === 'string' ? error : error?.code;
  if (code === 'conversation_filter_invalid') {
    return '<div class="notice error" role="alert" data-i18n="conversation-filter-invalid">One or more API-turn filters are invalid or too long. Clear the filters and try again.</div>';
  }
  if (code === 'search_query_too_short') {
    return '<div class="notice error" role="alert" data-i18n="conversation-search-query-too-short">Search query is too short for this API-turn archive. For large archives, enter at least three consecutive Chinese characters or more searchable text; remove standalone punctuation and split the query into simpler terms.</div>';
  }
  if (code === 'search_query_requires_indexed_terms') {
    return '<div class="notice error" role="alert" data-i18n="conversation-search-requires-indexed-terms">API-turn search needs indexed terms. For large archives, enter at least three consecutive Chinese characters, remove special punctuation, or split the query into simpler terms.</div>';
  }
  return '<div class="notice error" role="alert" data-i18n="conversation-search-error">API-turn search could not be completed.</div>';
}

export function conversationsView({
  fragment = false,
  result = null,
  searchResult = null,
  search = null,
  items = null,
  nextBeforeId = null,
  q = '',
  beforeId = '',
  period = 'all',
  memberLabel = '',
  deviceId = '',
  accountId = '',
  model = '',
  responseState = '',
  limit = 25,
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
  const normalizedLimit = Number(limit) === 1
    ? 1
    : CONVERSATION_LIMIT_OPTIONS.includes(Number(limit)) ? Number(limit) : 25;
  const normalizedPeriod = CONVERSATION_PERIOD_OPTIONS.some((option) => option.value === String(period))
    ? String(period)
    : 'all';
  const normalizedMember = String(memberLabel ?? '');
  const normalizedDevice = String(deviceId ?? '');
  const normalizedAccount = String(accountId ?? '');
  const normalizedModel = String(model ?? '');
  const normalizedState = API_FRAGMENT_RESPONSE_STATES.includes(String(responseState))
    ? String(responseState)
    : '';
  const facets = envelope.facets ?? {};
  const droppedCount = conversationCount(
    envelope.dropped
      ?? conversationQueueDropped
      ?? queueDropped
      ?? conversationDropped
      ?? droppedConversations
      ?? dropped,
  );
  const itemsView = envelope.items.map(conversationItemView).join('');
  const errorNotice = envelope.error === null || envelope.error === undefined
    ? ''
    : conversationSearchErrorView(envelope.error);
  const droppedNotice = droppedCount > 0
    ? `<div class="notice error conversation-queue-dropped" role="alert"><span data-i18n="conversation-queue-dropped">API-turn capture was dropped by the bounded queue.</span> <strong>${escapeHtml(String(droppedCount))}</strong></div>`
    : '';
  const facetNotice = facets.truncated === true
    ? '<div class="notice" role="note" data-i18n="conversation-facets-truncated">Some filter values are omitted from the list; a selected value remains available.</div>'
    : '';
  const totalMatches = envelope.totalMatches === null || envelope.totalMatches === undefined
    ? envelope.items.length
    : envelope.totalMatches;
  const periodOptions = CONVERSATION_PERIOD_OPTIONS.map((option) => (
    `<option value="${escapeHtml(option.value)}"${normalizedPeriod === option.value ? ' selected' : ''} data-i18n="${escapeHtml(option.i18n)}">${escapeHtml(option.label)}</option>`
  )).join('');
  const stateOptions = [
    '<option value="" data-i18n="conversation-all-states">All response states</option>',
    ...API_FRAGMENT_RESPONSE_STATES.map((state) => `<option value="${escapeHtml(state)}"${normalizedState === state ? ' selected' : ''} data-i18n="conversation-response-${escapeHtml(state)}">${escapeHtml(state)}</option>`),
  ].join('');
  const nextForm = envelope.nextBeforeId === null || envelope.nextBeforeId === undefined
    ? ''
    : `<form method="post" action="/conversation-turns" class="conversation-pagination-form" data-reset-scroll>
        ${conversationFormFields({ q: query, period: normalizedPeriod, memberLabel: normalizedMember, deviceId: normalizedDevice, accountId: normalizedAccount, model: normalizedModel, responseState: normalizedState, limit: normalizedLimit, beforeId: envelope.nextBeforeId })}
        <button type="submit" data-i18n="conversation-next-page">Next page</button>
      </form>`;
  const resultsSection = `
        <section class="conversation-results" aria-labelledby="conversation-results-heading">
          <div class="conversation-results-head">
            <div>
              <span class="badge stored" data-i18n="conversations-label">API fragment diagnostics</span>
              <h1 id="conversation-results-heading" data-i18n="conversations-heading">API fragment diagnostics</h1>
              <p class="muted" data-i18n="conversations-intro">Search immutable per-request Claude API fragments. They may contain wrappers, reminders, or tool-loop intermediates and are not user rounds.</p>
              ${conversationActiveChips({ q: query, period: normalizedPeriod, memberLabel: normalizedMember, deviceId: normalizedDevice, accountId: normalizedAccount, model: normalizedModel, responseState: normalizedState })}
            </div>
            <div class="conversation-result-summary" aria-live="polite"><strong>${escapeHtml(String(totalMatches))}</strong> <span data-i18n="conversation-total-matches">matches</span> · <label class="conversation-rows"><span class="muted tiny" data-i18n="conversation-filter-limit-label">Rows per page</span><select name="limit" form="conversation-filter-form" data-autoapply>${CONVERSATION_LIMIT_OPTIONS.map((value) => `<option value="${value}"${normalizedLimit === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label> · <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a></div>
          </div>
          ${errorNotice}
          ${droppedNotice}
          ${facetNotice}
          <div class="conversation-list" aria-live="polite">
            ${itemsView || '<p class="empty" data-i18n="conversation-no-results">No captured API turns match this search.</p>'}
          </div>
          ${nextForm ? `<div class="conversation-pagination"><span class="muted tiny" data-i18n="conversation-pagination-hint">Results are ordered newest first.</span>${nextForm}</div>` : ''}
        </section>
`;
  // A fragment request re-renders only the results, so a filter change costs
  // a few KB instead of the whole document over a high-latency link.
  if (fragment) return resultsSection;
  return layout('API fragment diagnostics', `
    <section class="stack">
      ${conversationPrivacyView(openMode)}
      ${conversationSubnav('turns')}
      <div class="conversation-layout">
        <details class="conversation-filter-details" data-persist-details="turn-filters" open>
          <summary data-i18n="conversation-filters-heading">Filters</summary>
          <form id="conversation-filter-form" method="post" action="/conversation-turns" class="card conversation-rail conversation-filters" aria-label="API-turn filters" data-reset-scroll>
          <h2 class="visually-hidden" data-i18n="conversation-filters-heading">Filters</h2>
          <label><span data-i18n="conversation-search">Search captured API turns</span>
            <input name="q" value="${escapeHtml(query)}" maxlength="256" autocomplete="off" placeholder="Text in prompt or reply" data-placeholder-en="Text in prompt or reply" data-placeholder-zh="已捕获 API 用户文本或回复">
          </label>
          <label><span data-i18n="conversation-filter-period-label">Period</span>
            <select name="period" data-autoapply>${periodOptions}</select>
          </label>
          <label><span data-i18n="conversation-filter-member-label">Member</span>
            <input name="member_label" value="${escapeHtml(normalizedMember)}" list="conversation-member-facets" maxlength="160" autocomplete="off" placeholder="All members" data-placeholder-en="All members" data-placeholder-zh="全部成员">
            <datalist id="conversation-member-facets">${conversationFacetDatalist(facets.members, normalizedMember)}</datalist>
            <p class="muted tiny conversation-filter-hint" data-i18n="conversation-filter-hint">Type to search member suggestions; leave the field blank for everyone.</p>
          </label>
          <label><span data-i18n="conversation-filter-device-label">Device</span>
            <select name="device_id" data-autoapply>${conversationFacetOptions(facets.devices, normalizedDevice, 'All devices', 'conversation-all-devices')}</select>
          </label>
          <label><span data-i18n="conversation-filter-account-label">Account</span>
            <select name="account_id" data-autoapply>${conversationFacetOptions(facets.accounts, normalizedAccount, 'All accounts', 'conversation-all-accounts')}</select>
          </label>
          <label><span data-i18n="conversation-filter-model-label">Model</span>
            <select name="model" data-autoapply>${conversationFacetOptions(facets.models, normalizedModel, 'All models', 'conversation-all-models')}</select>
          </label>
          <label><span data-i18n="conversation-filter-state-label">Response state</span>
            <select name="response_state" data-autoapply>${stateOptions}</select>
          </label>
          <div class="filter-actions">
            <button type="submit" data-i18n="conversation-search-submit">Search</button>
            <a class="button secondary" href="/conversation-turns" data-i18n="conversation-search-clear">Clear</a>
          </div>
          </form>
        </details>
        ${resultsSection}
      </div>
    </section>
  `, { openMode, activeTab: 'conversations' });
}

function conversationSessionSearchErrorView(error) {
  const code = typeof error === 'string' ? error : error?.code;
  if (code === 'conversation_filter_invalid') {
    return '<div class="notice error" role="alert" data-i18n="conversation-session-filter-invalid">One or more conversation filters are invalid or too long. Clear the filters and try again.</div>';
  }
  if (code === 'search_query_too_short') {
    return '<div class="notice error" role="alert" data-i18n="conversation-session-search-query-too-short">Search query is too short for this conversation archive. For large archives, enter at least three consecutive Chinese characters or more searchable text; remove standalone punctuation and split the query into simpler terms.</div>';
  }
  if (code === 'search_query_requires_indexed_terms') {
    return '<div class="notice error" role="alert" data-i18n="conversation-session-search-requires-indexed-terms">Conversation search needs indexed terms. For large archives, enter at least three consecutive Chinese characters, remove special punctuation, or split the query into simpler terms.</div>';
  }
  return '<div class="notice error" role="alert" data-i18n="conversation-session-search-error">Conversation search could not be completed.</div>';
}

function legacyFragmentsNotice(count) {
  const normalized = conversationCount(count);
  if (!normalized) return '';
  return `<div class="notice conversation-legacy-notice" role="note">
    <div><strong data-i18n="conversation-legacy-fragments-heading">Legacy API fragments kept for diagnostics</strong>
    <p><span data-i18n="conversation-legacy-fragments-notice">These older rows were captured from individual API requests. They are not user rounds and are never guessed into conversations.</span> <strong>${escapeHtml(String(normalized))}</strong></p></div>
    <a class="button secondary" href="/conversation-turns" data-i18n="conversation-legacy-fragments-link">Open API fragment diagnostics</a>
  </div>`;
}

function conversationSessionItemView(item) {
  const id = item?.id === null || item?.id === undefined ? '' : String(item.id);
  const state = conversationState({ responseState: item?.latestResponseState });
  const device = item?.deviceName ?? item?.deviceId ?? '—';
  const promptItem = {
    promptText: item?.latestPromptText ?? '',
    promptSource: 'claude_hook',
    promptSuffixOmitted: false,
  };
  const stateCounts = [
    ['complete', item?.completeCount],
    ['pending', item?.pendingCount],
    ['failed', item?.failedCount],
    ['unavailable', item?.unavailableCount],
  ].map(([name, value]) => [name, conversationCount(value)])
    .filter(([, value]) => value > 0)
    .map(([name, value]) => `<span><span data-i18n="conversation-response-${name}">${name}</span>: ${escapeHtml(String(value))}</span>`)
    .join('');
  const detailLink = id
    ? `<a class="button secondary" href="/conversations/session/${escapeHtml(encodeURIComponent(id))}" data-i18n="conversation-session-open">Open conversation</a>`
    : '';
  return `<article class="conversation-result-row conversation-session-row" data-conversation-session-id="${escapeHtml(id)}">
    <div class="conversation-result-head">
      <div>
        <h2><span data-i18n="conversation-session-heading">Conversation</span>${id ? ` #${escapeHtml(id)}` : ''}</h2>
        <div class="conversation-result-meta">
          <span><span data-i18n="conversation-session-turn-count">Turns</span>: ${escapeHtml(String(conversationCount(item?.turnCount)))}</span>
          <span><span data-i18n="conversation-session-first-at">First prompt</span>: ${escapeHtml(conversationDateText(item?.firstPromptAtMs))}</span>
          <span><span data-i18n="conversation-session-last-at">Latest activity</span>: ${escapeHtml(conversationDateText(item?.lastActivityAtMs))}</span>
          <span><span data-i18n="conversation-member-label">Member label</span>: ${escapeHtml(item?.memberLabel ?? '—')}</span>
          <span><span data-i18n="conversation-device">Device</span>: ${escapeHtml(device)}</span>
          <span><span data-i18n="conversation-account">Account</span>: ${escapeHtml(item?.accountAlias ?? '—')}</span>
          ${item?.model ? `<span><span data-i18n="conversation-model">Model</span>: ${escapeHtml(item.model)}</span>` : ''}
        </div>
      </div>
      <div class="conversation-result-actions">${conversationStatusView(state)}${detailLink}</div>
    </div>
    <div class="conversation-round-state-counts tiny" aria-label="Round state counts">
      ${stateCounts}
    </div>
    <p class="muted tiny" data-i18n="conversation-session-latest-preview">Round preview</p>
    <div class="conversation-result-snippets">
      ${conversationPromptSnippetView(promptItem, { reliable: true })}
      ${conversationSnippetView('conversation-final-response', 'Final response', item?.latestResponseText, 'conversation-empty-response')}
    </div>
  </article>`;
}

export function conversationSessionsView({
  fragment = false,
  result = null,
  searchResult = null,
  search = null,
  items = null,
  nextBeforeId = null,
  nextBeforeActivityMs = null,
  q = '',
  period = 'all',
  memberLabel = '',
  deviceId = '',
  accountId = '',
  model = '',
  responseState = '',
  limit = 25,
  openMode = false,
  error = null,
  queueDropped = null,
  legacyFragmentCount = null,
} = {}) {
  const envelope = conversationEnvelope({
    result,
    searchResult,
    search,
    items,
    nextBeforeId,
    nextBeforeActivityMs,
    error,
  });
  const source = result ?? searchResult ?? search ?? {};
  const query = typeof q === 'string' ? q : String(q ?? '');
  const normalizedLimit = Number(limit) === 1
    ? 1
    : CONVERSATION_LIMIT_OPTIONS.includes(Number(limit)) ? Number(limit) : 25;
  const normalizedPeriod = CONVERSATION_PERIOD_OPTIONS.some((option) => option.value === String(period))
    ? String(period)
    : 'all';
  const normalizedMember = String(memberLabel ?? '');
  const normalizedDevice = String(deviceId ?? '');
  const normalizedAccount = String(accountId ?? '');
  const normalizedModel = String(model ?? '');
  const normalizedState = CONVERSATION_RESPONSE_STATES.includes(String(responseState))
    ? String(responseState)
    : '';
  const facets = envelope.facets ?? {};
  const droppedCount = conversationCount(envelope.dropped ?? queueDropped);
  const legacyCount = conversationCount(
    legacyFragmentCount ?? source?.legacyFragmentCount,
  );
  const totalMatches = envelope.totalMatches === null || envelope.totalMatches === undefined
    ? envelope.items.length
    : envelope.totalMatches;
  const errorNotice = envelope.error === null || envelope.error === undefined
    ? ''
    : conversationSessionSearchErrorView(envelope.error);
  const droppedNotice = droppedCount > 0
    ? `<div class="notice error conversation-queue-dropped" role="alert"><span data-i18n="conversation-round-dropped">A reliable round could not be stored.</span> <strong>${escapeHtml(String(droppedCount))}</strong></div>`
    : '';
  const facetNotice = facets.truncated === true
    ? '<div class="notice" role="note" data-i18n="conversation-facets-truncated">Some filter values are omitted from the list; a selected value remains available.</div>'
    : '';
  const periodOptions = CONVERSATION_PERIOD_OPTIONS.map((option) => (
    `<option value="${escapeHtml(option.value)}"${normalizedPeriod === option.value ? ' selected' : ''} data-i18n="${escapeHtml(option.i18n)}">${escapeHtml(option.label)}</option>`
  )).join('');
  const stateOptions = [
    '<option value="" data-i18n="conversation-all-states">All response states</option>',
    ...CONVERSATION_RESPONSE_STATES.map((state) => `<option value="${escapeHtml(state)}"${normalizedState === state ? ' selected' : ''} data-i18n="conversation-response-${escapeHtml(state)}">${escapeHtml(state)}</option>`),
  ].join('');
  const nextForm = envelope.nextBeforeId === null
    || envelope.nextBeforeId === undefined
    || envelope.nextBeforeActivityMs === null
    || envelope.nextBeforeActivityMs === undefined
    ? ''
    : `<form method="post" action="/conversations" class="conversation-pagination-form" data-reset-scroll>
        ${conversationFormFields({ q: query, period: normalizedPeriod, memberLabel: normalizedMember, deviceId: normalizedDevice, accountId: normalizedAccount, model: normalizedModel, responseState: normalizedState, limit: normalizedLimit, beforeId: envelope.nextBeforeId, beforeActivityMs: envelope.nextBeforeActivityMs })}
        <button type="submit" data-i18n="conversation-next-page">Next page</button>
      </form>`;
  const itemsView = envelope.items.map(conversationSessionItemView).join('');
  const hasActiveFilters = Boolean(
    query
    || normalizedPeriod !== 'all'
    || normalizedMember
    || normalizedDevice
    || normalizedAccount
    || normalizedModel
    || normalizedState,
  );
  const emptyRounds = `<div class="card conversation-round-empty">
    <h2 data-i18n="conversation-round-empty-heading">No reliable user rounds yet</h2>
    <p data-i18n="conversation-round-empty-copy">Reliable conversations begin when a Claude Code profile sends UserPromptSubmit and Stop hooks. Existing API fragments remain available only in diagnostics and are not guessed into conversations.</p>
    <div class="actions">
      <a class="button" href="/#conversation-capture-upgrade" data-i18n="conversation-round-install-hooks">Install conversation capture update</a>
    </div>
  </div>`;
  const resultsSection = `
        <section class="conversation-results" aria-labelledby="conversation-sessions-results-heading">
          <div class="conversation-results-head">
            <div>
              <span class="badge stored" data-i18n="conversation-sessions-label">Reliable hook-backed conversations</span>
              <h1 id="conversation-sessions-results-heading" data-i18n="conversation-sessions-heading">Conversations</h1>
              <p class="muted" data-i18n="conversation-sessions-intro">Each round pairs the exact prompt emitted by Claude Code UserPromptSubmit with the final visible response emitted by Stop. Tool-loop API requests do not become fake user turns. Session and prompt identifiers are stored only as device-bound HMACs.</p>
              ${conversationActiveChips({ q: query, period: normalizedPeriod, memberLabel: normalizedMember, deviceId: normalizedDevice, accountId: normalizedAccount, model: normalizedModel, responseState: normalizedState })}
            </div>
            <div class="conversation-result-summary" aria-live="polite"><strong>${escapeHtml(String(totalMatches))}</strong> <span data-i18n="conversation-session-total-matches">matching conversations</span> · <label class="conversation-rows"><span class="muted tiny" data-i18n="conversation-filter-limit-label">Rows per page</span><select name="limit" form="conversation-filter-form" data-autoapply>${CONVERSATION_LIMIT_OPTIONS.map((value) => `<option value="${value}"${normalizedLimit === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label> · <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a></div>
          </div>
          ${errorNotice}
          ${droppedNotice}
          ${facetNotice}
          <div class="conversation-list" aria-live="polite">
            ${itemsView || (hasActiveFilters
              ? '<p class="empty" data-i18n="conversation-session-no-results">No reliable conversations match these filters.</p>'
              : emptyRounds)}
          </div>
          ${nextForm ? `<div class="conversation-pagination"><span class="muted tiny" data-i18n="conversation-session-pagination-hint">Conversations are ordered by latest hook activity, newest first.</span>${nextForm}</div>` : ''}
        </section>
`;
  // A fragment request re-renders only the results, so a filter change costs
  // a few KB instead of the whole document over a high-latency link.
  if (fragment) return resultsSection;
  return layout('Conversations', `
    <section class="stack">
      ${conversationPrivacyView(openMode, { reliable: true })}
      ${conversationSubnav('sessions')}
      ${legacyFragmentsNotice(legacyCount)}
      <div class="conversation-layout">
        <details class="conversation-filter-details" data-persist-details="session-filters" open>
          <summary data-i18n="conversation-filters-heading">Filters</summary>
          <form id="conversation-filter-form" method="post" action="/conversations" class="card conversation-rail conversation-filters" aria-label="Conversation filters" data-reset-scroll>
          <h2 class="visually-hidden" data-i18n="conversation-filters-heading">Filters</h2>
          <label><span data-i18n="conversation-session-search">Search conversations</span>
            <input name="q" value="${escapeHtml(query)}" maxlength="256" autocomplete="off" placeholder="Text in prompt or reply" data-placeholder-en="Text in prompt or reply" data-placeholder-zh="原始提交文字或最终回复">
          </label>
          <label><span data-i18n="conversation-filter-period-label">Period</span><select name="period" data-autoapply>${periodOptions}</select></label>
          <label><span data-i18n="conversation-filter-member-label">Member</span>
            <input name="member_label" value="${escapeHtml(normalizedMember)}" list="conversation-member-facets" maxlength="160" autocomplete="off" placeholder="All members" data-placeholder-en="All members" data-placeholder-zh="全部成员">
            <datalist id="conversation-member-facets">${conversationFacetDatalist(facets.members, normalizedMember)}</datalist>
            <p class="muted tiny conversation-filter-hint" data-i18n="conversation-session-filter-hint">Filters match reliable hook-backed user rounds. API fragments are searched separately in diagnostics.</p>
          </label>
          <label><span data-i18n="conversation-filter-device-label">Device</span><select name="device_id" data-autoapply>${conversationFacetOptions(facets.devices, normalizedDevice, 'All devices', 'conversation-all-devices')}</select></label>
          <label><span data-i18n="conversation-filter-account-label">Account</span><select name="account_id" data-autoapply>${conversationFacetOptions(facets.accounts, normalizedAccount, 'All accounts', 'conversation-all-accounts')}</select></label>
          <label><span data-i18n="conversation-filter-state-label">Response state</span><select name="response_state" data-autoapply>${stateOptions}</select></label>
          <div class="filter-actions">
            <button type="submit" data-i18n="conversation-search-submit">Search</button>
            <a class="button secondary" href="/conversations" data-i18n="conversation-search-clear">Clear</a>
          </div>
          </form>
        </details>
        ${resultsSection}
      </div>
    </section>
  `, { openMode, activeTab: 'conversations' });
}

function conversationSessionTurnView(turn, fallbackIndex) {
  const displayIndex = Number.isSafeInteger(turn?.turnIndex) && turn.turnIndex > 0
    ? turn.turnIndex
    : fallbackIndex + 1;
  const state = conversationState(turn);
  const promptDisplay = derivePromptDisplay(
    promptDisplayInput(turn, turn?.promptText ?? turn?.prompt),
    { maxChars: MAX_CONVERSATION_TIMELINE_TEXT_CHARS },
  );
  const responseDisplay = conversationTimelineText(turn?.responseText ?? turn?.response);
  const response = responseDisplay.text;
  const turnId = Number.isSafeInteger(turn?.id) && turn.id > 0 ? turn.id : null;
  const stateNotice = state === 'failed'
      ? `<p class="notice error conversation-session-state-note"><span data-i18n="conversation-round-failed">Claude Code reported that this round failed.</span> ${conversationFailureView(turn?.failureCode)}</p>`
      : state === 'unavailable'
        ? '<p class="notice conversation-session-state-note" data-i18n="conversation-round-unavailable">The prompt is preserved, but no final response hook was available before the session ended.</p>'
        : '';
  const timelineClipNotice = responseDisplay.omitted || turn?.responseDisplayTruncated === true
    ? '<p class="notice conversation-session-state-note" data-i18n="conversation-session-timeline-clipped">Long assistant text is shortened in this timeline. Open the individual turn to read the complete captured text.</p>'
    : '';
  const responseView = response
    ? `<pre>${escapeHtml(response)}</pre>`
    : `<p class="empty" data-i18n="${state === 'pending' ? 'conversation-round-response-pending' : 'conversation-round-empty-response'}">${state === 'pending' ? 'Waiting for the final response.' : 'No final assistant text was reported for this round.'}</p>`;
  return `<article class="conversation-timeline-turn" data-turn-index="${escapeHtml(String(displayIndex))}">
    <div class="conversation-timeline-turn-head">
      <div>
        <h2><span data-i18n="conversation-session-turn">Round</span> ${escapeHtml(String(displayIndex))}</h2>
        <div class="conversation-detail-meta">
          <span><span data-i18n="conversation-round-prompt-at">Prompt submitted</span>: ${escapeHtml(conversationDateText(turn?.promptAtMs))}</span>
          <span><span data-i18n="conversation-session-last-at">Latest activity</span>: ${escapeHtml(conversationDateText(turn?.lastActivityAtMs ?? turn?.completedAtMs ?? turn?.promptAtMs))}</span>
          <span><span data-i18n="conversation-member-label">Member label</span>: ${escapeHtml(turn?.memberLabel ?? '—')}</span>
          <span><span data-i18n="conversation-account">Account</span>: ${escapeHtml(turn?.accountAlias ?? '—')}</span>
          ${turn?.model ? `<span><span data-i18n="conversation-model">Model</span>: ${escapeHtml(turn.model)}</span>` : ''}
        </div>
      </div>
      <div class="conversation-result-actions">
        ${conversationStatusView(state)}
        ${turnId ? `<a class="button secondary" href="/conversation-rounds/${turnId}" data-i18n="conversation-session-open-turn">Open round</a>` : ''}
      </div>
    </div>
    <div class="conversation-turn-messages">
      <section class="conversation-message conversation-message-user">
        <h3 data-i18n="conversation-user-message">User-submitted message</h3>
        <p class="conversation-prompt-disclaimer muted tiny" data-i18n="conversation-hook-prompt-disclaimer">Captured directly from Claude Code UserPromptSubmit. It is exact client-submitted text, but the device does not authenticate the human identity.</p>
        ${promptDisplay.text ? `<pre>${escapeHtml(promptDisplay.text)}</pre>` : '<p class="empty" data-i18n="conversation-empty-prompt">Not captured</p>'}
        ${promptDisplayMetaView(promptDisplay)}
        ${turn?.promptTruncated === true ? '<p class="notice conversation-session-state-note" data-i18n="conversation-round-prompt-truncated">The submitted prompt exceeded the storage bound; only a complete UTF-8 prefix is retained.</p>' : ''}
      </section>
      <section class="conversation-message conversation-message-assistant">
        <h3 data-i18n="conversation-final-response">Final response</h3>
        ${responseView}
        ${stateNotice}
        ${turn?.responseTruncated === true ? '<p class="notice conversation-session-state-note" data-i18n="conversation-round-response-truncated">The final response exceeded the storage bound; only a complete UTF-8 prefix is retained.</p>' : ''}
        ${timelineClipNotice}
      </section>
    </div>
  </article>`;
}

export function conversationSessionDetailView({
  result = null,
  session = null,
  id = null,
  error = null,
  openMode = false,
} = {}) {
  const envelope = result ?? {};
  const record = session ?? (Object.hasOwn(envelope, 'session') ? envelope.session : null);
  const errorText = error ?? envelope.error ?? null;
  const errorNotice = errorText
    ? `<div class="notice error" role="alert"><span data-i18n="conversation-session-read-error">Conversation could not be loaded.</span></div>`
    : '';
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return layout('Conversation unavailable', `
      <section class="stack conversation-session-detail-shell">
        ${conversationPrivacyView(openMode, { reliable: true })}
        ${conversationSubnav('sessions')}
        ${errorNotice || '<div class="notice error" role="alert" data-i18n="conversation-session-not-found">Conversation not found.</div>'}
        <a class="button secondary" href="/conversations" data-i18n="conversation-session-back">Back to conversations</a>
      </section>
    `, { openMode, activeTab: 'conversations' });
  }
  const suppliedTurns = Array.isArray(record.turns) ? record.turns : [];
  // MetricsStore returns at most 200 ordered turns. Keep a defensive input cap
  // for test doubles/alternate implementations, then sort before the render
  // cap so a reversed bounded result still becomes a forward timeline.
  const sourceTurns = suppliedTurns.slice(0, 1_000);
  const turns = sourceTurns.sort((left, right) => {
    const leftIndex = Number.isSafeInteger(left?.turnIndex) ? left.turnIndex : Number.MAX_SAFE_INTEGER;
    const rightIndex = Number.isSafeInteger(right?.turnIndex) ? right.turnIndex : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    const leftAt = Number.isFinite(Number(left?.promptAtMs)) ? Number(left.promptAtMs) : 0;
    const rightAt = Number.isFinite(Number(right?.promptAtMs)) ? Number(right.promptAtMs) : 0;
    return leftAt - rightAt;
  }).slice(0, 200);
  const turnCount = Number.isSafeInteger(record.turnCount) && record.turnCount >= 0
    ? record.turnCount
    : suppliedTurns.length;
  const truncated = record.truncated === true || suppliedTurns.length > 200 || turnCount > turns.length;
  const sessionId = record.id ?? id ?? '—';
  const timeline = turns.map(conversationSessionTurnView).join('');
  return layout('Conversation', `
    <section class="stack conversation-session-detail-shell">
      ${conversationPrivacyView(openMode, { reliable: true })}
      ${conversationSubnav('sessions')}
      <div class="metrics-heading">
        <div>
          <span class="badge stored" data-i18n="conversation-sessions-label">Reliable hook-backed conversation</span>
          <h1><span data-i18n="conversation-session-heading">Conversation</span> #${escapeHtml(String(sessionId))}</h1>
          <p class="muted" data-i18n="conversation-session-detail-intro">Rounds are ordered by prompt submission inside one Claude Code session. Each panel pairs UserPromptSubmit with the terminal Stop event for the same prompt. Raw session and prompt identifiers are never stored; the device-reported identity is not human authentication.</p>
        </div>
        <a class="button secondary" href="/conversations" data-i18n="conversation-session-back">Back to conversations</a>
      </div>
      <div class="conversation-session-summary">
        <article class="card summary"><span class="muted" data-i18n="conversation-session-turn-count">Turns</span><strong>${escapeHtml(String(turnCount))}</strong></article>
        <article class="card summary"><span class="muted" data-i18n="conversation-session-first-at">First prompt</span><strong>${escapeHtml(conversationDateText(record.firstPromptAtMs))}</strong></article>
        <article class="card summary"><span class="muted" data-i18n="conversation-session-last-at">Latest activity</span><strong>${escapeHtml(conversationDateText(record.lastActivityAtMs))}</strong></article>
      </div>
      ${truncated ? '<div class="notice" role="status" data-i18n="conversation-session-truncated">This conversation exceeds the bounded timeline budget. Only the oldest contiguous prefix, up to 200 turns and 8 MiB of stored text, is shown; open an individual turn for its full stored text.</div>' : ''}
      <div class="conversation-timeline">
        ${timeline || '<p class="empty" data-i18n="conversation-session-empty">No captured turns are available in this conversation.</p>'}
      </div>
    </section>
  `, { openMode, activeTab: 'conversations' });
}

export function conversationRoundDetailView({
  result = null,
  round = null,
  id = null,
  error = null,
  openMode = false,
} = {}) {
  const envelope = result ?? {};
  const record = round ?? envelope.round ?? null;
  const errorText = error ?? envelope.error ?? null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return layout('Conversation round unavailable', `
      <section class="stack conversation-detail-shell">
        ${conversationPrivacyView(openMode, { reliable: true })}
        ${conversationSubnav('sessions')}
        ${errorText
          ? '<div class="notice error" role="alert" data-i18n="conversation-round-read-error">Conversation round could not be loaded.</div>'
          : '<div class="notice error" role="alert" data-i18n="conversation-round-not-found">Reliable conversation round not found.</div>'}
        <a class="button secondary" href="/conversations" data-i18n="conversation-session-back">Back to conversations</a>
      </section>
    `, { openMode, activeTab: 'conversations' });
  }
  const roundId = record.id ?? id ?? '—';
  const state = conversationState(record);
  const prompt = conversationText(record.promptText);
  const response = conversationText(record.responseText);
  const backHref = Number.isSafeInteger(record.conversationSessionId)
    ? `/conversations/session/${record.conversationSessionId}`
    : '/conversations';
  const stateNotice = state === 'failed'
      ? `<div class="notice error"><span data-i18n="conversation-round-failed">Claude Code reported that this round failed.</span> ${conversationFailureView(record.failureCode)}</div>`
      : state === 'unavailable'
        ? '<div class="notice" data-i18n="conversation-round-unavailable">The prompt is preserved, but no final response hook was available before the session ended.</div>'
        : '';
  return layout('Conversation round', `
    <section class="stack conversation-detail-shell" data-conversation-round-id="${escapeHtml(String(roundId))}">
      ${conversationPrivacyView(openMode, { reliable: true })}
      ${conversationSubnav('sessions')}
      ${errorText ? '<div class="notice error" data-i18n="conversation-round-read-error">Conversation round could not be loaded.</div>' : ''}
      <div class="topbar">
        <div>
          <span class="badge stored" data-i18n="conversation-round-label">Reliable user round</span>
          <h1><span data-i18n="conversation-session-turn">Round</span> ${escapeHtml(String(record.turnIndex ?? roundId))}</h1>
          <div class="conversation-detail-meta">
            <span><span data-i18n="conversation-round-prompt-at">Prompt submitted</span>: ${escapeHtml(conversationDateText(record.promptAtMs))}</span>
            <span><span data-i18n="conversation-session-last-at">Latest activity</span>: ${escapeHtml(conversationDateText(record.lastActivityAtMs ?? record.completedAtMs ?? record.promptAtMs))}</span>
            <span><span data-i18n="conversation-member-label">Member label</span>: ${escapeHtml(record.memberLabel ?? '—')}</span>
            <span><span data-i18n="conversation-device">Device</span>: ${escapeHtml(record.deviceName ?? record.deviceId ?? '—')}</span>
            <span><span data-i18n="conversation-account">Account</span>: ${escapeHtml(record.accountAlias ?? '—')}</span>
          </div>
        </div>
        ${conversationStatusView(state)}
      </div>
      <article class="card conversation-text conversation-message conversation-message-user">
        <h2 data-i18n="conversation-user-message">User-submitted message</h2>
        <p class="conversation-prompt-disclaimer muted tiny" data-i18n="conversation-hook-prompt-disclaimer">Captured directly from Claude Code UserPromptSubmit. It is exact client-submitted text, but the device does not authenticate the human identity.</p>
        ${prompt ? `<pre>${escapeHtml(prompt)}</pre>` : '<p class="empty" data-i18n="conversation-empty-prompt">Not captured</p>'}
        ${promptDisplayMetaView({ source: 'claude_hook', suffixOmitted: false })}
        ${record.promptTruncated === true ? '<p class="notice" data-i18n="conversation-round-prompt-truncated">The submitted prompt exceeded the storage bound; only a complete UTF-8 prefix is retained.</p>' : ''}
      </article>
      <article class="card conversation-text conversation-message conversation-message-assistant">
        <h2 data-i18n="conversation-final-response">Final response</h2>
        ${response ? `<pre>${escapeHtml(response)}</pre>` : `<p class="empty" data-i18n="${state === 'pending' ? 'conversation-round-response-pending' : 'conversation-round-empty-response'}">${state === 'pending' ? 'Waiting for the final response.' : 'No final assistant text was reported for this round.'}</p>`}
        ${record.responseTruncated === true ? '<p class="notice" data-i18n="conversation-round-response-truncated">The final response exceeded the storage bound; only a complete UTF-8 prefix is retained.</p>' : ''}
        ${stateNotice}
      </article>
      <a class="button secondary" href="${escapeHtml(backHref)}" data-i18n="conversation-session-back">Back to conversation</a>
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
    ? `<div class="notice error" role="alert"><span data-i18n="conversation-read-error">Captured API turn could not be loaded.</span><br><span class="tiny">${escapeHtml(String(errorText))}</span></div>`
    : '';
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return layout('Captured turn unavailable', `
      <section class="stack conversation-detail-shell">
        ${conversationPrivacyView(openMode)}
        ${conversationSubnav('turns')}
        ${errorNotice || '<div class="notice error" role="alert" data-i18n="conversation-not-found">Captured API turn not found.</div>'}
        <a class="button secondary" href="/conversation-turns" data-i18n="conversation-back">Back to API turns</a>
      </section>
    `, { openMode, activeTab: 'conversations' });
  }
  const conversationId = record.id ?? id ?? '—';
  const state = conversationState(record);
  const promptDisplay = derivePromptDisplay(promptDisplayInput(record, record.promptText ?? record.prompt));
  const prompt = promptDisplay.text;
  const response = conversationText(record.responseText ?? record.response);
  return layout('API fragment', `
    <section class="stack conversation-detail-shell">
      ${conversationPrivacyView(openMode)}
      ${conversationSubnav('turns')}
      ${errorNotice}
      <div class="topbar">
        <div>
          <span class="badge stored" data-i18n="conversations-label">API fragment diagnostics</span>
          <h1><span data-i18n="conversation-detail-heading">API fragment</span> #${escapeHtml(String(conversationId))}</h1>
          <div class="conversation-detail-meta">
            <span><span data-i18n="conversation-captured-at">Captured</span>: ${escapeHtml(conversationDateText(record.startedAtMs))}</span>
            <span><span data-i18n="conversation-member-label">Member label</span>: ${escapeHtml(record.memberLabel ?? '—')}</span>
            <span><span data-i18n="conversation-account">Account</span>: ${escapeHtml(record.accountAlias ?? '—')}</span>
            <span><span data-i18n="conversation-model">Model</span>: ${escapeHtml(record.model ?? '—')}</span>
          </div>
        </div>
        ${conversationStatusView(state)}
      </div>
      <article class="card conversation-text">
        <h2 data-i18n="conversation-prompt">Captured API user text</h2>
        <p class="conversation-prompt-disclaimer muted tiny" data-i18n="conversation-prompt-disclaimer">Captured from the final API user message; it may include client wrappers and is not guaranteed to be the user's original words.</p>
        ${prompt ? `<pre>${escapeHtml(prompt)}</pre>` : '<p class="empty" data-i18n="conversation-empty-prompt">Not captured</p>'}
        ${promptDisplayMetaView(promptDisplay)}
      </article>
      <article class="card conversation-text">
        <h2 data-i18n="conversation-response">Response</h2>
        ${response ? `<pre>${escapeHtml(response)}</pre>` : '<p class="empty" data-i18n="conversation-empty-response">Not captured</p>'}
      </article>
      <a class="button secondary" href="/conversation-turns" data-i18n="conversation-back">Back to API turns</a>
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
  claudeGatewayUrl = null,
  onboardingUrl = null,
  error = null,
  completedDraft = null,
  credentialAlerts = null,
  now = Date.now(),
}) {
  const alerts = credentialAlerts ?? classifyCredentialAlerts(accounts, { now });
  const alertsById = new Map(alerts.accounts
    .filter((entry) => entry.accountId)
    .map((entry) => [entry.accountId, entry]));
  const activeDevices = devices.filter((device) => !device.revoked_at);
  const healthy = alerts.accounts.filter((account) => account.severity === 'ok').length;
  // Claude only: this list feeds the Claude Code card's picker and its quota
  // block. A Codex account here would render Codex quota under a Claude heading
  // and offer a Claude installer for it.
  const selfServiceAccounts = accounts.filter((account) => (
    account.provider === 'claude'
    && ['stored', 'healthy'].includes(account.status)
    && (!account.expires_at || Date.parse(account.expires_at) > Date.now())
  ));
  const selfServiceOptions = selfServiceAccounts.map((account) => (
    `<option value="${escapeHtml(account.id)}">${escapeHtml(account.alias)}${account.email_label ? ` · ${escapeHtml(account.email_label)}` : ''}</option>`
  )).join('');
  const claudeHookProfiles = accounts
    .filter((account) => account.provider === 'claude')
    .map((account) => String(account.alias ?? '')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64))
    .filter(Boolean);
  let conversationHookUpgrade = '';
  try {
    if (claudeGatewayUrl && claudeHookProfiles.length) {
      const endpoint = buildClaudeConversationHookEndpoint(claudeGatewayUrl);
      const updater = renderClaudeConversationHookUpdaterSource({ endpoint });
      const updaterId = 'claude-conversation-hooks-updater';
      const filename = CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME;
      const commands = claudeHookProfiles.map((profile) => (
        `<div class="run-command">${escapeHtml(`node "$HOME/Downloads/${filename}" ${profile}`)}</div>`
      )).join('');
      conversationHookUpgrade = `<article class="card" id="conversation-capture-upgrade">
        <h2 data-i18n="conversation-hook-upgrade-heading">Enable reliable conversations on existing Claude profiles</h2>
        <p data-i18n="conversation-hook-upgrade-copy">This token-free updater preserves existing settings and installs synchronous Claude Code command hooks. It reads each profile's existing mode-600 device token only at event delivery time; it does not log in, rotate, print, or replace any credential.</p>
        <div class="notice"><span data-i18n="conversation-hook-upgrade-privacy">After installation, Claude user-submitted prompts and final visible assistant responses are permanently stored in this console and visible to every console member. Hooks do not deny or terminate Claude, but a failed synchronous command hook may cause bounded delay.</span></div>
        <p class="muted tiny" data-i18n="conversation-hook-version-note">Reliable prompt pairing requires Claude Code 2.1.196 or newer; older clients do not provide the prompt ID needed for reliable rounds.</p>
        <div class="setup-actions">
          <button type="button" data-download-target="${updaterId}" data-download-name="${escapeHtml(filename)}" data-i18n="conversation-hook-download">Download hook updater</button>
          <button type="button" class="secondary" data-copy-target="${updaterId}" data-i18n="conversation-hook-copy">Copy updater source</button>
        </div>
        <details data-persist-details="conversation-hook-updater-source">
          <summary data-i18n="view-script">View script</summary>
          <pre id="${updaterId}">${escapeHtml(updater)}</pre>
        </details>
        <h3 data-i18n="conversation-hook-run-heading">Run once for each installed profile on this device</h3>
        ${commands}
        <p class="muted tiny" data-i18n="conversation-hook-restart-note">Restart Claude Code after the updater completes. Hook failures do not deny or terminate Claude, but a failed synchronous command hook may add bounded delay; delivery failures otherwise exit silently.</p>
      </article>`;
    }
  } catch {
    conversationHookUpgrade = '';
  }
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
    <tr data-account-row="${escapeHtml(account.id)}">
      <td><strong>${escapeHtml(account.alias)}</strong><div class="muted tiny">${escapeHtml(account.provider === 'claude' ? 'Claude Code' : 'Codex')} · ${escapeHtml(account.email_label || 'No email label')}</div></td>
      <td><div class="account-status-stack">${statusBadge(account.status)}${alert ? credentialAlertBadge(alert) : ''}</div>
        ${alert ? `<div class="muted tiny" data-i18n="${credentialAlertLabelKey(alert.code)}">Credential status needs attention.</div>` : ''}
        <div class="muted tiny"><span data-i18n="devices">Devices</span>: <span data-account-device-count>${escapeHtml(account.active_devices ?? '—')}</span></div></td>
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
                <input name="member_label" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="alex" maxlength="64" data-draft-field>
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
            ${selfServiceAccounts.length ? `<form method="post" action="/self-service" class="member-form${memberFormClass}" data-persist-draft="claude-self-service">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <label><span data-i18n="team-account">Team account</span>
                <select name="account_id" required data-draft-field>${selfServiceOptions}</select>
              </label>
              ${memberLabelField}
              <label><span data-i18n="device-name">Device name</span>
                <input name="device_name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="my-macbook" maxlength="64" data-draft-field>
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
            ${primaryCodex && codexSelfServiceReady ? `<form method="post" action="/codex/self-service" class="member-form codex-form${memberFormClass}" data-persist-draft="codex-self-service">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              ${memberLabelField}
              <label><span data-i18n="device-name">Device name</span>
                <input name="device_name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="my-laptop" maxlength="64" data-draft-field>
              </label>
              <div><button type="submit" data-i18n="get-codex">Get Codex installer</button></div>
            </form>` : '<div class="notice" data-i18n="codex-unavailable">Codex self-service enrollment is not configured yet. An administrator must connect dispenser enrollment.</div>'}
            ${primaryCodex?.external?.kind === 'codex-credential' ? `<hr>
            <h3>Or route turns through this console</h3>
            <p class="muted tiny">The installer above pulls a credential and then talks to chatgpt.com directly, so those turns are not metered here. This alternative keeps the credential on the server and meters each device. It needs no dispenser enrollment, only an authorized account.</p>
            <form method="post" action="/self-service" class="member-form${memberFormClass}" data-persist-draft="codex-gateway-self-service">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="account_id" value="${escapeHtml(primaryCodex.id)}">
              ${memberLabelField}
              <label><span data-i18n="device-name">Device name</span>
                <input name="device_name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="my-laptop" maxlength="64" data-draft-field>
              </label>
              <div><button type="submit">Get Codex gateway token</button></div>
            </form>` : ''}
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
          ${conversationHookUpgrade}
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
              <table class="accounts-table">
                <caption class="visually-hidden" data-i18n="accounts-table-caption">Credential accounts and safe health metadata</caption>
                <thead><tr><th scope="col" data-i18n="account">Account</th><th scope="col" data-i18n="status">Status</th><th scope="col" data-i18n="expires">Expires</th><th scope="col" data-i18n="credential-history">Credential history</th><th scope="col" data-i18n="usage-quota">Usage quota</th><th scope="col" data-i18n="action">Action</th></tr></thead>
                <tbody>${accountRows || '<tr><td colspan="6" class="empty" data-i18n="no-accounts">No accounts yet.</td></tr>'}</tbody>
              </table>
            </div>
          </article>
          <article class="card split">
            <h2 data-i18n="add-claude-heading">Add a Claude Code team account</h2>
            <div class="notice"><span data-i18n="add-claude-help">Register the expected owner email once. The owner completes OAuth later from the account's permanent authorization page; no token is handed to an administrator.</span></div>
            <form method="post" action="/accounts" class="stack" autocomplete="off" data-persist-draft="register-claude-account">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="provider" value="claude">
              <label><span data-i18n="account-alias">Account alias</span>
                <input name="alias" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" placeholder="claude-max-1" data-draft-field>
              </label>
              <label><span data-i18n="account-email">Account email label</span>
                <input name="email_label" type="email" placeholder="owner@example.com" maxlength="160" required data-draft-field>
              </label>
              <button type="submit" data-i18n="register-account">Register account</button>
            </form>
          </article>
          <article class="card split">
            <h2 data-i18n="add-codex-heading">Add a Codex team account</h2>
            <div class="notice"><span data-i18n="add-codex-help">Register the alias, then authorize the ChatGPT subscription from the account's own page. No separate codex login on another machine is needed.</span></div>
            <form method="post" action="/accounts" class="stack" autocomplete="off" data-persist-draft="register-codex-account">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="provider" value="codex">
              <label><span data-i18n="account-alias">Account alias</span>
                <input name="alias" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" placeholder="codex-shared-1" data-draft-field>
              </label>
              <label><span data-i18n="account-email-optional">Account email label (optional, checked at authorization)</span>
                <input name="email_label" type="email" placeholder="owner@example.com" maxlength="160" data-draft-field>
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
            ${retiredMachines.length ? `<details class="machine-group" data-retired-machines="${retiredMachines.length}" data-persist-details="retired-machines">
              <summary><span data-i18n="retired-machines">Machines with no active credential</span> (${retiredMachines.length})</summary>
              <div class="machine-list">${retiredMachines.map(entryView).join('')}</div>
            </details>` : ''}
          </article>
        </section>
      </section>
    </div>
  `, { openMode, activeTab: 'overview', completedDraft });
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
        <hr>
        <h2 data-i18n="codex-paste-heading">Or paste an existing auth.json</h2>
        <p class="muted tiny" data-i18n="codex-paste-intro">For when the redirect cannot be completed — a quarantined refresh chain, a browser that cannot reach this console, or a credential minted on another machine. This writes the credential straight into the credential home and clears any refresh quarantine, exactly as a fresh authorization would. Unlike the flow above there is no 15-minute window and no code to spend, so a mistake costs nothing but a retry.</p>
        <form method="post" action="/accounts/${encodeURIComponent(account.id)}/codex-authorization/paste" class="stack" autocomplete="off">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <label><span data-i18n="codex-paste-label">Contents of ~/.codex/auth.json</span>
            <textarea name="credential_json" required minlength="8" spellcheck="false" autocomplete="off" placeholder='{"OPENAI_API_KEY":null,"tokens":{"id_token":"...","access_token":"...","refresh_token":"...","account_id":"..."}}'></textarea>
          </label>
          <button type="submit" data-i18n="codex-paste-submit">Store this credential</button>
        </form>
        <div class="notice error" data-i18n="codex-paste-warning">Paste the auth.json from the login itself, not one taken off a client machine — a distributed copy carries a deliberately invalid refresh_token and would leave the refresh centre unable to renew anything. Clear the clipboard afterwards.</div>
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

function codexUnixInstaller({ assets, endpoint, certPin, token, profileName, clientConfigVersion }) {
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
write_asset profiles.js ${shellSingleQuote(base64Asset(assets, 'profiles.js'))}
write_asset codex-gateway.js ${shellSingleQuote(base64Asset(assets, 'codex-gateway.js'))}
write_asset package.json ${shellSingleQuote(base64Asset(assets, 'package.json'))}
write_asset lib/pinned-request.js ${shellSingleQuote(base64Asset(assets, 'lib/pinned-request.js'))}
write_asset lib/profile-store.js ${shellSingleQuote(base64Asset(assets, 'lib/profile-store.js'))}
write_asset install/install.sh ${shellSingleQuote(base64Asset(assets, 'install/install.sh'))}
write_asset install/systemd/codex-credential.service ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential.service'))}
write_asset install/systemd/codex-credential.timer ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential.timer'))}
write_asset install/systemd/codex-credential-profiles.service ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential-profiles.service'))}
write_asset install/systemd/codex-credential-profiles.timer ${shellSingleQuote(base64Asset(assets, 'install/systemd/codex-credential-profiles.timer'))}
write_asset install/launchd/com.claude-codex-gateway.codex-credential.plist ${shellSingleQuote(base64Asset(assets, 'install/launchd/com.claude-codex-gateway.codex-credential.plist'))}
write_asset install/launchd/com.claude-codex-gateway.codex-credential-profiles.plist ${shellSingleQuote(base64Asset(assets, 'install/launchd/com.claude-codex-gateway.codex-credential-profiles.plist'))}
write_asset install/start-container-loop.sh ${shellSingleQuote(base64Asset(assets, 'install/start-container-loop.sh'))}
write_asset install/diagnose.sh ${shellSingleQuote(base64Asset(assets, 'install/diagnose.sh'))}
chmod 700 "$ROOT/install/install.sh"

TOKEN_FILE="$STAGE/device-token"
umask 077
printf '%s' ${shellSingleQuote(token)} > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

"$ROOT/install/install.sh" \\
  --endpoint ${shellSingleQuote(endpoint)} \\
  --token-file "$TOKEN_FILE" \\
  --profile ${shellSingleQuote(profileName)} \\
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

function codexWindowsInstaller({ assets, endpoint, certPin, token, profileName, clientConfigVersion }) {
  return `$ErrorActionPreference = 'Stop'
$Stage = Join-Path $env:TEMP ('codex-gateway-' + [guid]::NewGuid().ToString('N'))
$Root = Join-Path $Stage 'client-agent'
$StampTmp = $null
$PreviousCredentialToken = $env:CODEX_CRED_TOKEN
$PreviousCredentialEndpoint = $env:CODEX_CRED_ENDPOINT
$PreviousCredentialPin = $env:CODEX_CRED_CERT_PIN
$PreviousProfileRoot = $env:CODEX_CRED_PROFILE_ROOT
$Assets = @{
  'pull.js' = ${powerShellSingleQuote(base64Asset(assets, 'pull.js'))}
  'profiles.js' = ${powerShellSingleQuote(base64Asset(assets, 'profiles.js'))}
  'codex-gateway.js' = ${powerShellSingleQuote(base64Asset(assets, 'codex-gateway.js'))}
  'package.json' = ${powerShellSingleQuote(base64Asset(assets, 'package.json'))}
  'lib/pinned-request.js' = ${powerShellSingleQuote(base64Asset(assets, 'lib/pinned-request.js'))}
  'lib/profile-store.js' = ${powerShellSingleQuote(base64Asset(assets, 'lib/profile-store.js'))}
  'install/windows/install.ps1' = ${powerShellSingleQuote(base64Asset(assets, 'install/windows/install.ps1'))}
  'install/windows/diagnose.ps1' = ${powerShellSingleQuote(base64Asset(assets, 'install/windows/diagnose.ps1'))}
}

try {
  foreach ($Relative in $Assets.Keys) {
    $Target = Join-Path $Root ($Relative -replace '/', '\\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
    [System.IO.File]::WriteAllBytes($Target, [Convert]::FromBase64String($Assets[$Relative]))
  }
  $env:CODEX_CRED_TOKEN = ${powerShellSingleQuote(token)}
  & (Join-Path $Root 'install\\windows\\install.ps1') -Endpoint ${powerShellSingleQuote(endpoint)} -Profile ${powerShellSingleQuote(profileName)} -CertPin ${powerShellSingleQuote(certPin)}
  $Stamp = Join-Path $env:LOCALAPPDATA ${powerShellSingleQuote(CODEX_WINDOWS_CLIENT_CONFIG_VERSION_FILE)}
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Stamp) | Out-Null
  $StampTmp = "$Stamp.$PID.tmp"
  [IO.File]::WriteAllText($StampTmp, ${powerShellSingleQuote(clientConfigVersion)} + "\`r\`n", [Text.UTF8Encoding]::new($false))
  Move-Item -Force $StampTmp $Stamp
  $StampTmp = $null
} finally {
  if ($null -eq $PreviousCredentialToken) { Remove-Item Env:CODEX_CRED_TOKEN -ErrorAction SilentlyContinue } else { $env:CODEX_CRED_TOKEN = $PreviousCredentialToken }
  if ($null -eq $PreviousCredentialEndpoint) { Remove-Item Env:CODEX_CRED_ENDPOINT -ErrorAction SilentlyContinue } else { $env:CODEX_CRED_ENDPOINT = $PreviousCredentialEndpoint }
  if ($null -eq $PreviousCredentialPin) { Remove-Item Env:CODEX_CRED_CERT_PIN -ErrorAction SilentlyContinue } else { $env:CODEX_CRED_CERT_PIN = $PreviousCredentialPin }
  if ($null -eq $PreviousProfileRoot) { Remove-Item Env:CODEX_CRED_PROFILE_ROOT -ErrorAction SilentlyContinue } else { $env:CODEX_CRED_PROFILE_ROOT = $PreviousProfileRoot }
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
  profileName = 'codex-team',
  assets,
  clientConfigVersion = CLIENT_CONFIG_VERSION,
  openMode = false,
}) {
  const safeProfile = String(profileName)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64) || 'codex-team';
  const unixScript = codexUnixInstaller({
    assets,
    endpoint,
    certPin,
    token,
    profileName: safeProfile,
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
        profileName: safeProfile,
        clientConfigVersion,
      }),
      extension: 'ps1',
    },
  ];
  const installerPanels = installers.map(({ platform, label, script, extension }) => {
    const filename = `install-codex-${safeProfile}-${platform}.${extension}`;
    const targetId = `codex-installer-${safeProfile}-${platform}`;
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
      <div class="notice" role="note"><span data-i18n="codex-profile-ready">This installer adds an isolated Codex profile and leaves the default ~/.codex account unchanged.</span> <strong>${escapeHtml(safeProfile)}</strong></div>
      <h1 data-i18n="choose-codex-platform">Choose this device's operating system</h1>
      <p class="muted" data-i18n="one-time-token">This self-contained script has a token scoped to this device and is displayed once. It does not need the private console when it runs. Keep it readable only by you and delete it after installation succeeds.</p>
      <div class="notice" data-i18n="one-platform-only">Use exactly one installer on the device you just enrolled. Do not reuse these scripts on another machine.</div>
      <div class="installer-list">${installerPanels}</div>
      <div class="notice"><span data-i18n="do-not-codex-login">Do not run codex login after installation. The agent writes the subscription credential and refreshes it automatically.</span></div>
      <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
    </section>
  `, { openMode, completedDraft: 'codex-self-service' });
}

export function deviceConfiguredView({ account, device, token, claudeGatewayUrl, openMode = false }) {
  const gateway = claudeGatewayUrl.replace(/\/$/, '');
  const profile = account.alias.replace(/[^A-Za-z0-9._-]/g, '-');
  const hookEndpoint = buildClaudeConversationHookEndpoint(gateway);
  const hookUpdater = renderClaudeConversationHookUpdaterSource({ endpoint: hookEndpoint });
  const hookUpdaterBase64 = Buffer.from(hookUpdater, 'utf8').toString('base64');
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
HOOK_UPDATER_FILE="$CONFIG_ROOT/${CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME}"

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
if [ ! -f "$SETTINGS_FILE" ]; then printf '{}\n' > "$SETTINGS_FILE"; fi
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
cat > "$HOOK_UPDATER_FILE" <<'HOOK_UPDATER'
${hookUpdater}
HOOK_UPDATER
chmod 700 "$HOOK_UPDATER_FILE"
node "$HOOK_UPDATER_FILE" ${shellSingleQuote(profile)} || true
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
$hookUpdater = Join-Path $dir '${CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME}'
[IO.File]::WriteAllText($tokenFile, ${powerShellSingleQuote(token)}, [Text.UTF8Encoding]::new($false))
@'
[Console]::Out.Write([IO.File]::ReadAllText((Join-Path $HOME '.config\\claude-codex-gateway\\claude-${profile}.token')))
'@ | Set-Content -Encoding UTF8 $helper
Copy-Item -Force $helper $defaultHelper
if (-not (Test-Path -LiteralPath $settings -PathType Leaf)) {
  @{} | ConvertTo-Json | Set-Content -Encoding UTF8 $settings
}
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
[IO.File]::WriteAllBytes($hookUpdater, [Convert]::FromBase64String('${hookUpdaterBase64}'))
& node $hookUpdater ${powerShellSingleQuote(profile)}
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
& $defaultWrapper`;

  return layout('Device ready', `
    <section class="card stack">
      <div class="notice success">Device <strong>${escapeHtml(device.name)}</strong> is enrolled for <strong>${escapeHtml(account.alias)}</strong>.</div>
      <h1 data-i18n="claude-copy-now">Copy or download this configuration now</h1>
      <p class="muted" data-i18n="claude-one-time-token">This device token is displayed once and cannot be recovered from the control plane. The launcher injects it only into Claude Code's explicit gateway mode, which scrubs it from child-process environments, so no local sandbox package is required. Re-enroll if it is lost, and delete the downloaded installer after use.</p>
      <div class="notice error" data-i18n="conversation-hook-installer-privacy">This profile permanently stores Claude user-submitted prompts and final visible assistant responses in the console, where all console members can read them. Hooks do not deny or terminate Claude and do not change the device token, but a failed synchronous command hook may cause bounded delay.</div>
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
  `, { openMode, completedDraft: 'claude-self-service' });
}

/**
 * The Codex counterpart of `deviceConfiguredView`.
 *
 * Deliberately configuration, not an installer. The Claude page can generate a
 * launcher because it owns the whole profile; pointing the Codex CLI at the
 * gateway is two settings in a file the user already has, and a script that
 * rewrote `config.toml` would be far more likely to clobber someone's existing
 * setup than to save them a step.
 *
 * `model_provider` rather than `chatgpt_base_url`: the CLI sends plugin,
 * analytics and apps traffic to the latter, none of which this gateway proxies
 * or should proxy. Overriding only the provider leaves that traffic on its
 * normal path and routes just the turns.
 *
 * `env_key`, not `requires_openai_auth`: the latter makes the CLI authenticate
 * with the ChatGPT token from its own `auth.json`, which this gateway would
 * reject — the whole point is that the device presents a device token and never
 * holds the subscription credential. Verified against codex-cli 0.138.0, which
 * refuses to start with `Missing environment variable` when the named variable
 * is absent.
 */
export function codexDeviceConfiguredView({
  account, device, token, codexGatewayUrl, tokenEnvVar = 'CODEX_GATEWAY_TOKEN', openMode = false,
}) {
  const gateway = String(codexGatewayUrl ?? '').replace(/\/$/, '');
  const profile = account.alias.replace(/[^A-Za-z0-9._-]/g, '-');
  const configToml = `# ~/.codex/config.toml
# model_provider is a top-level key. It must sit ABOVE every [table]; appending
# this block to a config that already has one binds it into that table instead.
model_provider = "gateway"

[model_providers.gateway]
name = "gateway"
base_url = "${gateway}"
wire_api = "responses"
env_key = "${tokenEnvVar}"`;
  const tokenExport = `export ${tokenEnvVar}=${shellSingleQuote(token)}`;
  return layout('Codex device configured', `
    <section class="stack">
      <div class="notice success">Device <strong>${escapeHtml(device.name)}</strong> is enrolled for <strong>${escapeHtml(account.alias)}</strong>.</div>
      <h1>Copy this token now</h1>
      <p class="muted">This device token is displayed once and cannot be recovered from the control plane. Re-enroll if it is lost.</p>
      <h2>1. Token</h2>
      <pre id="codex-token">${escapeHtml(tokenExport)}</pre>
      <div class="setup-actions">
        <button type="button" class="secondary" data-copy-target="codex-token">Copy token</button>
      </div>
      <h2>2. Point the Codex CLI at the gateway</h2>
      <pre id="codex-config">${escapeHtml(configToml)}</pre>
      <div class="setup-actions">
        <button type="button" data-download-target="codex-config" data-download-name="codex-${escapeHtml(profile)}-config.toml">Download config.toml</button>
        <button type="button" class="secondary" data-copy-target="codex-config">Copy configuration</button>
      </div>
      <div class="notice">Turns now go through the console, which meters them per device. Nothing else is proxied, so a device holding no ChatGPT sign-in of its own loses the features that need one — <code>codex cloud</code>, plugin and app listings, and the quota figures in <code>codex /status</code>. Running a turn needs none of them.</div>
      <div class="notice">On Windows PowerShell the token is set with <code>$env:${escapeHtml(tokenEnvVar)} = '&lt;token&gt;'</code>, not <code>export</code>.</div>
      <div class="notice" data-i18n="closing-hides-token">Closing or refreshing this page permanently hides the credential.</div>
      <a class="button secondary" href="/" data-i18n="back-dashboard">Back to dashboard</a>
    </section>
  `, { openMode, completedDraft: 'codex-gateway-self-service' });
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
