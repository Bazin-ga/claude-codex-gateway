import { Buffer } from 'node:buffer';
import { sendJson } from './http.js';
import { deviceToken } from './device-auth.js';
import {
  AUTH_FAILURE_LIMIT,
  DEVICE_CONCURRENCY_LIMIT,
  DEVICE_REQUEST_LIMIT,
  authFailures,
  deviceConcurrency,
  deviceRequests,
  enqueueMetricSafely,
  log,
  rateLimited,
  safeUsageSnapshot,
  sourceIp,
  unavailableUsage,
} from './proxy.js';
import { readModelPrefix } from './model-gate.js';
import { relayStream } from './bedrock-proxy.js';
import { createCodexUsageParser, parseCodexUsage } from './codex-usage.js';
import { createResponseUsageParser, parseResponseUsage } from './response-usage.js';
import { RELAY_ACCOUNT_ID, RELAY_PROXY_PREFIX } from './relay.js';

/**
 * Carries a device's turn to the third-party platform.
 *
 * Two ways in. The Claude and Codex proxies call `intercept` on every inference
 * request: it reads just enough of the body to see the model, and if that model
 * is on the allow-list the turn goes to the platform; otherwise the bytes it
 * read go back to the caller and the request carries on to the account exactly
 * as before. `/relay/v1/*` is the direct route, for scripts that speak the
 * OpenAI or Anthropic wire format themselves. Both authenticate with the
 * device token the member already has.
 *
 * The allow-list is checked against the parsed body, not the first `model`
 * the prefix scan saw: the platform bills per token, and a body naming an
 * allowed model first and another one second would otherwise run — and bill —
 * the second.
 */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
const STREAM_TIMEOUT_MS = 60 * 60_000;
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'];

const KINDS = {
  messages: { upstreamPath: '/v1/messages' },
  responses: { upstreamPath: '/v1/responses' },
  chat: { upstreamPath: '/v1/chat/completions' },
};

const DIRECT_ROUTES = new Map([
  ['/v1/messages', 'messages'],
  ['/v1/responses', 'responses'],
  ['/v1/chat/completions', 'chat'],
]);

/** The error shape each client knows how to read. */
function errorBody(kind, type, message) {
  return kind === 'messages'
    ? { type: 'error', error: { type, message } }
    : { error: { type, message, code: null, param: null } };
}

/**
 * Usage from an OpenAI chat-completions body or stream: the final chunk of a
 * stream carries `usage` when the client asked for it, a JSON body always
 * does. Prompt tokens include the cached ones, as in the other two formats.
 */
export class ChatUsageParser {
  constructor() {
    this.pending = '';
    this.usage = null;
    this.bytes = 0;
  }

  #take(usage) {
    if (!usage || typeof usage !== 'object') return;
    this.usage = usage;
  }

  push(chunk) {
    this.bytes += chunk.length;
    if (this.bytes > MAX_RESPONSE_BYTES * 4) return;
    this.pending += chunk.toString('utf8');
    let index;
    while ((index = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, index).trim();
      this.pending = this.pending.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        this.#take(JSON.parse(data).usage);
      } catch {
        // Not every line is a whole JSON object; only the usage matters here.
      }
    }
  }

  finish({ truncated = false } = {}) {
    const rest = this.pending.trim();
    if (rest.startsWith('{')) {
      try {
        this.#take(JSON.parse(rest).usage);
      } catch {
        // A truncated body has no usage to read.
      }
    }
    const token = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    const usage = this.usage;
    if (!usage) return unavailableUsage();
    const inputTokens = token(usage.prompt_tokens);
    const outputTokens = token(usage.completion_tokens);
    return {
      inputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: token(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens),
      outputTokens,
      usageState: !truncated && inputTokens !== null && outputTokens !== null ? 'complete' : 'partial',
    };
  }
}

function usageParser(kind, format) {
  if (kind === 'messages') return createResponseUsageParser({ format });
  if (kind === 'responses') return createCodexUsageParser({ format });
  return new ChatUsageParser();
}

function bufferedUsage(kind, body) {
  if (kind === 'messages') return safeUsageSnapshot({ snapshot: () => parseResponseUsage(body, { format: 'json' }) });
  if (kind === 'responses') return safeUsageSnapshot({ snapshot: () => parseCodexUsage(body, { format: 'json' }) });
  const parser = new ChatUsageParser();
  parser.push(body);
  return safeUsageSnapshot({ snapshot: () => parser.finish() });
}

