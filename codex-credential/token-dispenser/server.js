#!/usr/bin/env node
/**
 * token-dispenser — hands short-lived Codex credentials to authenticated machines.
 *
 * The single most important property of this process: it CANNOT leak a refresh
 * token, because it never reads one. It serves `public/current.json`, which the
 * refresh-center populates with the access token alone. That is a structural
 * guarantee rather than an output filter someone could later regress on.
 *
 * Blast radius of a stolen client token is therefore bounded by construction: an
 * access token valid for at most ~10 days, with no way to renew it.
 */

import { createServer } from 'node:https';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from '../refresh-center/lib/credential-store.js';

const HOME = process.env.CODEX_CRED_HOME ?? '/var/lib/codex-credential';
const PORT = Number(process.env.CODEX_CRED_PORT ?? 8443);
const BIND = process.env.CODEX_CRED_BIND ?? '0.0.0.0';
const TLS_CERT = process.env.CODEX_CRED_TLS_CERT ?? join(HOME, 'tls', 'server.crt');
const TLS_KEY = process.env.CODEX_CRED_TLS_KEY ?? join(HOME, 'tls', 'server.key');

const PUBLIC_PATH = join(HOME, 'public', 'current.json');
const CLIENTS_PATH = join(HOME, 'clients', 'clients.json');
const ENROLLMENT_PATH = join(HOME, 'clients', 'enrollment.json');

/** Per-IP request budget. This endpoint is on the public internet. */
const RATE_LIMIT = { windowMs: 60_000, max: 30 };
const hits = new Map();

/**
 * Enrollment gets its own, much tighter budget. Guessing a 256-bit key is
 * infeasible regardless, so this is not the thing standing between an attacker
 * and a token — it bounds abuse and makes a scripted attempt visible in the log
 * rather than buried in normal traffic.
 */
const ENROLL_RATE_LIMIT = { windowMs: 3_600_000, max: 20 };
const enrollHits = new Map();

/** Largest enrollment body accepted. The endpoint is on the public internet. */
const MAX_ENROLL_BODY = 4096;

/** Machine names end up as filesystem-adjacent identifiers in clients.json. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Enrollment mutates clients.json read-modify-write. Two concurrent enrollments
 * would otherwise race and one would silently lose its token — the machine would
 * hold a bearer the server has no record of, and fail with 401 days later.
 */
