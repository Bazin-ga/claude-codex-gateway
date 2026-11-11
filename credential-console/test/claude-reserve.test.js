import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeProxy } from '../lib/proxy.js';
import { CredentialStore } from '../lib/store.js';
import { QuotaExhaustion } from '../lib/account-failover.js';
import { ClaudeQuotaSignal } from '../lib/claude-quota-signal.js';
import {
  CLAUDE_RESERVE_DEFAULT_THRESHOLD_PERCENT,
  claudeReserveHold,
  claudeReserveMessage,
  normalizeClaudeReserve,
  parseClaudeReserveInput,
  reserveExempts,
  reserveRestricts,
} from '../lib/claude-reserve.js';
import { createCredentialConsole } from '../server.js';

const MACHINE_A = 'machine-aaaaaaaaaaaaaaaa';
const MACHINE_B = 'machine-bbbbbbbbbbbbbbbb';
const NOW = Date.parse('2026-11-10T12:00:00Z');
const RESET_MS = NOW + 3 * 86_400_000;
const PASSWORD = 'correct horse battery';

/** What api.anthropic.com stamps on an answer to a subscription credential. */
function quotaHeaders(weeklyUsed, {
  resetMs = Date.now() + 86_400_000,
  fiveHourUsed = 0.1,
  fiveHourResetMs = Date.now() + 3_600_000,
} = {}) {
  return {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': String(weeklyUsed),
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(resetMs / 1000)),
    'anthropic-ratelimit-unified-5h-utilization': String(fiveHourUsed),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(fiveHourResetMs / 1000)),
  };
}

