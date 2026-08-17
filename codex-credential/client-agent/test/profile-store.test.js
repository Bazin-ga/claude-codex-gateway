import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, link, writeFile, chmod, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  ProfileStore,
  validateName,
  validateSource,
} from '../lib/profile-store.js';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-profile-store-'));
  const store = new ProfileStore({
    root,
    clock: () => new Date('2026-08-17T12:00:00.000Z'),
    random: (() => {
      let n = 0;
      return () => `test${++n}`;
    })(),
    ...options,
  });
  return { root, store };
}

function jwt(payload) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function completeAuth(store, name, account = 'acct@example.test') {
  const profile = await store.readProfile(name);
  await writeFile(join(profile.codex_home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({ exp: Math.floor(Date.parse('2026-08-24T12:00:00.000Z') / 1000) }),
      id_token: 'id-token-secret',
      account_id: account,
      refresh_token: '',
    },
    last_refresh: '2026-08-17T12:00:00.000Z',
  }), { mode: 0o600 });
  await chmod(join(profile.codex_home, 'auth.json'), 0o600);
  return profile;
}

test('validates names and rejects traversal, separators, nul, and reserved names', () => {
  assert.equal(validateName('Team-A_01'), 'Team-A_01');
  for (const value of ['', '.', '..', '../escape', 'a/b', 'a\\b', '/tmp', 'a\u0000b', '-bad', '_bad']) {
    assert.throws(() => validateName(value), { code: 'ERR_INVALID_PROFILE_NAME' });
  }
});

test('validates an HTTPS origin, pin, and one-line bearer before storing a live source', () => {
  const source = validateSource({
    endpoint: 'https://example.test:8443/',
    pin: 'A'.repeat(64),
    device_bearer: 'device_bearer-123',
  }, { requireBearer: true });
  assert.equal(source.endpoint, 'https://example.test:8443');
  assert.equal(source.pin, 'a'.repeat(64));
  for (const candidate of [
    { endpoint: 'http://example.test', pin: 'a'.repeat(64), device_bearer: 'device-token' },
    { endpoint: 'https://example.test/path', pin: 'a'.repeat(64), device_bearer: 'device-token' },
    { endpoint: 'https://example.test?q=1', pin: 'a'.repeat(64), device_bearer: 'device-token' },
    { endpoint: 'https://example.test', pin: 'short', device_bearer: 'device-token' },
    { endpoint: 'https://example.test', pin: 'a'.repeat(64), device_bearer: 'safe\nINJECT=1' },
  ]) {
    assert.throws(() => validateSource(candidate, { requireBearer: true }), {
      code: 'ERR_INVALID_PROFILE_SOURCE',
    });
  }
});

test('adds, reads, and lists profiles with the documented private layout', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bearer = 'device-bearer-secret';
  await store.addProfile('Personal', {
    endpoint: 'https://dispenser.example.test:8443',
    pin: 'a'.repeat(64),
    device_bearer: bearer,
  });
  await assert.rejects(
    () => store.addProfile('personal', {}),
    { code: 'ERR_PROFILE_EXISTS' },
  );
  const profile = await store.readProfile('Personal');
  assert.equal(profile.source.device_bearer, bearer);
  assert.equal(profile.auth.complete, false);
  const entries = await store.listProfiles();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source.device_bearer, null);
  assert.equal(entries[0].source.has_device_bearer, true);

  const rootStat = await stat(root);
  const profileStat = await stat(join(root, 'Personal'));
  const homeStat = await stat(profile.codex_home);
  const sourceStat = await stat(join(root, 'Personal', 'source.json'));
  assert.equal(rootStat.mode & 0o777, 0o700);
  assert.equal(profileStat.mode & 0o777, 0o700);
  assert.equal(homeStat.mode & 0o777, 0o700);
  assert.equal(sourceStat.mode & 0o777, 0o600);
});

test('binds the account digest once and cannot be changed', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('work', { endpoint: 'https://example.test' });
  const first = 'b'.repeat(64);
  await store.bindDigest('work', first.toUpperCase());
  assert.equal((await store.readProfile('work')).source.account_id_sha256, first);
  await store.bind('work', first);
  await assert.rejects(
    () => store.bindDigest('work', 'c'.repeat(64)),
    { code: 'ERR_PROFILE_DIGEST_IMMUTABLE' },
  );
});

