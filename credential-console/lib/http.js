import { StringDecoder } from 'node:string_decoder';

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
  const payload = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

export function sendText(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': contentType,
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
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
