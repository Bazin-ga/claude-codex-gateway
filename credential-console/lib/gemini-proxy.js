import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ACCOUNT_RESTRICTED_MESSAGE } from './account-restriction.js';
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
import { modelBlockMessage, modelBlockRuleFor } from './model-block-rules.js';
import {
  GEMINI_UPSTREAM_BASE_URL,
  fetchGeminiModels,
  geminiUpstreamHeaders,
  isTermsOfServiceBan,
  refreshHubVersion,
} from './gemini-oauth.js';

/**
 * The Gemini data proxy: the public Gemini API in, a Google AI Pro / Ultra
 * subscription out.
 *
 * Clients speak the ordinary Generative Language API — what Gemini CLI sends
 * with `GOOGLE_GEMINI_BASE_URL` set, and what any Gemini SDK sends with a base
 * URL override — and authenticate with the device token as their API key. The
 * subscription is only reachable through Cloud Code's internal API, which
 * takes the same request wrapped in an envelope naming the project and model,
 * and answers the same response wrapped in `{ response }`. So unlike the
 * Claude and Codex proxies this one is not a byte-for-byte relay: each request
 * is wrapped on the way in and each response (or SSE event) unwrapped on the
 * way out.
 *
 * - `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent`
 *   — the turns. Metered from `usageMetadata`.
 * - `POST /v1beta/models/{model}:countTokens` — answered upstream, or
 *   estimated when Cloud Code refuses it. Not a turn, not recorded.
 * - `GET /v1beta/models[/{model}]` — the models this account may call.
 */
export const GEMINI_PROXY_PREFIX = '/gemini';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
const STREAM_TIMEOUT_MS = 60 * 60_000;
/** How long one account's model list (and so its quota reading) is reused. */
const MODEL_LIST_TTL_MS = 10 * 60_000;

/**
 * The identity the Hub puts in front of every turn. Cloud Code answers some
 * requests without it with an opaque RESOURCE_EXHAUSTED, so it is prepended —
 * the client's own system prompt follows it unchanged.
 */
