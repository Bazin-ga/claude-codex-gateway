import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  METRICS_FILENAME,
  METRICS_SCHEMA_VERSION,
  MetricsStore,
} from '../lib/metrics.js';

const HOUR_MS = 60 * 60 * 1000;
const BASE_MS = 1_700_000_000_000;
const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function row(overrides = {}) {
  return {
    startedAtMs: BASE_MS,
    method: 'POST',
    path: '/v1/messages',
    deviceId: 'device-1',
    machineId: 'machine-1',
    memberLabel: 'alice',
    accountId: 'account-1',
    accountAlias: 'claude-team',
    model: 'claude-test',
    stream: true,
    statusCode: 200,
    outcome: 'completed',
    ttfbMs: 12,
    durationMs: 45,
    requestBytes: 100,
    responseBytes: 200,
    upstreamRequestId: 'upstream-1',
    ...overrides,
  };
}

async function newStore(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-'));
  const store = new MetricsStore({
    home,
    flushIntervalMs: 60_000,
    ...options,
  });
  await store.init();
  t.after(() => store.close());
  return { home, store, dbPath: join(home, METRICS_FILENAME) };
}

function readOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

function rowCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM request_metrics').get().count);
}

test('initializes a private WAL/NORMAL database with schema version and indexes', async (t) => {
  const { store, dbPath } = await newStore(t);
  assert.equal(METRICS_SCHEMA_VERSION, 1);
  assert.equal((await stat(dbPath)).mode & 0o777, 0o600);

  const db = readOnly(dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  // synchronous is connection-local; the read-only verifier has its default
  // while the MetricsStore connection is the one configured to NORMAL.
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(
    db.prepare('SELECT schema_version FROM schema_meta WHERE singleton = 1').get().schema_version,
    METRICS_SCHEMA_VERSION,
  );
  const indexes = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'request_metrics_%'
    ORDER BY name
  `).all().map((entry) => entry.name);
  assert.deepEqual(indexes, [
    'request_metrics_account_started_idx',
    'request_metrics_device_started_idx',
    'request_metrics_machine_started_idx',
    'request_metrics_member_started_idx',
    'request_metrics_model_started_idx',
    'request_metrics_started_idx',
  ]);
  assert.equal(store.db.isOpen, true);
});

test('enqueueRequest only queues bounded metadata and does not touch SQLite', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-preinit-'));
  const store = new MetricsStore({
    home,
    batchSize: 2,
    maxQueue: 2,
    flushIntervalMs: 60_000,
  });
  t.after(() => store.close());
  assert.equal(store.enqueueRequest(row()), true);
  await assert.rejects(access(join(home, METRICS_FILENAME)), { code: 'ENOENT' });

  await store.init();
  assert.equal(store.enqueueRequest(row({ startedAtMs: BASE_MS + 1 })), true);
  assert.equal(store.enqueueRequest(row({ startedAtMs: BASE_MS + 2 })), false);
  const before = readOnly(join(home, METRICS_FILENAME));
  assert.equal(rowCount(before), 0);
  before.close();

  assert.deepEqual(store.flush(), { queued: 2, written: 2, dropped: 0, failed: 0 });
  const after = readOnly(join(home, METRICS_FILENAME));
  assert.equal(rowCount(after), 2);
  after.close();
});

test('flush commits one batch and query APIs filter and aggregate fixed metadata', async (t) => {
  const { store } = await newStore(t, { batchSize: 16 });
  const rows = [
    row({ startedAtMs: BASE_MS, machineId: 'machine-1', memberLabel: 'alice', model: 'model-a' }),
    row({
      startedAtMs: BASE_MS + 1_000,
      machineId: 'machine-1',
      memberLabel: 'alice',
      model: 'model-b',
      statusCode: 500,
      outcome: 'completed',
      requestBytes: 20,
      responseBytes: 30,
    }),
    row({
      startedAtMs: BASE_MS + HOUR_MS,
      path: '/v1/messages/count_tokens',
      machineId: null,
      memberLabel: 'bob',
      accountId: 'account-2',
      accountAlias: 'claude-other',
      model: 'model-a',
      statusCode: 200,
      requestBytes: 3,
      responseBytes: 4,
    }),
    row({
      startedAtMs: BASE_MS + HOUR_MS + 1_000,
      path: '/v1/models',
      machineId: 'machine-2',
      memberLabel: 'carol',
      statusCode: 200,
      requestBytes: 5,
      responseBytes: 6,
    }),
    row({
      startedAtMs: BASE_MS + HOUR_MS + 2_000,
      machineId: null,
      memberLabel: 'bob',
      accountId: 'account-2',
      accountAlias: 'claude-other',
      model: 'model-c',
      statusCode: null,
      outcome: 'upstream_error',
      ttfbMs: null,
      durationMs: 9,
      requestBytes: 7,
      responseBytes: 0,
    }),
  ];
  for (const entry of rows) assert.equal(store.enqueueRequest(entry), true);
  assert.equal(store.flush().written, rows.length);

  assert.deepEqual(store.queryTotals({ scope: 'all' }), {
    requestCount: 5,
    successCount: 3,
    errorCount: 2,
    totalRequestBytes: 135,
    totalResponseBytes: 240,
    avgTtfbMs: 12,
    avgDurationMs: 37.8,
  });
  assert.deepEqual(store.queryTotals({ scope: 'consumption' }), {
    requestCount: 3,
    successCount: 1,
    errorCount: 2,
    totalRequestBytes: 127,
    totalResponseBytes: 230,
    avgTtfbMs: 12,
    avgDurationMs: 33,
  });

  const hourly = store.queryHourly({ scope: 'all' });
  assert.deepEqual(hourly.map(({ hourBucketMs, requestCount }) => ({ hourBucketMs, requestCount })), [
    { hourBucketMs: Math.floor(BASE_MS / HOUR_MS) * HOUR_MS, requestCount: 2 },
    { hourBucketMs: Math.floor((BASE_MS + HOUR_MS) / HOUR_MS) * HOUR_MS, requestCount: 3 },
  ]);
  assert.equal(store.queryTotals({ scope: 'all', machineId: 'machine-1' }).requestCount, 2);
  assert.equal(store.queryTotals({ scope: 'all', unattributedMachine: true }).requestCount, 2);
  assert.equal(store.queryTotals({ scope: 'all', memberLabel: 'bob' }).requestCount, 2);
  assert.equal(store.queryTotals({ scope: 'all', accountId: 'account-2' }).requestCount, 2);
  assert.equal(store.queryTotals({ scope: 'all', model: 'model-a' }).requestCount, 2);
  assert.equal(
    store.queryTotals({ scope: 'all', fromMs: BASE_MS + HOUR_MS, toMs: BASE_MS + 2 * HOUR_MS }).requestCount,
    3,
  );

  const machineBreakdown = store.queryBreakdown({ by: 'machine', scope: 'all' });
  assert.deepEqual(
    machineBreakdown.map(({ groupValue, requestCount }) => ({ groupValue, requestCount })),
    [
      { groupValue: 'machine-1', requestCount: 2 },
      { groupValue: null, requestCount: 2 },
      { groupValue: 'machine-2', requestCount: 1 },
    ],
  );
  assert.equal(store.queryBreakdown({ by: 'member', scope: 'consumption' })[0].groupValue, 'alice');
  assert.throws(
    () => store.queryTotals({ scope: 'unexpected' }),
    /scope must be all or consumption/,
  );
  assert.throws(
    () => store.queryBreakdown({ by: 'path' }),
    /breakdown must be machine, device, member, account, or model/,
  );
});

test('device IDs remain distinct when machine handles are absent', async (t) => {
  const { store } = await newStore(t);
  const shared = {
    machineId: null,
    memberLabel: 'same-member',
    accountId: 'same-account',
    accountAlias: 'same-account',
    model: 'same-model',
  };
  assert.equal(store.enqueueRequest(row({ ...shared, deviceId: 'device-a' })), true);
  assert.equal(store.enqueueRequest(row({ ...shared, deviceId: 'device-b', startedAtMs: BASE_MS + 1 })), true);
  store.flush();

  assert.equal(
    store.queryTotals({ scope: 'all', deviceId: 'device-a', unattributedMachine: true }).requestCount,
    1,
  );
  assert.equal(
    store.queryTotals({ scope: 'all', deviceId: 'device-b', unattributedMachine: true }).requestCount,
    1,
  );
  assert.equal(
    store.queryTotals({ scope: 'all', memberLabel: 'same-member', unattributedMachine: true }).requestCount,
    2,
  );
  assert.deepEqual(
    store.queryBreakdown({ by: 'device', scope: 'all', unattributedMachine: true })
      .map(({ groupValue, requestCount }) => ({ groupValue, requestCount })),
    [
      { groupValue: 'device-a', requestCount: 1 },
      { groupValue: 'device-b', requestCount: 1 },
    ],
  );
  assert.deepEqual(
    store.queryBreakdown({ by: 'machine', scope: 'all', unattributedMachine: true })
      .map(({ groupValue, requestCount }) => ({ groupValue, requestCount })),
    [{ groupValue: null, requestCount: 2 }],
  );
});

test('breakdowns are bounded before untrusted model cardinality reaches the page', async (t) => {
  const { store } = await newStore(t, { batchSize: 600, maxQueue: 600 });
  for (let index = 0; index < 510; index += 1) {
    assert.equal(store.enqueueRequest(row({
      startedAtMs: BASE_MS + index,
      model: `model-${String(index).padStart(3, '0')}`,
    })), true);
  }
  assert.equal(store.flush().written, 510);
  assert.equal(store.queryBreakdown({ by: 'model', scope: 'all' }).length, 500);
});

test('row normalization bounds strings, preserves nulls, and ignores body-like fields', async (t) => {
  const { store, dbPath } = await newStore(t);
  const longModel = 'm'.repeat(1000);
  const longMember = 'u'.repeat(300);
  const longRequestId = 'r'.repeat(500);
  assert.equal(store.enqueueRequest(row({
    memberLabel: longMember,
    model: longModel,
    stream: 'true',
    machineId: '',
    upstreamRequestId: longRequestId,
    body: 'this must not be stored',
    oauthToken: 'this must not be stored',
  })), true);
  store.flush();

  const db = readOnly(dbPath);
  t.after(() => db.close());
  const stored = db.prepare(`
    SELECT member_label, model, stream, machine_id, upstream_request_id
    FROM request_metrics
  `).get();
  assert.equal(stored.member_label.length, 160);
  assert.equal(stored.model.length, 256);
  assert.equal(stored.stream, null);
  assert.equal(stored.machine_id, null);
  assert.equal(stored.upstream_request_id.length, 256);
  assert.equal(Object.hasOwn(stored, 'body'), false);
  assert.equal(Object.hasOwn(stored, 'oauthToken'), false);
});

test('checkpoint refuses a live reader and succeeds after it releases the WAL', async (t) => {
  const { store, dbPath } = await newStore(t);
  store.enqueueRequest(row({ startedAtMs: BASE_MS }));
  store.enqueueRequest(row({ startedAtMs: BASE_MS + 1 }));
  store.flush();

  const reader = readOnly(dbPath);
  const cursor = reader.prepare('SELECT id FROM request_metrics ORDER BY id').iterate();
  assert.equal(cursor.next().done, false);
  store.enqueueRequest(row({ startedAtMs: BASE_MS + 2 }));
  store.flush();
  assert.throws(
    () => store.checkpoint(),
    (error) => error.result?.busy === 1,
  );
  while (!cursor.next().done) {}
  reader.close();
  assert.equal(store.checkpoint().busy, 0);
});

test('integrityCheck accepts exactly one ok result and rejects any other result', async (t) => {
  const { store } = await newStore(t);
  assert.equal(store.integrityCheck(), true);

  const realDb = store.db;
  store.db = {
    isOpen: true,
    prepare() {
      return { all: () => [{ integrity_check: 'not ok' }, { integrity_check: 'still broken' }] };
    },
  };
  assert.throws(
    () => store.integrityCheck(),
    (error) => Array.isArray(error.result) && error.result.length === 2,
  );
  store.db = realDb;
});

test('close flushes and checkpoints once, is idempotent, and stops accepting rows', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-close-'));
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await store.init();
  assert.equal(store.enqueueRequest(row()), true);
  assert.deepEqual(store.close(), { written: 1, dropped: 0, failed: 0 });
  assert.deepEqual(store.close(), { written: 0, dropped: 0, failed: 0 });
  assert.equal(store.enqueueRequest(row({ startedAtMs: BASE_MS + 1 })), false);

  const db = readOnly(join(home, METRICS_FILENAME));
  assert.equal(rowCount(db), 1);
  db.close();
  t.after(() => store.close());
});

test('close can skip its explicit checkpoint after an integrity failure', async (t) => {
  const { store } = await newStore(t);
  let checkpoints = 0;
  store.checkpoint = () => {
    checkpoints += 1;
    return { busy: 0, log: 0, checkpointed: 0 };
  };
  store.close({ checkpoint: false });
  assert.equal(checkpoints, 0);
});

test('flush failure is isolated and never throws into the caller', async (t) => {
  const events = [];
  const { store } = await newStore(t, { log: (event, detail) => events.push({ event, detail }) });
  // SQLite query_only makes the already-open connection reject writes reliably;
  // chmod alone is not sufficient after a connection has opened the file.
  store.db.exec('PRAGMA query_only = ON');
  assert.equal(store.enqueueRequest(row()), true);
  assert.deepEqual(store.flush(), { queued: 1, written: 0, dropped: 1, failed: 1 });
  assert.equal(events.some(({ event }) => event === 'metrics_flush_failed'), true);
  assert.doesNotThrow(() => store.close());
});

test('a transient SQLite writer lock requeues the whole batch and succeeds later', async (t) => {
  const { store, dbPath } = await newStore(t);
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('BEGIN IMMEDIATE');
  t.after(() => {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
  });
  assert.equal(store.enqueueRequest(row()), true);
  assert.deepEqual(store.flush(), { queued: 1, written: 0, dropped: 0, failed: 1 });
  assert.equal(store.queue.length, 1);
  blocker.exec('ROLLBACK');
  assert.deepEqual(store.flush(), { queued: 1, written: 1, dropped: 0, failed: 0 });
  assert.equal(store.queryTotals({ scope: 'all' }).requestCount, 1);
});

test('a future schema version is refused rather than silently rewritten', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-version-'));
  const first = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await first.init();
  first.close();
  const dbPath = join(home, METRICS_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE schema_meta SET schema_version = ? WHERE singleton = 1').run(
    METRICS_SCHEMA_VERSION + 1,
  );
  db.close();

  const second = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await assert.rejects(
    second.init(),
    /is newer than supported/,
  );
  t.after(() => second.close());
});

test('an existing empty or unrelated database is refused instead of silently replaced', async (t) => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'credential-console-metrics-empty-existing-'));
  const emptyPath = join(emptyHome, METRICS_FILENAME);
  const empty = new DatabaseSync(emptyPath);
  empty.close();
  const emptyStore = new MetricsStore({ home: emptyHome });
  await assert.rejects(emptyStore.init(), /empty or is not a regular file/);
  t.after(() => emptyStore.close());

  const unrelatedHome = await mkdtemp(join(tmpdir(), 'credential-console-metrics-unrelated-'));
  const unrelatedPath = join(unrelatedHome, METRICS_FILENAME);
  const unrelated = new DatabaseSync(unrelatedPath);
  unrelated.exec('CREATE TABLE unrelated (value TEXT)');
  unrelated.close();
  const unrelatedStore = new MetricsStore({ home: unrelatedHome });
  await assert.rejects(unrelatedStore.init(), /no recognized schema metadata/);
  const verify = new DatabaseSync(unrelatedPath, { readOnly: true });
  assert.equal(
    verify.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'request_metrics'").get().count,
    0,
  );
  verify.close();
  t.after(() => unrelatedStore.close());
});

test('checkpoint-metrics CLI is safe before the database exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-cli-empty-'));
  const result = await execFileAsync(process.execPath, ['--no-warnings', CLI, 'checkpoint-metrics'], {
    env: { ...process.env, CREDENTIAL_CONSOLE_HOME: home },
  });
  assert.match(result.stdout, /metrics database not present/);
  await assert.rejects(access(join(home, METRICS_FILENAME)), { code: 'ENOENT' });
});

test('checkpoint-metrics CLI integrity-checks and truncates an existing database', async (t) => {
  const { home, store, dbPath } = await newStore(t);
  store.enqueueRequest(row());
  store.flush();
  store.close();

  const result = await execFileAsync(process.execPath, ['--no-warnings', CLI, 'checkpoint-metrics'], {
    env: { ...process.env, CREDENTIAL_CONSOLE_HOME: home },
  });
  const reported = JSON.parse(result.stdout);
  assert.equal(reported.database, dbPath);
  assert.equal(reported.integrity, 'ok');
  assert.equal(reported.checkpoint.busy, 0);
  assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
});
