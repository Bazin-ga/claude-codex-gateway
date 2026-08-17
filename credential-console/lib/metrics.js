import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const METRICS_FILENAME = 'metrics.sqlite';
export const METRICS_SCHEMA_VERSION = 1;

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_QUEUE = 4096;
const SQLITE_TIMEOUT_MS = 1000;
const MAX_BREAKDOWN_ROWS = 500;
const QUEUE_DROP_LOG_INTERVAL_MS = 60_000;
const MAX_TRANSIENT_WRITE_RETRIES = 3;
const MAX_MEMBER_LABEL = 160;
const MAX_MODEL = 256;
const MAX_METHOD = 32;
const MAX_PATH = 256;
const MAX_IDENTIFIER = 128;
const MAX_MACHINE_ID = 128;
const MAX_OUTCOME = 64;
const MAX_UPSTREAM_REQUEST_ID = 256;

const CREATE_SCHEMA_META = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )
`;

const CREATE_REQUEST_METRICS = `
  CREATE TABLE IF NOT EXISTS request_metrics (
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
  )
`;

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS request_metrics_started_idx ON request_metrics(started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_member_started_idx ON request_metrics(member_label, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_machine_started_idx ON request_metrics(machine_id, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_device_started_idx ON request_metrics(device_id, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_account_started_idx ON request_metrics(account_id, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_model_started_idx ON request_metrics(model, started_at_ms)',
];

const INSERT_REQUEST = `
  INSERT INTO request_metrics (
    started_at_ms,
    hour_bucket_ms,
    method,
    path,
    device_id,
    machine_id,
    member_label,
    account_id,
    account_alias,
    model,
    stream,
    status_code,
    outcome,
    ttfb_ms,
    duration_ms,
    request_bytes,
    response_bytes,
    upstream_request_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const AGGREGATE_SELECT = `
  COUNT(*) AS request_count,
  SUM(CASE
    WHEN status_code >= 200 AND status_code < 400 AND outcome = 'completed' THEN 1
    ELSE 0
  END) AS success_count,
  SUM(CASE
    WHEN status_code >= 200 AND status_code < 400 AND outcome = 'completed' THEN 0
    ELSE 1
  END) AS error_count,
  COALESCE(SUM(request_bytes), 0) AS request_bytes,
  COALESCE(SUM(response_bytes), 0) AS response_bytes,
  AVG(ttfb_ms) AS avg_ttfb_ms,
  AVG(duration_ms) AS avg_duration_ms
`;

const AGGREGATE_ORDER = `
  ORDER BY request_count DESC, group_value IS NULL ASC, group_value ASC
`;

const BREAKDOWN_COLUMNS = Object.freeze({
  machine: 'machine_id',
  device: 'device_id',
  member: 'member_label',
  account: 'account_id',
  model: 'model',
});

function finiteInteger(value, name, { nullable = false, minimum = 0 } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function boundedRequiredString(value, name, maxLength) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.slice(0, maxLength);
}

function boundedString(value, name, maxLength, { nullable = true, emptyAsNull = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${name} must be a string`);
  }
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  if (emptyAsNull && value.length === 0) return null;
  return value.slice(0, maxLength);
}

function normalizePathFilter(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.slice(0, MAX_PATH);
}

function normalizeOptionalTime(value, name) {
  if (value === null || value === undefined) return null;
  return finiteInteger(value, name);
}

function normalizeRow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('metrics row must be an object');
  }

  const startedAtMs = finiteInteger(input.startedAtMs, 'startedAtMs');
  const stream = typeof input.stream === 'boolean' ? (input.stream ? 1 : 0) : null;
  const statusCode = input.statusCode === null || input.statusCode === undefined
    ? null
    : finiteInteger(input.statusCode, 'statusCode', { minimum: 100 });
  if (statusCode !== null && statusCode > 999) {
    throw new TypeError('statusCode must be between 100 and 999');
  }

  return {
    retryCount: 0,
    startedAtMs,
    hourBucketMs: Math.floor(startedAtMs / HOUR_MS) * HOUR_MS,
    method: boundedRequiredString(input.method, 'method', MAX_METHOD),
    path: boundedRequiredString(input.path, 'path', MAX_PATH),
    deviceId: boundedRequiredString(input.deviceId, 'deviceId', MAX_IDENTIFIER),
    machineId: boundedString(input.machineId, 'machineId', MAX_MACHINE_ID, { emptyAsNull: true }),
    memberLabel: boundedString(input.memberLabel, 'memberLabel', MAX_MEMBER_LABEL, {
      nullable: false,
    }),
    accountId: boundedRequiredString(input.accountId, 'accountId', MAX_IDENTIFIER),
    accountAlias: boundedRequiredString(input.accountAlias, 'accountAlias', MAX_IDENTIFIER),
    model: boundedString(input.model, 'model', MAX_MODEL, { emptyAsNull: true }),
    stream,
    statusCode,
    outcome: boundedRequiredString(input.outcome, 'outcome', MAX_OUTCOME),
    ttfbMs: finiteInteger(input.ttfbMs, 'ttfbMs', { nullable: true }),
    durationMs: finiteInteger(input.durationMs, 'durationMs', { nullable: true }),
    requestBytes: finiteInteger(input.requestBytes, 'requestBytes'),
    responseBytes: finiteInteger(input.responseBytes, 'responseBytes'),
    upstreamRequestId: boundedString(
      input.upstreamRequestId,
      'upstreamRequestId',
      MAX_UPSTREAM_REQUEST_ID,
      { emptyAsNull: true },
    ),
  };
}

function normalizeAggregateRow(row) {
  return {
    requestCount: Number(row.request_count),
    successCount: Number(row.success_count),
    errorCount: Number(row.error_count),
    totalRequestBytes: Number(row.request_bytes),
    totalResponseBytes: Number(row.response_bytes),
    avgTtfbMs: row.avg_ttfb_ms === null ? null : Number(row.avg_ttfb_ms),
    avgDurationMs: row.avg_duration_ms === null ? null : Number(row.avg_duration_ms),
  };
}

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('metrics filters must be an object');
  }
  const scope = filters.scope ?? 'all';
  if (scope !== 'all' && scope !== 'consumption') {
    throw new TypeError('metrics scope must be all or consumption');
  }
  const fromMs = normalizeOptionalTime(filters.fromMs, 'fromMs');
  const toMs = normalizeOptionalTime(filters.toMs, 'toMs');
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new TypeError('fromMs must not be after toMs');
  }
  const machineId = boundedString(filters.machineId, 'machineId', MAX_MACHINE_ID, {
    emptyAsNull: true,
  });
  const deviceId = boundedString(filters.deviceId, 'deviceId', MAX_IDENTIFIER, {
    emptyAsNull: true,
  });
  const memberLabel = boundedString(filters.memberLabel, 'memberLabel', MAX_MEMBER_LABEL, {
    emptyAsNull: true,
  });
  const accountId = boundedString(filters.accountId, 'accountId', MAX_IDENTIFIER, {
    emptyAsNull: true,
  });
  const model = boundedString(filters.model, 'model', MAX_MODEL, { emptyAsNull: true });
  const unattributedMachine = filters.unattributedMachine === true ? 1 : 0;
  return {
    fromMs,
    toMs,
    machineId,
    deviceId,
    unattributedMachine,
    memberLabel,
    accountId,
    model,
    scope,
  };
}

function filterSql(filters) {
  // Keep this predicate fixed. Values are always bound, including the optional
  // filters; only the breakdown identifier is selected from a fixed allowlist.
  return `
    WHERE (? IS NULL OR started_at_ms >= ?)
      AND (? IS NULL OR started_at_ms < ?)
      AND (? IS NULL OR machine_id = ?)
      AND (? IS NULL OR device_id = ?)
      AND (? = 0 OR machine_id IS NULL)
      AND (? IS NULL OR member_label = ?)
      AND (? IS NULL OR account_id = ?)
      AND (? IS NULL OR model = ?)
      AND (? = 'all' OR path = '/v1/messages')
  `;
}

function filterParams(filters) {
  return [
    filters.fromMs, filters.fromMs,
    filters.toMs, filters.toMs,
    filters.machineId, filters.machineId,
    filters.deviceId, filters.deviceId,
    filters.unattributedMachine,
    filters.memberLabel, filters.memberLabel,
    filters.accountId, filters.accountId,
    filters.model, filters.model,
    filters.scope,
  ];
}

export class MetricsStore {
  constructor({
    home,
    dbPath = null,
    batchSize = DEFAULT_BATCH_SIZE,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    maxQueue = DEFAULT_MAX_QUEUE,
    clock = Date.now,
    log = () => {},
  } = {}) {
    this.home = home;
    this.dbPath = dbPath ?? (home ? join(home, METRICS_FILENAME) : null);
    this.batchSize = Number.isSafeInteger(batchSize) && batchSize > 0
      ? batchSize
      : DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = Number.isFinite(Number(flushIntervalMs)) && Number(flushIntervalMs) > 0
      ? Number(flushIntervalMs)
      : DEFAULT_FLUSH_INTERVAL_MS;
    this.maxQueue = Number.isSafeInteger(maxQueue) && maxQueue > 0 ? maxQueue : DEFAULT_MAX_QUEUE;
    this.clock = typeof clock === 'function' ? clock : Date.now;
    this.log = typeof log === 'function' ? log : () => {};
    this.db = null;
    this.insertStatement = null;
    this.timer = null;
    this.queue = [];
    this.initialized = false;
    this.closed = false;
    this.closing = false;
    this.flushing = false;
    this.stats = {
      enqueued: 0,
      written: 0,
      dropped: 0,
      failed: 0,
    };
    this.lastQueueDropLogAt = null;
    this.suppressedQueueDrops = 0;
  }

  #now() {
    const value = Number(this.clock());
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  }

  #safeLog(event, detail = {}) {
    try {
      this.log(event, detail);
    } catch {
      // Metrics logging is also best effort and must never affect the gateway.
    }
  }

  #logQueueDrop(reason) {
    const now = this.#now();
    this.suppressedQueueDrops += 1;
    if (this.lastQueueDropLogAt !== null
      && now - this.lastQueueDropLogAt < QUEUE_DROP_LOG_INTERVAL_MS) return;
    this.#safeLog('metrics_queue_dropped', {
      reason,
      count: this.suppressedQueueDrops,
    });
    this.lastQueueDropLogAt = now;
    this.suppressedQueueDrops = 0;
  }

  #assertOpen() {
    if (!this.initialized || !this.db?.isOpen || this.closed) {
      throw new Error('metrics database is not open');
    }
  }

  #rollback() {
    if (!this.db?.isOpen || !this.db.isTransaction) return;
    try {
      this.db.exec('ROLLBACK');
    } catch (error) {
      this.#safeLog('metrics_rollback_failed', { code: error.code ?? 'unknown' });
    }
  }

  async init() {
    if (this.initialized) return this;
    if (this.closed) throw new Error('metrics store is closed');
    if (!this.home && !this.dbPath) throw new Error('metrics home or dbPath is required');
    if (!this.dbPath) throw new Error('metrics dbPath is required');

    if (this.home) {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await chmod(this.home, 0o700);
    }
    const parent = dirname(this.dbPath);
    if (parent !== this.home) await mkdir(parent, { recursive: true, mode: 0o700 });

    let databaseExisted = false;
    try {
      const existing = await stat(this.dbPath);
      databaseExisted = true;
      if (!existing.isFile() || existing.size === 0) {
        throw new Error('existing metrics database is empty or is not a regular file');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    try {
      this.db = new DatabaseSync(this.dbPath, { timeout: SQLITE_TIMEOUT_MS });
      await chmod(this.dbPath, 0o600);

      const journal = this.db.prepare('PRAGMA journal_mode = WAL').get();
      if (journal?.journal_mode !== 'wal') {
        throw new Error(`metrics database did not enable WAL (got ${journal?.journal_mode ?? 'none'})`);
      }
      this.db.exec('PRAGMA synchronous = NORMAL');
      const synchronous = this.db.prepare('PRAGMA synchronous').get();
      if (synchronous?.synchronous !== 1) {
        throw new Error(`metrics database did not enable synchronous=NORMAL (got ${synchronous?.synchronous ?? 'none'})`);
      }
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_TIMEOUT_MS}`);

      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (databaseExisted) {
          const recognized = this.db.prepare(`
            SELECT 1 AS present FROM sqlite_master
            WHERE type = 'table' AND name = 'schema_meta'
          `).get();
          if (!recognized) {
            throw new Error('existing metrics database has no recognized schema metadata');
          }
        }
        this.db.exec(CREATE_SCHEMA_META);
        const existing = this.db.prepare(
          'SELECT schema_version FROM schema_meta WHERE singleton = 1',
        ).get();
        if (existing && !Number.isInteger(existing.schema_version)) {
          throw new Error('metrics schema_version is invalid');
        }
        if (existing && existing.schema_version > METRICS_SCHEMA_VERSION) {
          throw new Error(
            `metrics schema_version ${existing.schema_version} is newer than supported ${METRICS_SCHEMA_VERSION}`,
          );
        }
        if (existing && existing.schema_version < METRICS_SCHEMA_VERSION) {
          throw new Error(
            `metrics schema_version ${existing.schema_version} cannot be migrated to ${METRICS_SCHEMA_VERSION}`,
          );
        }
        this.db.exec(CREATE_REQUEST_METRICS);
        for (const sql of CREATE_INDEXES) this.db.exec(sql);
        if (!existing) {
          this.db.prepare(`
            INSERT INTO schema_meta (singleton, schema_version, updated_at_ms)
            VALUES (1, ?, ?)
          `).run(METRICS_SCHEMA_VERSION, this.#now());
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.#rollback();
        throw error;
      }

      this.insertStatement = this.db.prepare(INSERT_REQUEST);
      this.initialized = true;
      this.timer = setInterval(() => {
        this.flush();
      }, this.flushIntervalMs);
      this.timer.unref?.();
      return this;
    } catch (error) {
      this.#rollback();
      try {
        if (this.db?.isOpen) this.db.close();
      } catch {
        // Preserve the initialization error.
      }
      this.db = null;
      this.insertStatement = null;
      throw error;
    }
  }

  enqueueRequest(row) {
    if (this.closed || this.closing || this.queue.length >= this.maxQueue) {
      this.stats.dropped += 1;
      this.#logQueueDrop(this.closed || this.closing ? 'closed' : 'full');
      return false;
    }
    let normalized;
    try {
      normalized = normalizeRow(row);
    } catch (error) {
      this.stats.dropped += 1;
      this.#safeLog('metrics_row_rejected', { code: error.code ?? 'invalid_row' });
      return false;
    }
    this.queue.push(normalized);
    this.stats.enqueued += 1;
    return true;
  }

  flush() {
    if (this.flushing || this.queue.length === 0) {
      return { queued: 0, written: 0, dropped: 0, failed: 0 };
    }
    if (!this.initialized || !this.db?.isOpen || this.closed) {
      return { queued: 0, written: 0, dropped: 0, failed: 0 };
    }

    const batch = this.queue.splice(0, this.batchSize);
    this.flushing = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const row of batch) {
        this.insertStatement.run(
          row.startedAtMs,
          row.hourBucketMs,
          row.method,
          row.path,
          row.deviceId,
          row.machineId,
          row.memberLabel,
          row.accountId,
          row.accountAlias,
          row.model,
          row.stream,
          row.statusCode,
          row.outcome,
          row.ttfbMs,
          row.durationMs,
          row.requestBytes,
          row.responseBytes,
          row.upstreamRequestId,
        );
      }
      this.db.exec('COMMIT');
      this.stats.written += batch.length;
      return { queued: batch.length, written: batch.length, dropped: 0, failed: 0 };
    } catch (error) {
      this.#rollback();
      this.stats.failed += batch.length;
      const transient = /(?:busy|locked|temporarily unavailable)/i.test(String(error.message ?? ''));
      const retryable = transient
        ? batch.filter((row) => row.retryCount < MAX_TRANSIENT_WRITE_RETRIES)
        : [];
      for (const row of retryable) row.retryCount += 1;
      const retryCapacity = Math.max(0, this.maxQueue - this.queue.length);
      const retryRows = retryable.slice(0, retryCapacity);
      if (retryRows.length) this.queue.unshift(...retryRows);
      const dropped = batch.length - retryRows.length;
      this.stats.dropped += dropped;
      this.#safeLog(retryRows.length ? 'metrics_flush_retry' : 'metrics_flush_failed', {
        count: batch.length,
        retried: retryRows.length,
        dropped,
        code: error.code ?? 'unknown',
      });
      return { queued: batch.length, written: 0, dropped, failed: batch.length };
    } finally {
      this.flushing = false;
    }
  }

  #queryRows(sql, params) {
    this.#assertOpen();
    return this.db.prepare(sql).all(...params);
  }

  queryTotals(filters = {}) {
    const normalized = normalizeFilters(filters);
    const rows = this.#queryRows(
      `SELECT ${AGGREGATE_SELECT}
       FROM request_metrics
       ${filterSql(normalized)}`,
      filterParams(normalized),
    );
    return normalizeAggregateRow(rows[0]);
  }

  queryHourly(filters = {}) {
    const normalized = normalizeFilters(filters);
    const rows = this.#queryRows(
      `SELECT hour_bucket_ms, ${AGGREGATE_SELECT}
       FROM request_metrics
       ${filterSql(normalized)}
       GROUP BY hour_bucket_ms
       ORDER BY hour_bucket_ms ASC`,
      filterParams(normalized),
    );
    return rows.map((row) => ({
      hourBucketMs: Number(row.hour_bucket_ms),
      ...normalizeAggregateRow(row),
    }));
  }

  queryBreakdown({ by, ...filters } = {}) {
    const column = BREAKDOWN_COLUMNS[by];
    if (!column) throw new TypeError('breakdown must be machine, device, member, account, or model');
    const normalized = normalizeFilters(filters);
    const rows = this.#queryRows(
      `SELECT ${column} AS group_value, ${AGGREGATE_SELECT}
       FROM request_metrics
       ${filterSql(normalized)}
       GROUP BY ${column}
       ${AGGREGATE_ORDER}
       LIMIT ${MAX_BREAKDOWN_ROWS}`,
      filterParams(normalized),
    );
    return rows.map((row) => ({
      groupValue: row.group_value ?? null,
      ...normalizeAggregateRow(row),
    }));
  }

  integrityCheck() {
    this.#assertOpen();
    const result = this.db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0]?.integrity_check !== 'ok') {
      const error = new Error('metrics database integrity check failed');
      error.result = result;
      throw error;
    }
    return true;
  }

  checkpoint() {
    this.#assertOpen();
    const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (!result || result.busy !== 0) {
      const error = new Error(`metrics WAL checkpoint is busy (${result?.busy ?? 'unknown'})`);
      error.result = result;
      throw error;
    }
    return {
      busy: Number(result.busy),
      log: Number(result.log),
      checkpointed: Number(result.checkpointed),
    };
  }

  close({ checkpoint = true } = {}) {
    if (this.closed || this.closing) return { written: 0, dropped: 0, failed: 0 };
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    // Let the final synchronous flush run before marking the DB closed. If a
    // flush/checkpoint fails, the metrics path is still best effort and close
    // must not make process shutdown fail.
    let flushResult = { queued: 0, written: 0, dropped: 0, failed: 0 };
    while (this.queue.length > 0) {
      const result = this.flush();
      flushResult = {
        queued: flushResult.queued + result.queued,
        written: flushResult.written + result.written,
        dropped: flushResult.dropped + result.dropped,
        failed: flushResult.failed + result.failed,
      };
      if (result.written === 0) break;
    }
    if (this.db?.isOpen) {
      if (checkpoint) {
        try {
          this.checkpoint();
        } catch (error) {
          this.#safeLog('metrics_checkpoint_failed', { code: error.code ?? 'busy' });
        }
      }
      try {
        this.db.close();
      } catch (error) {
        this.#safeLog('metrics_close_failed', { code: error.code ?? 'unknown' });
      }
    }
    this.initialized = false;
    this.insertStatement = null;
    this.db = null;
    this.closed = true;
    this.closing = false;
    if (this.queue.length > 0) {
      const dropped = this.queue.splice(0).length;
      this.stats.dropped += dropped;
      flushResult.dropped += dropped;
      flushResult.queued += dropped;
    }
    return {
      written: flushResult.written,
      dropped: flushResult.dropped,
      failed: flushResult.failed,
    };
  }
}