const HUB_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**`;
/**
 * Gemini rejects a replayed function call that lost its thought signature.
 * Clients that do not keep signatures (or a history edited by compaction)
 * would otherwise fail the whole turn; this documented sentinel tells the
 * backend to skip the check.
 */
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

function errorBody(status, message, code = 'FAILED_PRECONDITION') {
  return { error: { code: status, message, status: code } };
}

const GOOGLE_STATUS = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  405: 'INVALID_ARGUMENT',
  413: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
};

function sendGoogleError(res, status, message, headers = {}) {
  sendJson(res, status, errorBody(status, message, GOOGLE_STATUS[status] ?? 'UNKNOWN'), headers);
}

/**
 * Gemini clients send the key as `x-goog-api-key` (the SDKs) or `?key=` (REST
 * examples); the Claude-style bearer is accepted too, so one token header rule
 * covers every client.
 */
export function geminiDeviceToken(req, requestUrl) {
  const header = req?.headers?.['x-goog-api-key'];
  if (typeof header === 'string' && header) return header;
  const query = requestUrl.searchParams.get('key');
  if (query) return query;
  return deviceToken(req);
}

/** The route this proxy carries, or null. */
export function parseGeminiPath(path) {
  const list = /^\/(v1beta|v1|v1alpha)\/models\/?$/.exec(path);
  if (list) return { kind: 'list', model: null, method: 'GET' };
  const action = /^\/(?:v1beta|v1|v1alpha)\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/.exec(path);
  if (action) {
    let model;
    try {
      model = decodeURIComponent(action[1]);
    } catch {
      return null;
    }
    return { kind: action[2], model, method: 'POST' };
  }
  const single = /^\/(?:v1beta|v1|v1alpha)\/models\/([^/:]+)$/.exec(path);
  if (single) {
    try {
      return { kind: 'get', model: decodeURIComponent(single[1]), method: 'GET' };
    } catch {
      return null;
    }
  }
  return null;
}

function versionOf(id) {
  const match = /gemini-(\d+(?:\.\d+)?)/.exec(id);
  return match ? Number(match[1]) : 0;
}

/**
 * The model to send for the one a client asked for.
 *
 * Gemini CLI asks for public API names (`gemini-2.5-flash`, `gemini-3-pro-preview`,
 * and its own helper calls to a flash-lite model) that the subscription does not
 * list under those names; it lists its own (`gemini-3.1-pro-high`, ...). An id
 * the account offers is sent as is. Anything else is matched by family — lite,
 * flash or pro — to the newest Gemini model of that family the account has, so a
 * client's defaults keep working. With no list to consult, the name goes through.
 */
export function resolveGeminiModel(requested, models) {
  const id = String(requested ?? '').replace(/^models\//, '');
  if (!Array.isArray(models) || !models.length) return id;
  if (models.some((model) => model.id === id)) return id;
  const lower = id.toLowerCase();
  const family = lower.includes('lite') ? 'lite' : lower.includes('flash') ? 'flash' : lower.includes('pro') ? 'pro' : null;
  if (!family) return id;
  const gemini = models.filter((model) => /gemini/i.test(model.id) && !/image|embedding|tts|audio/i.test(model.id));
  const ofFamily = (name) => gemini.filter((model) => {
    const candidate = model.id.toLowerCase();
    if (name === 'lite') return candidate.includes('lite');
    if (name === 'flash') return candidate.includes('flash') && !candidate.includes('lite');
    return candidate.includes('pro');
  });
  // A lite request falls back to flash: a lite model is a cheaper flash.
  const pool = ofFamily(family).length ? ofFamily(family) : family === 'lite' ? ofFamily('flash') : [];
  if (!pool.length) return id;
  const rank = (model) => [
    versionOf(model.id),
    /high/.test(model.id) ? 2 : /low/.test(model.id) ? 0 : 1,
    // Previews and experiments last among equals.
    /preview|exp/.test(model.id) ? 0 : 1,
  ];
  pool.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return a.id.localeCompare(b.id);
  });
  return pool[0].id;
}

/**
 * The four token counts the metrics schema records, from Gemini's
 * `usageMetadata`. Thinking is billed as output, so it is counted as output.
 * Gemini reports cached reads but no cache writes: that column stays null.
 */
export function geminiUsageSnapshot(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== 'object') return unavailableUsage();
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const prompt = count(usageMetadata.promptTokenCount);
  const cached = count(usageMetadata.cachedContentTokenCount) ?? 0;
  const candidates = count(usageMetadata.candidatesTokenCount);
  const thoughts = count(usageMetadata.thoughtsTokenCount) ?? 0;
  if (prompt === null && candidates === null) return unavailableUsage();
  return {
    inputTokens: prompt === null ? null : Math.max(0, prompt - cached),
    cacheCreationInputTokens: null,
    cacheReadInputTokens: cached,
    outputTokens: candidates === null && !thoughts ? null : (candidates ?? 0) + thoughts,
    usageState: prompt !== null && candidates !== null ? 'complete' : 'partial',
  };
}

/** Give a function call that lost its thought signature the skip sentinel. */
function restoreFunctionCallSignatures(contents) {
  if (!Array.isArray(contents)) return contents;
  return contents.map((content) => {
    if (!content || content.role !== 'model' || !Array.isArray(content.parts)) return content;
    let first = true;
    const parts = content.parts.map((part) => {
      if (!part?.functionCall) return part;
      const signed = first && !(typeof part.thoughtSignature === 'string' && part.thoughtSignature);
      first = false;
      return signed ? { ...part, thoughtSignature: SKIP_THOUGHT_SIGNATURE } : part;
    });
    return { ...content, parts };
  });
}

function withHubSystemInstruction(systemInstruction) {
  let parts = [];
  if (typeof systemInstruction === 'string') parts = [{ text: systemInstruction }];
  else if (Array.isArray(systemInstruction?.parts)) parts = systemInstruction.parts;
  return { role: 'user', parts: [{ text: HUB_SYSTEM_INSTRUCTION }, ...parts] };
}

/**
 * One conversation, one session id: the device plus the opening of the first
 * user turn, so the backend's prompt cache sees one conversation as one.
 */
function sessionIdFor(deviceId, contents) {
  const opening = Array.isArray(contents)
    ? JSON.stringify(contents.find((content) => content?.role === 'user')?.parts ?? []).slice(0, 4096)
    : '';
  return `-${BigInt(`0x${createHash('sha256').update(`${deviceId}\u0000${opening}`).digest('hex').slice(0, 15)}`)}`;
}

/** The Cloud Code envelope around a public generateContent request. */
export function wrapGeminiRequest(body, { model, projectId, deviceId }) {
  const request = { ...body };
  delete request.model;
  request.contents = restoreFunctionCallSignatures(request.contents);
  request.systemInstruction = withHubSystemInstruction(request.systemInstruction ?? request.system_instruction);
  delete request.system_instruction;
  request.sessionId = sessionIdFor(deviceId, request.contents);
  return {
    project: projectId,
    model,
    request,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `agent-${randomUUID()}`,
  };
}

/** `{ response, traceId }` → the response; anything else is returned as is. */
function unwrapResponse(parsed) {
  return parsed && typeof parsed === 'object' && parsed.response && typeof parsed.response === 'object'
    ? parsed.response
    : parsed;
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

/** The model list in the public API's shape. */
function publicModel(model) {
  return {
    name: `models/${model.id}`,
    baseModelId: model.id,
    version: model.id,
    displayName: model.displayName ?? model.id,
    ...(model.inputTokenLimit ? { inputTokenLimit: model.inputTokenLimit } : {}),
    ...(model.outputTokenLimit ? { outputTokenLimit: model.outputTokenLimit } : {}),
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
  };
}

/**
 * Per-account model lists, shared by the proxy (model resolution, the list
 * route) and the usage monitor (the quota on the account card).
 */
export class GeminiModelCache {
  constructor({ tokens, fetchImpl = fetch, baseUrl = GEMINI_UPSTREAM_BASE_URL, now = Date.now, fetchModels = fetchGeminiModels }) {
    this.tokens = tokens;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.now = now;
    this.fetchModels = fetchModels;
    this.entries = new Map();
  }

  peek(accountId) {
    return this.entries.get(accountId) ?? null;
  }

  async modelsFor(accountId, { force = false } = {}) {
    const entry = this.entries.get(accountId);
    if (!force && entry && this.now() - entry.fetchedAtMs < MODEL_LIST_TTL_MS) return entry.models;
    if (!force && entry?.pending) return entry.pending;
    const pending = (async () => {
      const { accessToken, projectId } = await this.tokens.credentialFor(accountId);
      const models = await this.fetchModels({ accessToken, projectId, fetchImpl: this.fetchImpl, baseUrl: this.baseUrl });
      this.entries.set(accountId, { models, fetchedAtMs: this.now() });
      return models;
    })();
    this.entries.set(accountId, { ...(entry ?? { models: null, fetchedAtMs: 0 }), pending });
    try {
      return await pending;
    } catch (error) {
      const current = this.entries.get(accountId);
      if (current?.pending === pending) {
        if (current.models) this.entries.set(accountId, { models: current.models, fetchedAtMs: current.fetchedAtMs });
        else this.entries.delete(accountId);
      }
      throw error;
    }
  }
}

export async function handleGeminiProxy(req, res, {
  store,
  tokens,
  models,
  upstreamBaseUrl = GEMINI_UPSTREAM_BASE_URL,
  requestMetrics = null,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const requestUrl = new URL(req.url, 'https://credential-console.invalid');
  const upstreamPath = requestUrl.pathname.slice(GEMINI_PROXY_PREFIX.length);

  const token = geminiDeviceToken(req, requestUrl);
  const device = token ? store.deviceByToken(token) : null;
  if (!device) {
    const ip = sourceIp(req);
    if (rateLimited(authFailures, ip, AUTH_FAILURE_LIMIT)) {
      log('gemini_proxy_auth_rate_limited', { ip });
      sendGoogleError(res, 429, 'too many authentication failures', { 'Retry-After': '60' });
      return;
    }
    log('gemini_proxy_auth_failed', { ip });
    sendGoogleError(res, 401, 'API key not valid. Use the device token this console issued.');
    return;
  }

  const authenticatedAtMs = now();
  const authenticatedAtMonotonic = performance.now();
  let accountId = device.account_id;
  let account = null;
  let accountResolutionError = null;
  try {
    const resolved = store.resolveDeviceAccount(device);
    accountId = resolved.effective_account_id;
    account = resolved.account;
  } catch (error) {
    accountResolutionError = error;
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
      upstreamRequestId: null,
      ...usage,
    }, { accountId, deviceId: device.id });
  };

  if (accountResolutionError) {
    log('gemini_proxy_device_account_invalid', {
      device_id: device.id,
      account_id: accountId,
      code: accountResolutionError.code ?? accountResolutionError.name ?? 'unknown',
    });
    const restricted = accountResolutionError.code === 'ACCOUNT_RESTRICTED';
    record({ statusCode: restricted ? 403 : 503, outcome: 'rejected' });
    sendGoogleError(res, restricted ? 403 : 503, restricted ? ACCOUNT_RESTRICTED_MESSAGE : 'device account configuration unavailable');
    return;
  }
  if (!account || account.provider !== 'gemini' || account.status === 'disabled') {
    record({ statusCode: 403, outcome: 'rejected' });
    sendGoogleError(res, 403, 'this device token is not for a Gemini account');
    return;
  }

  const route = parseGeminiPath(upstreamPath);
  if (!route) {
    record({ statusCode: 404, outcome: 'rejected' });
    sendGoogleError(res, 404, 'unsupported gateway path');
    return;
  }
  if (req.method !== route.method) {
    record({ statusCode: 405, outcome: 'rejected', model: route.model });
    sendGoogleError(res, 405, 'method not allowed', { Allow: route.method });
    return;
  }

  let credential;
  try {
    credential = await tokens.credentialFor(account.id);
  } catch (error) {
    log('gemini_proxy_credential_unavailable', {
      account_id: account.id,
      device_id: device.id,
      code: error.code ?? error.name ?? 'unknown',
    });
    if (error.code === 'INVALID_GRANT') {
      store.updateAccountHealth?.(account.id, {
        success: false,
        error: 'Google refused the stored sign-in (invalid_grant); authorize this account again',
      }).catch(() => {});
    }
    record({ statusCode: 503, outcome: 'rejected', model: route.model });
    sendGoogleError(res, 503, error.code === 'LOGIN_REQUIRED' || error.code === 'INVALID_GRANT'
      ? 'the Gemini account behind this token needs to be authorized again in the console'
      : 'account credential unavailable');
    return;
  }
  if (!credential.projectId) {
    record({ statusCode: 503, outcome: 'rejected', model: route.model });
    sendGoogleError(res, 503, 'the Gemini account has no Cloud Code project; authorize it again');
    return;
  }

  // The list is fetched with the account's credential, so it is the account's
  // own: a failed read leaves resolution to pass names through.
  const accountModels = async () => {
    try {
      return await models.modelsFor(account.id);
    } catch (error) {
      log('gemini_proxy_model_list_failed', { account_id: account.id, code: error.code ?? error.name ?? 'unknown' });
      if (error.code === 'ACCOUNT_SUSPENDED') {
        store.updateAccountHealth?.(account.id, { success: false, error: 'Google has disabled Antigravity for this account (terms of service)' }).catch(() => {});
      }
      return models.peek(account.id)?.models ?? null;
    }
  };

  if (route.kind === 'list' || route.kind === 'get') {
    const list = await accountModels();
    if (!list) {
      sendGoogleError(res, 502, 'the model list could not be read upstream');
      return;
    }
    if (route.kind === 'list') {
      sendJson(res, 200, { models: list.map(publicModel) });
      return;
    }
    const id = resolveGeminiModel(route.model, list);
    const found = list.find((model) => model.id === id);
    if (!found) {
      sendGoogleError(res, 404, `model ${route.model} is not available on this account`);
      return;
    }
    sendJson(res, 200, publicModel(found));
    return;
  }

  const blockedBy = (modelId) => (typeof store.modelBlockRules === 'function'
    ? modelBlockRuleFor(store.modelBlockRules(), modelId)
    : null);
  const refuseBlocked = (modelId, extra = {}) => {
    const rule = blockedBy(modelId);
    if (!rule) return false;
    log('gemini_proxy_model_blocked', { account_id: account.id, device_id: device.id, model: modelId, rule_id: rule.id });
    record({ statusCode: 403, outcome: 'model_blocked', model: modelId, ...extra });
    sendGoogleError(res, 403, modelBlockMessage(rule, modelId));
    return true;
  };
  const streaming = route.kind === 'streamGenerateContent';
  if (route.kind !== 'countTokens' && refuseBlocked(route.model, { stream: streaming })) return;

  if (route.kind !== 'countTokens') {
    if (rateLimited(deviceRequests, device.id, DEVICE_REQUEST_LIMIT)) {
      log('gemini_proxy_device_rate_limited', { device_id: device.id });
      record({ statusCode: 429, outcome: 'rejected', model: route.model });
      sendGoogleError(res, 429, 'device request limit exceeded', { 'Retry-After': '60' });
      return;
    }
    const active = deviceConcurrency.get(device.id) ?? 0;
    if (active >= DEVICE_CONCURRENCY_LIMIT) {
      log('gemini_proxy_device_concurrency_limited', { device_id: device.id, active });
      record({ statusCode: 429, outcome: 'rejected', model: route.model });
      sendGoogleError(res, 429, 'device concurrency limit exceeded', { 'Retry-After': '1' });
      return;
    }
    // The Claude proxy's buckets, shared on purpose: a budget per provider
    // would let one device take more by rotating between them.
    deviceConcurrency.set(device.id, active + 1);
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
  }

  let requestBody;
  try {
    requestBody = await readBody(req, MAX_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error.code === 'BODY_TOO_LARGE';
    if (route.kind !== 'countTokens') {
      record({ statusCode: tooLarge ? 413 : 400, outcome: tooLarge ? 'request_too_large' : 'rejected', model: route.model });
    }
    if (!res.headersSent) sendGoogleError(res, tooLarge ? 413 : 400, tooLarge ? 'request body too large' : 'request body unreadable');
    return;
  }
  if (res.destroyed || !req.complete) {
    if (route.kind !== 'countTokens') record({ statusCode: null, outcome: 'client_disconnected', model: route.model });
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(requestBody.toString('utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (route.kind !== 'countTokens') record({ statusCode: 400, outcome: 'rejected', model: route.model, requestBytes: requestBody.length });
    sendGoogleError(res, 400, 'the request body must be a JSON object');
    return;
  }

  const model = resolveGeminiModel(route.model, await accountModels());
  if (model !== route.model && route.kind !== 'countTokens'
    && refuseBlocked(model, { stream: streaming, requestBytes: requestBody.length })) return;
  await refreshHubVersion({ fetchImpl });

  if (route.kind === 'countTokens') {
    await countTokens(res, { parsed, model, credential, upstreamBaseUrl, fetchImpl });
    return;
  }

  const startedAtMs = now();
  const startedAtMonotonic = performance.now();
  const metricBase = { startedAtMs, startedAtMonotonic, model, stream: streaming, requestBytes: requestBody.length };
  const envelope = JSON.stringify(wrapGeminiRequest(parsed, {
    model,
    projectId: credential.projectId,
    deviceId: device.id,
  }));

  const clientGone = new AbortController();
  res.once('close', () => clientGone.abort());
  const upstreamUrl = `${upstreamBaseUrl.replace(/\/$/, '')}/v1internal:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const send = (accessToken) => fetchImpl(upstreamUrl, {
    method: 'POST',
    headers: geminiUpstreamHeaders(accessToken, { accept: streaming ? 'text/event-stream' : 'application/json' }),
    body: envelope,
    signal: AbortSignal.any([
      clientGone.signal,
      AbortSignal.timeout(streaming ? STREAM_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS),
    ]),
  });

  let upstreamResponse;
  try {
    upstreamResponse = await send(credential.accessToken);
    if (upstreamResponse.status === 401) {
      // An access token can be revoked before it expires; one fresh mint is
      // worth a retry, a second refusal is the answer.
      await upstreamResponse.body?.cancel().catch(() => {});
      tokens.forget(account.id);
      const fresh = await tokens.credentialFor(account.id);
      upstreamResponse = await send(fresh.accessToken);
    }
  } catch (error) {
    if (clientGone.signal.aborted) {
      record({ ...metricBase, statusCode: null, outcome: 'client_disconnected' });
      return;
    }
    const code = error?.name === 'TimeoutError' ? 'timeout' : (error?.code ?? error?.name ?? 'unknown');
    log('gemini_proxy_upstream_failed', { account_id: account.id, device_id: device.id, code });
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error' });
    if (!res.headersSent) sendGoogleError(res, 502, 'upstream request failed');
    return;
  }
  const ttfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));

  if (!upstreamResponse.ok) {
    let body;
    try {
      body = await readBody(upstreamResponse.body ?? [], MAX_RESPONSE_BYTES);
    } catch {
      body = Buffer.from('');
    }
    const text = body.toString('utf8');
    let message = '';
    try {
      message = JSON.parse(text)?.error?.message ?? '';
    } catch {
      message = text.slice(0, 300);
    }
    log('gemini_proxy_upstream_refused', {
      account_id: account.id,
      device_id: device.id,
      status: upstreamResponse.status,
      model,
      message: String(message).slice(0, 300),
    });
    if (isTermsOfServiceBan(upstreamResponse.status, message)) {
      store.updateAccountHealth?.(account.id, { success: false, error: 'Google has disabled Antigravity for this account (terms of service)' }).catch(() => {});
    }
    record({ ...metricBase, statusCode: upstreamResponse.status, outcome: 'upstream_error', ttfbMs, responseBytes: body.length });
    if (res.destroyed) return;
    // Cloud Code's errors are already Google-shaped; a body that is not is
    // replaced so the client can still read a message.
    if (text.trim().startsWith('{')) {
      res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) });
      res.end(body);
    } else {
      sendGoogleError(res, upstreamResponse.status, message || 'upstream refused the request');
    }
    return;
  }

  if (streaming) {
    await relayGeminiStream(res, upstreamResponse, {
      clientGone,
      onDone: ({ outcome, responseBytes, usageMetadata }) => {
        if (outcome === 'upstream_error') log('gemini_proxy_upstream_stream_failed', { account_id: account.id, device_id: device.id });
        if (outcome === 'completed') store.updateAccountHealth?.(account.id, { success: true }).catch(() => {});
        record({
          ...metricBase,
          statusCode: upstreamResponse.status,
          outcome,
          ttfbMs,
          responseBytes,
          usage: geminiUsageSnapshot(usageMetadata),
        });
      },
    });
    return;
  }

  let responseBody;
  try {
    responseBody = await readBody(upstreamResponse.body ?? [], MAX_RESPONSE_BYTES);
  } catch (error) {
    log('gemini_proxy_upstream_body_failed', { account_id: account.id, device_id: device.id, code: error?.code ?? error?.name ?? 'unknown' });
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs });
    if (!res.headersSent) sendGoogleError(res, 502, 'upstream response unreadable');
    return;
  }
  let unwrapped;
  try {
    unwrapped = unwrapResponse(JSON.parse(responseBody.toString('utf8')));
  } catch {
    record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs, responseBytes: responseBody.length });
    sendGoogleError(res, 502, 'upstream response was not JSON');
    return;
  }
  const out = Buffer.from(JSON.stringify(unwrapped));
  store.updateAccountHealth?.(account.id, { success: true }).catch(() => {});
  record({
    ...metricBase,
    statusCode: 200,
    outcome: 'completed',
    ttfbMs,
    responseBytes: out.length,
    usage: geminiUsageSnapshot(unwrapped?.usageMetadata),
  });
  if (res.destroyed) return;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(out.length) });
  res.end(out);
}

