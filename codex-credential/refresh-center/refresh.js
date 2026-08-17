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
import {
  HealthPublisher,
  DEFAULT_EXPECTED_INTERVAL_SECONDS,
  accessMetadata,
  quarantineMetadata,
  validateExpectedIntervalSeconds,
} from './lib/health.js';
import { RefreshError, expiryOf, refresh } from './lib/oauth.js';

const HOME = process.env.CODEX_CRED_HOME ?? '/var/lib/codex-credential';

const DAY_MS = 86_400_000;

/**
 * Refresh when fewer than this many days remain. Access tokens live ~10 days, so
 * 3 days leaves room for several consecutive failed runs before clients notice.
 */
export function validateThresholdDays(value) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error('CODEX_CRED_REFRESH_THRESHOLD_DAYS must be a finite number between 0 and 30');
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 30) {
    throw new Error('CODEX_CRED_REFRESH_THRESHOLD_DAYS must be a finite number between 0 and 30');
  }
  return numeric;
}

function configuredThresholdDays() {
  return validateThresholdDays(process.env.CODEX_CRED_REFRESH_THRESHOLD_DAYS ?? 3);
}

function configuredExpectedIntervalSeconds() {
  return validateExpectedIntervalSeconds(
    process.env.CODEX_CRED_REFRESH_EXPECTED_INTERVAL_SECONDS
      ?? process.env.CODEX_CRED_REFRESH_INTERVAL_SECONDS
      ?? DEFAULT_EXPECTED_INTERVAL_SECONDS,
  );
}

export function classifyRefreshAttempt(attempt, credential) {
  if (!attempt) return 'none';
  if (!attempt.refresh_token || !attempt.access_token
    || !credential?.tokens?.refresh_token
    || !credential?.tokens?.access_token) return 'quarantine';
  const unchanged = attempt.refresh_token === CredentialStore.fingerprint(credential.tokens.refresh_token)
    && attempt.access_token === CredentialStore.fingerprint(credential.tokens.access_token);
  return unchanged ? 'quarantine' : 'committed';
}

function isTimeoutFailure(error) {
  return error instanceof RefreshError
    && (error.status === 0 || /deadline|did not complete|body could not be read/i.test(error.message));
}

function failureOutcome(error) {
  if (!(error instanceof RefreshError)) return 'unhandled';
  if (error.tokenLikelyConsumed === false) return 'pre_mint_rejected';
  return isTimeoutFailure(error) ? 'timeout' : 'quarantined';
}

function failureClass(error, outcome) {
  if (outcome === 'pre_mint_rejected') return 'provider_rejected';
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'quarantined') return 'quarantine';
  if (outcome === 'unhandled') return 'unhandled';
  if (outcome === 'operation_blocked') return 'operation_blocked';
  return outcome;
}

async function finishHealth(health, outcome, detail = {}) {
  if (!health) return false;
  try {
    return await health.terminal(outcome, detail);
  } catch {
    // Health is a side channel. Even an injected/malformed publisher must not
    // change the refresh result or hide the original alert.
    return false;
  }
}

async function reportCredentialReadFailure(alerter, home, error) {
  await alerter.send('critical', 'cannot read the stored credential', {
    home,
    error: error?.message ?? String(error),
    remediation: 'a human must seed the credential — see the README',
  });
}

async function publishBestEffortFailure({
  home,
  healthPublisher,
  failureClass = 'unhandled',
  expectedIntervalSeconds = DEFAULT_EXPECTED_INTERVAL_SECONDS,
}) {
  if (healthPublisher) {
    await finishHealth(healthPublisher, 'unhandled', {
      failureClass,
      quarantine: { present: false, since: null },
    });
    return;
  }
  try {
    const store = new CredentialStore(home);
    await store.init();
    const health = new HealthPublisher(store, { expectedIntervalSeconds });
    await finishHealth(health, 'unhandled', {
      failureClass,
      quarantine: { present: false, since: null },
    });
  } catch {
    // A configuration/startup failure must still fail closed even when the
    // health side-channel directory itself cannot be created.
    console.error('[refresh-center] WARN public health publication failed');
  }
}

function safeExpectedIntervalSeconds() {
  try {
    return configuredExpectedIntervalSeconds();
  } catch {
    return DEFAULT_EXPECTED_INTERVAL_SECONDS;
  }
}

/**
 * Run one refresh cycle. Options are intentionally injectable for safety tests;
 * the command-line entry point below uses the real store and OAuth exchange.
 */
