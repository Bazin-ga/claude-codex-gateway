import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { PassThrough, Transform } from 'node:stream';
import { sendJson } from './http.js';
import { deviceToken } from './device-auth.js';
import { createRequestMetadataTee, REQUEST_METADATA_PREFIX_BYTES } from './request-metadata.js';
import {
  createCompositeResponseObserver,
  createResponseObservationTee,
} from './response-observation.js';
import { createCodexUsageParser } from './codex-usage.js';
import {
  CODEX_GUARD_MODEL_KEYWORD,
  codexGuardAllowsModel,
  guardRestricts,
  normalizeCodexGuard,
} from './codex-model-guard.js';
import {
  creditGuardRefusalBody,
  includedQuotaExhaustion,
  normalizeCodexCreditGuard,
} from './codex-credit-guard.js';
import {
  createModelGateTail,
  createModelJudge,
  modelHeadRefusal,
  readModelPrefix,
} from './model-gate.js';
import {
  MODEL_POLICY_UNCHECKABLE_MESSAGE,
  anyModelBlockRuleEnabled,
  modelBlockMessage,
} from './model-block-rules.js';
import { codexQuotaSignal as defaultQuotaSignal } from './codex-quota-signal.js';
import { API_KEY_DEFAULT_MODELS, apiKeyAllowsModel, apiKeyGuardMessage, isCodexApiKeyAccount, OPENAI_API_BASE_URL } from './codex-api-key.js';
import {
  beginFailover,
  codexQuotaRejection,
  codexRateLimitHeaders,
  quotaExhaustion,
  sendCachedRefusal,
} from './account-failover.js';
import { createCodexResponseContentAssembler } from './codex-response-content.js';
import { codexTurnMetadata, extractCodexPromptCandidate } from './codex-prompt-capture.js';
import {
  AUTH_FAILURE_LIMIT,
  CONVERSATION_PREFIX_BYTES,
  DEVICE_CONCURRENCY_LIMIT,
  DEVICE_REQUEST_LIMIT,
  authFailures,
  captureBudget,
  deviceConcurrency,
  deviceRequests,
  enqueueMetricSafely,
  log,
  passthroughCounter,
  rateLimited,
  responseUsageFormat,
  safeConversationResponse,
  safeUsageSnapshot,
  sourceIp,
  threadKeyForRequest,
  unavailableUsage,
  usageObserver,
} from './proxy.js';

/**
 * The Codex data proxy: a device token in, a subscription turn out.
 *
 * Mounted on its own prefix rather than under `/codex/`, which already carries
 * the operator-facing `/codex/self-service` route. A proxy that shadowed a
 * console route would be a silent outage of whichever one lost.
 *
 * Two things are deliberately *not* shared with the Claude proxy. The forward
 * path is separate code because the wire protocols differ and the Claude path
 * carries effectively all of today's traffic — a Codex-shaped bug must not be
 * able to reach it. The per-device rate-limit buckets, by contrast, *are* the
 * Claude proxy's own: a budget that reset per provider would let one device
 * take double by alternating between them.
 */
export const CODEX_PROXY_PREFIX = '/codex-api';

/**
 * The inference endpoint plus the model catalog the Codex CLI reads from its
 * configured provider base URL. Plugins, analytics and the apps MCP server are
 * reached through `chatgpt_base_url` and have no business borrowing a shared
 * subscription credential through here.
 */
const ALLOWED_REQUESTS = new Map([
  ['/responses', 'POST'],
  ['/models', 'GET'],
]);

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

/** OpenAI-shaped, because that is what a Codex client knows how to read. */
function errorBody(type, message) {
  return { error: { type, message, code: null, param: null } };
}

function forwardHeaders(headers) {
  const allowed = [
    'accept',
    'accept-encoding',
    'content-length',
    'content-type',
    'if-none-match',
    'openai-beta',
    'originator',
    // Observed on a real codex-cli request. These are hyphenated: an earlier
    // `session_id` entry could never match, because Node lower-cases header
    // names but does not translate underscores, so the CLI's session identity
    // was being stripped silently.
    'session-id',
    'thread-id',
    'user-agent',
    'x-client-request-id',
    'x-codex-beta-features',
    // Carried in both directions; the backend appears to use it for turn and
    // cache affinity, and dropping it would cost prompt-cache hits — which show
    // up as a larger billed prompt, not as an error.
    'x-codex-turn-state',
    'x-codex-turn-metadata',
    'x-codex-window-id',
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
    'etag',
    'request-id',
    'retry-after',
    'x-request-id',
    'x-oai-request-id',
    // The client's own quota display and back-off depend on these. Stripping
    // them leaves `codex /status` permanently blank and denies the CLI the one
    // signal that tells it a rate limit was reached rather than a request
    // merely failing.
    'x-codex-active-limit',
    'x-codex-credits-balance',
    'x-codex-primary-used-percent',
    'x-codex-secondary-used-percent',
    'x-codex-rate-limit-reached-type',
    'x-codex-turn-state',
  ];
  return Object.fromEntries(
    allowed
      .filter((name) => headers[name] !== undefined)
      .map((name) => [name, headers[name]]),
  );
}

export class CodexCredentialError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CodexCredentialError';
    this.code = code;
  }
}

/**
 * Read the *published* Codex credential — the same file every enrolled machine
 * pulls, and the same one `usage.js` already reads to report quota.
 *
 * This does not widen the console's trust: by the dispenser's construction that
 * file carries no `refresh_token`, so holding it grants exactly what a client
 * machine holds and nothing that could evict anyone. `refresh_token` is not
 * merely filtered out below — it is never read, so there is no code path here
 * from which it could leak.
 */
