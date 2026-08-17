import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { access, copyFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

async function createV1Database(home, { version = 1, entry = row() } = {}) {
  const dbPath = join(home, METRICS_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE request_metrics (
      id INTEGER PRIMARY KEY,
      started_at_ms INTEGER NOT NULL,
      hour_bucket_ms INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      device_id TEXT NOT NULL,
      machine_id TEXT,
      member_label TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_alias TEXT NOT NULL,
      model TEXT,
      stream INTEGER CHECK (stream IS NULL OR stream IN (0, 1)),
      status_code INTEGER,
      outcome TEXT NOT NULL,
      ttfb_ms INTEGER CHECK (ttfb_ms IS NULL OR ttfb_ms >= 0),
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      request_bytes INTEGER NOT NULL CHECK (request_bytes >= 0),
      response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
      upstream_request_id TEXT
    );
  `);
  db.prepare(`
    INSERT INTO schema_meta (singleton, schema_version, updated_at_ms)
    VALUES (1, ?, ?)
  `).run(version, BASE_MS);
  db.prepare(`
    INSERT INTO request_metrics (
      started_at_ms, hour_bucket_ms, method, path, device_id, machine_id,
      member_label, account_id, account_alias, model, stream, status_code,
      outcome, ttfb_ms, duration_ms, request_bytes, response_bytes,
      upstream_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.startedAtMs,
    Math.floor(entry.startedAtMs / HOUR_MS) * HOUR_MS,
    entry.method,
    entry.path,
    entry.deviceId,
    entry.machineId,
    entry.memberLabel,
    entry.accountId,
    entry.accountAlias,
    entry.model,
    entry.stream === null || entry.stream === undefined ? null : (entry.stream ? 1 : 0),
    entry.statusCode,
    entry.outcome,
    entry.ttfbMs,
    entry.durationMs,
    entry.requestBytes,
    entry.responseBytes,
    entry.upstreamRequestId,
  );
  db.close();
  return dbPath;
}

test('initializes a private WAL/NORMAL database with schema version and indexes', async (t) => {
  const { store, dbPath } = await newStore(t);
  assert.equal(METRICS_SCHEMA_VERSION, 2);
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

test('migrates a v1 database in place and keeps old rows readable', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v1-'));
  const stateBytes = Buffer.from('{"state":"must remain byte-identical"}\n');
  await writeFile(join(home, 'state.json'), stateBytes, { mode: 0o600 });
  const dbPath = await createV1Database(home, {
    entry: row({ machineId: null, memberLabel: 'legacy-member' }),
  });
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await store.init();
  t.after(() => store.close());

  const db = readOnly(dbPath);
  t.after(() => db.close());
  assert.equal(
    db.prepare('SELECT schema_version FROM schema_meta WHERE singleton = 1').get().schema_version,
    2,
  );
  assert.deepEqual(store.queryTotals({ scope: 'all' }), {
    requestCount: 1,
    successCount: 1,
    errorCount: 0,
    totalRequestBytes: 100,
    totalResponseBytes: 200,
    avgTtfbMs: 12,
    avgDurationMs: 45,
    totalInputTokens: null,
    totalInputTokensKnownCount: 0,
    totalCacheCreationInputTokens: null,
    totalCacheCreationInputTokensKnownCount: 0,
    totalCacheReadInputTokens: null,
    totalCacheReadInputTokensKnownCount: 0,
    totalOutputTokens: null,
    totalOutputTokensKnownCount: 0,
    usageCompleteCount: 0,
    usagePartialCount: 0,
    usageUnavailableCount: 1,
    tokenTotalsOverflow: false,
  });
  const columns = db.prepare('PRAGMA table_info(request_metrics)').all().map(({ name }) => name);
  assert.deepEqual(columns.slice(-5), [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
    'usage_state',
  ]);
  assert.deepEqual(await readFile(join(home, 'state.json')), stateBytes);
});

test('aggregates complete, partial, unavailable, NULL, and explicit zero usage distinctly', async (t) => {
  const { store } = await newStore(t, { batchSize: 8 });
  const entries = [
    row({
      usageState: 'complete',
      inputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: null,
      outputTokens: 5,
    }),
    row({
      startedAtMs: BASE_MS + 1,
      usageState: 'partial',
      inputTokens: 3,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 2,
      outputTokens: null,
    }),
    row({
      startedAtMs: BASE_MS + 2,
      usageState: 'unavailable',
      inputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: null,
    }),
  ];
  for (const entry of entries) assert.equal(store.enqueueRequest(entry), true);
  assert.equal(store.flush().written, entries.length);

  assert.deepEqual(store.queryTotals({ scope: 'all' }), {
    requestCount: 3,
    successCount: 3,
    errorCount: 0,
    totalRequestBytes: 300,
    totalResponseBytes: 600,
    avgTtfbMs: 12,
    avgDurationMs: 45,
    totalInputTokens: 13,
    totalInputTokensKnownCount: 2,
    totalCacheCreationInputTokens: 0,
    totalCacheCreationInputTokensKnownCount: 1,
    totalCacheReadInputTokens: 2,
    totalCacheReadInputTokensKnownCount: 1,
    totalOutputTokens: 5,
    totalOutputTokensKnownCount: 1,
    usageCompleteCount: 1,
    usagePartialCount: 1,
    usageUnavailableCount: 1,
    tokenTotalsOverflow: false,
  });
  const [hour] = store.queryHourly({ scope: 'all' });
  assert.equal(hour.totalInputTokens, 13);
  assert.equal(hour.totalCacheCreationInputTokens, 0);
  assert.equal(hour.totalCacheReadInputTokens, 2);
  assert.equal(hour.totalOutputTokens, 5);
  assert.equal(hour.totalInputTokensKnownCount, 2);
  assert.equal(hour.usagePartialCount, 1);
});

test('token aggregation reports overflow without making metrics queries fail', async (t) => {
  const count = 1025;
  const { store } = await newStore(t, { batchSize: count, maxQueue: count });
  for (let index = 0; index < count; index += 1) {
    assert.equal(store.enqueueRequest(row({
      startedAtMs: BASE_MS + index,
      usageState: 'complete',
      inputTokens: Number.MAX_SAFE_INTEGER,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: Number.MAX_SAFE_INTEGER,
    })), true);
  }
  assert.equal(store.flush().written, count);
  for (const aggregate of [
    store.queryTotals({ scope: 'consumption' }),
    store.queryHourly({ scope: 'consumption' })[0],
    store.queryBreakdown({ by: 'member', scope: 'consumption' })[0],
  ]) {
    assert.equal(aggregate.requestCount, count);
    assert.equal(aggregate.totalInputTokens, null);
    assert.equal(aggregate.totalOutputTokens, null);
    assert.equal(aggregate.totalInputTokensKnownCount, count);
    assert.equal(aggregate.totalOutputTokensKnownCount, count);
    assert.equal(aggregate.totalCacheCreationInputTokens, 0);
    assert.equal(aggregate.tokenTotalsOverflow, true);
  }
});

test('token aggregates honor existing filters and consumption scope', async (t) => {
  const { store } = await newStore(t, { batchSize: 8 });
  const entries = [
    row({
      deviceId: 'device-a',
      machineId: 'machine-a',
      memberLabel: 'alice',
      accountId: 'account-a',
      model: 'model-a',
      usageState: 'complete',
      inputTokens: 10,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      outputTokens: 3,
    }),
    row({
      startedAtMs: BASE_MS + 1,
      path: '/v1/messages/count_tokens',
      deviceId: 'device-a',
      machineId: 'machine-a',
      memberLabel: 'alice',
      accountId: 'account-a',
      model: 'model-a',
      usageState: 'complete',
      inputTokens: 20,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      outputTokens: 4,
    }),
    row({
      startedAtMs: BASE_MS + 2,
      deviceId: 'device-b',
      machineId: null,
      memberLabel: 'bob',
      accountId: 'account-b',
      model: 'model-b',
      usageState: 'partial',
      inputTokens: 30,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: null,
    }),
    row({
      startedAtMs: BASE_MS + 3,
      path: '/v1/models',
      deviceId: 'device-c',
      machineId: 'machine-c',
      memberLabel: 'carol',
      accountId: 'account-c',
      model: 'model-c',
      usageState: 'complete',
      inputTokens: 40,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 5,
      outputTokens: 6,
    }),
  ];
  for (const entry of entries) assert.equal(store.enqueueRequest(entry), true);
  assert.equal(store.flush().written, entries.length);

  assert.equal(store.queryTotals({ scope: 'consumption' }).requestCount, 2);
  assert.equal(store.queryTotals({ scope: 'consumption' }).totalInputTokens, 40);
  assert.equal(store.queryTotals({ scope: 'all' }).totalInputTokens, 100);
  assert.equal(
    store.queryTotals({ scope: 'all', deviceId: 'device-a' }).totalOutputTokens,
    7,
  );
  assert.equal(
    store.queryTotals({ scope: 'all', machineId: 'machine-a', memberLabel: 'alice' })
      .totalInputTokens,
    30,
  );
  assert.equal(
    store.queryTotals({ scope: 'all', unattributedMachine: true }).totalInputTokens,
    30,
  );
  assert.equal(
    store.queryTotals({ scope: 'all', accountId: 'account-b', model: 'model-b' })
      .usagePartialCount,
    1,
  );
});

test('reopens v2 data and a checkpointed copy is backup-compatible', async (t) => {
  const { home, store, dbPath } = await newStore(t, { batchSize: 4 });
  store.enqueueRequest(row({
    usageState: 'complete',
    inputTokens: 7,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 1,
    outputTokens: 2,
  }));
  assert.equal(store.flush().written, 1);
  assert.equal(store.checkpoint().busy, 0);
  store.close();

  const reopened = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await reopened.init();
  assert.equal(reopened.queryTotals().totalInputTokens, 7);
  reopened.close();

  const backupHome = await mkdtemp(join(tmpdir(), 'credential-console-metrics-backup-'));
  await copyFile(dbPath, join(backupHome, METRICS_FILENAME));
  const backup = new MetricsStore({ home: backupHome, flushIntervalMs: 60_000 });
  await backup.init();
  t.after(() => backup.close());
  assert.equal(backup.queryTotals().totalOutputTokens, 2);
  assert.equal(backup.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
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
    totalInputTokens: null,
    totalInputTokensKnownCount: 0,
    totalCacheCreationInputTokens: null,
    totalCacheCreationInputTokensKnownCount: 0,
    totalCacheReadInputTokens: null,
    totalCacheReadInputTokensKnownCount: 0,
    totalOutputTokens: null,
    totalOutputTokensKnownCount: 0,
    usageCompleteCount: 0,
    usagePartialCount: 0,
    usageUnavailableCount: 5,
    tokenTotalsOverflow: false,
  });
  assert.deepEqual(store.queryTotals({ scope: 'consumption' }), {
    requestCount: 3,
    successCount: 1,
    errorCount: 2,
    totalRequestBytes: 127,
    totalResponseBytes: 230,
    avgTtfbMs: 12,
    avgDurationMs: 33,
    totalInputTokens: null,
    totalInputTokensKnownCount: 0,
    totalCacheCreationInputTokens: null,
    totalCacheCreationInputTokensKnownCount: 0,
    totalCacheReadInputTokens: null,
    totalCacheReadInputTokensKnownCount: 0,
    totalOutputTokens: null,
    totalOutputTokensKnownCount: 0,
    usageCompleteCount: 0,
    usagePartialCount: 0,
    usageUnavailableCount: 3,
    tokenTotalsOverflow: false,
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
    SELECT member_label, model, stream, machine_id, upstream_request_id,
      input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      output_tokens, usage_state
    FROM request_metrics
  `).get();
  assert.equal(stored.member_label.length, 160);
  assert.equal(stored.model.length, 256);
  assert.equal(stored.stream, null);
  assert.equal(stored.machine_id, null);
  assert.equal(stored.upstream_request_id.length, 256);
  assert.equal(stored.input_tokens, null);
  assert.equal(stored.cache_creation_input_tokens, null);
  assert.equal(stored.cache_read_input_tokens, null);
  assert.equal(stored.output_tokens, null);
  assert.equal(stored.usage_state, 'unavailable');
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

test('invalid usage states and counts are dropped before SQLite is touched', async (t) => {
  const events = [];
  const { store } = await newStore(t, {
    log: (event, detail) => events.push({ event, detail }),
  });
  const invalid = [
    { usageState: 'unknown' },
    { usageState: null },
    { usageState: 'unavailable', inputTokens: 1 },
    { usageState: 'partial' },
    { usageState: 'complete', inputTokens: null, outputTokens: 1 },
    { usageState: 'complete', inputTokens: 1, outputTokens: -1 },
    { usageState: 'partial', inputTokens: 1.5 },
  ];
  for (const overrides of invalid) {
    assert.equal(store.enqueueRequest(row(overrides)), false, JSON.stringify(overrides));
  }
  assert.equal(store.queue.length, 0);
  assert.equal(store.flush().written, 0);
  assert.equal(store.queryTotals().requestCount, 0);
  assert.equal(events.filter(({ event }) => event === 'metrics_row_rejected').length, invalid.length);
});

test('a v1 migration rolls back all DDL when metadata update fails', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-migration-rollback-'));
  const dbPath = await createV1Database(home);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TRIGGER reject_metrics_upgrade
    BEFORE UPDATE OF schema_version ON schema_meta
    BEGIN
      SELECT RAISE(ABORT, 'migration deliberately blocked');
    END;
  `);
  db.close();

  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await assert.rejects(store.init(), /migration deliberately blocked/);
  t.after(() => store.close());

  const verify = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => verify.close());
  assert.equal(
    verify.prepare('SELECT schema_version FROM schema_meta WHERE singleton = 1').get().schema_version,
    1,
  );
  const columns = verify.prepare('PRAGMA table_info(request_metrics)').all().map(({ name }) => name);
  assert.equal(columns.includes('input_tokens'), false);
});

test('an untrusted partially added v1 schema is refused without being promoted', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-partial-schema-'));
  const dbPath = await createV1Database(home);
  const partial = new DatabaseSync(dbPath);
  partial.exec(
    'ALTER TABLE request_metrics ADD COLUMN input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0)',
  );
  partial.close();

  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await assert.rejects(store.init(), /untrusted partial v2 columns: input_tokens/);
  t.after(() => store.close());

  const verify = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => verify.close());
  assert.equal(verify.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 1);
  const columns = verify.prepare('PRAGMA table_info(request_metrics)').all().map(({ name }) => name);
  assert.equal(columns.includes('input_tokens'), true);
  assert.equal(columns.includes('output_tokens'), false);
});

