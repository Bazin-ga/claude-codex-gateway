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
 * safe and a token that leaked from this machine dies on the next run.
 */

import { hostname } from 'node:os';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinnedRequest } from './lib/pinned-request.js';

const ENDPOINT = process.env.CODEX_CRED_ENDPOINT;
const ENROLLMENT_KEY = process.env.CODEX_CRED_ENROLLMENT_KEY;
const PIN = process.env.CODEX_CRED_CERT_PIN;

/** The env file the systemd unit / launchd job reads. Mode 600, never inline in a unit. */
const ENV_PATH = process.env.CODEX_CRED_ENV_FILE
  ?? join(homedir(), '.config', 'codex-credential.env');

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

/** @returns {Promise<{name: string, token: string}>} */
export async function requestEnrollment({
  endpoint = ENDPOINT,
  enrollmentKey = ENROLLMENT_KEY,
  pin = PIN,
  name = machineName(),
} = {}) {
  const { statusCode, body } = await pinnedRequest({
    endpoint,
    path: '/enroll',
    method: 'POST',
    pin,
    bearer: enrollmentKey,
    json: { name },
  });

  if (statusCode === 403) {
    throw new Error(
      'dispenser refused the enrollment key (403). Either the key in the deploy pack is '
      + 'stale, or enrollment is disabled server-side. Both are operator actions, not '
      + 'something this machine can fix.',
    );
  }
  if (statusCode !== 200) {
    throw new Error(`dispenser returned ${statusCode}: ${body.slice(0, 200)}`);
  }

  let issued;
  try {
    issued = JSON.parse(body);
  } catch (err) {
    throw new Error(`dispenser returned unparseable body: ${err.message}`);
  }
  if (typeof issued.token !== 'string' || !issued.token) {
    throw new Error('dispenser returned no token');
  }
  return issued;
}

/**
 * Merge values into the mode-600 env file, preserving unrelated lines so this
 * never clobbers settings an operator added by hand.
 */
export async function persistEnv(values, envPath = ENV_PATH) {
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const lines = existing.split('\n').filter((line) => line.trim() !== '');
  const kept = lines.filter((line) => !Object.keys(values).some((k) => line.startsWith(`${k}=`)));
  const merged = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];

  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  await writeFile(envPath, `${merged.join('\n')}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
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
  log('enrolling', { name, endpoint: ENDPOINT });

  let issued;
  try {
    issued = await requestEnrollment({ name });
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
