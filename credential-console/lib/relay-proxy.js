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
import { RELAY_ACCOUNT_ID, RELAY_PROXY_PREFIX, relayBaseUrl } from './relay.js';
import {
  createRelaySourceHealth,
  planRelaySources,
  relayBalanceRefusal,
  relayChainFor,
  relayFailoverStatus,
  relayRequestOnlyStatus,
  relayRequestWithoutThinking,
  relayRequestWithThinkingRestored,
  RELAY_THINKING_REFUSAL,
} from './relay-chain.js';

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

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
 * does. Its prompt tokens include the cached ones; they are taken out here,
 * so input means the same as in the other two formats — what was not cached.
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
    const promptTokens = token(usage.prompt_tokens);
    const cachedTokens = token(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens);
    const inputTokens = promptTokens === null ? null : Math.max(0, promptTokens - (cachedTokens ?? 0));
    const outputTokens = token(usage.completion_tokens);
    return {
      inputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: cachedTokens,
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

/**
 * What ties a request to its conversation: the session id Claude Code and
 * Codex each send. A client that sends neither has no conversation to keep
 * on one source.
 */
function conversationKey(req, device) {
  const id = req.headers['x-claude-code-session-id'] ?? req.headers['session-id'];
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(id) ? `${device.id}:${id}` : null;
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

/**
 * Fixed routes beside the platform: `model=url` entries (comma-, semicolon- or
 * newline-separated) from `CREDENTIAL_CONSOLE_RELAY_ROUTES`. A routed model goes
 * to its own OpenAI/Anthropic-compatible endpoint — typically a self-hosted
 * server reachable only from this host — with no platform key, and is allowed
 * because the deployment named it. `model=other-model` instead sends the turn
 * on as that other model, wherever it goes; it is allowed only while that
 * model is. Malformed entries are skipped, never widened into something else;
 * an unset value means no routes.
 */
export function parseRelayRoutes(value) {
  const routes = new Map();
  for (const entry of String(value ?? '').split(/[,;\n]/)) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const model = entry.slice(0, at).trim();
    const target = entry.slice(at + 1).trim();
    if (!MODEL_NAME.test(model)) continue;
    // A mistyped address (`http:host:port`) stays an address, never a model name.
    if (MODEL_NAME.test(target) && !/^https?:/i.test(target)) {
      routes.set(model, { model: target });
      continue;
    }
    const baseUrl = relayBaseUrl(target);
    if (!baseUrl) continue;
    routes.set(model, { base_url: baseUrl, alias: 'direct' });
  }
  return routes;
}

export function createRelay({
  store,
  catalog = null,
  requestMetrics = null,
  enabled = false,
  fetchImpl = fetch,
  now = Date.now,
  routes = new Map(),
}) {
  const settings = () => store.relaySettings();
  const health = createRelaySourceHealth({ now });
  const platformActive = () => {
    const current = settings();
    return Boolean(current.base_url && current.has_key && current.allowed_models.length);
  };
  /** Chains that can serve: one whose sources are all switched off is as good as absent. */
  const liveChains = () => store.relayChains().filter((chain) => chain.sources.some((source) => source.enabled));
  const active = () => enabled && (routes.size > 0 || platformActive() || liveChains().length > 0);
  /**
   * Where a turn naming `model` goes, and under which name: a chain of
   * sources, a route's own endpoint, else the platform. A renaming route is
   * followed one hop, so the model it names must itself be a chain's, routed
   * to an endpoint or allowed on the platform. Null when the turn is not the
   * relay's.
   */
  const destination = (model) => {
    if (typeof model !== 'string') return null;
    const upstreamModel = routes.get(model)?.model ?? model;
    const chains = liveChains();
    const chain = relayChainFor(chains, model) ?? relayChainFor(chains, upstreamModel);
    if (chain) return { model: chain.model, route: null, chain };
    const route = routes.get(upstreamModel) ?? null;
    if (route) return route.base_url ? { model: upstreamModel, route, chain: null } : null;
    return platformActive() && settings().allowed_models.includes(upstreamModel)
      ? { model: upstreamModel, route: null, chain: null }
      : null;
  };
  const allows = (model) => destination(model) !== null;
  const allowedModels = () => [...new Set([
    ...(platformActive() ? settings().allowed_models : []),
    ...liveChains().flatMap((chain) => [chain.model, ...chain.aliases]),
    ...[...routes.keys()].filter(allows),
  ])];
  const platformAlias = () => `relay:${settings().name ?? 'platform'}`;

  /** A platform source below its balance line. An unread balance is not a low one. */
  const balanceLow = (source) => {
    if (source.kind !== 'platform' || source.min_balance_usd === null) return false;
    const remaining = catalog?.remainingUsd?.() ?? null;
    return remaining !== null && remaining < source.min_balance_usd;
  };
  /** Where a source's requests go, or null while it has nowhere to send them. */
  const sourceEndpoint = (chain, source) => {
    if (source.kind === 'platform') {
      const current = settings();
      const apiKey = store.relayApiKey();
      return current.base_url && apiKey ? { baseUrl: current.base_url, apiKey } : null;
    }
    return {
      baseUrl: source.base_url,
      apiKey: source.has_key ? store.relaySourceApiKey(chain.model, source.id) : null,
    };
  };
  /**
   * The sources a turn may try, in the order it tries them. `fallback` marks
   * the ones that are not the chain's first choice: a conversation served by
   * one of those is held on it.
   */
  const chainCandidates = (chain, conversation) => {
    const usable = [];
    for (const source of chain.sources) {
      if (!source.enabled || balanceLow(source)) continue;
      const endpoint = sourceEndpoint(chain, source);
      if (!endpoint) continue;
      usable.push({
        id: source.id,
        alias: `relay:${source.name}`,
        ...endpoint,
        upstreamModel: source.upstream_model,
        firstByteTimeoutMs: source.first_byte_timeout_s * 1000,
        platform: source.kind === 'platform',
        fallback: usable.length > 0,
      });
    }
    return planRelaySources(usable, { health, pinnedId: health.pinned(conversation) });
  };

  /**
   * Forward one turn whose first bytes may already have been read. Owns the
   * response from here on.
   */
  async function forward(req, res, { device, kind, head = null, ended = false, path, authenticatedAtMs = now() }) {
    const authenticatedAtMonotonic = performance.now();
    const record = ({
      alias = platformAlias(),
      statusCode,
      outcome,
      model = null,
      stream = null,
      requestBytes = 0,
      responseBytes = 0,
      ttfbMs = null,
      startedAtMs = authenticatedAtMs,
      startedAtMonotonic = authenticatedAtMonotonic,
      usage = unavailableUsage(),
    }) => {
      enqueueMetricSafely(requestMetrics, {
        startedAtMs,
        method: req.method ?? 'UNKNOWN',
        path,
        deviceId: device.id,
        machineId: device.machine_id ?? null,
        memberLabel: device.member_label,
        accountId: RELAY_ACCOUNT_ID,
        accountAlias: alias,
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
    const requestedModel = typeof parsed?.model === 'string' ? parsed.model : null;
    const streaming = parsed?.stream === true;
    const target = destination(requestedModel);
    if (!target) {
      log('relay_proxy_model_refused', { device_id: device.id, model: requestedModel });
      record({ statusCode: 403, outcome: 'model_blocked', model: requestedModel, stream: streaming, requestBytes: body.length });
      sendJson(res, 403, errorBody(
        kind,
        'permission_error',
        `model "${requestedModel ?? ''}" is not allowed on the third-party platform; allowed: ${allowedModels().join(', ') || 'none'} `
          + `(第三方模型平台只允许：${allowedModels().join('、') || '无'})`,
      ));
      return;
    }

    // Recorded as the model that ran — for a chain, the one name its sources
    // share — which is what the spend is priced by.
    const { model, route, chain } = target;
    const requestBytes = body.length;
    const conversation = chain ? conversationKey(req, device) : null;
    let candidates;
    if (chain) {
      candidates = chainCandidates(chain, conversation);
    } else {
      const current = route ?? settings();
      const apiKey = route ? null : store.relayApiKey();
      candidates = current.base_url && (route || apiKey)
        ? [{
          id: null,
          alias: route ? `relay:${route.alias}` : platformAlias(),
          baseUrl: current.base_url,
          apiKey,
          upstreamModel: model,
        }]
        : [];
    }
    if (candidates.length === 0) {
      record({
        ...(chain ? {} : { alias: route ? `relay:${route.alias}` : platformAlias() }),
        statusCode: 503,
        outcome: 'rejected',
        model,
        stream: streaming,
        requestBytes,
      });
      sendJson(res, 503, errorBody(kind, 'api_error', chain
        ? `no source of model "${model}" can take requests right now (该模型的所有来源当前均不可用)`
        : 'third-party platform is not configured'));
      return;
    }

    const baseHeaders = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      if (typeof req.headers[name] === 'string') baseHeaders[name] = req.headers[name];
    }
    baseHeaders['content-type'] ??= 'application/json';
    if (kind === 'messages') baseHeaders['anthropic-version'] ??= '2023-06-01';
    const payload = (upstreamModel, request = parsed) => (request === parsed && upstreamModel === requestedModel
      ? body
      : Buffer.from(JSON.stringify({ ...request, model: upstreamModel }), 'utf8'));

    const clientGone = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) clientGone.abort();
    });

    /**
     * One source's turn at the request. True when the response is settled —
     * answered, or the client gone; false when the source failed before
     * anything reached the client and another one is left to try.
     */
    async function attempt(candidate, more) {
      const startedAtMs = now();
      const startedAtMonotonic = performance.now();
      const metricBase = {
        alias: candidate.alias,
        model,
        stream: streaming,
        requestBytes,
        // The first attempt carries the time spent reading the request, as a
        // turn always has; a later one only its own.
        ...(candidate === candidates[0] ? {} : { startedAtMs }),
        startedAtMonotonic,
      };
      const headers = { ...baseHeaders };
      if (candidate.apiKey) {
        headers.authorization = `Bearer ${candidate.apiKey}`;
        if (kind === 'messages') headers['x-api-key'] = candidate.apiKey;
      }
      // A source that has not begun to answer a streaming turn in time is
      // given up on while another can still take it. The wait runs to the
      // first bytes of the answer, not to its headers: a source may accept a
      // turn and then say nothing. Once it has begun, only the whole-stream
      // limit applies.
      const slow = more && streaming && candidate.firstByteTimeoutMs ? new AbortController() : null;
      let slowTimer = null;
      const begun = () => {
        clearTimeout(slowTimer);
        slowTimer = null;
      };
      const send = async (requestBody) => {
        begun();
        if (slow) slowTimer = setTimeout(() => slow.abort(), candidate.firstByteTimeoutMs);
        try {
          return await fetchImpl(`${candidate.baseUrl}${KINDS[kind].upstreamPath}`, {
            method: 'POST',
            headers,
            body: requestBody,
            signal: AbortSignal.any([
              clientGone.signal,
              AbortSignal.timeout(streaming ? STREAM_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS),
              ...(slow ? [slow.signal] : []),
            ]),
          });
        } catch (error) {
          begun();
          throw error;
        }
      };
      const failed = ({ status, reason, balance = false }) => {
        if (candidate.id === null) return;
        log('relay_proxy_source_failed', { device_id: device.id, model, source: candidate.alias, status, reason, failover: more });
        health.failure(candidate.id, { status, reason, balance });
        if (balance && candidate.platform) catalog?.refreshBalance?.().catch(() => {});
      };

      let upstreamResponse;
      try {
        upstreamResponse = await send(payload(candidate.upstreamModel));
      } catch (error) {
        if (clientGone.signal.aborted) {
          record({ ...metricBase, statusCode: null, outcome: 'client_disconnected' });
          return true;
        }
        const code = slow?.signal.aborted
          ? 'first_byte_timeout'
          : (error?.name === 'TimeoutError' ? 'timeout' : (error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown'));
        log('relay_proxy_upstream_failed', { device_id: device.id, model, code });
        failed({ status: null, reason: code });
        record({ ...metricBase, statusCode: 502, outcome: 'upstream_error' });
        if (more) return false;
        if (!res.headersSent) sendJson(res, 502, errorBody(kind, 'api_error', 'third-party platform request failed'));
        return true;
      }

      // A refusal is read whole before anything is decided: what it says
      // settles whether the next source is tried, and the client gets it
      // unchanged if none is.
      let refusal = null;
      if (!upstreamResponse.ok) {
        try {
          refusal = await readRest(upstreamResponse.body ?? [], null, MAX_RESPONSE_BYTES);
        } catch (error) {
          if (clientGone.signal.aborted) {
            record({ ...metricBase, statusCode: null, outcome: 'client_disconnected' });
            return true;
          }
          log('relay_proxy_upstream_body_failed', { device_id: device.id, model, code: error?.code ?? error?.name ?? 'unknown' });
          failed({ status: upstreamResponse.status, reason: slow?.signal.aborted ? 'first_byte_timeout' : 'unreadable' });
          record({ ...metricBase, statusCode: 502, outcome: 'upstream_error' });
          if (more) return false;
          if (!res.headersSent) sendJson(res, 502, errorBody(kind, 'api_error', 'third-party platform response unreadable'));
          return true;
        } finally {
          begun();
        }
        // A conversation moved between a chain's sources may lack the
        // reasoning this one wants passed back. It is asked again with an
        // empty block of reasoning where a turn has none, and failing that
        // without reasoning, rather than not run at all. A model with one
        // source is not rewritten.
        if (chain && upstreamResponse.status === 400 && RELAY_THINKING_REFUSAL.test(refusal.subarray(0, 4096).toString('utf8'))) {
          const rewrites = [
            ['relay_proxy_thinking_restored', relayRequestWithThinkingRestored(kind, parsed)],
            ['relay_proxy_thinking_dropped', relayRequestWithoutThinking(kind, parsed)],
          ];
          for (const [event, rewritten] of rewrites) {
            if (!rewritten) continue;
            try {
              const second = await send(payload(candidate.upstreamModel, rewritten));
              if (second.ok) {
                log(event, { device_id: device.id, model, source: candidate.alias });
                upstreamResponse = second;
                refusal = null;
                break;
              }
              begun();
              await second.body?.cancel().catch(() => {});
            } catch {
              if (clientGone.signal.aborted) {
                record({ ...metricBase, statusCode: null, outcome: 'client_disconnected' });
                return true;
              }
              if (slow?.signal.aborted) {
                failed({ status: null, reason: 'first_byte_timeout' });
                record({ ...metricBase, statusCode: 502, outcome: 'upstream_error' });
                return false;
              }
              // The first answer stands.
              break;
            }
          }
        }
      }

      const ttfbMs = Math.max(0, Math.round(performance.now() - startedAtMonotonic));
      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const responseHeaders = { 'Content-Type': contentType, 'Cache-Control': 'no-store' };
      if (refusal) {
        const status = upstreamResponse.status;
        const elsewhere = relayFailoverStatus(status);
        if (elsewhere && relayRequestOnlyStatus(status)) {
          // Not served here, whatever else is: the source is not rested for it.
          if (chain) log('relay_proxy_source_skipped', { device_id: device.id, model, source: candidate.alias, status, failover: more });
        } else if (elsewhere) {
          const balance = relayBalanceRefusal(status, refusal.subarray(0, 4096).toString('utf8'));
          failed({ status, reason: balance ? 'balance' : 'status', balance });
        }
        record({ ...metricBase, statusCode: status, outcome: 'upstream_error', ttfbMs, responseBytes: refusal.length });
        if (elsewhere && more) return false;
        if (res.destroyed) return true;
        res.writeHead(status, { ...responseHeaders, 'Content-Length': String(refusal.length) });
        res.end(refusal);
        return true;
      }

      const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
      let stream = upstreamResponse.body;
      if (slow && mediaType === 'text/event-stream' && stream) {
        // Nothing has reached the client yet, so a stream that does not start
        // is still another source's to answer.
        const reader = stream.getReader();
        let first;
        let code = 'empty_stream';
        try {
          first = await reader.read();
        } catch (error) {
          code = slow.signal.aborted ? 'first_byte_timeout' : (error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown');
        } finally {
          begun();
        }
        if (!first || first.done) {
          if (clientGone.signal.aborted) {
            record({ ...metricBase, statusCode: null, outcome: 'client_disconnected', ttfbMs });
            return true;
          }
          log('relay_proxy_upstream_failed', { device_id: device.id, model, code });
          failed({ status: upstreamResponse.status, reason: code });
          record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs });
          return false;
        }
        stream = (async function* rest() {
          try {
            yield first.value;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) return;
              yield value;
            }
          } finally {
            reader.cancel().catch(() => {});
          }
        }());
      }
      begun();
      // The answer has begun, so the conversation stays where it was moved to;
      // the source is only cleared of its earlier failures by finishing one.
      if (candidate.fallback) health.pin(conversation, candidate.id);
      const served = () => {
        if (candidate.id !== null) health.success(candidate.id);
      };
      if (mediaType === 'text/event-stream') {
        await relayStream(res, { body: stream }, {
          parser: usageParser(kind, 'sse'),
          clientGone,
          onDone: ({ outcome, statusCode, responseBytes, usage }) => {
            if (outcome === 'completed') served();
            if (outcome === 'upstream_error') {
              log('relay_proxy_upstream_stream_failed', { device_id: device.id, model });
              failed({ status: statusCode, reason: 'stream_broken' });
            }
            record({ ...metricBase, stream: true, statusCode, outcome, ttfbMs, responseBytes, usage });
          },
          headers: responseHeaders,
          status: upstreamResponse.status,
        });
        return true;
      }
      let responseBody;
      try {
        responseBody = await readRest(upstreamResponse.body ?? [], null, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (clientGone.signal.aborted) {
          record({ ...metricBase, statusCode: null, outcome: 'client_disconnected', ttfbMs });
          return true;
        }
        log('relay_proxy_upstream_body_failed', { device_id: device.id, model, code: error?.code ?? error?.name ?? 'unknown' });
        failed({ status: upstreamResponse.status, reason: 'unreadable' });
        record({ ...metricBase, statusCode: 502, outcome: 'upstream_error', ttfbMs });
        if (more) return false;
        if (!res.headersSent) sendJson(res, 502, errorBody(kind, 'api_error', 'third-party platform response unreadable'));
        return true;
      }
      served();
      record({
        ...metricBase,
        statusCode: upstreamResponse.status,
        outcome: 'completed',
        ttfbMs,
        responseBytes: responseBody.length,
        usage: bufferedUsage(kind, responseBody),
      });
      if (res.destroyed) return true;
      res.writeHead(upstreamResponse.status, { ...responseHeaders, 'Content-Length': String(responseBody.length) });
      res.end(responseBody);
      return true;
    }

    for (let index = 0; index < candidates.length; index += 1) {
      if (await attempt(candidates[index], index < candidates.length - 1)) return;
    }
  }

  /**
   * For the console: each chain source's standing right now — resting after
   * a failure, below its balance line, or without an endpoint to send to.
   */
  function sourceStates() {
    const states = new Map();
    for (const chain of store.relayChains()) {
      for (const source of chain.sources) {
        states.set(source.id, {
          ...health.describe(source.id),
          balance_low: balanceLow(source),
          configured: sourceEndpoint(chain, source) !== null,
        });
      }
    }
    return states;
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
        data: (active() ? allowedModels() : []).map((id) => {
          const target = destination(id);
          return { id, object: 'model', created, owned_by: target?.route ? 'direct' : (target?.chain ? 'relay' : (settings().name ?? 'relay')) };
        }),
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

  return { active, allows, intercept, handle, settings, sourceStates };
}
