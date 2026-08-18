import { Buffer } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';

export const METRICS_FILENAME = 'metrics.sqlite';
export const METRICS_SCHEMA_VERSION = 4;

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_QUEUE = 4096;
const SQLITE_TIMEOUT_MS = 1000;
const MAX_BREAKDOWN_ROWS = 500;
const MAX_DEVICE_TOKEN_DEVICES = 8;
const MAX_DEVICE_TOKEN_HOURS_PER_DEVICE = 720;
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
const USAGE_STATES = Object.freeze(['unavailable', 'partial', 'complete']);
const CONVERSATION_CAPTURE_STATES = Object.freeze(['not_applicable', 'stored', 'dropped']);
const RESPONSE_STATES = Object.freeze(['complete', 'incomplete', 'truncated', 'unavailable']);
const PROMPT_SOURCES = Object.freeze([
  'captured_api_user_text',
  'wrapper_removed',
  'fallback_raw',
]);
const DEFAULT_MAX_CONVERSATION_QUEUE_ITEMS = 64;
const DEFAULT_MAX_CONVERSATION_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_CONVERSATION_FLUSH_ITEMS = 4;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SEARCH_QUERY_BYTES = 256;
const MAX_SEARCH_LIMIT = 50;
const MAX_SEARCH_SNIPPET_BYTES = 4 * 1024;
const MAX_CONVERSATION_FACETS = 100;
const MAX_READ_CONVERSATION_BYTES = 1024 * 1024;
const MAX_CONVERSATION_SESSION_TURNS = 200;
const MAX_CONVERSATION_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_CONVERSATION_SESSION_RESPONSE_CHARS = 16 * 1024;
const CONVERSATION_QUEUE_OVERHEAD_BYTES = 4 * 1024;
const MAX_SHORT_HAN_SEARCH_ROWS = 20_000;
const MAX_SHORT_HAN_SEARCH_BYTES = 64 * 1024 * 1024;
const HAN_PATTERN = /\p{Script=Han}/u;
const CONVERSATION_FTS_TABLES = Object.freeze([
  'conversation_turns_fts',
  'conversation_turns_trigram_fts',
]);

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
    upstream_request_id TEXT,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    cache_creation_input_tokens INTEGER
      CHECK (cache_creation_input_tokens IS NULL OR cache_creation_input_tokens >= 0),
    cache_read_input_tokens INTEGER
      CHECK (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    usage_state TEXT NOT NULL DEFAULT 'unavailable'
      CHECK (usage_state IN ('unavailable', 'partial', 'complete')),
    conversation_capture_state TEXT NOT NULL DEFAULT 'not_applicable'
      CHECK (conversation_capture_state IN ('not_applicable', 'stored', 'dropped'))
  )
`;

const V2_COLUMN_DEFINITIONS = Object.freeze({
  input_tokens: 'INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0)',
  cache_creation_input_tokens:
    'INTEGER CHECK (cache_creation_input_tokens IS NULL OR cache_creation_input_tokens >= 0)',
  cache_read_input_tokens:
    'INTEGER CHECK (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0)',
  output_tokens: 'INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0)',
  usage_state:
    "TEXT NOT NULL DEFAULT 'unavailable' CHECK (usage_state IN ('unavailable', 'partial', 'complete'))",
});

const V3_COLUMN_DEFINITIONS = Object.freeze({
  conversation_capture_state:
    "TEXT NOT NULL DEFAULT 'not_applicable' CHECK (conversation_capture_state IN ('not_applicable', 'stored', 'dropped'))",
});

const CREATE_CONVERSATION_TURNS = `
  CREATE TABLE IF NOT EXISTS conversation_turns (
    id INTEGER PRIMARY KEY,
    request_metrics_id INTEGER NOT NULL UNIQUE
      REFERENCES request_metrics(id) ON DELETE RESTRICT,
    conversation_session_id INTEGER
      REFERENCES conversation_sessions(id) ON DELETE RESTRICT,
    turn_index INTEGER,
    prompt_text TEXT NOT NULL CHECK (length(prompt_text) > 0),
    prompt_bytes INTEGER NOT NULL CHECK (prompt_bytes > 0),
    prompt_source TEXT NOT NULL DEFAULT 'captured_api_user_text'
      CHECK (prompt_source IN (
        'captured_api_user_text', 'wrapper_removed', 'fallback_raw', 'legacy_unclassified'
      )),
    prompt_suffix_omitted INTEGER NOT NULL DEFAULT 0
      CHECK (prompt_suffix_omitted IN (0, 1)),
    response_text TEXT NOT NULL DEFAULT '',
    response_state TEXT NOT NULL
      CHECK (response_state IN ('complete', 'incomplete', 'truncated', 'unavailable')),
    response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
    CHECK (
      (conversation_session_id IS NULL AND turn_index IS NULL)
      OR (conversation_session_id IS NOT NULL AND turn_index IS NOT NULL AND turn_index >= 1)
    ),
    UNIQUE (conversation_session_id, turn_index)
  )
`;

const CREATE_CONVERSATION_TURNS_V3 = `
  CREATE TABLE IF NOT EXISTS conversation_turns (
    id INTEGER PRIMARY KEY,
    request_metrics_id INTEGER NOT NULL UNIQUE
      REFERENCES request_metrics(id) ON DELETE RESTRICT,
    prompt_text TEXT NOT NULL CHECK (length(prompt_text) > 0),
    prompt_bytes INTEGER NOT NULL CHECK (prompt_bytes > 0),
    response_text TEXT NOT NULL DEFAULT '',
    response_state TEXT NOT NULL
      CHECK (response_state IN ('complete', 'incomplete', 'truncated', 'unavailable')),
    response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0)
  )
