import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { CLIENT_CONFIG_VERSION } from '../lib/client-config-version.js';
import { codexConfiguredView, deviceConfiguredView } from '../lib/views.js';

const execFileAsync = promisify(execFile);
const INSTALL_SH = new URL('../../codex-credential/client-agent/install/install.sh', import.meta.url);
const INSTALL_PS1 = new URL('../../codex-credential/client-agent/install/windows/install.ps1', import.meta.url);
const DIAGNOSE_PS1 = new URL('../../codex-credential/client-agent/install/windows/diagnose.ps1', import.meta.url);

const ASSET_NAMES = [
  'pull.js',
  'profiles.js',
  'codex-gateway.js',
  'package.json',
  'lib/pinned-request.js',
  'lib/profile-store.js',
  'install/install.sh',
  'install/systemd/codex-credential.service',
  'install/systemd/codex-credential.timer',
  'install/systemd/codex-credential-profiles.service',
  'install/systemd/codex-credential-profiles.timer',
  'install/launchd/com.claude-codex-gateway.codex-credential.plist',
  'install/launchd/com.claude-codex-gateway.codex-credential-profiles.plist',
  'install/windows/install.ps1',
  'install/windows/diagnose.ps1',
  'install/start-container-loop.sh',
  'install/diagnose.sh',
];

