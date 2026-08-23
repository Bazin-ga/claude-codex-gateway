import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { sendJson } from './http.js';
import { deviceToken } from './device-auth.js';
import { createRequestMetadataTee, REQUEST_METADATA_PREFIX_BYTES } from './request-metadata.js';
import { createResponseObservationTee } from './response-observation.js';
import { createCodexUsageParser } from './codex-usage.js';
import {
  AUTH_FAILURE_LIMIT,
  DEVICE_CONCURRENCY_LIMIT,
  DEVICE_REQUEST_LIMIT,
  authFailures,
  deviceConcurrency,
  deviceRequests,
  enqueueMetricSafely,
  log,
  passthroughCounter,
  rateLimited,
  responseUsageFormat,
  safeUsageSnapshot,
  sourceIp,
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
 * Only the inference endpoint. The Codex CLI also talks to plugins, analytics
 * and an apps MCP server, but those are reached through `chatgpt_base_url` and
 * have no business borrowing a shared subscription credential through here.
 */
const ALLOWED_PATHS = new Set(['/responses']);

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
    'request-id',
    'retry-after',
    'x-request-id',
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
  requestMetrics = null,
  metadataTeeFactory = createRequestMetadataTee,
  responseObservationFactory = createResponseObservationTee,
  codexUsageParserFactory = createCodexUsageParser,
  credentialReader = readPublishedCodexCredential,
  now = Date.now,
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
  if (!ALLOWED_PATHS.has(upstreamPath)) {
    recordRejected(404);
    sendJson(res, 404, errorBody('not_found_error', 'unsupported gateway path'));
    return;
  }

  let credential;
  try {
    credential = await credentialReader(account);
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
  // The credential read above is this handler's only await, and every listener
  // that frees a resource is registered after it. If the client went away while
  // it was pending, `res` has already emitted 'close' and every once() below
  // would be waiting on an event that cannot fire again: the concurrency slot
  // would be taken and never released, and that Map is shared with the Claude
  // proxy, so after DEVICE_CONCURRENCY_LIMIT such cancellations the device is
  // 429'd on /claude too, until the process restarts. handleClaudeProxy is
  // immune only because its credential read is synchronous.
  if (res.destroyed || req.destroyed) {
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

  const upstream = new URL(
    `${upstreamBaseUrl.replace(/\/$/, '')}${upstreamPath}${requestUrl.search}`,
  );
  const transport = upstream.protocol === 'http:' ? http : https;
  const headers = {
    ...forwardHeaders(req.headers),
    authorization: `Bearer ${credential.accessToken}`,
    'chatgpt-account-id': credential.accountId,
    host: upstream.host,
  };
  // The client authenticated with a device token; it must never reach upstream.
  // The allow-list above already excludes it and the assignments above override
  // any Authorization the client sent, so this is a second, independent barrier:
  // widening that list later must not silently start forwarding the token.
  delete headers['x-api-key'];

  const startedAtMs = now();
  const startedAtMonotonic = performance.now();
  const requestMetadata = metadataTeeFactory({
    capturePrompt: false,
    prefixLimit: REQUEST_METADATA_PREFIX_BYTES,
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
    enqueueMetricSafely(requestMetrics, {
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
    }, { accountId: account.id, deviceId: device.id });
  };

  // Usage lands in the terminal SSE event, which can arrive after the last byte
  // has been written to the client. Waiting for both keeps the token counts.
  const finalizeCompletedWhenReady = () => {
    if (responseFinished && observationFinished && requestBodyFinished) {
      finalizeMetric(pendingOutcome ?? 'completed');
    }
  };

  const upstreamReq = transport.request(
    upstream,
    { method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      upstreamTtfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));
      upstreamStatus = status;
      const requestId = upstreamRes.headers['request-id'] ?? upstreamRes.headers['x-request-id'];
      upstreamRequestId = typeof requestId === 'string' ? requestId : null;
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
      const responseFormat = status >= 200 && status < 400
        ? (responseUsageFormat(upstreamRes.headers['content-type']) ?? 'auto')
        : null;
      let observer = null;
      if (responseFormat && requestMetrics?.enqueueRequest) {
        try {
          observer = usageObserver(codexUsageParserFactory({ format: responseFormat }));
        } catch (error) {
          log('codex_usage_parser_init_failed', {
            account_id: account.id,
            device_id: device.id,
            code: error?.code ?? error?.name ?? 'unknown',
          });
        }
      }
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
    },
  );

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream request timed out')));
  upstreamReq.on('error', (error) => {
    if (clientAborted || metricFinalized || upstreamEnded) return;
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

  req.once('aborted', () => {
    clientAborted = true;
    finalizeMetric('client_aborted');
    upstreamReq.destroy();
  });

  res.once('close', () => {
    if (!responseFinished && !metricFinalized) {
      clientAborted = true;
      finalizeMetric('client_disconnected');
      upstreamReq.destroy();
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
    requestMetadata.stream.destroy();
    if (res.writableFinished) {
      finalizeMetric(pendingOutcome, upstreamStatus);
      if (!req.destroyed) req.destroy();
    } else if (!upstreamReq.destroyed) {
      upstreamReq.destroy(error);
    }
  });

  requestLimit.stream.once('finish', () => {
    requestBodyFinished = true;
    finalizeCompletedWhenReady();
  });

  req.pipe(requestMetadata.stream).pipe(requestLimit.stream).pipe(upstreamReq);
}