function weeklySnapshot(remaining, { resetsAt = new Date(Date.now() + 86_400_000).toISOString(), fetchedAt = new Date().toISOString() } = {}) {
  return {
    provider: 'claude',
    status: 'available',
    fetched_at: fetchedAt,
    windows: [
      { kind: 'five_hour', used_percent: 10, remaining_percent: 90, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      { kind: 'weekly', used_percent: 100 - remaining, remaining_percent: remaining, resets_at: resetsAt },
    ],
  };
}

// --- the rule ---------------------------------------------------------------

test('a reserve nobody configured, or one that cannot be read, is off', () => {
  for (const value of [undefined, null, {}, { enabled: 'yes', threshold_percent: 20 }, { enabled: true }, { enabled: true, threshold_percent: 0 }, { enabled: true, threshold_percent: 96 }, { enabled: true, threshold_percent: 12.5 }]) {
    const reserve = normalizeClaudeReserve(value);
    assert.equal(reserve.enabled, false, `${JSON.stringify(value)} must not stop an account`);
    assert.equal(reserve.threshold_percent, CLAUDE_RESERVE_DEFAULT_THRESHOLD_PERCENT);
  }
  assert.deepEqual(normalizeClaudeReserve({
    enabled: true,
    threshold_percent: 30,
    exempt_machine_ids: [MACHINE_A, MACHINE_A, 'short', 7],
    exempt_device_ids: ['device-00001', '../etc'],
  }), {
    enabled: true,
    threshold_percent: 30,
    exempt_machine_ids: [MACHINE_A],
    exempt_device_ids: ['device-00001'],
  });
});

test('a submitted reserve is checked, not trusted to the form', () => {
  assert.deepEqual(
    parseClaudeReserveInput({ enabled: true, thresholdPercent: ' 20 ', exemptMachineIds: [MACHINE_A], exemptDeviceIds: [] }),
    { enabled: true, threshold_percent: 20, exempt_machine_ids: [MACHINE_A], exempt_device_ids: [] },
  );
  for (const thresholdPercent of ['', '0', '96', '12.5', '-3', 'abc', '1e1', undefined]) {
    assert.throws(() => parseClaudeReserveInput({ enabled: true, thresholdPercent }), /whole number from 1 to 95/, String(thresholdPercent));
  }
  assert.throws(
    () => parseClaudeReserveInput({ enabled: true, thresholdPercent: '20', exemptMachineIds: ['nope'] }),
    /unknown exempt device/,
  );
  assert.throws(
    () => parseClaudeReserveInput({
      enabled: true,
      thresholdPercent: '20',
      exemptMachineIds: Array.from({ length: 65 }, (_, index) => `machine-${String(index).padStart(16, '0')}`),
    }),
    /at most 64 exempt devices/,
  );
  assert.equal(parseClaudeReserveInput({ enabled: 'yes', thresholdPercent: '20' }).enabled, false);
});

test('the reserve holds below the line only, and a missing reading is not a low one', () => {
  const reserve = normalizeClaudeReserve({ enabled: true, threshold_percent: 20 });
  assert.equal(reserveRestricts(reserve, 19.9), true);
  assert.equal(reserveRestricts(reserve, 20), false, 'at the line the account still serves');
  assert.equal(reserveRestricts(reserve, 0), true);
  assert.equal(reserveRestricts(reserve, null), false);
  assert.equal(reserveRestricts(reserve, undefined), false);
  assert.equal(reserveRestricts(normalizeClaudeReserve({ enabled: false, threshold_percent: 20 }), 1), false);
});

test('a device is exempt by its machine, or by itself when it has none', () => {
  const reserve = normalizeClaudeReserve({
    enabled: true,
    threshold_percent: 20,
    exempt_machine_ids: [MACHINE_A],
    exempt_device_ids: ['legacy-device-1'],
  });
  assert.equal(reserveExempts(reserve, { id: 'any-device-0001', machine_id: MACHINE_A }), true);
  assert.equal(reserveExempts(reserve, { id: 'any-device-0002', machine_id: MACHINE_B }), false);
  assert.equal(reserveExempts(reserve, { id: 'legacy-device-1' }), true);
  assert.equal(reserveExempts(reserve, { id: 'legacy-device-2' }), false);
  assert.equal(reserveExempts(reserve, null), false);
});

test('the refusal names the account, the line and the reset, in both languages', () => {
  const message = claudeReserveMessage({
    alias: 'claude-ethan',
    thresholdPercent: 20,
    remainingPercent: 14.6,
    resetsAtMs: Date.parse('2026-11-13T05:00:00Z'),
  });
  assert.match(message, /account claude-ethan is held in reserve for its owner \(weekly quota left 14%, reserve line 20%\)/);
  assert.match(message, /after the weekly reset at 2026-11-13 05:00 UTC/);
  assert.match(message, /账号 claude-ethan 已进入保留额度（周额度剩余 14%，保留线 20%）/);
  const bare = claudeReserveMessage({ alias: 'claude-ethan', thresholdPercent: 20, remainingPercent: null, resetsAtMs: null });
  assert.doesNotMatch(bare, /weekly reset at|周额度剩余/);
});

// --- the reading ------------------------------------------------------------

test('the weekly figure is read off a response and outranks an older poll', () => {
  const signal = new ClaudeQuotaSignal();
  assert.equal(signal.weeklyReading('acct', null, NOW), null);
  signal.observe('acct', quotaHeaders(0.853, { resetMs: RESET_MS }), NOW);
  assert.deepEqual(signal.weeklyReading('acct', null, NOW), {
    remaining_percent: 14.7,
    resets_at_ms: Math.floor(RESET_MS / 1000) * 1000,
    at_ms: NOW,
  });
  const older = weeklySnapshot(60, { resetsAt: new Date(RESET_MS).toISOString(), fetchedAt: new Date(NOW - 60_000).toISOString() });
  assert.equal(signal.weeklyReading('acct', older, NOW).remaining_percent, 14.7);
  // The owner kept spending directly; nothing passed the gateway since, so the
  // poll is the newer word.
  const newer = weeklySnapshot(9, { resetsAt: new Date(RESET_MS).toISOString(), fetchedAt: new Date(NOW + 60_000).toISOString() });
  assert.equal(signal.weeklyReading('acct', newer, NOW + 120_000).remaining_percent, 9);
});

test('a response without the weekly figure leaves the last reading standing', () => {
  const signal = new ClaudeQuotaSignal();
  signal.observe('acct', quotaHeaders(0.5, { resetMs: RESET_MS }), NOW);
  assert.equal(signal.observe('acct', { 'content-type': 'application/json' }, NOW + 1), null);
  assert.equal(signal.observe('acct', { 'anthropic-ratelimit-unified-7d-utilization': 'lots' }, NOW + 2), null);
  assert.equal(signal.weeklyReading('acct', null, NOW + 3).remaining_percent, 50);
  // Overdrawn is still a reading: of a window with nothing left.
  signal.observe('acct', quotaHeaders(1.01, { resetMs: RESET_MS }), NOW + 4);
  assert.equal(signal.weeklyReading('acct', null, NOW + 5).remaining_percent, 0);
});

test('a reading of a week that has ended is no reading', () => {
  const signal = new ClaudeQuotaSignal();
  signal.observe('acct', quotaHeaders(0.95, { resetMs: RESET_MS }), NOW);
  assert.equal(signal.weeklyReading('acct', null, RESET_MS - 1000).remaining_percent, 5);
  assert.equal(signal.weeklyReading('acct', null, RESET_MS + 1000), null);
  const stale = weeklySnapshot(3, { resetsAt: new Date(RESET_MS).toISOString(), fetchedAt: new Date(NOW + 1000).toISOString() });
  assert.equal(signal.weeklyReading('acct', stale, RESET_MS + 1000), null);
});

test('the page shows the newer of the poll and the observation', () => {
  const signal = new ClaudeQuotaSignal();
  const polled = weeklySnapshot(60, { resetsAt: new Date(RESET_MS).toISOString(), fetchedAt: new Date(NOW - 60_000).toISOString() });
  assert.equal(signal.merge('acct', polled, NOW), polled, 'nothing observed: the poll as it is');
  signal.observe('acct', quotaHeaders(0.853, { resetMs: RESET_MS, fiveHourUsed: 0.42, fiveHourResetMs: NOW + 3_600_000 }), NOW);
  const merged = signal.merge('acct', polled, NOW);
  assert.equal(merged.windows.find((entry) => entry.kind === 'weekly').remaining_percent, 14.7);
  assert.equal(merged.windows.find((entry) => entry.kind === 'five_hour').used_percent, 42);
  assert.equal(merged.observed_at, new Date(NOW).toISOString());
  assert.equal(merged.status, 'available');
  assert.equal(polled.windows.find((entry) => entry.kind === 'weekly').remaining_percent, 60, 'the cached poll is not rewritten');
  const later = weeklySnapshot(9, { fetchedAt: new Date(NOW + 60_000).toISOString() });
  assert.equal(signal.merge('acct', later, NOW + 120_000), later);
});

test('what holds an account back: the reserve on, the device not exempt, the reading low', () => {
  const quotaSignal = new ClaudeQuotaSignal();
  const account = {
    id: 'acct',
    provider: 'claude',
    claude_reserve: { enabled: true, threshold_percent: 20, exempt_machine_ids: [MACHINE_A], exempt_device_ids: [] },
  };
  const device = { id: 'device-000001', machine_id: MACHINE_B };
  assert.equal(claudeReserveHold({ account, device, quotaSignal, now: NOW }), null, 'no reading, no hold');
  quotaSignal.observe('acct', quotaHeaders(0.9, { resetMs: RESET_MS }), NOW);
  assert.deepEqual(claudeReserveHold({ account, device, quotaSignal, now: NOW }), {
    until: Math.floor(RESET_MS / 1000) * 1000,
    remainingPercent: 10,
    thresholdPercent: 20,
  });
  assert.equal(claudeReserveHold({ account, device: { id: 'device-000002', machine_id: MACHINE_A }, quotaSignal, now: NOW }), null);
  assert.equal(claudeReserveHold({ account: { ...account, provider: 'codex' }, device, quotaSignal, now: NOW }), null);
  assert.equal(claudeReserveHold({ account: { ...account, claude_reserve: null }, device, quotaSignal, now: NOW }), null);
  assert.equal(claudeReserveHold({ account, device, quotaSignal, now: RESET_MS + 1 }), null, 'and not past the weekly reset');
});

// --- the gateway ------------------------------------------------------------

async function fleet({
  backups = ['backup'],
  accountsNamed = ['home', 'backup', 'spare'],
  machineId = null,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-reserve-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const accounts = {};
  for (const name of accountsNamed) {
    accounts[name] = await store.addAccount({
      provider: 'claude',
      alias: `claude-${name}`,
      credential: { oauth_token: `token-${name}` },
    });
  }
  if (backups.length) {
    await store.setAccountFailover(accounts.home.id, {
      enabled: true,
      backupAccountIds: backups.map((name) => accounts[name].id),
      actor: 'test',
    });
  }
  const issued = await store.issueDeviceCredential({
    accountId: accounts.home.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
    machineId,
  });
  return { store, accounts, deviceToken: issued.token, deviceId: issued.device.id };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function bearer(req) {
  return String(req.headers.authorization ?? '').replace(/^Bearer /, '');
}

/**
 * A gateway in front of an upstream that answers every account 200, stamped
 * with the weekly utilization `used[token]` gives for it.
 */
async function gateway(t, { store, used = {}, usageSnapshotFor, exhaustion = new QuotaExhaustion() }) {
  const quotaSignal = new ClaudeQuotaSignal();
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      const token = bearer(req);
      seen.push({ token, path: req.url });
      const refusal = typeof used[token] === 'function' ? used[token](req, res) : null;
      if (refusal === true) return;
      const weekly = typeof used[token] === 'number' ? used[token] : 0.1;
      res.writeHead(200, quotaHeaders(weekly));
      res.end(JSON.stringify({ ok: true, served_by: token }));
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleClaudeProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      exhaustion,
      quotaSignal,
      ...(usageSnapshotFor ? { usageSnapshotFor } : {}),
    })).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    upstream.closeAllConnections?.();
    proxy.closeAllConnections?.();
    await Promise.all([close(proxy), close(upstream)]);
  });
  const send = (token, path = '/claude/v1/messages') => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
    const request = http.request(new URL(`${proxyUrl}${path}`), {
      method: 'POST',
      headers: { 'X-Api-Key': token, 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(body);
  });
  return { send, seen, quotaSignal, tokens: () => seen.map((entry) => entry.token) };
}

