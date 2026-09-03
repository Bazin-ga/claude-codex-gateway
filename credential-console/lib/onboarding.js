import {
  CLAUDE_CLIENT_CONFIG_VERSION_KEY,
  CODEX_UNIX_CLIENT_CONFIG_VERSION_FILE,
  CODEX_WINDOWS_CLIENT_CONFIG_VERSION_FILE,
} from './client-config-version.js';

export const ONBOARDING_SCHEMA_VERSION = 1;
export const CLAUDE_PROFILE_VERSION_KEY = CLAUDE_CLIENT_CONFIG_VERSION_KEY;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Account ids are `randomBytes(12).toString('base64url')`, whose alphabet is
 * `[A-Za-z0-9_-]` — so about one id in 32 begins with `-` or `_`.
 *
 * This pattern used to demand an alphanumeric first character, borrowed from
 * the rule for *aliases*, which are human-typed. Applied to machine-generated
 * ids it silently dropped ~3% of accounts from the guide that member machines
 * read, with no error anywhere. Measured: 28 rejections in 1000 ids.
 *
 * Only the anchor changes; the character set is the same, and the value is
 * still escaped by `markdownText` before it reaches a table cell, so nothing
 * about injection safety depends on which of these characters comes first.
 */
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_PIN = /^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/;
const MARKDOWN_FENCE = '```';
const MARKDOWN_INLINE = '`';
const SAFE_STATUS = new Set([
  'available',
  'healthy',
  'stored',
  'unhealthy',
  'login_required',
  'authorization_required',
  'expired',
  'disabled',
  'unavailable',
]);

function safeVersion(value) {
  return typeof value === 'string' && SAFE_VERSION.test(value) ? value : 'unavailable';
}

function safeAccountId(value) {
  return typeof value === 'string' && SAFE_ACCOUNT_ID.test(value) ? value : null;
}

function safeStatus(value) {
  return typeof value === 'string' && SAFE_STATUS.has(value) ? value : 'unavailable';
}

// Exported so the docs page can show a base URL under exactly the same rule the
// generated guide uses: no credentials, no query, no fragment, and nothing for a
// loopback address a member could not reach anyway.
export function sanitizeUrl(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n`]/.test(value)) {
    return { url: null, state: 'unavailable' };
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { url: null, state: 'unavailable_invalid' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { url: null, state: 'unavailable_invalid' };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(hostname)) {
    return { url: null, state: 'unavailable_localhost' };
  }
  // Deliberately discard credentials, query and fragment rather than ever
  // reflecting them into a machine-readable guide.
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return { url: parsed.toString().replace(/\/$/, ''), state: 'configured' };
}

export function buildOnboardingGuideUrl(consoleUrl) {
  const safeConsoleUrl = sanitizeUrl(consoleUrl);
  return safeConsoleUrl.url ? `${safeConsoleUrl.url}/onboarding.md` : null;
}

function safePin(value) {
  if (typeof value !== 'string') return null;
  const pin = value.trim();
  return SAFE_PIN.test(pin) ? pin.toLowerCase() : null;
}

function markdownText(value, { max = 256 } = {}) {
  return String(value ?? '')
    .slice(0, max)
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('|', '\\|')
    .replaceAll('<', '\\<')
    .replaceAll('>', '\\>');
}

function inlineCode(value) {
  return `\`${String(value ?? '').replaceAll('`', '\\`')}\``;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"")}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeAccounts(accounts, provider) {
  if (!Array.isArray(accounts)) return [];
  const seen = new Set();
  return accounts
    .filter((account) => account?.provider === provider)
    .map((account) => {
      const id = safeAccountId(account.id);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const alias = typeof account.alias === 'string'
        ? account.alias.replace(/[\r\n]+/g, ' ').slice(0, 128)
        : null;
      if (!alias) return null;
      return { id, alias, status: safeStatus(account.status) };
    })
    .filter(Boolean);
}

function urlLine(label, entry) {
  if (entry.url) return `- ${label}: ${inlineCode(entry.url)}`;
  if (entry.state === 'unavailable_localhost') {
    return `- ${label}: unavailable (localhost fallback is not a remote machine endpoint)`;
  }
  return `- ${label}: unavailable (${entry.state.replaceAll('_', ' ')})`;
}

function machineConfig({ consoleUrl, claudeGatewayUrl, clientConfigVersion, adminAuth }) {
  return {
    schema_version: ONBOARDING_SCHEMA_VERSION,
    client_config_version: safeVersion(clientConfigVersion),
    admin_auth: adminAuth === 'open' || adminAuth === 'tailscale' ? adminAuth : 'unknown',
    console_url: consoleUrl.url ?? 'unavailable',
    console_url_state: consoleUrl.state,
    claude_gateway_url: claudeGatewayUrl.url ?? 'unavailable',
    claude_gateway_url_state: claudeGatewayUrl.state,
  };
}

