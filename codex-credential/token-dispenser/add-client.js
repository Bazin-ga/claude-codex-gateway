#!/usr/bin/env node
/**
 * Mint a bearer token for one machine, or revoke one.
 *
 * Only the SHA-256 digest is stored. The plaintext is printed exactly once, here,
 * and cannot be recovered afterwards — a leaked clients.json therefore hands over
 * nothing usable.
 *
 * Usage:
 *   node add-client.js <machine-name>       mint a token
 *   node add-client.js --revoke <name>      revoke it
 *   node add-client.js --list               show what exists
 */

import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../refresh-center/lib/credential-store.js';

const HOME = process.env.CODEX_CRED_HOME ?? '/var/lib/codex-credential';
const CLIENTS_PATH = join(HOME, 'clients', 'clients.json');

async function load() {
  try {
    return JSON.parse(await readFile(CLIENTS_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { clients: [] };
    throw err;
  }
}

async function save(db) {
  await mkdir(join(HOME, 'clients'), { recursive: true, mode: 0o700 });
  await writeFileAtomic(CLIENTS_PATH, `${JSON.stringify(db, null, 2)}\n`);
}

async function main() {
  const [flag, value] = process.argv.slice(2);
  const db = await load();

  if (flag === '--list') {
    if (!db.clients.length) return console.log('no clients registered');
    for (const c of db.clients) {
      console.log(`  ${c.revoked ? 'REVOKED' : 'active '}  ${c.name}  added ${c.added_at}`);
    }
    return;
  }

  if (flag === '--revoke') {
    const client = db.clients.find((c) => c.name === value);
    if (!client) {
      console.error(`no client named "${value}"`);
      process.exitCode = 1;
      return;
    }
    client.revoked = true;
    client.revoked_at = new Date().toISOString();
    await save(db);
    console.log(`revoked ${value} — it will be refused on its next pull`);
    return;
  }

  const name = flag;
  if (!name || name.startsWith('--')) {
    console.error('usage: node add-client.js <machine-name> | --revoke <name> | --list');
    process.exitCode = 2;
    return;
  }
  if (db.clients.some((c) => c.name === name && !c.revoked)) {
    console.error(`"${name}" already has an active token; revoke it first to re-issue`);
    process.exitCode = 1;
    return;
  }

  const token = randomBytes(32).toString('base64url');
  db.clients.push({
    name,
    token_sha256: createHash('sha256').update(token).digest('hex'),
    added_at: new Date().toISOString(),
  });
  await save(db);

  console.log(`token for "${name}" — shown once, not recoverable:\n`);
  console.log(`  ${token}\n`);
  console.log('Give it to that machine as CODEX_CRED_TOKEN.');
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