function htmlDecode(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function generatedAssets({ install = null } = {}) {
  return Object.fromEntries(ASSET_NAMES.map((name) => [
    name,
    name === 'install/install.sh'
      ? install ?? '#!/usr/bin/env bash\nexit 0\n'
      : `asset-${name}`,
  ]));
}

function generatedUnixInstaller(assets = generatedAssets()) {
  const html = codexConfiguredView({
    deviceName: 'version-device',
    token: 'synthetic-device-token',
    endpoint: 'https://dispenser.example:8443',
    certPin: 'a'.repeat(64),
    assets,
  });
  const match = html.match(/<pre id="codex-installer-codex-team-macos">([\s\S]*?)<\/pre>/);
  assert.ok(match, 'generated Unix installer should be rendered');
  return htmlDecode(match[1]);
}

function generatedClaudeUnixInstaller() {
  const html = deviceConfiguredView({
    account: { alias: 'claude-version-test' },
    device: { name: 'version-device' },
    token: 'synthetic-device-token',
    claudeGatewayUrl: 'https://gateway.example/claude',
  });
  const match = html.match(/<pre id="unix-config">([\s\S]*?)<\/pre>/);
  assert.ok(match, 'generated Claude Unix installer should be rendered');
  return htmlDecode(match[1]);
}

test('one version source stamps Claude profiles and generated Codex outer installers', () => {
  assert.equal(CLIENT_CONFIG_VERSION, '3');
  const claudeHtml = deviceConfiguredView({
    account: { alias: 'claude-version-test' },
    device: { name: 'version-device' },
    token: 'synthetic-device-token',
    claudeGatewayUrl: 'https://gateway.example/claude',
  });
  assert.match(claudeHtml, /CREDENTIAL_CONSOLE_CLIENT_CONFIG_VERSION/);
  assert.match(claudeHtml, /CREDENTIAL_CONSOLE_CLIENT_CONFIG_VERSION[^\n]*3/);
  assert.match(claudeHtml, /data-completed-draft="claude-self-service"/);
  assert.match(claudeHtml, /WriteAllBytes\(\$hookUpdater, \[Convert\]::FromBase64String/);
  assert.match(claudeHtml, /data-i18n="conversation-hook-installer-privacy"/);
  assert.match(claudeHtml, /Claude user-submitted prompts and final visible assistant responses[\s\S]*do not deny or terminate Claude[\s\S]*failed synchronous command hook[\s\S]*bounded delay/i);
  assert.ok(
    claudeHtml.indexOf('data-i18n="conversation-hook-installer-privacy"')
      < claudeHtml.indexOf('id="unix-config"'),
    'Claude privacy notice must precede the mobile-scrollable installer payload',
  );
  assert.match(claudeHtml, /\.card \{[^}]*min-width: 0/);
  assert.match(claudeHtml, /\.setup-actions \{[^}]*flex-wrap: wrap/);
  assert.match(claudeHtml, /pre \{[^}]*overflow-x: auto;[^}]*white-space: pre-wrap/);

  const codexHtml = codexConfiguredView({
    deviceName: 'codex-version-device',
    token: 'synthetic-codex-token',
    endpoint: 'https://dispenser.example:8443',
    certPin: 'a'.repeat(64),
    assets: generatedAssets(),
  });
  assert.match(codexHtml, /\.config[\\/]claude-codex-gateway[\\/]client-agent/);
  assert.match(codexHtml, /config-version/);
  assert.match(codexHtml, /Join-Path \$env:LOCALAPPDATA/);
  assert.match(codexHtml, /--token-file/);
  assert.match(codexHtml, /--profile/);
  assert.match(codexHtml, /codex-profile-ready/);
  assert.match(codexHtml, /data-completed-draft="codex-self-service"/);
  assert.doesNotMatch(codexHtml, /conversation-hook|Claude user-submitted prompts|final visible assistant responses|synchronous command hook|bounded delay/i);
  assert.match(codexHtml, /\.notice \{[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(codexHtml, /--token synthetic-codex-token/);
  assert.doesNotMatch(codexHtml, /-Token synthetic-codex-token/);
  assert.doesNotMatch(codexHtml, /--config-version/);
  assert.doesNotMatch(codexHtml, /-ConfigVersion/);
});

test('generated Unix outer installer stamps only after the original installer succeeds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'credential-console-client-version-'));
  const home = join(root, 'home');
  const scriptPath = join(root, 'installer.sh');
  t.after(() => rm(root, { recursive: true, force: true }));

  const failing = generatedUnixInstaller(generatedAssets({
    install: '#!/usr/bin/env bash\nset -eu\nexit 17\n',
  }));
  await writeFile(scriptPath, failing, { mode: 0o700 });
  await assert.rejects(execFileAsync('bash', [scriptPath], {
    env: { ...process.env, HOME: home, FAKE_INSTALL_FAIL: '1' },
  }));
  await assert.rejects(
    stat(join(home, '.config/claude-codex-gateway/client-agent/config-version')),
    { code: 'ENOENT' },
  );

  const succeeding = generatedUnixInstaller();
  await writeFile(scriptPath, succeeding, { mode: 0o700 });
  await execFileAsync('bash', [scriptPath], { env: { ...process.env, HOME: home } });
  const stamp = join(home, '.config/claude-codex-gateway/client-agent/config-version');
  assert.equal(await readFile(stamp, 'utf8'), `${CLIENT_CONFIG_VERSION}\n`);
  assert.equal((await stat(stamp)).mode & 0o777, 0o600);
});

test('generated Claude installer adds exact-round hooks without replacing the device token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'credential-console-claude-hooks-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const scriptPath = join(root, 'installer.sh');
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('mkdir', ['-p', bin]);
  const preexistingConfig = join(home, '.config', 'claude-codex-gateway');
  await execFileAsync('mkdir', ['-p', preexistingConfig]);
  await writeFile(
    join(preexistingConfig, 'claude-claude-version-test.settings.json'),
    JSON.stringify({ model: 'preserve-existing-model' }),
    { mode: 0o600 },
  );
  const fakeClaude = join(bin, 'claude');
  await writeFile(fakeClaude, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  await writeFile(scriptPath, generatedClaudeUnixInstaller(), { mode: 0o700 });
  await execFileAsync('bash', [scriptPath], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  const config = join(home, '.config', 'claude-codex-gateway');
  const settings = JSON.parse(await readFile(
    join(config, 'claude-claude-version-test.settings.json'),
    'utf8',
  ));
  assert.equal(settings.model, 'preserve-existing-model');
  for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']) {
    const handlers = settings.hooks[event].flatMap((group) => group.hooks ?? []);
    assert.equal(handlers.length, 1);
    assert.deepEqual(handlers[0].args, [
      join(config, 'conversation-hook-client.mjs'),
      'https://gateway.example/claude/control/v1/conversation-hooks',
      join(config, 'claude-claude-version-test.token'),
    ]);
  }
  assert.equal(
    await readFile(join(config, 'claude-claude-version-test.token'), 'utf8'),
    'synthetic-device-token',
  );
  assert.equal((await stat(join(config, 'conversation-hook-client.mjs'))).mode & 0o777, 0o700);
});

test('legacy client-agent installers remain unchanged and Windows outer script owns the stamp', async () => {
  const install = await readFile(INSTALL_SH, 'utf8');
  const windowsInstall = await readFile(INSTALL_PS1, 'utf8');
  const windowsDiagnose = await readFile(DIAGNOSE_PS1, 'utf8');
  assert.doesNotMatch(install, /CODEX_CRED_CLIENT_CONFIG_VERSION|--config-version/);
  assert.doesNotMatch(windowsInstall, /CODEX_CRED_CLIENT_CONFIG_VERSION|ConfigVersion|config-version/);
  assert.doesNotMatch(windowsDiagnose, /ExpectedConfigVersion|config-version/);

  const generated = generatedUnixInstaller();
  const fetchCall = generated.indexOf('$ROOT/install/install.sh');
  const stampWrite = generated.indexOf('config-version');
  assert.ok(fetchCall >= 0 && stampWrite > fetchCall, 'stamp must follow original installer call');
  assert.match(generated, /printf .*3/);
  assert.equal(generated.includes('synthetic-device-token'), true, 'installer keeps its existing one-time token path');
});

test('Windows profile installation validates its origin and restores temporary credential environment', async () => {
  const windowsInstall = await readFile(INSTALL_PS1, 'utf8');
  assert.match(windowsInstall, /function Normalize-HttpsOrigin/);
  assert.match(windowsInstall, /\[Uri\]::TryCreate/);
  assert.match(windowsInstall, /Scheme -ne 'https'/);
  assert.match(windowsInstall, /UserInfo/);
  assert.match(windowsInstall, /AbsolutePath -ne '\/'/);
  assert.match(windowsInstall, /certificate pin must be a 64-character SHA-256 hex digest/);
  assert.match(windowsInstall, /pull\.js[^\r\n]+--all-profiles/);
  assert.doesNotMatch(windowsInstall, /--all-profiles --force/);

  const html = codexConfiguredView({
    deviceName: 'windows-environment-test',
    token: 'synthetic-device-token',
    endpoint: 'https://dispenser.example:8443',
    certPin: 'a'.repeat(64),
    assets: generatedAssets(),
  });
  const match = html.match(/<pre id="codex-installer-codex-team-windows">([\s\S]*?)<\/pre>/);
  assert.ok(match, 'generated Windows installer should be rendered');
  const generated = htmlDecode(match[1]);
  for (const [variable, previous] of [
    ['CODEX_CRED_TOKEN', 'PreviousCredentialToken'],
    ['CODEX_CRED_ENDPOINT', 'PreviousCredentialEndpoint'],
    ['CODEX_CRED_CERT_PIN', 'PreviousCredentialPin'],
    ['CODEX_CRED_PROFILE_ROOT', 'PreviousProfileRoot'],
  ]) {
    assert.match(generated, new RegExp(`\\$${previous} = \\$env:${variable}`));
    assert.match(generated, new RegExp(`Remove-Item Env:${variable}`));
    assert.match(generated, new RegExp(`\\$env:${variable} = \\$${previous}`));
  }
});