`;

const CREATE_CONVERSATION_SESSIONS = `
  CREATE TABLE IF NOT EXISTS conversation_sessions (
    id INTEGER PRIMARY KEY,
    thread_key TEXT NOT NULL UNIQUE
      CHECK (length(thread_key) = 64 AND thread_key NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  )
`;

const CREATE_CONVERSATION_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
    prompt_text,
    response_text,
    content='conversation_turns',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  )
`;

const CREATE_CONVERSATION_TRIGRAM_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_trigram_fts USING fts5(
    prompt_text,
    response_text,
    content='conversation_turns',
    content_rowid='id',
    tokenize='trigram'
  )
`;

const CREATE_CONVERSATION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS conversation_turns_metrics_idx ON conversation_turns(request_metrics_id)',
  'CREATE INDEX IF NOT EXISTS conversation_turns_session_idx ON conversation_turns(conversation_session_id, turn_index)',
  'CREATE INDEX IF NOT EXISTS conversation_sessions_created_idx ON conversation_sessions(created_at_ms)',
];

const CREATE_CONVERSATION_INDEXES_V3 = [
  'CREATE INDEX IF NOT EXISTS conversation_turns_metrics_idx ON conversation_turns(request_metrics_id)',
];

const CREATE_CONVERSATION_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS conversation_turns_fts_ai
   AFTER INSERT ON conversation_turns
   BEGIN
     INSERT INTO conversation_turns_fts(rowid, prompt_text, response_text)
     VALUES (new.id, new.prompt_text, new.response_text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS conversation_turns_trigram_fts_ai
   AFTER INSERT ON conversation_turns
   BEGIN
     INSERT INTO conversation_turns_trigram_fts(rowid, prompt_text, response_text)
     VALUES (new.id, new.prompt_text, new.response_text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS conversation_turns_no_update
   BEFORE UPDATE ON conversation_turns
   BEGIN
     SELECT RAISE(ABORT, 'conversation turns are permanent');
   END`,
  `CREATE TRIGGER IF NOT EXISTS conversation_turns_no_delete
   BEFORE DELETE ON conversation_turns
   BEGIN
     SELECT RAISE(ABORT, 'conversation turns are permanent');
   END`,
];

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS request_metrics_started_idx ON request_metrics(started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_member_started_idx ON request_metrics(member_label, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_machine_started_idx ON request_metrics(machine_id, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_device_started_idx ON request_metrics(device_id, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_account_started_idx ON request_metrics(account_id, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_model_started_idx ON request_metrics(model, started_at_ms)',
  'CREATE INDEX IF NOT EXISTS request_metrics_conversation_capture_idx ON request_metrics(conversation_capture_state)',
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
    upstream_request_id,
    input_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    output_tokens,
    usage_state,
    conversation_capture_state
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_CONVERSATION = `
  INSERT INTO conversation_turns (
    request_metrics_id,
    conversation_session_id,
    turn_index,
    prompt_text,
    prompt_bytes,
    prompt_source,
    prompt_suffix_omitted,
    response_text,
    response_state,
    response_bytes
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  AVG(duration_ms) AS avg_duration_ms,
  CASE WHEN COUNT(input_tokens) = 0 THEN NULL ELSE TOTAL(input_tokens) END AS input_tokens,
  COUNT(input_tokens) AS input_tokens_known_count,
  CASE WHEN COUNT(cache_creation_input_tokens) = 0
    THEN NULL ELSE TOTAL(cache_creation_input_tokens) END AS cache_creation_input_tokens,
  COUNT(cache_creation_input_tokens) AS cache_creation_input_tokens_known_count,
  CASE WHEN COUNT(cache_read_input_tokens) = 0
    THEN NULL ELSE TOTAL(cache_read_input_tokens) END AS cache_read_input_tokens,
  COUNT(cache_read_input_tokens) AS cache_read_input_tokens_known_count,
  CASE WHEN COUNT(output_tokens) = 0 THEN NULL ELSE TOTAL(output_tokens) END AS output_tokens,
  COUNT(output_tokens) AS output_tokens_known_count,
  COALESCE(SUM(CASE WHEN usage_state = 'complete' THEN 1 ELSE 0 END), 0)
    AS usage_complete_count,
  COALESCE(SUM(CASE WHEN usage_state = 'partial' THEN 1 ELSE 0 END), 0)
    AS usage_partial_count,
  COALESCE(SUM(CASE WHEN usage_state = 'unavailable' THEN 1 ELSE 0 END), 0)
    AS usage_unavailable_count
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

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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

function normalizeThreadKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new TypeError('conversation threadKey must be a nullable 64-hex string');
  }
  return value.toLowerCase();
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

  const inputTokens = finiteInteger(input.inputTokens, 'inputTokens', { nullable: true });
  const cacheCreationInputTokens = finiteInteger(
    input.cacheCreationInputTokens,
    'cacheCreationInputTokens',
    { nullable: true },
  );
  const cacheReadInputTokens = finiteInteger(
    input.cacheReadInputTokens,
    'cacheReadInputTokens',
    { nullable: true },
  );
  const outputTokens = finiteInteger(input.outputTokens, 'outputTokens', { nullable: true });
  const hasUsage = [
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
  ].some((value) => value !== null);
  const usageState = input.usageState === undefined
    ? (hasUsage ? 'partial' : 'unavailable')
    : input.usageState;
  const conversationCaptureState = input.conversationCaptureState === undefined
    ? 'not_applicable'
    : input.conversationCaptureState;
  if (!USAGE_STATES.includes(usageState)) {
    throw new TypeError('usageState must be unavailable, partial, or complete');
  }
  if (usageState === 'unavailable' && hasUsage) {
    throw new TypeError('unavailable usageState requires all token counts to be null');
  }
  if (usageState === 'partial' && !hasUsage) {
    throw new TypeError('partial usageState requires at least one token count');
  }
  if (usageState === 'complete' && (inputTokens === null || outputTokens === null)) {
    throw new TypeError('complete usageState requires inputTokens and outputTokens');
  }
  if (!CONVERSATION_CAPTURE_STATES.includes(conversationCaptureState)) {
    throw new TypeError('conversationCaptureState must be not_applicable, stored, or dropped');
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
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    usageState,
    conversationCaptureState,
  };
}

function normalizeConversation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('conversation must be an object');
  }
  if (typeof input.promptText !== 'string' || input.promptText.length === 0) {
    throw new TypeError('conversation promptText must be a non-empty string');
  }
  const promptBytes = Buffer.byteLength(input.promptText, 'utf8');
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new TypeError('conversation promptText exceeds its bounded size');
  }
  if (input.promptBytes !== undefined
    && (!Number.isSafeInteger(input.promptBytes) || input.promptBytes !== promptBytes)) {
    throw new TypeError('conversation promptBytes does not match promptText');
  }
  const responseText = input.responseText === undefined ? '' : input.responseText;
  if (typeof responseText !== 'string') throw new TypeError('conversation responseText must be a string');
  const responseUtf8Bytes = Buffer.byteLength(responseText, 'utf8');
  if (input.responseBytes === undefined) {
    throw new TypeError('conversation responseBytes is required');
  }
  const responseBytes = finiteInteger(input.responseBytes, 'conversation responseBytes');
  if (responseBytes !== responseUtf8Bytes) {
    throw new TypeError('conversation responseBytes does not match responseText');
  }
  if (responseUtf8Bytes > MAX_RESPONSE_BYTES) {
    throw new TypeError('conversation responseText exceeds its bounded size');
  }
  const responseState = input.responseState === undefined ? 'unavailable' : input.responseState;
  if (!RESPONSE_STATES.includes(responseState)) {
    throw new TypeError('conversation responseState is invalid');
  }
  const promptSource = input.promptSource === undefined
    ? 'captured_api_user_text'
    : input.promptSource;
  if (!PROMPT_SOURCES.includes(promptSource)) {
    throw new TypeError('conversation promptSource is invalid');
  }
  const promptSuffixOmitted = input.promptSuffixOmitted === undefined
    ? 0
    : input.promptSuffixOmitted === true
      ? 1
      : input.promptSuffixOmitted === false
        ? 0
        : null;
  if (promptSuffixOmitted === null) {
    throw new TypeError('conversation promptSuffixOmitted must be boolean');
  }
  if (responseState === 'unavailable' && responseText.length > 0) {
    throw new TypeError('unavailable responseState requires an empty responseText');
  }
  if (input.promptText.includes('\u0000') || responseText.includes('\u0000')) {
    throw new TypeError('conversation text contains NUL');
  }
  if (hasUnpairedSurrogate(input.promptText) || hasUnpairedSurrogate(responseText)) {
    throw new TypeError('conversation text contains an unpaired surrogate');
  }
  const promptUtf8Bytes = Buffer.byteLength(input.promptText, 'utf8');
  return {
    threadKey: normalizeThreadKey(input.threadKey),
    promptText: input.promptText,
    promptBytes: promptUtf8Bytes,
    promptSource,
    promptSuffixOmitted,
    responseText,
    responseState,
    responseBytes,
    queueBytes: (2 * (promptUtf8Bytes + responseUtf8Bytes)) + CONVERSATION_QUEUE_OVERHEAD_BYTES,
    retryCount: 0,
  };
}

function tokenAggregate(value) {
  if (value === null || value === undefined) return { value: null, overflow: false };
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return { value: null, overflow: true };
  return { value: numeric, overflow: false };
}

function normalizeAggregateRow(row) {
  const inputTokens = tokenAggregate(row.input_tokens);
  const cacheCreationInputTokens = tokenAggregate(row.cache_creation_input_tokens);
  const cacheReadInputTokens = tokenAggregate(row.cache_read_input_tokens);
  const outputTokens = tokenAggregate(row.output_tokens);
  return {
    requestCount: Number(row.request_count),
    successCount: Number(row.success_count),
    errorCount: Number(row.error_count),
    totalRequestBytes: Number(row.request_bytes),
    totalResponseBytes: Number(row.response_bytes),
    avgTtfbMs: row.avg_ttfb_ms === null ? null : Number(row.avg_ttfb_ms),
    avgDurationMs: row.avg_duration_ms === null ? null : Number(row.avg_duration_ms),
    totalInputTokens: inputTokens.value,
    totalInputTokensKnownCount: Number(row.input_tokens_known_count),
    totalCacheCreationInputTokens: cacheCreationInputTokens.value,
    totalCacheCreationInputTokensKnownCount: Number(row.cache_creation_input_tokens_known_count),
    totalCacheReadInputTokens: cacheReadInputTokens.value,
    totalCacheReadInputTokensKnownCount: Number(row.cache_read_input_tokens_known_count),
    totalOutputTokens: outputTokens.value,
    totalOutputTokensKnownCount: Number(row.output_tokens_known_count),
    usageCompleteCount: Number(row.usage_complete_count),
    usagePartialCount: Number(row.usage_partial_count),
    usageUnavailableCount: Number(row.usage_unavailable_count),
    tokenTotalsOverflow: [
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
    ].some((entry) => entry.overflow),
  };
}

function normalizeDeviceTokenHourlyRow(row) {
  const inputTokens = tokenAggregate(row.input_tokens);
  const cacheCreationInputTokens = tokenAggregate(row.cache_creation_input_tokens);
  const cacheReadInputTokens = tokenAggregate(row.cache_read_input_tokens);
  const outputTokens = tokenAggregate(row.output_tokens);
  return {
    hourBucketMs: Number(row.hour_bucket_ms),
    deviceId: row.device_id,
    requestCount: Number(row.request_count),
    inputTokens: inputTokens.value,
    inputTokensKnownCount: Number(row.input_tokens_known_count),
    cacheCreationInputTokens: cacheCreationInputTokens.value,
    cacheCreationInputTokensKnownCount: Number(row.cache_creation_input_tokens_known_count),
    cacheReadInputTokens: cacheReadInputTokens.value,
    cacheReadInputTokensKnownCount: Number(row.cache_read_input_tokens_known_count),
    outputTokens: outputTokens.value,
    outputTokensKnownCount: Number(row.output_tokens_known_count),
    usageCompleteCount: Number(row.usage_complete_count),
    usagePartialCount: Number(row.usage_partial_count),
    usageUnavailableCount: Number(row.usage_unavailable_count),
    tokenTotalsOverflow: [
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
    ].some((entry) => entry.overflow),
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

function normalizeDeviceTokenFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('device token hourly filters must be an object');
  }
  for (const name of ['deviceId', 'machineId']) {
    if (filters[name] !== undefined && filters[name] !== null && filters[name] !== '') {
      throw new TypeError('device token hourly query does not accept a device filter');
    }
  }
  if (filters.unattributedMachine === true) {
    throw new TypeError('device token hourly query does not accept a device filter');
  }
  if (filters.scope !== undefined && filters.scope !== 'consumption') {
    throw new TypeError('device token hourly query is consumption-only');
  }
  return normalizeFilters({
    ...filters,
    deviceId: null,
    machineId: null,
    unattributedMachine: false,
    scope: 'consumption',
  });
}

function deviceTokenFilteredCte(filters) {
  return `
    WITH filtered AS (
      SELECT
        id,
        started_at_ms,
        hour_bucket_ms,
        device_id,
        machine_id,
        member_label,
        account_id,
        account_alias,
        input_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        output_tokens,
        usage_state
      FROM request_metrics
      ${filterSql(filters)}
    )`;
}

function deviceTokenStatusSql(filters) {
  return `
    ${deviceTokenFilteredCte(filters)},
    device_totals AS (
      SELECT
        device_id,
        COUNT(input_tokens)
          + COUNT(cache_creation_input_tokens)
          + COUNT(cache_read_input_tokens)
          + COUNT(output_tokens) AS known_token_count
      FROM filtered
      GROUP BY device_id
    )
    SELECT
      COUNT(*) AS device_count,
      COALESCE(SUM(CASE WHEN known_token_count > 0 THEN 1 ELSE 0 END), 0)
        AS known_device_count,
      COALESCE(SUM(CASE WHEN known_token_count = 0 THEN 1 ELSE 0 END), 0)
        AS unavailable_device_count
    FROM device_totals
  `;
}

function deviceTokenHourlySql(filters) {
  // Every identifier is a fixed internal name. Filter values are bound by the
  // single filterParams() call below; the only numeric limits are constants.
  return `
    ${deviceTokenFilteredCte(filters)},
    device_totals AS (
      SELECT
        device_id,
        COUNT(DISTINCT hour_bucket_ms) AS device_hour_count,
        COUNT(input_tokens)
          + COUNT(cache_creation_input_tokens)
          + COUNT(cache_read_input_tokens)
          + COUNT(output_tokens) AS known_token_count,
        COALESCE(TOTAL(input_tokens), 0.0)
          + COALESCE(TOTAL(cache_creation_input_tokens), 0.0)
          + COALESCE(TOTAL(cache_read_input_tokens), 0.0)
          + COALESCE(TOTAL(output_tokens), 0.0) AS known_token_sort_total
      FROM filtered
      GROUP BY device_id
    ),
    top_devices AS (
      SELECT
        device_id,
        device_hour_count,
        ROW_NUMBER() OVER (
          ORDER BY known_token_sort_total DESC, device_id ASC
        ) AS device_rank
      FROM device_totals
      WHERE known_token_count > 0
      ORDER BY known_token_sort_total DESC, device_id ASC
      LIMIT ${MAX_DEVICE_TOKEN_DEVICES}
    ),
    latest_metadata AS (
      SELECT device_id, machine_id, member_label, account_id, account_alias
      FROM (
        SELECT
          f.device_id,
          f.machine_id,
          f.member_label,
          f.account_id,
          f.account_alias,
          ROW_NUMBER() OVER (
            PARTITION BY f.device_id
            ORDER BY f.started_at_ms DESC, f.id DESC
          ) AS metadata_rank
        FROM filtered f
        JOIN top_devices d ON d.device_id = f.device_id
      )
      WHERE metadata_rank = 1
    ),
    hourly AS (
      SELECT
        f.device_id,
        f.hour_bucket_ms,
        COUNT(*) AS request_count,
        CASE WHEN COUNT(f.input_tokens) = 0 THEN NULL ELSE TOTAL(f.input_tokens) END AS input_tokens,
        COUNT(f.input_tokens) AS input_tokens_known_count,
        CASE WHEN COUNT(f.cache_creation_input_tokens) = 0
          THEN NULL ELSE TOTAL(f.cache_creation_input_tokens) END AS cache_creation_input_tokens,
        COUNT(f.cache_creation_input_tokens) AS cache_creation_input_tokens_known_count,
        CASE WHEN COUNT(f.cache_read_input_tokens) = 0
          THEN NULL ELSE TOTAL(f.cache_read_input_tokens) END AS cache_read_input_tokens,
        COUNT(f.cache_read_input_tokens) AS cache_read_input_tokens_known_count,
        CASE WHEN COUNT(f.output_tokens) = 0 THEN NULL ELSE TOTAL(f.output_tokens) END AS output_tokens,
        COUNT(f.output_tokens) AS output_tokens_known_count,
        COALESCE(SUM(CASE WHEN f.usage_state = 'complete' THEN 1 ELSE 0 END), 0)
          AS usage_complete_count,
        COALESCE(SUM(CASE WHEN f.usage_state = 'partial' THEN 1 ELSE 0 END), 0)
          AS usage_partial_count,
        COALESCE(SUM(CASE WHEN f.usage_state = 'unavailable' THEN 1 ELSE 0 END), 0)
          AS usage_unavailable_count
      FROM filtered f
      JOIN top_devices d ON d.device_id = f.device_id
      GROUP BY f.device_id, f.hour_bucket_ms
    ),
    numbered_hourly AS (
      SELECT
        h.*,
        d.device_hour_count,
        d.device_rank,
        ROW_NUMBER() OVER (
          PARTITION BY h.device_id
          ORDER BY h.hour_bucket_ms DESC
        ) AS device_hour_number
      FROM hourly h
      JOIN top_devices d ON d.device_id = h.device_id
    )
    SELECT
      n.device_id,
      n.hour_bucket_ms,
      n.request_count,
      n.input_tokens,
      n.input_tokens_known_count,
      n.cache_creation_input_tokens,
      n.cache_creation_input_tokens_known_count,
      n.cache_read_input_tokens,
      n.cache_read_input_tokens_known_count,
      n.output_tokens,
      n.output_tokens_known_count,
      n.usage_complete_count,
      n.usage_partial_count,
      n.usage_unavailable_count,
      n.device_hour_count,
      n.device_rank,
      m.machine_id,
      m.member_label,
      m.account_id,
      m.account_alias
    FROM numbered_hourly n
    JOIN latest_metadata m ON m.device_id = n.device_id
    WHERE n.device_hour_number <= ${MAX_DEVICE_TOKEN_HOURS_PER_DEVICE}
    ORDER BY n.hour_bucket_ms ASC, n.device_rank ASC, n.device_id ASC
  `;
}

function requestMetricsTableExists(db) {
  return Boolean(db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'request_metrics'
  `).get());
}

function requestMetricsColumnInfo(db) {
  return new Map(
    db.prepare('PRAGMA table_info(request_metrics)').all()
      .map((column) => [column.name, column]),
  );
}

function assertV2Columns(db) {
  const columns = requestMetricsColumnInfo(db);
  for (const [name, definition] of Object.entries(V2_COLUMN_DEFINITIONS)) {
    const column = columns.get(name);
    if (!column) throw new Error(`metrics schema is missing column ${name}`);
    const expectedType = definition.startsWith('TEXT') ? 'TEXT' : 'INTEGER';
    if (String(column.type).toUpperCase() !== expectedType) {
      throw new Error(`metrics column ${name} has incompatible type ${column.type}`);
    }
    if (name === 'usage_state') {
      if (column.notnull !== 1 || column.dflt_value !== "'unavailable'") {
        throw new Error(`metrics column ${name} has incompatible null/default contract`);
      }
    } else if (column.notnull !== 0) {
      throw new Error(`metrics column ${name} must be nullable`);
    }
  }
  const tableSql = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'request_metrics'
  `).get()?.sql;
  const normalizedSql = String(tableSql ?? '').replace(/\s+/g, ' ').toLowerCase();
  for (const name of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
  ]) {
    const escaped = name.replaceAll('_', '[_]');
    const constraint = new RegExp(
      `${escaped} integer check \\( ?${escaped} is null or ${escaped} >= 0 ?\\)`,
    );
    if (!constraint.test(normalizedSql)) {
      throw new Error(`metrics column ${name} is missing its non-negative CHECK constraint`);
    }
  }
  if (!normalizedSql.includes(
    "check (usage_state in ('unavailable', 'partial', 'complete'))",
  )) {
    throw new Error('metrics column usage_state is missing its CHECK constraint');
  }
}

function sqliteObjectExists(db, type, name) {
  return Boolean(db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = ? AND name = ?
  `).get(type, name));
}

