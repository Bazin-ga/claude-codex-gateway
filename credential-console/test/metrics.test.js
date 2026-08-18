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

async function createV2Database(home, options = {}) {
  const dbPath = await createV1Database(home, options);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    ALTER TABLE request_metrics ADD COLUMN input_tokens INTEGER
      CHECK (input_tokens IS NULL OR input_tokens >= 0);
    ALTER TABLE request_metrics ADD COLUMN cache_creation_input_tokens INTEGER
      CHECK (cache_creation_input_tokens IS NULL OR cache_creation_input_tokens >= 0);
    ALTER TABLE request_metrics ADD COLUMN cache_read_input_tokens INTEGER
      CHECK (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0);
    ALTER TABLE request_metrics ADD COLUMN output_tokens INTEGER
      CHECK (output_tokens IS NULL OR output_tokens >= 0);
    ALTER TABLE request_metrics ADD COLUMN usage_state TEXT NOT NULL DEFAULT 'unavailable'
      CHECK (usage_state IN ('unavailable', 'partial', 'complete'));
    UPDATE schema_meta SET schema_version = 2 WHERE singleton = 1;
  `);
  db.close();
  return dbPath;
}

async function createV3Database(home, options = {}) {
  const dbPath = await createV2Database(home, options);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    ALTER TABLE request_metrics ADD COLUMN conversation_capture_state TEXT NOT NULL
      DEFAULT 'not_applicable'
      CHECK (conversation_capture_state IN ('not_applicable', 'stored', 'dropped'));
    CREATE TABLE conversation_turns (
      id INTEGER PRIMARY KEY,
      request_metrics_id INTEGER NOT NULL UNIQUE
        REFERENCES request_metrics(id) ON DELETE RESTRICT,
      prompt_text TEXT NOT NULL CHECK (length(prompt_text) > 0),
      prompt_bytes INTEGER NOT NULL CHECK (prompt_bytes > 0),
      response_text TEXT NOT NULL DEFAULT '',
      response_state TEXT NOT NULL
        CHECK (response_state IN ('complete', 'incomplete', 'truncated', 'unavailable')),
      response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0)
    );
    CREATE VIRTUAL TABLE conversation_turns_fts USING fts5(
      prompt_text, response_text, content='conversation_turns', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE conversation_turns_trigram_fts USING fts5(
      prompt_text, response_text, content='conversation_turns', content_rowid='id',
      tokenize='trigram'
    );
    CREATE INDEX conversation_turns_metrics_idx ON conversation_turns(request_metrics_id);
    CREATE TRIGGER conversation_turns_fts_ai
    AFTER INSERT ON conversation_turns
    BEGIN
      INSERT INTO conversation_turns_fts(rowid, prompt_text, response_text)
      VALUES (new.id, new.prompt_text, new.response_text);
    END;
    CREATE TRIGGER conversation_turns_trigram_fts_ai
    AFTER INSERT ON conversation_turns
    BEGIN
      INSERT INTO conversation_turns_trigram_fts(rowid, prompt_text, response_text)
      VALUES (new.id, new.prompt_text, new.response_text);
    END;
    CREATE TRIGGER conversation_turns_no_update
    BEFORE UPDATE ON conversation_turns
    BEGIN
      SELECT RAISE(ABORT, 'conversation turns are permanent');
    END;
    CREATE TRIGGER conversation_turns_no_delete
    BEFORE DELETE ON conversation_turns
    BEGIN
      SELECT RAISE(ABORT, 'conversation turns are permanent');
    END;
  `);
  const promptText = options.promptText ?? 'legacy v3 prompt';
  const responseText = options.responseText ?? 'legacy v3 response';
  db.prepare(`
    INSERT INTO conversation_turns (
      request_metrics_id, prompt_text, prompt_bytes, response_text,
      response_state, response_bytes
    ) VALUES (1, ?, ?, ?, 'complete', ?)
  `).run(
    promptText,
    Buffer.byteLength(promptText),
    responseText,
    Buffer.byteLength(responseText),
  );
  db.prepare(`
    UPDATE request_metrics
    SET conversation_capture_state = 'stored'
    WHERE id = 1
  `).run();
  db.prepare('UPDATE schema_meta SET schema_version = 3 WHERE singleton = 1').run();
  db.close();
  return dbPath;
}

test('initializes a private WAL/NORMAL database with schema version and indexes', async (t) => {
  const { store, dbPath } = await newStore(t);
  assert.equal(METRICS_SCHEMA_VERSION, 4);
  assert.equal((await stat(dbPath)).mode & 0o777, 0o600);

  const db = readOnly(dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
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
    'request_metrics_conversation_capture_idx',
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
    4,
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
  for (const name of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
    'usage_state',
    'conversation_capture_state',
  ]) assert.equal(columns.includes(name), true, name);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_turns').get().count, 0);
  assert.deepEqual(await readFile(join(home, 'state.json')), stateBytes);
});

test('migrates a v2 database to v3 with FTS in one transaction', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v2-'));
  const dbPath = await createV2Database(home, { entry: row({ memberLabel: 'v2-member' }) });
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await store.init();
  t.after(() => store.close());

  const db = readOnly(dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversation_turns").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'conversation_turns_fts'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'conversation_turns_trigram_fts'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'conversation_turns_trigram_fts_ai'").get().count, 1);
  assert.equal(store.queryTotals().requestCount, 1);
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

test('paired completion stores conversation, FTS index, and safe metadata only', async (t) => {
  const { store, dbPath } = await newStore(t, { batchSize: 4 });
  const metrics = row({
    responseBytes: 20,
    upstreamRequestId: 'header-value-must-not-be-in-conversation',
  });
  assert.equal(store.enqueueCompletion({
    metrics,
    conversation: {
      promptText: 'hello search phrase',
      promptBytes: Buffer.byteLength('hello search phrase'),
      responseText: 'safe assistant reply',
      responseState: 'complete',
      responseBytes: 20,
      deviceToken: 'ignored-device-token',
      providerCredential: 'ignored-provider-credential',
      headers: { authorization: 'ignored-header' },
    },
  }), true);
  assert.equal(store.flush().written, 1);

  const db = readOnly(dbPath);
  t.after(() => db.close());
  const stored = db.prepare('SELECT * FROM conversation_turns').get();
  assert.equal(stored.prompt_text, 'hello search phrase');
  assert.equal(stored.response_text, 'safe assistant reply');
  assert.equal(Object.hasOwn(stored, 'device_token'), false);
  assert.equal(Object.hasOwn(stored, 'provider_credential'), false);
  assert.equal(Object.hasOwn(stored, 'headers'), false);
  assert.equal(db.prepare('SELECT conversation_capture_state FROM request_metrics').get().conversation_capture_state, 'stored');

  const search = store.searchConversations({ q: 'search phrase', limit: 1 });
  assert.equal(search.error, null);
  assert.equal(search.items.length, 1);
  assert.match(search.items[0].promptSnippet, /search phrase/);
  assert.equal(store.searchConversations({ q: '" OR 1=1 --' }).error, null);
  assert.equal(store.readConversation(stored.id).turn.responseText, 'safe assistant reply');
  assert.equal(store.readConversation('not-an-id').error, 'conversation_unavailable');

  assert.equal(store.checkpoint().busy, 0);
  const backupHome = await mkdtemp(join(tmpdir(), 'credential-console-metrics-conversation-backup-'));
  await copyFile(dbPath, join(backupHome, METRICS_FILENAME));
  const backup = await new MetricsStore({ home: backupHome, flushIntervalMs: 60_000 }).init();
  t.after(() => backup.close());
  assert.equal(backup.searchConversations({ q: 'search phrase' }).items.length, 1);
  assert.equal(backup.integrityCheck(), true);

  assert.throws(
    () => store.db.exec(`UPDATE conversation_turns SET response_text = 'changed' WHERE id = ${stored.id}`),
    /conversation turns are permanent/,
  );
  assert.throws(
    () => store.db.exec(`DELETE FROM conversation_turns WHERE id = ${stored.id}`),
    /conversation turns are permanent/,
  );
});