/** The store persists on its own queue; wait for anything already scheduled. */
async function settled(store) {
  await store.serialized(async () => {});
}

async function reserve(store, account, fields = {}) {
  return store.setClaudeReserve(account.id, { enabled: true, thresholdPercent: '20', actor: 'test', ...fields });
}

test('an account that crosses its reserve line stops serving, and its device moves to the backup', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  await reserve(store, accounts.home);
  const { send, tokens } = await gateway(t, { store, used: { 'token-home': 0.85 } });

  // Nothing is known about the account yet, so it serves — and that answer is
  // what says 15% is left.
  const first = await send(deviceToken);
  assert.equal(first.json.served_by, 'token-home');

  const second = await send(deviceToken);
  assert.equal(second.status, 200, 'the client sees an answer, not the reserve');
  assert.equal(second.json.served_by, 'token-backup');
  assert.deepEqual(tokens(), ['token-home', 'token-backup'], 'the held account is not asked again');

  await settled(store);
  const device = store.state.devices.find((entry) => entry.id === deviceId);
  assert.equal(device.selected_account_id, accounts.backup.id, 'the device itself moves');
  assert.equal(device.account_failover.home_account_id, accounts.home.id);
  assert.ok(Date.parse(device.account_failover.return_after) > Date.now(), 'and is due back at the weekly reset');
  const move = store.state.audit.findLast((entry) => entry.event === 'device_account_failover');
  assert.equal(move.reason, 'reserve threshold reached on claude-home');

  // Still held: the device does not go home just because nothing refused it.
  const third = await send(deviceToken);
  assert.equal(third.json.served_by, 'token-backup');
  assert.deepEqual(tokens(), ['token-home', 'token-backup', 'token-backup']);
});

