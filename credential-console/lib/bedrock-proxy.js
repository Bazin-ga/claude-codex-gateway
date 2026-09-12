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
  sourceIp,
  unavailableUsage,
} from './proxy.js';

/**
 * The Bedrock data proxy: a device token in, one metered Converse turn out.
 *
 * Deliberately the simplest of the three, and short in a way the other two
 * cannot be. The Claude and Codex proxies stream, so they carry tees, response
 * observers, incremental usage parsers and the bookkeeping needed to finalise a
 * metric whose numbers arrive in the last event. A non-streaming Converse turn
 * is one request and one JSON response: buffer, forward, read `usage`, record.
 *
 * That simplicity is the entire reason streaming is refused rather than passed
 * through. `converse-stream` frames its events in the AWS event-stream binary
 * format, not SSE, so none of the existing observation machinery can read it —
 * forwarding it would work for the client and silently record every turn as
 * zero tokens. Metering is what this console is for; a path that quietly
 * stopped metering would be worse than one that is honestly unavailable.
 */
export const BEDROCK_PROXY_PREFIX = '/bedrock';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/**
 * A non-streaming Converse response holds one assistant message. The cap exists
 * so a surprising upstream cannot grow this process's memory without bound; it
 * is far above any real reply and far below the streaming proxies' limits,
 * which have to accommodate a whole transcript.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

/** Bedrock-shaped, because that is what a Bedrock client knows how to read. */
function errorBody(message) {
  return { message };
}

/**
 * `/model/{modelId}/converse` and nothing else.
 *
 * Returned as a parse rather than a boolean so the caller can compare the model
 * against the account's pin. `converse-stream` is recognised specifically, so
 * it can be refused with the reason rather than falling through to a generic
 * 404 that would read like a typo.
 */
export function parseBedrockPath(path) {
  const match = /^\/model\/([^/]+)\/(converse|converse-stream)$/.exec(path);
  if (!match) return null;
  return { modelId: decodeURIComponent(match[1]), streaming: match[2] === 'converse-stream' };
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
      // Never null: this proxy only ever carries non-streaming turns, so the
      // column is a fact about the path rather than something read off a body.
      stream: false,
      statusCode,
      outcome,
      ttfbMs,
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      requestBytes,
      responseBytes,
      upstreamRequestId: null,
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
  if (route.streaming) {
    // Said plainly, with the reason, because the alternative a client would
    // otherwise infer is that the model or the region is wrong.
    log('bedrock_proxy_streaming_refused', { account_id: account.id, device_id: device.id });
    record({ statusCode: 501, outcome: 'rejected', model: route.modelId });
    sendJson(res, 501, errorBody(
      'streaming is not available through this gateway: its turns cannot be metered yet, '
      + 'and an unmetered turn would be recorded as zero tokens. Use /converse.',
    ));
    return;
  }
  if (req.method !== 'POST') {
    record({ statusCode: 405, outcome: 'rejected', model: route.modelId });
    sendJson(res, 405, errorBody('method not allowed'), { Allow: 'POST' });
    return;
  }

  const pin = account.bedrock;
  if (!pin?.region || !pin?.model_id) {
    log('bedrock_proxy_account_unpinned', { account_id: account.id, device_id: device.id });
    record({ statusCode: 503, outcome: 'rejected', model: route.modelId });
    sendJson(res, 503, errorBody('account has no region and model pin'));
    return;
  }
  if (route.modelId !== pin.model_id) {
    // The key is account-wide; the pin is the only thing keeping a device token
    // from reaching every model the AWS account can invoke.
    log('bedrock_proxy_model_not_allowed', {
      account_id: account.id,
      device_id: device.id,
      requested: route.modelId,
    });
    record({ statusCode: 403, outcome: 'rejected', model: route.modelId });
    sendJson(res, 403, errorBody(`this account may only invoke ${pin.model_id}`));
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

  const base = upstreamBaseUrl ?? `https://bedrock-runtime.${pin.region}.amazonaws.com`;
  const upstream = `${base.replace(/\/$/, '')}${upstreamPath}`;
  const startedAtMs = now();
  const startedAtMonotonic = performance.now();
  const metricBase = {
    startedAtMs,
    startedAtMonotonic,
    model: route.modelId,
    requestBytes: requestBody.length,
  };

  let upstreamResponse;
  try {
    upstreamResponse = await fetchImpl(upstream, {
      method: 'POST',
      headers: {
        // The device token authenticated the caller to this console and must
        // never leave it; the real key is attached only here.
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: requestBody,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'timeout' : (error?.code ?? error?.name ?? 'unknown');
    log('bedrock_proxy_upstream_failed', { account_id: account.id, device_id: device.id, code });
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error' });
    if (!res.headersSent) sendJson(res, 502, errorBody('upstream request failed'));
    return;
  }

  const ttfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));
  let responseBody;
  try {
    responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
  } catch (error) {
    log('bedrock_proxy_upstream_body_failed', {
      account_id: account.id,
      device_id: device.id,
      code: error?.code ?? error?.name ?? 'unknown',
    });
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs });
    if (!res.headersSent) sendJson(res, 502, errorBody('upstream response unreadable'));
    return;
  }
  if (responseBody.length > MAX_RESPONSE_BYTES) {
    log('bedrock_proxy_upstream_body_too_large', {
      account_id: account.id,
      device_id: device.id,
      bytes: responseBody.length,
    });
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs });
    if (!res.headersSent) sendJson(res, 502, errorBody('upstream response too large'));
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(responseBody.toString('utf8'));
  } catch {
    // A non-JSON body is still forwarded verbatim; only the usage is lost, and
    // recording it as unavailable is the honest outcome.
  }

  record({
    ...metricBase,
    statusCode: upstreamResponse.status,
    outcome: upstreamResponse.ok ? 'completed' : 'upstream_error',
    ttfbMs,
    responseBytes: responseBody.length,
    usage: upstreamResponse.ok ? bedrockUsageSnapshot(parsed) : unavailableUsage(),
  });

  if (res.destroyed) return;
  res.writeHead(upstreamResponse.status, {
    'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json',
    'Content-Length': String(responseBody.length),
  });
  res.end(responseBody);
}
