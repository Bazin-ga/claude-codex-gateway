/**
 * Small, deliberately boring persistence layer for Codex profiles.
 *
 * A profile is a directory, rather than a row in one JSON file.  That gives
 * each Codex home a natural trust boundary and means that a bad profile cannot
 * make the selected profile (or another profile's bearer) readable.  The only
 * state kept at the store root is the selected profile pointer and a bounded,
 * redacted audit trail.
 *
 * This module does not run codex, pull credentials, or switch a process's
 * CODEX_HOME.  Those are intentionally left to the profile runner.  It only
 * owns the on-disk contract and its safety checks.
 */

import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, parse, resolve } from 'node:path';

export const DEFAULT_PROFILE_ROOT = join(
  homedir(),
  '.local',
  'share',
  'claude-codex-gateway',
  'codex-profiles',
);

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const SAFE_EVENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_NAME_BYTES = 64;
const MAX_SOURCE_BYTES = 16 * 1024;
const MAX_SELECTED_BYTES = 4 * 1024;
const DEFAULT_AUDIT_MAX_RECORDS = 256;
const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 15;
const LOCK_STALE_MS = 5 * 60 * 1000;

const OPEN_READ = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const OPEN_WRITE_EXCLUSIVE = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);

const ROOT_LOCK = '.store.lock';
const PROFILE_LOCK = '.bind.lock';
const AUDIT_LOCK = '.audit.lock';
const RUNTIME_LOCK = '.runtime.lock';

function error(code, message, cause = undefined) {
  const err = new Error(message, cause === undefined ? undefined : { cause });
  err.code = code;
  return err;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function asName(value) {
  const name = validateName(value);
  return name;
}

/**
 * Validate a profile name before it can become a path component.
 *
 * The function returns the original value so callers can use it inline.  It
 * does not lower-case names: names remain human-readable, while the store
 * refuses a second name that collides case-insensitively with an existing one.
 */
export function validateName(value) {
  if (typeof value !== 'string' || !PROFILE_NAME.test(value)) {
    throw error(
      'ERR_INVALID_PROFILE_NAME',
      'profile name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}',
    );
  }
  if (byteLength(value) > MAX_NAME_BYTES || value === '.' || value === '..') {
    throw error('ERR_INVALID_PROFILE_NAME', 'profile name is too long or reserved');
  }
  return value;
}

function digest(value) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw error('ERR_INVALID_ACCOUNT_DIGEST', 'account_id_sha256 must be a 64-character hex digest');
  }
  return value.toLowerCase();
}

function nullableText(value, field, { max = 4096 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) {
    throw error('ERR_INVALID_PROFILE_SOURCE', `${field} must be a bounded string or null`);
  }
  return value;
}

function normalizeSource(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw error('ERR_INVALID_PROFILE_SOURCE', 'profile source must be an object');
  }

  // Accept camelCase at the boundary because the runner API is JavaScript,
  // but write one unambiguous snake_case schema on disk.
  const endpoint = input.endpoint;
  const pin = input.pin ?? input.cert_pin;
  const bearer = input.device_bearer
    ?? input.deviceBearer
    ?? input.bearer
    ?? input.token;
  const accountDigest = input.account_id_sha256
    ?? input.accountIdSha256
    ?? null;

  const normalizedDigest = accountDigest === null || accountDigest === undefined || accountDigest === ''
    ? null
    : digest(accountDigest);
  return {
    endpoint: nullableText(endpoint, 'endpoint', { max: 2048 }),
    pin: nullableText(pin, 'pin', { max: 512 }),
    device_bearer: nullableText(bearer, 'device_bearer', { max: 8192 }),
    account_id_sha256: normalizedDigest,
  };
}

/**
 * Validate the source shape used by a live profile.  `ProfileStore` keeps the
 * fields nullable for backwards-compatible empty profiles (the old `add`
 * helper was also used to create a directory before enrollment), while the
 * profiles CLI calls this stricter validator before creating a usable profile.
 */