test('schema v4 groups supplied HMAC thread keys and exposes provenance', async (t) => {
  // The proxy computes this digest with CredentialStore.master.key.  Metrics
  // accepts only the digest and stores that exact 64-hex value.
  const threadKey = 'a'.repeat(64);
  const { store, dbPath } = await newStore(t, { batchSize: 8 });
  for (const [index, [promptText, promptSource]] of [
    ['captured user text', 'captured_api_user_text'],
    ['wrapper removed', 'wrapper_removed'],
    ['fallback raw', 'fallback_raw'],
  ].entries()) {
    assert.equal(store.enqueueCompletion({
      metrics: row({ startedAtMs: BASE_MS + index, memberLabel: index === 1 ? 'bob' : 'alice' }),
      conversation: {
        threadKey,
        headers: { 'x-claude-code-session-id': 'raw-header-must-not-reach-metrics' },
        promptText,
        promptSource,
        promptSuffixOmitted: index === 1,
        responseText: `reply-${index}`,
        responseState: 'complete',
        responseBytes: Buffer.byteLength(`reply-${index}`),
      },
    }), true);
  }
  assert.equal(store.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 10, memberLabel: 'legacy-only' }),
    conversation: {
      promptText: 'standalone legacy-shaped turn',
      responseText: 'standalone reply',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('standalone reply'),
    },
  }), true);
  assert.equal(store.flush().written, 4);

  const db = readOnly(dbPath);
  t.after(() => db.close());
  const rows = db.prepare(`
    SELECT conversation_session_id, turn_index, prompt_source, prompt_suffix_omitted
    FROM conversation_turns
    ORDER BY id ASC
  `).all();
  assert.deepEqual(rows.slice(0, 3).map((entry) => [
    Number(entry.conversation_session_id), Number(entry.turn_index),
    entry.prompt_source, Number(entry.prompt_suffix_omitted),
  ]), [
    [1, 1, 'captured_api_user_text', 0],
    [1, 2, 'wrapper_removed', 1],
    [1, 3, 'fallback_raw', 0],
  ]);
  assert.equal(rows[3].conversation_session_id, null);
  assert.equal(rows[3].turn_index, null);
  const storedThreadKey = db.prepare(
    'SELECT thread_key FROM conversation_sessions WHERE id = 1',
  ).get().thread_key;
  assert.match(storedThreadKey, /^[0-9a-f]{64}$/);
  assert.equal(storedThreadKey, threadKey);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM pragma_table_info('conversation_sessions') WHERE name LIKE '%header%'",
  ).get().count, 0);

  const sessions = store.searchConversationSessions({ q: 'reply', limit: 5 });
  assert.equal(sessions.error, null);
  assert.equal(sessions.totalMatches, 1);
  assert.equal(sessions.items.length, 1);
  assert.equal(sessions.items[0].turnCount, 3);
  assert.equal(sessions.items[0].deviceId, 'device-1');
  assert.equal(sessions.items[0].memberLabel, 'alice');
  assert.equal(sessions.items[0].accountAlias, 'claude-team');
  assert.equal(sessions.items[0].model, 'claude-test');
  assert.equal(sessions.items[0].latestPromptSource, 'fallback_raw');
  assert.equal(sessions.items[0].latestPromptSuffixOmitted, false);
  const detail = store.readConversationSession(sessions.items[0].id);
  assert.equal(detail.error, null);
  assert.equal(detail.session.turnCount, 3);
  assert.equal(detail.session.turns.length, 3);
  assert.deepEqual(detail.session.turns.map((turn) => turn.turnIndex), [1, 2, 3]);
  assert.deepEqual(detail.session.turns.map((turn) => [
    turn.promptSource, turn.promptSuffixOmitted,
  ]), [
    ['captured_api_user_text', false],
    ['wrapper_removed', true],
    ['fallback_raw', false],
  ]);
  assert.equal(detail.session.standaloneCount, 1);
  const sessionFacets = store.queryConversationSessionFacets({});
  assert.equal(sessionFacets.totalStored, 1);
  assert.deepEqual(sessionFacets.members.map((entry) => [entry.value, entry.count]), [
    ['alice', 1],
    ['bob', 1],
  ]);
  assert.equal(sessionFacets.members.some((entry) => entry.value === 'legacy-only'), false);
  assert.equal(store.readConversationSession('not-an-id').error, 'conversation_unavailable');

});

test('schema v4 migrates v3 turns to standalone defaults without guessing a session', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v3-to-v4-'));
  const dbPath = await createV3Database(home);
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await store.init();
  t.after(() => store.close());
  const db = readOnly(dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 4);
  const legacy = db.prepare(`
    SELECT conversation_session_id, turn_index, prompt_source, prompt_suffix_omitted
    FROM conversation_turns WHERE id = 1
  `).get();
  assert.equal(legacy.conversation_session_id, null);
  assert.equal(legacy.turn_index, null);
  assert.equal(legacy.prompt_source, 'legacy_unclassified');
  assert.equal(legacy.prompt_suffix_omitted, 0);
  assert.equal(store.searchConversations({ q: 'legacy v3' }).items.length, 1);
  assert.equal(store.searchConversationSessions({}).items.length, 0);
  assert.equal(store.searchConversationSessions({}).standaloneCount, 1);
  assert.equal(store.integrityCheck(), true);
});

