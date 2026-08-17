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

/** The rows clients.json holds for a name, newest last. */
async function rowsNamed(paths, name) {
  const db = JSON.parse(await readFile(paths.clientsPath, 'utf8'));
  return db.clients.filter((client) => client.name === name);
}

test('a reported machine fingerprint is recorded on the client row', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const machineId = 'machine-handle-aaaaaaaaaaaaaaaa';

  const response = await enroll(
    paths,
    `Bearer ${ENROLLMENT_KEY}`,
    { name: 'laptop-01', machine_id: machineId },
    'f-1',
  );

  assert.equal(response.status, 200);
  const [row] = await rowsNamed(paths, 'laptop-01');
  assert.equal(row.machine_id, machineId);
  // The handle is not a secret and not a credential, but it must not leak into
  // the response either: the client already knows it, and nothing else should.
  assert.equal(Object.hasOwn(response.body, 'machine_id'), false);
  assert.equal((await request(paths, `Bearer ${response.body.token}`, 'f-2')).status, 200);
});

test('a malformed machine fingerprint is refused outright', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const rejected = [
    'short',                       // below the minimum length
    'x'.repeat(65),                // above the maximum
    'has spaces in it aaaaaaaaaa', // outside the character set
    'semi;colon;injection;aaaaaa',
    42,
    { nested: 'object' },
    ['array'],
    '',
  ];

  for (const [index, machine_id] of rejected.entries()) {
    const response = await enroll(
      paths,
      `Bearer ${ENROLLMENT_KEY}`,
      { name: 'laptop-01', machine_id },
      `f-bad-${index}`,
    );
    assert.equal(response.status, 400, `${JSON.stringify(machine_id)} should have been refused`);
    assert.match(response.body.error, /machine_id/);
  }
  // Nothing was minted or stored for any of them.
  assert.deepEqual(await rowsNamed(paths, 'laptop-01'), []);
});

test('an agent that reports no fingerprint still enrolls', async () => {
  const paths = await fixture({ enrollment: 'enabled' });

  const omitted = await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'old-agent' }, 'f-3');
  const explicitNull = await enroll(
    paths,
    `Bearer ${ENROLLMENT_KEY}`,
    { name: 'null-agent', machine_id: null },
    'f-4',
  );

  assert.equal(omitted.status, 200);
  assert.equal(explicitNull.status, 200);
  assert.equal((await request(paths, `Bearer ${omitted.body.token}`, 'f-5')).status, 200);
  assert.equal((await request(paths, `Bearer ${explicitNull.body.token}`, 'f-6')).status, 200);
  // Absent means legacy. It is never written as null, empty, or anything else.
  for (const name of ['old-agent', 'null-agent']) {
    const [row] = await rowsNamed(paths, name);
    assert.equal(Object.hasOwn(row, 'machine_id'), false);
  }
});

test('re-enrolling the same machine revokes only its own previous token', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const machineId = 'same-machine-handle-bbbbbbbb';

  const first = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop-01', machine_id: machineId }, 'f-7',
  );
  const second = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop-01', machine_id: machineId }, 'f-8',
  );

  assert.notEqual(first.body.token, second.body.token);
  assert.equal((await request(paths, `Bearer ${first.body.token}`, 'f-9')).status, 401);
  assert.equal((await request(paths, `Bearer ${second.body.token}`, 'f-10')).status, 200);

  const revoked = (await rowsNamed(paths, 'laptop-01')).filter((client) => client.revoked);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].revoked_reason, 're-enrolled');
  assert.equal(revoked[0].machine_id, machineId);
});

test('two machines that chose the same name both keep working', async () => {
  const paths = await fixture({ enrollment: 'enabled' });

  // The live defect this fixes: before fingerprints, the second install silently
  // knocked the first machine offline and it found out days later as a 401.
  const alice = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop', machine_id: 'alice-machine-handle-cccccc' }, 'f-11',
  );
  const bob = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop', machine_id: 'bob-machine-handle-dddddddd' }, 'f-12',
  );

  assert.equal((await request(paths, `Bearer ${alice.body.token}`, 'f-13')).status, 200);
  assert.equal((await request(paths, `Bearer ${bob.body.token}`, 'f-14')).status, 200);
  assert.deepEqual(
    (await rowsNamed(paths, 'laptop')).map((client) => Boolean(client.revoked)),
    [false, false],
  );

  // Bob reinstalling still replaces Bob's own token, and still only his.
  const bobAgain = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop', machine_id: 'bob-machine-handle-dddddddd' }, 'f-15',
  );
  assert.equal((await request(paths, `Bearer ${alice.body.token}`, 'f-16')).status, 200);
  assert.equal((await request(paths, `Bearer ${bob.body.token}`, 'f-17')).status, 401);
  assert.equal((await request(paths, `Bearer ${bobAgain.body.token}`, 'f-18')).status, 200);
});