let writeQueue = Promise.resolve();
function serialized(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

/**
 * Constant-time bearer check against stored SHA-256 digests.
 *
 * Digests rather than plaintext so a leaked clients.json does not hand over
 * working credentials, and constant-time comparison so response latency does not
 * reveal how much of a token was guessed correctly.
 *
 * @returns {Promise<{name: string} | null>}
 */
export async function authenticate(authorization, clientsPath = CLIENTS_PATH) {
  const presented = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
  if (!presented) return null;

  const digest = createHash('sha256').update(presented).digest();

  let clients;
  try {
    clients = JSON.parse(await readFile(clientsPath, 'utf8')).clients ?? [];
  } catch (err) {
    log('clients_unreadable', { error: err.message });
    return null;
  }

  for (const client of clients) {
    if (client.revoked) continue;
    let expected;
    try {
      expected = Buffer.from(client.token_sha256, 'hex');
    } catch {
      continue;
    }
    if (expected.length === digest.length && timingSafeEqual(expected, digest)) {
      return { name: client.name };
    }
  }
  return null;
}

function rateLimitedBy(bucket, limit, ip) {
  const now = Date.now();
  const record = bucket.get(ip);
  if (!record || now - record.since > limit.windowMs) {
    bucket.set(ip, { since: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > limit.max;
}

const rateLimited = (ip) => rateLimitedBy(hits, RATE_LIMIT, ip);
const enrollRateLimited = (ip) => rateLimitedBy(enrollHits, ENROLL_RATE_LIMIT, ip);

// Unbounded growth would be a slow leak under scanning traffic.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT.windowMs;
  for (const [ip, record] of hits) if (record.since < cutoff) hits.delete(ip);
}, RATE_LIMIT.windowMs).unref();

setInterval(() => {
  const cutoff = Date.now() - ENROLL_RATE_LIMIT.windowMs;
  for (const [ip, record] of enrollHits) if (record.since < cutoff) enrollHits.delete(ip);
}, ENROLL_RATE_LIMIT.windowMs).unref();

/** Constant-time compare of a presented secret against a stored hex digest. */
function digestMatches(presented, expectedHex) {
  let expected;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  const digest = createHash('sha256').update(presented).digest();
  return expected.length === digest.length && timingSafeEqual(expected, digest);
}

/** Read at most `MAX_ENROLL_BODY` bytes, then give up rather than buffer forever. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_ENROLL_BODY) {
        req.destroy();
        return reject(new Error('body too large'));
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Self-service enrollment: exchange the shared enrollment key for this machine's
 * own bearer token.
 *
 * Two properties make the shared key survivable if it leaks, which matters
 * because it is distributed in a repository rather than handed over per machine:
 *
 *   1. It mints a token and NOTHING ELSE. This handler never reads
 *      `public/current.json`, so no path through it can return a credential —
 *      the same structural guarantee the process already has for refresh tokens,
 *      rather than a filter someone could later regress on.
 *   2. Every token it mints is per-machine and individually revocable, and each
 *      enrollment is logged with name and IP. A leak is bounded and visible,
 *      and rotating the key (set-enrollment-key.js) does not disturb machines
 *      already enrolled.
 *
 * Re-enrolling an existing name is allowed and revokes that name's previous
 * token. Re-running the installer is therefore safe, and a token that leaked
 * from a machine dies the next time that machine enrolls.
 */
export async function handleEnroll(req, res, { clientsPath, enrollmentPath, ip }) {
  let enrollment;
  try {
    enrollment = JSON.parse(await readFile(enrollmentPath, 'utf8'));
  } catch (err) {
    // No key configured is a deliberate state: enrollment is off until an
    // operator turns it on. Do not distinguish it from a wrong key to callers.
    log('enroll_unconfigured', { ip, error: err.message });
    return send(res, 403, { error: 'enrollment unavailable' });
  }

  const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!presented
    || enrollment.disabled === true
    || typeof enrollment.key_sha256 !== 'string'
    || !digestMatches(presented, enrollment.key_sha256)) {
    log('enroll_denied', { ip });
    return send(res, 403, { error: 'enrollment unavailable' });
  }

  let name;
  try {
    ({ name } = JSON.parse(await readBody(req)) ?? {});
  } catch (err) {
    return send(res, 400, { error: `unreadable body: ${err.message}` });
  }
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return send(res, 400, {
      error: 'name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}',
    });
  }

  const token = await serialized(async () => {
    let db;
    try {
      db = JSON.parse(await readFile(clientsPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      db = { clients: [] };
    }
    db.clients ??= [];

    let replaced = 0;
    for (const client of db.clients) {
      if (client.name === name && !client.revoked) {
        client.revoked = true;
        client.revoked_at = new Date().toISOString();
        client.revoked_reason = 're-enrolled';
        replaced += 1;
      }
    }

    const minted = randomBytes(32).toString('base64url');
    db.clients.push({
      name,
      token_sha256: createHash('sha256').update(minted).digest('hex'),
      added_at: new Date().toISOString(),
      enrolled: true,
    });

    await mkdir(dirname(clientsPath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(clientsPath, `${JSON.stringify(db, null, 2)}\n`);
    log('enrolled', { name, ip, replaced_previous: replaced });
    return minted;
  });

  return send(res, 200, { name, token });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export async function handle(req, res, {
  publicPath = PUBLIC_PATH,
  clientsPath = CLIENTS_PATH,
  enrollmentPath = ENROLLMENT_PATH,
} = {}) {
  const ip = req.socket.remoteAddress ?? 'unknown';

  if (rateLimited(ip)) {
    log('rate_limited', { ip });
    return send(res, 429, { error: 'rate limited' });
  }

  const path = new URL(req.url, 'https://placeholder').pathname;

  if (path === '/enroll') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (enrollRateLimited(ip)) {
      log('enroll_rate_limited', { ip });
      return send(res, 429, { error: 'rate limited' });
    }
    return handleEnroll(req, res, { clientsPath, enrollmentPath, ip });
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

  if (path === '/health') {
    // Deliberately unauthenticated and credential-free: it answers "is the
    // process up", nothing about the credential it holds.
    return send(res, 200, { status: 'ok' });
  }

  if (path !== '/credential') return send(res, 404, { error: 'not found' });

  const client = await authenticate(req.headers.authorization, clientsPath);
  if (!client) {
    log('auth_failed', { ip });
    return send(res, 401, { error: 'unauthorized' });
  }

  let current;
  try {
    current = JSON.parse(await readFile(publicPath, 'utf8'));
  } catch (err) {
    // The center has not published yet, or its storage is broken. Say so plainly
    // rather than serving something stale or empty.
    log('publish_unreadable', { client: client.name, error: err.message });
    return send(res, 503, { error: 'no credential available' });
  }

  const expiresAt = Date.parse(current.expires_at);
  if (typeof current.access_token !== 'string'
    || current.access_token.length === 0
    || !Number.isFinite(expiresAt)) {
    log('publish_invalid', { client: client.name });
    return send(res, 503, { error: 'credential invalid at source' });
  }
  if (expiresAt <= Date.now()) {
    // Serving a token we already know is dead would push the failure onto the
    // client as a mid-turn 451. Refuse here, where it is diagnosable.
    log('publish_expired', { client: client.name, expires_at: current.expires_at });
    return send(res, 503, { error: 'credential expired at source' });
  }

  log('issued', { client: client.name, ip, expires_at: current.expires_at });
  return send(res, 200, {
    access_token: current.access_token,
    id_token: current.id_token,
    account_id: current.account_id,
    expires_at: current.expires_at,
  });
}

async function main() {
  const [cert, key] = await Promise.all([readFile(TLS_CERT), readFile(TLS_KEY)]);

  const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
    handle(req, res).catch((err) => {
      log('handler_error', { error: err.message });
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });

  server.listen(PORT, BIND, () => {
    log('listening', { bind: BIND, port: PORT, home: HOME });
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log('shutting_down', { signal });
      server.close(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  });
}