test('turn search returns the bounded complete legacy prompt when FTS hits only its suffix', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v4-search-prompt-'));
  const promptText = '<session>\nvisible user body\n</session>\n\nsuffix-only-marker';
  await createV3Database(home, { promptText });
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await store.init();
  t.after(() => store.close());
  const result = store.searchConversations({ q: 'suffix-only-marker' });
  assert.equal(result.error, null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].promptText, promptText);
  assert.equal(result.items[0].promptSource, 'legacy_unclassified');
  assert.equal(result.items[0].promptSuffixOmitted, false);
  assert.equal(result.items[0].promptSnippet.includes('suffix-only-marker'), true);
});

test('schema v4 migration rollback leaves a v3 database untouched', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v4-rollback-'));
  const dbPath = await createV3Database(home);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TRIGGER reject_v4_promotion
    BEFORE UPDATE OF schema_version ON schema_meta
    BEGIN
      SELECT RAISE(ABORT, 'v4 migration deliberately blocked');
    END;
  `);
  db.close();
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await assert.rejects(store.init(), /v4 migration deliberately blocked/);
  t.after(() => store.close());
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => verify.close());
  assert.equal(verify.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 3);
  assert.equal(verify.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'conversation_sessions'",
  ).get().count, 0);
  assert.equal(verify.prepare(
    "SELECT COUNT(*) AS count FROM pragma_table_info('conversation_turns') WHERE name IN ('conversation_session_id', 'turn_index', 'prompt_source', 'prompt_suffix_omitted')",
  ).get().count, 0);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM conversation_turns').get().count, 1);
});

test('schema v4 refuses partial session or provenance objects without promotion', async (t) => {
  const shapes = ['session_table', 'session_column', 'prompt_source_column'];
  for (const shape of shapes) {
    const home = await mkdtemp(join(tmpdir(), `credential-console-metrics-v4-partial-${shape}-`));
    const dbPath = await createV3Database(home);
    const db = new DatabaseSync(dbPath);
    if (shape === 'session_table') {
      db.exec(`
        CREATE TABLE conversation_sessions (
          id INTEGER PRIMARY KEY,
          thread_key TEXT NOT NULL
        )
      `);
    } else if (shape === 'session_column') {
      db.exec('ALTER TABLE conversation_turns ADD COLUMN conversation_session_id INTEGER');
    } else {
      db.exec("ALTER TABLE conversation_turns ADD COLUMN prompt_source TEXT");
    }
    db.close();
    const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
    await assert.rejects(store.init(), /untrusted partial v4 objects/);
    t.after(() => store.close());
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    t.after(() => verify.close());
    assert.equal(verify.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 3);
  }
});

test('schema v4 session detail is capped at 200 turns and preserves explicit ordering', async (t) => {
  const { store } = await newStore(t, {
    batchSize: 64,
    maxConversationQueueItems: 64,
  });
  const threadKey = 'b'.repeat(64);
  for (let index = 0; index < 201; index += 1) {
    assert.equal(store.enqueueCompletion({
      metrics: row({ startedAtMs: BASE_MS + index }),
      conversation: {
        threadKey,
        promptText: `bounded session prompt ${index}`,
        responseText: `bounded session response ${index}`,
        responseState: 'complete',
        responseBytes: Buffer.byteLength(`bounded session response ${index}`),
      },
    }), true);
    if ((index + 1) % 4 === 0) assert.equal(store.flush().written, 4);
  }
  assert.equal(store.flush().written, 1);
  const list = store.searchConversationSessions({ q: 'bounded session', limit: 5 });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].turnCount, 201);
  const detail = store.readConversationSession(list.items[0].id);
  assert.equal(detail.error, null);
  assert.equal(detail.session.turnCount, 201);
  assert.equal(detail.session.turns.length, 200);
  assert.equal(detail.session.displayedTurnCount, 200);
  assert.equal(detail.session.maxDisplayedTurns, 200);
  assert.equal(detail.session.maxDisplayedBytes, 8 * 1024 * 1024);
  assert.equal(detail.session.truncated, true);
  assert.deepEqual(detail.session.turns.map((turn) => turn.turnIndex).slice(0, 3), [1, 2, 3]);
  assert.equal(detail.session.turns.at(-1).turnIndex, 200);
});

test('schema v4 same-thread writes converge on one session under separate store flushes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v4-concurrent-'));
  const first = new MetricsStore({ home, flushIntervalMs: 60_000 });
  const second = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await first.init();
  await second.init();
  t.after(() => first.close());
  t.after(() => second.close());
  const threadKey = 'c'.repeat(64);
  assert.equal(first.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 100 }),
    conversation: {
      threadKey,
      promptText: 'first concurrent prompt',
      responseText: 'first concurrent response',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('first concurrent response'),
    },
  }), true);
  assert.equal(second.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS }),
    conversation: {
      threadKey,
      promptText: 'second concurrent prompt',
      responseText: 'second concurrent response',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('second concurrent response'),
    },
  }), true);
  assert.equal(first.flush().written, 1);
  assert.equal(second.flush().written, 1);
  const db = readOnly(join(home, METRICS_FILENAME));
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_sessions').get().count, 1);
  assert.deepEqual(db.prepare(`
    SELECT conversation_session_id, turn_index
    FROM conversation_turns ORDER BY turn_index ASC
  `).all().map((entry) => [Number(entry.conversation_session_id), Number(entry.turn_index)]), [
    [1, 1],
    [1, 2],
  ]);
  const sessions = first.searchConversationSessions({ limit: 5 });
  assert.equal(sessions.items[0].latestPromptSnippet, 'second concurrent prompt');
  const detail = first.readConversationSession(sessions.items[0].id);
  assert.deepEqual(detail.session.turns.map((turn) => turn.turnIndex), [1, 2]);
  assert.deepEqual(detail.session.turns.map((turn) => turn.promptText), [
    'first concurrent prompt',
    'second concurrent prompt',
  ]);
});

test('schema v4 session detail applies a total byte budget and bounded response previews', async (t) => {
  const { store } = await newStore(t, { batchSize: 4 });
  const threadKey = 'd'.repeat(64);
  const responseText = 'x'.repeat(1024 * 1024);
  for (let index = 0; index < 9; index += 1) {
    assert.equal(store.enqueueCompletion({
      metrics: row({ startedAtMs: BASE_MS + index }),
      conversation: {
        threadKey,
        promptText: `large response prompt ${index}`,
        responseText,
        responseState: 'complete',
        responseBytes: Buffer.byteLength(responseText),
      },
    }), true);
    assert.equal(store.flush().written, 1);
  }
  const session = store.searchConversationSessions({ limit: 5 }).items[0];
  const detail = store.readConversationSession(session.id);
  assert.equal(detail.session.turnCount, 9);
  assert.ok(detail.session.turns.length > 0 && detail.session.turns.length < 9);
  assert.equal(detail.session.truncated, true);
  assert.equal(detail.session.maxDisplayedBytes, 8 * 1024 * 1024);
  assert.ok(detail.session.turns.every((turn) => turn.responseText.length === 16 * 1024));
  assert.ok(detail.session.turns.every((turn) => turn.responseDisplayTruncated === true));
});

test('schema v4 rejects malformed thread keys without persisting their value', async (t) => {
  const { store } = await newStore(t);
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      threadKey: 'not-a-thread-key',
      promptText: 'malformed thread key',
      responseText: 'reply',
      responseState: 'complete',
      responseBytes: 5,
    },
  }), true);
  assert.equal(store.flush().written, 1);
  assert.equal(store.stats.conversation.dropped, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM conversation_sessions').get().count, 0);
  assert.equal(store.db.prepare(
    "SELECT conversation_capture_state FROM request_metrics",
  ).get().conversation_capture_state, 'dropped');
});

test('conversation queue enforces item/byte budgets while retaining dropped metrics', async (t) => {
  const { store } = await newStore(t, {
    batchSize: 8,
    maxConversationQueueItems: 1,
    maxConversationQueueBytes: 8 * 1024,
  });
  const conversation = {
    promptText: 'first prompt',
    responseText: 'first response',
    responseState: 'complete',
    responseBytes: Buffer.byteLength('first response'),
  };
  assert.equal(store.enqueueCompletion({ metrics: row(), conversation }), true);
  assert.equal(store.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 1 }),
    conversation: {
      promptText: 'second prompt',
      responseText: 'second response',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('second response'),
    },
  }), true);
  assert.equal(store.conversationQueue.length, 1);
  assert.equal(store.stats.conversation.dropped, 1);
  assert.equal(store.flush().written, 2);
  assert.equal(store.queryTotals().requestCount, 2);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM conversation_turns",
  ).get().count, 1);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM request_metrics WHERE conversation_capture_state = 'dropped'",
  ).get().count, 1);
  assert.equal(store.searchConversations({}).droppedConversations, 1);
  const home = store.home;
  store.close();
  const reopened = await new MetricsStore({ home, flushIntervalMs: 60_000 }).init();
  t.after(() => reopened.close());
  assert.equal(reopened.searchConversations({}).droppedConversations, 1);
});

test('conversation flush caps one synchronous batch at four pairs', async (t) => {
  const { store } = await newStore(t, { batchSize: 64, maxConversationQueueItems: 8 });
  for (let index = 0; index < 6; index += 1) {
    assert.equal(store.enqueueCompletion({
      metrics: row({ startedAtMs: BASE_MS + index }),
      conversation: {
        promptText: `batch prompt ${index}`,
        responseText: `batch response ${index}`,
        responseState: 'complete',
        responseBytes: Buffer.byteLength(`batch response ${index}`),
      },
    }), true);
  }
  assert.equal(store.flush().written, 4);
  assert.equal(store.conversationQueue.length, 2);
  assert.equal(store.flush().written, 2);
  assert.equal(store.conversationQueue.length, 0);
});

test('conversation text bounds reject prompt overflow and preserve response truncation state', async (t) => {
  const { store } = await newStore(t, { batchSize: 8 });
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText: 'p'.repeat(32 * 1024 + 1),
      responseText: '',
      responseState: 'unavailable',
      responseBytes: 0,
    },
  }), true);
  assert.equal(store.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 1 }),
    conversation: {
      promptText: 'valid prompt',
      responseText: 'truncated prefix',
      responseState: 'truncated',
      responseBytes: Buffer.byteLength('truncated prefix'),
    },
  }), true);
  assert.equal(store.flush().written, 2);
  assert.equal(store.queryTotals().requestCount, 2);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM conversation_turns WHERE response_state = 'truncated'",
  ).get().count, 1);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM request_metrics WHERE conversation_capture_state = 'dropped'",
  ).get().count, 1);
  assert.equal(store.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 2 }),
    conversation: {
      promptText: 'invalid response state',
      responseText: '',
      responseState: null,
      responseBytes: 0,
    },
  }), true);
  assert.equal(store.flush().written, 1);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM request_metrics WHERE conversation_capture_state = 'dropped'",
  ).get().count, 2);
  assert.equal(store.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 3 }),
    conversation: {
      promptText: 'mismatched response bytes',
      responseText: 'one',
      responseState: 'complete',
      responseBytes: 0,
    },
  }), true);
  assert.equal(store.flush().written, 1);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM request_metrics WHERE conversation_capture_state = 'dropped'",
  ).get().count, 3);
  assert.equal(store.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 4 }),
    conversation: {
      promptText: 'unpaired \ud800',
      responseText: '',
      responseState: 'unavailable',
      responseBytes: 0,
    },
  }), true);
  assert.equal(store.flush().written, 1);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM request_metrics WHERE conversation_capture_state = 'dropped'",
  ).get().count, 4);
});

test('conversation queue configuration is hard-clamped and snippets preserve valid UTF-8', async (t) => {
  const { store } = await newStore(t, {
    maxConversationQueueItems: Number.MAX_SAFE_INTEGER,
    maxConversationQueueBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(store.maxConversationQueueItems, 64);
  assert.equal(store.maxConversationQueueBytes, 8 * 1024 * 1024);
  const promptText = `${'a'.repeat(4095)}🌍tail`;
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText,
      responseText: 'utf8 response',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('utf8 response'),
    },
  }), true);
  assert.equal(store.flush().written, 1);
  const item = store.searchConversations().items[0];
  assert.ok(Buffer.byteLength(item.promptSnippet, 'utf8') <= 4 * 1024);
  assert.equal(item.promptSnippet.includes('\uFFFD'), false);
  assert.equal(store.readConversation(item.id).turn.promptText, promptText);
});

test('conversation/FTS failure rolls back only the pair and keeps its metric dropped', async (t) => {
  const { store } = await newStore(t, { batchSize: 4 });
  store.db.exec('DROP TABLE conversation_turns_fts');
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText: 'fts failure prompt',
      responseText: 'reply',
      responseState: 'complete',
      responseBytes: 5,
    },
  }), true);
  assert.equal(store.flush().written, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM request_metrics').get().count, 1);
  assert.equal(store.db.prepare(
    "SELECT conversation_capture_state FROM request_metrics",
  ).get().conversation_capture_state, 'dropped');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM conversation_turns').get().count, 0);
  assert.equal(store.stats.conversation.dropped, 1);
});

test('conversation lock retry preserves its bounded queue budget', async (t) => {
  const { store, dbPath } = await newStore(t, { batchSize: 4 });
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('BEGIN IMMEDIATE');
  t.after(() => {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
  });
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText: 'retry prompt',
      responseText: 'retry response',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('retry response'),
    },
  }), true);
  const budgetBefore = store.conversationQueueBytes;
  assert.equal(store.flush().written, 0);
  assert.equal(store.conversationQueue.length, 1);
  assert.equal(store.conversationQueueBytes, budgetBefore);
  blocker.exec('ROLLBACK');
  assert.equal(store.flush().written, 1);
  assert.equal(store.conversationQueueBytes, 0);
  assert.equal(store.searchConversations({ q: 'retry' }).items.length, 1);
});

test('conversation retry drops pairs that no longer fit the remaining byte budget', async (t) => {
  const { store, dbPath } = await newStore(t, {
    batchSize: 64,
    maxConversationQueueItems: 8,
    maxConversationQueueBytes: 64 * 1024,
  });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(store.enqueueCompletion({
      metrics: row({ startedAtMs: BASE_MS + index }),
      conversation: {
        promptText: `budget prompt ${index}`,
        responseText: `budget response ${index}`,
        responseState: 'complete',
        responseBytes: Buffer.byteLength(`budget response ${index}`),
      },
    }), true);
  }
  const remainingBudget = store.conversationQueueBytes - 1;
  store.maxConversationQueueBytes = remainingBudget;
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('BEGIN IMMEDIATE');
  t.after(() => {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
  });
  assert.equal(store.flush().written, 0);
  assert.ok(store.conversationQueueBytes <= remainingBudget);
  assert.equal(store.conversationQueue.length, 4);
  assert.equal(store.stats.conversation.dropped, 1);
});

test('conversation search uses fixed filters, keyset pagination, and bounded errors', async (t) => {
  const { store } = await newStore(t, { batchSize: 8 });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(store.enqueueCompletion({
      metrics: row({
        startedAtMs: BASE_MS + index,
        deviceId: index === 1 ? 'device-b' : 'device-a',
        machineId: null,
        memberLabel: index === 1 ? 'bob' : 'alice',
      }),
      conversation: {
        promptText: `pagination phrase ${index}`,
        responseText: `response ${index}`,
        responseState: index === 2 ? 'incomplete' : 'complete',
        responseBytes: Buffer.byteLength(`response ${index}`),
      },
    }), true);
  }
  assert.equal(store.flush().written, 3);
  const first = store.searchConversations({ q: 'pagination', limit: 1 });
  assert.equal(first.error, null);
  assert.equal(first.items.length, 1);
  assert.equal(first.totalMatches, 3);
  assert.ok(first.nextBeforeId);
  const second = store.searchConversations({ q: 'pagination', beforeId: first.nextBeforeId, limit: 1 });
  assert.equal(second.items.length, 1);
  assert.equal(second.totalMatches, 3);
  assert.notEqual(second.items[0].id, first.items[0].id);
  assert.equal(store.searchConversations({ q: 'pagination', deviceId: 'device-b' }).totalMatches, 1);
  assert.equal(store.searchConversations({ q: 'pagination', unattributedMachine: true }).totalMatches, 3);
  assert.equal(store.searchConversations({ responseState: 'incomplete' }).totalMatches, 1);
  assert.equal(store.searchConversations({ q: '***' }).totalMatches, 0);
  assert.equal(store.searchConversations({ q: 'x'.repeat(257) }).totalMatches, null);
  assert.equal(store.searchConversations({ beforeId: -1 }).error, 'search_unavailable');
  const result = store.searchConversations({ q: 'pagination', limit: 999 });
  assert.equal(result.items.length, 3);
  assert.ok(result.items.every((item) => Buffer.byteLength(item.promptSnippet, 'utf8') <= 4 * 1024));
});

test('conversation facets and exact search counts stay bounded and filter-compatible', async (t) => {
  const { store } = await newStore(t, { batchSize: 256, maxQueue: 256 });
  const metricInsert = store.db.prepare(`
    INSERT INTO request_metrics (
      started_at_ms, hour_bucket_ms, method, path, device_id, machine_id,
      member_label, account_id, account_alias, model, stream, status_code,
      outcome, ttfb_ms, duration_ms, request_bytes, response_bytes,
      upstream_request_id, input_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, output_tokens, usage_state, conversation_capture_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const conversationInsert = store.db.prepare(`
    INSERT INTO conversation_turns (
      request_metrics_id, prompt_text, prompt_bytes, response_text,
      response_state, response_bytes
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const xssMember = '<script>alert(1)</script>';
  const rows = 150;
  store.db.exec('BEGIN');
  for (let index = 0; index < rows; index += 1) {
    const promptText = `facet prompt ${index}`;
    const responseText = `facet response ${index}`;
    const responseState = ['complete', 'incomplete', 'truncated', 'unavailable'][index % 4];
    const startedAtMs = BASE_MS + index;
    metricInsert.run(
      startedAtMs,
      Math.floor(startedAtMs / HOUR_MS) * HOUR_MS,
      'POST', '/v1/messages', `facet-device-${index % 3}`, null,
      `member-${String(index).padStart(3, '0')}`, `facet-account-${index % 4}`,
      `facet-account-${index % 4}`, `facet-model-${index % 5}`, 0, 200,
      'completed', 1, 2, Buffer.byteLength(promptText), Buffer.byteLength(responseText),
      null, null, null, null, null, 'unavailable', 'stored',
    );
    const metricId = Number(store.db.prepare('SELECT last_insert_rowid() AS id').get().id);
    conversationInsert.run(
      metricId,
      promptText,
      Buffer.byteLength(promptText),
      responseText,
      responseState,
      Buffer.byteLength(responseText),
    );
  }
  const specialPrompt = '今天北京天气怎么样';
  const specialResponse = '北京天气晴朗';
  const specialStartedAtMs = BASE_MS + rows + 1;
  metricInsert.run(
    specialStartedAtMs,
    Math.floor(specialStartedAtMs / HOUR_MS) * HOUR_MS,
    'POST', '/v1/messages', 'facet-special-device', null,
    xssMember, 'facet-special-account', 'facet-special-account', 'facet-special-model',
    0, 200, 'completed', 1, 2,
    Buffer.byteLength(specialPrompt), Buffer.byteLength(specialResponse),
    null, null, null, null, null, 'unavailable', 'stored',
  );
  const specialMetricId = Number(store.db.prepare('SELECT last_insert_rowid() AS id').get().id);
  conversationInsert.run(
    specialMetricId,
    specialPrompt,
    Buffer.byteLength(specialPrompt),
    specialResponse,
    'complete',
    Buffer.byteLength(specialResponse),
  );
  store.db.exec('COMMIT');

  const facets = store.queryConversationFacets();
  assert.equal(facets.totalStored, 151);
  assert.equal(facets.earliestStartedAtMs, BASE_MS);
  assert.equal(facets.latestStartedAtMs, specialStartedAtMs);
  assert.equal(facets.members.length, 100);
  assert.equal(facets.facetTruncated.members, true);
  assert.equal(facets.truncated, true);
  assert.equal(facets.members.every((entry) => entry.count === 1), true);
  assert.equal(facets.members.some((entry) => entry.value === xssMember), true);
  assert.equal(facets.devices.length, 4);
  assert.equal(facets.accounts.length, 5);
  assert.equal(facets.models.length, 6);
  assert.equal(facets.responseStates.length, 4);
  assert.equal(facets.facetTruncated.devices, false);

  const filtered = store.queryConversationFacets({
    fromMs: specialStartedAtMs,
    toMs: specialStartedAtMs + 1,
    memberLabel: xssMember,
    deviceId: 'facet-special-device',
    accountId: 'facet-special-account',
    model: 'facet-special-model',
    responseState: 'complete',
  });
  assert.equal(filtered.totalStored, 1);
  assert.deepEqual(filtered.members, [{ value: xssMember, count: 1 }]);
  assert.deepEqual(filtered.devices, [{ value: 'facet-special-device', count: 1 }]);
  assert.deepEqual(filtered.responseStates, [{ value: 'complete', count: 1 }]);

  const disjunctive = store.queryConversationFacets({
    memberLabel: 'member-000',
    responseState: 'complete',
  });
  assert.equal(disjunctive.totalStored, 1);
  assert.ok(disjunctive.members.length > 1, 'member facet should exclude its own active filter');
  assert.equal(disjunctive.members.some((entry) => entry.value === 'member-004'), true);
  assert.deepEqual(disjunctive.responseStates, [{ value: 'complete', count: 1 }]);

  const cjk = store.queryConversationFacets({ q: '北京天气' });
  assert.equal(cjk.totalStored, 1);
  assert.deepEqual(cjk.members, [{ value: xssMember, count: 1 }]);
  assert.equal(store.searchConversations({ q: '北京天气' }).totalMatches, 1);
  const shortCjk = store.queryConversationFacets({ q: '北京' });
  assert.equal(shortCjk.totalStored, 1);
  assert.deepEqual(shortCjk.members, [{ value: xssMember, count: 1 }]);
  assert.equal(shortCjk.error, null);
  assert.equal(
    store.queryConversationFacets({ beforeId: 1 }).error,
    'search_unavailable',
  );
});

test('Han queries use safe substring fallback while English remains on FTS', async (t) => {
  const { store } = await newStore(t, { batchSize: 8 });
  const hanPrompt = '今天北京天气怎么样';
  const hanResponse = '北京天气晴朗';
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText: hanPrompt,
      responseText: hanResponse,
      responseState: 'complete',
      responseBytes: Buffer.byteLength(hanResponse),
    },
  }), true);
  const englishResponse = 'weather report';
  assert.equal(store.enqueueCompletion({
    metrics: row({ startedAtMs: BASE_MS + 1 }),
    conversation: {
      promptText: 'weather report',
      responseText: englishResponse,
      responseState: 'complete',
      responseBytes: Buffer.byteLength(englishResponse),
    },
  }), true);
  assert.equal(store.flush().written, 2);
  assert.equal(store.searchConversations({ q: hanPrompt }).items.length, 1);
  for (const term of ['北京', '天气', '晴朗']) {
    const result = store.searchConversations({ q: term });
    assert.equal(result.error, null, term);
    assert.equal(result.items.length, 1, term);
    assert.match(result.items[0].promptSnippet, /北京|天气|晴朗/);
  }
  assert.equal(store.searchConversations({ q: 'weather' }).items.length, 1);
  const mixed = store.searchConversations({ q: '北京 OR 1=1 --' });
  assert.equal(mixed.error, null);
  assert.equal(mixed.items.length, 0);
  const special = store.searchConversations({ q: '天气" OR 1=1' });
  assert.equal(special.error, null);
  assert.equal(special.items.length, 0);
});

test('short Han fallback has a hard row-count ceiling while trigram remains indexed', async (t) => {
  const { store } = await newStore(t, { batchSize: 4 });
  const metricInsert = store.db.prepare(`
    INSERT INTO request_metrics (
      started_at_ms, hour_bucket_ms, method, path, device_id, machine_id,
      member_label, account_id, account_alias, model, stream, status_code,
      outcome, ttfb_ms, duration_ms, request_bytes, response_bytes,
      upstream_request_id, input_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, output_tokens, usage_state, conversation_capture_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const conversationInsert = store.db.prepare(`
    INSERT INTO conversation_turns (
      request_metrics_id, prompt_text, prompt_bytes, response_text,
      response_state, response_bytes
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  store.db.exec('BEGIN');
  const rows = 20_001;
  for (let index = 1; index <= rows; index += 1) {
    const promptText = index === rows ? '今天北京天气怎么样' : `synthetic row ${index}`;
    const responseText = index === rows ? '北京天气晴朗' : 'response';
    metricInsert.run(
      BASE_MS + index,
      Math.floor((BASE_MS + index) / HOUR_MS) * HOUR_MS,
      'POST', '/v1/messages', `device-${index}`, null, 'member', 'account',
      'account', 'model', 0, 200, 'completed', 1, 2,
      Buffer.byteLength(promptText), Buffer.byteLength(responseText), null,
      null, null, null, null, 'unavailable', 'stored',
    );
    const metricId = Number(store.db.prepare('SELECT last_insert_rowid() AS id').get().id);
    conversationInsert.run(
      metricId,
      promptText,
      Buffer.byteLength(promptText),
      responseText,
      'complete',
      Buffer.byteLength(responseText),
    );
  }
  store.db.exec('COMMIT');
  assert.equal(store.searchConversations({ q: '北京' }).error, 'search_query_too_short');
  assert.equal(store.searchConversations({ q: '北京天气' }).items.length, 1);
  assert.equal(store.queryConversationFacets({ q: '北京' }).error, 'search_query_too_short');
});

test('an existing v3 store without the additive trigram index rebuilds it from stored turns', async (t) => {
  const { home, store, dbPath } = await newStore(t, { batchSize: 4 });
  const responseText = '北京天气晴朗';
  store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText: '今天北京天气怎么样',
      responseText,
      responseState: 'complete',
      responseBytes: Buffer.byteLength(responseText),
    },
  });
  store.flush();
  store.close();
  const mutate = new DatabaseSync(dbPath);
  mutate.exec('DROP TRIGGER conversation_turns_trigram_fts_ai; DROP TABLE conversation_turns_trigram_fts;');
  mutate.close();
  const reopened = await new MetricsStore({ home, flushIntervalMs: 60_000 }).init();
  t.after(() => reopened.close());
  assert.equal(reopened.searchConversations({ q: '北京天气' }).items.length, 1);
});

test('v1 migration rollback removes both v2 and v3 changes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v1-full-rollback-'));
  const dbPath = await createV1Database(home);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TRIGGER reject_full_upgrade
    BEFORE UPDATE OF schema_version ON schema_meta
    BEGIN
      SELECT RAISE(ABORT, 'full migration deliberately blocked');
    END;
  `);
  db.close();
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await assert.rejects(store.init(), /full migration deliberately blocked/);
  t.after(() => store.close());
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => verify.close());
  assert.equal(verify.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 1);
  assert.equal(verify.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('conversation_turns', 'conversation_turns_fts', 'conversation_turns_trigram_fts', 'conversation_turns_fts_ai', 'conversation_turns_trigram_fts_ai')",
  ).get().count, 0);
  assert.equal(verify.prepare(
    "SELECT COUNT(*) AS count FROM pragma_table_info('request_metrics') WHERE name = 'conversation_capture_state'",
  ).get().count, 0);
});

