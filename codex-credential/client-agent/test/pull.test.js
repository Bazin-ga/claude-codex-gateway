import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fetchCredential, hardenWindowsAcl } from '../pull.js';

const execFileAsync = promisify(execFile);

async function startServer() {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-credential-test-'));
  const keyPath = path.join(directory, 'server.key');
  const certPath = path.join(directory, 'server.crt');
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '1',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const requests = [];
  const server = createServer({ key, cert }, (request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      access_token: 'access',
      id_token: 'identity',
      account_id: 'account',
      expires_at: '2099-01-01T00:00:00.000Z',
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const pin = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
  return {
    directory,
    endpoint: `https://127.0.0.1:${address.port}`,
    pin,
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('a wrong certificate pin sends no HTTP request or bearer token', async () => {
  const fixture = await startServer();
  try {
    await assert.rejects(
      fetchCredential({
        endpoint: fixture.endpoint,
        token: 'must-not-leak',
        pin: '0'.repeat(64),
      }),
      /certificate does not match the pin/,
    );
    assert.deepEqual(fixture.requests, []);
  } finally {
    await fixture.close();
  }
});

test('the bearer is sent after a matching certificate pin', async () => {
  const fixture = await startServer();
  try {
    const credential = await fetchCredential({
      endpoint: fixture.endpoint,
      token: 'expected-client-token',
      pin: fixture.pin,
    });
    assert.equal(credential.access_token, 'access');
    assert.deepEqual(fixture.requests, ['Bearer expected-client-token']);
  } finally {
    await fixture.close();
  }
});

test('Windows ACL hardening uses an encoded non-interactive PowerShell command', async () => {
  let invocation;
  await hardenWindowsAcl('C:\\Users\\test user\\.codex', {
    directory: true,
    execFileImpl(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null);
    },
  });
  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const decoded = Buffer.from(invocation.args[3], 'base64').toString('utf16le');
  assert.match(decoded, /SetAccessRuleProtection\(\$true,\s*\$false\)/);
  assert.match(decoded, /Directory\]::SetAccessControl/);
  assert.match(decoded, /\$Kind='directory'/);
  assert.equal(invocation.options.windowsHide, true);
});

test('Windows ACL applies a protected single-identity rule', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-acl-test-'));
  try {
    await hardenWindowsAcl(directory, { directory: true });
    const target = Buffer.from(directory, 'utf8').toString('base64');
    const script = [
      `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${target}'))`,
      '$acl=[System.IO.Directory]::GetAccessControl($p)',
      '$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.NTAccount])',
      '$explicit=@($rules | Where-Object { -not $_.IsInherited })',
      '[pscustomobject]@{protected=$acl.AreAccessRulesProtected;explicit=$explicit.Count} | ConvertTo-Json -Compress',
    ].join(';');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
    ]);
    assert.deepEqual(JSON.parse(stdout.trim()), { protected: true, explicit: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
