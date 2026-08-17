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
 * The optional machine fingerprint an agent reports at enrollment: an opaque
 * random handle the client generated once and kept (client-agent/lib/machine-id.js).
 *
 * Validated like the name — bounded, character-restricted, rejected outright if
 * malformed — because it arrives on the same public endpoint and ends up stored
 * verbatim. It identifies a machine and nothing else: it is not derived from
 * anything about the host or the person using it, and it proves nothing about
 * who is calling.
 */
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The digest of the token the caller currently holds, offered as proof that the
 * row it is replacing is its own.
 *
 * A handle answers "same machine?" only while the machine still has it. A
 * container rebuild, a restored backup, a new OS user or an unwritable
 * `~/.config` all produce a fresh handle on a machine that is emphatically not
 * new — and without this, the row it already owns would stay active forever with
 * nobody able to retire it. The digest is proof rather than inference: only the
 * holder of that token can produce it, so honouring it cannot reopen the
 * name-collision hole the handle exists to close.
 *
 * A digest, never the token: the server already stores exactly this value, so
 * sending it discloses nothing it does not have, and it cannot be replayed as a
 * bearer.
 */
const TOKEN_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

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
 * Re-enrolling is allowed and revokes the caller's previous token, so re-running
 * the installer is safe and a token that leaked from a machine dies the next
 * time that machine enrolls. Identifying "the caller's previous token" is the
 * whole difficulty, and it is decided by exactly two rules:
 *
 *   1. PROOF. If the caller presents `previous_token_sha256` and an active row
 *      carries that digest, that row is revoked, whatever its name or handle.
 *      Only the holder of a token can produce its digest, so this is evidence
 *      rather than a guess — and it is the only thing that retires a row whose
 *      handle the machine has since lost.
 *   2. CLAIM, among the active rows of the same name. A row is claimable when it
 *      carries no handle, or carries the caller's. Which gives, symmetrically:
 *
 *        - two fingerprinted machines never touch each other. Two people who
 *          independently named their machine `laptop` used to evict each other
 *          on every install, silently, with the victim finding out days later as
 *          a 401 mid-turn. Now they coexist, and the overlap is logged as
 *          `enroll_name_shared`;
 *        - a handle-less row is claimed by anyone enrolling under that name,
 *          because that is precisely what the pre-handle rule did with it. This
 *          is what retires the caller's OWN pre-upgrade row on the first run
 *          after an upgrade, and it is why the rollout does not strand a live
 *          token per machine in the fleet. Counted as `reclaimed_legacy`;
 *        - a handle-less caller therefore claims handle-less rows and nothing
 *          else. It no longer evicts fingerprinted machines wholesale, which
 *          during the rollout would have made an un-upgraded agent strictly more
 *          destructive than before.
 *
 * What is left unbounded, honestly: a machine that loses BOTH its handle and its
 * token — a wiped `~/.config`, a container with no persistent home — can prove
 * nothing and claim nothing, so its previous row stays active until it expires
 * with the credential or an operator runs `add-client.js --revoke`. There is no
 * signal here that distinguishes it from a second machine, and inventing one
 * would disconnect machines nobody asked about.
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
  let reportedMachineId;
  let reportedPreviousDigest;
  try {
    ({
      name,
      machine_id: reportedMachineId,
      previous_token_sha256: reportedPreviousDigest,
    } = JSON.parse(await readBody(req)) ?? {});
  } catch (err) {
    return send(res, 400, { error: `unreadable body: ${err.message}` });
  }
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return send(res, 400, {
      error: 'name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}',
    });
  }
  // Absent is a supported shape, not an error: agents installed before this
  // existed keep enrolling. Present-but-malformed is an error, because storing
  // an unvalidated identifier is how one becomes something else later.
  const omitted = reportedMachineId === undefined || reportedMachineId === null;
  if (!omitted && (typeof reportedMachineId !== 'string' || !MACHINE_ID_PATTERN.test(reportedMachineId))) {
    return send(res, 400, {
      error: 'machine_id must match [A-Za-z0-9_-]{16,64}',
    });
  }
  const machineId = omitted ? null : reportedMachineId;
  // Same shape rule as the handle: absent is normal, malformed is refused rather
  // than compared against stored digests as whatever it happens to be.
  const digestOmitted = reportedPreviousDigest === undefined || reportedPreviousDigest === null;
  if (!digestOmitted
    && (typeof reportedPreviousDigest !== 'string' || !TOKEN_DIGEST_PATTERN.test(reportedPreviousDigest))) {
    return send(res, 400, {
      error: 'previous_token_sha256 must be a sha256 hex digest',
    });
  }
  const previousDigest = digestOmitted ? null : reportedPreviousDigest;

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
    let keptSameName = 0;
    let reclaimedLegacy = 0;
    let reclaimedByToken = 0;
    const revoke = (client, reason) => {
      client.revoked = true;
      client.revoked_at = new Date().toISOString();
      client.revoked_reason = reason;
    };
    for (const client of db.clients) {
      if (client.revoked) continue;
      // Rule 1: proof. Matched before the name is even looked at — a machine that
      // renamed itself is still the machine that holds this token.
      if (previousDigest !== null && client.token_sha256 === previousDigest) {
        revoke(client, 're-enrolled');
        reclaimedByToken += 1;
        replaced += 1;
        continue;
      }
      if (client.name !== name) continue;
      // Rule 2: claim. A stored handle that is not the caller's belongs to another
      // machine and is left alone in both directions — a caller reporting no
      // handle has no more right to it than one reporting a different handle.
      const stored = typeof client.machine_id === 'string' ? client.machine_id : null;
      if (stored !== null && stored !== machineId) {
        keptSameName += 1;
        continue;
      }
      // A handle-less row is exactly the row the pre-handle rule would have
      // revoked for this same request, so revoking it keeps the old guarantee
      // without weakening the new one.
      if (stored === null && machineId !== null) reclaimedLegacy += 1;
      revoke(client, 're-enrolled');
      replaced += 1;
    }

    const minted = randomBytes(32).toString('base64url');
    db.clients.push({
      name,
      // Absent means "enrolled by an agent that reports no fingerprint". Nothing
      // rewrites existing rows to add it.
      ...(machineId ? { machine_id: machineId } : {}),
      token_sha256: createHash('sha256').update(minted).digest('hex'),
      added_at: new Date().toISOString(),
      enrolled: true,
    });

    await mkdir(dirname(clientsPath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(clientsPath, `${JSON.stringify(db, null, 2)}\n`);
    log('enrolled', {
      name,
      ip,
      machine_id: machineId,
      replaced_previous: replaced,
      // Split apart because they mean different things to an operator reading
      // the log: one row this machine proved, one row it inherited from before
      // handles existed, and N rows belonging to somebody else left alone.
      reclaimed_by_token: reclaimedByToken,
      reclaimed_legacy: reclaimedLegacy,
      kept_same_name: keptSameName,
    });
    if (keptSameName) {
      // The case the fingerprint exists to make visible: more than one machine
      // is answering to this name. Nothing is broken — say so plainly, since the
      // previous behaviour was to disconnect one of them without a word.
      log('enroll_name_shared', { name, ip, machine_id: machineId, other_active: keptSameName });
    }
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