test('corrupt v2 schemas with a missing column or CHECK constraint are refused', async (t) => {
  const valid = await newStore(t);
  valid.store.close();
  const corrupt = new DatabaseSync(valid.dbPath);
  corrupt.exec('ALTER TABLE request_metrics RENAME COLUMN output_tokens TO output_tokens_removed');
  corrupt.close();
  const reopened = new MetricsStore({ home: valid.home, flushIntervalMs: 60_000 });
  await assert.rejects(reopened.init(), /missing column output_tokens/);
  t.after(() => reopened.close());

  const uncheckedHome = await mkdtemp(join(tmpdir(), 'credential-console-metrics-unchecked-v2-'));
  const uncheckedPath = await createV1Database(uncheckedHome);
  const unchecked = new DatabaseSync(uncheckedPath);
  unchecked.exec(`
    ALTER TABLE request_metrics ADD COLUMN input_tokens INTEGER;
    ALTER TABLE request_metrics ADD COLUMN cache_creation_input_tokens INTEGER;
    ALTER TABLE request_metrics ADD COLUMN cache_read_input_tokens INTEGER;
    ALTER TABLE request_metrics ADD COLUMN output_tokens INTEGER;
    ALTER TABLE request_metrics ADD COLUMN usage_state TEXT NOT NULL DEFAULT 'unavailable';
    UPDATE schema_meta SET schema_version = 2;
  `);
  unchecked.close();
  const uncheckedStore = new MetricsStore({ home: uncheckedHome, flushIntervalMs: 60_000 });
  await assert.rejects(uncheckedStore.init(), /missing its non-negative CHECK constraint/);
  t.after(() => uncheckedStore.close());
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
