import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handle } from '../server.js';

const ENROLLMENT_KEY = 'shared-enrollment-key-long-enough';

async function fixture({ revoked = false, expired = false, enrollment } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dispenser-'));
  const clientsPath = path.join(root, 'clients.json');
  const publicPath = path.join(root, 'current.json');
  const enrollmentPath = path.join(root, 'enrollment.json');
  await writeFile(clientsPath, JSON.stringify({
    clients: [{
      name: 'test-client',
      token_sha256: createHash('sha256').update('valid-token').digest('hex'),
      revoked,
    }],
  }));
  await writeFile(publicPath, JSON.stringify({
    access_token: 'access-only',
    id_token: 'identity',
    account_id: 'account',
    expires_at: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
  }));
  if (enrollment !== undefined) {
    await writeFile(enrollmentPath, JSON.stringify({
      key_sha256: createHash('sha256').update(ENROLLMENT_KEY).digest('hex'),
      created_at: new Date().toISOString(),
      disabled: enrollment === 'disabled',
    }));
  }
  return { clientsPath, publicPath, enrollmentPath };
}

async function malformedFixture(value) {
  const paths = await fixture();
  await writeFile(paths.publicPath, JSON.stringify(value));
  return paths;
}

function collector() {
  const result = {};
  return [result, {
    headersSent: false,
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      result.body = JSON.parse(body);
    },
  }];
}

async function request(paths, authorization, ip) {
  const [result, res] = collector();
  await handle({
    method: 'GET',
    url: '/credential',
    headers: { authorization },
    socket: { remoteAddress: ip },
  }, res, paths);
  return result;
}

/** POST /enroll. The request must be a real stream: the handler reads its body. */
async function enroll(paths, authorization, body, ip, method = 'POST') {
  const [result, res] = collector();
  const req = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]);
  req.method = method;
  req.url = '/enroll';
  req.headers = { authorization };
  req.socket = { remoteAddress: ip };
  await handle(req, res, paths);
  return result;
}

test('dispenser rejects missing, wrong, and revoked bearer tokens', async () => {
  const paths = await fixture();
  assert.equal((await request(paths, undefined, 'test-1')).status, 401);
  assert.equal((await request(paths, 'Bearer wrong', 'test-2')).status, 401);
  const revoked = await fixture({ revoked: true });
  assert.equal((await request(revoked, 'Bearer valid-token', 'test-3')).status, 401);
});

test('dispenser refuses expired source credentials', async () => {
  const paths = await fixture({ expired: true });
  assert.equal((await request(paths, 'Bearer valid-token', 'test-4')).status, 503);
});

test('dispenser returns only the public credential subset', async () => {
  const paths = await fixture();
  const response = await request(paths, 'Bearer valid-token', 'test-5');
  assert.equal(response.status, 200);
  assert.equal(response.body.access_token, 'access-only');
  assert.equal(Object.hasOwn(response.body, 'refresh_token'), false);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('enrollment is refused when unconfigured, disabled, or presented a wrong key', async () => {
  const unconfigured = await fixture();
  assert.equal((await enroll(unconfigured, `Bearer ${ENROLLMENT_KEY}`, { name: 'm' }, 'e-1')).status, 403);

  const disabled = await fixture({ enrollment: 'disabled' });
  assert.equal((await enroll(disabled, `Bearer ${ENROLLMENT_KEY}`, { name: 'm' }, 'e-2')).status, 403);

  const enabled = await fixture({ enrollment: 'enabled' });
  assert.equal((await enroll(enabled, 'Bearer wrong-key', { name: 'm' }, 'e-3')).status, 403);
  assert.equal((await enroll(enabled, undefined, { name: 'm' }, 'e-4')).status, 403);
});

test('enrollment mints a token that then authenticates, and never returns a credential', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const response = await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop-01' }, 'e-5');

  assert.equal(response.status, 200);
  assert.equal(response.body.name, 'laptop-01');
  assert.ok(response.body.token.length > 20);
  // The whole point of the low-privilege key: this path cannot yield a credential.
  assert.equal(Object.hasOwn(response.body, 'access_token'), false);
  assert.equal(Object.hasOwn(response.body, 'refresh_token'), false);

  // The minted token is a real client token, not a decoration.
  const used = await request(paths, `Bearer ${response.body.token}`, 'e-6');
  assert.equal(used.status, 200);
  assert.equal(used.body.access_token, 'access-only');
});

test('re-enrolling a name revokes that name previous token', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const first = await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop-01' }, 'e-7');
  const second = await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop-01' }, 'e-8');

  assert.notEqual(first.body.token, second.body.token);
  assert.equal((await request(paths, `Bearer ${first.body.token}`, 'e-9')).status, 401);
  assert.equal((await request(paths, `Bearer ${second.body.token}`, 'e-10')).status, 200);

  const db = JSON.parse(await readFile(paths.clientsPath, 'utf8'));
  const revoked = db.clients.filter((c) => c.name === 'laptop-01' && c.revoked);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].revoked_reason, 're-enrolled');
});

test('enrollment validates the machine name and the method', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  assert.equal((await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'bad name!' }, 'e-11')).status, 400);
  assert.equal((await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: '' }, 'e-12')).status, 400);
  assert.equal((await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, {}, 'e-13')).status, 400);
  assert.equal((await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, 'not json', 'e-14')).status, 400);
  // A wrong method must not be treated as an enrollment attempt.
  assert.equal((await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'm' }, 'e-15', 'GET')).status, 405);
});

test('concurrent enrollments all persist — no read-modify-write loss', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const names = ['a-1', 'a-2', 'a-3', 'a-4', 'a-5'];
  const issued = await Promise.all(
    names.map((name, i) => enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name }, `c-${i}`)),
  );

  assert.deepEqual(issued.map((r) => r.status), names.map(() => 200));
  for (const [i, response] of issued.entries()) {
    assert.equal((await request(paths, `Bearer ${response.body.token}`, `cu-${i}`)).status, 200);
  }
});

test('dispenser refuses malformed source credentials', async () => {
  const missingToken = await malformedFixture({
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await request(missingToken, 'Bearer valid-token', 'test-6')).status, 503);
  const invalidExpiry = await malformedFixture({
    access_token: 'access',
    expires_at: 'not-a-date',
  });
  assert.equal((await request(invalidExpiry, 'Bearer valid-token', 'test-7')).status, 503);
});
