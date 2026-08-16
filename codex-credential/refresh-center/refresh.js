#!/usr/bin/env node
/**
 * refresh-center — keeps one Codex credential alive so many machines can borrow
 * short-lived copies of it.
 *
 * Run this on a schedule (see install/). Each run:
 *   1. reads the stored credential;
 *   2. refreshes it only if the access token is close enough to expiry;
 *   3. persists the ROTATED refresh token atomically, retaining the previous one;
 *   4. publishes the access token for the dispenser.
 *
 * Deliberately NOT refreshing on every run: each refresh rotates the token, and
 * every rotation is an opportunity to lose it. Fewer rotations is strictly safer.
 */

import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Alerter } from './lib/alert.js';
import { CredentialStore } from './lib/credential-store.js';
import { RefreshError, expiryOf, refresh } from './lib/oauth.js';

const HOME = process.env.CODEX_CRED_HOME ?? '/var/lib/codex-credential';

/**
 * Refresh when fewer than this many days remain. Access tokens live ~10 days, so
 * 3 days leaves room for several consecutive failed runs before clients notice.
 */
const THRESHOLD_DAYS = Number(process.env.CODEX_CRED_REFRESH_THRESHOLD_DAYS ?? 3);

const DAY_MS = 86_400_000;

export function classifyRefreshAttempt(attempt, credential) {
  if (!attempt) return 'none';
  if (!attempt.refresh_token || !attempt.access_token) return 'quarantine';
  const unchanged = attempt.refresh_token === CredentialStore.fingerprint(credential.tokens.refresh_token)
    && attempt.access_token === CredentialStore.fingerprint(credential.tokens.access_token);
  return unchanged ? 'quarantine' : 'committed';
}