function assertV3Schema(db) {
  assertV2Columns(db);
  const requestColumns = requestMetricsColumnInfo(db);
  const capture = requestColumns.get('conversation_capture_state');
  if (!capture) throw new Error('metrics schema is missing column conversation_capture_state');
  if (String(capture.type).toUpperCase() !== 'TEXT'
    || capture.notnull !== 1
    || capture.dflt_value !== "'not_applicable'") {
    throw new Error('metrics conversation_capture_state has an incompatible contract');
  }
  const requestSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'request_metrics'
  `).get()?.sql ?? '').replace(/\s+/g, ' ').toLowerCase();
  if (!requestSql.includes(
    "check (conversation_capture_state in ('not_applicable', 'stored', 'dropped'))",
  )) {
    throw new Error('metrics conversation_capture_state is missing its CHECK constraint');
  }

  if (!sqliteObjectExists(db, 'table', 'conversation_turns')) {
    throw new Error('metrics schema is missing conversation_turns');
  }
  const conversationColumns = new Map(
    db.prepare('PRAGMA table_info(conversation_turns)').all()
      .map((column) => [column.name, column]),
  );
  const required = {
    request_metrics_id: { type: 'INTEGER', notnull: 1 },
    prompt_text: { type: 'TEXT', notnull: 1 },
    prompt_bytes: { type: 'INTEGER', notnull: 1 },
    response_text: { type: 'TEXT', notnull: 1 },
    response_state: { type: 'TEXT', notnull: 1 },
    response_bytes: { type: 'INTEGER', notnull: 1 },
  };
  for (const [name, contract] of Object.entries(required)) {
    const column = conversationColumns.get(name);
    if (!column || String(column.type).toUpperCase() !== contract.type
      || column.notnull !== contract.notnull) {
      throw new Error(`conversation_turns column ${name} has an incompatible contract`);
    }
  }
  if (conversationColumns.get('response_text').dflt_value !== "''") {
    throw new Error('conversation_turns response_text has an incompatible default');
  }
  const conversationSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns'
  `).get()?.sql ?? '').replace(/\s+/g, ' ').toLowerCase();
  if (!conversationSql.includes('request_metrics_id integer not null unique')) {
    throw new Error('conversation_turns request_metrics_id must be unique');
  }
  for (const fragment of [
    'check (length(prompt_text) > 0)',
    "check (response_state in ('complete', 'incomplete', 'truncated', 'unavailable'))",
    'check (prompt_bytes > 0)',
    'check (response_bytes >= 0)',
  ]) {
    if (!conversationSql.includes(fragment)) {
      throw new Error(`conversation_turns is missing canonical constraint: ${fragment}`);
    }
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(conversation_turns)').all();
  if (!foreignKeys.some((entry) => entry.table === 'request_metrics'
    && entry.from === 'request_metrics_id' && entry.to === 'id')) {
    throw new Error('conversation_turns is missing its request_metrics foreign key');
  }

  if (!sqliteObjectExists(db, 'table', 'conversation_turns_fts')) {
    throw new Error('metrics schema is missing conversation_turns_fts');
  }
  const ftsColumns = db.prepare('PRAGMA table_info(conversation_turns_fts)').all()
    .map((column) => column.name);
  if (!ftsColumns.includes('prompt_text') || !ftsColumns.includes('response_text')) {
    throw new Error('conversation_turns_fts has an incompatible contract');
  }
  const ftsSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns_fts'
  `).get()?.sql ?? '').replace(/\s+/g, '').toLowerCase();
  for (const fragment of [
    "content='conversation_turns'",
    "content_rowid='id'",
    "tokenize='unicode61remove_diacritics2'",
  ]) {
    if (!ftsSql.includes(fragment)) {
      throw new Error(`conversation_turns_fts is missing canonical option ${fragment}`);
    }
  }
  if (!sqliteObjectExists(db, 'table', 'conversation_turns_trigram_fts')) {
    throw new Error('metrics schema is missing conversation_turns_trigram_fts');
  }
  const trigramColumns = db.prepare('PRAGMA table_info(conversation_turns_trigram_fts)').all()
    .map((column) => column.name);
  if (!trigramColumns.includes('prompt_text') || !trigramColumns.includes('response_text')) {
    throw new Error('conversation_turns_trigram_fts has an incompatible contract');
  }
  const trigramSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns_trigram_fts'
  `).get()?.sql ?? '').replace(/\s+/g, '').toLowerCase();
  for (const fragment of [
    "content='conversation_turns'",
    "content_rowid='id'",
    "tokenize='trigram'",
  ]) {
    if (!trigramSql.includes(fragment)) {
      throw new Error(`conversation_turns_trigram_fts is missing canonical option ${fragment}`);
    }
  }
  const triggers = new Map(
    db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'conversation_turns_fts_ai',
        'conversation_turns_trigram_fts_ai',
        'conversation_turns_no_update',
        'conversation_turns_no_delete'
      )
    `).all().map((trigger) => [
      trigger.name,
      String(trigger.sql ?? '').replace(/\s+/g, '').toLowerCase(),
    ]),
  );
  const triggerFragments = {
    conversation_turns_fts_ai: [
      'afterinsertonconversation_turns',
      'insertintoconversation_turns_fts(rowid,prompt_text,response_text)values(new.id,new.prompt_text,new.response_text)',
    ],
    conversation_turns_trigram_fts_ai: [
      'afterinsertonconversation_turns',
      'insertintoconversation_turns_trigram_fts(rowid,prompt_text,response_text)values(new.id,new.prompt_text,new.response_text)',
    ],
    conversation_turns_no_update: [
      'beforeupdateonconversation_turns',
      "selectraise(abort,'conversationturnsarepermanent')",
    ],
    conversation_turns_no_delete: [
      'beforedeleteonconversation_turns',
      "selectraise(abort,'conversationturnsarepermanent')",
    ],
  };
  for (const [trigger, fragments] of Object.entries(triggerFragments)) {
    if (!triggers.has(trigger) || fragments.some((fragment) => !triggers.get(trigger).includes(fragment))) {
      throw new Error(`metrics schema has an incompatible trigger ${trigger}`);
    }
  }
}

function assertV4Schema(db) {
  assertV3Schema(db);

  if (!sqliteObjectExists(db, 'table', 'conversation_sessions')) {
    throw new Error('metrics schema is missing conversation_sessions');
  }
  const sessionColumns = new Map(
    db.prepare('PRAGMA table_info(conversation_sessions)').all()
      .map((column) => [column.name, column]),
  );
  const threadKey = sessionColumns.get('thread_key');
  const createdAt = sessionColumns.get('created_at_ms');
  if (!threadKey || String(threadKey.type).toUpperCase() !== 'TEXT' || threadKey.notnull !== 1) {
    throw new Error('conversation_sessions thread_key has an incompatible contract');
  }
  if (!createdAt || String(createdAt.type).toUpperCase() !== 'INTEGER' || createdAt.notnull !== 1) {
    throw new Error('conversation_sessions created_at_ms has an incompatible contract');
  }
  const sessionSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_sessions'
  `).get()?.sql ?? '').replace(/\s+/g, ' ').toLowerCase();
  if (!sessionSql.includes('thread_key text not null unique')
    || !sessionSql.includes('check (length(thread_key) = 64')
    || !sessionSql.includes("thread_key not glob '*[^0-9a-f]*'")) {
    throw new Error('conversation_sessions is missing its canonical thread key contract');
  }

  const conversationColumns = new Map(
    db.prepare('PRAGMA table_info(conversation_turns)').all()
      .map((column) => [column.name, column]),
  );
  for (const name of ['conversation_session_id', 'turn_index']) {
    const column = conversationColumns.get(name);
    if (!column || String(column.type).toUpperCase() !== 'INTEGER' || column.notnull !== 0) {
      throw new Error(`conversation_turns column ${name} has an incompatible contract`);
    }
  }
  const promptSource = conversationColumns.get('prompt_source');
  if (!promptSource || String(promptSource.type).toUpperCase() !== 'TEXT'
    || promptSource.notnull !== 1 || promptSource.dflt_value !== "'captured_api_user_text'") {
    throw new Error('conversation_turns prompt_source has an incompatible contract');
  }
  const promptSuffix = conversationColumns.get('prompt_suffix_omitted');
  if (!promptSuffix || String(promptSuffix.type).toUpperCase() !== 'INTEGER'
    || promptSuffix.notnull !== 1 || promptSuffix.dflt_value !== '0') {
    throw new Error('conversation_turns prompt_suffix_omitted has an incompatible contract');
  }
  const conversationSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns'
  `).get()?.sql ?? '').replace(/\s+/g, ' ').toLowerCase();
  if (!/check \(\s*\(conversation_session_id is null and turn_index is null\)\s*or\s*\(conversation_session_id is not null and turn_index is not null and turn_index >= 1\)\s*\)/.test(conversationSql)) {
    throw new Error('conversation_turns is missing its session/index pairing constraint');
  }
  if (!conversationSql.includes('unique (conversation_session_id, turn_index)')) {
    throw new Error('conversation_turns is missing its session/index uniqueness constraint');
  }
  if (!conversationSql.includes('check (prompt_source in (')
    || !['captured_api_user_text', 'wrapper_removed', 'fallback_raw', 'legacy_unclassified']
      .every((source) => conversationSql.includes(`'${source}'`))
    || !conversationSql.includes('check (prompt_suffix_omitted in (0, 1))')) {
    throw new Error('conversation_turns is missing its prompt provenance constraints');
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(conversation_turns)').all();
  if (!foreignKeys.some((entry) => entry.table === 'conversation_sessions'
    && entry.from === 'conversation_session_id' && entry.to === 'id'
    && entry.on_delete === 'RESTRICT')) {
    throw new Error('conversation_turns is missing its conversation session foreign key');
  }
}

function migrateRequestMetricsToV2(db) {
  if (!requestMetricsTableExists(db)) {
    throw new Error('existing metrics database has no request_metrics table');
  }
  const columns = requestMetricsColumnInfo(db);
  const partial = Object.keys(V2_COLUMN_DEFINITIONS).filter((name) => columns.has(name));
  if (partial.length) {
    throw new Error(`metrics schema v1 contains untrusted partial v2 columns: ${partial.join(', ')}`);
  }
  for (const [name, definition] of Object.entries(V2_COLUMN_DEFINITIONS)) {
    db.exec(`ALTER TABLE request_metrics ADD COLUMN ${name} ${definition}`);
  }
  assertV2Columns(db);
}

function migrateRequestMetricsToV3(db) {
  if (!requestMetricsTableExists(db)) {
    throw new Error('existing metrics database has no request_metrics table');
  }
  const requestColumns = requestMetricsColumnInfo(db);
  const partialNames = [
    'conversation_capture_state',
    'conversation_turns',
    'conversation_turns_fts',
    'conversation_turns_trigram_fts',
    'conversation_turns_fts_ai',
    'conversation_turns_trigram_fts_ai',
    'conversation_turns_no_update',
    'conversation_turns_no_delete',
  ].filter((name) => requestColumns.has(name)
    || sqliteObjectExists(db, 'table', name)
    || sqliteObjectExists(db, 'trigger', name));
  if (partialNames.length) {
    throw new Error(`metrics schema v2 contains untrusted partial v3 objects: ${partialNames.join(', ')}`);
  }
  const [name, definition] = Object.entries(V3_COLUMN_DEFINITIONS)[0];
  db.exec(`ALTER TABLE request_metrics ADD COLUMN ${name} ${definition}`);
  db.exec(CREATE_CONVERSATION_TURNS_V3);
  db.exec(CREATE_CONVERSATION_FTS);
  db.exec(CREATE_CONVERSATION_TRIGRAM_FTS);
  for (const sql of CREATE_CONVERSATION_INDEXES_V3) db.exec(sql);
  for (const sql of CREATE_CONVERSATION_TRIGGERS) db.exec(sql);
  assertV3Schema(db);
}

function migrateRequestMetricsToV4(db) {
  if (!requestMetricsTableExists(db)) {
    throw new Error('existing metrics database has no request_metrics table');
  }
  assertV3Schema(db);
  const conversationColumns = new Set(
    db.prepare('PRAGMA table_info(conversation_turns)').all().map((column) => column.name),
  );
  const partialNames = [
    'conversation_sessions',
    'conversation_turns_session_idx',
    'conversation_sessions_created_idx',
    'conversation_turns_v3_legacy',
    ...['conversation_session_id', 'turn_index', 'prompt_source', 'prompt_suffix_omitted']
      .filter((name) => conversationColumns.has(name)),
  ].filter((name) => sqliteObjectExists(db, 'table', name)
    || sqliteObjectExists(db, 'index', name)
    || conversationColumns.has(name));
  if (partialNames.length) {
    throw new Error(`metrics schema v3 contains untrusted partial v4 objects: ${partialNames.join(', ')}`);
  }

  db.exec(CREATE_CONVERSATION_SESSIONS);
  for (const trigger of [
    'conversation_turns_fts_ai',
    'conversation_turns_trigram_fts_ai',
    'conversation_turns_no_update',
    'conversation_turns_no_delete',
  ]) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  db.exec('DROP INDEX IF EXISTS conversation_turns_metrics_idx');
  db.exec('DROP TABLE conversation_turns_fts');
  db.exec('DROP TABLE conversation_turns_trigram_fts');
  db.exec('ALTER TABLE conversation_turns RENAME TO conversation_turns_v3_legacy');
  db.exec(CREATE_CONVERSATION_TURNS);
  db.exec(`
    INSERT INTO conversation_turns (
      id, request_metrics_id, prompt_text, prompt_bytes, prompt_source,
      response_text, response_state, response_bytes
    )
    SELECT
      id, request_metrics_id, prompt_text, prompt_bytes, 'legacy_unclassified',
      response_text, response_state, response_bytes
    FROM conversation_turns_v3_legacy
  `);
  db.exec('DROP TABLE conversation_turns_v3_legacy');
  db.exec(CREATE_CONVERSATION_FTS);
  db.exec(CREATE_CONVERSATION_TRIGRAM_FTS);
  db.exec(`
    INSERT INTO conversation_turns_fts(rowid, prompt_text, response_text)
    SELECT id, prompt_text, response_text FROM conversation_turns
  `);
  db.exec(`
    INSERT INTO conversation_turns_trigram_fts(rowid, prompt_text, response_text)
    SELECT id, prompt_text, response_text FROM conversation_turns
  `);
  for (const sql of CREATE_CONVERSATION_INDEXES) db.exec(sql);
  for (const sql of CREATE_CONVERSATION_TRIGGERS) db.exec(sql);
  assertV4Schema(db);
}

function ensureConversationTrigramSearch(db) {
  const table = sqliteObjectExists(db, 'table', 'conversation_turns_trigram_fts');
  const trigger = sqliteObjectExists(db, 'trigger', 'conversation_turns_trigram_fts_ai');
  if (table !== trigger) {
    throw new Error('metrics schema has a partial conversation trigram index');
  }
  if (!table) {
    db.exec(CREATE_CONVERSATION_TRIGRAM_FTS);
    db.exec(`
      INSERT INTO conversation_turns_trigram_fts(rowid, prompt_text, response_text)
      SELECT id, prompt_text, response_text FROM conversation_turns
    `);
    const triggerSql = CREATE_CONVERSATION_TRIGGERS.find(
      (sql) => sql.includes('conversation_turns_trigram_fts_ai'),
    );
    db.exec(triggerSql);
  }
}

function normalizeConversationSearch({
  q = '',
  fromMs = null,
  toMs = null,
  deviceId = null,
  machineId = null,
  unattributedMachine = false,
  memberLabel = null,
  accountId = null,
  model = null,
  responseState = null,
  beforeId = null,
  limit = 20,
} = {}) {
  if (typeof q !== 'string') throw new TypeError('conversation search query must be a string');
  const query = q
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (Buffer.byteLength(query, 'utf8') > MAX_SEARCH_QUERY_BYTES) {
    throw new TypeError('conversation search query is too long');
  }
  const normalizedFromMs = normalizeOptionalTime(fromMs, 'fromMs');
  const normalizedToMs = normalizeOptionalTime(toMs, 'toMs');
  if (normalizedFromMs !== null && normalizedToMs !== null
    && normalizedFromMs > normalizedToMs) {
    throw new TypeError('fromMs must not be after toMs');
  }
  const normalizedState = responseState === null || responseState === undefined
    ? null
    : responseState;
  if (normalizedState !== null && !RESPONSE_STATES.includes(normalizedState)) {
    throw new TypeError('responseState is invalid');
  }
  const normalizedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(MAX_SEARCH_LIMIT, limit))
    : 20;
  const normalizedBeforeId = beforeId === null || beforeId === undefined
    ? null
    : finiteInteger(beforeId, 'beforeId', { minimum: 1 });
  const literalTerms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (literalTerms.length > 32) throw new TypeError('conversation search query has too many terms');
  const containsHan = HAN_PATTERN.test(query);
  const hasSearchPunctuation = /[^\p{L}\p{N}\s_-]/u.test(query);
  const hasSearchWhitespace = /\s/u.test(query);
  const useTrigram = containsHan
    && !hasSearchPunctuation
    && !hasSearchWhitespace
    && [...query].length >= 3;
  const substringTerms = containsHan && !useTrigram
    ? query.split(/\s+/).filter(Boolean)
    : [];
  const ftsQuery = literalTerms.length
    ? literalTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    : null;
  return {
    ftsQuery,
    containsHan,
    shortHanQuery: containsHan && [...query].length < 3,
    trigramQuery: useTrigram ? `"${query.replaceAll('"', '""')}"` : null,
    substringTerms,
    emptyLiteralQuery: query.length > 0 && literalTerms.length === 0,
    fromMs: normalizedFromMs,
    toMs: normalizedToMs,
    deviceId: boundedString(deviceId, 'deviceId', MAX_IDENTIFIER, { emptyAsNull: true }),
    machineId: boundedString(machineId, 'machineId', MAX_MACHINE_ID, { emptyAsNull: true }),
    unattributedMachine: unattributedMachine === true ? 1 : 0,
    memberLabel: boundedString(memberLabel, 'memberLabel', MAX_MEMBER_LABEL, { emptyAsNull: true }),
    accountId: boundedString(accountId, 'accountId', MAX_IDENTIFIER, { emptyAsNull: true }),
    model: boundedString(model, 'model', MAX_MODEL, { emptyAsNull: true }),
    responseState: normalizedState,
    beforeId: normalizedBeforeId,
    limit: normalizedLimit,
  };
}

