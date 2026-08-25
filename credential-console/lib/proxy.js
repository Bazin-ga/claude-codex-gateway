import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { Transform } from 'node:stream';
import { sendJson } from './http.js';
import { deviceToken } from './device-auth.js';
import { createRequestMetadataTee, REQUEST_METADATA_PREFIX_BYTES } from './request-metadata.js';
import { createCaptureBudget, CAPTURE_MEMORY_AMPLIFICATION } from './capture-budget.js';
import { displayPromptText } from './prompt-display.js';
import { CLAUDE_SESSION_ID_PATTERN } from './store.js';
import {
  createCompositeResponseObserver,
  createResponseObservationTee,
} from './response-observation.js';
import {
  RESPONSE_CONTENT_MAX_BYTES,
  createResponseContentAssembler,
} from './response-content.js';
import { createResponseUsageParser } from './response-usage.js';

const ALLOWED_PATHS = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/models',
]);
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
// Shared across every in-flight request in this process: a per-request limit
// bounds one capture, not the sum of them.
export const captureBudget = createCaptureBudget();
// Cap one capture at what the shared pool could ever admit. Allowing a larger
// prefix does not capture anything extra — a body over this size drains the
// whole pool chunk by chunk, is refused near the end, discards what it built,
// and blocks every concurrent capture while it does so.
export const CONVERSATION_PREFIX_BYTES = Math.min(
  MAX_REQUEST_BYTES,
  Math.floor(captureBudget.maxBytes() / CAPTURE_MEMORY_AMPLIFICATION),
);
export const AUTH_FAILURE_LIMIT = { windowMs: 60_000, max: 30 };
export const DEVICE_REQUEST_LIMIT = { windowMs: 60_000, max: 120 };
export const DEVICE_CONCURRENCY_LIMIT = 8;
export const authFailures = new Map();
export const deviceRequests = new Map();
export const deviceConcurrency = new Map();

export function passthroughCounter({ maxBytes = null } = {}) {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (maxBytes !== null && bytes > maxBytes) {
        const error = new Error('request body too large');
        error.code = 'ERR_REQUEST_BODY_TOO_LARGE';
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
  return { stream, bytes: () => bytes };
}

export function unavailableUsage() {
  return {
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    usageState: 'unavailable',
  };
}

export function responseUsageFormat(contentType) {
  const mediaType = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'text/event-stream') return 'sse';
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json';
  return null;
}

export function usageObserver(parser) {
  return {
    write(chunk) {
      const state = parser.push(chunk).parseState;
      return !['invalid', 'limit', 'truncated'].includes(state);
    },
    end() { parser.finish(); },
    abort() { parser.finish({ truncated: true }); },
    snapshot() { return parser.snapshot(); },
  };
}

export function safeUsageSnapshot(observation) {
  let snapshot;
  try {
    snapshot = observation?.snapshot?.();
  } catch {
    return unavailableUsage();
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return unavailableUsage();
  }
  const token = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const usage = {
    inputTokens: token(snapshot.inputTokens),
    cacheCreationInputTokens: token(snapshot.cacheCreationInputTokens),
    cacheReadInputTokens: token(snapshot.cacheReadInputTokens),
    outputTokens: token(snapshot.outputTokens),
    usageState: ['unavailable', 'partial', 'complete'].includes(snapshot.usageState)
      ? snapshot.usageState
      : 'unavailable',
  };
  const known = [
    usage.inputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
    usage.outputTokens,
  ].some((value) => value !== null);
  if (!known) return unavailableUsage();
  if (usage.usageState === 'complete'
    && (usage.inputTokens === null || usage.outputTokens === null)) {
    usage.usageState = 'partial';
  } else if (usage.usageState === 'unavailable') {
    usage.usageState = 'partial';
  }
  return usage;
}

