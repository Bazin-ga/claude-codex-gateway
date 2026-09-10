import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { codexDeviceConfiguredView } from '../lib/views.js';

const execFileAsync = promisify(execFile);

async function newStore() {
  const home = await mkdtemp(join(tmpdir(), 'codex-self-service-'));
  return new CredentialStore(home, { allowKeyInit: true }).init();
}

async function codexAccount(store, { alias = 'codex-shared-1', external } = {}) {
  return store.addAccount({
    provider: 'codex',
    alias,
    emailLabel: '',
    external: external === undefined ? { kind: 'codex-credential', home: '/var/lib/codex-credential' } : external,
  });
}

test('a Codex account can be issued a gateway device token', async () => {
  const store = await newStore();
  const account = await codexAccount(store);

  const issued = await store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
  });

  assert.ok(issued.token, 'a token was minted');
  assert.equal(store.deviceByToken(issued.token).id, issued.device.id);
  // The proxy resolves the account this way, so issuance is only useful if the
  // resolved account is the Codex one.
  const resolved = store.resolveDeviceAccount(issued.device);
  assert.equal(resolved.account.id, account.id);
  assert.equal(resolved.account.provider, 'codex');
  assert.equal(resolved.account.external.kind, 'codex-credential');
});

test('a Codex account that was never authorised cannot be issued a token', async () => {
  const store = await newStore();
  // Registered on the dashboard but never pointed at a credential home: there is
  // nothing for the proxy to read, so a token would only fail later and less
  // legibly.
  const account = await codexAccount(store, { external: null });

  await assert.rejects(
    store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'member@example.com',
      deviceName: 'member-laptop',
    }),
    /not available for gateway self-service/,
  );
});

test('a Claude account still needs its stored credential', async () => {
  const store = await newStore();
  const account = await store.addAccount({
    provider: 'claude',
    alias: 'claude-no-credential',
    emailLabel: 'owner@example.com',
  });

  await assert.rejects(
    store.issueDeviceCredential({
      accountId: account.id,
      memberLabel: 'member@example.com',
      deviceName: 'member-laptop',
    }),
    /not available for gateway self-service/,
    'relaxing the Codex path must not have relaxed the Claude one',
  );
});

/** The page escapes the snippets it renders, so assert on what the user copies. */
function decodeEntities(html) {
  return html
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

test('a cross-provider switch is refused without writing anything', async () => {
  const store = await newStore();
  const codex = await codexAccount(store);
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'claude-target',
    emailLabel: 'owner@example.com',
    credential: { oauth_token: 'claude-target-token' },
  });
  const { device } = await store.issueDeviceCredential({
    accountId: codex.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
  });

  await assert.rejects(
    store.configureDeviceAccount({ deviceId: device.id, selectedAccountId: claude.id, actor: 'test' }),
    /configured for a different provider/,
  );

  // The refusal has to happen before the row is touched. Appending the Claude
  // account would make the allowlist mixed, and that mutation is persisted
  // before anything revalidates it — a crash before the rollback would leave a
  // device that no longer resolves and that this same method could no longer
  // repair, because it reads the policy on entry.
  const stored = store.state.devices.find((entry) => entry.id === device.id);
  assert.deepEqual(stored.allowed_account_ids, [codex.id], 'the allowlist is untouched');
  assert.equal(stored.selected_account_id, codex.id);
  assert.equal(store.resolveDeviceAccount(device).account.id, codex.id, 'the device still resolves');

  // Re-reading from disk proves nothing mixed was persisted and rolled back in
  // a way that could survive a crash at the wrong moment.
  const reopened = await new CredentialStore(store.home, { allowKeyInit: false }).init();
  const persisted = reopened.state.devices.find((entry) => entry.id === device.id);
  assert.deepEqual(persisted.allowed_account_ids, [codex.id]);
});

test('the Codex setup page configures the CLI to send the device token', () => {
  const html = codexDeviceConfiguredView({
    account: { alias: 'codex-shared-1', provider: 'codex' },
    device: { name: 'member-laptop' },
    token: 'sk-ant-api03-EXAMPLE-DEVICE-TOKEN',
    codexGatewayUrl: 'https://console.example/codex-api/',
  });
  const copied = decodeEntities(html);

  assert.match(copied, /base_url = "https:\/\/console\.example\/codex-api"/, 'the trailing slash is trimmed');
  assert.match(copied, /wire_api = "responses"/);
  assert.match(copied, /env_key = "CODEX_GATEWAY_TOKEN"/);
  assert.match(copied, /export CODEX_GATEWAY_TOKEN='sk-ant-api03-EXAMPLE-DEVICE-TOKEN'/);
  assert.match(copied, /CODEX_BIN="\$\(command -v codex \|\| true\)"/);
  assert.match(copied, /NODE_BIN="\$\(command -v node \|\| true\)"/);
  assert.match(copied, /export PATH=\$\(printf '%q' "\$\{CODEX_BIN%\/\*\}:\$\{NODE_BIN%\/\*\}"\):"\\\$PATH"/);
  assert.match(copied, /exec \$\(printf '%q' "\$CODEX_BIN"\) --dangerously-bypass-hook-trust/, 'the launcher captures the executable found at install time');
  assert.equal(copied.includes('exec "$HOME/.local/bin/codex"'), false);
  assert.equal(copied.includes('exec codex --dangerously-bypass-hook-trust'), false);
  // requires_openai_auth would make the CLI send its own ChatGPT token, which
  // the gateway rejects by design.
  assert.equal(html.includes('requires_openai_auth'), false);
  // Claude's launcher variables have no meaning here and would mislead.
  for (const claudeOnly of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_GATEWAY']) {
    assert.equal(html.includes(claudeOnly), false, claudeOnly);
  }
});