function conversationSearchPlan(filters) {
  const useTrigram = Boolean(filters.trigramQuery);
  const useFts = Boolean(filters.ftsQuery) && !filters.containsHan && !useTrigram;
  const useSubstring = filters.substringTerms.length > 0;
  const searchTable = useTrigram
    ? 'conversation_turns_trigram_fts'
    : 'conversation_turns_fts';
  const substringPredicate = useSubstring
    ? filters.substringTerms
      .map(() => '(instr(t.prompt_text, ?) > 0 OR instr(t.response_text, ?) > 0)')
      .join(' AND ')
    : null;
  return {
    useFts,
    useTrigram,
    useSubstring,
    hasText: useFts || useTrigram || useSubstring,
    searchTable,
    textPredicate: useFts || useTrigram
      ? `${searchTable} MATCH ?`
      : useSubstring
        ? substringPredicate
        : '? IS NULL',
    textParams: useFts
      ? [filters.ftsQuery]
      : useTrigram
        ? [filters.trigramQuery]
        : useSubstring
          ? filters.substringTerms.flatMap((term) => [term, term])
          : [null],
  };
}

function conversationSearchFilterSql(plan, { includeBefore = false } = {}) {
  return `
    WHERE (${plan.textPredicate})
      AND (? IS NULL OR m.started_at_ms >= ?)
      AND (? IS NULL OR m.started_at_ms < ?)
      AND (? IS NULL OR m.device_id = ?)
      AND (? IS NULL OR m.machine_id = ?)
      AND (? = 0 OR m.machine_id IS NULL)
      AND (? IS NULL OR m.member_label = ?)
      AND (? IS NULL OR m.account_id = ?)
      AND (? IS NULL OR m.model = ?)
      AND (? IS NULL OR t.response_state = ?)
      ${includeBefore ? 'AND (? IS NULL OR t.id < ?)' : ''}
  `;
}