export async function main({
  home = HOME,
  alerter = new Alerter({
    webhookUrl: process.env.CODEX_CRED_ALERT_WEBHOOK,
    host: hostname(),
  }),
  store = new CredentialStore(home),
  refreshImpl = refresh,
  healthPublisher,
  expectedIntervalSeconds,
  thresholdDays,
} = {}) {
  let effectiveThresholdDays;
  let effectiveExpectedIntervalSeconds;
  try {
    effectiveThresholdDays = validateThresholdDays(
      thresholdDays === undefined ? configuredThresholdDays() : thresholdDays,
    );
    effectiveExpectedIntervalSeconds = validateExpectedIntervalSeconds(
      expectedIntervalSeconds === undefined
        ? configuredExpectedIntervalSeconds()
        : expectedIntervalSeconds,
    );
  } catch {
    await publishBestEffortFailure({
      home,
      healthPublisher,
      failureClass: 'configuration_invalid',
      expectedIntervalSeconds: safeExpectedIntervalSeconds(),
    });
    process.exitCode = 1;
    return false;
  }

  let health;
  try {
    health = healthPublisher ?? new HealthPublisher(store, {
      expectedIntervalSeconds: effectiveExpectedIntervalSeconds,
    });
    await store.init();
  } catch (error) {
    await finishHealth(health, 'unhandled', { failureClass: 'unhandled' });
    process.exitCode = 1;
    return false;
  }
  let releaseOperation;
  let refreshMarkerSince = null;
  try {
    releaseOperation = await store.acquireOperation('refresh');
  } catch (error) {
    await finishHealth(health, 'operation_blocked', {
      failureClass: 'operation_blocked',
      quarantine: { present: false, since: null },
    });
    await alerter.send('critical', 'another credential operation is active', {
      error: error.message,
      remediation: 'wait for the live seed/refresh operation to finish; inspect a stale lock before removing it',
    });
    process.exitCode = 1;
    return false;
  }

  try {
    // This is deliberately after the operation lock: a concurrent seed must not
    // look like a refresh heartbeat in the public record.
    try {
      await health.start();
    } catch {
      // HealthPublisher itself is best effort; keep this guard for injected
      // publishers and future implementations so a side-channel write cannot
      // change the refresh outcome.
    }

    let credential;
    try {
      credential = await store.readCredential();
    } catch (err) {
      await finishHealth(health, 'unreadable', {
        access: accessMetadata(null, null),
        quarantine: { present: false, since: null },
      });
      await reportCredentialReadFailure(alerter, home, err);
      process.exitCode = 1;
      return false;
    }

    const expiry = expiryOf(credential.tokens.access_token);
    const remainingMs = expiry ? expiry.getTime() - Date.now() : 0;
    const remainingDays = remainingMs / DAY_MS;
    const access = accessMetadata(credential, expiry);

    let existingAttempt;
    try {
      existingAttempt = await store.readRefreshAttempt();
    } catch (error) {
      await finishHealth(health, 'unreadable', {
        access,
        quarantine: { present: true, since: null },
        failureClass: 'unreadable',
      });
      await alerter.send('critical', 'cannot read the refresh safety marker', {
        error: error.message,
        remediation: 'repair the credential store before retrying; do not remove an ambiguous marker blindly',
      });
      process.exitCode = 1;
      return false;
    }

    let recovered = false;
    if (existingAttempt) {
      const currentRefresh = CredentialStore.fingerprint(credential.tokens.refresh_token);
      if (classifyRefreshAttempt(existingAttempt, credential) === 'quarantine') {
        await finishHealth(health, 'quarantined', {
          access,
          quarantine: quarantineMetadata(existingAttempt),
          failureClass: 'quarantine',
        });
        await alerter.send('critical', 'refresh is quarantined after an unfinished or ambiguous attempt', {
          attempt: existingAttempt,
          remediation:
            'do NOT retry automatically. Inspect whether clients still work; re-seed with a fresh human login ' +
            'to clear quarantine safely.',
        });
        process.exitCode = 1;
        return false;
      }
      // The durable credential differs from both pre-request fingerprints. The
      // exchange commit completed and the process crashed before marker cleanup.
      try {
        await store.clearRefreshAttempt();
      } catch (error) {
        await finishHealth(health, 'persist_failed', {
          access,
          quarantine: quarantineMetadata(existingAttempt),
          failureClass: 'persist_failed',
        });
        await alerter.send('critical', 'cannot clear the completed refresh safety marker', {
          error: error.message,
          remediation: 'repair the credential store before retrying; do not remove an ambiguous marker blindly',
        });
        process.exitCode = 1;
        return false;
      }
      recovered = true;
      await alerter.send('info', 'recovered a completed refresh after a local crash', {
        previous_attempt: existingAttempt,
        current_refresh_token: currentRefresh,
      });
    }

    // An unparseable or already-expired token means refresh now. Assuming it is
    // still fine would be the failure we cannot detect until clients break.
    if (expiry && remainingDays > effectiveThresholdDays) {
      await alerter.send('info', 'credential still fresh, not refreshing', {
        expires_at: expiry.toISOString(),
        remaining_days: Number(remainingDays.toFixed(2)),
        threshold_days: effectiveThresholdDays,
      });
      try {
        await store.publish(credential, expiry);
      } catch (error) {
        await finishHealth(health, 'publish_failed', {
          access,
          quarantine: { present: false, since: null },
          failureClass: 'publish_failed',
        });
        await alerter.send('critical', 'credential is fresh but could not be published', {
          error: error.message,
          remediation: 'repair the public credential store and rerun refresh.js',
        });
        process.exitCode = 1;
        return false;
      }
      await finishHealth(health, recovered ? 'recovered' : 'fresh', {
        access,
        quarantine: { present: false, since: null },
        lastRefreshAt: recovered ? true : undefined,
      });
      return true;
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
      await finishHealth(health, 'persist_failed', {
        access,
        quarantine: { present: false, since: null },
        failureClass: 'persist_failed',
      });
      process.exitCode = 1;
      return false;
    }

    refreshMarkerSince = new Date().toISOString();

    let payload;
    try {
      payload = await refreshImpl(credential.tokens.refresh_token);
    } catch (err) {
      const outcome = failureOutcome(err);
      let quarantine = { present: true, since: refreshMarkerSince };
      if (err instanceof RefreshError && err.tokenLikelyConsumed === false) {
        try {
          await store.clearRefreshAttempt();
          quarantine = { present: false, since: null };
        } catch (clearError) {
          await reportRefreshFailure(alerter, err);
          await finishHealth(health, 'persist_failed', {
            access,
            quarantine,
            failureClass: 'persist_failed',
          });
          await alerter.send('critical', 'refresh was safely rejected but its safety marker could not be cleared', {
            error: clearError.message,
            remediation: 'repair the credential store before retrying',
          });
          process.exitCode = 1;
          return false;
        }
      }
      await reportRefreshFailure(alerter, err);
      await finishHealth(health, outcome, {
        access,
        quarantine,
        failureClass: failureClass(err, outcome),
      });
      process.exitCode = 1;
      return false;
    }

    // The provider may omit the refresh token when it chooses not to rotate;
    // keeping the existing one is correct then. Overwriting it with undefined
    // would destroy the credential.
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
      (Number.isFinite(Number(payload.expires_in))
        ? new Date(Date.now() + Number(payload.expires_in) * 1000)
        : null);
    const updatedAccess = accessMetadata(updated, newExpiry);

    // Store before publishing: if the process dies between the two, the next
    // run recovers and republishes. The reverse order could hand out a token
    // whose refresh counterpart was never saved.
    try {
      await store.writeCredential(updated);
    } catch (error) {
      await alerter.send('critical', 'refresh succeeded but the rotated credential could not be persisted', {
        error: error.message,
        remediation:
          'do NOT retry automatically. The in-flight quarantine marker was retained; perform a fresh ' +
          'human login and re-seed because the rotated token could not be stored durably.',
      });
      await finishHealth(health, 'persist_failed', {
        access,
        quarantine: { present: true, since: refreshMarkerSince },
        failureClass: 'persist_failed',
      });
      process.exitCode = 1;
      return false;
    }

    try {
      await store.clearRefreshAttempt();
    } catch (error) {
        await finishHealth(health, 'persist_failed', {
          access: updatedAccess,
          quarantine: { present: true, since: refreshMarkerSince },
          failureClass: 'persist_failed',
          lastRefreshAt: true,
        });
      await alerter.send('critical', 'refresh succeeded but its safety marker could not be cleared', {
        error: error.message,
        remediation: 'do NOT retry automatically; repair the credential store and re-seed if needed.',
      });
      process.exitCode = 1;
      return false;
    }

    try {
      await store.publish(updated, newExpiry);
    } catch (error) {
      await finishHealth(health, 'publish_failed', {
        access: updatedAccess,
        quarantine: { present: false, since: null },
        failureClass: 'publish_failed',
        lastRefreshAt: true,
      });
      await alerter.send('critical', 'refresh succeeded but the new credential could not be published', {
        error: error.message,
        remediation: 'repair the public credential store and rerun refresh.js',
      });
      process.exitCode = 1;
      return false;
    }

    const rotated = updated.tokens.refresh_token !== credential.tokens.refresh_token;
    await alerter.send('info', 'credential refreshed', {
      expires_at: newExpiry?.toISOString() ?? 'unparseable',
      refresh_token_rotated: rotated,
      refresh_token: CredentialStore.fingerprint(updated.tokens.refresh_token),
    });
    await finishHealth(health, 'refreshed', {
      access: updatedAccess,
      quarantine: { present: false, since: null },
      lastRefreshAt: true,
    });
    return true;
  } catch (error) {
    await finishHealth(health, 'unhandled', {
      failureClass: 'unhandled',
      quarantine: refreshMarkerSince
        ? { present: true, since: refreshMarkerSince }
        : { present: false, since: null },
    });
    await alerter.send('critical', 'refresh failed unexpectedly', { error: error.message });
    process.exitCode = 1;
    return false;
  } finally {
    await releaseOperation();
  }
}

async function reportRefreshFailure(alerter, err) {
  if (!(err instanceof RefreshError)) {
    await alerter.send('critical', 'refresh failed unexpectedly', { error: err?.message ?? String(err) });
    return;
  }

  if (err.tokenLikelyConsumed !== false) {
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
    await publishBestEffortFailure({
      home: HOME,
      failureClass: 'unhandled',
      expectedIntervalSeconds: safeExpectedIntervalSeconds(),
    });
    console.error(`[${new Date().toISOString()}] CRITICAL unhandled failure`);
    process.exitCode = 1;
  });
}