test('with no backup the gateway answers for itself, at once, and asks the upstream nothing', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet({ backups: [] });
  await reserve(store, accounts.home);
  const { send, tokens } = await gateway(t, { store, used: { 'token-home': 0.85 } });
  await send(deviceToken);

  const refused = await send(deviceToken);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers['x-should-retry'], 'false', 'or Claude Code retries ten times before saying anything');
  assert.equal(refused.headers['x-gateway-account-reserved'], '1');
  assert.ok(Number(refused.headers['retry-after']) > 0);
  assert.equal(refused.json.type, 'error');
  assert.equal(refused.json.error.type, 'rate_limit_error');
  assert.match(refused.json.error.message, /account claude-home is held in reserve.*weekly quota left 15%, reserve line 20%/);
  assert.match(refused.json.error.message, /账号 claude-home 已进入保留额度/);
  assert.deepEqual(tokens(), ['token-home'], 'the refusal is the gateway\'s own');

  // Counting tokens spends nothing of what is being kept.
  const counted = await send(deviceToken, '/claude/v1/messages/count_tokens');
  assert.equal(counted.status, 200);
});

test('a chain whose every backup is held too ends in the same refusal', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet({ backups: ['backup'] });
  await reserve(store, accounts.home);
  await reserve(store, accounts.backup);
  const snapshots = { [accounts.home.id]: weeklySnapshot(12), [accounts.backup.id]: weeklySnapshot(5) };
  const { send, tokens } = await gateway(t, { store, usageSnapshotFor: (id) => snapshots[id] ?? null });

  const refused = await send(deviceToken);
  assert.equal(refused.status, 429);
  assert.match(refused.json.error.message, /claude-home.*weekly quota left 12%/);
  assert.deepEqual(tokens(), []);
});

