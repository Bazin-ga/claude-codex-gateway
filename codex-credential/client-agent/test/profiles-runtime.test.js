import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { launchSelected } from '../codex-gateway.js';
import { ProfileStore } from '../lib/profile-store.js';
import { activateProfile, installProfile, sourceFromEnvFile } from '../profiles.js';
import { pullAllProfiles, pullSelectedProfile } from '../pull.js';

const execFileAsync = promisify(execFile);
const CLAIM = 'https://api.openai.com/auth';

function jwt(payload) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function dispenser(account, { status = 200, errorMarker = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-dispenser-'));
  const keyPath = join(directory, 'server.key');
  const certPath = join(directory, 'server.crt');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  let currentAccount = account;
  let currentStatus = status;
  let generation = 0;
  let requests = 0;
  const server = createServer({ key, cert }, (request, response) => {
    requests += 1;
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    response.writeHead(currentStatus, { 'content-type': 'application/json' });
    if (currentStatus !== 200) {
      response.end(JSON.stringify({ error: errorMarker ?? 'fixed failure' }));
      return;
    }
    generation += 1;
    response.end(JSON.stringify({
      access_token: jwt({ exp, generation }),
      id_token: jwt({ [CLAIM]: { chatgpt_account_id: currentAccount } }),
      account_id: currentAccount,
      expires_at: new Date(exp * 1000).toISOString(),
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `https://127.0.0.1:${server.address().port}`,
    pin: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),
    token: `device-token-${account}`,
    get requests() { return requests; },
    setAccount(value) { currentAccount = value; },
    setStatus(value) { currentStatus = value; },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('two isolated profiles switch atomically without touching the default Codex home', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-runtime-'));
  const alpha = await dispenser('account-alpha');
  const beta = await dispenser('account-beta');
  t.after(async () => {
    await Promise.all([alpha.close(), beta.close()]);
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'profiles');
  const defaultAuth = join(directory, '.codex', 'auth.json');
  await mkdir(join(directory, '.codex'), { recursive: true });
  await writeFile(defaultAuth, 'personal-auth-sentinel\n', { mode: 0o600 });
  const store = new ProfileStore({ root });
  await store.addProfile('alpha', {
    endpoint: alpha.endpoint, pin: alpha.pin, device_bearer: alpha.token,
  });
  await store.addProfile('beta', {
    endpoint: beta.endpoint, pin: beta.pin, device_bearer: beta.token,
  });

  const first = await activateProfile(store, 'alpha');
  assert.equal(first.profile, 'alpha');
  const alphaProfile = await store.readProfile('alpha');
  const alphaAuth = JSON.parse(await readFile(join(alphaProfile.codex_home, 'auth.json'), 'utf8'));
  assert.equal(alphaAuth.tokens.account_id, 'account-alpha');
  assert.equal(alphaAuth.tokens.refresh_token, '');
  assert.equal(await readFile(defaultAuth, 'utf8'), 'personal-auth-sentinel\n');

  const second = await activateProfile(store, 'beta');
  assert.equal(second.profile, 'beta');
  assert.equal((await store.readSelected()).profile, 'beta');
  assert.equal(await readFile(defaultAuth, 'utf8'), 'personal-auth-sentinel\n');
  assert.equal((await store.readProfile('alpha')).auth.complete, true);

  const betaProfile = await store.readProfile('beta');
  const betaBefore = await readFile(join(betaProfile.codex_home, 'auth.json'));
  beta.setAccount('account-attacker');
  await assert.rejects(() => activateProfile(store, 'beta'), /account binding changed/);
  assert.equal((await store.readSelected()).profile, 'beta');
  assert.deepEqual(await readFile(join(betaProfile.codex_home, 'auth.json')), betaBefore);
  assert.equal(await readFile(defaultAuth, 'utf8'), 'personal-auth-sentinel\n');
});

test('profile reinstall rotates only its device source after proving the same bound account', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-reinstall-'));
  const fixture = await dispenser('account-stable');
  t.after(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new ProfileStore({ root: join(directory, 'profiles') });
  const firstSource = { endpoint: fixture.endpoint, pin: fixture.pin, device_bearer: 'device-token-old' };
  await installProfile(store, 'stable', firstSource);
  const before = await store.readProfile('stable');
  const beforeDigest = before.source.account_id_sha256;
  const nextSource = { ...firstSource, device_bearer: 'device-token-new' };
  await installProfile(store, 'stable', nextSource);
  const after = await store.readProfile('stable');
  assert.equal(after.source.device_bearer, 'device-token-new');
  assert.equal(after.source.account_id_sha256, beforeDigest);
  const authBeforeMismatch = await readFile(join(after.codex_home, 'auth.json'));
  fixture.setAccount('account-other');
  await assert.rejects(() => installProfile(store, 'stable', {
    ...nextSource,
    device_bearer: 'device-token-attacker',
  }), /account binding changed/);
  const unchanged = await store.readProfile('stable');
  assert.equal(unchanged.source.device_bearer, 'device-token-new');
  assert.deepEqual(await readFile(join(unchanged.codex_home, 'auth.json')), authBeforeMismatch);
});

test('concurrent timer pulls commit one fresh credential under the runtime lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-concurrency-'));
  const fixture = await dispenser('account-concurrent');
  t.after(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new ProfileStore({ root: join(directory, 'profiles') });
  await store.addProfile('work', {
    endpoint: fixture.endpoint, pin: fixture.pin, device_bearer: fixture.token,
  });
  await activateProfile(store, 'work');
  const profile = await store.readProfile('work');
  const authPath = join(profile.codex_home, 'auth.json');
  const stale = JSON.parse(await readFile(authPath, 'utf8'));
  const exp = Math.floor(Date.now() / 1000) + 60;
  stale.tokens.access_token = jwt({ exp });
  await writeFile(authPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  await chmod(authPath, 0o600);
  const before = fixture.requests;
  await Promise.all(Array.from({ length: 20 }, () => pullSelectedProfile(store)));
  assert.equal(fixture.requests - before, 1);
  assert.equal((await store.readProfile('work')).auth.complete, true);
});

test('the profile timer refreshes unselected profiles and isolates a failing account', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-all-refresh-'));
  const alpha = await dispenser('account-refresh-alpha');
  const beta = await dispenser('account-refresh-beta');
  t.after(async () => {
    await Promise.all([alpha.close(), beta.close()]);
    await rm(directory, { recursive: true, force: true });
  });
  const store = new ProfileStore({ root: join(directory, 'profiles') });
  await installProfile(store, 'alpha', {
    endpoint: alpha.endpoint, pin: alpha.pin, device_bearer: alpha.token,
  });
  await installProfile(store, 'beta', {
    endpoint: beta.endpoint, pin: beta.pin, device_bearer: beta.token,
  });
  assert.equal((await store.readSelected()).profile, 'beta');
  const alphaProfile = await store.readProfile('alpha');
  const betaProfile = await store.readProfile('beta');
  const alphaAuthPath = join(alphaProfile.codex_home, 'auth.json');
  const alphaStale = JSON.parse(await readFile(alphaAuthPath, 'utf8'));
  alphaStale.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) + 60 });
  await writeFile(alphaAuthPath, `${JSON.stringify(alphaStale)}\n`, { mode: 0o600 });
  await chmod(alphaAuthPath, 0o600);
  const alphaBeforeThreshold = alpha.requests;
  const betaBeforeThreshold = beta.requests;
  const thresholdResults = await pullAllProfiles(store);
  assert.deepEqual(thresholdResults, [
    { profile: 'alpha', outcome: 'installed' },
    { profile: 'beta', outcome: 'still_fresh' },
  ]);
  assert.equal(alpha.requests, alphaBeforeThreshold + 1);
  assert.equal(beta.requests, betaBeforeThreshold);
  assert.equal((await store.readSelected()).profile, 'beta');
  const betaAuthPath = join(betaProfile.codex_home, 'auth.json');
  const damagedBeta = JSON.parse(await readFile(betaAuthPath, 'utf8'));
  damagedBeta.tokens.account_id = 'wrong-local-account';
  await writeFile(betaAuthPath, `${JSON.stringify(damagedBeta)}\n`, { mode: 0o600 });
  await chmod(betaAuthPath, 0o600);
  assert.equal((await store.readProfile('beta')).auth.complete, false);
  const alphaBeforeRepair = alpha.requests;
  const betaBeforeRepair = beta.requests;
  const repairResults = await pullAllProfiles(store);
  assert.deepEqual(repairResults, [
    { profile: 'alpha', outcome: 'still_fresh' },
    { profile: 'beta', outcome: 'installed' },
  ]);
  assert.equal(alpha.requests, alphaBeforeRepair);
  assert.equal(beta.requests, betaBeforeRepair + 1);
  assert.equal((await store.readProfile('beta')).auth.complete, true);
  const alphaBeforeFailure = await readFile(join(alphaProfile.codex_home, 'auth.json'));
  const betaBeforeFailure = await readFile(join(betaProfile.codex_home, 'auth.json'));
  const alphaRequests = alpha.requests;
  const betaRequests = beta.requests;

  alpha.setStatus(503);
  await assert.rejects(
    () => pullAllProfiles(store, { force: true }),
    { code: 'ERR_PROFILE_REFRESH_PARTIAL' },
  );
  assert.equal(alpha.requests, alphaRequests + 1);
  assert.equal(beta.requests, betaRequests + 1);
  assert.deepEqual(await readFile(join(alphaProfile.codex_home, 'auth.json')), alphaBeforeFailure);
  assert.notDeepEqual(await readFile(join(betaProfile.codex_home, 'auth.json')), betaBeforeFailure);
  assert.equal((await store.readSelected()).profile, 'beta');

  alpha.setStatus(200);
  const recovered = await pullAllProfiles(store, { force: true });
  assert.deepEqual(recovered.map((item) => item.profile), ['alpha', 'beta']);
  assert.equal(recovered.every((item) => item.outcome === 'installed'), true);
  assert.equal(alpha.requests, alphaRequests + 2);
  assert.equal(beta.requests, betaRequests + 2);
  assert.equal((await store.readSelected()).profile, 'beta');
});

test('the launcher fixes CODEX_HOME per process and later selection does not mutate an old launch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-launcher-'));
  const alpha = await dispenser('account-launch-alpha');
  const beta = await dispenser('account-launch-beta');
  t.after(async () => {
    await Promise.all([alpha.close(), beta.close()]);
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'profiles');
  const store = new ProfileStore({ root });
  await store.addProfile('alpha', { endpoint: alpha.endpoint, pin: alpha.pin, device_bearer: alpha.token });
  await store.addProfile('beta', { endpoint: beta.endpoint, pin: beta.pin, device_bearer: beta.token });
  const launches = [];
  const spawnImpl = (_command, _args, options) => {
    launches.push(options.env.CODEX_HOME);
    assert.equal(options.env.CODEX_CRED_TOKEN, undefined);
    assert.equal(options.env.CODEX_CRED_ENDPOINT, undefined);
    assert.equal(options.env.CODEX_CRED_CERT_PIN, undefined);
    assert.equal(options.env.CODEX_CRED_PROFILE_ROOT, undefined);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  await activateProfile(store, 'alpha');
  const launcherEnv = {
    CODEX_CRED_PROFILE_ROOT: root,
    CODEX_CRED_TOKEN: 'bearer-must-not-reach-codex',
    CODEX_CRED_ENDPOINT: 'https://secret-endpoint.test',
    CODEX_CRED_CERT_PIN: 'a'.repeat(64),
  };
  await launchSelected([], { env: launcherEnv, spawnImpl });
  const firstHome = launches[0];
  await activateProfile(store, 'beta');
  await launchSelected([], { env: launcherEnv, spawnImpl });
  assert.notEqual(launches[1], firstHome);
  assert.equal(firstHome, (await store.readProfile('alpha')).codex_home);
  assert.equal(launches[1], (await store.readProfile('beta')).codex_home);
});

test('env-file profile sources require a private regular file and never echo its bearer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.env');
  const marker = 'device-bearer-secret-marker';
  await writeFile(path, [
    'CODEX_CRED_ENDPOINT=https://example.test:8443',
    `CODEX_CRED_CERT_PIN=${'a'.repeat(64)}`,
    `CODEX_CRED_TOKEN=${marker}`,
    '',
  ].join('\n'), { mode: 0o600 });
  const source = await sourceFromEnvFile(path);
  assert.equal(source.device_bearer, marker);
  await chmod(path, 0o644);
  await assert.rejects(() => sourceFromEnvFile(path), { code: 'ERR_INSECURE_ENV_FILE' });
});