test('a partial v3 object is refused without promotion', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-v3-partial-'));
  const dbPath = await createV2Database(home);
  const db = new DatabaseSync(dbPath);
  db.exec("ALTER TABLE request_metrics ADD COLUMN conversation_capture_state TEXT NOT NULL DEFAULT 'not_applicable'");
  db.close();
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  await assert.rejects(store.init(), /untrusted partial v3 objects/);
  t.after(() => store.close());
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => verify.close());
  assert.equal(verify.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 2);
  assert.equal(verify.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'conversation_turns'",
  ).get().count, 0);
});

test('a partial trigram table or trigger is refused without promotion', async (t) => {
  for (const shape of ['table', 'trigger']) {
    const home = await mkdtemp(join(tmpdir(), `credential-console-metrics-v3-trigram-${shape}-`));
    const dbPath = await createV2Database(home);
    const db = new DatabaseSync(dbPath);
    if (shape === 'table') {
      db.exec('CREATE TABLE conversation_turns_trigram_fts (prompt_text TEXT, response_text TEXT)');
    } else {
      db.exec(`
        CREATE TRIGGER conversation_turns_trigram_fts_ai
        AFTER INSERT ON request_metrics
        BEGIN
          SELECT 1;
        END;
      `);
    }
    db.close();

    const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
    await assert.rejects(store.init(), /untrusted partial v3 objects/);
    t.after(() => store.close());
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    t.after(() => verify.close());
    assert.equal(verify.prepare('SELECT schema_version FROM schema_meta').get().schema_version, 2);
    assert.equal(verify.prepare(
      "SELECT COUNT(*) AS count FROM pragma_table_info('request_metrics') WHERE name = 'conversation_capture_state'",
    ).get().count, 0);
    assert.equal(verify.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'conversation_turns'",
    ).get().count, 0);
  }
});