test('an exempt machine keeps the account below the line; another machine does not', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet({ machineId: MACHINE_A });
  const other = await store.issueDeviceCredential({
    accountId: accounts.home.id,
    memberLabel: 'member@example.com',
    deviceName: 'other-box',
    machineId: MACHINE_B,
  });
  await reserve(store, accounts.home, { exemptMachineIds: [MACHINE_A] });
  const { send } = await gateway(t, { store, usageSnapshotFor: () => weeklySnapshot(8) });

  assert.equal((await send(deviceToken)).json.served_by, 'token-home');
  assert.equal((await send(other.token)).json.served_by, 'token-backup');
});

test('a credential with no machine is exempted by itself', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  await reserve(store, accounts.home, { exemptDeviceIds: [deviceId] });
  const { send } = await gateway(t, { store, usageSnapshotFor: () => weeklySnapshot(8) });
  assert.equal((await send(deviceToken)).json.served_by, 'token-home');
});

test('no other chain fails over onto a held account', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet({ backups: ['backup', 'spare'] });
  await reserve(store, accounts.backup);
  const { send, tokens } = await gateway(t, {
    store,
    usageSnapshotFor: (id) => (id === accounts.backup.id ? weeklySnapshot(10) : null),
    used: {
      'token-home': (req, res) => {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-representative-claim': 'seven_day',
          'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit reached' } }));
        return true;
      },
    },
  });

  const response = await send(deviceToken);
  assert.equal(response.status, 200);
  assert.equal(response.json.served_by, 'token-spare');
  assert.deepEqual(tokens(), ['token-home', 'token-spare'], 'the held backup is passed over, not tried');
});

