import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { SHUTDOWN_DEADLINE_MS } from '../server.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = '.owner.lock';

function spawnServer(t, home) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CREDENTIAL_CONSOLE_HOME: home,
      CREDENTIAL_CONSOLE_PORT: '0',
      CREDENTIAL_CONSOLE_COOKIE_SECURE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, exited, stderr: () => stderr };
}

async function waitForListening(server) {
  const { child, exited, stderr } = server;
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`timed out waiting for listening event: ${stderr()}`));
    }, 3_000);
    const onData = (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'credential_console_listening') {
            finish(resolve, event);
            return;
          }
        } catch {}
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    exited.then(({ code }) => {
      if (stderr().includes('listen EPERM')) finish(resolve, null);
      else finish(reject, new Error(`server exited early (${code}): ${stderr()}`));
    });
  });
}

function skipIfLoopbackForbidden(t, listening) {
  if (listening) return false;
  const reason = 'environment cannot run this test: sandbox does not permit loopback listeners (listen EPERM)';
  if (process.env.CREDENTIAL_CONSOLE_TEST_ALLOW_SKIP !== '1') {
    assert.fail(`${reason}; set CREDENTIAL_CONSOLE_TEST_ALLOW_SKIP=1 to skip explicitly`);
  }
  t.diagnostic(`${reason}; skipping because CREDENTIAL_CONSOLE_TEST_ALLOW_SKIP=1`);
  t.skip(reason);
  return true;
}

async function assertCleanExit(server) {
  const result = await server.exited;
  assert.equal(result.signal, null, server.stderr());
  assert.equal(result.code, 0, server.stderr());
}

test('shutdown grace period is short relative to systemd RestartSec', () => {
  assert.equal(SHUTDOWN_DEADLINE_MS, 1_000);
});

test('listening event reports the actual ephemeral port', { timeout: 10_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-shutdown-'));
  await new CredentialStore(home, { allowKeyInit: true }).init();
  const server = spawnServer(t, home);
  const listening = await waitForListening(server);
  if (skipIfLoopbackForbidden(t, listening)) return;
  assert.ok(listening.port > 0);
  assert.equal(listening.public_url, `https://127.0.0.1:${listening.port}`);
  server.child.kill('SIGTERM');
  await assertCleanExit(server);
});

test('SIGTERM releases the home lock with no open connection', { timeout: 10_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-shutdown-'));
  await new CredentialStore(home, { allowKeyInit: true }).init();
  const server = spawnServer(t, home);
  const listening = await waitForListening(server);
  if (skipIfLoopbackForbidden(t, listening)) return;
  server.child.kill('SIGTERM');
  await assertCleanExit(server);
  await assert.rejects(access(join(home, LOCK_PATH)), { code: 'ENOENT' });
});

test('SIGTERM bounds shutdown and releases the home lock with an open request', { timeout: 10_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-shutdown-'));
  await new CredentialStore(home, { allowKeyInit: true }).init();
  const server = spawnServer(t, home);
  const listening = await waitForListening(server);
  if (skipIfLoopbackForbidden(t, listening)) return;
  const socket = net.connect(listening.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
  const started = Date.now();
  server.child.kill('SIGTERM');
  await assertCleanExit(server);
  const elapsed = Date.now() - started;
  socket.destroy();
  assert.ok(elapsed >= SHUTDOWN_DEADLINE_MS, 'open request did not exercise the shutdown deadline');
  assert.ok(elapsed < 2_500, 'shutdown exceeded its bounded deadline');
  await assert.rejects(access(join(home, LOCK_PATH)), { code: 'ENOENT' });
});
