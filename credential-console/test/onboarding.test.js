import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildOnboardingMarkdown } from '../lib/onboarding.js';

const execFileAsync = promisify(execFile);

const TOKEN_CANARY = 'sk-ant-api03-token-canary-never-output';
const DIGEST_CANARY = 'token_sha256-canary-never-output';
const CREDENTIAL_CANARY = 'oauth-credential-canary-never-output';
const EMAIL_CANARY = 'owner@example.com-never-output';
const EXTERNAL_CANARY = '/var/lib/codex-credential-never-output';
const ENROLLMENT_CANARY = 'enrollment-key-canary-never-output';

function guide(overrides = {}) {
  return buildOnboardingMarkdown({
    consoleUrl: 'https://console.example.ts.net',
    claudeGatewayUrl: 'https://gateway.example.net/claude',
    clientConfigVersion: 'p4-1',
    adminAuth: 'tailscale',
    accounts: [{
      provider: 'claude',
      id: 'account-claude-a',
      alias: 'claude-team-a',
      status: 'healthy',
      email_label: EMAIL_CANARY,
      credential: { oauth_token: CREDENTIAL_CANARY },
      token: TOKEN_CANARY,
      token_sha256: DIGEST_CANARY,
      audit: [{ token: TOKEN_CANARY }],
      external: { home: EXTERNAL_CANARY },
    }, {
      provider: 'codex',
      id: 'account-codex-a',
      alias: 'codex-team-a',
      status: 'healthy',
      credential: { oauth_token: CREDENTIAL_CANARY },
    }],
    codexEndpoint: 'https://codex.example.net:8443',
    codexCertPin: 'ab'.repeat(32),
    ...overrides,
  });
}

test('emits a stable machine-readable version block and safe account metadata', () => {
  const output = guide();
  assert.match(output, /<!-- claude-codex-gateway:onboarding/);
  assert.match(output, /"schema_version":1/);
  assert.match(output, /"client_config_version":"p4-1"/);
  assert.match(output, /"admin_auth":"tailscale"/);
  assert.match(output, /claude-team-a/);
  assert.match(output, /account-claude-a/);
  assert.match(output, /healthy/);
  const claudeSection = output.slice(output.indexOf('## Claude Code'), output.indexOf('## Codex'));
  assert.equal(claudeSection.includes('codex-team-a'), false, 'Codex account must not be mixed into Claude table');
  assert.match(output.slice(output.indexOf('## Codex')), /codex-team-a/);
  assert.match(output, /account-codex-a/);
});

test('never accepts or emits token, digest, credential, audit, email, external path, or enrollment key', () => {
  const output = guide({
    accounts: [{
      provider: 'claude',
      id: 'safe-account',
      alias: 'safe-alias',
      status: 'stored',
      email_label: EMAIL_CANARY,
      credential: { oauth_token: CREDENTIAL_CANARY },
      token: TOKEN_CANARY,
      token_sha256: DIGEST_CANARY,
      audit: [{ event: 'audit-canary' }],
      external: { home: EXTERNAL_CANARY },
      enrollment_key: ENROLLMENT_CANARY,
    }],
    codexEndpoint: 'https://codex.example.net:8443',
    codexCertPin: 'cd'.repeat(32),
  });
  for (const canary of [
    TOKEN_CANARY,
    DIGEST_CANARY,
    CREDENTIAL_CANARY,
    EMAIL_CANARY,
    EXTERNAL_CANARY,
    ENROLLMENT_CANARY,
  ]) assert.equal(output.includes(canary), false, canary);
  for (const forbidden of ['token_sha256', 'oauth_token', 'audit', 'enrollment_key']) {
    assert.equal(output.includes(forbidden), false, forbidden);
  }
  assert.match(output, /CLAUDE_DEVICE_TOKEN/);
  assert.match(output, /CODEX_PROFILE_FILE/);
  assert.match(output, /CREDENTIAL_CONSOLE_CLIENT_CONFIG_VERSION/);
  assert.match(output, /\.config\/claude-codex-gateway\/client-agent\/config-version/);
  assert.match(output, /LOCALAPPDATA.*claude-codex-gateway\\client-agent\\config-version/);
});

