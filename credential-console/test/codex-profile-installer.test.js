import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { CODEX_AGENT_ASSETS } from '../server.js';
import { codexConfiguredView } from '../lib/views.js';

const execFileAsync = promisify(execFile);
const claim = 'https://api.openai.com/auth';

function jwt(payload) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function decodeHtml(text) {
  return text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

test('the generated Codex profile installer works in a clean home without touching default auth', {
  timeout: 30_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'console-codex-profile-installer-'));
  const home = join(directory, 'home');
  const fakeBin = join(directory, 'bin');
  const keyPath = join(directory, 'server.key');
  const certPath = join(directory, 'server.crt');
  const scriptPath = join(directory, 'installer.sh');
  const loopPid = join(home, '.cache', 'claude-codex-gateway', 'codex-credential-profiles-loop.pid');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const server = createServer({ key, cert }, (_request, response) => {
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      access_token: jwt({ exp }),
      id_token: jwt({ [claim]: { chatgpt_account_id: 'outer-profile-account' } }),
      account_id: 'outer-profile-account',
      expires_at: new Date(exp * 1000).toISOString(),
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try {
      const pid = Number((await readFile(loopPid, 'utf8')).trim());
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
    } catch {}
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const assets = Object.fromEntries(await Promise.all([...CODEX_AGENT_ASSETS].map(async ([name, relative]) => [
    name,
    await readFile(new URL(`../../codex-credential/client-agent/${relative}`, import.meta.url), 'utf8'),
  ])));
  const token = 'outer-profile-device-token-marker';
  const pin = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
  const html = codexConfiguredView({
    deviceName: 'outer-profile-device',
    token,
    endpoint: `https://127.0.0.1:${server.address().port}`,
    certPin: pin,
    profileName: 'team-a',
    assets,
  });
  const encoded = html.match(/<pre id="codex-installer-team-a-linux">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(encoded);
  await writeFile(scriptPath, decodeHtml(encoded), { mode: 0o700 });
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'auth.json'), 'default-auth-sentinel\n', { mode: 0o600 });
  await mkdir(fakeBin, { recursive: true });
  for (const [name, body] of [
    ['codex', '#!/bin/sh\nexit 0\n'],
    ['systemctl', '#!/bin/sh\nexit 1\n'],
    ['loginctl', '#!/bin/sh\nexit 1\n'],
  ]) {
    await writeFile(join(fakeBin, name), body, { mode: 0o700 });
    await chmod(join(fakeBin, name), 0o700);
  }
  const { stdout, stderr } = await execFileAsync('bash', [scriptPath], {
    env: {
      ...process.env,
      HOME: home,
      USER: 'profile-test',
      CODEX_HOME: join(directory, 'inherited-home-must-not-win'),
      PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(stdout.includes(token), false);
  assert.equal(stderr.includes(token), false);
  assert.equal(await readFile(join(home, '.codex', 'auth.json'), 'utf8'), 'default-auth-sentinel\n');
  const profileRoot = join(home, '.local', 'share', 'claude-codex-gateway', 'codex-profiles');
  const auth = JSON.parse(await readFile(join(profileRoot, 'team-a', 'codex-home', 'auth.json'), 'utf8'));
  assert.equal(auth.tokens.account_id, 'outer-profile-account');
  assert.equal(auth.tokens.refresh_token, '');
  assert.equal(JSON.parse(await readFile(join(profileRoot, 'selected.json'), 'utf8')).profile, 'team-a');
  assert.equal((await stat(join(home, '.local', 'bin', 'codex-gateway'))).mode & 0o777, 0o700);
  assert.equal(await readFile(join(home, '.config', 'claude-codex-gateway', 'client-agent', 'config-version'), 'utf8'), '2\n');
});