export async function readPublishedCodexCredential(account, { readFileImpl = readFile } = {}) {
  if (account?.external?.kind !== 'codex-credential') {
    throw new CodexCredentialError('authorization_required');
  }
  const home = account.external.home;
  if (typeof home !== 'string' || home.length === 0) {
    throw new CodexCredentialError('authorization_required');
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFileImpl(`${home}/public/current.json`, 'utf8'));
  } catch {
    throw new CodexCredentialError('credential_unavailable');
  }
  const accessToken = typeof parsed?.access_token === 'string' ? parsed.access_token : '';
  const accountId = typeof parsed?.account_id === 'string' ? parsed.account_id : '';
  if (!accessToken || !accountId) throw new CodexCredentialError('credential_unavailable');
  const expiresAt = Date.parse(String(parsed?.expires_at ?? ''));
  if (!Number.isFinite(expiresAt)) throw new CodexCredentialError('credential_unavailable');
  return { accessToken, accountId, expiresAtMs: expiresAt };
}

export async function handleCodexProxy(req, res, {
  store,
  upstreamBaseUrl = 'https://chatgpt.com/backend-api/codex',
  openaiApiBaseUrl = OPENAI_API_BASE_URL,
  requestMetrics = null,
  metadataTeeFactory = createRequestMetadataTee,
  responseObservationFactory = createResponseObservationTee,
  codexUsageParserFactory = createCodexUsageParser,
  codexContentAssemblerFactory = createCodexResponseContentAssembler,
  credentialReader = readPublishedCodexCredential,
  quotaSignal = defaultQuotaSignal,
  usageSnapshotFor = () => null,
  exhaustion = quotaExhaustion,
  now = Date.now,
  relay = null,
  apiKeyModels = API_KEY_DEFAULT_MODELS,
}) {
  const requestUrl = new URL(req.url, 'https://credential-console.invalid');
  const upstreamPath = requestUrl.pathname.slice(CODEX_PROXY_PREFIX.length);

  const token = deviceToken(req);
  const device = token ? store.deviceByToken(token) : null;
  if (!device) {
    const ip = sourceIp(req);
    if (rateLimited(authFailures, ip, AUTH_FAILURE_LIMIT)) {
      log('codex_proxy_auth_rate_limited', { ip });
      sendJson(res, 429, errorBody('rate_limit_error', 'too many authentication failures'), {
        'Retry-After': '60',
      });
      return;
    }
    log('codex_proxy_auth_failed', { ip });
    sendJson(res, 401, errorBody('authentication_error', 'unauthorized'));
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

  const recordRejected = (statusCode, outcome = 'rejected', extra = {}) => {
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
      ...extra,
    }, { accountId, deviceId: device.id });
  };

  if (accountResolutionError) {
    log('codex_proxy_device_account_invalid', {
      device_id: device.id,
      account_id: accountId,
      code: accountResolutionError.code ?? accountResolutionError.name ?? 'unknown',
    });
    recordRejected(503);
    sendJson(res, 503, errorBody('api_error', 'device account configuration unavailable'));
    return;
  }
  if (!account || account.provider !== 'codex' || account.status === 'disabled') {
    recordRejected(403);
    sendJson(res, 403, errorBody('permission_error', 'account unavailable'));
    return;
  }
  const allowedMethod = ALLOWED_REQUESTS.get(upstreamPath);
  if (!allowedMethod) {
    recordRejected(404);
    sendJson(res, 404, errorBody('not_found_error', 'unsupported gateway path'));
    return;
  }
  if (req.method !== allowedMethod) {
    recordRejected(405);
    sendJson(res, 405, errorBody('invalid_request_error', 'method not allowed'), {
      Allow: allowedMethod,
    });
    return;
  }
  const inferenceRequest = upstreamPath === '/responses';

  // A turn naming an allowed third-party model goes to that platform instead
  // of to this account; any other turn carries on, with the bytes read to find
  // out put back in front of the body by the gate code below.
  let relayPrefix = null;
  if (relay && inferenceRequest) {
    const relayed = await relay.intercept(req, res, { device, kind: 'responses', path: upstreamPath });
    if (relayed.handled) return;
    relayPrefix = relayed.prefix;
  }

  // Quota failover, decided before the credit guard below: with a usable
  // backup, an account whose included quota is used up is moved off rather
  // than refused or left to spend credits. A backup is only taken when its own
  // included quota is left and its low-quota guard is not biting — the body is
  // judged against the home account's gate, not the backup's.
  const mergedUsage = (id) => quotaSignal.merge(id, usageSnapshotFor(id));
  const failover = inferenceRequest
    ? beginFailover({
      store,
      device,
      account,
      exhaustion,
      usageSnapshotFor: mergedUsage,
      exhaustedBy: (snapshot, at) => includedQuotaExhaustion(snapshot, at) !== null,
      acceptCandidate: (candidate) => {
        const candidateGuard = normalizeCodexGuard(candidate.codex_guard);
        return !(candidateGuard.enabled && guardRestricts(
          candidateGuard,
          quotaSignal.weeklyRemainingPercent(candidate.id, usageSnapshotFor(candidate.id)),
        ));
      },
      log,
      logPrefix: 'codex_proxy',
      now,
    })
    : null;
  if (failover) account = failover.account;

  // The account was refused for quota and has not reset, and no backup can
  // take the request: answer with that refusal now — the same body and headers
  // chatgpt.com sent, so the CLI shows its usual "try again at" — instead of
  // spending a round trip and an upload to collect it again.
  if (failover?.refusal) {
    log('codex_proxy_cached_refusal', {
      account_id: account.id,
      device_id: device.id,
      resets_at: new Date(failover.refusal.until).toISOString(),
    });
    recordRejected(429, 'quota_exhausted_cached');
    res.once('finish', () => {
      if (!req.destroyed) req.destroy();
    });
    sendCachedRefusal(res, failover.refusal, now());
    return;
  }

  // The credit guard, ahead of everything else: once the included quota is
  // gone, every request forwarded is paid for out of the account's credits, so
  // an account that opted out is refused here — before the body is read, a
  // credential is touched or anything reaches chatgpt.com. Only inference is
  // stopped; the model catalog costs nothing.
  if (inferenceRequest && normalizeCodexCreditGuard(account.codex_credit_guard).enabled) {
    const exhaustion = includedQuotaExhaustion(
      quotaSignal.merge(account.id, usageSnapshotFor(account.id)),
      now(),
    );
    if (exhaustion) {
      log('codex_proxy_credits_blocked', {
        account_id: account.id,
        device_id: device.id,
        resets_at: Number.isFinite(exhaustion.resetsAtMs)
          ? new Date(exhaustion.resetsAtMs).toISOString()
          : null,
      });
      recordRejected(429, 'credits_blocked');
      // Nothing of the body was read; closing is what stops the rest of an
      // upload nobody will forward from being drained.
      res.once('finish', () => {
        if (!req.destroyed) req.destroy();
      });
      sendJson(res, 429, creditGuardRefusalBody(exhaustion), { Connection: 'close' });
      return;
    }
  }

  // The model gate, evaluated before anything is acquired: no credential read,
  // no concurrency slot, no upstream socket. A request refused here has cost
  // the account nothing.
  //
  // Two things can close it. The console-wide block rules apply to every
  // account; the low-quota guard applies to an account that opted in, and only
  // while its quota reading is below the threshold. When neither is in force
  // the body is not touched at all, and the request takes exactly the path it
  // took before either existed.
  const guard = normalizeCodexGuard(account.codex_guard);
  const blockRules = inferenceRequest && typeof store.modelBlockRules === 'function'
    ? store.modelBlockRules()
    : [];
  let guardRemainingPercent = null;
  let guardBiting = false;
  // An API-key account has no included quota to read — every token is paid
  // for — so a guard switched on there is always in force.
  const guardAlwaysOn = isCodexApiKeyAccount(account);
  if (inferenceRequest && guard.enabled && guardAlwaysOn) {
    guardBiting = true;
  } else if (inferenceRequest && guard.enabled) {
    const remainingPercent = quotaSignal.weeklyRemainingPercent(
      account.id,
      usageSnapshotFor(account.id),
    );
    if (guardRestricts(guard, remainingPercent)) {
      guardRemainingPercent = remainingPercent;
      guardBiting = true;
    }
  }
  const gated = guardBiting || anyModelBlockRuleEnabled(blockRules);
  const judge = createModelJudge({
    rules: blockRules,
    guardAllows: guardBiting
      ? (guardAlwaysOn ? (model) => apiKeyAllowsModel(model, apiKeyModels) : codexGuardAllowsModel)
      : null,
  });
  // A block rule speaks for itself. Anything else the gate refuses — a model
  // outside the guard, or a body it cannot vouch for — is the guard's refusal
  // when the guard is biting, since that is the rule the caller ran into.
  const refusalOutcome = (refusal) => (refusal.code === 'model_blocked' || !guardBiting
    ? 'model_blocked'
    : 'model_restricted');
  const refusalBody = (refusal) => {
    if (refusal.code === 'model_blocked') {
      return errorBody('permission_error', modelBlockMessage(refusal.rule, refusal.model));
    }
    if (!guardBiting) return errorBody('permission_error', MODEL_POLICY_UNCHECKABLE_MESSAGE);
    if (guardAlwaysOn) return errorBody('permission_error', apiKeyGuardMessage(apiKeyModels));
    return errorBody(
      'permission_error',
      `account weekly quota is ${guardRemainingPercent}% remaining, below this account's ${guard.threshold_percent}% guard; only "${CODEX_GUARD_MODEL_KEYWORD}" models are allowed until it recovers `
      + `(该账号周额度剩余 ${guardRemainingPercent}%，低于设定的 ${guard.threshold_percent}% 阈值，当前仅允许含 ${CODEX_GUARD_MODEL_KEYWORD} 的模型)`,
    );
  };
  const logRefusal = (refusal, model, stage) => {
    log(refusalOutcome(refusal) === 'model_restricted'
      ? 'codex_proxy_model_restricted'
      : 'codex_proxy_model_blocked', {
      account_id: account.id,
      device_id: device.id,
      model,
      code: refusal.code,
      rule_id: refusal.rule?.id ?? null,
      stage,
      remaining_percent: guardRemainingPercent,
      threshold_percent: guardBiting ? guard.threshold_percent : null,
    });
  };
  let gatePrefix = relayPrefix;
  if (gated) {
    gatePrefix ??= await readModelPrefix(req);
    if (gatePrefix.aborted || res.destroyed) {
      log('codex_proxy_client_gone_during_model_read', {
        account_id: account.id,
        device_id: device.id,
      });
      recordRejected(null, 'client_disconnected');
      return;
    }
    // The first `model` decides nothing on its own: everything the gate has
    // read so far has to be something it can vouch for, or a body naming an
    // allowed model first and a refused one second would pass here and run the
    // second upstream.
    const refusal = modelHeadRefusal(gatePrefix, judge, { requireModel: guardBiting });
    if (refusal) {
      // The model the upstream would have run, which is the last one named,
      // not the first — that is the one worth recording.
      const recordedModel = gatePrefix.scanner.snapshot().model ?? gatePrefix.model;
      logRefusal(refusal, recordedModel, 'head');
      recordRejected(403, refusalOutcome(refusal), {
        model: recordedModel,
        requestBytes: gatePrefix.bytes,
      });
      // The body was only read far enough to find the model, so the rest of
      // an upload nobody will forward is still arriving. Closing the
      // connection is what stops it; keeping it alive would leave the server
      // draining megabytes for a request it has already refused.
      res.once('finish', () => {
        if (!req.destroyed) req.destroy();
      });
      sendJson(res, 403, refusalBody(refusal), { Connection: 'close' });
      return;
    }
  }

  // An API-key row carries its key in the store, encrypted, and never expires;
  // every other Codex row reads the credential its refresh home publishes.
  const readCredential = async (target) => {
    if (!isCodexApiKeyAccount(target)) return credentialReader(target);
    const apiKey = store.accountCredential?.(target.id)?.api_key;
    if (!apiKey) throw new CodexCredentialError('credential_unavailable');
    return { apiKey, accountId: null, expiresAtMs: Number.POSITIVE_INFINITY };
  };
  // The two kinds of row talk to different upstreams with different auth.
  const applyUpstreamAuth = (target, cred) => {
    target.authorization = `Bearer ${cred.apiKey ?? cred.accessToken}`;
    if (cred.accountId) target['chatgpt-account-id'] = cred.accountId;
    else delete target['chatgpt-account-id'];
  };

  let credential;
  try {
    credential = await readCredential(account);
  } catch (error) {
    const code = error instanceof CodexCredentialError ? error.code : 'credential_unavailable';
    log('codex_proxy_credential_unavailable', {
      account_id: account.id,
      device_id: device.id,
      code,
    });
    recordRejected(503);
    sendJson(res, 503, errorBody('api_error', code));
    return;
  }
  // Every listener that frees a resource is registered after this point. If the
  // client went away while the awaits above were pending, `res` has already
  // emitted 'close' and every once() below would be waiting on an event that
  // cannot fire again: the concurrency slot would be taken and never released,
  // and that Map is shared with the Claude proxy, so with a concurrency cap
  // configured, that many such cancellations 429 the device on /claude too,
  // until the process restarts. handleClaudeProxy is immune only because its
  // credential read is synchronous.
  //
  // `req.destroyed` is checked only when the gate did not read the body to its
  // end: Node destroys the IncomingMessage the moment a body has been fully
  // consumed, so after a short gated request that flag is true on the
  // *successful* path, and testing it unconditionally would refuse every
  // request the gate let through.
  if (res.destroyed || (!gatePrefix?.ended && req.destroyed)) {
    log('codex_proxy_client_gone_during_credential_read', {
      account_id: account.id,
      device_id: device.id,
    });
    recordRejected(null, 'client_disconnected');
    return;
  }
  if (credential.expiresAtMs <= now()) {
    // Forwarding an expired token buys a 451 from upstream and an opaque client
    // failure; saying so here is diagnosable, and the refresh centre — not this
    // proxy — is what fixes it.
    log('codex_proxy_credential_expired', { account_id: account.id, device_id: device.id });
    recordRejected(503);
    sendJson(res, 503, errorBody('authentication_error', 'account credential expired'));
    return;
  }

  if (rateLimited(deviceRequests, device.id, DEVICE_REQUEST_LIMIT)) {
    log('codex_proxy_device_rate_limited', { device_id: device.id });
    recordRejected(429);
    sendJson(res, 429, errorBody('rate_limit_error', 'device request limit exceeded'), {
      'Retry-After': '60',
    });
    return;
  }
  const activeRequests = deviceConcurrency.get(device.id) ?? 0;
  if (activeRequests >= DEVICE_CONCURRENCY_LIMIT) {
    log('codex_proxy_device_concurrency_limited', { device_id: device.id, active: activeRequests });
    recordRejected(429);
    sendJson(res, 429, errorBody('rate_limit_error', 'device concurrency limit exceeded'), {
      'Retry-After': '1',
    });
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

  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    recordRejected(413, 'request_too_large');
    res.once('finish', () => {
      if (!req.destroyed) req.destroy();
    });
    sendJson(res, 413, errorBody('invalid_request_error', 'request body too large'), {
      Connection: 'close',
    });
    return;
  }

  // Which upstream this attempt goes to. Not fixed for the request: a quota
  // failover can move it from chatgpt.com to the OpenAI API, so the retry
  // re-points all three before it is sent.
  let upstreamApiKey;
  let upstream;
  let transport;
  const headers = forwardHeaders(req.headers);
  const pointUpstreamAt = (target) => {
    upstreamApiKey = isCodexApiKeyAccount(target);
    upstream = new URL(
      `${(upstreamApiKey ? openaiApiBaseUrl : upstreamBaseUrl).replace(/\/$/, '')}${upstreamPath}${requestUrl.search}`,
    );
    transport = upstream.protocol === 'http:' ? http : https;
    headers.host = upstream.host;
  };
  pointUpstreamAt(account);
  applyUpstreamAuth(headers, credential);
  // The client authenticated with a device token; it must never reach upstream.
  // The allow-list above already excludes it and the assignments above override
  // any Authorization the client sent, so this is a second, independent barrier:
  // widening that list later must not silently start forwarding the token.
  delete headers['x-api-key'];

  // chatgpt.com takes a zstd-encoded body — the official CLI sends one whenever
  // it talks to it directly — but a CLI pointed at this gateway sends its whole
  // context as plain JSON on every turn. Compressed here, that upload shrinks
  // several times over, and on a narrow uplink it was the slowest part of the
  // turn. Only toward chatgpt.com (the API-key upstream is not known to take
  // it) and only for a body the client did not already encode.
  const compressBody = inferenceRequest
    && !upstreamApiKey
    && req.headers['content-encoding'] === undefined
    && typeof zlib.createZstdCompress === 'function';
  if (compressBody) {
    delete headers['content-length'];
    headers['content-encoding'] = 'zstd';
  }
  // Where the request body is written: the upstream request itself, or a
  // compressor in front of it.
  const bodySink = (upstreamReq) => {
    if (!compressBody) return upstreamReq;
    const compressor = zlib.createZstdCompress();
    compressor.once('error', (error) => upstreamReq.destroy(error));
    // Every path that abandons a request tears down the upstream request; the
    // compressor in front of it goes with it.
    upstreamReq.once('close', () => compressor.destroy());
    compressor.pipe(upstreamReq);
    upstreamReq.bodySink = compressor;
    return compressor;
  };

  const startedAtMs = now();
  const startedAtMonotonic = performance.now();
  const capturePrompt = inferenceRequest
    && typeof requestMetrics?.enqueueCompletion === 'function';
  const requestMetadata = metadataTeeFactory({
    capturePrompt,
    // Only pay the buffering cost where a prompt can actually be extracted.
    prefixLimit: capturePrompt ? CONVERSATION_PREFIX_BYTES : REQUEST_METADATA_PREFIX_BYTES,
    // The same shared pool the Claude path draws from: two independent budgets
    // would each be within their limit while together exceeding the memory the
    // limit exists to bound.
    budget: captureBudget,
    extractPrompt: extractCodexPromptCandidate,
  });
  // Piping does not tell the tee that its source died; without this an aborted
  // upload keeps its share of the shared pool forever.
  requestMetadata.trackSource(req);
  const requestLimit = passthroughCounter({ maxBytes: MAX_REQUEST_BYTES });

  let responseObservation = null;
  let observationFinished = true;
  let upstreamTtfbMs = null;
  let upstreamStatus = null;
  let upstreamRequestId = null;
  let upstreamEnded = false;
  let clientAborted = false;
  let metricFinalized = false;
  let responseFinished = false;
  // The upstream can answer before the client has finished uploading — a 400 on
  // an oversized context does exactly that. Finalising then would read
  // requestBytes and the model/stream metadata mid-body, undercounting the very
  // numbers this proxy exists to collect.
  let requestBodyFinished = false;
  // Set by whichever failure got there first, so a response that finishes after
  // the fact is not recorded as a clean turn.
  let pendingOutcome = null;
  // When the gate stops a body partway through, the metadata tee has only seen
  // the head and would record the first model named. The one worth recording
  // is the one that got the body stopped.
  let gateRecordedModel = null;

  const finalizeMetric = (outcome, statusCode = upstreamStatus) => {
    if (metricFinalized) return;
    metricFinalized = true;
    if (outcome !== 'completed') responseObservation?.abort?.(outcome);
    let metadata = { requestBytes: requestLimit.bytes(), model: null, stream: null };
    try {
      metadata = { ...metadata, ...requestMetadata.snapshot() };
    } catch (error) {
      log('request_metadata_snapshot_failed', {
        account_id: account.id,
        device_id: device.id,
        code: error?.code ?? error?.name ?? 'unknown',
      });
    }
    let conversation = null;
    if (capturePrompt) {
      try {
        const prompt = requestMetadata.conversationCandidate?.();
        if (prompt?.promptText) {
          const turn = codexTurnMetadata(req.headers);
          // The CLI's own session id, which it also sends as a `session-id`
          // header. Grouping turns into a thread needs nothing more, and the
          // raw id is never stored — threadKeyForSession derives an HMAC.
          const sessionId = turn?.sessionId
            ?? (typeof req.headers['session-id'] === 'string' ? req.headers['session-id'] : null);
          conversation = {
            promptText: prompt.promptText,
            promptBytes: Buffer.byteLength(prompt.promptText, 'utf8'),
            // The Codex CLI sends its preamble as separate input items rather
            // than wrapped around the prompt, so what was extracted is already
            // exactly what the person typed — there is nothing to unwrap and no
            // other source to distinguish.
            promptSource: 'captured_api_user_text',
            promptSuffixOmitted: prompt.suffixOmitted,
            threadKey: threadKeyForRequest(store, device.id, sessionId),
            ...safeConversationResponse(responseObservation),
          };
        }
      } catch (error) {
        log('codex_conversation_capture_failed', {
          account_id: account.id,
          device_id: device.id,
          code: error?.code ?? error?.name ?? 'unknown',
        });
      }
    }
    enqueueMetricSafely(requestMetrics, {
      startedAtMs,
      method: req.method ?? 'UNKNOWN',
      path: upstreamPath,
      deviceId: device.id,
      machineId: device.machine_id ?? null,
      memberLabel: device.member_label,
      accountId: account.id,
      accountAlias: account.alias,
      model: gateRecordedModel ?? metadata.model ?? null,
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
    }, { accountId: account.id, deviceId: device.id, conversation });
  };

  // Usage lands in the terminal SSE event, which can arrive after the last byte
  // has been written to the client. Waiting for both keeps the token counts.
  const finalizeCompletedWhenReady = () => {
    if (responseFinished && observationFinished && requestBodyFinished) {
      finalizeMetric(pendingOutcome ?? 'completed');
    }
  };

  // Only an account that can fail over pays for a copy of the body: it is what
  // a backup is sent, and an account nobody configured keeps streaming
  // straight through exactly as before.
  const MAX_FAILOVERS = 3;
  let failoversUsed = 0;
  const bodyChunks = [];
  const bodyFinishedWaiters = [];
  let bodyCopyFinished = false;
  const bodyCopy = failover?.enabled
    ? new Transform({
      transform(chunk, encoding, callback) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback(null, chunk);
      },
    })
    : null;
  bodyCopy?.once('finish', () => {
    bodyCopyFinished = true;
    for (const waiter of bodyFinishedWaiters.splice(0)) waiter();
  });
  let currentUpstreamReq = null;
  // A 429 is read to its end before anything is decided; it is a few hundred
  // bytes. Past this it is not the refusal being looked for.
  const QUOTA_BODY_MAX_BYTES = 256 * 1024;

  const handleUpstreamResponse = (upstreamRes) => {
    const status = upstreamRes.statusCode ?? 502;
    upstreamTtfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));
    upstreamStatus = status;
    if (status >= 200 && status < 300) {
      if (inferenceRequest) exhaustion.succeeded(account.id, now());
      failover?.recordMove();
    }
    const requestId = upstreamRes.headers['request-id'] ?? upstreamRes.headers['x-request-id'];
    upstreamRequestId = typeof requestId === 'string' ? requestId : null;
    // Free, and an hour fresher than the usage poll: the upstream stamps the
    // account's window usage on every answer. Taken here rather than from the
    // streamed body so it is recorded even when a turn is abandoned halfway.
    quotaSignal.observe(account.id, upstreamRes.headers, now());
    res.writeHead(status, {
      ...responseHeaders(upstreamRes.headers),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    // chatgpt.com returns a streamed turn with *no* content-type header at
    // all — verified against the live endpoint. Gating the parser on that
    // header, as the Claude proxy safely can, meant every Codex row was
    // written with null tokens and usage_state 'unavailable'. Fall back to
    // the parser's own sniffing, which reads the first bytes and yields
    // 'unavailable' harmlessly for anything it cannot make sense of.
    const responseFormat = inferenceRequest && status >= 200 && status < 400
      ? (responseUsageFormat(upstreamRes.headers['content-type']) ?? 'auto')
      : null;
    const observers = [];
    if (responseFormat && requestMetrics?.enqueueRequest) {
      try {
        observers.push(usageObserver(codexUsageParserFactory({ format: responseFormat })));
      } catch (error) {
        log('codex_usage_parser_init_failed', {
          account_id: account.id,
          device_id: device.id,
          code: error?.code ?? error?.name ?? 'unknown',
        });
      }
    }
    if (responseFormat && capturePrompt) {
      try {
        observers.push(codexContentAssemblerFactory());
      } catch (error) {
        log('codex_content_parser_init_failed', {
          account_id: account.id,
          device_id: device.id,
          code: error?.code ?? error?.name ?? 'unknown',
        });
      }
    }
    const observer = observers.length ? createCompositeResponseObserver(observers) : null;
    observationFinished = false;
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
      () => { observationFinished = true; finalizeCompletedWhenReady(); },
      () => { observationFinished = true; finalizeCompletedWhenReady(); },
    );

    upstreamRes.pipe(responseObservation.stream).pipe(res);
    upstreamRes.on('end', () => {
      upstreamEnded = true;
      store.markDeviceSeen?.(device.id)?.catch?.(() => {});
      if (status === 401 || status === 403 || status === 451) {
        // 451 is how this upstream answers a dead or invalid subscription
        // token; surfacing it as an account health fault is the whole point
        // of routing Codex through here.
        store.updateAccountHealth?.(account.id, {
          success: false,
          error: `upstream rejected the subscription credential (${status})`,
        })?.catch?.(() => {});
      } else if (status >= 200 && status < 400) {
        store.updateAccountHealth?.(account.id, { success: true })?.catch?.(() => {});
      }
    });

    const failResponse = (error) => {
      if (upstreamEnded || clientAborted || metricFinalized) return;
      pendingOutcome = 'upstream_error_after_headers';
      log('codex_proxy_failed', {
        account_id: account.id,
        device_id: device.id,
        code: error?.code ?? error?.name ?? 'upstream_response_incomplete',
        duration_ms: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      });
      finalizeMetric('upstream_error_after_headers', status);
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    };
    upstreamRes.once('aborted', () => failResponse(new Error('upstream response aborted')));
    upstreamRes.once('error', failResponse);
    upstreamRes.once('close', () => {
      if (!upstreamEnded && !upstreamRes.complete) {
        failResponse(new Error('upstream response closed before completion'));
      }
    });
  };

  // The refused attempt gets its own row, on the account that refused it.
  const recordFailedOverAttempt = (fromAccount, statusCode) => {
    let model = null;
    try {
      model = requestMetadata.snapshot()?.model ?? null;
    } catch {
      model = null;
    }
    enqueueMetricSafely(requestMetrics, {
      startedAtMs,
      method: req.method ?? 'UNKNOWN',
      path: upstreamPath,
      deviceId: device.id,
      machineId: device.machine_id ?? null,
      memberLabel: device.member_label,
      accountId: fromAccount.id,
      accountAlias: fromAccount.alias,
      model,
      stream: null,
      statusCode,
      outcome: 'quota_failover',
      ttfbMs: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      requestBytes: requestLimit.bytes(),
      responseBytes: 0,
      upstreamRequestId: null,
      ...unavailableUsage(),
    }, { accountId: fromAccount.id, deviceId: device.id });
  };

  // A backup whose credential cannot be read, or has lapsed, is skipped like
  // an exhausted one.
  const nextBackupWithCredential = async () => {
    for (let backup = failover.nextBackup(); backup; backup = failover.nextBackup()) {
      // The body has already been judged against the home account's gate, not
      // this one's. A paid API-key backup with its guard on only takes a model
      // the guard allows; a body whose model is not known yet is not sent.
      if (isCodexApiKeyAccount(backup)
        && normalizeCodexGuard(backup.codex_guard).enabled
        && !apiKeyAllowsModel(requestMetadata.snapshot()?.model ?? null, apiKeyModels)) {
        continue;
      }
      try {
        const backupCredential = await readCredential(backup);
        if (backupCredential.expiresAtMs > now()) return { backup, credential: backupCredential };
      } catch {
        // Try the next one.
      }
    }
    return null;
  };

  const sendUpstream = (bodyBuffer) => {
    if (clientAborted || metricFinalized) return null;
    // Set when this attempt is abandoned for a backup, so the teardown of its
    // socket is not mistaken for a failure of the request.
    let superseded = false;
    // A replay that failed over to the API-key upstream goes uncompressed,
    // like any request that started there.
    const compressPayload = compressBody && !upstreamApiKey;
    const payload = bodyBuffer && compressPayload ? zlib.zstdCompressSync(bodyBuffer) : bodyBuffer;
    const attemptHeaders = payload ? { ...headers, 'content-length': String(payload.length) } : headers;
    // Only a replay can get here with compression switched off after the fact,
    // and a replay always carries its own copy of the headers.
    if (compressBody && !compressPayload) delete attemptHeaders['content-encoding'];
    const upstreamReq = transport.request(
      upstream,
      {
        method: req.method,
        headers: attemptHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upstreamRes) => {
        // Every inference 429 is read, failover or not: whether it is a quota
        // refusal decides whether the account is skipped until it resets.
        if (!inferenceRequest || upstreamRes.statusCode !== 429) {
          if (upstreamRes.statusCode === 429) {
            log('codex_proxy_upstream_rate_limited', {
              account_id: account.id,
              device_id: device.id,
              quota_exhausted: null,
              headers: codexRateLimitHeaders(upstreamRes.headers),
            });
          }
          handleUpstreamResponse(upstreamRes);
          return;
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        const failCollect = (error) => {
          if (settled) return;
          settled = true;
          if (clientAborted || metricFinalized) return;
          log('codex_proxy_upstream_error', {
            account_id: account.id,
            device_id: device.id,
            code: error?.code ?? error?.name ?? 'upstream_response_incomplete',
          });
          finalizeMetric('upstream_error', 502);
          if (!res.headersSent) sendJson(res, 502, errorBody('api_error', 'upstream request failed'));
        };
        const passThrough = (body, rest = null) => {
          // What was read goes to the client as if it had streamed straight
          // through: same status, same headers, same bytes.
          const replayed = new PassThrough();
          replayed.statusCode = upstreamRes.statusCode;
          replayed.headers = upstreamRes.headers;
          replayed.complete = rest === null;
          handleUpstreamResponse(replayed);
          replayed.write(body);
          if (rest) {
            rest.once('end', () => { replayed.complete = true; });
            rest.pipe(replayed);
          } else {
            replayed.end();
          }
        };
        const decide = async () => {
          const body = Buffer.concat(chunks);
          const rejection = codexQuotaRejection(upstreamRes.statusCode, body, {
            contentEncoding: upstreamRes.headers['content-encoding'],
            now: now(),
          });
          log('codex_proxy_upstream_rate_limited', {
            account_id: account.id,
            device_id: device.id,
            quota_exhausted: Boolean(rejection),
            headers: codexRateLimitHeaders(upstreamRes.headers),
          });
          quotaSignal.observe(account.id, upstreamRes.headers, now());
          if (rejection) {
            const entry = exhaustion.mark(account.id, {
              ...rejection,
              reply: { headers: responseHeaders(upstreamRes.headers), body },
            }, now());
            const found = failover?.enabled && failoversUsed < MAX_FAILOVERS
              ? await nextBackupWithCredential()
              : null;
            if (clientAborted || metricFinalized) return;
            if (found) {
              failoversUsed += 1;
              superseded = true;
              const exhausted = account;
              recordFailedOverAttempt(exhausted, upstreamRes.statusCode);
              log('codex_proxy_quota_failover', {
                stage: 'response',
                device_id: device.id,
                from_account_id: exhausted.id,
                to_account_id: found.backup.id,
                claim: rejection.claim,
                resets_at: new Date(entry.until).toISOString(),
              });
              failover.moveTo(found.backup);
              account = found.backup;
              credential = found.credential;
              pointUpstreamAt(account);
              applyUpstreamAuth(headers, credential);
              // Turn affinity belongs to the account that issued it.
              delete headers['x-codex-turn-state'];
              if (!bodyCopyFinished) {
                // Refused before the upload ended: keep reading the client into
                // the copy, but stop feeding a request that is already refused.
                bodyCopy.unpipe(upstreamReq.bodySink ?? upstreamReq);
                upstreamReq.bodySink?.destroy();
                bodyCopy.resume();
                upstreamReq.destroy();
              }
              const replay = () => {
                if (clientAborted || metricFinalized) return;
                sendUpstream(Buffer.concat(bodyChunks));
              };
              if (bodyCopyFinished) replay();
              else bodyFinishedWaiters.push(replay);
              return;
            }
          }
          passThrough(body);
        };
        upstreamRes.on('data', (chunk) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size > QUOTA_BODY_MAX_BYTES) {
            // Too large to be the refusal; stop holding it back.
            settled = true;
            upstreamRes.removeAllListeners('data');
            upstreamRes.pause();
            passThrough(Buffer.concat(chunks), upstreamRes);
          }
        });
        upstreamRes.once('end', () => {
          if (settled) return;
          settled = true;
          decide().catch((error) => {
            settled = false;
            failCollect(error);
          });
        });
        upstreamRes.once('aborted', () => failCollect(new Error('upstream response aborted')));
        upstreamRes.once('error', failCollect);
      },
    );
    currentUpstreamReq = upstreamReq;

    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream request timed out')));
    upstreamReq.on('error', (error) => {
      if (superseded || clientAborted || metricFinalized || upstreamEnded) return;
      if (error.code === 'ERR_REQUEST_BODY_TOO_LARGE') {
        // Destroying the upstream request is how the size guard above surfaces
        // here; answer the client with the real reason, not a generic 502.
        pendingOutcome = 'request_too_large';
        if (!res.headersSent) {
          res.once('finish', () => {
            if (!req.destroyed) req.destroy();
          });
          sendJson(res, 413, errorBody('invalid_request_error', 'request body too large'), {
            Connection: 'close',
          });
        } else if (!res.destroyed) {
          res.destroy(error);
        }
        return;
      }
      log('codex_proxy_upstream_error', {
        account_id: account.id,
        device_id: device.id,
        code: error?.code ?? error?.name ?? 'unknown',
      });
      if (!res.headersSent) {
        finalizeMetric('upstream_error', 502);
        sendJson(res, 502, errorBody('api_error', 'upstream request failed'));
        return;
      }
      finalizeMetric('upstream_error_after_headers');
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    });

    if (payload) {
      upstreamReq.write(payload);
      upstreamReq.end();
    }
    return upstreamReq;
  };

  req.once('aborted', () => {
    clientAborted = true;
    finalizeMetric('client_aborted');
    currentUpstreamReq?.destroy();
  });

  res.once('close', () => {
    if (!responseFinished && !metricFinalized) {
      clientAborted = true;
      finalizeMetric('client_disconnected');
      currentUpstreamReq?.destroy();
    }
  });
  res.once('finish', () => {
    responseFinished = true;
    const outcome = pendingOutcome ?? (upstreamEnded ? 'completed' : 'gateway_response');
    if (outcome === 'completed') {
      finalizeCompletedWhenReady();
      return;
    }
    // The gateway wrote this response itself, so the upstream status is null and
    // res.statusCode is the only true one — a 413 recorded as null would vanish
    // from any dashboard that buckets by status.
    finalizeMetric(outcome, Number.isInteger(res.statusCode) ? res.statusCode : upstreamStatus);
  });

  // The declared-length check above only catches a client that announces an
  // oversized body. A chunked upload declares nothing, so the counter is what
  // actually stops it — and the 'error' it emits has no default handler. Without
  // this listener that error is an uncaughtException, which takes down the whole
  // console process, and with it every in-flight Claude turn. One enrolled Codex
  // device could otherwise stop the gateway at will.
  requestLimit.stream.once('error', (error) => {
    if (error.code !== 'ERR_REQUEST_BODY_TOO_LARGE') return;
    pendingOutcome = 'request_too_large';
    req.unpipe(requestMetadata.stream);
    // Declared further down; by the time a body can overflow it is assigned.
    if (gateTail) req.unpipe(gateTail);
    requestMetadata.stream.destroy();
    if (res.writableFinished) {
      finalizeMetric(pendingOutcome, upstreamStatus);
      if (!req.destroyed) req.destroy();
    } else if (currentUpstreamReq && !currentUpstreamReq.destroyed) {
      currentUpstreamReq.destroy(error);
    } else if (!res.headersSent) {
      // A failover was waiting for this body to finish; there is no live
      // upstream request left to carry the error, so answer here.
      res.once('finish', () => {
        if (!req.destroyed) req.destroy();
      });
      sendJson(res, 413, errorBody('invalid_request_error', 'request body too large'), {
        Connection: 'close',
      });
    }
  });

  requestLimit.stream.once('finish', () => {
    requestBodyFinished = true;
    finalizeCompletedWhenReady();
  });

  const initialUpstreamReq = sendUpstream(null);
  const forwarded = requestMetadata.stream.pipe(requestLimit.stream);
  if (bodyCopy) forwarded.pipe(bodyCopy).pipe(bodySink(initialUpstreamReq));
  else forwarded.pipe(bodySink(initialUpstreamReq));

  // While the gate is closed on anything, the rest of the body is scanned on
  // its way past and a chunk is only forwarded once it has been cleared. A
  // chunk that names a refused model, carries a second `model`, or holds syntax
  // this parser cannot follow is withheld: the upstream is left with an
  // incomplete body it cannot run, and is torn down here before it could.
  let gateTail = null;
  if (gated && gatePrefix && !gatePrefix.ended) {
    gateTail = createModelGateTail(gatePrefix.scanner, judge);
    gateTail.once('error', (error) => {
      req.unpipe(gateTail);
      if (metricFinalized) return;
      const refusal = error?.refusal ?? { code: error?.code ?? 'unknown' };
      gateRecordedModel = gatePrefix.scanner.snapshot().model ?? gatePrefix.model;
      logRefusal(refusal, gateRecordedModel, 'body');
      const outcome = refusalOutcome(refusal);
      pendingOutcome = outcome;
      // Finalized before the upstream is destroyed, so the 'error' that
      // destruction raises finds the metric already written and stays quiet
      // instead of recording a 502.
      finalizeMetric(outcome, 403);
      currentUpstreamReq?.destroy();
      requestMetadata.stream.destroy();
      if (!res.headersSent) {
        res.once('finish', () => {
          if (!req.destroyed) req.destroy();
        });
        sendJson(res, 403, refusalBody(refusal), { Connection: 'close' });
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
    gateTail.pipe(requestMetadata.stream);
  }

  if (gatePrefix?.head) {
    // The bytes the gate consumed while looking for `model` go back in front
    // of the body, before anything else is written, so the upstream sees the
    // request exactly as the client sent it.
    requestMetadata.stream.write(gatePrefix.head);
  }
  if (gatePrefix?.ended) {
    // A body short enough, or model-less enough, that the gate read all of it.
    // The gate stops as soon as it has the model, so this is rare — but the
    // forward path must not quietly depend on that. Piping an
    // already-ended stream attaches to something that will never emit 'data'
    // or 'end' again, and the upstream request would hang until its ten-minute
    // timeout rather than fail.
    requestMetadata.stream.end();
  } else {
    req.pipe(gateTail ?? requestMetadata.stream);
  }
}
