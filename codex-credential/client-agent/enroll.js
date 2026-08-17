#!/usr/bin/env node
/**
 * enroll — exchange the shared enrollment key for THIS machine's own bearer token.
 *
 * Run once, before the first `pull.js`. It turns a shared secret that every
 * enrolling machine holds into a secret only this machine holds, then persists
 * the result so the refresh timer can use it unattended.
 *
 * Why the exchange is worth doing at all, rather than sharing one bearer token:
 * the minted token is per-machine and individually revocable, and every
 * enrollment is logged server-side with a name and an IP. The shared key can
 * only mint — it cannot read a credential — so it survives distribution through
 * an ordinary configuration channel, which the thing that actually fetches
 * credentials does not.
 *
 * Idempotent by consequence rather than by check: re-enrolling mints a fresh
 * token and revokes this machine's previous one, so re-running the installer is
 * safe and a token that leaked from this machine dies on the next run. "This
 * machine" is decided by two things, neither of them the name — a name alone
 * cannot distinguish a reinstall from a second machine that chose the same name,
 * and treating those two cases alike silently evicted the other machine:
 *
 *   - the opaque handle in lib/machine-id.js, which survives reinstalls;
 *   - the digest of the token this machine currently holds, which survives the
 *     handle. A rebuilt container or a restored backup arrives with a fresh
 *     handle on a machine that is not new, and without the digest its previous
 *     row would stay active with nobody able to retire it.
 */

import { hostname } from 'node:os';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, chmod, lstat, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinnedRequest } from './lib/pinned-request.js';
import { MACHINE_ID_PATTERN, ensureMachineId, machineIdPathFor } from './lib/machine-id.js';

const ENDPOINT = process.env.CODEX_CRED_ENDPOINT;
const ENROLLMENT_KEY = process.env.CODEX_CRED_ENROLLMENT_KEY;
const PIN = process.env.CODEX_CRED_CERT_PIN;

/** The env file the systemd unit / launchd job reads. Mode 600, never inline in a unit. */
const ENV_PATH = process.env.CODEX_CRED_ENV_FILE
  ?? join(homedir(), '.config', 'codex-credential.env');

/** This machine's opaque handle, kept beside the env file. */
const MACHINE_ID_PATH = process.env.CODEX_CRED_MACHINE_ID_FILE ?? machineIdPathFor(ENV_PATH);

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, host: hostname(), ...detail }));
}

/**
 * Machine name. Server-side pattern is [A-Za-z0-9][A-Za-z0-9._-]{0,63}; a
 * hostname can contain characters outside it, so sanitise here and let the
 * server reject anything still wrong rather than guessing on its behalf.
 */
export function machineName(raw = process.env.CODEX_CRED_NAME ?? hostname()) {
  const cleaned = String(raw).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return (cleaned || 'machine').slice(0, 64);
}

/**
 * The token this machine currently holds, if it has one.
 *
 * Read from the env file rather than the environment, because that is where the
 * previous enrollment put it and an operator re-running this by hand will not
 * have sourced it. Any failure is "no previous token" — this is an optimisation
 * on revocation, never a precondition for enrolling.
 */
