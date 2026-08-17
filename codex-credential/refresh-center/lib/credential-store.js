import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat as statPath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Durable storage for the Codex credential.
 *
 * This module exists because of one asymmetry: OpenAI rotates the refresh token
 * single-use. Once a refresh succeeds upstream, the OLD token is already dead —
 * so if the NEW one fails to reach disk, the credential is gone for good and a
 * human has to log in again. There is no retry that recovers from a lost write.
 *
 * Every write here is therefore temp-file + fsync + rename, and every write keeps
 * the previous generation. Losing power mid-write must leave either the old
 * credential or the new one on disk, never a truncated file.
 */

const SECRET_MODE = 0o600;
const DIR_MODE = 0o700;
const PUBLIC_MODE = 0o640;
const PUBLIC_DIR_MODE = 0o750;

/** How many previous generations to retain. Cheap insurance against a bad write. */
const BACKUP_GENERATIONS = 5;

export class CredentialStore {
  /**
   * @param {string} home Data directory. Holds `secret/` (refresh token lives here,
   *   readable only by the refresh-center) and `public/` (access token only, the
   *   dispenser's input).
   */
  constructor(home) {
    this.home = home;
    this.secretDir = join(home, 'secret');
    this.publicDir = join(home, 'public');
    this.credentialPath = join(this.secretDir, 'credential.json');
    this.refreshAttemptPath = join(this.secretDir, 'refresh-in-flight.json');
    this.operationLockPath = join(this.secretDir, 'operation.lock');
    this.publicPath = join(this.publicDir, 'current.json');
    this.healthPath = join(this.publicDir, 'health.json');
  }

  async init() {
    await mkdir(this.secretDir, { recursive: true, mode: DIR_MODE });
    await mkdir(this.publicDir, { recursive: true, mode: PUBLIC_DIR_MODE });
    await ensureMode(this.secretDir, DIR_MODE);
    await ensureMode(this.publicDir, PUBLIC_DIR_MODE);
  }

  /** @returns {Promise<object>} the full credential, including the refresh token. */
  async readCredential() {
    const raw = await readFile(this.credentialPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.tokens?.refresh_token) {
      throw new Error(
        `credential at ${this.credentialPath} has no refresh_token — this store holds the ` +
          'authoritative credential and cannot function without one',
      );
    }
    return parsed;
  }

  /**
   * Replace the stored credential. Retains the previous generation first, so a bad
   * write is recoverable by hand.
   */
  async writeCredential(credential) {
    await this.#retainGeneration();
    await writeFileAtomic(this.credentialPath, `${JSON.stringify(credential, null, 2)}\n`);
  }

