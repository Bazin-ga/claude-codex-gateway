import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/credential-store.js';
import {
  HealthPublisher,
  accessMetadata,
  DEFAULT_EXPECTED_INTERVAL_SECONDS,
  validateExpectedIntervalSeconds,
} from '../lib/health.js';
import { main, validateThresholdDays } from '../refresh.js';
import { RefreshError } from '../lib/oauth.js';

const DAY_SECONDS = 86_400;

function jwt(expiresInSeconds) {
  const encode = (value) => Buffer.from(value).toString('base64url');
  return `${encode('{}')}.${encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  }))}.signature`;
}

async function fixture(expiresInSeconds = 5 * DAY_SECONDS) {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-refresh-health-'));
  const store = new CredentialStore(home);
  await store.init();
  const credential = {
    tokens: {
      refresh_token: 'refresh-token-fixture',
      access_token: jwt(expiresInSeconds),
      id_token: 'id-token-fixture',
      account_id: 'account-fixture',
    },
  };
  await store.writeCredential(credential);
  return { home, store, credential };
}

async function clean(home) {
  await rm(home, { recursive: true, force: true });
  process.exitCode = 0;
}

const silentAlerter = { send: async () => true };

test('threshold and expected interval configuration is finite, bounded, and safe', () => {
  assert.equal(validateThresholdDays(0), 0);
  assert.equal(validateThresholdDays(30), 30);
  assert.equal(validateExpectedIntervalSeconds(1), 1);
  assert.throws(() => validateThresholdDays(Number.NaN));
  assert.throws(() => validateThresholdDays(-1));
  assert.throws(() => validateThresholdDays(31));
  assert.throws(() => validateExpectedIntervalSeconds(0));
  assert.throws(() => validateExpectedIntervalSeconds(1.5));
  assert.throws(() => validateExpectedIntervalSeconds(Number.POSITIVE_INFINITY));
});

test('health is atomic, mode 0640, and contains only the fixed public schema', async () => {
  const { home, store, credential } = await fixture();
  try {
    const publisher = new HealthPublisher(store);
    await publisher.start({ access: accessMetadata(credential, new Date(Date.now() + 60_000)) });
    assert.equal(await publisher.terminal('fresh', {
      access: accessMetadata(credential, new Date(Date.now() + 60_000)),
    }), true);

    assert.equal((await stat(store.healthPath)).mode & 0o777, 0o640);
    const health = JSON.parse(await readFile(store.healthPath, 'utf8'));
    assert.deepEqual(Object.keys(health), [
      'version',
      'updated_at',
      'expected_interval_seconds',
      'last_cycle_started_at',
      'last_cycle_finished_at',
      'last_outcome',
      'last_success_at',
      'last_refresh_at',
      'last_failure_at',
      'failure_class',
      'consecutive_failures',
      'quarantine',
      'access',
    ]);
    assert.deepEqual(Object.keys(health.quarantine), ['present', 'since']);
    assert.deepEqual(Object.keys(health.access), [
      'present',
      'valid',
      'expires_at',
      'remaining_seconds',
    ]);
    assert.equal(health.version, 1);
    assert.equal(health.expected_interval_seconds, DEFAULT_EXPECTED_INTERVAL_SECONDS);
    assert.equal((await readdir(store.publicDir)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await clean(home);
  }
});

test('health tracks consecutive failures and resets them on recovery', async () => {
  const { home, store } = await fixture();
  try {
    const publisher = new HealthPublisher(store);
    await publisher.start();
    await publisher.terminal('timeout', { quarantine: { present: true, since: new Date().toISOString() } });
    assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).consecutive_failures, 1);
    await publisher.start();
    await publisher.terminal('unhandled', { quarantine: { present: true, since: new Date().toISOString() } });
    assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).consecutive_failures, 2);
    await publisher.start();
    await publisher.terminal('fresh', { quarantine: { present: false, since: null } });
    const health = JSON.parse(await readFile(store.healthPath, 'utf8'));
    assert.equal(health.consecutive_failures, 0);
    assert.equal(health.last_outcome, 'fresh');
    assert.equal(health.failure_class, null);
    assert.equal(health.quarantine.present, false);
  } finally {
    await clean(home);
  }
});

test('a future-version old health snapshot is reset instead of promoted', async () => {
  const { home, store } = await fixture();
  try {
    await writeFile(store.healthPath, JSON.stringify({
      version: 99,
      consecutive_failures: 999,
      last_failure_at: '2020-01-01T00:00:00.000Z',
    }));
    const publisher = new HealthPublisher(store);
    await publisher.start();
    await publisher.terminal('fresh');
    const health = JSON.parse(await readFile(store.healthPath, 'utf8'));
    assert.equal(health.version, 1);
    assert.equal(health.consecutive_failures, 0);
    assert.equal(health.last_failure_at, null);
  } finally {
    await clean(home);
  }
});

test('health serialization has no token, fingerprint, account, raw error, or path canaries', async () => {
  const { home, store, credential } = await fixture();
  try {
    const publisher = new HealthPublisher(store);
    const canaries = [
      credential.tokens.refresh_token,
      credential.tokens.access_token,
      credential.tokens.account_id,
      'fingerprint-canary',
      '/secret/credential.json',
      'raw provider error canary',
    ];
    await publisher.start({
      access: accessMetadata(credential, new Date(Date.now() + 60_000)),
      quarantine: { present: true, since: new Date().toISOString() },
    });
    await publisher.terminal('unhandled', {
      failureClass: 'raw provider error canary',
      quarantine: { present: true, since: new Date().toISOString() },
    });
    const serialized = await readFile(store.healthPath, 'utf8');
    for (const canary of canaries) assert.equal(serialized.includes(canary), false, canary);
  } finally {
    await clean(home);
  }
});