async function main() {
  const alerter = new Alerter({
    webhookUrl: process.env.CODEX_CRED_ALERT_WEBHOOK,
    host: hostname(),
  });
  const store = new CredentialStore(HOME);
  await store.init();
  let releaseOperation;
  try {
    releaseOperation = await store.acquireOperation('refresh');
  } catch (error) {
    await alerter.send('critical', 'another credential operation is active', {
      error: error.message,
      remediation: 'wait for the live seed/refresh operation to finish; inspect a stale lock before removing it',
    });
    process.exitCode = 1;
    return;
  }

  try {
    let credential;
    try {
      credential = await store.readCredential();
    } catch (err) {
      await alerter.send('critical', 'cannot read the stored credential', {
        home: HOME,
        error: err.message,
        remediation: 'a human must seed the credential — see the README',
      });
      process.exitCode = 1;
      return;
    }

    const expiry = expiryOf(credential.tokens.access_token);
    const remainingMs = expiry ? expiry.getTime() - Date.now() : 0;
    const remainingDays = remainingMs / DAY_MS;

    const existingAttempt = await store.readRefreshAttempt();
    if (existingAttempt) {
      const currentRefresh = CredentialStore.fingerprint(credential.tokens.refresh_token);
      if (classifyRefreshAttempt(existingAttempt, credential) === 'quarantine') {
        await alerter.send('critical', 'refresh is quarantined after an unfinished or ambiguous attempt', {
          attempt: existingAttempt,
          remediation:
            'do NOT retry automatically. Inspect whether clients still work; re-seed with a fresh human login ' +
            'to clear quarantine safely.',
        });
        process.exitCode = 1;
        return;
      }
      // The durable credential differs from both pre-request fingerprints. The
      // exchange commit completed and the process crashed before marker cleanup.
      await store.clearRefreshAttempt();
      await alerter.send('info', 'recovered a completed refresh after a local crash', {
        previous_attempt: existingAttempt,
        current_refresh_token: currentRefresh,
      });
    }

    // An unparseable or already-expired token means refresh now. Assuming it is
    // still fine would be the failure we cannot detect until clients break.
    if (expiry && remainingDays > THRESHOLD_DAYS) {
      await alerter.send('info', 'credential still fresh, not refreshing', {
        expires_at: expiry.toISOString(),
        remaining_days: Number(remainingDays.toFixed(2)),
        threshold_days: THRESHOLD_DAYS,
      });
      await store.publish(credential, expiry);
      return;
    }

    await alerter.send('info', 'refreshing credential', {
    expires_at: expiry?.toISOString() ?? 'unparseable',
    remaining_days: expiry ? Number(remainingDays.toFixed(2)) : null,
    refresh_token: CredentialStore.fingerprint(credential.tokens.refresh_token),
  });

    try {
      await store.beginRefreshAttempt({
        refresh_token: CredentialStore.fingerprint(credential.tokens.refresh_token),
        access_token: CredentialStore.fingerprint(credential.tokens.access_token),
        access_token_expires_at: expiry?.toISOString() ?? null,
      });
    } catch (error) {
    await alerter.send('critical', 'cannot persist the refresh safety marker', {
      error: error.message,
      remediation: 'repair the credential store before retrying; no refresh request was sent',
    });
    process.exitCode = 1;
    return;
  }

    let payload;
    try {
      payload = await refresh(credential.tokens.refresh_token);
    } catch (err) {
    if (err instanceof RefreshError && !err.tokenLikelyConsumed) {
      await store.clearRefreshAttempt();
    }
    await reportRefreshFailure(alerter, err);
    process.exitCode = 1;
    return;
  }

  // The provider may omit the refresh token when it chooses not to rotate; keeping
  // the existing one is correct then. Overwriting it with undefined would destroy
  // the credential.
    const updated = {
    ...credential,
    tokens: {
      ...credential.tokens,
      access_token: payload.access_token,
      id_token: payload.id_token ?? credential.tokens.id_token,
      refresh_token: payload.refresh_token ?? credential.tokens.refresh_token,
      account_id: payload.account_id ?? credential.tokens.account_id,
    },
    last_refresh: new Date().toISOString(),
  };

    const newExpiry =
    expiryOf(updated.tokens.access_token) ??
    new Date(Date.now() + (payload.expires_in ?? 0) * 1000);

  // Store before publishing: if the process dies between the two, the next run
  // recovers and republishes. The reverse order could hand out a token whose
  // refresh counterpart was never saved.
    try {
      await store.writeCredential(updated);
    } catch (error) {
    await alerter.send('critical', 'refresh succeeded but the rotated credential could not be persisted', {
      error: error.message,
      remediation:
        'do NOT retry automatically. The in-flight quarantine marker was retained; perform a fresh ' +
        'human login and re-seed because the rotated token could not be stored durably.',
    });
    process.exitCode = 1;
    return;
  }
    await store.clearRefreshAttempt();
    await store.publish(updated, newExpiry);

    const rotated = updated.tokens.refresh_token !== credential.tokens.refresh_token;
    await alerter.send('info', 'credential refreshed', {
      expires_at: newExpiry.toISOString(),
      refresh_token_rotated: rotated,
      refresh_token: CredentialStore.fingerprint(updated.tokens.refresh_token),
    });
  } finally {
    await releaseOperation();
  }
}

async function reportRefreshFailure(alerter, err) {
  if (!(err instanceof RefreshError)) {
    await alerter.send('critical', 'refresh failed unexpectedly', { error: err.message });
    return;
  }

  if (err.tokenLikelyConsumed) {
    // The dangerous branch: the exchange may have succeeded upstream while the
    // reply was lost, in which case the stored token is already spent and no
    // retry can recover it. Escalate instead of looping.
    await alerter.send('critical', 'refresh outcome UNKNOWN — credential may be unrecoverable', {
      status: err.status,
      code: err.code,
      error: err.message,
      remediation:
        'do NOT retry automatically. Verify whether clients still work; if the credential is ' +
        'dead a human must log in again and re-seed. Previous generations are in secret/.',
    });
    return;
  }

  await alerter.send('critical', 'refresh rejected by the provider', {
    status: err.status,
    code: err.code,
    error: err.message,
    remediation:
      err.code === 'token_expired'
        ? 'the refresh token is no longer valid — a human must log in again and re-seed'
        : 'inspect the provider response; the stored token was not consumed by this attempt',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(`[${new Date().toISOString()}] CRITICAL unhandled failure: ${err.stack ?? err}`);
    process.exitCode = 1;
  });
}