  /**
   * Return a persisted ambiguous/in-flight refresh marker, if one exists.
   * A marker is a deliberate fail-closed quarantine: an earlier request may have
   * consumed the single-use token, so another automatic attempt is unsafe.
   */
  async readRefreshAttempt() {
    try {
      return JSON.parse(await readFile(this.refreshAttemptPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Atomically acquire the single-refresh lock and persist it before network I/O.
   * `wx` prevents concurrent/manual invocations from racing the systemd timer.
   */
  async beginRefreshAttempt(detail) {
    const handle = await open(this.refreshAttemptPath, 'wx', SECRET_MODE);
    let complete = false;
    try {
      await handle.writeFile(`${JSON.stringify({
        ...detail,
        started_at: new Date().toISOString(),
      }, null, 2)}\n`);
      await handle.sync();
      complete = true;
    } finally {
      await handle.close();
      if (!complete) await unlink(this.refreshAttemptPath).catch(() => {});
    }
    await syncDirectory(this.secretDir);
  }

  /** Clear quarantine only after the outcome is known safe. */
  async clearRefreshAttempt() {
    try {
      await unlink(this.refreshAttemptPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await syncDirectory(this.secretDir);
  }

  /**
   * Serialize seed and refresh operations. A crashed owner's lock is reclaimed
   * only after its PID is proven absent; a live or unreadable lock fails closed.
   */
  async acquireOperation(operation) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const identity = await processIdentity(process.pid);
        const handle = await open(this.operationLockPath, 'wx', SECRET_MODE);
        try {
          await handle.writeFile(`${JSON.stringify({
            operation,
            pid: process.pid,
            boot_id: identity?.bootId ?? null,
            process_start_time: identity?.startTime ?? null,
            started_at: new Date().toISOString(),
          })}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(this.secretDir);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await unlink(this.operationLockPath);
          await syncDirectory(this.secretDir);
        };
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt > 0) throw error;
        const lock = JSON.parse(await readFile(this.operationLockPath, 'utf8'));
        const identity = await processIdentity(Number(lock.pid));
        const sameOwner = identity
          && lock.boot_id
          && lock.process_start_time
          && lock.boot_id === identity.bootId
          && String(lock.process_start_time) === identity.startTime;
        if (sameOwner
          || (identity && !identity.bootId)
          || (identity && (!lock.boot_id || !lock.process_start_time))) {
          throw new Error(
            `credential operation "${lock.operation ?? 'unknown'}" is already running as pid ${lock.pid}`,
          );
        }
        // A missing process, a different kernel boot, or a reused PID with a
        // different /proc start time proves that the owner cannot still hold it.
        await unlink(this.operationLockPath);
        await syncDirectory(this.secretDir);
      }
    }
    throw new Error('could not acquire credential operation lock');
  }

  /**
   * Publish the subset the dispenser is allowed to see.
   *
   * The dispenser reads THIS file, never the credential — so the refresh token is
   * absent from its process by construction rather than by a filter it could
   * later regress on.
   */
  async publish(credential, expiresAt) {
    const { access_token, id_token, account_id } = credential.tokens;
    await writeFileAtomic(
      this.publicPath,
      `${JSON.stringify(
        {
          access_token,
          id_token,
          account_id,
          expires_at: expiresAt.toISOString(),
          published_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      PUBLIC_MODE,
    );
  }

  /** Short, non-reversible identifier for a token — safe to log. */
  static fingerprint(token) {
    return createHash('sha256').update(token).digest('hex').slice(0, 12);
  }

  async #retainGeneration() {
    let current;
    try {
      current = await readFile(this.credentialPath);
    } catch (err) {
      if (err.code === 'ENOENT') return; // first write, nothing to retain
      throw err;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
    await writeFileAtomic(join(this.secretDir, `credential.${stamp}.bak.json`), current);
    await this.#pruneGenerations();
  }

  async #pruneGenerations() {
    const entries = (await readdir(this.secretDir))
      .filter((name) => name.startsWith('credential.') && name.endsWith('.bak.json'))
      .sort()
      .reverse();
    for (const stale of entries.slice(BACKUP_GENERATIONS)) {
      await unlink(join(this.secretDir, stale)).catch(() => {});
    }
  }
}

/**
 * chmod requires ownership, not merely write access, so a process seeding a home
 * owned by another user (the console writing the centre's home) gets EPERM even
 * with an ACL granting it everything. Correcting a mode that is already correct
 * is the only reason that ever happened, so check before asking.
 */
async function ensureMode(path, mode) {
  const info = await statPath(path);
  if ((info.mode & 0o7777) === mode) return;
  await chmod(path, mode);
}

async function processIdentity(pid) {
  try {
    const [bootId, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTime = afterCommand[19];
    if (!startTime) throw new Error(`cannot parse process start time for pid ${pid}`);
    return { bootId: bootId.trim(), startTime };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Non-Linux hosts cannot prove PID reuse. Preserve fail-closed behavior for
    // a live PID rather than guessing that an existing lock is stale.
    try {
      process.kill(pid, 0);
      return { bootId: null, startTime: null };
    } catch (probeError) {
      if (probeError.code === 'ESRCH') return null;
      throw probeError;
    }
  }
}

/**
 * Write that survives a crash: a fresh temp file in the same directory, fsynced,
 * then renamed over the target. `rename` within a filesystem is atomic, so a
 * reader sees either the whole old file or the whole new one.
 *
 * The directory itself is fsynced too — without that, the rename can still be
 * pending in the directory entry cache when power is lost.
 */
export async function writeFileAtomic(path, data, mode = SECRET_MODE) {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  let renamed = false;
  try {
    const handle = await open(tmp, 'wx', mode);
    created = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    await chmod(path, mode);
    await syncDirectory(dirname(path));
  } finally {
    if (created && !renamed) await unlink(tmp).catch(() => {});
  }
}

async function syncDirectory(path) {
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
