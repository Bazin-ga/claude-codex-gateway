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
import { modelBlockMessage, modelBlockRuleFor } from './model-block-rules.js';
import { bedrockModelAllowed } from './bedrock-models.js';
import { createBedrockEventStreamUsageParser } from './bedrock-event-stream.js';
import { createCodexUsageParser, parseCodexUsage } from './codex-usage.js';
import { parseResponseUsage } from './response-usage.js';

/**
 * The Bedrock data proxy: a device token in, metered Bedrock turns out.
 *
 * It carries the requests the two coding CLIs make when pointed at Bedrock, and
 * the plain Converse call the first version was built for:
 *
 * - `/model/{id}/converse` and `/model/{id}/invoke` — one JSON request, one JSON
 *   response; buffered, forwarded, usage read off the body.
 * - `/model/{id}/invoke-with-response-stream` — what Claude Code sends with
 *   `CLAUDE_CODE_USE_BEDROCK=1`. Streamed through untouched; usage is read from
 *   the AWS event-stream framing by bedrock-event-stream.js.
 * - `/openai/v1/responses` — Bedrock's OpenAI-compatible Responses endpoint,
 *   which Codex speaks as a custom model provider. The model is in the body, not
 *   the path. Streamed as SSE and metered by the Codex usage parser.
 * - `GET /inference-profiles` — the control-plane listing Claude Code reads at
 *   start-up to pick its models. Not a model turn, so not recorded; without it
 *   Claude Code falls back to probing a string of retired models one by one.
 *
 * `converse-stream` is still refused: no client in use needs it, and metering it
 * would need a Converse event-stream reader that nothing else would exercise.
 */
export const BEDROCK_PROXY_PREFIX = '/bedrock';

/** The Claude and Codex proxies' limit: these requests carry a whole transcript. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/**
 * A non-streaming Converse response holds one assistant message. The cap exists
 * so a surprising upstream cannot grow this process's memory without bound; it
 * is far above any real reply and far below the streaming proxies' limits,
 * which have to accommodate a whole transcript.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
/** A long reasoning turn can stream for well past ten minutes. */
const STREAM_TIMEOUT_MS = 60 * 60_000;
const CATALOG_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The request headers Bedrock reads. The device token, the client's own
 * telemetry headers and anything else stay here: the upstream request is built
 * from this list, the account key and nothing more.
 */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-beta', 'anthropic-version'];

/** Bedrock-shaped, because that is what a Bedrock client knows how to read. */
function errorBody(message) {
  return { message };
}

/**
 * The routes this proxy carries, or null.
 *
 * Returned as a parse rather than a boolean so the caller can compare the model
 * against the account's pin. `converse-stream` is recognised specifically, so
 * it can be refused with the reason rather than falling through to a generic
 * 404 that would read like a typo. A Responses route has no model here — it is
 * read from the body once that has arrived.
 */