test('strips URL userinfo, query, fragment, and rejects localhost fallback', () => {
  const output = guide({
    consoleUrl: 'https://user:password@console.example/path?secret=console#frag',
    claudeGatewayUrl: 'https://user:password@gateway.example/claude?secret=gateway#frag',
    codexEndpoint: 'https://user:password@codex.example:8443?secret=codex#frag',
  });
  assert.match(output, /https:\/\/console\.example\/path/);
  assert.match(output, /https:\/\/gateway\.example\/claude/);
  assert.match(output, /https:\/\/codex\.example:8443/);
  assert.equal(output.includes('password'), false);
  assert.equal(output.includes('secret='), false);
  assert.equal(output.includes('#frag'), false);

  const localhost = guide({
    consoleUrl: 'https://127.0.0.1:9080',
    claudeGatewayUrl: 'https://localhost:10000/claude',
    codexEndpoint: 'https://[::1]:8443',
  });
  assert.match(localhost, /Console: unavailable \(localhost fallback/);
  assert.match(localhost, /Claude gateway: unavailable \(localhost fallback/);
  assert.match(localhost, /Dispenser endpoint: unavailable/);
  assert.equal(localhost.includes('127.0.0.1:9080'), false);
  assert.equal(localhost.includes('localhost:10000'), false);
});

test('neutralizes line and Markdown injection in URLs and version', () => {
  const output = guide({
    consoleUrl: 'https://console.example/ok\n- injected',
    claudeGatewayUrl: 'https://gateway.example/ok`evil',
    clientConfigVersion: 'p4-1\nsecret',
  });
  assert.equal(output.includes('injected'), false);
  assert.equal(output.includes('`evil'), false);
  assert.match(output, /client_config_version":"unavailable"/);
});

test('renders dynamic account state on every build without stale data', () => {
  const accounts = [{ provider: 'claude', id: 'account-a', alias: 'team-a', status: 'healthy' }];
  const first = guide({ accounts });
  accounts[0].status = 'expired';
  accounts.push({ provider: 'claude', id: 'account-b', alias: 'team-b', status: 'stored' });
  const second = guide({ accounts });
  assert.match(first, /team-a.*healthy/s);
  assert.equal(first.includes('team-b'), false);
  assert.match(second, /team-a.*expired/s);
  assert.match(second, /team-b.*stored/s);
});

test('omits unconfigured Codex values and still explains web-only first issuance', () => {
  const output = guide({ codexEndpoint: undefined, codexCertPin: undefined });
  assert.match(output, /Codex dispenser is not configured/);
  assert.equal(output.includes('codex.example.net'), false);
  assert.equal(output.includes('Certificate pin:'), false);
  assert.match(output, /existing web self-service flow/);
  assert.match(output, /Codex[\s\S]*not configured[\s\S]*enrollment key or an enroll API/i);
});

test('contains exact P3 commands and explicit missing/current/mismatch rules', () => {
  const output = guide();
  assert.match(output, /\/control\/v1\/status/);
  assert.match(output, /\/control\/v1\/account/);
  assert.match(output, /already-allowed-account-id/);
  assert.match(output, /missing means/i);
  assert.match(output, /current means proceed/);
  assert.match(output, /mismatch/);
  assert.match(output, /exact equality only/);
  assert.match(output, /never\s+automatically\s+replace\s+or\s+downgrade/i);
  assert.match(output, /generate a\s+fresh profile\/installer/);
  assert.match(output, /claude-\*\.env/);
  assert.match(output, /claude-\*\.ps1/);
  assert.match(output, /client-agent\\config-version/);
  assert.match(output, /first device credential.*private web self-service page/s);
  assert.match(output, /no machine-control enroll endpoint/i);
});

function shellBlockAfter(markdown, heading) {
  const headingAt = markdown.indexOf(heading);
  assert.ok(headingAt >= 0, `missing heading: ${heading}`);
  const start = markdown.indexOf('```sh\n', headingAt);
  assert.ok(start >= 0, `missing shell block after: ${heading}`);
  const bodyStart = start + '```sh\n'.length;
  const end = markdown.indexOf('\n```', bodyStart);
  assert.ok(end >= 0, `unterminated shell block after: ${heading}`);
  return markdown.slice(bodyStart, end);
}

async function runVersionCheck(script, env) {
  try {
    const result = await execFileAsync('bash', ['-e', '-c', script], { env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number(error.code),
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

test('generated Unix version checks execute missing, current, and mismatch paths under set -e', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'credential-console-onboarding-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = guide();
  const claudeCheck = shellBlockAfter(output, '### Unix (Claude profile)');
  const codexCheck = shellBlockAfter(output, '### Unix (Codex profile)');
  const env = {
    ...process.env,
    HOME: root,
    CLAUDE_PROFILE_FILE: '',
    CODEX_PROFILE_FILE: '',
  };

  const claudeMissing = await runVersionCheck(claudeCheck, env);
  assert.notEqual(claudeMissing.code, 0);
  assert.match(claudeMissing.stdout, /missing config stamp/);

  const claudeDir = join(root, '.config', 'claude-codex-gateway');
  const claudeProfile = join(claudeDir, 'claude-test.env');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(claudeProfile, "export CREDENTIAL_CONSOLE_CLIENT_CONFIG_VERSION='p4-1'\n");
  const claudeCurrent = await runVersionCheck(claudeCheck, env);
  assert.equal(claudeCurrent.code, 0);
  assert.match(claudeCurrent.stdout, /config stamp is current/);
  await writeFile(claudeProfile, "export CREDENTIAL_CONSOLE_CLIENT_CONFIG_VERSION='p4-2'\n");
  const claudeMismatch = await runVersionCheck(claudeCheck, env);
  assert.notEqual(claudeMismatch.code, 0);
  assert.match(claudeMismatch.stdout, /config mismatch: expected p4-1, got p4-2/);

  const codexStamp = join(claudeDir, 'client-agent', 'config-version');
  const codexMissing = await runVersionCheck(codexCheck, env);
  assert.notEqual(codexMissing.code, 0);
  assert.match(codexMissing.stdout, /missing config stamp/);
  await mkdir(join(claudeDir, 'client-agent'), { recursive: true });
  await writeFile(codexStamp, 'p4-1\n');
  const codexCurrent = await runVersionCheck(codexCheck, env);
  assert.equal(codexCurrent.code, 0);
  assert.match(codexCurrent.stdout, /config stamp is current/);
  await writeFile(codexStamp, 'p4-2\n');
  const codexMismatch = await runVersionCheck(codexCheck, env);
  assert.notEqual(codexMismatch.code, 0);
  assert.match(codexMismatch.stdout, /config mismatch: expected p4-1, got p4-2/);
});