test('the generated Codex launcher runs without inheriting the installer PATH', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-gateway-launcher-'));
  const home = join(root, 'home');
  const bin = join(root, 'custom prefix $(not-executed)', 'bin');
  const runtimeBin = join(root, 'node prefix;still-safe', 'bin');
  const fakeCodex = join(bin, 'codex');
  const fakeNode = join(runtimeBin, 'node');
  const setup = join(root, 'setup.sh');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(bin, { recursive: true });
  await mkdir(runtimeBin, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(fakeNode, `#!/bin/sh
export PR18_CAPTURED_NODE=used
exec ${process.execPath} "$@"
`, { mode: 0o700 });
  await writeFile(fakeCodex, `#!/usr/bin/env node
console.log('binary=' + process.argv[1]);
console.log('node_marker=' + process.env.PR18_CAPTURED_NODE);
console.log('codex_home=' + process.env.CODEX_HOME);
console.log('token=' + process.env.CODEX_GATEWAY_TOKEN);
console.log('args=' + process.argv.slice(2).join(' '));
`, { mode: 0o700 });

  const html = codexDeviceConfiguredView({
    account: { alias: 'codex-shared-1', provider: 'codex' },
    device: { name: 'member-laptop' },
    token: 'synthetic-device-token',
    codexGatewayUrl: 'https://console.example/codex-api',
  });
  const encoded = html.match(/<pre id="codex-setup">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(encoded, 'the setup script is rendered');
  await writeFile(setup, decodeEntities(encoded), { mode: 0o700 });

  await execFileAsync('bash', [setup], {
    env: {
      HOME: home,
      PATH: `${bin}:${runtimeBin}:/usr/bin:/bin`,
    },
  });
  const launcher = join(home, '.local', 'bin', 'codex-codex-shared-1');
  const launcherSource = await readFile(launcher, 'utf8');
  assert.equal(launcherSource.includes('$HOME/.local/bin/codex'), false);

  const { stdout } = await execFileAsync('/bin/bash', [launcher, 'hello', 'world'], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
  });
  assert.ok(stdout.includes(`binary=${fakeCodex}\n`));
  assert.match(stdout, /node_marker=used/);
  assert.ok(stdout.includes(`codex_home=${join(home, '.config/claude-codex-gateway/codex-codex-shared-1-home')}\n`));
  assert.match(stdout, /token=synthetic-device-token/);
  assert.match(stdout, /args=--dangerously-bypass-hook-trust hello world/);
});

test('the generated Codex setup fails before writing a profile when no CLI is installed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-gateway-no-cli-'));
  const home = join(root, 'home');
  const emptyPath = join(root, 'empty-bin');
  const setup = join(root, 'setup.sh');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await mkdir(emptyPath, { recursive: true });
  await symlink(process.execPath, join(emptyPath, 'node'));

  const html = codexDeviceConfiguredView({
    account: { alias: 'codex-shared-1', provider: 'codex' },
    device: { name: 'member-laptop' },
    token: 'synthetic-device-token',
    codexGatewayUrl: 'https://console.example/codex-api',
  });
  const encoded = html.match(/<pre id="codex-setup">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(encoded, 'the setup script is rendered');
  await writeFile(setup, decodeEntities(encoded), { mode: 0o700 });

  await assert.rejects(
    execFileAsync('/bin/bash', [setup], { env: { HOME: home, PATH: emptyPath } }),
    (error) => error.code === 1 && /codex: NOT INSTALLED/.test(String(error.stderr)),
  );
  await assert.rejects(
    readFile(join(home, '.config', 'claude-codex-gateway', 'codex-codex-shared-1.token')),
    { code: 'ENOENT' },
  );
});

test('the setup page escapes a hostile alias rather than rendering it', () => {
  const html = codexDeviceConfiguredView({
    account: { alias: '<img src=x onerror=alert(1)>', provider: 'codex' },
    device: { name: '</pre><script>alert(2)</script>' },
    token: 'sk-ant-api03-EXAMPLE',
    codexGatewayUrl: 'https://console.example/codex-api',
  });
  assert.equal(html.includes('<script>alert(2)</script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});