test('the account serves again once the reading is back above the line, and the device goes home', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken, deviceId } = await fleet();
  await reserve(store, accounts.home);
  let snapshot = weeklySnapshot(8);
  const { send } = await gateway(t, { store, usageSnapshotFor: (id) => (id === accounts.home.id ? snapshot : null) });

  assert.equal((await send(deviceToken)).json.served_by, 'token-backup');
  await settled(store);
  assert.equal(store.state.devices.find((entry) => entry.id === deviceId).selected_account_id, accounts.backup.id);

  // The week turned over: the old reading describes a window that has ended.
  snapshot = weeklySnapshot(8, { resetsAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await send(deviceToken)).json.served_by, 'token-home');
  await settled(store);
  const device = store.state.devices.find((entry) => entry.id === deviceId);
  assert.equal(device.selected_account_id, accounts.home.id);
  assert.equal(device.account_failover ?? null, null);
  assert.ok(store.state.audit.some((entry) => entry.event === 'device_account_failback'));
});

test('lowering the line or switching the reserve off releases the account at the next request', { timeout: 20_000 }, async (t) => {
  const { store, accounts, deviceToken } = await fleet({ backups: [] });
  await reserve(store, accounts.home);
  const { send } = await gateway(t, { store, usageSnapshotFor: () => weeklySnapshot(12) });
  assert.equal((await send(deviceToken)).status, 429);

  await reserve(store, accounts.home, { thresholdPercent: '10' });
  assert.equal((await send(deviceToken)).json.served_by, 'token-home');

  await reserve(store, accounts.home, { thresholdPercent: '50' });
  assert.equal((await send(deviceToken)).status, 429);
  await reserve(store, accounts.home, { enabled: false, thresholdPercent: '50' });
  assert.equal((await send(deviceToken)).json.served_by, 'token-home');
});

test('an account with no reserve set behaves as it always did', { timeout: 20_000 }, async (t) => {
  const { store, deviceToken } = await fleet();
  const { send, tokens } = await gateway(t, { store, used: { 'token-home': 0.99 } });
  await send(deviceToken);
  assert.equal((await send(deviceToken)).json.served_by, 'token-home');
  assert.deepEqual(tokens(), ['token-home', 'token-home']);
});

// --- the store --------------------------------------------------------------

test('the store keeps a reserve only for a Claude account and only for devices it knows', async () => {
  const { store, accounts, deviceId } = await fleet({ machineId: null });
  const withMachine = await store.issueDeviceCredential({
    accountId: accounts.home.id,
    memberLabel: 'member@example.com',
    deviceName: 'studio',
    machineId: MACHINE_A,
  });
  await assert.rejects(store.setClaudeReserve('missing', { enabled: true, thresholdPercent: '20' }), /account not found/);
  await assert.rejects(reserve(store, accounts.home, { thresholdPercent: '0' }), /whole number from 1 to 95/);
  await assert.rejects(reserve(store, accounts.home, { exemptMachineIds: [MACHINE_B] }), /unknown exempt device/);
  await assert.rejects(
    reserve(store, accounts.home, { exemptDeviceIds: [withMachine.device.id] }),
    /unknown exempt device/,
    'a credential that has a machine is exempted through the machine',
  );
  assert.equal(store.accountById(accounts.home.id).claude_reserve ?? null, null, 'a refused save writes nothing');

  await reserve(store, accounts.home, { thresholdPercent: '25', exemptMachineIds: [MACHINE_A], exemptDeviceIds: [deviceId], actor: 'root' });
  const saved = store.publicAccounts().find((entry) => entry.id === accounts.home.id).claude_reserve;
  assert.equal(saved.enabled, true);
  assert.equal(saved.threshold_percent, 25);
  assert.deepEqual(saved.exempt_machine_ids, [MACHINE_A]);
  assert.deepEqual(saved.exempt_device_ids, [deviceId]);
  const audit = store.state.audit.findLast((entry) => entry.event === 'claude_reserve_updated');
  assert.equal(audit.account_id, accounts.home.id);
  assert.equal(audit.threshold_percent, 25);
  assert.equal(audit.exempt_machines, 1);
  assert.equal(audit.exempt_devices, 1);
  assert.equal(audit.previous_enabled, false);
  assert.equal(audit.actor, 'root');

  const reopened = await new CredentialStore(store.home, {}).init();
  assert.equal(reopened.accountById(accounts.home.id).claude_reserve.threshold_percent, 25, 'and it survives a restart');

  const codex = await store.addAccount({
    provider: 'codex',
    alias: 'codex-one',
    external: { kind: 'codex-credential', home: await mkdtemp(join(tmpdir(), 'credential-console-reserve-codex-')) },
  });
  await assert.rejects(reserve(store, codex), /not a Claude account/);
});

