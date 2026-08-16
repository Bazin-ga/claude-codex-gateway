#!/usr/bin/env node
/**
 * Seed the store with a credential produced by a human `codex login`.
 *
 * This is the one moment a person is involved. Everything after it is automatic
 * until the refresh chain breaks.
 *
 * Usage:  node seed.js /path/to/auth.json
 *
 * The source file is left untouched — but be aware it goes stale the moment the
 * center performs its first rotation, so it is a seed, not a backup.
 */

import { readFile } from 'node:fs/promises';
import { CredentialStore } from './lib/credential-store.js';
import { expiryOf } from './lib/oauth.js';

const HOME = process.env.CODEX_CRED_HOME ?? '/var/lib/codex-credential';

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('usage: node seed.js <path-to-auth.json>');
    process.exitCode = 2;
    return;
  }

  const credential = JSON.parse(await readFile(source, 'utf8'));

  const problems = [];
  if (!credential?.tokens?.refresh_token) {
    problems.push('no tokens.refresh_token — the center cannot refresh without one');
  }
  if (!credential?.tokens?.access_token) {
    problems.push('no tokens.access_token');
  }
  if (credential?.auth_mode && credential.auth_mode !== 'chatgpt') {
    problems.push(`auth_mode is "${credential.auth_mode}", expected "chatgpt" (a subscription login)`);
  }
  if (problems.length) {
    console.error(`refusing to seed from ${source}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const store = new CredentialStore(HOME);
  await store.init();
  const releaseOperation = await store.acquireOperation('seed');

  try {
    const expiry = expiryOf(credential.tokens.access_token);
    await store.writeCredential(credential);
    // A fresh human login supersedes any ambiguous earlier rotation.
    await store.clearRefreshAttempt();
    if (expiry) await store.publish(credential, expiry);

    console.log(`seeded ${HOME}`);
    console.log(`  refresh_token  ${CredentialStore.fingerprint(credential.tokens.refresh_token)}`);
    console.log(
      `  access_token   expires ${expiry ? expiry.toISOString() : 'unknown (unparseable exp)'}`,
    );
    if (!expiry) {
      console.log('  note: the access token expiry could not be read, so the next run will refresh.');
    }
  } finally {
    await releaseOperation();
  }
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
