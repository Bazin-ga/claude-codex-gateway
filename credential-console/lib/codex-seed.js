import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialStore as CodexCredentialStore } from '../../codex-credential/refresh-center/lib/credential-store.js';
import { expiryOf } from '../../codex-credential/refresh-center/lib/oauth.js';

/**
 * Carries how far the seed got. A failure after `writeCredential` has already
 * replaced the credential on disk is not the same event as one that wrote
 * nothing: the home now holds this account's token, and forgetting that would
 * let a second account authorize into the same home and destroy it.
 */
export class CodexSeedError extends Error {
  constructor(message, progress) {
    super(message);
    this.name = 'CodexSeedError';
    this.progress = progress;
  }
}

/**
 * Write a freshly authorized credential into a codex-credential home, doing
 * exactly what `refresh-center/seed.js` does — same store, same expiry parser,
 * same operation lock. Reimplementing the atomic write here would be a second
 * copy of the one piece of this system that must never lose a write.
 *
 * This is the only path in the console that writes outside its own home, and it
 * exists only when CREDENTIAL_CONSOLE_CODEX_SEED_HOME is set.
 */
export async function seedCodexCredentialHome(home, credential) {
  const store = new CodexCredentialStore(home);
  const progress = { home, wroteCredential: false, expiresAt: null };
  try {
    await store.init();
  } catch (error) {
    throw new CodexSeedError(
      `the Codex credential home ${home} could not be prepared, so nothing was written: ${error.message}`,
      progress,
    );
  }

  let release;
  try {
    release = await store.acquireOperation('credential-console-authorization');
  } catch (error) {
    // A held lock means a refresh is in flight against the same single-use token.
    // Racing it can destroy the credential, so stop and let the operator retry.
    throw new CodexSeedError(
      `the Codex credential home ${home} is busy, so nothing was written: ${error.message}`,
      progress,
    );
  }

  try {
    const expiry = expiryOf(credential.tokens.access_token);
    progress.expiresAt = expiry ? expiry.toISOString() : null;
    await store.writeCredential(credential);
    progress.wroteCredential = true;
    // A fresh human login supersedes any ambiguous earlier rotation.
    await store.clearRefreshAttempt();
    if (expiry) await store.publish(credential, expiry);
    return progress;
  } catch (error) {
    throw new CodexSeedError(error.message, progress);
  } finally {
    // A stuck lock has to surface — every later seed fails on it — but not as a
    // report that nothing was written when the credential is already on disk.
    try {
      await release();
    } catch (error) {
      throw new CodexSeedError(
        `the credential operation lock in ${home} could not be released: ${error.message}`,
        progress,
      );
    }
  }
}

/**
 * Prove the console can actually write here before an authorization is spent on
 * it. A seed that fails costs a real browser login that cannot be replayed, and
 * the usual cause — a systemd mount namespace or a missing ACL on the directory
 * rather than the file — is invisible until the first write is attempted.
 */
export async function assertCodexSeedHomeWritable(home) {
  const store = new CodexCredentialStore(home);
  const refuse = (path, error) => new Error(
    `the Codex credential home ${path} is not writable by this console (${error.code ?? error.message}); `
      + 'see DEPLOY.md "the console seeds the home directly"',
  );
  try {
    await store.init();
  } catch (error) {
    throw refuse(home, error);
  }
  // Both directories, because the atomic writes create their temp file as a
  // sibling: write access to current.json alone is not enough to publish.
  for (const directory of [store.secretDir, store.publicDir]) {
    const probe = join(directory, `.console-write-probe.${randomBytes(6).toString('hex')}`);
    try {
      const handle = await open(probe, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      throw refuse(directory, error);
    } finally {
      await unlink(probe).catch(() => {});
    }
  }
}