// --- the console ------------------------------------------------------------
//
// Asserted on the rendered page, not the store: the page reads accounts through
// hand-written projections, and a field missing from one of them makes a
// working setting look broken.

async function consoleFixture(t, { adminAuth = 'open', snapshots = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-reserve-ui-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const account = await store.addAccount({ provider: 'claude', alias: 'claude-ethan', credential: { oauth_token: 'token-ethan' } });
  const other = await store.addAccount({ provider: 'claude', alias: 'claude-team', credential: { oauth_token: 'token-team' } });
  const studio = await store.issueDeviceCredential({ accountId: account.id, memberLabel: 'ethan@example.com', deviceName: 'ethan-studio', machineId: MACHINE_A });
  const laptop = await store.issueDeviceCredential({ accountId: other.id, memberLabel: 'kid@example.com', deviceName: 'kid-laptop', machineId: MACHINE_B });
  const legacy = await store.issueDeviceCredential({ accountId: account.id, memberLabel: 'old@example.com', deviceName: 'old-box' });
  if (adminAuth === 'password') await store.addAdminUser({ username: 'root', password: PASSWORD });
  const created = await createCredentialConsole({
    store,
    adminAuth,
    cookieSecure: false,
    metricsQueryService: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: { snapshotForAccount: (id) => snapshots[id === account.id ? 'ethan' : 'team'] ?? null, refreshAccount: async () => null, stop() {} },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
    await rm(home, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  let cookie = null;
  const request = async (path, { method = 'GET', form = null } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        'Tailscale-User-Login': 'member@example.com',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.text() };
  };
  const csrf = async () => (await request('/')).body.match(/name="csrf" value="([^"]+)"/)[1];
  return {
    store,
    account,
    other,
    devices: { studio: studio.device, laptop: laptop.device, legacy: legacy.device },
    request,
    csrf,
    async login() {
      const token = (await request('/login')).body.match(/name="csrf" value="([^"]+)"/)[1];
      return request('/login', { method: 'POST', form: { csrf: token, username: 'root', password: PASSWORD, next: '/' } });
    },
    async save(fields, accountId = account.id) {
      return request(`/accounts/${accountId}/claude-reserve`, { method: 'POST', form: { csrf: await csrf(), ...fields } });
    },
  };
}

function reserveForm(html, accountId) {
  const form = new RegExp(`<form[^>]*/accounts/${accountId}/claude-reserve"[\\s\\S]*?</form>`).exec(html);
  assert.ok(form, 'the reserve form should be on the page');
  return form[0];
}

test('the reserve is set from the account card, devices ticked from chips, and the page shows what was saved', async (t) => {
  const app = await consoleFixture(t);
  const before = reserveForm((await app.request('/')).body, app.account.id);
  assert.match(before, /name="enabled" value="1">/, 'off until somebody switches it on');
  assert.match(before, /name="threshold_percent" min="1" max="95" step="1" value="20"/);
  assert.match(before, new RegExp(`name="machine:${MACHINE_A}" value="1">`));
  assert.match(before, new RegExp(`name="machine:${MACHINE_B}" value="1">`), 'a machine on another Claude account can be exempted ahead of time');
  assert.match(before, new RegExp(`name="device:${app.devices.legacy.id}" value="1">`));
  assert.match(before, /ethan-studio/);
  assert.doesNotMatch(before, /<select/, 'chips, not a dropdown of every device');

  const saved = await app.save({
    enabled: '1',
    threshold_percent: '30',
    [`machine:${MACHINE_A}`]: '1',
    [`device:${app.devices.legacy.id}`]: '1',
  });
  assert.equal(saved.response.status, 303);
  assert.equal(saved.response.headers.get('location'), `/#account-${app.account.id}`);

  const { body } = await app.request('/');
  const after = reserveForm(body, app.account.id);
  assert.match(after, /name="enabled" value="1" checked>/);
  assert.match(after, /name="threshold_percent" min="1" max="95" step="1" value="30"/);
  assert.match(after, new RegExp(`name="machine:${MACHINE_A}" value="1" checked>`));
  assert.match(after, new RegExp(`name="machine:${MACHINE_B}" value="1">`));
  assert.match(after, new RegExp(`name="device:${app.devices.legacy.id}" value="1" checked>`));
  assert.match(body, /data-claude-reserve-note><span data-i18n="claude-reserve-active">Reserve<\/span> 30% · <span data-i18n="claude-reserve-standby">not reached<\/span> · 2 <span/);
  assert.doesNotMatch(reserveForm(body, app.other.id), /checked/, 'the other account is untouched');

  const refused = await app.save({ enabled: '1', threshold_percent: '0' });
  assert.match(decodeURIComponent(refused.response.headers.get('location')), /whole number from 1 to 95/);
  const unknown = await app.save({ enabled: '1', threshold_percent: '30', 'machine:machine-zzzzzzzzzzzzzzzz': '1' });
  assert.match(decodeURIComponent(unknown.response.headers.get('location')), /unknown exempt device/);
  assert.equal(app.store.accountById(app.account.id).claude_reserve.threshold_percent, 30);
});

test('a held account says so on the page, with the reset it is held until', async (t) => {
  const resetsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const app = await consoleFixture(t, { snapshots: { ethan: weeklySnapshot(12, { resetsAt }), team: weeklySnapshot(12, { resetsAt }) } });
  await app.save({ enabled: '1', threshold_percent: '20' });
  const { body } = await app.request('/');
  const card = new RegExp(`<article class="acct[^"]*" data-account-row="${app.account.id}"[\\s\\S]*?</article>`).exec(body)[0];
  assert.match(card, /data-i18n="claude-reserve-pill">Held in reserve</);
  assert.match(body, /data-i18n="claude-reserve-in-force">in force: the gateway is not using this account<\/span> · <span class="until" data-until="until" data-until-at="[^"]+"><span class="until-left">lifts in 2d<\/span>/);
  const otherCard = new RegExp(`<article class="acct[^"]*" data-account-row="${app.other.id}"[\\s\\S]*?</article>`).exec(body)[0];
  assert.doesNotMatch(otherCard, /claude-reserve-pill/, 'the same reading without a reserve holds nothing');

  await app.save({ enabled: '1', threshold_percent: '10' });
  assert.doesNotMatch((await app.request('/')).body, /claude-reserve-pill|claude-reserve-in-force/);
});

test('only an administrator can set a reserve', async (t) => {
  const app = await consoleFixture(t, { adminAuth: 'password' });
  const page = await app.request('/');
  assert.doesNotMatch(page.body, /claude-reserve"/, 'a member is not shown the form');
  const member = await app.save({ enabled: '1', threshold_percent: '30' });
  assert.notEqual(member.response.headers.get('location'), `/#account-${app.account.id}`);
  assert.equal(app.store.accountById(app.account.id).claude_reserve ?? null, null, 'and posting it anyway changes nothing');

  await app.login();
  const admin = await app.save({ enabled: '1', threshold_percent: '30' });
  assert.equal(admin.response.headers.get('location'), `/#account-${app.account.id}`);
  assert.equal(app.store.accountById(app.account.id).claude_reserve.threshold_percent, 30);
  assert.match(
    JSON.stringify(app.store.state.audit.findLast((entry) => entry.event === 'claude_reserve_updated').actor),
    /root/,
    'the audit says which administrator',
  );
  // The member's quota view states the rule too, or a moved device is a mystery.
  await app.request('/logout');
  assert.match((await app.request('/')).body, /data-claude-reserve-note>/);
});
