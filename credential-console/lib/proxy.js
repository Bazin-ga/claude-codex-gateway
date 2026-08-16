import http from 'node:http';
import https from 'node:https';
import { bearerToken, sendJson } from './http.js';

const ALLOWED_PATHS = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/models',
]);
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const AUTH_FAILURE_LIMIT = { windowMs: 60_000, max: 30 };
const DEVICE_REQUEST_LIMIT = { windowMs: 60_000, max: 120 };
const DEVICE_CONCURRENCY_LIMIT = 8;
const authFailures = new Map();
const deviceRequests = new Map();
const deviceConcurrency = new Map();

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

function sourceIp(req) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return peer;
  return String(req.headers['x-forwarded-for'] ?? peer).split(',')[0].trim();
}

function rateLimited(bucket, key, limit) {
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

function deviceToken(req) {
  const bearer = bearerToken(req);
  const apiKey = typeof req.headers['x-api-key'] === 'string'
    ? req.headers['x-api-key']
    : null;
  if (bearer && apiKey && bearer !== apiKey) return null;
  return bearer ?? apiKey;
}

export async function handleClaudeProxy(req, res, {
  store,
  upstreamBaseUrl = 'https://api.anthropic.com',
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

  const account = store.accountById(device.account_id);
  if (!account || account.provider !== 'claude' || account.status === 'disabled') {
    sendJson(res, 403, { type: 'error', error: { type: 'permission_error', message: 'account unavailable' } });
    return;
  }
  if (account.expires_at && Date.parse(account.expires_at) <= Date.now()) {
    sendJson(res, 503, { type: 'error', error: { type: 'authentication_error', message: 'account credential expired' } });
    return;
  }

  if (!ALLOWED_PATHS.has(upstreamPath)) {
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
    sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: 'credential unavailable' } });
    return;
  }
  if (!credential?.oauth_token) {
    sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: 'account login required' } });
    return;
  }

  if (rateLimited(deviceRequests, device.id, DEVICE_REQUEST_LIMIT)) {
    log('claude_proxy_device_rate_limited', { device_id: device.id });
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
    sendJson(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: 'request body too large' } });
    return;
  }

  const startedAt = Date.now();
  let bytes = 0;
  let settled = false;
  let upstreamTtfbMs = null;
  const upstreamReq = transport.request(
    upstream,
    {
      method: req.method,
      headers,
      timeout: 10 * 60_000,
    },
    (upstreamRes) => {
      settled = true;
      upstreamTtfbMs = Date.now() - startedAt;
      const status = upstreamRes.statusCode ?? 502;
      res.writeHead(status, {
        ...responseHeaders(upstreamRes.headers),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => {
        log('claude_proxy_complete', {
          account_id: account.id,
          account_alias: account.alias,
          device_id: device.id,
          member_label: device.member_label,
          status,
          upstream_ttfb_ms: upstreamTtfbMs,
          duration_ms: Date.now() - startedAt,
        });
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
    },
  );

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream request timed out')));
  upstreamReq.on('error', (error) => {
    log('claude_proxy_failed', {
      account_id: account.id,
      device_id: device.id,
      error: error.message,
      duration_ms: Date.now() - startedAt,
    });
    if (!settled && !res.headersSent) {
      sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'gateway upstream failure' } });
    } else {
      res.destroy(error);
    }
  });

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      upstreamReq.destroy(new Error('request body too large'));
      req.destroy();
    }
  });
  req.pipe(upstreamReq);
}