export function validateSource(input = {}, { requireBearer = false } = {}) {
  const source = normalizeSource(input);
  if (source.endpoint !== null) {
    let url;
    try {
      url = new URL(source.endpoint);
    } catch {
      throw error('ERR_INVALID_PROFILE_SOURCE', 'endpoint must be an absolute https URL');
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
      throw error('ERR_INVALID_PROFILE_SOURCE', 'endpoint must be https without credentials, query, hash, or path');
    }
    source.endpoint = url.origin;
  }
  if (source.pin !== null && !/^[a-f0-9]{64}$/i.test(source.pin)) {
    throw error('ERR_INVALID_PROFILE_SOURCE', 'pin must be a 64-character SHA-256 hex digest');
  }
  if (source.pin !== null) source.pin = source.pin.toLowerCase();
  if (source.device_bearer !== null && !/^[A-Za-z0-9_-]{8,8192}$/.test(source.device_bearer)) {
    throw error('ERR_INVALID_PROFILE_SOURCE', 'device bearer must be unpadded base64url without newlines');
  }
  if (requireBearer && (!source.endpoint || !source.pin || !source.device_bearer)) {
    throw error('ERR_INVALID_PROFILE_SOURCE', 'endpoint, pin, and device bearer are required');
  }
  return source;
}

function normalizeAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error('ERR_INVALID_PROFILE_AUTH', 'profile auth must be an object');
  }
  const tokens = value.tokens;
  if (value.auth_mode !== 'chatgpt' || value.OPENAI_API_KEY !== null
    || !tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw error('ERR_INVALID_PROFILE_AUTH', 'profile auth has an invalid shape');
  }
  for (const field of ['access_token', 'id_token', 'account_id']) {
    if (typeof tokens[field] !== 'string' || !tokens[field] || tokens[field].includes('\u0000')) {
      throw error('ERR_INVALID_PROFILE_AUTH', `profile auth ${field} is missing`);
    }
  }
  if (tokens.refresh_token !== '') {
    throw error('ERR_INVALID_PROFILE_AUTH', 'profile auth refresh_token must be present and empty');
  }
  if (typeof value.last_refresh !== 'string' || !Number.isFinite(Date.parse(value.last_refresh))) {
    throw error('ERR_INVALID_PROFILE_AUTH', 'profile auth last_refresh is invalid');
  }
  return value;
}

function accessExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number') return null;
    const date = new Date(payload.exp * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function nowDate(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw error('ERR_INVALID_CLOCK', 'clock returned an invalid date');
  return date;
}

function randomSuffix(random) {
  const value = typeof random === 'function' ? random() : randomBytes(12);
  const suffix = Buffer.isBuffer(value)
    ? value.toString('hex')
    : typeof value === 'string'
      ? value
      : Buffer.from(String(value)).toString('hex');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffix)) {
    throw error('ERR_INVALID_RANDOM', 'random hook returned an unsafe temporary-file suffix');
  }
  return suffix;
}

function modeIsPrivate(stat) {
  return (stat.mode & 0o077) === 0;
}

function regularStat(stat, path, { privateMode = false } = {}) {
  if (stat.isSymbolicLink()) throw error('ERR_SYMLINK', `${path} is a symbolic link`);
  if (!stat.isFile()) throw error('ERR_UNSAFE_FILE', `${path} is not a regular file`);
  if (stat.nlink !== 1) throw error('ERR_HARDLINK', `${path} has multiple hard links`);
  if (privateMode && !modeIsPrivate(stat)) {
    throw error('ERR_INSECURE_PERMISSIONS', `${path} is more permissive than mode 600`);
  }
}

function directoryStat(stat, path) {
  if (stat.isSymbolicLink()) throw error('ERR_SYMLINK', `${path} is a symbolic link`);
  if (!stat.isDirectory()) throw error('ERR_UNSAFE_DIRECTORY', `${path} is not a directory`);
}

function isNotFound(err) {
  return err?.code === 'ENOENT';
}

function isBusy(err) {
  return err?.code === 'EEXIST' || err?.code === 'EACCES' || err?.code === 'EPERM';
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause?.code === 'EPERM';
  }
}

async function processStartIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, 'utf8');
    const tail = statLine.slice(statLine.lastIndexOf(')') + 2).trim().split(/\s+/);
    return tail[19] ?? null; // proc(5) field 22; tail begins at field 3.
  } catch {
    return null;
  }
}

/**
 * Persistent Codex profile store.
 *
 * Hooks are intentionally dependency-injection points rather than environment
 * variables.  Tests can use a temporary root and deterministic clock/random
 * functions without ever touching a real Codex home.
 *
 * Options:
 *   root / rootDir       store root
 *   clock / now          () => Date|number|string
 *   random              () => string|Buffer (temporary-file suffix)
 *   platform             defaults to process.platform
 *   aclHardener          async (path, {directory, mode}) => void
 *   failureHooks         callbacks or Errors, keyed by atomic operation point
 */