async function readRest(stream, already, limit) {
  const chunks = already ? [already] : [];
  let bytes = already?.length ?? 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createRelay({
  store,
  catalog = null,
  requestMetrics = null,
  enabled = false,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const settings = () => store.relaySettings();
  const active = () => {
    if (!enabled) return false;
    const current = settings();
    return Boolean(current.base_url && current.has_key && current.allowed_models.length);
  };
  const allows = (model) => typeof model === 'string' && settings().allowed_models.includes(model);
  const platformAlias = () => `relay:${settings().name ?? 'platform'}`;

  /**
   * Forward one turn whose first bytes may already have been read. Owns the
   * response from here on.
   */
  async function forward(req, res, { device, kind, head = null, ended = false, path, authenticatedAtMs = now() }) {
    const authenticatedAtMonotonic = performance.now();
    const record = ({
      statusCode,
      outcome,
      model = null,
      stream = null,
      requestBytes = 0,
      responseBytes = 0,
      ttfbMs = null,
      startedAtMonotonic = authenticatedAtMonotonic,
      usage = unavailableUsage(),
    }) => {
      enqueueMetricSafely(requestMetrics, {
        startedAtMs: authenticatedAtMs,
        method: req.method ?? 'UNKNOWN',
        path,
        deviceId: device.id,
        machineId: device.machine_id ?? null,
        memberLabel: device.member_label,
        accountId: RELAY_ACCOUNT_ID,
        accountAlias: platformAlias(),
        model,
        stream,
        statusCode,
        outcome,
        ttfbMs,
        durationMs: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
        requestBytes,
        responseBytes,
        upstreamRequestId: null,
        ...usage,
      }, { accountId: RELAY_ACCOUNT_ID, deviceId: device.id });
    };

    if (rateLimited(deviceRequests, device.id, DEVICE_REQUEST_LIMIT)) {
      record({ statusCode: 429, outcome: 'rejected' });
      sendJson(res, 429, errorBody(kind, 'rate_limit_error', 'device request limit exceeded'), { 'Retry-After': '60' });
      return;
    }
    const activeRequests = deviceConcurrency.get(device.id) ?? 0;
    if (activeRequests >= DEVICE_CONCURRENCY_LIMIT) {
      record({ statusCode: 429, outcome: 'rejected' });
      sendJson(res, 429, errorBody(kind, 'rate_limit_error', 'device concurrency limit exceeded'), { 'Retry-After': '1' });
      return;
    }
    deviceConcurrency.set(device.id, activeRequests + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (deviceConcurrency.get(device.id) ?? 1) - 1;
      if (remaining > 0) deviceConcurrency.set(device.id, remaining);
      else deviceConcurrency.delete(device.id);
    };
    res.once('finish', release);
    res.once('close', release);

    let body;
    try {
      body = ended ? (head ?? Buffer.alloc(0)) : await readRest(req, head, MAX_REQUEST_BYTES);
    } catch (error) {
      const tooLarge = error.code === 'BODY_TOO_LARGE';
      record({ statusCode: tooLarge ? 413 : 400, outcome: tooLarge ? 'request_too_large' : 'rejected' });
      if (!res.headersSent) {
        sendJson(res, tooLarge ? 413 : 400, errorBody(kind, 'invalid_request_error', tooLarge ? 'request body too large' : 'request body unreadable'));
      }
      return;
    }
    if (res.destroyed) {
      record({ statusCode: null, outcome: 'client_disconnected', requestBytes: body.length });
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      // Judged below.
    }
    const model = typeof parsed?.model === 'string' ? parsed.model : null;
    const streaming = parsed?.stream === true;
    if (!allows(model)) {
      log('relay_proxy_model_refused', { device_id: device.id, model });
      record({ statusCode: 403, outcome: 'model_blocked', model, stream: streaming, requestBytes: body.length });
      sendJson(res, 403, errorBody(
        kind,
        'permission_error',
        `model "${model ?? ''}" is not allowed on the third-party platform; allowed: ${settings().allowed_models.join(', ') || 'none'} `
          + `(第三方模型平台只允许：${settings().allowed_models.join('、') || '无'})`,
      ));
      return;
    }

    const current = settings();
    const apiKey = store.relayApiKey();
    if (!current.base_url || !apiKey) {
      record({ statusCode: 503, outcome: 'rejected', model, stream: streaming, requestBytes: body.length });
      sendJson(res, 503, errorBody(kind, 'api_error', 'third-party platform is not configured'));
      return;
    }
    const headers = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    headers['content-type'] ??= 'application/json';
    headers.authorization = `Bearer ${apiKey}`;
    if (kind === 'messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] ??= '2023-06-01';
    }

    const startedAtMonotonic = performance.now();
    const metricBase = { model, stream: streaming, requestBytes: body.length, startedAtMonotonic };
    const clientGone = new AbortController();
    const abort = () => clientGone.abort();
    res.once('close', () => {
      if (!res.writableFinished) abort();
    });
    let upstreamResponse;
    try {
      upstreamResponse = await fetchImpl(`${current.base_url}${KINDS[kind].upstreamPath}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.any([
          clientGone.signal,
          AbortSignal.timeout(streaming ? STREAM_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS),
        ]),
      });
    } catch (error) {
      if (clientGone.signal.aborted) {
        record({ ...metricBase, statusCode: null, outcome: 'client_disconnected' });
        return;
      }
      const code = error?.name === 'TimeoutError' ? 'timeout' : (error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown');
      log('relay_proxy_upstream_failed', { device_id: device.id, model, code });
      record({ ...metricBase, statusCode: 502, outcome: 'upstream_error' });
      if (!res.headersSent) sendJson(res, 502, errorBody(kind, 'api_error', 'third-party platform request failed'));
      return;
    }

    const ttfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));
    const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
    const responseHeaders = { 'Content-Type': contentType, 'Cache-Control': 'no-store' };
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (upstreamResponse.ok && mediaType === 'text/event-stream') {
      await relayStream(res, upstreamResponse, {
        parser: usageParser(kind, 'sse'),
        clientGone,
        onDone: ({ outcome, statusCode, responseBytes, usage }) => {
          if (outcome === 'upstream_error') log('relay_proxy_upstream_stream_failed', { device_id: device.id, model });
          record({ ...metricBase, stream: true, statusCode, outcome, ttfbMs, responseBytes, usage });
        },
        headers: responseHeaders,
        status: upstreamResponse.status,
      });
      return;
    }
    let responseBody;
    try {
      responseBody = await readRest(upstreamResponse.body ?? [], null, MAX_RESPONSE_BYTES);
    } catch (error) {
      log('relay_proxy_upstream_body_failed', { device_id: device.id, model, code: error?.code ?? error?.name ?? 'unknown' });
      record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs });
      if (!res.headersSent) sendJson(res, 502, errorBody(kind, 'api_error', 'third-party platform response unreadable'));
      return;
    }
    record({
      ...metricBase,
      statusCode: upstreamResponse.status,
      outcome: upstreamResponse.ok ? 'completed' : 'upstream_error',
      ttfbMs,
      responseBytes: responseBody.length,
      usage: upstreamResponse.ok ? bufferedUsage(kind, responseBody) : unavailableUsage(),
    });
    if (res.destroyed) return;
    res.writeHead(upstreamResponse.status, { ...responseHeaders, 'Content-Length': String(responseBody.length) });
    res.end(responseBody);
  }

  /**
   * Called by the Claude and Codex proxies once the device is known. Returns
   * `{ handled: true }` when this turn went to the platform (or was answered
   * here), else the prefix it read — which the caller must put back in front
   * of the body — or null when nothing was read.
   */
  async function intercept(req, res, { device, kind, path }) {
    if (!active() || req.method !== 'POST') return { handled: false, prefix: null };
    const authenticatedAtMs = now();
    const prefix = await readModelPrefix(req);
    if (prefix.aborted || res.destroyed || (!prefix.ended && req.destroyed)) {
      return { handled: true, prefix: null };
    }
    const model = prefix.scanner.snapshot().model ?? prefix.model;
    if (!allows(model)) return { handled: false, prefix };
    await forward(req, res, { device, kind, head: prefix.head, ended: prefix.ended, path, authenticatedAtMs });
    return { handled: true, prefix: null };
  }

  /** `/relay/v1/*`: the direct route, authenticated by any live device token. */
  async function handle(req, res) {
    const url = new URL(req.url, 'https://credential-console.invalid');
    const path = url.pathname.slice(RELAY_PROXY_PREFIX.length);
    const token = deviceToken(req);
    const device = token ? store.deviceByToken(token) : null;
    if (!device) {
      const ip = sourceIp(req);
      if (rateLimited(authFailures, ip, AUTH_FAILURE_LIMIT)) {
        sendJson(res, 429, errorBody('chat', 'rate_limit_error', 'too many authentication failures'), { 'Retry-After': '60' });
        return;
      }
      log('relay_proxy_auth_failed', { ip });
      sendJson(res, 401, errorBody('chat', 'authentication_error', 'unauthorized'));
      return;
    }
    if (path === '/v1/models' && req.method === 'GET') {
      const created = Math.floor(now() / 1000);
      sendJson(res, 200, {
        object: 'list',
        data: (active() ? settings().allowed_models : []).map((id) => ({ id, object: 'model', created, owned_by: settings().name ?? 'relay' })),
      });
      return;
    }
    const kind = DIRECT_ROUTES.get(path);
    if (!kind) {
      sendJson(res, 404, errorBody('chat', 'not_found_error', 'unsupported gateway path'));
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, errorBody(kind, 'invalid_request_error', 'method not allowed'), { Allow: 'POST' });
      return;
    }
    if (!active()) {
      sendJson(res, 503, errorBody(kind, 'api_error', 'no third-party model is enabled on this console'));
      return;
    }
    await forward(req, res, { device, kind, path });
  }

  return { active, allows, intercept, handle, settings };
}