test('selection is atomic and refuses a profile until auth is structurally complete', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('ready', { endpoint: 'https://example.test' });
  await assert.rejects(
    () => store.selectProfile('ready'),
    { code: 'ERR_PROFILE_AUTH_INCOMPLETE' },
  );
  assert.equal(await store.readSelected(), null);
  await completeAuth(store, 'ready');
  await store.bindDigest('ready', createHash('sha256').update('acct@example.test').digest('hex'));
  const selected = await store.select('ready');
  assert.deepEqual(selected, { profile: 'ready', generation: 1 });
  assert.deepEqual(await store.readSelected(), selected);
  const raw = JSON.parse(await readFile(join(root, 'selected.json'), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['generation', 'profile']);
  assert.equal((await stat(join(root, 'selected.json'))).mode & 0o777, 0o600);
});

test('a failed atomic replacement leaves the previous selection and no temp file', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('one', {});
  await completeAuth(store, 'one');
  await store.bindDigest('one', createHash('sha256').update('acct@example.test').digest('hex'));
  await store.selectProfile('one');
  await store.addProfile('two', {});
  await completeAuth(store, 'two');
  await store.bindDigest('two', createHash('sha256').update('acct@example.test').digest('hex'));
  const failing = new ProfileStore({
    root,
    random: () => 'failtest',
    failureHooks: {
      'atomic.beforeRename': () => { throw new Error('rename deliberately failed'); },
    },
  });
  await assert.rejects(() => failing.selectProfile('two'), /rename deliberately failed/);
  assert.deepEqual(await store.readSelected(), { profile: 'one', generation: 1 });
  const rootEntries = await readdir(root);
  assert.equal(rootEntries.some((name) => name.endsWith('.tmp')), false);
});

test('rejects symlink and hard-link replacement of a profile source', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('safe', { endpoint: 'https://example.test' });
  const source = join(root, 'safe', 'source.json');
  const outside = join(root, 'outside.json');
  await writeFile(outside, '{}', { mode: 0o600 });
  await rm(source);
  await symlink(outside, source);
  await assert.rejects(() => store.readProfile('safe'), { code: 'ERR_SYMLINK' });

  await rm(source);
  await link(outside, source);
  await assert.rejects(() => store.readProfile('safe'), { code: 'ERR_HARDLINK' });
});

test('rejects a symlinked root component and hard-linked auth without changing its canary', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-profile-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outside = join(directory, 'outside');
  const redirected = join(directory, 'redirected');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, redirected);
  const redirectedStore = new ProfileStore({ root: join(redirected, 'profiles') });
  await assert.rejects(() => redirectedStore.addProfile('unsafe', {}), { code: 'ERR_SYMLINK' });

  const root = join(directory, 'safe-root');
  const store = new ProfileStore({ root });
  await store.addProfile('safe', { endpoint: 'https://example.test' });
  await store.bindDigest('safe', createHash('sha256').update('account').digest('hex'));
  const profile = await store.readProfile('safe');
  const canary = join(directory, 'canary');
  const authPath = join(profile.codex_home, 'auth.json');
  await writeFile(canary, 'outside-canary', { mode: 0o600 });
  await link(canary, authPath);
  await assert.rejects(() => store.writeProfileAuth('safe', {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { access_token: 'access', id_token: 'identity', account_id: 'account', refresh_token: '' },
    last_refresh: '2026-08-17T12:00:00.000Z',
  }), { code: 'ERR_HARDLINK' });
  assert.equal(await readFile(canary, 'utf8'), 'outside-canary');
});

test('recovers an old private runtime lock but never removes a symlink lock', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('safe', {});
  const lock = join(root, '.runtime.lock');
  await writeFile(lock, '', { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, old, old);
  assert.equal(await store.withRuntimeLock(async () => 'recovered'), 'recovered');
  const outside = join(root, 'outside-lock');
  await writeFile(outside, 'canary', { mode: 0o600 });
  await symlink(outside, lock);
  await assert.rejects(() => store.withRuntimeLock(async () => 'unsafe'), { code: 'ERR_SYMLINK' });
  assert.equal(await readFile(outside, 'utf8'), 'canary');
});