function accountTable(accounts, providerLabel) {
  if (!accounts.length) return `No ${providerLabel} accounts are currently recorded.`;
  return [
    '| Alias | Account ID | Status |',
    '|---|---|---|',
    ...accounts.map((account) => `| ${markdownText(account.alias)} | ${markdownText(account.id)} | ${markdownText(account.status)} |`),
  ].join('\n');
}

function profileStampSection(version) {
  const expected = shellQuote(version);
  const psExpected = powershellQuote(version);
  return `## Profile version check

The server publishes a stable client configuration version. Compare only the stamp line; do not
print or copy the profile because it may contain a device token.

### Unix (Claude profile)

${MARKDOWN_FENCE}sh
EXPECTED=${expected}
PROFILE="\${CLAUDE_PROFILE_FILE:-}"
if [ -z "$PROFILE" ]; then
  PROFILE="$(find "$HOME/.config/claude-codex-gateway" -maxdepth 1 -type f -name 'claude-*.env' -print -quit 2>/dev/null || true)"
fi
ACTUAL=''
if [ -n "$PROFILE" ] && [ -f "$PROFILE" ]; then
  ACTUAL="$(sed -n "s/^export ${CLAUDE_PROFILE_VERSION_KEY}='\\([^']*\\)'$/\\1/p" "$PROFILE" | head -1 || true)"
fi
if [ -z "$ACTUAL" ]; then echo 'missing config stamp: fetch a current web profile'; exit 1; fi
case "$ACTUAL" in [A-Za-z0-9]*) ;; *) echo 'invalid config stamp'; exit 1 ;; esac
case "$ACTUAL" in *[!A-Za-z0-9._-]*) echo 'invalid config stamp'; exit 1 ;; esac
if [ "\${#ACTUAL}" -gt 64 ]; then echo 'invalid config stamp'; exit 1; fi
if [ "$ACTUAL" != "$EXPECTED" ]; then echo "config mismatch: expected $EXPECTED, got $ACTUAL"; exit 1; fi
echo 'config stamp is current'
${MARKDOWN_FENCE}

### Unix (Codex profile)

${MARKDOWN_FENCE}sh
EXPECTED=${expected}
PROFILE="\${CODEX_PROFILE_FILE:-$HOME/${CODEX_UNIX_CLIENT_CONFIG_VERSION_FILE}}"
ACTUAL=''
if [ -f "$PROFILE" ]; then ACTUAL="$(tr -d '\\r\\n' < "$PROFILE" || true)"; fi
if [ -z "$ACTUAL" ]; then echo 'missing config stamp: fetch a current web installer'; exit 1; fi
case "$ACTUAL" in [A-Za-z0-9]*) ;; *) echo 'invalid config stamp'; exit 1 ;; esac
case "$ACTUAL" in *[!A-Za-z0-9._-]*) echo 'invalid config stamp'; exit 1 ;; esac
if [ "\${#ACTUAL}" -gt 64 ]; then echo 'invalid config stamp'; exit 1; fi
if [ "$ACTUAL" != "$EXPECTED" ]; then echo "config mismatch: expected $EXPECTED, got $ACTUAL"; exit 1; fi
echo 'config stamp is current'
${MARKDOWN_FENCE}

### Windows PowerShell

${MARKDOWN_FENCE}powershell
$Expected = ${psExpected}
$Profile = if ($env:CLAUDE_PROFILE_FILE) { Get-Item $env:CLAUDE_PROFILE_FILE -ErrorAction SilentlyContinue } else { Get-ChildItem (Join-Path $HOME '.config\\claude-codex-gateway') -Filter 'claude-*.ps1' -ErrorAction SilentlyContinue | Where-Object { Select-String -LiteralPath $_.FullName -SimpleMatch '$env:${CLAUDE_PROFILE_VERSION_KEY}=' -Quiet } | Select-Object -First 1 }
$Line = if ($Profile) { Select-String -LiteralPath $Profile.FullName -SimpleMatch '$env:${CLAUDE_PROFILE_VERSION_KEY}=' | Select-Object -First 1 -ExpandProperty Line } else { $null }
if (-not $Line) { throw 'missing config stamp: fetch a current web profile' }
$Actual = ($Line -split "'", 3)[1]
if ($Actual -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'invalid config stamp' }
if ($Actual -ne $Expected) { throw "config mismatch: expected $Expected, got $Actual" }
Write-Host 'config stamp is current'
${MARKDOWN_FENCE}

### Windows PowerShell (Codex profile)

${MARKDOWN_FENCE}powershell
$Expected = ${psExpected}
$Profile = if ($env:CODEX_PROFILE_FILE) { $env:CODEX_PROFILE_FILE } else { Join-Path $env:LOCALAPPDATA ${powershellQuote(CODEX_WINDOWS_CLIENT_CONFIG_VERSION_FILE)} }
$Actual = if (Test-Path $Profile) { (Get-Content -LiteralPath $Profile -Raw).Trim() } else { '' }
if (-not $Actual) { throw 'missing config stamp: fetch a current web installer' }
if ($Actual -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'invalid config stamp' }
if ($Actual -ne $Expected) { throw "config mismatch: expected $Expected, got $Actual" }
Write-Host 'config stamp is current'
${MARKDOWN_FENCE}

Rules: compare by exact equality only. Missing means the installed profile predates this contract;
current means proceed; mismatch means stop and report both values to the operator. Never
automatically replace or downgrade a mismatched profile. After the operator approves, generate a
fresh profile/installer from the private console. Never repair a profile by copying a token into it
manually.`;
}