export function safeConversationResponse(observation) {
  let snapshot;
  try {
    snapshot = observation?.snapshot?.();
  } catch {
    return { responseText: '', responseState: 'unavailable', responseBytes: 0 };
  }
  if (!snapshot || typeof snapshot.text !== 'string') {
    return { responseText: '', responseState: 'unavailable', responseBytes: 0 };
  }
  const responseBytes = Buffer.byteLength(snapshot.text, 'utf8');
  if (responseBytes > RESPONSE_CONTENT_MAX_BYTES) {
    return { responseText: '', responseState: 'unavailable', responseBytes: 0 };
  }
  const unavailableReasons = new Set([
    'global_budget',
    'unsupported_encoding',
    'decode_error',
    'invalid_utf8',
    'invalid_text',
    'protocol_invalid',
    'observer_write_error',
    'observer_end_error',
  ]);
  const limitReasons = new Set(['raw_limit', 'decoded_limit']);
  let responseState = 'incomplete';
  if (snapshot.truncated === true || limitReasons.has(snapshot.reason)) responseState = 'truncated';
  else if (unavailableReasons.has(snapshot.reason)) responseState = 'unavailable';
  else if (snapshot.status === 'complete') responseState = 'complete';
  return { responseText: snapshot.text, responseState, responseBytes };
}

function claudeSessionId(headers) {
  const value = headers?.['x-claude-code-session-id'];
  return typeof value === 'string' && CLAUDE_SESSION_ID_PATTERN.test(value)
    ? value
    : null;
}

export function threadKeyForRequest(store, deviceId, sessionId) {
  if (!sessionId) return null;
  const derive = typeof store?.threadKeyForSession === 'function'
    ? store.threadKeyForSession
    : store?.conversationThreadKey;
  if (typeof derive !== 'function') return null;
  try {
    const threadKey = derive.call(store, { version: 1, deviceId, sessionId });
    return typeof threadKey === 'string' && /^[0-9a-f]{64}$/.test(threadKey)
      ? threadKey
      : null;
  } catch {
    // Invalid client correlation input must degrade to an ungrouped turn.  In
    // particular, never put the rejected session id into a log line.
    return null;
  }
}

export function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

export function enqueueMetricSafely(requestMetrics, row, { accountId, deviceId, conversation = null }) {
  if (!requestMetrics?.enqueueRequest && !requestMetrics?.enqueueCompletion) return;
  try {
    const result = conversation && typeof requestMetrics.enqueueCompletion === 'function'
      ? requestMetrics.enqueueCompletion({ metrics: row, conversation })
      : requestMetrics.enqueueRequest?.(row);
    if (result && typeof result.then === 'function') {
      result.catch((error) => log('metrics_enqueue_failed', {
        account_id: accountId,
        device_id: deviceId,
        code: error?.code ?? error?.name ?? 'unknown',
      }));
    }
  } catch (error) {
    log('metrics_enqueue_failed', {
      account_id: accountId,
      device_id: deviceId,
      code: error?.code ?? error?.name ?? 'unknown',
    });
  }
}

export function sourceIp(req) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return peer;
  return String(req.headers['x-forwarded-for'] ?? peer).split(',')[0].trim();
}