export function parseBedrockPath(path) {
  if (path === '/openai/v1/responses') {
    return { kind: 'responses', modelId: null, streaming: null, method: 'POST' };
  }
  if (path === '/inference-profiles') {
    return { kind: 'catalog', modelId: null, streaming: false, method: 'GET' };
  }
  const match = /^\/model\/([^/]+)\/(converse|converse-stream|invoke|invoke-with-response-stream)$/.exec(path);
  if (!match) return null;
  let modelId;
  try {
    modelId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return {
    kind: match[2],
    modelId,
    streaming: match[2] === 'converse-stream' || match[2] === 'invoke-with-response-stream',
    method: 'POST',
  };
}

/** The upstream host a route belongs to: inference, or the control plane. */
export function bedrockUpstreamBase(route, region) {
  return route.kind === 'catalog'
    ? `https://bedrock.${region}.amazonaws.com`
    : `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * The four token counts the metrics schema records, from Converse's `usage`.
 *
 * Bedrock reports a cache *read* count but no cache *creation* count, so that
 * column stays null rather than being invented as zero: null means "this
 * provider does not report it" and zero would mean "it reported none".
 */
export function bedrockUsageSnapshot(body) {
  const usage = body && typeof body === 'object' && !Array.isArray(body) ? body.usage : null;
  if (!usage || typeof usage !== 'object') return unavailableUsage();
  const token = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const inputTokens = token(usage.inputTokens);
  const outputTokens = token(usage.outputTokens);
  if (inputTokens === null && outputTokens === null) return unavailableUsage();
  return {
    inputTokens,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: token(usage.cacheReadInputTokens ?? usage.cacheReadInputTokenCount),
    outputTokens,
    usageState: inputTokens !== null && outputTokens !== null ? 'complete' : 'partial',
  };
}

async function readBody(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handleBedrockProxy(req, res, {
  store,
  upstreamBaseUrl = null,
  // Tests point both planes at one fake server; production derives each from
  // the account's region.
  controlBaseUrl = upstreamBaseUrl,
  requestMetrics = null,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const requestUrl = new URL(req.url, 'https://credential-console.invalid');
  const upstreamPath = requestUrl.pathname.slice(BEDROCK_PROXY_PREFIX.length);

  const token = deviceToken(req);
  const device = token ? store.deviceByToken(token) : null;
  if (!device) {
    const ip = sourceIp(req);
    if (rateLimited(authFailures, ip, AUTH_FAILURE_LIMIT)) {
      log('bedrock_proxy_auth_rate_limited', { ip });
      sendJson(res, 429, errorBody('too many authentication failures'), { 'Retry-After': '60' });
      return;
    }
    log('bedrock_proxy_auth_failed', { ip });
    sendJson(res, 401, errorBody('unauthorized'));
    return;
  }

  const authenticatedAtMs = now();
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

  const record = ({
    statusCode,
    outcome,
    startedAtMs = authenticatedAtMs,
    startedAtMonotonic = authenticatedAtMonotonic,
    model = null,
    requestBytes = 0,
    responseBytes = 0,
    ttfbMs = null,
    stream = false,
    upstreamRequestId = null,
    usage = unavailableUsage(),
  }) => {
    enqueueMetricSafely(requestMetrics, {
      startedAtMs,
      method: req.method ?? 'UNKNOWN',
      path: upstreamPath,
      deviceId: device.id,
      machineId: device.machine_id ?? null,
      memberLabel: device.member_label,
      accountId,
      accountAlias: account?.alias ?? 'unavailable',
      model,
      stream,
      statusCode,
      outcome,
      ttfbMs,
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      requestBytes,
      responseBytes,
      upstreamRequestId,
      ...usage,
    }, { accountId, deviceId: device.id });
  };

  if (accountResolutionError) {
    log('bedrock_proxy_device_account_invalid', {
      device_id: device.id,
      account_id: accountId,
      code: accountResolutionError.code ?? accountResolutionError.name ?? 'unknown',
    });
    record({ statusCode: 503, outcome: 'rejected' });
    sendJson(res, 503, errorBody('device account configuration unavailable'));
    return;
  }
  if (!account || account.provider !== 'bedrock' || account.status === 'disabled') {
    record({ statusCode: 403, outcome: 'rejected' });
    sendJson(res, 403, errorBody('account unavailable'));
    return;
  }

  const route = parseBedrockPath(upstreamPath);
  if (!route) {
    record({ statusCode: 404, outcome: 'rejected' });
    sendJson(res, 404, errorBody('unsupported gateway path'));
    return;
  }
  if (route.kind === 'converse-stream') {
    // Said plainly, with the reason, because the alternative a client would
    // otherwise infer is that the model or the region is wrong.
    log('bedrock_proxy_streaming_refused', { account_id: account.id, device_id: device.id });
    record({ statusCode: 501, outcome: 'rejected', model: route.modelId, stream: true });
    sendJson(res, 501, errorBody(
      'converse-stream is not available through this gateway: its turns cannot be metered yet. '
      + 'Use /converse, or /invoke-with-response-stream for a streamed turn.',
    ));
    return;
  }
  if (req.method !== route.method) {
    record({ statusCode: 405, outcome: 'rejected', model: route.modelId });
    sendJson(res, 405, errorBody('method not allowed'), { Allow: route.method });
    return;
  }

  const pin = account.bedrock;
  if (!pin?.region || !pin?.model_id) {
    log('bedrock_proxy_account_unpinned', { account_id: account.id, device_id: device.id });
    record({ statusCode: 503, outcome: 'rejected', model: route.modelId });
    sendJson(res, 503, errorBody('account has no region and model pin'));
    return;
  }

  let apiKey;
  try {
    apiKey = store.accountCredential(account.id)?.api_key;
  } catch {
    apiKey = null;
  }
  if (!apiKey) {
    log('bedrock_proxy_credential_unavailable', { account_id: account.id, device_id: device.id });
    record({ statusCode: 503, outcome: 'rejected', model: route.modelId });
    sendJson(res, 503, errorBody('account credential unavailable'));
    return;
  }

  if (route.kind === 'catalog') {
    await forwardCatalog(req, res, {
      account,
      device,
      apiKey,
      url: `${(controlBaseUrl ?? bedrockUpstreamBase(route, pin.region)).replace(/\/$/, '')}${upstreamPath}${requestUrl.search}`,
      fetchImpl,
    });
    return;
  }

  // A path model can be judged before the body is read; a Responses model only
  // after. Both go through the same two checks.
  const refuseModel = (modelId, { stream = false, requestBytes = 0 } = {}) => {
    if (!bedrockModelAllowed(pin.model_id, modelId)) {
      // The key is account-wide; the pin is the only thing keeping a device
      // token from reaching every model the AWS account can invoke.
      log('bedrock_proxy_model_not_allowed', {
        account_id: account.id,
        device_id: device.id,
        requested: modelId,
      });
      record({ statusCode: 403, outcome: 'rejected', model: modelId, stream, requestBytes });
      sendJson(res, 403, errorBody(`this account may only invoke ${pin.model_id}`));
      return true;
    }
    // The console-wide block rules apply here too.
    const blockRule = typeof store.modelBlockRules === 'function'
      ? modelBlockRuleFor(store.modelBlockRules(), modelId)
      : null;
    if (blockRule) {
      log('bedrock_proxy_model_blocked', {
        account_id: account.id,
        device_id: device.id,
        model: modelId,
        rule_id: blockRule.id,
      });
      record({ statusCode: 403, outcome: 'model_blocked', model: modelId, stream, requestBytes });
      sendJson(res, 403, errorBody(modelBlockMessage(blockRule, modelId)));
      return true;
    }
    return false;
  };
  if (route.modelId !== null && refuseModel(route.modelId, { stream: route.streaming })) return;

  if (rateLimited(deviceRequests, device.id, DEVICE_REQUEST_LIMIT)) {
    log('bedrock_proxy_device_rate_limited', { device_id: device.id });
    record({ statusCode: 429, outcome: 'rejected', model: route.modelId });
    sendJson(res, 429, errorBody('device request limit exceeded'), { 'Retry-After': '60' });
    return;
  }
  const activeRequests = deviceConcurrency.get(device.id) ?? 0;
  if (activeRequests >= DEVICE_CONCURRENCY_LIMIT) {
    log('bedrock_proxy_device_concurrency_limited', { device_id: device.id, active: activeRequests });
    record({ statusCode: 429, outcome: 'rejected', model: route.modelId });
    sendJson(res, 429, errorBody('device concurrency limit exceeded'), { 'Retry-After': '1' });
    return;
  }
  // The buckets are the Claude proxy's own, shared on purpose: a budget that
  // reset per provider would let one device take triple by rotating between
  // them.
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

  let requestBody;
  try {
    requestBody = await readBody(req, MAX_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error.code === 'BODY_TOO_LARGE';
    record({ statusCode: tooLarge ? 413 : 400, outcome: tooLarge ? 'request_too_large' : 'rejected', model: route.modelId });
    if (!res.headersSent) {
      sendJson(res, tooLarge ? 413 : 400, errorBody(tooLarge ? 'request body too large' : 'request body unreadable'));
    }
    return;
  }
  // NOT `req.destroyed`: Node destroys the IncomingMessage as soon as the body
  // has been fully read, so that flag is true on every *successful* request and
  // using it here returned without ever writing a response — every call hung
  // until the client gave up. `req.complete` is the question actually being
  // asked: did the whole request arrive, or did the client vanish mid-upload.
  if (res.destroyed || !req.complete) {
    record({ statusCode: null, outcome: 'client_disconnected', model: route.modelId });
    return;
  }

  let modelId = route.modelId;
  let streaming = route.streaming;
  if (route.kind === 'responses') {
    let parsedRequest = null;
    try {
      parsedRequest = JSON.parse(requestBody.toString('utf8'));
    } catch {
      // Judged below: a body this proxy cannot read has no model to check.
    }
    modelId = typeof parsedRequest?.model === 'string' && parsedRequest.model ? parsedRequest.model : null;
    streaming = parsedRequest?.stream === true;
    if (!modelId) {
      record({ statusCode: 400, outcome: 'rejected', requestBytes: requestBody.length });
      sendJson(res, 400, errorBody('the request body must be JSON naming a model'));
      return;
    }
    if (refuseModel(modelId, { stream: streaming, requestBytes: requestBody.length })) return;
  }

  const base = upstreamBaseUrl ?? bedrockUpstreamBase(route, pin.region);
  const upstream = `${base.replace(/\/$/, '')}${upstreamPath}`;
  const startedAtMs = now();
  const startedAtMonotonic = performance.now();
  const metricBase = {
    startedAtMs,
    startedAtMonotonic,
    model: modelId,
    stream: streaming,
    requestBytes: requestBody.length,
  };

  const headers = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
  }
  headers['content-type'] ??= 'application/json';
  headers.accept ??= 'application/json';
  // The device token authenticated the caller to this console and must never
  // leave it; the real key is attached only here.
  headers.authorization = `Bearer ${apiKey}`;

  // Aborted when the client goes away, so an abandoned stream stops being
  // generated (and billed) upstream instead of running to completion unread.
  const clientGone = new AbortController();
  const abortUpstream = () => clientGone.abort();
  res.once('close', abortUpstream);

  let upstreamResponse;
  try {
    upstreamResponse = await fetchImpl(upstream, {
      method: 'POST',
      headers,
      body: requestBody,
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
    const code = error?.name === 'TimeoutError' ? 'timeout' : (error?.code ?? error?.name ?? 'unknown');
    log('bedrock_proxy_upstream_failed', { account_id: account.id, device_id: device.id, code });
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error' });
    if (!res.headersSent) sendJson(res, 502, errorBody('upstream request failed'));
    return;
  }

  const ttfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));
  const upstreamRequestId = upstreamResponse.headers.get('x-amzn-requestid');
  const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
  const responseHeaders = { 'Content-Type': contentType };
  // The AWS SDK reads the error type from x-amzn-errortype, and request ids
  // belong in a support ticket; the rest of AWS's x-amzn-* set is harmless.
  for (const [name, value] of upstreamResponse.headers) {
    if (name.startsWith('x-amzn-')) responseHeaders[name] = value;
  }

  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  const streamedBody = upstreamResponse.ok
    && (mediaType === 'application/vnd.amazon.eventstream' || mediaType === 'text/event-stream');
  if (streamedBody) {
    await relayStream(res, upstreamResponse, {
      parser: mediaType === 'text/event-stream'
        ? createCodexUsageParser({ format: 'sse' })
        : createBedrockEventStreamUsageParser(),
      clientGone,
      onDone: ({ outcome, statusCode, responseBytes, usage }) => {
        if (outcome === 'upstream_error') {
          log('bedrock_proxy_upstream_stream_failed', { account_id: account.id, device_id: device.id });
        }
        record({
          ...metricBase,
          stream: true,
          statusCode,
          outcome,
          ttfbMs,
          responseBytes,
          upstreamRequestId,
          usage,
        });
      },
      headers: responseHeaders,
      status: upstreamResponse.status,
    });
    return;
  }

  let responseBody;
  try {
    responseBody = await readBody(upstreamResponse.body ?? [], MAX_RESPONSE_BYTES);
  } catch (error) {
    const tooLarge = error.code === 'BODY_TOO_LARGE';
    log(tooLarge ? 'bedrock_proxy_upstream_body_too_large' : 'bedrock_proxy_upstream_body_failed', {
      account_id: account.id,
      device_id: device.id,
      code: error?.code ?? error?.name ?? 'unknown',
    });
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs, upstreamRequestId });
    if (!res.headersSent) sendJson(res, 502, errorBody(tooLarge ? 'upstream response too large' : 'upstream response unreadable'));
    return;
  }

  record({
    ...metricBase,
    statusCode: upstreamResponse.status,
    outcome: upstreamResponse.ok ? 'completed' : 'upstream_error',
    ttfbMs,
    responseBytes: responseBody.length,
    upstreamRequestId,
    usage: upstreamResponse.ok ? jsonUsage(route.kind, responseBody) : unavailableUsage(),
  });

  if (res.destroyed) return;
  res.writeHead(upstreamResponse.status, {
    ...responseHeaders,
    'Content-Length': String(responseBody.length),
  });
  res.end(responseBody);
}

/** Usage from a buffered JSON response, read in the shape its route returns. */
function jsonUsage(kind, body) {
  if (kind === 'converse') {
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      // A non-JSON body is still forwarded verbatim; only the usage is lost,
      // and recording it as unavailable is the honest outcome.
    }
    return bedrockUsageSnapshot(parsed);
  }
  // `invoke` returns the model provider's own body: for an Anthropic model,
  // exactly what the Claude proxy meters.
  const snapshot = kind === 'responses'
    ? parseCodexUsage(body, { format: 'json' })
    : parseResponseUsage(body, { format: 'json' });
  return safeUsageSnapshot({ snapshot: () => snapshot });
}

/**
 * Pass a streamed upstream body to the client unchanged while a usage parser
 * reads a copy. Backpressure is honoured, so a slow client slows the upstream
 * read rather than growing this process's memory.
 */
export async function relayStream(res, upstreamResponse, { parser, clientGone, onDone, headers, status }) {
  let responseBytes = 0;
  let observing = true;
  const observe = (chunk) => {
    if (!observing) return;
    try {
      parser.push(chunk);
    } catch {
      // A parser fault costs this turn its usage, never the client its stream.
      observing = false;
    }
  };
  const usage = (truncated) => safeUsageSnapshot({
    snapshot: () => (observing ? parser.finish({ truncated }) : null),
  });

  if (!res.destroyed) res.writeHead(status, headers);
  try {
    for await (const chunk of upstreamResponse.body) {
      const bytes = Buffer.from(chunk);
      responseBytes += bytes.length;
      observe(bytes);
      if (res.destroyed) break;
      if (!res.write(bytes)) {
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
    }
  } catch {
    if (clientGone.signal.aborted || res.destroyed) {
      onDone({ outcome: 'client_disconnected', statusCode: status, responseBytes, usage: usage(true) });
      return;
    }
    onDone({ outcome: 'upstream_error', statusCode: status, responseBytes, usage: usage(true) });
    res.destroy();
    return;
  }
  if (res.destroyed) {
    onDone({ outcome: 'client_disconnected', statusCode: status, responseBytes, usage: usage(true) });
    return;
  }
  res.end();
  onDone({ outcome: 'completed', statusCode: status, responseBytes, usage: usage(false) });
}

/**
 * The control-plane listing. Read-only and free, so it is forwarded without a
 * metric row — it is not a model turn, and recording one per Claude Code start
 * would make every machine look busier than it is.
 */
async function forwardCatalog(req, res, { account, device, apiKey, url, fetchImpl }) {
  let upstreamResponse;
  let body;
  try {
    upstreamResponse = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    body = await readBody(upstreamResponse.body ?? [], CATALOG_MAX_BYTES);
  } catch (error) {
    log('bedrock_proxy_catalog_failed', {
      account_id: account.id,
      device_id: device.id,
      code: error?.code ?? error?.name ?? 'unknown',
    });
    if (!res.headersSent) sendJson(res, 502, errorBody('upstream request failed'));
    return;
  }
  if (res.destroyed) return;
  res.writeHead(upstreamResponse.status, {
    'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json',
    'Content-Length': String(body.length),
  });
  res.end(body);
}
