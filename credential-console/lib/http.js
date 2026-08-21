import { StringDecoder } from 'node:string_decoder';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/**
 * Below this, compression costs more than it saves: the framing overhead is a
 * few dozen bytes and the payload already fits in one segment. It also leaves
 * the proxy's small JSON error bodies alone.
 */
const COMPRESSION_MIN_BYTES = 1024;

/**
 * Quality 5, not 11. Measured on this console's own pages (182 KB home page):
 * q5 saves 90% in 1.6 ms, q11 saves 91% in 109 ms. A hundred milliseconds of
 * synchronous CPU per response would stall every other request on the loop —
 * one extra percent is not worth that. gzip level 6 is the same trade.
 */
const BROTLI_PARAMS = { [constants.BROTLI_PARAM_QUALITY]: 5 };
const GZIP_LEVEL = 6;

/** @returns {'br'|'gzip'|null} the best encoding the client accepted. */
function negotiateEncoding(res) {
  const header = res?.req?.headers?.['accept-encoding'];
  if (!header) return null;
  const accepted = new Set(
    String(header)
      .split(',')
      .map((part) => part.split(';')[0].trim().toLowerCase())
      .filter(Boolean),
  );
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

/**
 * Write a response body, compressed when the client accepts it.
 *
 * Deliberately synchronous: at the levels chosen above it costs 1–2 ms against
 * a render that already costs 5–33 ms, and staying synchronous preserves the
 * "call send*, then return" contract every caller already relies on.
 */
function sendBuffer(res, status, payload, contentType, headers = {}) {
  const preEncoded = Object.keys(headers)
    .some((name) => name.toLowerCase() === 'content-encoding');
  const encoding = preEncoded ? null : negotiateEncoding(res);
  let body = payload;
  const negotiated = {};

  if (encoding && payload.length >= COMPRESSION_MIN_BYTES) {
    try {
      body = encoding === 'br'
        ? brotliCompressSync(payload, { params: BROTLI_PARAMS })
        : gzipSync(payload, { level: GZIP_LEVEL });
      negotiated['Content-Encoding'] = encoding;
    } catch {
      // Never fail a response because it could not be compressed.
      body = payload;
    }
  }

  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': contentType,
    // Set even when this response was not compressed: the URL does vary by
    // Accept-Encoding, and a cache must not serve one form in place of the other.
    Vary: 'Accept-Encoding',
    ...headers,
    // Always ours, never the caller's: a length computed before compression
    // would truncate the response.
    ...negotiated,
    'Content-Length': body.length,
  });
  res.end(body);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const entry of String(header).split(';')) {
    const index = entry.indexOf('=');
    if (index < 1) continue;
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export async function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const decoder = new StringDecoder('utf8');
    let body = '';
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Keep draining the already-flowing request without retaining it. The
        // route can then return a real 413 instead of resetting the socket.
        rejected = true;
        body = '';
        reject(new Error('request body too large'));
        return;
      }
      body += decoder.write(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(body + decoder.end());
    });
    req.on('error', (error) => {
      if (!rejected) {
        rejected = true;
        reject(error);
      }
    });
  });
}

export async function readForm(req, maxBytes) {
  const body = await readBody(req, maxBytes);
  return Object.fromEntries(new URLSearchParams(body));
}

export function baseHeaders({ nonce = null } = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      `style-src 'self' 'unsafe-inline'${nonce ? ` 'nonce-${nonce}'` : ''}`,
      `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

export function sendHtml(res, status, html, headers = {}) {
  sendBuffer(res, status, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8', headers);
}

export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  sendBuffer(res, status, payload, 'application/json; charset=utf-8', headers);
}

export function sendText(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  sendBuffer(res, status, Buffer.from(body, 'utf8'), contentType, headers);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(303, {
    ...baseHeaders(),
    Location: location,
    ...headers,
  });
  res.end();
}

export function bearerToken(req) {
  return /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
}