export function rateLimited(bucket, key, limit) {
  const now = Date.now();
  const record = bucket.get(key);
  if (!record || now - record.since > limit.windowMs) {
    bucket.set(key, { since: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > limit.max;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of authFailures) {
    if (now - record.since > AUTH_FAILURE_LIMIT.windowMs) authFailures.delete(key);
  }
  for (const [key, record] of deviceRequests) {
    if (now - record.since > DEVICE_REQUEST_LIMIT.windowMs) deviceRequests.delete(key);
  }
}, 60_000).unref();

function forwardHeaders(headers) {
  const allowed = [
    'accept',
    'accept-encoding',
    'anthropic-beta',
    'anthropic-version',
    'content-length',
    'content-type',
    'user-agent',
    'x-claude-code-agent-id',
    'x-claude-code-parent-agent-id',
    'x-claude-code-session-id',
  ];
  return Object.fromEntries(
    allowed
      .filter((name) => headers[name] !== undefined)
      .map((name) => [name, headers[name]]),
  );
}

function responseHeaders(headers) {
  const allowed = [
    'content-encoding',
    'content-type',
    'request-id',
    'retry-after',
    'x-request-id',
  ];
  return Object.fromEntries(
    allowed
      .filter((name) => headers[name] !== undefined)
      .map((name) => [name, headers[name]]),
  );
}

export async function handleClaudeProxy(req, res, {
  store,
  upstreamBaseUrl = 'https://api.anthropic.com',
  requestMetrics = null,
  metadataTeeFactory = createRequestMetadataTee,
  responseObservationFactory = createResponseObservationTee,
  responseUsageParserFactory = createResponseUsageParser,
  responseContentAssemblerFactory = createResponseContentAssembler,
}) {
  const requestUrl = new URL(req.url, 'https://credential-console.invalid');
  const upstreamPath = requestUrl.pathname.slice('/claude'.length);
  if ((req.method === 'GET' || req.method === 'HEAD') && upstreamPath === '/api/hello') {
    sendJson(res, 200, { message: 'hello' });
    return;
  }

  const token = deviceToken(req);
  const device = token ? store.deviceByToken(token) : null;
  if (!device) {
    const ip = sourceIp(req);
    if (rateLimited(authFailures, ip, AUTH_FAILURE_LIMIT)) {
      log('claude_proxy_auth_rate_limited', { ip });
      sendJson(
        res,
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'too many authentication failures' } },
        { 'Retry-After': '60' },
      );
      return;
    }
    log('claude_proxy_auth_failed', { ip });
    sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'unauthorized' } });
    return;
  }

  const authenticatedAtMs = Date.now();
  const authenticatedAtMonotonic = performance.now();
  let accountId = device.account_id;
  let account = null;
  let accountResolutionError = null;
  try {
    if (typeof store.resolveDeviceAccount === 'function') {
      const resolved = store.resolveDeviceAccount(device);
      accountId = resolved.effective_account_id;
      account = resolved.account;
    } else {
      account = store.accountById(device.account_id);
    }
  } catch (error) {
    accountResolutionError = error;
    if (typeof device.selected_account_id === 'string' && device.selected_account_id) {
      accountId = device.selected_account_id;
    }
  }
  const recordRejected = (statusCode, outcome = 'rejected') => {
    enqueueMetricSafely(requestMetrics, {
      startedAtMs: authenticatedAtMs,
      method: req.method ?? 'UNKNOWN',
      path: upstreamPath,
      deviceId: device.id,
      machineId: device.machine_id ?? null,
      memberLabel: device.member_label,
      accountId,
      accountAlias: account?.alias ?? 'unavailable',
      model: null,
      stream: null,
      statusCode,
      outcome,
      ttfbMs: null,
      durationMs: Math.max(0, Math.round(performance.now() - authenticatedAtMonotonic)),
      requestBytes: 0,
      responseBytes: 0,
      upstreamRequestId: null,
      ...unavailableUsage(),
    }, { accountId, deviceId: device.id });
  };
  if (accountResolutionError) {
    log('claude_proxy_device_account_invalid', {
      device_id: device.id,
      account_id: accountId,
      code: accountResolutionError.code ?? accountResolutionError.name ?? 'unknown',
    });
    recordRejected(503);
    sendJson(res, 503, {
      type: 'error',
      error: { type: 'api_error', message: 'device account configuration unavailable' },
    });
    return;
  }
  if (!account || account.provider !== 'claude' || account.status === 'disabled') {
    recordRejected(403);
    sendJson(res, 403, { type: 'error', error: { type: 'permission_error', message: 'account unavailable' } });
    return;
  }
  if (account.expires_at && Date.parse(account.expires_at) <= Date.now()) {
    recordRejected(503);
    sendJson(res, 503, { type: 'error', error: { type: 'authentication_error', message: 'account credential expired' } });
    return;
  }

  if (!ALLOWED_PATHS.has(upstreamPath)) {
    recordRejected(404);
    sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'unsupported gateway path' } });
    return;
  }

  let credential;
  try {
    credential = store.accountCredential(account.id);
  } catch (error) {
    log('claude_proxy_credential_decrypt_failed', {
      account_id: account.id,
      device_id: device.id,
      error: error.message,
    });
    recordRejected(503);
    sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: 'credential unavailable' } });
    return;
  }
  if (!credential?.oauth_token) {
    recordRejected(503);
    sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: 'account login required' } });
    return;
  }

  if (rateLimited(deviceRequests, device.id, DEVICE_REQUEST_LIMIT)) {
    log('claude_proxy_device_rate_limited', { device_id: device.id });
    recordRejected(429);
    sendJson(
      res,
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'device request limit exceeded' } },
      { 'Retry-After': '60' },
    );
    return;
  }
  const activeRequests = deviceConcurrency.get(device.id) ?? 0;
  if (activeRequests >= DEVICE_CONCURRENCY_LIMIT) {
    log('claude_proxy_device_concurrency_limited', { device_id: device.id, active: activeRequests });
    recordRejected(429);
    sendJson(
      res,
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'device concurrency limit exceeded' } },
      { 'Retry-After': '1' },
    );
    return;
  }
  deviceConcurrency.set(device.id, activeRequests + 1);
  let concurrencyReleased = false;
  const releaseConcurrency = () => {
    if (concurrencyReleased) return;
    concurrencyReleased = true;
    const remaining = (deviceConcurrency.get(device.id) ?? 1) - 1;
    if (remaining > 0) deviceConcurrency.set(device.id, remaining);
    else deviceConcurrency.delete(device.id);
  };
  res.once('finish', releaseConcurrency);
  res.once('close', releaseConcurrency);

  const upstream = new URL(`${upstreamPath}${requestUrl.search}`, upstreamBaseUrl);
  const transport = upstream.protocol === 'http:' ? http : https;
  const headers = {
    ...forwardHeaders(req.headers),
    authorization: `Bearer ${credential.oauth_token}`,
    host: upstream.host,
  };
  delete headers['x-api-key'];
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    recordRejected(413, 'request_too_large');
    res.once('finish', () => {
      if (!req.destroyed) req.destroy();
    });
    sendJson(
      res,
      413,
      { type: 'error', error: { type: 'invalid_request_error', message: 'request body too large' } },
      { Connection: 'close' },
    );
    return;
  }

  const startedAtMs = Date.now();
  const startedAtMonotonic = performance.now();
  const capturePrompt = upstreamPath === '/v1/messages';
  const requestMetadata = metadataTeeFactory({
    capturePrompt,
    // Only pay the buffering cost where a prompt can actually be extracted.
    prefixLimit: capturePrompt ? CONVERSATION_PREFIX_BYTES : REQUEST_METADATA_PREFIX_BYTES,
    budget: captureBudget,
  });
  // Piping does not tell the tee that its source died; without this an aborted
  // upload keeps its share of the shared pool forever.
  requestMetadata.trackSource(req);
  const requestLimit = passthroughCounter({ maxBytes: MAX_REQUEST_BYTES });
  // The request body still streams to the upstream exactly as before; this
  // Transform only records a side-copy so a transient upstream overload
  // (HTTP 529/503) can be replayed without re-reading the client.
  const bodyChunks = [];
  const bodyAccumulator = new Transform({
    transform(chunk, encoding, callback) {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback(null, chunk);
    },
  });
  const RETRYABLE_UPSTREAM_STATUS = new Set([529, 503]);
  const MAX_UPSTREAM_ATTEMPTS = 3;
  const RETRY_BASE_DELAY_MS = 250;
  const RETRY_MAX_DELAY_MS = 5000;
  let responseObservation = null;
  let responseUsageFinished = true;
  let upstreamTtfbMs = null;
  let upstreamStatus = null;
  let upstreamRequestId = null;
  let upstreamEnded = false;
  let activeUpstreamRes = null;
  let clientAborted = false;
  let metricFinalized = false;
  let pendingOutcome = null;
  let requestBodyFinished = false;
  let responseFinished = false;
  let currentUpstreamReq = null;
  let retryTimer = null;
  let attemptsUsed = 0;
  let retryBackoffMs = RETRY_BASE_DELAY_MS;

  const nextRetryDelayMs = (retryAfterHeader) => {
    const backoff = retryBackoffMs;
    retryBackoffMs = Math.min(retryBackoffMs * 2, RETRY_MAX_DELAY_MS);
    if (typeof retryAfterHeader === 'string' && /^\s*\d+\s*$/.test(retryAfterHeader)) {
      const seconds = Number(retryAfterHeader.trim());
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
      }
    }
    return backoff;
  };

  const cancelPendingRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const finalizeMetric = (outcome, statusCode = upstreamStatus) => {
    if (metricFinalized) return;
    metricFinalized = true;
    if (outcome !== 'completed') responseObservation?.abort?.(outcome);
    let metadata = {
      requestBytes: requestLimit.bytes(),
      model: null,
      stream: null,
    };
    try {
      metadata = { ...metadata, ...requestMetadata.snapshot() };
    } catch (error) {
      log('request_metadata_snapshot_failed', {
        account_id: account.id,
        device_id: device.id,
        code: error?.code ?? error?.name ?? 'unknown',
      });
    }
    const metricRow = {
      startedAtMs,
      method: req.method ?? 'UNKNOWN',
      path: upstreamPath,
      deviceId: device.id,
      machineId: device.machine_id ?? null,
      memberLabel: device.member_label,
      accountId: account.id,
      accountAlias: account.alias,
      model: metadata.model ?? null,
      stream: typeof metadata.stream === 'boolean' ? metadata.stream : null,
      statusCode: Number.isInteger(statusCode) ? statusCode : null,
      outcome,
      ttfbMs: upstreamTtfbMs,
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      requestBytes: Number.isSafeInteger(metadata.requestBytes)
        ? metadata.requestBytes
        : requestLimit.bytes(),
      responseBytes: responseObservation?.bytes?.() ?? 0,
      upstreamRequestId,
      ...safeUsageSnapshot(responseObservation),
    };
    let conversation = null;
    if (upstreamPath === '/v1/messages'
      && typeof requestMetrics?.enqueueCompletion === 'function') {
      try {
        const prompt = requestMetadata.conversationCandidate?.();
        if (prompt?.promptText) {
          const sessionId = claudeSessionId(req.headers);
          const display = displayPromptText(prompt.promptText, {
            // Only a validated Claude Code correlation header establishes that
            // the line-based root is a client envelope on new traffic. Legacy
            // rows use the same strict structural rule at presentation time.
            allowWrapperRemoval: sessionId !== null,
          });
          conversation = {
            promptText: display.text,
            promptBytes: Buffer.byteLength(display.text, 'utf8'),
            promptSource: display.source,
            promptSuffixOmitted: display.suffixOmitted,
            threadKey: threadKeyForRequest(store, device.id, sessionId),
            ...safeConversationResponse(responseObservation),
          };
        }
      } catch (error) {
        log('conversation_capture_failed', {
          account_id: account.id,
          device_id: device.id,
          code: error?.code ?? error?.name ?? 'unknown',
        });
      }
    }
    enqueueMetricSafely(requestMetrics, metricRow, {
      accountId: account.id,
      deviceId: device.id,
      conversation,
    });
  };

  const finalizeCompletedWhenReady = () => {
    if (!responseFinished || !requestBodyFinished || !responseUsageFinished || metricFinalized) return;
    finalizeMetric(pendingOutcome ?? 'completed', res.statusCode);
  };

  const sendUpstream = (bodyBuffer) => {
    if (clientAborted || metricFinalized) return undefined;
    attemptsUsed += 1;
    let attemptSettled = false;

    const upstreamReq = transport.request(
      upstream,
      {
        method: req.method,
        headers: bodyBuffer
          ? { ...headers, 'content-length': String(bodyBuffer.length) }
          : headers,
        timeout: 10 * 60_000,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;

        if (RETRYABLE_UPSTREAM_STATUS.has(status)
          && attemptsUsed < MAX_UPSTREAM_ATTEMPTS
          && requestBodyFinished
          && !clientAborted) {
          log('claude_proxy_upstream_retry', {
            account_id: account.id,
            device_id: device.id,
            status,
            attempt: attemptsUsed,
          });
          upstreamRes.resume();
          upstreamRes.once('error', () => {});
          upstreamRes.once('end', () => {
            if (clientAborted || metricFinalized) return;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              sendUpstream(bodyBuffer ?? Buffer.concat(bodyChunks));
            }, nextRetryDelayMs(upstreamRes.headers['retry-after']));
            if (typeof retryTimer.unref === 'function') retryTimer.unref();
          });
          return;
        }

        attemptSettled = true;
        activeUpstreamRes = upstreamRes;
        upstreamTtfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));
        upstreamStatus = status;
        const requestId = upstreamRes.headers['request-id'] ?? upstreamRes.headers['x-request-id'];
        upstreamRequestId = typeof requestId === 'string' ? requestId : null;
        res.writeHead(status, {
          ...responseHeaders(upstreamRes.headers),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        const responseFormat = upstreamPath === '/v1/messages' && status >= 200 && status < 400
          ? responseUsageFormat(upstreamRes.headers['content-type'])
          : null;
        const observers = [];
        if (responseFormat && requestMetrics?.enqueueRequest) {
          try {
            observers.push(usageObserver(responseUsageParserFactory({ format: responseFormat })));
          } catch (error) {
            log('response_usage_parser_init_failed', {
              account_id: account.id,
              device_id: device.id,
              code: error?.code ?? error?.name ?? 'unknown',
            });
          }
        }
        if (responseFormat && typeof requestMetrics?.enqueueCompletion === 'function') {
          try {
            observers.push(responseContentAssemblerFactory({ format: responseFormat }));
          } catch (error) {
            log('response_content_parser_init_failed', {
              account_id: account.id,
              device_id: device.id,
              code: error?.code ?? error?.name ?? 'unknown',
            });
          }
        }
        const observer = observers.length
          ? createCompositeResponseObserver(observers)
          : null;
        responseUsageFinished = false;
        try {
          responseObservation = responseObservationFactory({
            contentEncoding: upstreamRes.headers['content-encoding'],
            observer,
          });
        } catch (error) {
          log('response_observation_init_failed', {
            account_id: account.id,
            device_id: device.id,
            code: error?.code ?? error?.name ?? 'unknown',
          });
          responseObservation = createResponseObservationTee();
        }
        Promise.resolve(responseObservation.done).then(
          () => {
            responseUsageFinished = true;
            finalizeCompletedWhenReady();
          },
          () => {
            responseUsageFinished = true;
            finalizeCompletedWhenReady();
          },
        );
        upstreamRes.pipe(responseObservation.stream).pipe(res);
        upstreamRes.on('end', () => {
          upstreamEnded = true;
          store.markDeviceSeen(device.id).catch(() => {});
          if (status >= 200 && status < 400) {
            store.updateAccountHealth(account.id, { success: true }).catch(() => {});
          } else if (status === 401 || status === 403) {
            store.updateAccountHealth(account.id, {
              success: false,
              error: `upstream authentication failed (${status})`,
            }).catch(() => {});
          }
        });

        const failResponse = (error) => {
          if (upstreamEnded || clientAborted || metricFinalized
            || pendingOutcome === 'upstream_error_after_headers') return;
          pendingOutcome = 'upstream_error_after_headers';
          log('claude_proxy_failed', {
            account_id: account.id,
            device_id: device.id,
            code: error?.code ?? error?.name ?? 'upstream_response_incomplete',
            duration_ms: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
          });
          if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
        };
        upstreamRes.once('aborted', () => failResponse(new Error('upstream response aborted')));
        upstreamRes.once('error', failResponse);
        upstreamRes.once('close', () => {
          if (!upstreamEnded && !upstreamRes.complete) {
            failResponse(new Error('upstream response closed before completion'));
          }
        });
      },
    );

    currentUpstreamReq = upstreamReq;
    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream request timed out')));
    upstreamReq.on('error', (error) => {
      if (clientAborted || metricFinalized || upstreamEnded) return;
      if (error.code === 'ERR_REQUEST_BODY_TOO_LARGE') {
        pendingOutcome = 'request_too_large';
        if (!res.headersSent) {
          res.once('finish', () => {
            if (!req.destroyed) req.destroy();
          });
          sendJson(res, 413, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'request body too large' },
          }, { Connection: 'close' });
        } else if (!res.destroyed) {
          res.destroy(error);
        }
        return;
      }
      if (pendingOutcome?.startsWith('upstream_error')) return;
      pendingOutcome = attemptSettled
        ? 'upstream_error_after_headers'
        : 'upstream_error_before_headers';
      log('claude_proxy_failed', {
        account_id: account.id,
        device_id: device.id,
        code: error.code ?? error.name ?? 'unknown',
        duration_ms: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      });
      if (!attemptSettled && !res.headersSent) {
        sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'gateway upstream failure' } });
      } else {
        res.destroy(error);
      }
    });

    if (bodyBuffer) {
      upstreamReq.write(bodyBuffer);
      upstreamReq.end();
    }
    return upstreamReq;
  };

  res.once('finish', () => {
    responseFinished = true;
    const outcome = pendingOutcome ?? (upstreamEnded ? 'completed' : 'gateway_response');
    const statusCode = Number.isInteger(res.statusCode) ? res.statusCode : upstreamStatus;
    if (outcome === 'completed') finalizeCompletedWhenReady();
    else finalizeMetric(outcome, statusCode);
    if (outcome === 'completed') {
      log('claude_proxy_complete', {
        account_id: account.id,
        account_alias: account.alias,
        device_id: device.id,
        member_label: device.member_label,
        status: upstreamStatus,
        upstream_ttfb_ms: upstreamTtfbMs,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      });
    }
  });
  res.once('close', () => {
    if (res.writableFinished || metricFinalized) return;
    if (!pendingOutcome) pendingOutcome = 'client_aborted';
    if (pendingOutcome === 'client_aborted') clientAborted = true;
    cancelPendingRetry();
    finalizeMetric(pendingOutcome, upstreamStatus);
    if (currentUpstreamReq && !currentUpstreamReq.destroyed) currentUpstreamReq.destroy();
    if (activeUpstreamRes && !activeUpstreamRes.destroyed) activeUpstreamRes.destroy();
  });
  req.once('aborted', () => {
    if (metricFinalized) return;
    clientAborted = true;
    pendingOutcome = 'client_aborted';
    cancelPendingRetry();
    finalizeMetric(pendingOutcome, upstreamStatus);
    if (currentUpstreamReq && !currentUpstreamReq.destroyed) currentUpstreamReq.destroy();
    if (activeUpstreamRes && !activeUpstreamRes.destroyed) activeUpstreamRes.destroy();
  });

  requestLimit.stream.once('error', (error) => {
    if (error.code !== 'ERR_REQUEST_BODY_TOO_LARGE') return;
    pendingOutcome = 'request_too_large';
    req.unpipe(requestMetadata.stream);
    requestMetadata.stream.destroy();
    if (res.writableFinished) {
      finalizeMetric(pendingOutcome, upstreamStatus);
      if (!req.destroyed) req.destroy();
    } else if (currentUpstreamReq && !currentUpstreamReq.destroyed) {
      currentUpstreamReq.destroy(error);
    }
  });
  bodyAccumulator.once('finish', () => {
    requestBodyFinished = true;
    finalizeCompletedWhenReady();
  });

  const initialUpstreamReq = sendUpstream(null);
  req.pipe(requestMetadata.stream).pipe(requestLimit.stream).pipe(bodyAccumulator).pipe(initialUpstreamReq);
}