export class ProfileStore {
  constructor(options = {}) {
    const rootValue = options.root ?? options.rootDir ?? DEFAULT_PROFILE_ROOT;
    if (typeof rootValue !== 'string' || !rootValue || rootValue.includes('\u0000')) {
      throw error('ERR_INVALID_ROOT', 'profile store root must be a non-empty path');
    }
    this.root = resolve(rootValue);
    this.selectedPath = join(this.root, 'selected.json');
    this.auditPath = join(this.root, 'audit.json');
    this.clock = options.clock ?? options.now ?? (() => new Date());
    this.random = options.random ?? (() => randomBytes(12));
    this.platform = options.platform ?? process.platform;
    this.aclHardener = options.aclHardener ?? options.windowsAclHardener ?? null;
    this.failureHooks = options.failureHooks ?? options.failures ?? {};
    this.lockTimeoutMs = Math.max(50, Math.min(60_000, Number(options.lockTimeoutMs ?? 10_000)));
    this.lockStaleMs = Math.max(1000, Math.min(60 * 60_000, Number(options.lockStaleMs ?? LOCK_STALE_MS)));
    this.auditMaxRecords = Math.max(
      1,
      Math.min(4096, Number(options.auditMaxRecords ?? DEFAULT_AUDIT_MAX_RECORDS)),
    );
    this.auditMaxBytes = Math.max(
      1024,
      Math.min(1024 * 1024, Number(options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES)),
    );
  }

  validateName(name) {
    return validateName(name);
  }

  profilePath(name) {
    const safeName = asName(name);
    return join(this.root, safeName);
  }

  async _fail(point, context = {}) {
    const shortPoint = point.replace(/^atomic\./, '');
    const aliases = {
      'atomic.beforeOpen': ['open'],
      'atomic.afterOpen': ['opened'],
      'atomic.beforeWrite': ['write'],
      'atomic.beforeSync': ['sync'],
      'atomic.beforeRename': ['rename'],
      'atomic.afterRename': ['renamed'],
      directorySync: ['fsync'],
    }[point] ?? [];
    const hook = this.failureHooks?.[point]
      ?? this.failureHooks?.[shortPoint]
      ?? aliases.map((alias) => this.failureHooks?.[alias]).find(Boolean)
      ?? this.failureHooks?.['*'];
    if (!hook) return;
    if (hook instanceof Error) throw hook;
    if (typeof hook === 'function') {
      const result = await hook({ point, ...context });
      if (result instanceof Error) throw result;
      if (result === false) throw error('ERR_INJECTED_FAILURE', `failure hook rejected ${point}`);
    }
  }

  async _harden(path, { directory, mode }) {
    if (typeof this.aclHardener === 'function') {
      await this.aclHardener(path, { directory, mode });
    }
  }

