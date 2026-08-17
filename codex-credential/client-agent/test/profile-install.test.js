import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const install = new URL('../install/install.sh', import.meta.url).pathname;
const claim = 'https://api.openai.com/auth';

function jwt(payload) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function serverFor(account) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-install-server-'));
  const keyPath = join(directory, 'server.key');
  const certPath = join(directory, 'server.crt');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  let requests = 0;
  const server = createServer({ key, cert }, (_request, response) => {
    requests += 1;
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      access_token: jwt({ exp }),
      id_token: jwt({ [claim]: { chatgpt_account_id: account } }),
      account_id: account,
      expires_at: new Date(exp * 1000).toISOString(),
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `https://127.0.0.1:${server.address().port}`,
    pin: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),
    get requests() { return requests; },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('two profile installers coexist and never modify the default Codex home', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-install-'));
  const home = join(directory, 'home');
  const fakeBin = join(directory, 'bin');
  const alpha = await serverFor('install-account-alpha');
  const beta = await serverFor('install-account-beta');
  const profileLoopPid = join(home, '.cache', 'claude-codex-gateway', 'codex-credential-profiles-loop.pid');
  t.after(async () => {
    try {
      const pid = Number((await readFile(profileLoopPid, 'utf8')).trim());
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
    } catch {
      // The assertion below reports a missing loop; cleanup remains best effort.
    }
    await Promise.all([alpha.close(), beta.close()]);
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(home, '.codex', 'auth.json'), 'personal-sentinel\n', { mode: 0o600 });
  for (const [name, body] of [
    ['codex', '#!/bin/sh\nexit 0\n'],
    ['systemctl', '#!/bin/sh\nexit 1\n'],
    ['loginctl', '#!/bin/sh\nexit 1\n'],
  ]) {
    await writeFile(join(fakeBin, name), body, { mode: 0o700 });
  }
  const tokenFile = join(directory, 'device-token');
  const agentDir = join(home, '.local', 'share', 'claude-codex-gateway', 'client-agent');
  const env = {
    ...process.env,
    HOME: home,
    USER: 'profile-test',
    CODEX_CRED_AGENT_DIR: agentDir,
    CODEX_HOME: join(directory, 'legacy-explicit-home'),
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const run = async (name, fixture, token) => {
    await writeFile(tokenFile, token, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    return execFileAsync('bash', [install,
      '--profile', name,
      '--endpoint', fixture.endpoint,
      '--token-file', tokenFile,
      '--cert-pin', fixture.pin,
    ], { env, maxBuffer: 4 * 1024 * 1024 });
  };

  const alphaToken = 'profile-device-token-alpha';
  const first = await run('alpha', alpha, alphaToken);
  assert.equal(first.stdout.includes(alphaToken), false);
  assert.equal(first.stderr.includes(alphaToken), false);
  assert.equal(await readFile(join(home, '.codex', 'auth.json'), 'utf8'), 'personal-sentinel\n');
  const root = join(home, '.local', 'share', 'claude-codex-gateway', 'codex-profiles');
  const alphaAuthPath = join(root, 'alpha', 'codex-home', 'auth.json');
  const alphaAuth = await readFile(alphaAuthPath);
  assert.equal(JSON.parse(alphaAuth).tokens.refresh_token, '');
  assert.equal((await stat(alphaAuthPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(root, 'selected.json'), 'utf8')).profile, 'alpha');
  assert.equal(await readFile(join(home, '.codex', 'auth.json'), 'utf8'), 'personal-sentinel\n');
  const profileLoop = join(agentDir, 'refresh-loop-codex-credential-profiles.sh');
  const firstLoopPid = Number((await readFile(profileLoopPid, 'utf8')).trim());
  const oldLoop = (await readFile(profileLoop, 'utf8')).replace(/^force=0$/m, 'force=1');
  await writeFile(profileLoop, oldLoop, { mode: 0o700 });
  await chmod(profileLoop, 0o700);

  const betaToken = 'profile-device-token-beta';
  const second = await run('beta', beta, betaToken);
  assert.equal(second.stdout.includes(betaToken), false);
  assert.equal(second.stderr.includes(betaToken), false);
  assert.match(second.stdout, /reconfiguring container refresh loop/);
  assert.notEqual(Number((await readFile(profileLoopPid, 'utf8')).trim()), firstLoopPid);
  assert.equal(JSON.parse(await readFile(join(root, 'selected.json'), 'utf8')).profile, 'beta');
  assert.deepEqual(await readFile(alphaAuthPath), alphaAuth);
  assert.equal(await readFile(join(home, '.codex', 'auth.json'), 'utf8'), 'personal-sentinel\n');
  assert.equal(await readFile(join(home, '.config', 'codex-credential.env'), 'utf8').catch(() => null), null);
  assert.equal((await stat(join(home, '.local', 'bin', 'codex-gateway'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, '.local', 'bin', 'codex-profile-alpha'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, '.local', 'bin', 'codex-profile-beta'))).mode & 0o777, 0o700);
  const alphaRequests = alpha.requests;
  const betaRequests = beta.requests;
  await execFileAsync(join(agentDir, 'run-profiles.sh'), ['--force'], { env });
  assert.equal(alpha.requests, alphaRequests + 1);
  assert.equal(beta.requests, betaRequests + 1);
  const statusResult = await execFileAsync(process.execPath, [join(agentDir, 'profiles.js'), 'status'], {
    env: { ...env, CODEX_CRED_PROFILE_ROOT: root },
  });
  const statusBody = JSON.parse(statusResult.stdout);
  assert.equal(statusBody.selected, 'beta');
  assert.equal(statusBody.profiles.length, 2);
  assert.equal(statusResult.stdout.includes(alphaToken) || statusResult.stdout.includes(betaToken), false);
  const runner = await readFile(join(agentDir, 'run-profiles.sh'), 'utf8');
  assert.match(runner, /pull\.js" --all-profiles/);
  const unit = await readFile(join(home, '.config', 'systemd', 'user', 'codex-credential-profiles.service'), 'utf8');
  assert.equal(unit.includes(alphaToken) || unit.includes(betaToken), false);
  assert.doesNotMatch(unit, /--force/);
  const loop = await readFile(profileLoop, 'utf8');
  assert.match(loop, /^force=0$/m);
  assert.equal(await readFile(join(home, '.config', 'systemd', 'user', 'codex-credential.service'), 'utf8').catch(() => null), null);
  const pid = Number((await readFile(profileLoopPid, 'utf8')).trim());
  assert.equal(Number.isSafeInteger(pid) && pid > 1, true);
  process.kill(pid, 0);
});

test('legacy installer refuses a symlinked credential env target without changing its canary', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-legacy-env-symlink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const config = join(home, '.config');
  const canary = join(directory, 'outside-canary');
  const token = join(directory, 'token');
  await mkdir(config, { recursive: true });
  await writeFile(canary, 'unchanged', { mode: 0o600 });
  await symlink(canary, join(config, 'codex-credential.env'));
  await writeFile(token, 'legacy-device-token', { mode: 0o600 });
  await chmod(token, 0o600);
  await assert.rejects(execFileAsync('bash', [install,
    '--endpoint', 'https://127.0.0.1:8443',
    '--token-file', token,
    '--cert-pin', 'a'.repeat(64),
  ], {
    env: { ...process.env, HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  }));
  assert.equal(await readFile(canary, 'utf8'), 'unchanged');
});

test('installer rejects endpoint shell syntax before writing config or executing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-endpoint-injection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const token = join(directory, 'token');
  const marker = join(directory, 'executed');
  await mkdir(home, { recursive: true });
  await writeFile(token, 'legacy-device-token', { mode: 0o600 });
  await chmod(token, 0o600);
  await assert.rejects(execFileAsync('bash', [install,
    '--endpoint', `https://example.test/$(touch ${marker})`,
    '--token-file', token,
    '--cert-pin', 'a'.repeat(64),
  ], { env: { ...process.env, HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } }));
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
  assert.equal(await readFile(join(home, '.config', 'codex-credential.env'), 'utf8').catch(() => null), null);
});
