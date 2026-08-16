import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acquireHomeLock } from '../lib/home-lock.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const LOCK_HELPER = join(TEST_DIR, 'home-lock-helper.js');

function runHelper(home, holdMs = 0) {
  return new Promise((resolve) => {
    execFile(process.execPath, [LOCK_HELPER, home, String(holdMs)], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('real concurrent processes cannot both acquire one credential home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-race-'));
  const results = await Promise.all([runHelper(home, 250), runHelper(home, 250)]);
  assert.deepEqual(results.map(({ code }) => code).sort(), [0, 1]);
});

test('a dead owner lock is recovered', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-dead-'));
  await writeFile(join(home, '.owner.lock'), `${JSON.stringify({
    pid: 2147483647,
    role: 'server',
    startIdentity: '1',
  })}\n`);
  const lock = await acquireHomeLock(home, { role: 'test' });
  await lock.release();
});

test('an out-of-range safe-integer pid is treated as dead', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-invalid-pid-'));
  await writeFile(join(home, '.owner.lock'), `${JSON.stringify({
    pid: Number.MAX_SAFE_INTEGER,
    role: 'server',
    startIdentity: '1',
  })}\n`);
  const lock = await acquireHomeLock(home, { role: 'test' });
  await lock.release();
});

test('a genuinely live holder is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-live-'));
  const held = await acquireHomeLock(home, { role: 'live-test' });
  try {
    await assert.rejects(
      acquireHomeLock(home, { role: 'contender' }),
      /pid \d+.*role live-test.*stop the service first/i,
    );
  } finally {
    await held.release();
  }
});

for (const [label, contents] of [
  ['zero-byte', ''],
  ['truncated JSON', '{"pid":'],
  ['valid non-object JSON', '17\n'],
]) test(`${label} owner lock is recovered`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-malformed-'));
  await writeFile(join(home, '.owner.lock'), contents);
  const lock = await acquireHomeLock(home, { role: 'test' });
  await lock.release();
});

test('a directory at the owner lock path is recovered', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-directory-'));
  await mkdir(join(home, '.owner.lock'));
  const lock = await acquireHomeLock(home, { role: 'test' });
  await lock.release();
});

test('an orphaned recovery sidecar does not block stale lock recovery', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-sidecar-'));
  const stale = `${JSON.stringify({ pid: 2147483647, role: 'server', startIdentity: '1' })}\n`;
  await writeFile(join(home, '.owner.lock'), stale);
  await writeFile(join(home, '.owner.lock.recovery'), stale);
  const lock = await acquireHomeLock(home, { role: 'test' });
  await lock.release();
});

test('real concurrent processes racing on a malformed lock have one winner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-malformed-race-'));
  await writeFile(join(home, '.owner.lock'), '{');
  const results = await Promise.all([runHelper(home, 250), runHelper(home, 250)]);
  assert.deepEqual(results.map(({ code }) => code).sort(), [0, 1]);
});

test('a reused live pid with a different start identity is recovered', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-reused-'));
  await writeFile(join(home, '.owner.lock'), `${JSON.stringify({
    pid: process.pid,
    role: 'server',
    startIdentity: 'definitely-not-this-process',
  })}\n`);
  const lock = await acquireHomeLock(home, { role: 'test' });
  await lock.release();
});

test('release makes the credential home immediately acquirable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-lock-release-'));
  const first = await acquireHomeLock(home, { role: 'first' });
  await first.release();
  const second = await acquireHomeLock(home, { role: 'second' });
  await second.release();
});
