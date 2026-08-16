/**
 * One HTTPS request to the dispenser, with certificate pinning.
 *
 * Shared by `pull.js` (fetch a credential) and `enroll.js` (obtain this machine's
 * bearer token). Deliberately one implementation rather than two: this is the
 * routine that decides whether a secret is handed to the peer, and two copies of
 * that decision drift — one gets hardened, the other quietly does not.
 *
 * The dispenser uses a self-signed certificate: it is reached by IP, so there is
 * no domain to validate and no CA that could vouch for it. Pinning the exact
 * certificate fingerprint is what makes that safe — without it,
 * `rejectUnauthorized: false` would accept literally any certificate and hand the
 * secret to whoever answered.
 *
 * The ordering below is the security property, not a style choice: nothing
 * secret is attached, and `req.end()` is not called, until the peer has passed
 * the pin. A wrong peer therefore receives no HTTP request at all — no
 * Authorization header, no body. `client-agent/test/pull.test.js` asserts exactly
 * that, by observing that a mismatched pin leaves the server with zero requests.
 */

import { request } from 'node:https';
import { createHash } from 'node:crypto';

/**
 * @param {object} options
 * @param {string} options.endpoint  dispenser base URL, e.g. https://203.0.113.10:8443
 * @param {string} options.path      request path, e.g. /credential
 * @param {string} [options.method]  HTTP method (default GET)
 * @param {string} options.pin       SHA-256 of the server certificate, hex
 * @param {string} options.bearer    secret sent only after the pin matches
 * @param {object} [options.json]    request body, serialised as JSON
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{statusCode: number, body: string}>} resolves for any status
 *          the server actually returned; rejects only on transport or pin failure.
 */
export function pinnedRequest({
  endpoint,
  path,
  method = 'GET',
  pin,
  bearer,
  json = null,
  timeoutMs = 30_000,
}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, endpoint);
    const payload = json === null ? null : Buffer.from(JSON.stringify(json), 'utf8');

    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        // Validation is done by the pin check below, not by the CA chain.
        rejectUnauthorized: false,
        // Never reuse a socket whose TLS handshake happened outside this request:
        // the bearer header is attached only after this fresh peer is pinned.
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      },
    );

    req.once('socket', (socket) => {
      socket.once('secureConnect', () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert.raw) throw new Error('server did not present a certificate');
          const actual = createHash('sha256').update(cert.raw).digest('hex');
          const expected = String(pin ?? '').toLowerCase();
          if (actual !== expected) {
            throw new Error(
              'server certificate does not match the pin — refusing to send credentials.\n' +
                `  expected ${expected}\n  got      ${actual}`,
            );
          }

          // Past the pin: only now may anything secret exist on the wire.
          req.setHeader('Authorization', `Bearer ${bearer}`);
          if (payload) {
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('Content-Length', payload.length);
            req.write(payload);
          }
          req.end();
        } catch (error) {
          req.destroy(error);
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}
