#!/usr/bin/env node
/**
 * client-agent — fetches a short-lived Codex credential and installs it.
 *
 * Run on a timer (see install/). Idempotent: when the local credential still has
 * comfortable life left it does nothing, so running it more often is harmless.
 *
 * The credential it writes has `refresh_token` set to an empty string. Both
 * halves of that are load-bearing and both were measured against codex-cli 0.145.0:
 *
 *   - the field must be PRESENT — deleting it makes codex fail to parse the file
 *     ("missing field `refresh_token`");
 *   - the value must be INVALID — that is what makes this machine structurally
 *     unable to refresh, so it can never rotate the center's token away and
 *     silently kill every other machine's credential.
 *
 * Verified: a credential in this shape completed a real turn, and left auth.json
 * byte-identical afterwards.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { mkdir, readFile, rename, chmod, open, unlink, lstat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinnedRequest } from './lib/pinned-request.js';
import { DEFAULT_PROFILE_ROOT, ProfileStore, validateSource } from './lib/profile-store.js';

const ENDPOINT = process.env.CODEX_CRED_ENDPOINT; // e.g. https://203.0.113.10:8443
const TOKEN = process.env.CODEX_CRED_TOKEN;
/** SHA-256 of the server certificate, hex. Required — see pinning note below. */
const PIN = process.env.CODEX_CRED_CERT_PIN;

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const AUTH_PATH = join(CODEX_HOME, 'auth.json');
const PROFILE_ROOT = process.env.CODEX_CRED_PROFILE_ROOT ?? DEFAULT_PROFILE_ROOT;

/** Renew once less than this remains. Tokens live ~10 days; 4 days tolerates several missed runs. */
const RENEW_BELOW_DAYS = Number(process.env.CODEX_CRED_RENEW_BELOW_DAYS ?? 4);
const DAY_MS = 86_400_000;

const WINDOWS_ACL_SCRIPT = `
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Kind -eq 'directory') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inherit,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
if ($Kind -eq 'directory') {
  [System.IO.Directory]::SetAccessControl($Target, $acl)
} else {
  [System.IO.File]::SetAccessControl($Target, $acl)
}
`;

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, host: hostname(), ...detail }));
}

/** Replace inherited Windows ACLs with one rule for the current identity. */
export async function hardenWindowsAcl(path, {
  directory = false,
  execFileImpl = execFile,
} = {}) {
  const targetBase64 = Buffer.from(path, 'utf8').toString('base64');
  const command = [
    `$Target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targetBase64}'))`,
    `$Kind='${directory ? 'directory' : 'file'}'`,
    WINDOWS_ACL_SCRIPT,
  ].join(';');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  await new Promise((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      { windowsHide: true },
      (error) => error ? reject(error) : resolve(),
    );
  });
}

/** Read a JWT's `exp` without verifying it — we only need to know when to act. */
export function expiryOf(jwt) {
  const segments = String(jwt ?? '').split('.');
  if (segments.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

function jwtClaims(jwt, field) {
  const segments = String(jwt ?? '').split('.');
  if (segments.length < 2) throw new Error(`${field} is not a JWT`);
  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error(`${field} could not be decoded`);
  }
}

const ACCOUNT_CLAIM = 'https://api.openai.com/auth';

export function validateIssuedCredential(value, { now = Date.now() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dispenser credential has an invalid shape');
  }
  if (Object.hasOwn(value, 'refresh_token')) {
    throw new Error('dispenser credential unexpectedly contains a refresh token');
  }
  const limits = { access_token: 256 * 1024, id_token: 256 * 1024, account_id: 512, expires_at: 64 };
  for (const [field, limit] of Object.entries(limits)) {
    if (typeof value[field] !== 'string' || !value[field] || value[field].length > limit) {
      throw new Error(`dispenser credential ${field} is missing or invalid`);
    }
  }
  const idClaims = jwtClaims(value.id_token, 'id_token');
  const claimedAccount = idClaims?.[ACCOUNT_CLAIM]?.chatgpt_account_id;
  if (typeof claimedAccount !== 'string' || claimedAccount !== value.account_id) {
    throw new Error('dispenser credential account binding does not match its id_token');
  }
  const accessExpiry = expiryOf(value.access_token);
  const publishedExpiry = new Date(value.expires_at);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!accessExpiry || !Number.isFinite(publishedExpiry.getTime()) || !Number.isFinite(nowMs)
    || accessExpiry.getTime() <= nowMs || publishedExpiry.getTime() <= nowMs
    || accessExpiry.getTime() - nowMs > 14 * DAY_MS
    || Math.abs(accessExpiry.getTime() - publishedExpiry.getTime()) > 5 * 60_000) {
    throw new Error('dispenser credential expiry is invalid or inconsistent');
  }
  return {
    access_token: value.access_token,
    id_token: value.id_token,
    account_id: value.account_id,
    expires_at: publishedExpiry.toISOString(),
  };
}