/**
 * Re-emit each SSE event with its envelope removed. Events are split on blank
 * lines; a `data:` payload that is not JSON is passed through untouched.
 * Backpressure is honoured, so a slow client slows the upstream read.
 */
export async function relayGeminiStream(res, upstreamResponse, { clientGone, onDone }) {
  let responseBytes = 0;
  let usageMetadata = null;
  let pending = '';
  const decoder = new TextDecoder();

  const write = async (text) => {
    if (res.destroyed || !text) return;
    const bytes = Buffer.from(text, 'utf8');
    responseBytes += bytes.length;
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
  };
  const transformEvent = (event) => {
    const lines = event.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return `${event}\n\n`;
    try {
      const unwrapped = unwrapResponse(JSON.parse(data));
      if (unwrapped?.usageMetadata) usageMetadata = unwrapped.usageMetadata;
      return `data: ${JSON.stringify(unwrapped)}\r\n\r\n`;
    } catch {
      return `${event}\n\n`;
    }
  };

  if (!res.destroyed) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }
  try {
    for await (const chunk of upstreamResponse.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (event.trim()) await write(transformEvent(event));
      }
      if (res.destroyed) break;
    }
    pending += decoder.decode();
    if (pending.trim() && !res.destroyed) await write(transformEvent(pending));
  } catch {
    const outcome = clientGone.signal.aborted || res.destroyed ? 'client_disconnected' : 'upstream_error';
    onDone({ outcome, responseBytes, usageMetadata });
    if (outcome === 'upstream_error') res.destroy();
    return;
  }
  if (res.destroyed) {
    onDone({ outcome: 'client_disconnected', responseBytes, usageMetadata });
    return;
  }
  res.end();
  onDone({ outcome: 'completed', responseBytes, usageMetadata });
}

/**
 * countTokens is advisory — clients use it to decide when to compact — so a
 * refusal upstream is answered with an estimate rather than an error that
 * would stop the client.
 */
async function countTokens(res, { parsed, model, credential, upstreamBaseUrl, fetchImpl }) {
  const contents = parsed.contents ?? parsed.generateContentRequest?.contents ?? [];
  try {
    const response = await fetchImpl(`${upstreamBaseUrl.replace(/\/$/, '')}/v1internal:countTokens`, {
      method: 'POST',
      headers: geminiUpstreamHeaders(credential.accessToken),
      body: JSON.stringify({ request: { model: `models/${model}`, contents } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const body = await response.json();
      if (Number.isSafeInteger(body?.totalTokens)) {
        sendJson(res, 200, { totalTokens: body.totalTokens });
        return;
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
  } catch {
    // Estimated below.
  }
  sendJson(res, 200, { totalTokens: Math.ceil(JSON.stringify(contents).length / 4) });
}
