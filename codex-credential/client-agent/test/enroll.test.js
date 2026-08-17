import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat, symlink, link } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { currentToken, machineName, persistEnv, requestEnrollment } from '../enroll.js';

const execFileAsync = promisify(execFile);

/** An HTTPS server with a self-signed cert, recording what each request carried. */
async function startServer({ status = 200, body } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-enroll-test-'));
  const keyPath = path.join(directory, 'server.key');
  const certPath = path.join(directory, 'server.crt');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);

  const requests = [];
  const server = createServer({ key, cert }, (request, response) => {
    let payload = '';
    request.on('data', (chunk) => (payload += chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: payload,
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body ?? { name: 'laptop-01', token: 'minted-machine-token' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    endpoint: `https://127.0.0.1:${server.address().port}`,
    pin: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('a wrong certificate pin sends no request and no enrollment key', async () => {
  const fixture = await startServer();
  try {
    await assert.rejects(
      requestEnrollment({
        endpoint: fixture.endpoint,
        enrollmentKey: 'must-not-leak',
        pin: '0'.repeat(64),
        name: 'laptop-01',
      }),
      /certificate does not match the pin/,
    );
    assert.deepEqual(fixture.requests, []);
  } finally {
    await fixture.close();
  }
});

test('enrollment posts the machine name and returns the minted token', async () => {
  const fixture = await startServer();
  try {
    const issued = await requestEnrollment({
      endpoint: fixture.endpoint,
      enrollmentKey: 'shared-key',
      pin: fixture.pin,
      name: 'laptop-01',
    });

    assert.equal(issued.token, 'minted-machine-token');
    assert.equal(fixture.requests.length, 1);
    const [sent] = fixture.requests;
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/enroll');
    assert.equal(sent.authorization, 'Bearer shared-key');
    assert.deepEqual(JSON.parse(sent.body), { name: 'laptop-01' });
  } finally {
    await fixture.close();
  }
});

test('enrollment reports the machine handle when the caller has one', async () => {
  const fixture = await startServer();
  try {
    await requestEnrollment({
      endpoint: fixture.endpoint,
      enrollmentKey: 'shared-key',
      pin: fixture.pin,
      name: 'laptop-01',
      machineId: 'machine-handle-aaaaaaaaaaaaaaaa',
    });

    assert.deepEqual(JSON.parse(fixture.requests[0].body), {
      name: 'laptop-01',
      machine_id: 'machine-handle-aaaaaaaaaaaaaaaa',
    });
  } finally {
    await fixture.close();
  }
});

test('an unusable handle is dropped rather than blocking the enrollment', async () => {
  const fixture = await startServer();
  try {
    // The console mints for other people's machines and passes none, and a local
    // handle file can be corrupt. Neither may cost this machine its credential:
    // the request goes out without a fingerprint and the server falls back to
    // what it did before fingerprints existed.
    for (const machineId of [null, undefined, '', 'too-short', 'has spaces in it', 42]) {
      const issued = await requestEnrollment({
        endpoint: fixture.endpoint,
        enrollmentKey: 'shared-key',
        pin: fixture.pin,
        name: 'laptop-01',
        machineId,
      });
      assert.equal(issued.token, 'minted-machine-token');
      assert.deepEqual(JSON.parse(fixture.requests.at(-1).body), { name: 'laptop-01' });
    }
  } finally {
    await fixture.close();
  }
});

test('enrollment offers the digest of the token it already holds, never the token', async () => {
  const fixture = await startServer();
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-enroll-env-'));
  const envPath = path.join(directory, 'codex-credential.env');
  const held = 'the-token-this-machine-currently-holds';
  try {
    await persistEnv({ CODEX_CRED_ENDPOINT: 'https://example', CODEX_CRED_TOKEN: held }, envPath);
    delete process.env.CODEX_CRED_TOKEN;
    const previousTokenSha256 = createHash('sha256').update(await currentToken(envPath)).digest('hex');

    await requestEnrollment({
      endpoint: fixture.endpoint,
      enrollmentKey: 'shared-key',
      pin: fixture.pin,
      name: 'laptop-01',
      machineId: 'machine-handle-aaaaaaaaaaaaaaaa',
      previousTokenSha256,
    });

    const sent = JSON.parse(fixture.requests.at(-1).body);
    assert.deepEqual(sent, {
      name: 'laptop-01',
      machine_id: 'machine-handle-aaaaaaaaaaaaaaaa',
      previous_token_sha256: createHash('sha256').update(held).digest('hex'),
    });
    // The digest is proof of the token, never a second copy of it.
    assert.equal(fixture.requests.at(-1).body.includes(held), false);

    // Same rule as the handle: an unusable value is dropped rather than allowed
    // to cost a 400. Tidying an old row matters less than getting a credential.
    for (const bad of [null, undefined, '', 'nope', 'A'.repeat(64), 42]) {
      await requestEnrollment({
        endpoint: fixture.endpoint,
        enrollmentKey: 'shared-key',
        pin: fixture.pin,
        name: 'laptop-01',
        previousTokenSha256: bad,
      });
      assert.deepEqual(JSON.parse(fixture.requests.at(-1).body), { name: 'laptop-01' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await fixture.close();
  }
});

test('the token this machine already holds is read back out of its env file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-enroll-env-'));
  const envPath = path.join(directory, 'codex-credential.env');
  const saved = process.env.CODEX_CRED_TOKEN;
  try {
    delete process.env.CODEX_CRED_TOKEN;
    // A machine enrolling for the first time has nothing to prove and must not
    // be blocked by that: no file, no token, no error.
    assert.equal(await currentToken(envPath), null);

    await persistEnv({
      CODEX_CRED_ENDPOINT: 'https://example',
      CODEX_CRED_CERT_PIN: 'abc',
      CODEX_CRED_TOKEN: 'previously-minted-token',
    }, envPath);
    assert.equal(await currentToken(envPath), 'previously-minted-token');

    // An env file an operator hand-edited into something unusable is "no token",
    // exactly like a missing one.
    await writeFile(envPath, 'CODEX_CRED_ENDPOINT=https://example\nCODEX_CRED_TOKEN=\n');
    assert.equal(await currentToken(envPath), null);

    // A sourced environment wins, because that is the token the process would
    // actually be using.
    process.env.CODEX_CRED_TOKEN = 'token-from-the-environment';
    assert.equal(await currentToken(envPath), 'token-from-the-environment');
  } finally {
    if (saved === undefined) delete process.env.CODEX_CRED_TOKEN;
    else process.env.CODEX_CRED_TOKEN = saved;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a 403 is reported as an operator problem, not a machine one', async () => {
  const fixture = await startServer({ status: 403, body: { error: 'enrollment unavailable' } });
  try {
    await assert.rejects(
      requestEnrollment({
        endpoint: fixture.endpoint,
        enrollmentKey: 'stale-key',
        pin: fixture.pin,
        name: 'laptop-01',
      }),
      /stale.*or enrollment is disabled|refused the enrollment key/s,
    );
  } finally {
    await fixture.close();
  }
});

test('a failed enrollment never copies a secret-bearing response body into errors', async () => {
  const marker = 'fake-refresh-token-must-not-enter-errors';
  const fixture = await startServer({ status: 500, body: { error: marker } });
  try {
    let failure;
    try {
      await requestEnrollment({
        endpoint: fixture.endpoint,
        enrollmentKey: 'shared-key',
        pin: fixture.pin,
        name: 'laptop-01',
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(failure.message, /returned 500 during enrollment/);
    assert.equal(failure.message.includes(marker), false);
  } finally {
    await fixture.close();
  }
});

test('a success-shaped response with no token is rejected', async () => {
  const fixture = await startServer({ body: { name: 'laptop-01' } });
  try {
    await assert.rejects(
      requestEnrollment({
        endpoint: fixture.endpoint,
        enrollmentKey: 'shared-key',
        pin: fixture.pin,
        name: 'laptop-01',
      }),
      /returned no token/,
    );
  } finally {
    await fixture.close();
  }
});

test('a success response cannot inject shell syntax into the persisted device bearer', async () => {
  const fixture = await startServer({ body: { name: 'laptop-01', token: 'abc$(touch-pwned)' } });
  try {
    await assert.rejects(
      requestEnrollment({
        endpoint: fixture.endpoint,
        enrollmentKey: 'shared-key',
        pin: fixture.pin,
        name: 'laptop-01',
      }),
      /returned no token/,
    );
  } finally {
    await fixture.close();
  }
});

test('machine names are sanitised to the pattern the server accepts', () => {
  const PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  for (const raw of ['work-laptop', 'host.local', 'weird name!@#', '---leading', 'ünïcode', 'x'.repeat(200)]) {
    assert.match(machineName(raw), PATTERN, `"${raw}" produced an unusable name`);
  }
  // Nothing usable left over is still a valid name rather than an empty one.
  assert.match(machineName('!!!'), PATTERN);
});

test('persistEnv merges without clobbering unrelated settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-enroll-env-'));
  const envPath = path.join(directory, 'codex-credential.env');
  try {
    await writeFile(envPath, 'CODEX_CRED_RENEW_BELOW_DAYS=2\nCODEX_CRED_TOKEN=old-token\n');
    await persistEnv({ CODEX_CRED_TOKEN: 'new-token', CODEX_CRED_ENDPOINT: 'https://h:8443' }, envPath);

    const lines = (await readFile(envPath, 'utf8')).split('\n').filter(Boolean);
    assert.ok(lines.includes('CODEX_CRED_RENEW_BELOW_DAYS=2'), 'unrelated setting was dropped');
    assert.ok(lines.includes('CODEX_CRED_TOKEN=new-token'));
    assert.ok(lines.includes('CODEX_CRED_ENDPOINT=https://h:8443'));
    assert.equal(lines.filter((l) => l.startsWith('CODEX_CRED_TOKEN=')).length, 1, 'stale token survived');

    // The file holds this machine's bearer token; anything looser than 600 is a leak.
    if (process.platform !== 'win32') {
      assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistEnv rejects line injection, symlink, and hard-link targets without changing a canary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-enroll-env-safety-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, 'credential.env');
  await assert.rejects(
    () => persistEnv({ CODEX_CRED_TOKEN: 'safe\nINJECTED=value' }, envPath),
    /single-line/,
  );
  const canary = path.join(directory, 'canary');
  await writeFile(canary, 'unchanged', { mode: 0o600 });
  await symlink(canary, envPath);
  await assert.rejects(() => persistEnv({ CODEX_CRED_TOKEN: 'safe-token' }, envPath), /symbolic link/);
  await rm(envPath);
  await link(canary, envPath);
  await assert.rejects(() => persistEnv({ CODEX_CRED_TOKEN: 'safe-token' }, envPath), /private regular/);
  assert.equal(await readFile(canary, 'utf8'), 'unchanged');
});