  async _lstat(path, { optional = false } = {}) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw error('ERR_SYMLINK', `${path} is a symbolic link or junction`);
      return stat;
    } catch (err) {
      if (optional && isNotFound(err)) return null;
      throw err;
    }
  }

  async _ensureRoot() {
    // mkdir({recursive:true}) follows a symlink in an intermediate component.
    // Walk the caller-provided root one component at a time so a redirected
    // parent can never become the profile store by accident.
    const rootPart = parse(this.root).root;
    if (this.root === rootPart) throw error('ERR_INVALID_ROOT', 'profile store root is too broad');
    let current = rootPart;
    for (const component of this.root.slice(rootPart.length).split(/[\\/]+/).filter(Boolean)) {
      current = join(current, component);
      let stat = await this._lstat(current, { optional: true });
      if (!stat) {
        await this._fail('beforeMkdir', { path: current, mode: PROFILE_DIR_MODE });
        await mkdir(current, { mode: PROFILE_DIR_MODE });
        stat = await this._lstat(current);
      }
      directoryStat(stat, current);
    }
    await chmod(this.root, PROFILE_DIR_MODE);
    await this._harden(this.root, { directory: true, mode: PROFILE_DIR_MODE });
    return this.root;
  }

  async _ensureDirectoryTree(path, { mode = PROFILE_DIR_MODE, exclusive = false } = {}) {
    await this._fail('beforeMkdir', { path, mode, exclusive });
    let created = false;
    try {
      if (exclusive) {
        await mkdir(path, { mode });
        created = true;
      } else {
        await mkdir(path, { recursive: true, mode });
      }
    } catch (err) {
      if (!(err?.code === 'EEXIST' && !exclusive)) throw err;
    }
    const stat = await this._lstat(path);
    directoryStat(stat, path);
    await chmod(path, mode);
    await this._harden(path, { directory: true, mode });
    return { path, created };
  }

  async _assertExistingFile(path, { optional = false, privateMode = true, maxBytes = null } = {}) {
    let handle;
    try {
      const before = await this._lstat(path);
      regularStat(before, path, { privateMode });
      handle = await open(path, OPEN_READ);
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw error('ERR_FILE_REPLACED', `${path} changed while being opened`);
      }
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (optional && isNotFound(err)) return null;
      if (err?.code === 'ELOOP') throw error('ERR_SYMLINK', `${path} is a symbolic link`);
      throw err;
    }
    try {
      const stat = await handle.stat();
      regularStat(stat, path, { privateMode });
      if (maxBytes !== null && stat.size > maxBytes) {
        throw error('ERR_FILE_TOO_LARGE', `${path} exceeds its bounded size`);
      }
      return { handle, stat };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  async _readJson(path, { optional = false, maxBytes, privateMode = true } = {}) {
    const opened = await this._assertExistingFile(path, { optional, maxBytes, privateMode });
    if (!opened) return null;
    try {
      const contents = await opened.handle.readFile('utf8');
      try {
        return JSON.parse(contents);
      } catch (cause) {
        throw error('ERR_INVALID_JSON', `${path} is not valid JSON`, cause);
      }
    } finally {
      await opened.handle.close();
    }
  }

  async _checkTarget(path, { optional = true } = {}) {
    let stat;
    try {
      const { lstat } = await import('node:fs/promises');
      stat = await lstat(path);
    } catch (err) {
      if (optional && isNotFound(err)) return null;
      throw err;
    }
    if (stat.isSymbolicLink()) throw error('ERR_SYMLINK', `${path} is a symbolic link`);
    regularStat(stat, path, { privateMode: false });
    return stat;
  }

  async _syncDirectory(path) {
    if (this.platform === 'win32') return;
    await this._fail('directorySync', { path });
    const handle = await open(path, OPEN_READ);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Crash-safe file replacement. The target is never written in place. */
  async _atomicWrite(path, contents, mode, { maxBytes = null } = {}) {
    const data = String(contents);
    if (maxBytes !== null && byteLength(data) > maxBytes) {
      throw error('ERR_FILE_TOO_LARGE', `${path} exceeds its bounded size`);
    }
    await this._checkTarget(path);
    const tmpPath = `${path}.${randomSuffix(this.random)}.tmp`;
    let handle = null;
    let renamed = false;
    let writtenStat = null;
    try {
      await this._fail('atomic.beforeOpen', { path, tmpPath });
      handle = await open(tmpPath, OPEN_WRITE_EXCLUSIVE, mode);
      await this._fail('atomic.afterOpen', { path, tmpPath });
      await handle.chmod(mode);
      await this._harden(tmpPath, { directory: false, mode });
      await this._fail('atomic.beforeWrite', { path, tmpPath, bytes: byteLength(data) });
      await handle.writeFile(data, 'utf8');
      await this._fail('atomic.beforeSync', { path, tmpPath });
      await handle.sync();
      writtenStat = await handle.stat();
      await handle.close();
      handle = null;
      await this._fail('atomic.beforeRename', { path, tmpPath });
      await rename(tmpPath, path);
      renamed = true;
      await this._fail('atomic.afterRename', { path });
      const committed = await lstat(path);
      regularStat(committed, path, { privateMode: true });
      if (!writtenStat || committed.dev !== writtenStat.dev || committed.ino !== writtenStat.ino) {
        throw error('ERR_ATOMIC_REPLACED', `${path} changed during atomic commit`);
      }
      await this._syncDirectory(dirname(path));
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!renamed) await unlink(tmpPath).catch(() => {});
    }
  }

  async _lock(path, callback) {
    const started = Date.now();
    let owned = null;
    while (true) {
      let handle;
      let created = false;
      try {
        handle = await open(path, OPEN_WRITE_EXCLUSIVE, PRIVATE_FILE_MODE);
        created = true;
        const nonce = randomSuffix(this.random);
        const owner = {
          pid: process.pid,
          process_start: await processStartIdentity(process.pid),
          nonce,
          created_at: new Date().toISOString(),
        };
        await handle.writeFile(json(owner));
        await handle.sync();
        const stat = await handle.stat();
        owned = { handle, nonce, dev: stat.dev, ino: stat.ino };
        break;
      } catch (err) {
        if (handle) await handle.close().catch(() => {});
        if (created) await unlink(path).catch(() => {});
        if (!isBusy(err)) throw err;
        // The owner may release the lock between our EEXIST and inspection.
        // Treat that narrow window as another acquisition attempt, not as an
        // I/O failure.  We still fail closed for links and malformed targets.
        let stat = await this._checkTarget(path);
        if (!stat) continue;
        let owner = null;
        try {
          owner = await this._readJson(path, { maxBytes: 4096, privateMode: true });
        } catch (cause) {
          if (isNotFound(cause) || cause?.code === 'ERR_FILE_REPLACED') continue;
          // Invalid locks are recoverable only after the stale threshold.
        }
        const current = await this._checkTarget(path);
        if (!current) continue;
        if (current.dev !== stat.dev || current.ino !== stat.ino) continue;
        stat = current;
        const alive = owner && processAlive(owner.pid);
        const sameProcess = alive && (owner.process_start === null
          || owner.process_start === await processStartIdentity(owner.pid));
        if (!sameProcess && stat && Date.now() - stat.mtimeMs > this.lockStaleMs) {
          const quarantine = `${path}.stale.${randomSuffix(this.random)}`;
          try {
            await rename(path, quarantine);
            const moved = await lstat(quarantine);
            regularStat(moved, quarantine);
            await unlink(quarantine);
            await this._syncDirectory(dirname(path));
            continue;
          } catch (cause) {
            throw error('ERR_LOCK_STALE', `${path} contains a stale lock that could not be quarantined`, cause);
          }
        }
        if (Date.now() - started >= this.lockTimeoutMs) throw error('ERR_LOCK_BUSY', `${path} is locked`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
      }
    }
    try {
      return await callback();
    } finally {
      if (owned) {
        try {
          const current = await lstat(path);
          const contents = JSON.parse(await readFile(path, 'utf8'));
          if (current.dev === owned.dev && current.ino === owned.ino && contents.nonce === owned.nonce) {
            await unlink(path);
          }
        } catch {
          // Never remove a path we cannot prove is the lock acquired above.
        }
        await owned.handle.close().catch(() => {});
      }
    }
  }

  async _rootLock(callback) {
    await this._ensureRoot();
    return this._lock(join(this.root, ROOT_LOCK), callback);
  }

  async withRuntimeLock(callback) {
    await this._ensureRoot();
    return this._lock(join(this.root, RUNTIME_LOCK), callback);
  }

  _profileLock(profilePath, callback) {
    return this._lock(join(profilePath, PROFILE_LOCK), callback);
  }

  async _existingProfile(name) {
    const path = this.profilePath(name);
    const stat = await this._lstat(path, { optional: true });
    if (!stat) throw error('ERR_PROFILE_NOT_FOUND', `profile ${name} does not exist`);
    directoryStat(stat, path);
    return path;
  }

  async _readSource(profilePath) {
    const value = await this._readJson(join(profilePath, 'source.json'), {
      maxBytes: MAX_SOURCE_BYTES,
      privateMode: true,
    });
    if (!value) throw error('ERR_PROFILE_INCOMPLETE', 'profile source.json is missing');
    return validateSource(value);
  }

  async _authStatus(profilePath, source) {
    const homePath = join(profilePath, 'codex-home');
    const homeStat = await this._lstat(homePath, { optional: true });
    if (!homeStat) return { complete: false, reason: 'missing_codex_home' };
    directoryStat(homeStat, homePath);
    const authPath = join(homePath, 'auth.json');
    const auth = await this._readJson(authPath, {
      optional: true,
      maxBytes: 128 * 1024,
      privateMode: true,
    });
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      return { complete: false, reason: 'missing_auth' };
    }
    let normalized;
    try {
      normalized = normalizeAuth(auth);
    } catch {
      return { complete: false, reason: 'invalid_auth' };
    }
    const tokens = normalized.tokens;
    const expiry = accessExpiry(tokens.access_token);
    if (!expiry) return { complete: false, reason: 'invalid_access_expiry' };
    if (!source.account_id_sha256) return { complete: false, reason: 'account_unbound' };
    const actual = createHash('sha256').update(tokens.account_id).digest('hex');
    if (actual !== source.account_id_sha256) {
      return { complete: false, reason: 'account_mismatch' };
    }
    return {
      complete: true,
      account_id_sha256: createHash('sha256').update(tokens.account_id).digest('hex'),
      expires_at: expiry.toISOString(),
      expired: expiry.getTime() <= nowDate(this.clock).getTime(),
    };
  }

  async _profileInfo(name, { includeSecret = true } = {}) {
    const safeName = asName(name);
    const profilePath = await this._existingProfile(safeName);
    const source = await this._readSource(profilePath);
    const homePath = join(profilePath, 'codex-home');
    const homeStat = await this._lstat(homePath, { optional: true });
    if (homeStat) directoryStat(homeStat, homePath);
    const auth = await this._authStatus(profilePath, source);
    const result = {
      name: safeName,
      source: includeSecret ? source : {
        endpoint: source.endpoint,
        pin: source.pin,
        device_bearer: null,
        account_id_sha256: source.account_id_sha256,
        has_device_bearer: Boolean(source.device_bearer),
      },
      codex_home: homePath,
      auth,
    };
    return result;
  }

  /**
   * Add an empty profile. Authentication is deliberately not implied by
   * creating the directory; selectProfile will refuse it until auth.json is
   * complete.
   */
  async addProfile(name, source = {}) {
    const safeName = asName(name);
    const normalized = validateSource(source);
    await this._rootLock(async () => {
      const entries = await this._profileEntries();
      const lower = safeName.toLowerCase();
      if (entries.some((entry) => entry.name.toLowerCase() === lower)) {
        throw error('ERR_PROFILE_EXISTS', `profile ${safeName} already exists`);
      }
      const profilePath = this.profilePath(safeName);
      let profileCreated = false;
      let homeCreated = false;
      try {
        await this._ensureDirectoryTree(profilePath, { mode: PROFILE_DIR_MODE, exclusive: true });
        profileCreated = true;
        await this._ensureDirectoryTree(join(profilePath, 'codex-home'), {
          mode: PROFILE_DIR_MODE,
          exclusive: true,
        });
        homeCreated = true;
        await this._atomicWrite(join(profilePath, 'source.json'), json(normalized), PRIVATE_FILE_MODE, {
          maxBytes: MAX_SOURCE_BYTES,
        });
      } catch (cause) {
        if (profileCreated) await this._cleanupNewProfile(profilePath, { homeCreated });
        throw cause;
      }
    });
    return this._profileInfo(safeName);
  }

  async _cleanupNewProfile(profilePath, { homeCreated }) {
    const sourcePath = join(profilePath, 'source.json');
    const sourceStat = await this._lstat(sourcePath, { optional: true }).catch(() => null);
    if (sourceStat && sourceStat.isFile() && !sourceStat.isSymbolicLink() && sourceStat.nlink === 1) {
      await unlink(sourcePath).catch(() => {});
    }
    const homePath = join(profilePath, 'codex-home');
    if (homeCreated) {
      const homeStat = await this._lstat(homePath, { optional: true }).catch(() => null);
      if (homeStat && homeStat.isDirectory() && !homeStat.isSymbolicLink()) {
        await rmdir(homePath).catch(() => {});
      }
    }
    const profileStat = await this._lstat(profilePath, { optional: true }).catch(() => null);
    if (profileStat && profileStat.isDirectory() && !profileStat.isSymbolicLink()) {
      await rmdir(profilePath).catch(() => {});
    }
  }

  async readProfile(name) {
    await this._ensureRoot();
    return this._profileInfo(name);
  }

  async _profileEntries() {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.root, { withFileTypes: true });
    const profiles = [];
    const seen = new Map();
    for (const entry of entries) {
      if (entry.name === 'selected.json' || entry.name === 'audit.json'
        || entry.name === ROOT_LOCK || entry.name === AUDIT_LOCK || entry.name === RUNTIME_LOCK) continue;
      if (/^(?:selected|audit)\.json\.[A-Za-z0-9_-]{1,128}\.tmp$/.test(entry.name)) {
        const stat = await this._lstat(join(this.root, entry.name));
        regularStat(stat, entry.name, { privateMode: true });
        continue;
      }
      if (entry.name.startsWith('.')) {
        // Temporary files are only ignored when they are ordinary files. A
        // symlink with a temporary-looking name is still an attack surface.
        const stat = await this._lstat(join(this.root, entry.name), { optional: true });
        if (stat?.isSymbolicLink()) throw error('ERR_SYMLINK', `${entry.name} is a symbolic link`);
        continue;
      }
      validateName(entry.name);
      const path = join(this.root, entry.name);
      const stat = await this._lstat(path);
      directoryStat(stat, path);
      const lower = entry.name.toLowerCase();
      if (seen.has(lower)) throw error('ERR_PROFILE_CASE_COLLISION', `profiles ${seen.get(lower)} and ${entry.name} differ only by case`);
      seen.set(lower, entry.name);
      profiles.push({ name: entry.name, path });
    }
    profiles.sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) || left.name.localeCompare(right.name));
    return profiles;
  }

  async listProfiles() {
    await this._ensureRoot();
    const entries = await this._profileEntries();
    const result = [];
    for (const entry of entries) result.push(await this._profileInfo(entry.name, { includeSecret: false }));
    return result;
  }

  async listProfileNames() {
    await this._ensureRoot();
    return (await this._profileEntries()).map((entry) => entry.name);
  }

  list() {
    return this.listProfiles();
  }

  read(name) {
    return this.readProfile(name);
  }

  add(name, source) {
    return this.addProfile(name, source);
  }

  async bindDigest(name, accountIdSha256) {
    const safeName = asName(name);
    const nextDigest = digest(accountIdSha256);
    await this._ensureRoot();
    const profilePath = await this._existingProfile(safeName);
    return this._profileLock(profilePath, async () => {
      const source = await this._readSource(profilePath);
      if (source.account_id_sha256 && source.account_id_sha256 !== nextDigest) {
        throw error('ERR_PROFILE_DIGEST_IMMUTABLE', `profile ${safeName} is already bound to another account digest`);
      }
      if (!source.account_id_sha256) {
        await this._atomicWrite(
          join(profilePath, 'source.json'),
          json({ ...source, account_id_sha256: nextDigest }),
          PRIVATE_FILE_MODE,
          { maxBytes: MAX_SOURCE_BYTES },
        );
      }
      return this._profileInfo(safeName);
    });
  }

  bind(name, accountIdSha256) {
    return this.bindDigest(name, accountIdSha256);
  }

  async writeProfileAuth(name, auth) {
    const safeName = asName(name);
    const normalized = normalizeAuth(auth);
    const actualDigest = createHash('sha256').update(normalized.tokens.account_id).digest('hex');
    await this._ensureRoot();
    const profilePath = await this._existingProfile(safeName);
    return this._profileLock(profilePath, async () => {
      const source = await this._readSource(profilePath);
      if (!source.account_id_sha256 || source.account_id_sha256 !== actualDigest) {
        throw error('ERR_PROFILE_ACCOUNT_MISMATCH', `profile ${safeName} is not bound to this account`);
      }
      await this._atomicWrite(
        join(profilePath, 'codex-home', 'auth.json'),
        json(normalized),
        PRIVATE_FILE_MODE,
        { maxBytes: 128 * 1024 },
      );
      return this._profileInfo(safeName);
    });
  }

  async replaceProfileSource(name, source, expectedAccountDigest) {
    const safeName = asName(name);
    const expected = digest(expectedAccountDigest);
    const candidate = validateSource(source, { requireBearer: true });
    await this._ensureRoot();
    const profilePath = await this._existingProfile(safeName);
    return this._profileLock(profilePath, async () => {
      const current = await this._readSource(profilePath);
      if (!current.account_id_sha256 || current.account_id_sha256 !== expected) {
        throw error('ERR_PROFILE_ACCOUNT_MISMATCH', `profile ${safeName} is bound to another account`);
      }
      await this._atomicWrite(
        join(profilePath, 'source.json'),
        json({ ...candidate, account_id_sha256: current.account_id_sha256 }),
        PRIVATE_FILE_MODE,
        { maxBytes: MAX_SOURCE_BYTES },
      );
      return this._profileInfo(safeName);
    });
  }

  async _readSelectedRaw() {
    const selected = await this._readJson(this.selectedPath, {
      optional: true,
      maxBytes: MAX_SELECTED_BYTES,
      privateMode: true,
    });
    if (selected === null) return null;
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
      throw error('ERR_INVALID_SELECTED', 'selected.json must contain an object');
    }
    const keys = Object.keys(selected).sort();
    if (keys.length !== 2 || keys[0] !== 'generation' || keys[1] !== 'profile') {
      throw error('ERR_INVALID_SELECTED', 'selected.json may contain only profile and generation');
    }
    validateName(selected.profile);
    if (!Number.isSafeInteger(selected.generation) || selected.generation < 1) {
      throw error('ERR_INVALID_SELECTED', 'selected.json generation must be a positive integer');
    }
    return { profile: selected.profile, generation: selected.generation };
  }

  /** Select only a profile whose Codex auth.json is structurally complete. */
  async selectProfile(name) {
    const safeName = asName(name);
    return this._rootLock(async () => {
      const profile = await this._profileInfo(safeName);
      if (!profile.auth.complete || profile.auth.expired) {
        throw error('ERR_PROFILE_AUTH_INCOMPLETE', `profile ${safeName} cannot be selected: ${profile.auth.reason}`);
      }
      const previous = await this._readSelectedRaw();
      const generation = (previous?.generation ?? 0) + 1;
      await this._atomicWrite(
        this.selectedPath,
        json({ profile: safeName, generation }),
        PRIVATE_FILE_MODE,
        { maxBytes: MAX_SELECTED_BYTES },
      );
      return { profile: safeName, generation };
    });
  }

  select(name) {
    return this.selectProfile(name);
  }

  async readSelected() {
    await this._ensureRoot();
    const selected = await this._readSelectedRaw();
    if (!selected) return null;
    const profile = await this._profileInfo(selected.profile);
    if (!profile.auth.complete) {
      throw error('ERR_SELECTED_INCOMPLETE', `selected profile ${selected.profile} is incomplete`);
    }
    return selected;
  }

  selected() {
    return this.readSelected();
  }

  _auditRecord(eventName, details = {}) {
    if (typeof eventName !== 'string' || !SAFE_EVENT.test(eventName)) {
      throw error('ERR_INVALID_AUDIT_EVENT', 'audit event must be a bounded lowercase identifier');
    }
    const record = { at: nowDate(this.clock).toISOString(), event: eventName };
    const profile = details.profile ?? details.name ?? details.profileName;
    if (profile !== undefined) record.profile = asName(profile);
    if (Number.isSafeInteger(details.generation) && details.generation > 0) record.generation = details.generation;
    // Allow only low-cardinality, non-secret values. In particular, no caller
    // supplied arbitrary object is ever serialized into audit.json.
    if (typeof details.outcome === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(details.outcome)) {
      record.outcome = details.outcome;
    }
    if (typeof details.reason === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(details.reason)) {
      record.reason = details.reason;
    }
    return record;
  }

  _sanitizeAuditRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.event !== 'string' || !SAFE_EVENT.test(value.event)) return null;
    const record = {
      at: typeof value.at === 'string' && value.at.length <= 64
        ? value.at
        : nowDate(this.clock).toISOString(),
      event: value.event,
    };
    const profile = value.profile;
    if (profile !== undefined) {
      try {
        record.profile = asName(profile);
      } catch {
        return null;
      }
    }
    if (Number.isSafeInteger(value.generation) && value.generation > 0) record.generation = value.generation;
    if (typeof value.outcome === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(value.outcome)) {
      record.outcome = value.outcome;
    }
    if (typeof value.reason === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.reason)) {
      record.reason = value.reason;
    }
    return record;
  }

  async audit(eventName, details = {}) {
    await this._ensureRoot();
    return this._lock(join(this.root, AUDIT_LOCK), async () => {
      const existing = await this._readJson(this.auditPath, {
        optional: true,
        maxBytes: this.auditMaxBytes,
        privateMode: true,
      });
      if (existing !== null && !Array.isArray(existing)) {
        throw error('ERR_INVALID_AUDIT', 'audit.json must contain an array');
      }
      const records = Array.isArray(existing)
        ? existing.map((item) => this._sanitizeAuditRecord(item)).filter(Boolean)
        : [];
      records.push(this._auditRecord(eventName, details));
      while (records.length > this.auditMaxRecords) records.shift();
      let payload = json(records);
      while (byteLength(payload) > this.auditMaxBytes && records.length > 1) {
        records.shift();
        payload = json(records);
      }
      if (byteLength(payload) > this.auditMaxBytes) {
        throw error('ERR_AUDIT_TOO_LARGE', 'audit record cannot fit in audit.json bound');
      }
      await this._atomicWrite(this.auditPath, payload, PRIVATE_FILE_MODE, { maxBytes: this.auditMaxBytes });
      return records.at(-1);
    });
  }

  recordAudit(eventName, details) {
    return this.audit(eventName, details);
  }

  async readAudit() {
    await this._ensureRoot();
    const existing = await this._readJson(this.auditPath, {
      optional: true,
      maxBytes: this.auditMaxBytes,
      privateMode: true,
    });
    if (existing === null) return [];
    if (!Array.isArray(existing)) throw error('ERR_INVALID_AUDIT', 'audit.json must contain an array');
    return existing.map((item) => this._sanitizeAuditRecord(item)).filter(Boolean);
  }
}

export function createProfileStore(options) {
  return new ProfileStore(options);
}