function conversationSearchFilterParams(filters, plan, { includeBefore = false } = {}) {
  return [
    ...plan.textParams,
    filters.fromMs, filters.fromMs,
    filters.toMs, filters.toMs,
    filters.deviceId, filters.deviceId,
    filters.machineId, filters.machineId,
    filters.unattributedMachine,
    filters.memberLabel, filters.memberLabel,
    filters.accountId, filters.accountId,
    filters.model, filters.model,
    filters.responseState, filters.responseState,
    ...(includeBefore ? [filters.beforeId, filters.beforeId] : []),
  ];
}

function conversationSessionMatchSql(plan) {
  const textJoin = plan.useFts || plan.useTrigram
    ? `JOIN ${plan.searchTable} ON ${plan.searchTable}.rowid = t.id`
    : '';
  return `
    SELECT DISTINCT t.conversation_session_id
    FROM conversation_turns t
    JOIN request_metrics m ON m.id = t.request_metrics_id
    ${textJoin}
    ${conversationSearchFilterSql(plan)}
      AND t.conversation_session_id IS NOT NULL
  `;
}

function normalizeConversationFacetFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('conversation facet filters must be an object');
  }
  if (filters.beforeId !== undefined && filters.beforeId !== null) {
    throw new TypeError('conversation facets do not accept a pagination cursor');
  }
  if (filters.limit !== undefined && filters.limit !== 20) {
    throw new TypeError('conversation facets do not accept a result limit');
  }
  return normalizeConversationSearch({ ...filters, beforeId: null, limit: 20 });
}

function conversationFacetFilterSql(plan = null) {
  return `
    WHERE ${plan?.hasText ? `(${plan.textPredicate}) AND` : ''}
      (? IS NULL OR m.started_at_ms >= ?)
      AND (? IS NULL OR m.started_at_ms < ?)
      AND (? IS NULL OR m.device_id = ?)
      AND (? IS NULL OR m.machine_id = ?)
      AND (? = 0 OR m.machine_id IS NULL)
      AND (? IS NULL OR m.member_label = ?)
      AND (? IS NULL OR m.account_id = ?)
      AND (? IS NULL OR m.model = ?)
      AND (? IS NULL OR t.response_state = ?)
  `;
}

function conversationFacetFilterParams(filters, plan = null) {
  return [
    ...(plan?.hasText ? plan.textParams : []),
    filters.fromMs, filters.fromMs,
    filters.toMs, filters.toMs,
    filters.deviceId, filters.deviceId,
    filters.machineId, filters.machineId,
    filters.unattributedMachine,
    filters.memberLabel, filters.memberLabel,
    filters.accountId, filters.accountId,
    filters.model, filters.model,
    filters.responseState, filters.responseState,
  ];
}

function conversationFacetBaseFilterSql(plan = null) {
  return `
    WHERE ${plan?.hasText ? `(${plan.textPredicate}) AND` : ''}
      (? IS NULL OR m.started_at_ms >= ?)
      AND (? IS NULL OR m.started_at_ms < ?)
      AND (? IS NULL OR m.machine_id = ?)
      AND (? = 0 OR m.machine_id IS NULL)
  `;
}

function conversationFacetBaseFilterParams(filters, plan = null) {
  return [
    ...(plan?.hasText ? plan.textParams : []),
    filters.fromMs, filters.fromMs,
    filters.toMs, filters.toMs,
    filters.machineId, filters.machineId,
    filters.unattributedMachine,
  ];
}

