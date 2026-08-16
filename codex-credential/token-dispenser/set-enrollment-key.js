#!/usr/bin/env node
/**
 * Configure the shared enrollment key — the secret a machine presents to
 * `POST /enroll` to mint its own bearer token.
 *
 * Only the SHA-256 digest is stored, so a leaked `enrollment.json` hands over
 * nothing usable. The plaintext is printed once, here.
 *
 * This key is deliberately low-privilege: it can mint a machine token and
 * nothing else. It cannot read a credential — `handleEnroll` never opens
 * `public/current.json`. That is what makes it distributable through a
 * configuration channel — a secrets manager, a configuration-management secret,
 * an out-of-band message — rather than a credential channel. It still must not
 * be committed to a repository: a committed value survives in history after
 * rotation.
 *
 * Rotating it does not disturb machines already enrolled: their tokens are
 * independent records in clients.json. Rotation only invalidates the ability to
 * enrol NEW machines with the old key.
 *
 * Usage:
 *   node set-enrollment-key.js --generate     mint a random key and enable enrollment
 *   node set-enrollment-key.js --set <key>    adopt a key generated elsewhere
 *                                             (visible in `ps`; prefer --generate)
 *   node set-enrollment-key.js --disable      refuse all enrollment, keeping the key on file
 *   node set-enrollment-key.js --status       report configuration without revealing anything
 */

import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../refresh-center/lib/credential-store.js';

const HOME = process.env.CODEX_CRED_HOME ?? '/var/lib/codex-credential';
const ENROLLMENT_PATH = join(HOME, 'clients', 'enrollment.json');

/** Shorter than this and a shared secret is not worth having. */
const MIN_KEY_LENGTH = 24;

async function load() {
  try {
    return JSON.parse(await readFile(ENROLLMENT_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function save(record) {
  await mkdir(join(HOME, 'clients'), { recursive: true, mode: 0o700 });
  await writeFileAtomic(ENROLLMENT_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

function announce(key) {
  console.log('Enrollment key — shown once, not recoverable from the server:\n');
  console.log(`  ${key}\n`);
  console.log('Put it in the deploy pack as CODEX_CRED_ENROLLMENT_KEY.');
  console.log('Anyone who can read it can mint a machine token — not read a credential.');
}

async function main() {
  const [flag, value] = process.argv.slice(2);
  const existing = await load();

  if (flag === '--status') {
    if (!existing) return console.log('enrollment: not configured (POST /enroll answers 403)');
    console.log(`enrollment: ${existing.disabled ? 'DISABLED' : 'enabled'}`);
    console.log(`  configured ${existing.created_at}`);
    if (existing.rotated_at) console.log(`  rotated    ${existing.rotated_at}`);
    return;
  }

  if (flag === '--disable') {
    if (!existing) {
      console.error('nothing to disable — enrollment was never configured');
      process.exitCode = 1;
      return;
    }
    await save({ ...existing, disabled: true, disabled_at: new Date().toISOString() });
    console.log('enrollment disabled — POST /enroll now answers 403 for every key');
    return;
  }

  let key;
  if (flag === '--generate') {
    key = randomBytes(32).toString('base64url');
  } else if (flag === '--set') {
    key = value;
    if (!key || key.startsWith('--')) {
      console.error('usage: node set-enrollment-key.js --set <key>');
      process.exitCode = 2;
      return;
    }
    if (key.length < MIN_KEY_LENGTH) {
      console.error(`refusing a key shorter than ${MIN_KEY_LENGTH} characters`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.error(
      'usage: node set-enrollment-key.js --generate | --set <key> | --disable | --status',
    );
    process.exitCode = 2;
    return;
  }

  const now = new Date().toISOString();
  await save({
    key_sha256: createHash('sha256').update(key).digest('hex'),
    created_at: existing?.created_at ?? now,
    ...(existing ? { rotated_at: now } : {}),
    disabled: false,
  });

  if (flag === '--generate') announce(key);
  else console.log(`enrollment key adopted${existing ? ' (rotated)' : ''}; enrollment is enabled`);

  console.log('\nMachines already enrolled are unaffected — their tokens are separate records.');
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