test('canonical trigger semantics are validated, not just trigger names', async (t) => {
  const valid = await newStore(t);
  valid.store.close();
  const db = new DatabaseSync(valid.dbPath);
  db.exec(`
    DROP TRIGGER conversation_turns_no_update;
    CREATE TRIGGER conversation_turns_no_update
    BEFORE UPDATE ON conversation_turns
    BEGIN SELECT 1; END;
  `);
  db.close();
  const reopened = new MetricsStore({ home: valid.home, flushIntervalMs: 60_000 });
  await assert.rejects(reopened.init(), /incompatible trigger conversation_turns_no_update/);
  t.after(() => reopened.close());
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

test('enqueueCompletion only queues bounded text and does not touch SQLite', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-metrics-completion-preinit-'));
  const store = new MetricsStore({ home, flushIntervalMs: 60_000 });
  t.after(() => store.close());
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText: 'queued before init',
      responseText: 'queued response',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('queued response'),
    },
  }), true);
  await assert.rejects(access(join(home, METRICS_FILENAME)), { code: 'ENOENT' });
  await store.init();
  assert.equal(store.flush().written, 1);
  assert.equal(store.searchConversations({ q: 'queued' }).items.length, 1);
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

test('device token hourly returns bounded top devices with nullable coverage fields', async (t) => {
  const { store } = await newStore(t, { batchSize: 64, maxQueue: 128 });
  const tokenRow = (deviceId, {
    inputTokens = null,
    cacheCreationInputTokens = null,
    cacheReadInputTokens = null,
    outputTokens = null,
    usageState = 'unavailable',
    startedAtMs = BASE_MS,
    path = '/v1/messages',
  } = {}) => row({
    deviceId,
    machineId: null,
    memberLabel: `member-${deviceId}`,
    accountId: `account-${deviceId}`,
    accountAlias: `alias-${deviceId}`,
    model: `model-${deviceId}`,
    startedAtMs,
    path,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    usageState,
  });
  const entries = [
    tokenRow('device-a', { inputTokens: 10, outputTokens: 5, usageState: 'complete' }),
    tokenRow('device-a', {
      inputTokens: 20,
      outputTokens: 5,
      usageState: 'complete',
      startedAtMs: BASE_MS + HOUR_MS,
    }),
    tokenRow('device-b', { inputTokens: 30, usageState: 'partial' }),
    tokenRow('device-c', { inputTokens: 20, outputTokens: 5, usageState: 'complete' }),
    tokenRow('device-d', { inputTokens: 15, outputTokens: 5, usageState: 'complete' }),
    tokenRow('device-e', { inputTokens: 10, outputTokens: 5, usageState: 'complete' }),
    tokenRow('device-f', { inputTokens: 8, outputTokens: 2, usageState: 'complete' }),
    tokenRow('device-g', { inputTokens: 3, outputTokens: 2, usageState: 'complete' }),
    tokenRow('device-0-unknown'),
    tokenRow('device-0-zero', { inputTokens: 0, outputTokens: 0, usageState: 'complete' }),
    tokenRow('device-count', {
      inputTokens: 999_999,
      outputTokens: 999_999,
      usageState: 'complete',
      path: '/v1/messages/count_tokens',
    }),
  ];
  for (const entry of entries) assert.equal(store.enqueueRequest(entry), true);
  assert.equal(store.flush().written, entries.length);

  const result = store.queryDeviceTokenHourly();
  assert.equal(result.truncated, false);
  assert.equal(result.devicesTruncated, false);
  assert.equal(result.hoursTruncated, false);
  assert.equal(result.unavailableDeviceCount, 1);
  assert.deepEqual(result.devices.map(({ deviceId }) => deviceId), [
    'device-a',
    'device-b',
    'device-c',
    'device-d',
    'device-e',
    'device-f',
    'device-g',
    'device-0-zero',
  ]);
  assert.equal(result.devices.length, 8);
  assert.equal(result.devices.every(({ machineId }) => machineId === null), true);
  assert.equal(result.rows.some(({ deviceId }) => deviceId === 'device-count'), false);
  assert.equal(result.rows.some(({ deviceId }) => deviceId === 'device-0-unknown'), false);

  const deviceARows = result.rows.filter(({ deviceId }) => deviceId === 'device-a');
  assert.deepEqual(deviceARows.map(({ hourBucketMs, inputTokens, outputTokens }) => ({
    hourBucketMs,
    inputTokens,
    outputTokens,
  })), [
    {
      hourBucketMs: Math.floor(BASE_MS / HOUR_MS) * HOUR_MS,
      inputTokens: 10,
      outputTokens: 5,
    },
    {
      hourBucketMs: Math.floor((BASE_MS + HOUR_MS) / HOUR_MS) * HOUR_MS,
      inputTokens: 20,
      outputTokens: 5,
    },
  ]);

  const partial = result.rows.find(({ deviceId }) => deviceId === 'device-b');
  assert.equal(partial.inputTokens, 30);
  assert.equal(partial.outputTokens, null);
  assert.equal(partial.inputTokensKnownCount, 1);
  assert.equal(partial.outputTokensKnownCount, 0);
  assert.equal(partial.usagePartialCount, 1);
  const explicitZero = result.rows.find(({ deviceId }) => deviceId === 'device-0-zero');
  assert.equal(explicitZero.inputTokens, 0);
  assert.equal(explicitZero.outputTokens, 0);
  assert.equal(explicitZero.inputTokensKnownCount, 1);
  assert.equal(explicitZero.outputTokensKnownCount, 1);
  assert.equal(explicitZero.usageCompleteCount, 1);
  assert.equal(Object.hasOwn(explicitZero, 'totalInputTokens'), false);

  const filtered = store.queryDeviceTokenHourly({
    fromMs: BASE_MS + HOUR_MS,
    toMs: BASE_MS + 2 * HOUR_MS,
    memberLabel: 'member-device-a',
    accountId: 'account-device-a',
    model: 'model-device-a',
  });
  assert.deepEqual(filtered.devices.map(({ deviceId }) => deviceId), ['device-a']);
  assert.deepEqual(filtered.rows.map(({ inputTokens, outputTokens }) => ({
    inputTokens,
    outputTokens,
  })), [{ inputTokens: 20, outputTokens: 5 }]);
  assert.equal(filtered.unavailableDeviceCount, 0);

  assert.throws(
    () => store.queryDeviceTokenHourly({ deviceId: 'device-a' }),
    /does not accept a device filter/,
  );
  assert.throws(
    () => store.queryDeviceTokenHourly({ machineId: 'machine-a' }),
    /does not accept a device filter/,
  );
  assert.throws(
    () => store.queryDeviceTokenHourly({ unattributedMachine: true }),
    /does not accept a device filter/,
  );
  assert.throws(
    () => store.queryDeviceTokenHourly({ scope: 'all' }),
    /consumption-only/,
  );
});