function clipConversationText(value, maxBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

export class MetricsStore {
  constructor({
    home,
    dbPath = null,
    batchSize = DEFAULT_BATCH_SIZE,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    maxQueue = DEFAULT_MAX_QUEUE,
    maxConversationQueueItems = DEFAULT_MAX_CONVERSATION_QUEUE_ITEMS,
    maxConversationQueueBytes = DEFAULT_MAX_CONVERSATION_QUEUE_BYTES,
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
    this.maxConversationQueueItems = Number.isSafeInteger(maxConversationQueueItems)
      && maxConversationQueueItems > 0
      ? Math.min(maxConversationQueueItems, DEFAULT_MAX_CONVERSATION_QUEUE_ITEMS)
      : DEFAULT_MAX_CONVERSATION_QUEUE_ITEMS;
    this.maxConversationQueueBytes = Number.isSafeInteger(maxConversationQueueBytes)
      && maxConversationQueueBytes > 0
      ? Math.min(maxConversationQueueBytes, DEFAULT_MAX_CONVERSATION_QUEUE_BYTES)
      : DEFAULT_MAX_CONVERSATION_QUEUE_BYTES;
    this.clock = typeof clock === 'function' ? clock : Date.now;
    this.log = typeof log === 'function' ? log : () => {};
    this.db = null;
    this.insertStatement = null;
    this.timer = null;
    this.queue = [];
    this.conversationQueue = [];
    this.conversationQueueBytes = 0;
    this.initialized = false;
    this.closed = false;
    this.closing = false;
    this.flushing = false;
    this.stats = {
      enqueued: 0,
      written: 0,
      dropped: 0,
      failed: 0,
      conversation: {
        enqueued: 0,
        written: 0,
        dropped: 0,
        failed: 0,
      },
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

  #logConversationDrop(reason) {
    this.#safeLog('conversation_queue_dropped', { reason });
  }

  #queueHasCapacity() {
    return this.queue.length + this.conversationQueue.length < this.maxQueue;
  }

  #enqueueMetricOnly(normalized) {
    if (this.closed || this.closing || !this.#queueHasCapacity()) {
      this.stats.dropped += 1;
      this.#logQueueDrop(this.closed || this.closing ? 'closed' : 'full');
      return false;
    }
    this.queue.push(normalized);
    this.stats.enqueued += 1;
    return true;
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
      this.db.exec('PRAGMA foreign_keys = ON');
      const foreignKeys = this.db.prepare('PRAGMA foreign_keys').get();
      if (foreignKeys?.foreign_keys !== 1) {
        throw new Error('metrics database did not enable foreign_keys');
      }

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
        const schemaMeta = this.db.prepare(
          'SELECT schema_version FROM schema_meta WHERE singleton = 1',
        ).get();
        if (databaseExisted && !schemaMeta) {
          throw new Error('existing metrics database has no schema version row');
        }
        if (schemaMeta && !Number.isInteger(schemaMeta.schema_version)) {
          throw new Error('metrics schema_version is invalid');
        }
        if (schemaMeta && schemaMeta.schema_version > METRICS_SCHEMA_VERSION) {
          throw new Error(
            `metrics schema_version ${schemaMeta.schema_version} is newer than supported ${METRICS_SCHEMA_VERSION}`,
          );
        }
        let schemaVersion = schemaMeta?.schema_version ?? null;
        if (!schemaMeta) {
          this.db.exec(CREATE_REQUEST_METRICS);
          this.db.exec(CREATE_CONVERSATION_SESSIONS);
          this.db.exec(CREATE_CONVERSATION_TURNS);
          this.db.exec(CREATE_CONVERSATION_FTS);
          this.db.exec(CREATE_CONVERSATION_TRIGRAM_FTS);
          for (const sql of CREATE_CONVERSATION_INDEXES) this.db.exec(sql);
          for (const sql of CREATE_CONVERSATION_TRIGGERS) this.db.exec(sql);
          assertV4Schema(this.db);
          schemaVersion = METRICS_SCHEMA_VERSION;
        } else if (schemaVersion === 1) {
          migrateRequestMetricsToV2(this.db);
          schemaVersion = 2;
        }
        if (schemaVersion === 2) {
          migrateRequestMetricsToV3(this.db);
          schemaVersion = 3;
        }
        if (schemaVersion === 3) {
          migrateRequestMetricsToV4(this.db);
          schemaVersion = 4;
        } else if (schemaVersion === METRICS_SCHEMA_VERSION) {
          ensureConversationTrigramSearch(this.db);
          assertV4Schema(this.db);
        } else if (schemaVersion !== null) {
          throw new Error(
            `metrics schema_version ${schemaVersion} cannot be migrated to ${METRICS_SCHEMA_VERSION}`,
          );
        }
        for (const sql of CREATE_INDEXES) this.db.exec(sql);
        for (const sql of CREATE_CONVERSATION_INDEXES) this.db.exec(sql);
        if (schemaMeta && schemaMeta.schema_version !== METRICS_SCHEMA_VERSION) {
          this.db.prepare(`
            UPDATE schema_meta
            SET schema_version = ?, updated_at_ms = ?
            WHERE singleton = 1
          `).run(METRICS_SCHEMA_VERSION, this.#now());
        }
        if (!schemaMeta) {
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
    let normalized;
    try {
      normalized = normalizeRow(row);
    } catch (error) {
      this.stats.dropped += 1;
      this.#safeLog('metrics_row_rejected', { code: error.code ?? 'invalid_row' });
      return false;
    }
    normalized.conversationCaptureState = 'not_applicable';
    return this.#enqueueMetricOnly(normalized);
  }

  enqueueCompletion({ metrics, conversation = null } = {}) {
    let normalizedMetrics;
    try {
      normalizedMetrics = normalizeRow(metrics);
    } catch (error) {
      this.stats.dropped += 1;
      this.#safeLog('metrics_row_rejected', { code: error.code ?? 'invalid_row' });
      return false;
    }
    if (conversation === null || conversation === undefined) {
      normalizedMetrics.conversationCaptureState = 'not_applicable';
      return this.#enqueueMetricOnly(normalizedMetrics);
    }
    let normalizedConversation;
    try {
      normalizedConversation = normalizeConversation(conversation);
    } catch (error) {
      normalizedMetrics.conversationCaptureState = 'dropped';
      this.stats.conversation.dropped += 1;
      this.#logConversationDrop(error.message);
      return this.#enqueueMetricOnly(normalizedMetrics);
    }
    if (this.closed || this.closing || !this.#queueHasCapacity()) {
      this.stats.dropped += 1;
      this.#logQueueDrop(this.closed || this.closing ? 'closed' : 'full');
      this.stats.conversation.dropped += 1;
      this.#logConversationDrop(this.closed || this.closing ? 'closed' : 'full');
      return false;
    }
    if (this.conversationQueue.length >= this.maxConversationQueueItems
      || this.conversationQueueBytes + normalizedConversation.queueBytes
        > this.maxConversationQueueBytes) {
      normalizedMetrics.conversationCaptureState = 'dropped';
      this.stats.conversation.dropped += 1;
      this.#logConversationDrop('budget');
      return this.#enqueueMetricOnly(normalizedMetrics);
    }
    normalizedMetrics.conversationCaptureState = 'not_applicable';
    this.conversationQueue.push({
      metrics: normalizedMetrics,
      conversation: normalizedConversation,
    });
    this.conversationQueueBytes += normalizedConversation.queueBytes;
    this.stats.enqueued += 1;
    this.stats.conversation.enqueued += 1;
    return true;
  }

  #insertMetric(row) {
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
      row.inputTokens,
      row.cacheCreationInputTokens,
      row.cacheReadInputTokens,
      row.outputTokens,
      row.usageState,
      row.conversationCaptureState,
    );
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  #persistentConversationDroppedCount() {
    try {
      return Number(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM request_metrics
        WHERE conversation_capture_state = 'dropped'
      `).get().count);
    } catch {
      return null;
    }
  }

  #persistentStandaloneConversationCount() {
    try {
      return Number(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_turns
        WHERE conversation_session_id IS NULL
      `).get().count);
    } catch {
      return null;
    }
  }

  #ensureConversationSession(threadKey, startedAtMs) {
    if (threadKey === null) return null;
    this.db.prepare(`
      INSERT INTO conversation_sessions (thread_key, created_at_ms)
      VALUES (?, ?)
      ON CONFLICT(thread_key) DO NOTHING
    `).run(threadKey, startedAtMs);
    const session = this.db.prepare(`
      SELECT id
      FROM conversation_sessions
      WHERE thread_key = ?
    `).get(threadKey);
    if (!session) throw new Error('conversation session could not be created');
    return Number(session.id);
  }

  #nextConversationTurnIndex(sessionId) {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(turn_index), 0) + 1 AS turn_index
      FROM conversation_turns
      WHERE conversation_session_id = ?
    `).get(sessionId);
    return Number(row.turn_index);
  }

  #conversationSearchWorkload() {
    return this.db.prepare(`
      SELECT COUNT(*) AS count,
        CASE WHEN COUNT(*) = 0 THEN 0 ELSE TOTAL(prompt_bytes + response_bytes) END AS bytes
      FROM conversation_turns
    `).get();
  }

  #conversationMatchCount(filters, plan) {
    const textJoin = plan.useFts || plan.useTrigram
      ? `JOIN ${plan.searchTable} ON ${plan.searchTable}.rowid = t.id`
      : '';
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total_matches
      FROM conversation_turns t
      JOIN request_metrics m ON m.id = t.request_metrics_id
      ${textJoin}
      ${conversationSearchFilterSql(plan)}
    `).get(...conversationSearchFilterParams(filters, plan));
    return Number(row?.total_matches ?? 0);
  }

  #insertConversationPair(pair) {
    this.db.exec('SAVEPOINT conversation_pair');
    try {
      const metricId = this.#insertMetric(pair.metrics);
      const conversationSessionId = this.#ensureConversationSession(
        pair.conversation.threadKey,
        pair.metrics.startedAtMs,
      );
      const turnIndex = conversationSessionId === null
        ? null
        : this.#nextConversationTurnIndex(conversationSessionId);
      this.db.prepare(INSERT_CONVERSATION).run(
        metricId,
        conversationSessionId,
        turnIndex,
        pair.conversation.promptText,
        pair.conversation.promptBytes,
        pair.conversation.promptSource,
        pair.conversation.promptSuffixOmitted,
        pair.conversation.responseText,
        pair.conversation.responseState,
        pair.conversation.responseBytes,
      );
      this.db.prepare(`
        UPDATE request_metrics
        SET conversation_capture_state = 'stored'
        WHERE id = ?
      `).run(metricId);
      this.db.exec('RELEASE SAVEPOINT conversation_pair');
      return 'stored';
    } catch (error) {
      try {
        this.db.exec('ROLLBACK TO SAVEPOINT conversation_pair');
        this.db.exec('RELEASE SAVEPOINT conversation_pair');
      } catch (rollbackError) {
        this.#safeLog('conversation_savepoint_rollback_failed', {
          code: rollbackError.code ?? 'unknown',
        });
        throw error;
      }
      const droppedMetrics = { ...pair.metrics, conversationCaptureState: 'dropped' };
      this.#insertMetric(droppedMetrics);
      this.#safeLog('conversation_write_failed', { code: error.code ?? 'unknown' });
      return 'dropped';
    }
  }

  flush() {
    if (this.flushing || (this.queue.length === 0 && this.conversationQueue.length === 0)) {
      return { queued: 0, written: 0, dropped: 0, failed: 0 };
    }
    if (!this.initialized || !this.db?.isOpen || this.closed) {
      return { queued: 0, written: 0, dropped: 0, failed: 0 };
    }

    const batch = this.queue.splice(0, this.batchSize);
    const conversationBatch = this.conversationQueue.splice(
      0,
      Math.min(this.batchSize, MAX_CONVERSATION_FLUSH_ITEMS),
    );
    this.conversationQueueBytes -= conversationBatch.reduce(
      (total, pair) => total + pair.conversation.queueBytes,
      0,
    );
    this.flushing = true;
    let conversationWritten = 0;
    let conversationDroppedInTransaction = 0;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const row of batch) this.#insertMetric(row);
      for (const pair of conversationBatch) {
        if (this.#insertConversationPair(pair) === 'stored') conversationWritten += 1;
        else conversationDroppedInTransaction += 1;
      }
      this.db.exec('COMMIT');
      this.stats.written += batch.length + conversationBatch.length;
      this.stats.conversation.written += conversationWritten;
      this.stats.conversation.dropped += conversationDroppedInTransaction;
      return {
        queued: batch.length + conversationBatch.length,
        written: batch.length + conversationBatch.length,
        dropped: 0,
        failed: 0,
      };
    } catch (error) {
      this.#rollback();
      this.stats.failed += batch.length + conversationBatch.length;
      this.stats.conversation.failed += conversationBatch.length;
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

      const retryConversation = transient
        ? conversationBatch.filter((pair) => pair.metrics.retryCount < MAX_TRANSIENT_WRITE_RETRIES)
        : [];
      for (const pair of retryConversation) pair.metrics.retryCount += 1;
      const conversationRetryRows = [];
      let retryConversationBytes = 0;
      for (const pair of retryConversation) {
        if (this.conversationQueue.length + conversationRetryRows.length
          >= this.maxConversationQueueItems) break;
        if (this.conversationQueueBytes + retryConversationBytes + pair.conversation.queueBytes
          > this.maxConversationQueueBytes) continue;
        conversationRetryRows.push(pair);
        retryConversationBytes += pair.conversation.queueBytes;
      }
      if (conversationRetryRows.length) {
        this.conversationQueue.unshift(...conversationRetryRows);
        this.conversationQueueBytes += retryConversationBytes;
      }
      const conversationDropped = conversationBatch.length - conversationRetryRows.length;
      this.stats.conversation.dropped += conversationDropped;
      this.stats.dropped += conversationDropped;
      this.#safeLog(retryRows.length || conversationRetryRows.length
        ? 'metrics_flush_retry'
        : 'metrics_flush_failed', {
        count: batch.length + conversationBatch.length,
        retried: retryRows.length + conversationRetryRows.length,
        dropped: dropped + conversationDropped,
        code: error.code ?? 'unknown',
      });
      return {
        queued: batch.length + conversationBatch.length,
        written: 0,
        dropped: dropped + conversationDropped,
        failed: batch.length + conversationBatch.length,
      };
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

  queryDeviceTokenHourly(filters = {}) {
    const normalized = normalizeDeviceTokenFilters(filters);
    const status = this.#queryRows(
      deviceTokenStatusSql(normalized),
      filterParams(normalized),
    )[0];
    const rows = this.#queryRows(
      deviceTokenHourlySql(normalized),
      filterParams(normalized),
    );
    const devices = new Map();
    const normalizedRows = rows.map((row) => {
      const deviceId = row.device_id;
      if (!devices.has(deviceId)) {
        devices.set(deviceId, {
          deviceId,
          machineId: row.machine_id ?? null,
          memberLabel: row.member_label,
          accountId: row.account_id,
          accountAlias: row.account_alias,
          deviceRank: Number(row.device_rank),
        });
      }
      return normalizeDeviceTokenHourlyRow(row);
    });
    return {
      devices: [...devices.values()]
        .sort((left, right) => left.deviceRank - right.deviceRank)
        .map(({ deviceRank, ...device }) => device),
      rows: normalizedRows,
      unavailableDeviceCount: Number(status?.unavailable_device_count ?? 0),
      devicesTruncated: Number(status?.known_device_count ?? 0) > MAX_DEVICE_TOKEN_DEVICES,
      hoursTruncated: rows.some(
        (row) => Number(row.device_hour_count) > MAX_DEVICE_TOKEN_HOURS_PER_DEVICE,
      ),
      truncated: Number(status?.known_device_count ?? 0) > MAX_DEVICE_TOKEN_DEVICES
        || rows.some(
          (row) => Number(row.device_hour_count) > MAX_DEVICE_TOKEN_HOURS_PER_DEVICE,
        ),
    };
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

  queryConversationFacets(filters = {}) {
    try {
      return this.#queryConversationFacets(filters, { sessionsOnly: false });
    } catch (error) {
      this.#safeLog('conversation_facets_failed', { code: error.code ?? error.name ?? 'unknown' });
      return this.#emptyConversationFacets('search_unavailable');
    }
  }

  queryConversationSessionFacets(filters = {}) {
    try {
      return this.#queryConversationFacets(filters, { sessionsOnly: true });
    } catch (error) {
      this.#safeLog('conversation_session_facets_failed', {
        code: error.code ?? error.name ?? 'unknown',
      });
      return this.#emptyConversationFacets('search_unavailable');
    }
  }

  #queryConversationFacets(filters = {}, { sessionsOnly = false } = {}) {
    const normalized = normalizeConversationFacetFilters(filters);
    const plan = conversationSearchPlan(normalized);
    if (normalized.emptyLiteralQuery) {
      return {
        members: [],
        devices: [],
        accounts: [],
        models: [],
        responseStates: [],
        totalStored: 0,
        earliestStartedAtMs: null,
        latestStartedAtMs: null,
        facetTruncated: {
          members: false,
          devices: false,
          accounts: false,
          models: false,
          responseStates: false,
        },
        truncated: false,
        error: null,
      };
    }
    const workload = plan.useSubstring ? this.#conversationSearchWorkload() : null;
    if (workload && Number(workload.count) > MAX_SHORT_HAN_SEARCH_ROWS) {
      return this.#emptyConversationFacets(
        normalized.shortHanQuery ? 'search_query_too_short' : 'search_query_requires_indexed_terms',
      );
    }
    if (workload && Number(workload.bytes) > MAX_SHORT_HAN_SEARCH_BYTES) {
      return this.#emptyConversationFacets('search_query_requires_indexed_terms');
    }
    const params = conversationFacetFilterParams(normalized, plan);
    const textJoin = plan.useFts || plan.useTrigram
      ? `JOIN ${plan.searchTable} ON ${plan.searchTable}.rowid = t.id`
      : '';
    const sessionConstraint = sessionsOnly
      ? 'AND t.conversation_session_id IS NOT NULL'
      : '';
    const facetCount = sessionsOnly
      ? 'COUNT(DISTINCT conversation_session_id)'
      : 'COUNT(*)';
    const stats = this.#queryRows(`
      SELECT
        ${sessionsOnly ? 'COUNT(DISTINCT t.conversation_session_id)' : 'COUNT(*)'} AS total_stored,
        MIN(m.started_at_ms) AS earliest_started_at_ms,
        MAX(m.started_at_ms) AS latest_started_at_ms
      FROM conversation_turns t
      JOIN request_metrics m ON m.id = t.request_metrics_id
      ${textJoin}
      ${conversationFacetFilterSql(plan)}
      ${sessionConstraint}
    `, params)[0];
    // Facets are disjunctive: each list applies every active constraint except
    // its own dimension. This keeps, for example, member B available while
    // member A is selected, without changing the exact filtered total above.
    const facetRows = this.#queryRows(`
      WITH criteria(
        member_filter,
        device_filter,
        account_filter,
        model_filter,
        response_filter
      ) AS (VALUES (?, ?, ?, ?, ?)),
      base AS (
        SELECT
          m.member_label,
          m.device_id,
          m.account_id,
          m.model,
          t.conversation_session_id,
          t.response_state
        FROM conversation_turns t
        JOIN request_metrics m ON m.id = t.request_metrics_id
        ${textJoin}
        ${conversationFacetBaseFilterSql(plan)}
        ${sessionConstraint}
      ),
      facet_values AS (
        SELECT 'members' AS facet, member_label AS value, ${facetCount} AS facet_count
        FROM base, criteria
        WHERE member_label IS NOT NULL AND member_label <> ''
          AND (device_filter IS NULL OR device_id = device_filter)
          AND (account_filter IS NULL OR account_id = account_filter)
          AND (model_filter IS NULL OR model = model_filter)
          AND (response_filter IS NULL OR response_state = response_filter)
        GROUP BY member_label
        UNION ALL
        SELECT 'devices' AS facet, device_id AS value, ${facetCount} AS facet_count
        FROM base, criteria
        WHERE device_id IS NOT NULL AND device_id <> ''
          AND (member_filter IS NULL OR member_label = member_filter)
          AND (account_filter IS NULL OR account_id = account_filter)
          AND (model_filter IS NULL OR model = model_filter)
          AND (response_filter IS NULL OR response_state = response_filter)
        GROUP BY device_id
        UNION ALL
        SELECT 'accounts' AS facet, account_id AS value, ${facetCount} AS facet_count
        FROM base, criteria
        WHERE account_id IS NOT NULL AND account_id <> ''
          AND (member_filter IS NULL OR member_label = member_filter)
          AND (device_filter IS NULL OR device_id = device_filter)
          AND (model_filter IS NULL OR model = model_filter)
          AND (response_filter IS NULL OR response_state = response_filter)
        GROUP BY account_id
        UNION ALL
        SELECT 'models' AS facet, model AS value, ${facetCount} AS facet_count
        FROM base, criteria
        WHERE model IS NOT NULL AND model <> ''
          AND (member_filter IS NULL OR member_label = member_filter)
          AND (device_filter IS NULL OR device_id = device_filter)
          AND (account_filter IS NULL OR account_id = account_filter)
          AND (response_filter IS NULL OR response_state = response_filter)
        GROUP BY model
        UNION ALL
        SELECT 'responseStates' AS facet, response_state AS value, ${facetCount} AS facet_count
        FROM base, criteria
        WHERE response_state IS NOT NULL AND response_state <> ''
          AND (member_filter IS NULL OR member_label = member_filter)
          AND (device_filter IS NULL OR device_id = device_filter)
          AND (account_filter IS NULL OR account_id = account_filter)
          AND (model_filter IS NULL OR model = model_filter)
        GROUP BY response_state
      ),
      ranked AS (
        SELECT
          facet,
          value,
          facet_count,
          COUNT(*) OVER (PARTITION BY facet) AS facet_value_count,
          ROW_NUMBER() OVER (
            PARTITION BY facet
            ORDER BY facet_count DESC, value IS NULL ASC, value ASC
          ) AS facet_rank
        FROM facet_values
      )
      SELECT facet, value, facet_count, facet_value_count
      FROM ranked
      WHERE facet_rank <= ${MAX_CONVERSATION_FACETS}
      ORDER BY facet, facet_rank
    `, [
      normalized.memberLabel,
      normalized.deviceId,
      normalized.accountId,
      normalized.model,
      normalized.responseState,
      ...conversationFacetBaseFilterParams(normalized, plan),
    ]);
    const result = {
      members: [],
      devices: [],
      accounts: [],
      models: [],
      responseStates: [],
      totalStored: Number(stats?.total_stored ?? 0),
      earliestStartedAtMs: stats?.earliest_started_at_ms === null
        || stats?.earliest_started_at_ms === undefined
        ? null
        : Number(stats.earliest_started_at_ms),
      latestStartedAtMs: stats?.latest_started_at_ms === null
        || stats?.latest_started_at_ms === undefined
        ? null
        : Number(stats.latest_started_at_ms),
      facetTruncated: {
        members: false,
        devices: false,
        accounts: false,
        models: false,
        responseStates: false,
      },
      truncated: false,
      error: null,
    };
    for (const row of facetRows) {
      if (!Object.hasOwn(result, row.facet) || !Array.isArray(result[row.facet])) continue;
      if (Number(row.facet_value_count) > MAX_CONVERSATION_FACETS) {
        result.facetTruncated[row.facet] = true;
        result.truncated = true;
      }
      result[row.facet].push({
        value: row.value ?? null,
        count: Number(row.facet_count),
      });
    }
    return result;
  }

  #emptyConversationFacets(error) {
    return {
      members: [],
      devices: [],
      accounts: [],
      models: [],
      responseStates: [],
      totalStored: null,
      earliestStartedAtMs: null,
      latestStartedAtMs: null,
      facetTruncated: {
        members: false,
        devices: false,
        accounts: false,
        models: false,
        responseStates: false,
      },
      truncated: false,
      error,
    };
  }

  searchConversations(options = {}) {
    try {
      this.#assertOpen();
      const filters = normalizeConversationSearch(options);
      if (filters.emptyLiteralQuery) {
        return {
          items: [],
          nextBeforeId: null,
          totalMatches: 0,
          droppedConversations: this.#persistentConversationDroppedCount(),
          error: null,
        };
      }
      const plan = conversationSearchPlan(filters);
      const workload = plan.useSubstring ? this.#conversationSearchWorkload() : null;
      if (workload && Number(workload.count) > MAX_SHORT_HAN_SEARCH_ROWS) {
        return {
          items: [],
          nextBeforeId: null,
          totalMatches: null,
          droppedConversations: this.#persistentConversationDroppedCount(),
          error: filters.shortHanQuery ? 'search_query_too_short' : 'search_query_requires_indexed_terms',
        };
      }
      if (workload && Number(workload.bytes) > MAX_SHORT_HAN_SEARCH_BYTES) {
        return {
          items: [],
          nextBeforeId: null,
          totalMatches: null,
          droppedConversations: this.#persistentConversationDroppedCount(),
          error: 'search_query_requires_indexed_terms',
        };
      }
      const totalMatches = this.#conversationMatchCount(filters, plan);
      const textSelect = plan.useFts || plan.useTrigram
        ? `
            snippet(${plan.searchTable}, 0, '', '', '…', 32) AS prompt_snippet,
            snippet(${plan.searchTable}, 1, '', '', '…', 32) AS response_snippet
          `
        : `
            substr(t.prompt_text, 1, 4096) AS prompt_snippet,
            substr(t.response_text, 1, 4096) AS response_snippet
          `;
      const sql = `
        SELECT
          t.id,
          m.started_at_ms,
          m.device_id,
          m.machine_id,
          m.member_label,
          m.account_id,
          m.account_alias,
          m.model,
          m.status_code,
          m.outcome,
          substr(t.prompt_text, 1, ${MAX_PROMPT_BYTES}) AS prompt_text,
          t.prompt_bytes,
          t.prompt_source,
          t.prompt_suffix_omitted,
          t.response_state,
          t.response_bytes,
          ${textSelect}
        FROM conversation_turns t
        JOIN request_metrics m ON m.id = t.request_metrics_id
        ${plan.useFts || plan.useTrigram
          ? `JOIN ${plan.searchTable} ON ${plan.searchTable}.rowid = t.id`
          : ''}
        ${conversationSearchFilterSql(plan, { includeBefore: true })}
        ORDER BY t.id DESC
        LIMIT ?
      `;
      const params = [
        ...conversationSearchFilterParams(filters, plan, { includeBefore: true }),
        filters.limit,
      ];
      const rows = this.db.prepare(sql).all(...params);
      const items = rows.map((row) => ({
        id: Number(row.id),
        startedAtMs: Number(row.started_at_ms),
        deviceId: row.device_id,
        machineId: row.machine_id ?? null,
        memberLabel: row.member_label,
        accountId: row.account_id,
        accountAlias: row.account_alias,
        model: row.model ?? null,
        statusCode: row.status_code === null ? null : Number(row.status_code),
        outcome: row.outcome,
        promptText: clipConversationText(row.prompt_text, MAX_PROMPT_BYTES),
        promptBytes: Number(row.prompt_bytes),
        promptSource: row.prompt_source,
        promptSuffixOmitted: Boolean(row.prompt_suffix_omitted),
        responseState: row.response_state,
        responseBytes: Number(row.response_bytes),
        promptSnippet: clipConversationText(row.prompt_snippet, MAX_SEARCH_SNIPPET_BYTES),
        responseSnippet: clipConversationText(row.response_snippet, MAX_SEARCH_SNIPPET_BYTES),
      }));
      return {
        items,
        nextBeforeId: items.length === filters.limit ? items.at(-1).id : null,
        totalMatches,
        droppedConversations: this.#persistentConversationDroppedCount(),
        error: null,
      };
    } catch (error) {
      this.#safeLog('conversation_search_failed', { code: error.code ?? error.name ?? 'unknown' });
      return {
        items: [],
        nextBeforeId: null,
        totalMatches: null,
        droppedConversations: this.#persistentConversationDroppedCount(),
        error: 'search_unavailable',
      };
    }
  }

  searchConversationSessions(options = {}) {
    try {
      this.#assertOpen();
      const filters = normalizeConversationSearch(options);
      const standaloneCount = this.#persistentStandaloneConversationCount();
      if (filters.emptyLiteralQuery) {
        return {
          items: [],
          nextBeforeId: null,
          totalMatches: 0,
          droppedConversations: this.#persistentConversationDroppedCount(),
          standaloneCount,
          error: null,
        };
      }
      const plan = conversationSearchPlan(filters);
      const workload = plan.useSubstring ? this.#conversationSearchWorkload() : null;
      if (workload && Number(workload.count) > MAX_SHORT_HAN_SEARCH_ROWS) {
        return {
          items: [],
          nextBeforeId: null,
          totalMatches: null,
          droppedConversations: this.#persistentConversationDroppedCount(),
          standaloneCount,
          error: filters.shortHanQuery ? 'search_query_too_short' : 'search_query_requires_indexed_terms',
        };
      }
      if (workload && Number(workload.bytes) > MAX_SHORT_HAN_SEARCH_BYTES) {
        return {
          items: [],
          nextBeforeId: null,
          totalMatches: null,
          droppedConversations: this.#persistentConversationDroppedCount(),
          standaloneCount,
          error: 'search_query_requires_indexed_terms',
        };
      }

      const matchSql = conversationSessionMatchSql(plan);
      const matchParams = conversationSearchFilterParams(filters, plan);
      const totalMatches = Number(this.db.prepare(`
        SELECT COUNT(*) AS total_matches
        FROM conversation_sessions s
        WHERE s.id IN (${matchSql})
      `).get(...matchParams).total_matches);
      const rows = this.db.prepare(`
        WITH matched_sessions AS (${matchSql}),
        ranked_turns AS (
          SELECT
            t.conversation_session_id AS id,
            COUNT(*) OVER (PARTITION BY t.conversation_session_id) AS turn_count,
            MIN(m.started_at_ms) OVER (PARTITION BY t.conversation_session_id)
              AS first_started_at_ms,
            MAX(m.started_at_ms) OVER (PARTITION BY t.conversation_session_id)
              AS last_started_at_ms,
            m.device_id AS latest_device_id,
            m.machine_id AS latest_machine_id,
            m.member_label AS latest_member_label,
            m.account_id AS latest_account_id,
            m.account_alias AS latest_account_alias,
            m.model AS latest_model,
            substr(t.prompt_text, 1, ${MAX_SEARCH_SNIPPET_BYTES}) AS latest_prompt_snippet,
            t.prompt_source AS latest_prompt_source,
            t.prompt_suffix_omitted AS latest_prompt_suffix_omitted,
            substr(t.response_text, 1, ${MAX_SEARCH_SNIPPET_BYTES}) AS latest_response_snippet,
            t.response_state AS latest_response_state,
            ROW_NUMBER() OVER (
              PARTITION BY t.conversation_session_id
              ORDER BY t.turn_index DESC, t.id DESC
            ) AS latest_rank
          FROM conversation_turns t
          JOIN request_metrics m ON m.id = t.request_metrics_id
          WHERE t.conversation_session_id IN (
            SELECT conversation_session_id FROM matched_sessions
          )
        )
        SELECT *
        FROM ranked_turns
        WHERE latest_rank = 1
          AND (? IS NULL OR id < ?)
        ORDER BY id DESC
        LIMIT ?
      `).all(...matchParams, filters.beforeId, filters.beforeId, filters.limit);
      const items = rows.map((row) => ({
        id: Number(row.id),
        turnCount: Number(row.turn_count),
        firstStartedAtMs: Number(row.first_started_at_ms),
        lastStartedAtMs: Number(row.last_started_at_ms),
        deviceId: row.latest_device_id,
        machineId: row.latest_machine_id ?? null,
        memberLabel: row.latest_member_label,
        accountId: row.latest_account_id,
        accountAlias: row.latest_account_alias,
        model: row.latest_model ?? null,
        latestPromptSnippet: clipConversationText(
          row.latest_prompt_snippet,
          MAX_SEARCH_SNIPPET_BYTES,
        ),
        latestPromptSource: row.latest_prompt_source,
        latestPromptSuffixOmitted: Boolean(row.latest_prompt_suffix_omitted),
        latestResponseSnippet: clipConversationText(
          row.latest_response_snippet,
          MAX_SEARCH_SNIPPET_BYTES,
        ),
        latestResponseState: row.latest_response_state,
      }));
      return {
        items,
        nextBeforeId: items.length === filters.limit ? items.at(-1).id : null,
        totalMatches,
        droppedConversations: this.#persistentConversationDroppedCount(),
        standaloneCount,
        error: null,
      };
    } catch (error) {
      this.#safeLog('conversation_session_search_failed', {
        code: error.code ?? error.name ?? 'unknown',
      });
      return {
        items: [],
        nextBeforeId: null,
        totalMatches: null,
        droppedConversations: this.#persistentConversationDroppedCount(),
        standaloneCount: this.#persistentStandaloneConversationCount(),
        error: 'search_unavailable',
      };
    }
  }

  readConversation(id) {
    try {
      this.#assertOpen();
      const normalizedId = finiteInteger(id, 'conversation id', { minimum: 1 });
      const row = this.db.prepare(`
        SELECT
          t.id,
          m.started_at_ms,
          m.device_id,
          m.machine_id,
          m.member_label,
          m.account_id,
          m.account_alias,
          m.model,
          m.stream,
          m.status_code,
          m.outcome,
          m.ttfb_ms,
          m.duration_ms,
          m.request_bytes,
          m.response_bytes,
          t.prompt_text,
          t.prompt_bytes,
          t.prompt_source,
          t.prompt_suffix_omitted,
          t.response_text,
          t.response_state,
          t.response_bytes AS stored_response_bytes
        FROM conversation_turns t
        JOIN request_metrics m ON m.id = t.request_metrics_id
        WHERE t.id = ?
      `).get(normalizedId);
      if (!row) return { turn: null, error: null };
      return {
        turn: {
          id: Number(row.id),
          startedAtMs: Number(row.started_at_ms),
          deviceId: row.device_id,
          machineId: row.machine_id ?? null,
          memberLabel: row.member_label,
          accountId: row.account_id,
          accountAlias: row.account_alias,
          model: row.model ?? null,
          stream: row.stream === null ? null : Boolean(row.stream),
          statusCode: row.status_code === null ? null : Number(row.status_code),
          outcome: row.outcome,
          ttfbMs: row.ttfb_ms === null ? null : Number(row.ttfb_ms),
          durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
          requestBytes: Number(row.request_bytes),
          responseBytes: Number(row.response_bytes),
          promptText: clipConversationText(row.prompt_text, MAX_PROMPT_BYTES),
          promptBytes: Number(row.prompt_bytes),
          promptSource: row.prompt_source,
          promptSuffixOmitted: Boolean(row.prompt_suffix_omitted),
          responseText: clipConversationText(row.response_text, MAX_READ_CONVERSATION_BYTES),
          responseState: row.response_state,
          responseBytesStored: Number(row.stored_response_bytes),
        },
        error: null,
      };
    } catch (error) {
      this.#safeLog('conversation_read_failed', { code: error.code ?? error.name ?? 'unknown' });
      return { turn: null, error: 'conversation_unavailable' };
    }
  }

  readConversationSession(id) {
    try {
      this.#assertOpen();
      const normalizedId = finiteInteger(id, 'conversation session id', { minimum: 1 });
      const session = this.db.prepare(`
        SELECT
          s.id,
          COUNT(t.id) AS turn_count,
          MIN(m.started_at_ms) AS first_started_at_ms,
          MAX(m.started_at_ms) AS last_started_at_ms
        FROM conversation_sessions s
        LEFT JOIN conversation_turns t ON t.conversation_session_id = s.id
        LEFT JOIN request_metrics m ON m.id = t.request_metrics_id
        WHERE s.id = ?
        GROUP BY s.id
      `).get(normalizedId);
      if (!session) {
        return {
          session: null,
          standaloneCount: this.#persistentStandaloneConversationCount(),
          error: null,
        };
      }
      const budgetRows = this.db.prepare(`
        SELECT
          t.id,
          t.turn_index,
          SUM(t.prompt_bytes + t.response_bytes) OVER (
            ORDER BY t.turn_index ASC, t.id ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumulative_bytes
        FROM conversation_turns t
        WHERE t.conversation_session_id = ?
        ORDER BY t.turn_index ASC, t.id ASC
        LIMIT ?
      `).all(normalizedId, MAX_CONVERSATION_SESSION_TURNS + 1);
      const selectedIds = [];
      for (const row of budgetRows) {
        if (selectedIds.length >= MAX_CONVERSATION_SESSION_TURNS) break;
        if (Number(row.cumulative_bytes) > MAX_CONVERSATION_SESSION_BYTES) break;
        selectedIds.push(Number(row.id));
      }
      const placeholders = selectedIds.map(() => '?').join(', ');
      const rows = selectedIds.length === 0 ? [] : this.db.prepare(`
        SELECT
          t.id,
          t.conversation_session_id,
          t.turn_index,
          m.started_at_ms,
          m.device_id,
          m.machine_id,
          m.member_label,
          m.account_id,
          m.account_alias,
          m.model,
          m.stream,
          m.status_code,
          m.outcome,
          m.ttfb_ms,
          m.duration_ms,
          m.request_bytes,
          m.response_bytes,
          t.prompt_text,
          t.prompt_bytes,
          t.prompt_source,
          t.prompt_suffix_omitted,
          substr(t.response_text, 1, ${MAX_CONVERSATION_SESSION_RESPONSE_CHARS})
            AS response_display_text,
          CASE WHEN length(t.response_text) > ${MAX_CONVERSATION_SESSION_RESPONSE_CHARS}
            THEN 1 ELSE 0 END AS response_display_truncated,
          t.response_state,
          t.response_bytes AS stored_response_bytes
        FROM conversation_turns t
        JOIN request_metrics m ON m.id = t.request_metrics_id
        WHERE t.conversation_session_id = ?
          AND t.id IN (${placeholders})
        ORDER BY t.turn_index ASC, t.id ASC
      `).all(normalizedId, ...selectedIds);
      const standaloneCount = this.#persistentStandaloneConversationCount();
      const turns = rows.map((row) => ({
        id: Number(row.id),
        conversationSessionId: Number(row.conversation_session_id),
        turnIndex: Number(row.turn_index),
        startedAtMs: Number(row.started_at_ms),
        deviceId: row.device_id,
        machineId: row.machine_id ?? null,
        memberLabel: row.member_label,
        accountId: row.account_id,
        accountAlias: row.account_alias,
        model: row.model ?? null,
        stream: row.stream === null ? null : Boolean(row.stream),
        statusCode: row.status_code === null ? null : Number(row.status_code),
        outcome: row.outcome,
        ttfbMs: row.ttfb_ms === null ? null : Number(row.ttfb_ms),
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        requestBytes: Number(row.request_bytes),
        responseBytes: Number(row.response_bytes),
        promptText: clipConversationText(row.prompt_text, MAX_PROMPT_BYTES),
        promptBytes: Number(row.prompt_bytes),
        promptSource: row.prompt_source,
        promptSuffixOmitted: Boolean(row.prompt_suffix_omitted),
        responseText: clipConversationText(row.response_display_text, MAX_READ_CONVERSATION_BYTES),
        responseDisplayTruncated: Boolean(row.response_display_truncated),
        responseState: row.response_state,
        responseBytesStored: Number(row.stored_response_bytes),
      }));
      return {
        session: {
          id: Number(session.id),
          turnCount: Number(session.turn_count),
          firstStartedAtMs: Number(session.first_started_at_ms),
          lastStartedAtMs: Number(session.last_started_at_ms),
          turns,
          displayedTurnCount: turns.length,
          maxDisplayedTurns: MAX_CONVERSATION_SESSION_TURNS,
          maxDisplayedBytes: MAX_CONVERSATION_SESSION_BYTES,
          truncated: Number(session.turn_count) > turns.length,
          standaloneCount,
        },
        standaloneCount,
        error: null,
      };
    } catch (error) {
      this.#safeLog('conversation_session_read_failed', {
        code: error.code ?? error.name ?? 'unknown',
      });
      return {
        session: null,
        standaloneCount: this.#persistentStandaloneConversationCount(),
        error: 'conversation_unavailable',
      };
    }
  }

  integrityCheck() {
    this.#assertOpen();
    const result = this.db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0]?.integrity_check !== 'ok') {
      const error = new Error('metrics database integrity check failed');
      error.result = result;
      throw error;
    }
    for (const table of CONVERSATION_FTS_TABLES) {
      if (!sqliteObjectExists(this.db, 'table', table)) {
        throw new Error(`conversation FTS integrity check failed: ${table} is missing`);
      }
      try {
        this.db.prepare(
          `INSERT INTO ${table}(${table}) VALUES ('integrity-check')`,
        ).run();
      } catch (error) {
        const ftsError = new Error(`conversation FTS integrity check failed: ${table}`);
        ftsError.cause = error;
        throw ftsError;
      }
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
    while (this.queue.length > 0 || this.conversationQueue.length > 0) {
      const pendingBefore = this.queue.length + this.conversationQueue.length;
      const result = this.flush();
      flushResult = {
        queued: flushResult.queued + result.queued,
        written: flushResult.written + result.written,
        dropped: flushResult.dropped + result.dropped,
        failed: flushResult.failed + result.failed,
      };
      if (this.queue.length + this.conversationQueue.length >= pendingBefore) break;
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
    if (this.conversationQueue.length > 0) {
      const dropped = this.conversationQueue.splice(0).length;
      this.conversationQueueBytes = 0;
      this.stats.conversation.dropped += dropped;
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