export function accountDigest(accountId) {
  return createHash('sha256').update(String(accountId)).digest('hex');
}

export function authFromCredential(issued, { now = new Date() } = {}) {
  const credential = validateIssuedCredential(issued, { now });
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: credential.access_token,
      id_token: credential.id_token,
      account_id: credential.account_id,
      refresh_token: '',
    },
    last_refresh: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

/**
 * Fetch the credential over TLS with certificate pinning.
 *
 * The pinning itself lives in `lib/pinned-request.js`, shared with `enroll.js` —
 * see that file for why the bearer is attached only after the peer is verified.
 */
export async function fetchCredential({
  endpoint = ENDPOINT,
  token = TOKEN,
  pin = PIN,
} = {}) {
  const { statusCode, body } = await pinnedRequest({
    endpoint,
    path: '/credential',
    method: 'GET',
    pin,
    bearer: token,
  });

  if (statusCode !== 200) {
    throw new Error(`dispenser returned ${statusCode} while fetching a credential`);
  }
  try {
    return validateIssuedCredential(JSON.parse(body));
  } catch {
    throw new Error('dispenser returned an invalid credential document');
  }
}

/** Same crash-safe write as the center: temp + fsync + rename. */
export async function writeAtomic(path, data) {
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink()) throw new Error('credential target is a symbolic link');
    if (!current.isFile() || current.nlink !== 1) throw new Error('credential target is not a private regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  let renamed = false;
  let writtenStat = null;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
      writtenStat = await handle.stat();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    const committed = await lstat(path);
    if (committed.isSymbolicLink() || !committed.isFile() || committed.nlink !== 1
      || !writtenStat || committed.dev !== writtenStat.dev || committed.ino !== writtenStat.ino) {
      throw new Error('credential target changed during atomic commit');
    }
    try {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      // Windows cannot open directories as file handles. Rename remains atomic
      // there, but directory fsync is only available on Unix-like platforms.
      if (process.platform !== 'win32') throw error;
    }
  } finally {
    if (created && !renamed) await unlink(tmp).catch(() => {});
  }
}

export async function currentExpiry(authPath = AUTH_PATH) {
  try {
    const local = JSON.parse(await readFile(authPath, 'utf8'));
    return expiryOf(local?.tokens?.access_token);
  } catch {
    return null; // absent or unreadable — treat as "needs a credential"
  }
}