test('device token hourly reports bounded history truncation', async (t) => {
  const { store } = await newStore(t, { batchSize: 1024, maxQueue: 1024 });
  for (let index = 0; index <= 720; index += 1) {
    assert.equal(store.enqueueRequest(row({
      deviceId: 'device-long-history',
      machineId: null,
      startedAtMs: BASE_MS + index * HOUR_MS,
      inputTokens: 1,
      outputTokens: 1,
      usageState: 'complete',
    })), true);
  }
  assert.equal(store.flush().written, 721);
  const result = store.queryDeviceTokenHourly();
  assert.equal(result.devices.length, 1);
  assert.equal(result.rows.length, 720);
  assert.equal(result.devicesTruncated, false);
  assert.equal(result.hoursTruncated, true);
  assert.equal(result.truncated, true);
  assert.equal(
    Math.min(...result.rows.map(({ hourBucketMs }) => hourBucketMs)),
    Math.floor((BASE_MS + HOUR_MS) / HOUR_MS) * HOUR_MS,
  );
  assert.equal(
    Math.max(...result.rows.map(({ hourBucketMs }) => hourBucketMs)),
    Math.floor((BASE_MS + 720 * HOUR_MS) / HOUR_MS) * HOUR_MS,
  );
});

test('device token hourly reports qualifying-device truncation separately', async (t) => {
  const { store } = await newStore(t, { batchSize: 16, maxQueue: 32 });
  for (let index = 0; index < 9; index += 1) {
    assert.equal(store.enqueueRequest(row({
      deviceId: `device-${String.fromCharCode(97 + index)}`,
      machineId: null,
      startedAtMs: BASE_MS + index,
      inputTokens: index + 1,
      outputTokens: 0,
      usageState: 'complete',
    })), true);
  }
  assert.equal(store.flush().written, 9);
  const result = store.queryDeviceTokenHourly();
  assert.equal(result.devices.length, 8);
  assert.deepEqual(result.devices.map(({ deviceId }) => deviceId), [
    'device-i',
    'device-h',
    'device-g',
    'device-f',
    'device-e',
    'device-d',
    'device-c',
    'device-b',
  ]);
  assert.equal(result.unavailableDeviceCount, 0);
  assert.equal(result.devicesTruncated, true);
  assert.equal(result.hoursTruncated, false);
  assert.equal(result.truncated, true);
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

test('token breakdown ranks the true top eight beyond the request-count candidate cap', async (t) => {
  const { store } = await newStore(t, { batchSize: 700, maxQueue: 700 });
  for (let index = 0; index < 501; index += 1) {
    assert.equal(store.enqueueRequest(row({
      startedAtMs: BASE_MS + index,
      accountId: `account-${String(index).padStart(3, '0')}`,
      inputTokens: index === 500 ? 1_000_000 : index,
      outputTokens: 0,
      usageState: 'complete',
    })), true);
  }
  assert.equal(store.enqueueRequest(row({
    startedAtMs: BASE_MS + 1000,
    accountId: 'non-consumption-helper',
    path: '/v1/messages/count_tokens',
    inputTokens: 9_000_000,
    outputTokens: 0,
    usageState: 'complete',
  })), true);
  assert.equal(store.flush().written, 502);
  const result = store.queryTokenBreakdown({ by: 'account' });
  assert.equal(result.length, 8);
  assert.equal(result[0].groupValue, 'account-500');
  assert.equal(result[0].totalInputTokens, 1_000_000);
  assert.equal(result.some((entry) => entry.groupValue === 'non-consumption-helper'), false);
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

test('integrityCheck rejects corrupted trigram FTS independently', async (t) => {
  const { store } = await newStore(t);
  assert.equal(store.enqueueCompletion({
    metrics: row(),
    conversation: {
      promptText: 'trigram integrity prompt',
      responseText: 'trigram integrity response',
      responseState: 'complete',
      responseBytes: Buffer.byteLength('trigram integrity response'),
    },
  }), true);
  assert.equal(store.flush().written, 1);

  // Keep SQLite's generic check at "ok" so this assertion exercises the
  // per-index FTS5 integrity command for the trigram index specifically.
  store.db.exec('DELETE FROM conversation_turns_trigram_fts_data');
  const realDb = store.db;
  store.db = {
    isOpen: true,
    prepare(sql, ...args) {
      if (sql === 'PRAGMA integrity_check') {
        return { all: () => [{ integrity_check: 'ok' }] };
      }
      return realDb.prepare(sql, ...args);
    },
  };
  try {
    assert.throws(
      () => store.integrityCheck(),
      /conversation FTS integrity check failed: conversation_turns_trigram_fts/,
    );
  } finally {
    store.db = realDb;
  }
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
