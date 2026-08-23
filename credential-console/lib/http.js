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

/**
 * @returns {'br'|'gzip'|null} the best encoding the client accepted.
 *
 * Honours q-values. `br;q=0` is how RFC 9110 §12.5.3 says "I cannot decode
 * this" — some proxies and gzip-only HTTP clients send exactly that, and
 * reading it as acceptance hands them a body they cannot read.
 */
export function negotiateEncoding(acceptEncoding) {
  if (!acceptEncoding) return null;
  const weights = new Map();
  for (const part of String(acceptEncoding).split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const q = params
      .map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1])
      .find((value) => value !== undefined);
    const weight = q === undefined ? 1 : Number(q);
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const acceptable = (name) => {
    const explicit = weights.get(name);
    if (explicit !== undefined) return explicit > 0;
    // A wildcard only stands in for encodings the client did not name.
    const wildcard = weights.get('*');
    return wildcard !== undefined && wildcard > 0;
  };
  if (acceptable('br')) return 'br';
  if (acceptable('gzip')) return 'gzip';
  return null;
}

/** Compress `payload` for `encoding`, or return it unchanged on failure. */
export function compressFor(encoding, payload) {
  if (!encoding) return payload;
  try {
    return encoding === 'br'
      ? brotliCompressSync(payload, { params: BROTLI_PARAMS })
      : gzipSync(payload, { level: GZIP_LEVEL });
  } catch {
    return payload;
  }
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
  const encoding = preEncoded
    ? null
    : negotiateEncoding(res?.req?.headers?.['accept-encoding']);
  let body = payload;
  const negotiated = {};

  if (encoding && payload.length >= COMPRESSION_MIN_BYTES) {
    const compressed = compressFor(encoding, payload);
    if (compressed !== payload) {
      body = compressed;
      negotiated['Content-Encoding'] = encoding;
    }
  }

  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': contentType,
    // Set even when this response was not compressed: the URL does vary by
    // Accept-Encoding, and a cache must not serve one form in place of the other.
    Vary: 'Accept-Encoding, X-Fragment',
    ...headers,
    // Always ours, never the caller's: a length computed before compression
    // would truncate the response.
    ...negotiated,
    'Content-Length': body.length,
  });
  res.end(body);
}

/**
 * Sentinels around the per-page region of the document.
 *
 * Navigation can then re-render one page inside the existing document instead
 * of replacing it, without every view function having to learn about it: the
 * page is rendered exactly as always and the region is sliced out afterwards.
 * String markers rather than parsing, so the boundary is exact and cannot be
 * confused by user content that happens to contain similar markup.
 */
export const PAGE_CONTENT_START = '<!--page-content-->';
export const PAGE_CONTENT_END = '<!--/page-content-->';

/**
 * @returns {{content: string, title: string, scripts: object[]}|null}
 *
 * `scripts` matters because a page's script tags live in the document head, not
 * in the region being swapped: /metrics loads the chart bundle there, so a
 * navigation that only replaced the region would show an empty chart frame.
 */
export function extractPageContent(html) {
  const start = html.indexOf(PAGE_CONTENT_START);
  const end = html.lastIndexOf(PAGE_CONTENT_END);
  if (start === -1 || end === -1 || end < start) return null;
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  // Which tab is current is the server's answer, not something the client can
  // infer: /conversation-turns and /conversations are siblings, so no prefix
  // rule relates them, and guessing wrong removes a highlight already correct.
  const activeTab = /data-active-tab="([^"]*)"/.exec(html)?.[1] ?? '';
  const scripts = [];
  for (const tag of html.slice(0, start).match(/<script\b[^>]*src="[^"]+"[^>]*>/g) ?? []) {
    const src = /src="([^"]+)"/.exec(tag)?.[1];
    if (!src) continue;
    scripts.push({
      src,
      // Carried through so an injected tag keeps the same guarantees as one the
      // document would have shipped.
      integrity: /integrity="([^"]+)"/.exec(tag)?.[1] ?? null,
      crossorigin: /crossorigin="([^"]+)"/.exec(tag)?.[1] ?? null,
    });
  }
  return { content: html.slice(start + PAGE_CONTENT_START.length, end), title, scripts, activeTab };
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
  // A navigation asks for just the page region: same document, new page. The
  // page was rendered exactly as it always is; only the slice differs, so a
  // boosted navigation and a real one cannot drift apart.
  if (res?.req?.headers?.['x-fragment'] === 'page') {
    const page = extractPageContent(html);
    if (page) {
      sendBuffer(res, status, Buffer.from(page.content, 'utf8'), 'text/html; charset=utf-8', {
        ...headers,
        // Header-safe for any title, including CJK.
        'X-Page-Title': encodeURIComponent(page.title),
        'X-Page-Scripts': encodeURIComponent(JSON.stringify(page.scripts)),
        'X-Active-Tab': page.activeTab,
      });
      return;
    }
  }
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
