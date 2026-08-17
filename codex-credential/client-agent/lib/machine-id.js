/**
 * machine-id — a random opaque handle that lets the dispenser tell "this machine
 * again" from "a different machine that picked the same name".
 *
 * What it is NOT, deliberately: it is not derived from the hostname, the user,
 * a MAC address, a disk serial, or anything else about the machine or the person
 * using it. It is 24 random bytes generated once and kept in a file. It says
 * nothing except "same handle as last time", which is the only thing the server
 * needs and the only thing this project is willing to collect.
 *
 * Where it lives: next to the env file the agent already writes, but NOT inside
 * it. `install/install.sh` rewrites that env file wholesale (`cat > "$ENV_FILE"`),
 * so a value stored in it would be destroyed by the next install — exactly the
 * "regenerated on every run" behaviour this exists to avoid.
 *
 * Losing it is survivable by design. A missing, unreadable or corrupt file means
 * a fresh handle, so the machine simply looks new to the server; it is never a
 * reason to fail an enrollment, and neither is a filesystem that refuses the
 * write.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The shape the dispenser accepts: an opaque, bounded token. Kept deliberately
 * narrower than the machine-name pattern — nothing but base64url characters,
 * and long enough that a hand-typed or truncated value is rejected rather than
 * quietly colliding with another machine's handle.
 *
 * The server has its own copy of this rule (token-dispenser/server.js); a client
 * is never the thing that decides what the server will store.
 */
export const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Sibling of the env file, so the two travel together for a given install. */
export function machineIdPathFor(envPath) {
  return join(dirname(envPath), 'codex-credential.machine-id');
}

/** 24 random bytes — 32 base64url characters, comfortably inside the pattern. */
export function newMachineId() {
  return randomBytes(24).toString('base64url');
}

/**
 * The persisted handle, or null when there is not a usable one.
 *
 * Every failure collapses to null on purpose: absent, unreadable, a directory,
 * truncated, or filled with something that is not a handle all mean the same
 * thing to the caller — this machine has no handle yet.
 */
export async function readMachineId(path) {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return MACHINE_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The persisted handle, generating and storing one the first time.
 *
 * @returns {Promise<{id: string, created: boolean, persisted: boolean, error?: string}>}
 *   `persisted: false` means the handle is real but only for this run: the next
 *   run will generate another and the server will see a new machine. That is a
 *   degraded outcome worth logging, and still better than refusing to enroll.
 */
export async function ensureMachineId(path) {
  const existing = await readMachineId(path);
  if (existing) return { id: existing, created: false, persisted: true };

  const id = newMachineId();
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Truncating write: anything already here failed to parse as a handle, and a
    // handle nobody can read is worth nothing.
    await writeFile(path, `${id}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return { id, created: true, persisted: true };
  } catch (error) {
    return { id, created: true, persisted: false, error: error.message };
  }
}