export async function installCredential(authPath, issued, {
  now = new Date(),
  aclHardener = hardenWindowsAcl,
} = {}) {
  const auth = authFromCredential(issued, { now });
  const home = resolve(dirname(authPath));
  const root = parse(home).root;
  let current = root;
  for (const component of home.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    try {
      const item = await lstat(current);
      if (item.isSymbolicLink() || !item.isDirectory()) {
        throw new Error('credential home contains an unsafe path component');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  await chmod(home, 0o700);
  if (process.platform === 'win32') await aclHardener(home, { directory: true });
  await writeAtomic(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  if (process.platform === 'win32') await aclHardener(authPath);
  return auth;
}

async function pullTarget({
  endpoint,
  token,
  pin,
  authPath,
  profile = null,
  expectedAccountDigest = null,
  installer = null,
  force = false,
}) {
  const expiry = await currentExpiry(authPath);
  const remainingDays = expiry ? (expiry.getTime() - Date.now()) / DAY_MS : null;
  if (!force && remainingDays !== null && remainingDays > RENEW_BELOW_DAYS) {
    log('still_fresh', {
      ...(profile ? { profile } : {}),
      expires_at: expiry.toISOString(),
      remaining_days: Number(remainingDays.toFixed(2)),
    });
    return { outcome: 'still_fresh', expiry };
  }
  log('pulling', {
    ...(profile ? { profile } : {}),
    reason: expiry ? `${remainingDays.toFixed(2)}d remaining` : 'no usable local credential',
  });
  let issued;
  try {
    issued = await fetchCredential({ endpoint, token, pin });
    if (expectedAccountDigest && accountDigest(issued.account_id) !== expectedAccountDigest) {
      throw new Error('profile account binding changed');
    }
  } catch (err) {
    log('pull_failed', {
      ...(profile ? { profile } : {}),
      reason: err.code ?? err.name ?? 'credential_unavailable',
      impact:
        expiry && remainingDays > 0
          ? `existing credential still valid for ${remainingDays.toFixed(2)} days`
          : 'NO VALID CREDENTIAL — codex will fail on this machine',
    });
    throw err;
  }
  if (installer) await installer(issued);
  else await installCredential(authPath, issued);
  log('installed', { ...(profile ? { profile } : {}), expires_at: issued.expires_at });
  return { outcome: 'installed', issued };
}

async function selectedProfileStore({ allowUnselected = false } = {}) {
  if (process.env.CODEX_HOME) return null;
  const targetPath = allowUnselected ? PROFILE_ROOT : join(PROFILE_ROOT, 'selected.json');
  try {
    const item = await lstat(targetPath);
    if (item.isSymbolicLink() || (allowUnselected ? !item.isDirectory() : !item.isFile())) {
      throw new Error(allowUnselected ? 'profile store is unsafe' : 'selected profile manifest is unsafe');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return new ProfileStore({
    root: PROFILE_ROOT,
    aclHardener: process.platform === 'win32'
      ? async (path, options) => hardenWindowsAcl(path, options)
      : null,
  });
}

export async function pullSelectedProfile(store, { force = false } = {}) {
  return store.withRuntimeLock(async () => {
    const selected = await store.readSelected();
    if (!selected) throw new Error('no Codex profile is selected');
    return pullProfileUnlocked(store, selected.profile, { force });
  });
}

async function pullProfileUnlocked(store, name, { force = false } = {}) {
  const profile = await store.readProfile(name);
  const source = validateSource(profile.source, { requireBearer: true });
  if (!source.account_id_sha256) {
    throw Object.assign(new Error(`profile ${name} has not been account-bound`), {
      code: 'ERR_PROFILE_UNBOUND',
    });
  }
  return pullTarget({
    endpoint: source.endpoint,
    token: source.device_bearer,
    pin: source.pin,
    authPath: join(profile.codex_home, 'auth.json'),
    profile: profile.name,
    expectedAccountDigest: source.account_id_sha256,
    installer: async (issued) => store.writeProfileAuth(
      profile.name,
      authFromCredential(issued),
    ),
    // A future-looking access-token exp is not enough: a truncated auth file
    // or wrong local account_id is unusable and must self-heal immediately.
    force: force || !profile.auth.complete,
  });
}

/** Refresh every installed, account-bound profile without changing selection. */
export async function pullAllProfiles(store, { force = false } = {}) {
  return store.withRuntimeLock(async () => {
    const profileNames = await store.listProfileNames();
    if (!profileNames.length) {
      throw Object.assign(new Error('no Codex profiles are installed'), { code: 'ERR_NO_PROFILES' });
    }
    const results = [];
    const failures = [];
    for (const name of profileNames) {
      try {
        const profile = await store.readProfile(name);
        if (!profile.source.account_id_sha256) {
          log('profile_skipped', { profile: name, reason: 'profile_unbound' });
          results.push({ profile: name, outcome: 'skipped_unbound' });
          continue;
        }
        const result = await pullProfileUnlocked(store, name, { force });
        results.push({ profile: name, outcome: result.outcome });
      } catch (err) {
        failures.push({
          profile: name,
          reason: err.code ?? err.name ?? 'credential_unavailable',
        });
      }
    }
    if (failures.length) {
      throw Object.assign(new Error(`${failures.length} Codex profile refreshes failed`), {
        code: 'ERR_PROFILE_REFRESH_PARTIAL',
        failures,
      });
    }
    return results;
  });
}

async function main() {
  const force = process.argv.includes('--force');
  const allProfiles = process.argv.includes('--all-profiles');
  const profileStore = await selectedProfileStore({ allowUnselected: allProfiles });
  if (profileStore) {
    if (allProfiles) await pullAllProfiles(profileStore, { force });
    else await pullSelectedProfile(profileStore, { force });
    return;
  }
  if (allProfiles) {
    log('misconfigured', { missing: ['selected profile store'] });
    process.exitCode = 2;
    return;
  }
  const missing = ['CODEX_CRED_ENDPOINT', 'CODEX_CRED_TOKEN', 'CODEX_CRED_CERT_PIN'].filter(
    (name) => !process.env[name],
  );
  if (missing.length) {
    log('misconfigured', { missing });
    process.exitCode = 2;
    return;
  }
  await pullTarget({ endpoint: ENDPOINT, token: TOKEN, pin: PIN, authPath: AUTH_PATH, force });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('unhandled_failure', { reason: err.code ?? err.name ?? 'unknown' });
    process.exitCode = 1;
  });
}