export async function currentToken(envPath = ENV_PATH) {
  const fromEnv = process.env.CODEX_CRED_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const line = (await readFile(envPath, 'utf8'))
      .split('\n')
      .find((entry) => entry.startsWith('CODEX_CRED_TOKEN='));
    const value = line?.slice('CODEX_CRED_TOKEN='.length).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * `machineId` is an explicit argument with no default, and that is deliberate:
 * the credential console imports this function to mint tokens *on behalf of*
 * other people's machines, and a default that read this host's handle would
 * stamp the console's own identity onto every machine it enrolled. Only a
 * process running on the machine being enrolled should pass one.
 *
 * `previousTokenSha256` is the same idea from the other direction: the digest of
 * the token this machine already holds, which is the only way the server can
 * retire that exact row once the handle beside it has been lost. A digest and
 * never the token — the server stores precisely this value already, so it learns
 * nothing new, and it cannot be replayed as a bearer.
 *
 * @returns {Promise<{name: string, token: string}>}
 */
export async function requestEnrollment({
  endpoint = ENDPOINT,
  enrollmentKey = ENROLLMENT_KEY,
  pin = PIN,
  name = machineName(),
  machineId = null,
  previousTokenSha256 = null,
} = {}) {
  // A handle we cannot vouch for is dropped rather than sent: the server would
  // refuse the whole request over it, and an unusable local file must never be
  // the reason a machine cannot get a credential. Without it the server falls
  // back to what it did before fingerprints existed.
  const usableMachineId = typeof machineId === 'string' && MACHINE_ID_PATTERN.test(machineId)
    ? machineId
    : null;
  // Same rule for the proof: a malformed digest would cost the whole request a
  // 400, and enrolling matters more than tidying up an old row.
  const usableDigest = typeof previousTokenSha256 === 'string' && /^[a-f0-9]{64}$/.test(previousTokenSha256)
    ? previousTokenSha256
    : null;

  const { statusCode, body } = await pinnedRequest({
    endpoint,
    path: '/enroll',
    method: 'POST',
    pin,
    bearer: enrollmentKey,
    json: {
      name,
      ...(usableMachineId ? { machine_id: usableMachineId } : {}),
      ...(usableDigest ? { previous_token_sha256: usableDigest } : {}),
    },
  });

  if (statusCode === 403) {
    throw new Error(
      'dispenser refused the enrollment key (403). Either the key in the deploy pack is '
      + 'stale, or enrollment is disabled server-side. Both are operator actions, not '
      + 'something this machine can fix.',
    );
  }
  if (statusCode !== 200) {
    // The endpoint is remote and its body is untrusted. It may contain a token
    // or upstream diagnostic, so never copy it into a local error/log.
    throw new Error(`dispenser returned ${statusCode} during enrollment`);
  }

  let issued;
  try {
    issued = JSON.parse(body);
  } catch (err) {
    throw new Error(`dispenser returned unparseable body: ${err.message}`);
  }
  if (typeof issued.token !== 'string' || !/^[A-Za-z0-9_-]{8,8192}$/.test(issued.token)) {
    throw new Error('dispenser returned no token');
  }
  return issued;
}

/**
 * Merge values into the mode-600 env file, preserving unrelated lines so this
 * never clobbers settings an operator added by hand.
 */
export async function persistEnv(values, envPath = ENV_PATH) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\u0000]/.test(value)) {
      throw new Error('credential env values must be single-line strings with safe keys');
    }
  }
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const lines = existing.split('\n').filter((line) => line.trim() !== '');
  const kept = lines.filter((line) => !Object.keys(values).some((k) => line.startsWith(`${k}=`)));
  const merged = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];

  const parent = dirname(envPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  try {
    const target = await lstat(envPath);
    if (target.isSymbolicLink()) throw new Error('credential env file must not be a symbolic link');
    if (!target.isFile() || target.nlink !== 1) throw new Error('credential env file must be a private regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const tmp = `${envPath}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  let renamed = false;
  let writtenStat = null;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(`${merged.join('\n')}\n`);
    await handle.sync();
    writtenStat = await handle.stat();
    await handle.close();
    handle = null;
    await rename(tmp, envPath);
    renamed = true;
    const committed = await lstat(envPath);
    if (committed.isSymbolicLink() || !committed.isFile() || committed.nlink !== 1
      || !writtenStat || committed.dev !== writtenStat.dev || committed.ino !== writtenStat.ino) {
      throw new Error('credential env target changed during atomic commit');
    }
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await unlink(tmp).catch(() => {});
  }
  return envPath;
}

async function main() {
  const missing = ['CODEX_CRED_ENDPOINT', 'CODEX_CRED_ENROLLMENT_KEY', 'CODEX_CRED_CERT_PIN']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    log('misconfigured', { missing });
    process.exitCode = 2;
    return;
  }

  const name = machineName();
  // Never fatal: ensureMachineId() reports a degraded outcome instead of throwing,
  // because an enrollment that fails over a missing handle is strictly worse than
  // one the server records as a new machine.
  const machine = await ensureMachineId(MACHINE_ID_PATH);
  // The row this machine already owns. Presenting its digest is what retires that
  // row when the handle no longer matches — a rebuilt container, a restored
  // backup, an unwritable ~/.config — instead of leaving a live token behind on
  // every reinstall.
  const previous = await currentToken(ENV_PATH);
  const previousTokenSha256 = previous
    ? createHash('sha256').update(previous).digest('hex')
    : null;
  log('enrolling', {
    name,
    endpoint: ENDPOINT,
    // Whether a previous token was found, never the token and never its digest.
    replacing_previous_token: Boolean(previousTokenSha256),
    // The handle is opaque and identifies nothing but itself, so it is safe to
    // log — unlike the token, which never appears here.
    machine_id: machine.id,
    machine_id_source: machine.created ? 'generated' : 'existing',
    ...(machine.persisted
      ? {}
      : {
        machine_id_persisted: false,
        machine_id_error: machine.error,
        impact: `could not write ${MACHINE_ID_PATH}; this machine reports a new handle at every enrollment`
          + `${previousTokenSha256 ? ', and relies on its current token to retire the previous row' : ''}`,
      }),
  });

  let issued;
  try {
    issued = await requestEnrollment({ name, machineId: machine.id, previousTokenSha256 });
  } catch (err) {
    log('enroll_failed', { error: err.message });
    process.exitCode = 1;
    return;
  }

  const envPath = await persistEnv({
    CODEX_CRED_ENDPOINT: ENDPOINT,
    CODEX_CRED_CERT_PIN: PIN,
    CODEX_CRED_TOKEN: issued.token,
  });

  // The token is never logged: it is written to the mode-600 env file and read
  // from there by pull.js and by the timer.
  log('enrolled', { name: issued.name, env_file: envPath, next: 'run pull.js --force' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('unhandled_failure', { error: err.stack ?? String(err) });
    process.exitCode = 1;
  });
}