test('a handle-less row is claimed by either kind of caller, a fingerprinted one by nobody else', async () => {
  const paths = await fixture({ enrollment: 'enabled' });

  // The upgrade window. This row was written before fingerprints existed, so it
  // is the enrolling machine's OWN previous row far more often than anyone
  // else's — and it is exactly the row the pre-handle rule revoked here. Leaving
  // it live stranded one permanently-valid token per machine in the fleet, on
  // every rollout, self-healing never.
  const legacy = await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop' }, 'f-19');
  const upgraded = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop', machine_id: 'new-agent-handle-eeeeeeee' }, 'f-20',
  );

  assert.equal((await request(paths, `Bearer ${legacy.body.token}`, 'f-21')).status, 401);
  assert.equal((await request(paths, `Bearer ${upgraded.body.token}`, 'f-22')).status, 200);
  const reclaimed = (await rowsNamed(paths, 'laptop')).find((client) => client.revoked);
  assert.equal(Object.hasOwn(reclaimed, 'machine_id'), false);
  assert.equal(reclaimed.revoked_reason, 're-enrolled');

  // And in the other direction: an un-upgraded agent claims handle-less rows and
  // nothing else. Falling back to "revoke every row of this name" made one stale
  // agent strictly more destructive than before the fingerprint existed — it
  // could evict several fingerprinted machines at once.
  const other = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop', machine_id: 'other-agent-handle-ffffffff' }, 'f-23',
  );
  const stillLegacy = await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop' }, 'f-24');

  assert.equal((await request(paths, `Bearer ${upgraded.body.token}`, 'f-25')).status, 200);
  assert.equal((await request(paths, `Bearer ${other.body.token}`, 'f-26')).status, 200);
  assert.equal((await request(paths, `Bearer ${stillLegacy.body.token}`, 'f-27')).status, 200);

  // A second handle-less enrollment claims the first one's row, which is the
  // pre-handle guarantee, and still nobody else's.
  const legacyAgain = await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'laptop' }, 'f-28');
  assert.equal((await request(paths, `Bearer ${stillLegacy.body.token}`, 'f-29')).status, 401);
  assert.equal((await request(paths, `Bearer ${legacyAgain.body.token}`, 'f-30')).status, 200);
  assert.equal((await request(paths, `Bearer ${upgraded.body.token}`, 'f-31')).status, 200);
  assert.equal((await request(paths, `Bearer ${other.body.token}`, 'f-32')).status, 200);
});

test('a presented token digest retires that exact row, across a lost handle or a rename', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const digestOf = (token) => createHash('sha256').update(token).digest('hex');

  // The machine-id file is gone — a rebuilt container, a restored backup, a new
  // OS user, an unwritable ~/.config — so every run reports a handle the server
  // has never seen. Without proof of the token it already holds, each reinstall
  // would leave the previous one permanently valid.
  let held = (await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'agent-box', machine_id: 'handle-generation-1-aaaaaaaa' }, 'p-1',
  )).body.token;
  const stranded = [held];
  for (const [index, handleValue] of ['handle-generation-2-bbbbbbbb', 'handle-generation-3-cccccccc'].entries()) {
    const issued = await enroll(
      paths,
      `Bearer ${ENROLLMENT_KEY}`,
      { name: 'agent-box', machine_id: handleValue, previous_token_sha256: digestOf(held) },
      `p-${index + 2}`,
    );
    held = issued.body.token;
    stranded.push(held);
  }
  for (const dead of stranded.slice(0, -1)) {
    assert.equal((await request(paths, `Bearer ${dead}`, 'p-4')).status, 401);
  }
  assert.equal((await request(paths, `Bearer ${held}`, 'p-5')).status, 200);
  assert.equal((await rowsNamed(paths, 'agent-box')).filter((client) => !client.revoked).length, 1);

  // Proof beats the name too: a machine that renamed itself still retires its
  // own row rather than accumulating one under every name it ever had.
  const renamed = await enroll(
    paths,
    `Bearer ${ENROLLMENT_KEY}`,
    { name: 'agent-box-renamed', machine_id: 'handle-generation-4-dddddddd', previous_token_sha256: digestOf(held) },
    'p-6',
  );
  assert.equal((await request(paths, `Bearer ${held}`, 'p-7')).status, 401);
  assert.equal((await request(paths, `Bearer ${renamed.body.token}`, 'p-8')).status, 200);
  assert.deepEqual((await rowsNamed(paths, 'agent-box')).map((client) => Boolean(client.revoked)), [true, true, true]);

  // It is proof, not a wildcard: a digest nobody holds matches nothing, and
  // another machine's row is still untouchable without its own token.
  const bystander = await enroll(
    paths, `Bearer ${ENROLLMENT_KEY}`, { name: 'other-box', machine_id: 'bystander-handle-eeeeeeee' }, 'p-9',
  );
  await enroll(
    paths,
    `Bearer ${ENROLLMENT_KEY}`,
    { name: 'third-box', machine_id: 'third-handle-ffffffffffff', previous_token_sha256: digestOf('a-token-nobody-was-issued') },
    'p-10',
  );
  assert.equal((await request(paths, `Bearer ${bystander.body.token}`, 'p-11')).status, 200);
  assert.equal((await request(paths, `Bearer ${renamed.body.token}`, 'p-12')).status, 200);
});

test('a malformed previous token digest is refused rather than compared', async () => {
  const paths = await fixture({ enrollment: 'enabled' });
  const rejected = ['nope', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '', 42, {}, ['a'.repeat(64)]];

  for (const [index, previous_token_sha256] of rejected.entries()) {
    const response = await enroll(
      paths,
      `Bearer ${ENROLLMENT_KEY}`,
      { name: 'laptop-01', previous_token_sha256 },
      `p-bad-${index}`,
    );
    assert.equal(response.status, 400, `${JSON.stringify(previous_token_sha256)} should have been refused`);
    assert.match(response.body.error, /previous_token_sha256/);
  }
  assert.deepEqual(await rowsNamed(paths, 'laptop-01'), []);

  // Absent and explicitly null both stay supported: the console mints on behalf
  // of machines whose token it does not hold, and old agents send neither.
  for (const [index, body] of [{ name: 'laptop-01' }, { name: 'laptop-02', previous_token_sha256: null }].entries()) {
    assert.equal((await enroll(paths, `Bearer ${ENROLLMENT_KEY}`, body, `p-ok-${index}`)).status, 200);
  }
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