function claudeSection(gatewayUrl, accounts) {
  if (!gatewayUrl.url) {
    return `## Claude Code

The Claude gateway URL is unavailable in the current deployment configuration. Do not invent a
URL or use the console loopback address. First obtain a configured gateway URL from the operator.`;
  }
  const gateway = shellQuote(gatewayUrl.url);
  const statusUrl = shellQuote(`${gatewayUrl.url}/control/v1/status`);
  const accountUrl = shellQuote(`${gatewayUrl.url}/control/v1/account`);
  return `## Claude Code

Use the exact gateway URL below; the control-plane console URL is separate.

${urlLine('Gateway', gatewayUrl)}

For an already-issued device token, check this device and switch only to an account already
allowed for it. Keep the token in an environment variable; this guide never contains one.

${MARKDOWN_FENCE}sh
curl -fsS -H 'Authorization: Bearer '\"$CLAUDE_DEVICE_TOKEN\" ${statusUrl}
curl -fsS -X POST -H 'Authorization: Bearer '\"$CLAUDE_DEVICE_TOKEN\" \\
  -H 'Content-Type: application/json' \\
  --data '{"account_id":"<already-allowed-account-id>"}' ${accountUrl}
${MARKDOWN_FENCE}

The first device credential is issued only by the private web self-service page. There is no
machine-control enroll endpoint. Available account metadata:

${accountTable(accounts, 'Claude')}

The profile must stamp ${MARKDOWN_INLINE}${CLAUDE_PROFILE_VERSION_KEY}${MARKDOWN_INLINE}; use the read-only checks below before
starting Claude Code.`;
}

function codexSection(endpoint, pin, accounts) {
  const configured = endpoint.url || pin;
  if (!configured) {
    return `## Codex

The Codex dispenser is not configured in the current deployment. Do not invent an endpoint or
certificate pin. First issuance remains on the existing web self-service flow; this guide never
provides an enrollment key or an enroll API.

Available Codex account metadata:

${accountTable(accounts, 'Codex')}`;
  }
  return `## Codex

${endpoint.url ? urlLine('Dispenser endpoint', endpoint) : '- Dispenser endpoint: unavailable'}
${pin ? `- Certificate pin: ${inlineCode(pin)}` : '- Certificate pin: unavailable'}

The first device credential is issued through the existing private web self-service page. There
is no machine-control enroll endpoint and no enrollment key in this guide. The current web
installer stamps a non-secret version sidecar; compare it with the read-only profile command.

Available Codex account metadata:

${accountTable(accounts, 'Codex')}`;
}

/**
 * Build the tailnet-internal, real-state onboarding document. The builder only
 * receives safe metadata; it intentionally has no access to CredentialStore
 * internals, tokens, credentials, digests, audit events, or external paths.
 */
export function buildOnboardingMarkdown({
  consoleUrl,
  claudeGatewayUrl,
  clientConfigVersion,
  accounts = [],
  codexEndpoint,
  codexCertPin,
  adminAuth,
} = {}) {
  const safeConsoleUrl = sanitizeUrl(consoleUrl);
  const safeGatewayUrl = sanitizeUrl(claudeGatewayUrl);
  const safeCodexEndpoint = sanitizeUrl(codexEndpoint);
  const safeCodexPin = safePin(codexCertPin);
  const version = safeVersion(clientConfigVersion);
  const safeClaudeAccounts = safeAccounts(accounts, 'claude');
  const safeCodexAccounts = safeAccounts(accounts, 'codex');
  const config = machineConfig({
    consoleUrl: safeConsoleUrl,
    claudeGatewayUrl: safeGatewayUrl,
    clientConfigVersion: version,
    adminAuth,
  });

  return `# Internal AI onboarding guide

This document is generated from the current console configuration. It is available only through
the private console route and contains routing/account metadata, never bearer tokens or provider
credentials.

<!-- claude-codex-gateway:onboarding
${JSON.stringify(config)}
-->

## Current endpoints

${urlLine('Console', safeConsoleUrl)}
${urlLine('Claude gateway', safeGatewayUrl)}
- Administrator mode: ${markdownText(config.admin_auth)}
- Client configuration version: ${inlineCode(version)}

${claudeSection(safeGatewayUrl, safeClaudeAccounts)}

${codexSection(safeCodexEndpoint, safeCodexPin, safeCodexAccounts)}

${profileStampSection(version)}
`;
}