test('health write failures are isolated from a successful refresh cycle', async () => {
  const { home, store } = await fixture();
  try {
    const publisher = new HealthPublisher(store, {
      logger: () => {},
      writeImpl: async () => { throw new Error('simulated health disk failure'); },
    });
    assert.equal(await main({ home, store, alerter: silentAlerter, healthPublisher: publisher }), true);
    await assert.rejects(readFile(store.healthPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await clean(home);
  }
});

test('refresh main publishes fresh, refreshed, and recovered terminal outcomes', async () => {
  {
    const { home, store } = await fixture();
    try {
      assert.equal(await main({ home, store, alerter: silentAlerter }), true);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'fresh');
    } finally {
      await clean(home);
    }
  }
  {
    const { home, store } = await fixture(1);
    try {
      assert.equal(await main({
        home,
        store,
        alerter: silentAlerter,
        refreshImpl: async () => ({ access_token: jwt(10 * DAY_SECONDS), refresh_token: 'new-refresh-token' }),
      }), true);
      const health = JSON.parse(await readFile(store.healthPath, 'utf8'));
      assert.equal(health.last_outcome, 'refreshed');
      assert.equal(typeof health.last_refresh_at, 'string');
    } finally {
      await clean(home);
    }
  }
  {
    const { home, store, credential } = await fixture();
    try {
      await store.beginRefreshAttempt({
        refresh_token: 'committed-refresh-fingerprint',
        access_token: 'committed-access-fingerprint',
      });
      assert.equal(await main({ home, store, alerter: silentAlerter }), true);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'recovered');
      assert.equal((await store.readRefreshAttempt()), null);
      assert.equal(credential.tokens.refresh_token, 'refresh-token-fixture');
    } finally {
      await clean(home);
    }
  }
});

test('refresh main publishes quarantine, provider rejection, timeout, persistence, publish, unreadable, and unhandled outcomes', async () => {
  {
    const { home, store } = await fixture();
    const release = await store.acquireOperation('seed');
    try {
      assert.equal(await main({ home, store, alerter: silentAlerter }), false);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'operation_blocked');
    } finally {
      await release();
      await clean(home);
    }
  }
  {
    const { home, store, credential } = await fixture();
    try {
      await store.beginRefreshAttempt({
        refresh_token: CredentialStore.fingerprint(credential.tokens.refresh_token),
        access_token: CredentialStore.fingerprint(credential.tokens.access_token),
      });
      assert.equal(await main({ home, store, alerter: silentAlerter }), false);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'quarantined');
    } finally {
      await clean(home);
    }
  }
  {
    const { home, store } = await fixture(1);
    try {
      assert.equal(await main({
        home,
        store,
        alerter: silentAlerter,
        refreshImpl: async () => {
          throw new RefreshError('pre-mint rejection', {
            status: 400,
            code: 'invalid_request',
            tokenLikelyConsumed: false,
          });
        },
      }), false);
      const health = JSON.parse(await readFile(store.healthPath, 'utf8'));
      assert.equal(health.last_outcome, 'pre_mint_rejected');
      assert.equal(health.quarantine.present, false);
    } finally {
      await clean(home);
    }
  }
  {
    const { home, store } = await fixture(1);
    try {
      assert.equal(await main({
        home,
        store,
        alerter: silentAlerter,
        refreshImpl: async () => {
          throw new RefreshError('deadline', { status: 0, tokenLikelyConsumed: true });
        },
      }), false);
      const health = JSON.parse(await readFile(store.healthPath, 'utf8'));
      assert.equal(health.last_outcome, 'timeout');
      assert.equal(health.quarantine.present, true);
      assert.equal(typeof health.quarantine.since, 'string');
    } finally {
      await clean(home);
    }
  }
  {
    const { home, store } = await fixture(1);
    try {
      store.beginRefreshAttempt = async () => { throw new Error('marker write'); };
      assert.equal(await main({ home, store, alerter: silentAlerter }), false);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'persist_failed');
    } finally {
      await clean(home);
    }
  }
  {
    const { home, store } = await fixture();
    try {
      store.publish = async () => { throw new Error('publish write'); };
      assert.equal(await main({ home, store, alerter: silentAlerter }), false);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'publish_failed');
    } finally {
      await clean(home);
    }
  }
  {
    const home = await mkdtemp(path.join(tmpdir(), 'codex-refresh-health-'));
    const store = new CredentialStore(home);
    try {
      assert.equal(await main({ home, store, alerter: silentAlerter }), false);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'unreadable');
    } finally {
      await clean(home);
    }
  }
  {
    const { home, store } = await fixture(1);
    try {
      assert.equal(await main({
        home,
        store,
        alerter: silentAlerter,
        refreshImpl: async () => { throw new Error('unexpected'); },
      }), false);
      assert.equal(JSON.parse(await readFile(store.healthPath, 'utf8')).last_outcome, 'unhandled');
    } finally {
      await clean(home);
    }
  }
});
