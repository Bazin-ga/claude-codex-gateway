import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_NAME = '.owner.lock';
const RECOVERY_NAME = '.owner.lock.recovery';

async function processStartIdentity(pid) {
  if (process.platform !== 'linux') return null;
  let path = pid === process.pid ? '/proc/self/stat' : `/proc/${pid}/stat`;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const entries = await readdir('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
      const namespacePids = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
      if (namespacePids?.at(-1) === pid) {
        path = `/proc/${entry}/stat`;
        text = await readFile(path, 'utf8');
        break;
      }
    }
    if (!text) throw error;
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  if (!fields[19]) throw new Error(`cannot determine start identity for pid ${pid}`);
  return fields[19];
}

async function ownerIsLive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EINVAL' || error.code === 'ERR_INVALID_ARG_TYPE') return false;
    if (error.code !== 'EPERM') throw error;
  }
  if (process.platform !== 'linux') return true;
  try {
    return typeof owner.startIdentity === 'string'
      && owner.startIdentity === await processStartIdentity(owner.pid);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`cannot safely verify credential home owner pid ${owner.pid}: ${error.message}`);
  }
}

async function observeOwner(path) {
  let identity;
  try {
    identity = await stat(path);
    if (identity.isDirectory()) return { identity, malformed: true, owner: null };
    const owner = JSON.parse(await readFile(path, 'utf8'));
    const malformed = owner === null || typeof owner !== 'object' || Array.isArray(owner);
    return { identity, malformed, owner: malformed ? null : owner };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return { identity, malformed: true, owner: null };
    throw new Error(`cannot read credential home lock ${path}: ${error.message}`);
  }
}

function heldError(owner) {
  const pid = Number.isSafeInteger(owner?.pid) ? owner.pid : 'unknown';
  const role = typeof owner?.role === 'string' ? owner.role : 'unknown';
  return new Error(
    `credential home is already held by pid ${pid} with role ${role}; stop the service first and retry`,
  );
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function recoverStaleLock(lockPath, recoveryPath, observed) {
  const claimPath = `${recoveryPath}.${process.pid}.${randomUUID()}`;
  if (observed.identity.isDirectory()) {
    try {
      await rename(lockPath, claimPath);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const claimed = await stat(claimPath);
    if (!sameFile(claimed, observed.identity)) return false;
    await rm(claimPath, { recursive: true });
    return true;
  }
  try {
    await link(lockPath, claimPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const [locked, claimed] = await Promise.all([stat(lockPath), stat(claimPath)]);
    if (!sameFile(locked, observed.identity) || !sameFile(claimed, observed.identity)) return false;
    await unlink(lockPath);
    return true;
  } finally {
    await unlink(claimPath).catch(() => {});
  }
}

export async function acquireHomeLock(home, { role }) {
  if (!role || typeof role !== 'string') throw new Error('credential home lock role is required');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockPath = join(home, LOCK_NAME);
  const recoveryPath = join(home, RECOVERY_NAME);
  const owner = {
    pid: process.pid,
    role,
    startIdentity: await processStartIdentity(process.pid),
  };

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pendingPath = `${recoveryPath}.pending.${process.pid}.${randomUUID()}`;
    let handle;
    try {
      handle = await open(pendingPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.sync();
      const identity = await handle.stat();
      await link(pendingPath, lockPath);
      await unlink(pendingPath).catch(() => {});
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const current = await stat(lockPath);
            if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          } finally {
            await handle.close();
          }
        },
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(pendingPath).catch(() => {});
      if (error.code !== 'EEXIST') throw error;
    }

    const existing = await observeOwner(lockPath);
    if (!existing) continue;
    if (!existing.malformed && await ownerIsLive(existing.owner)) throw heldError(existing.owner);
    if (await recoverStaleLock(lockPath, recoveryPath, existing)) continue;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('credential home lock recovery is busy; stop the service first and retry');
}