test('never recovers an old-mtime lock while its recorded process is alive', async (t) => {
  const { root, store } = await fixture({ lockTimeoutMs: 120, lockStaleMs: 1000 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('safe', {});
  let release;
  const held = store.withRuntimeLock(async () => new Promise((resolve) => { release = resolve; }));
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  const lock = join(root, '.runtime.lock');
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, old, old);
  const contender = new ProfileStore({ root, lockTimeoutMs: 120, lockStaleMs: 1000 });
  await assert.rejects(() => contender.withRuntimeLock(async () => 'unsafe'), { code: 'ERR_LOCK_BUSY' });
  release('done');
  assert.equal(await held, 'done');
});

test('retries when a lock owner releases between EEXIST and inspection', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('safe', {});
  const lock = join(root, '.runtime.lock');
  await writeFile(lock, '', { mode: 0o600 });
  const checkTarget = store._checkTarget.bind(store);
  let released = false;
  store._checkTarget = async (path, options) => {
    if (!released && path === lock) {
      released = true;
      await rm(lock);
      return null;
    }
    return checkTarget(path, options);
  };
  assert.equal(await store.withRuntimeLock(async () => 'acquired'), 'acquired');
  assert.equal(released, true);
});

test('ignores only private regular crash-temp files at the store root', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.addProfile('safe', {});
  const temp = join(root, 'selected.json.deadbeef.tmp');
  await writeFile(temp, 'partial', { mode: 0o600 });
  assert.equal((await store.listProfiles()).length, 1);
  await rm(temp);
  const outside = join(dirname(root), `outside-temp-${Date.now()}`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, 'canary', { mode: 0o600 });
  await symlink(outside, temp);
  await assert.rejects(() => store.listProfiles(), { code: 'ERR_SYMLINK' });
});

test('detects replacement after rename without chmodding an external symlink target', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = createHash('sha256').update('account').digest('hex');
  await store.addProfile('safe', {
    endpoint: 'https://example.test', pin: 'a'.repeat(64), device_bearer: 'device-token',
  });
  await store.bindDigest('safe', digest);
  const canary = join(root, 'permission-canary');
  await writeFile(canary, 'outside', { mode: 0o644 });
  const attacked = new ProfileStore({
    root,
    failureHooks: {
      'atomic.afterRename': async ({ path }) => {
        if (!path.endsWith('source.json')) return;
        await rm(path);
        await symlink(canary, path);
      },
    },
  });
  await assert.rejects(() => attacked.replaceProfileSource('safe', {
    endpoint: 'https://example.test', pin: 'b'.repeat(64), device_bearer: 'next-token',
  }, digest), { code: 'ERR_SYMLINK' });
  assert.equal((await stat(canary)).mode & 0o777, 0o644);
  assert.equal(await readFile(canary, 'utf8'), 'outside');
});

test('audit is bounded, private, and strips bearer/pin/token-shaped caller data', async (t) => {
  const { root, store } = await fixture({ auditMaxRecords: 3, auditMaxBytes: 4096 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.audit('profile.added', {
    profile: 'safe',
    device_bearer: 'bearer-secret',
    token: 'token-secret',
    pin: 'pin-secret',
    reason: 'created',
  });
  await store.audit('profile.bound', { profile: 'safe', account_id_sha256: 'a'.repeat(64) });
  await store.audit('profile.selected', { profile: 'safe', outcome: 'ok' });
  await store.audit('profile.extra', { profile: 'safe' });
  const records = await store.readAudit();
  assert.equal(records.length, 3);
  const text = await readFile(join(root, 'audit.json'), 'utf8');
  assert.doesNotMatch(text, /bearer-secret|token-secret|pin-secret|account_id_sha256/);
  assert.equal((await stat(join(root, 'audit.json'))).mode & 0o777, 0o600);
});

test('invokes the injectable Windows ACL hardener for directories and atomic files', async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const store = new ProfileStore({
    root,
    platform: 'win32',
    aclHardener: async (path, options) => calls.push({ path, ...options }),
    random: () => 'acltest',
  });
  await store.addProfile('acl', { endpoint: 'https://example.test' });
  await store.audit('profile.added', { profile: 'acl' });
  assert.ok(calls.some((call) => call.directory && call.path.endsWith('codex-home')));
  assert.ok(calls.some((call) => !call.directory && call.path.endsWith('.tmp')));
});
