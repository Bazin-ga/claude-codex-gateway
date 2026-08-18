import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  CONVERSATION_HOOK_BODY_LIMIT,
  CONVERSATION_HOOK_BODY_TIMEOUT_MS,
  CONVERSATION_HOOK_PATH,
  handleMachineControl,
} from '../lib/machine-control.js';

const TOKEN_A = 'machine-token-a';
const TOKEN_B = 'machine-token-b';
const TOKEN_C = 'machine-token-c';
const TOKEN_D = 'machine-token-d';
const TOKEN_E = 'machine-token-e';
const TOKEN_RATE = 'machine-token-rate-limit';
const SENSITIVE = {
  token: 'device-token-must-not-return',
  token_sha256: 'device-digest-must-not-return',
  credential: { oauth_token: 'oauth-credential-must-not-return' },
  audit: [{ event: 'must-not-return' }],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function accountSummary({
  deviceId,
  machineId = null,
  memberLabel,
  accountId,
  accountAlias,
  accountStatus = 'healthy',
  allowedAccountIds,
  selectedAccountId = null,
}) {
  return {
    device_id: deviceId,
    machine_id: machineId,
    member_label: memberLabel,
    name: `${deviceId}-name`,
    account_id: accountId,
    account_alias: accountAlias,
    account_status: accountStatus,
    allowed_account_ids: allowedAccountIds,
    selected_account_id: selectedAccountId,
    ...SENSITIVE,
  };
}

class FakeStore {
  constructor() {
    this.active = new Map([
      [TOKEN_A, { id: 'device-a' }],
      [TOKEN_B, { id: 'device-b' }],
      [TOKEN_C, { id: 'device-c' }],
      [TOKEN_D, { id: 'device-d' }],
      [TOKEN_E, { id: 'device-e' }],
      [TOKEN_RATE, { id: 'device-rate-limit' }],
    ]);
    this.summaries = new Map([
      ['device-a', accountSummary({
        deviceId: 'device-a',
        memberLabel: 'alice',
        accountId: 'account-a',
        accountAlias: 'claude-a',
        allowedAccountIds: ['account-a', 'account-b'],
      })],
      ['device-b', accountSummary({
        deviceId: 'device-b',
        machineId: 'machine-b-0000000001',
        memberLabel: 'bob',
        accountId: 'account-b',
        accountAlias: 'claude-b',
        allowedAccountIds: ['account-b'],
      })],
      ['device-c', accountSummary({
        deviceId: 'device-c',
        memberLabel: 'carol',
        accountId: 'account-a',
        accountAlias: 'claude-a',
        allowedAccountIds: ['account-a'],
      })],
      ['device-d', accountSummary({
        deviceId: 'device-d',
        memberLabel: 'dave',
        accountId: 'account-a',
        accountAlias: 'claude-a',
        allowedAccountIds: ['account-a'],
      })],
      ['device-e', accountSummary({
        deviceId: 'device-e',
        memberLabel: 'erin',
        accountId: 'account-a',
        accountAlias: 'claude-a',
        allowedAccountIds: ['account-a'],
      })],
      ['device-rate-limit', accountSummary({
        deviceId: 'device-rate-limit',
        memberLabel: 'rate-limit-member',
        accountId: 'account-a',
        accountAlias: 'claude-a',
        allowedAccountIds: ['account-a'],
      })],
    ]);
    this.deviceByTokenCalls = [];
    this.deviceByTokenHook = null;
    this.switchCalls = [];
    this.nextSwitchError = null;
    this.nextSummaryError = null;
  }

  deviceByToken(token) {
    this.deviceByTokenCalls.push(token);
    const device = this.active.has(token) ? this.active.get(token) : null;
    this.deviceByTokenHook?.(device?.id ?? null, token);
    return device;
  }

  deviceAccountSummary(deviceId) {
    if (this.nextSummaryError) {
      const error = this.nextSummaryError;
      this.nextSummaryError = null;
      throw Object.assign(new Error('internal summary details must not leak'), { code: error });
    }
    return clone(this.summaries.get(deviceId));
  }

  switchDeviceAccount({ deviceId, selectedAccountId, actorDeviceId }) {
    this.switchCalls.push({ deviceId, selectedAccountId, actorDeviceId });
    if (this.nextSwitchError) {
      const error = this.nextSwitchError;
      this.nextSwitchError = null;
      throw Object.assign(new Error('internal switch details must not leak'), { code: error });
    }
    const summary = this.summaries.get(deviceId);
    if (!summary) throw Object.assign(new Error('missing'), { code: 'DEVICE_CONFIGURATION_INVALID' });
    if (!summary.allowed_account_ids.includes(selectedAccountId)) {
      throw Object.assign(new Error('not allowed'), { code: 'ACCOUNT_NOT_ALLOWED' });
    }
    summary.selected_account_id = selectedAccountId === summary.account_id ? null : selectedAccountId;
    summary.account_id = selectedAccountId;
    summary.account_alias = selectedAccountId === 'account-a' ? 'claude-a' : 'claude-b';
    return clone(summary);
  }

  threadKeyForSession() {
    return 'a'.repeat(64);
  }

  promptKeyForHook() {
    return 'b'.repeat(64);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function harness(t) {
  const store = new FakeStore();
  const requestMetrics = {
    hookEvents: [],
    recordConversationHookEvent(event) {
      this.hookEvents.push(event);
      return true;
    },
  };
  const server = http.createServer((req, res) => {
    handleMachineControl(req, res, { store, requestMetrics }).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl, server, store, requestMetrics };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForCondition(condition, { maxTurns = 1000 } = {}) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (condition()) return;
    await nextTurn();
  }
  throw new Error('condition was not reached before the turn budget expired');
}

/**
 * Start an HTTP request without ending its body. This lets the admission
 * tests hold a real socket in readJsonBody rather than relying on mocked
 * timers or direct calls into the handler.
 */
function openRawHookRequest(baseUrl, {
  token = TOKEN_A,
  body,
  contentLength,
  headers = {},
} = {}) {
  const url = new URL(`${baseUrl}${CONVERSATION_HOOK_PATH}`);
  const requestHeaders = {
    ...tokenHeaders(token),
    'Content-Type': 'application/json',
    ...(contentLength === undefined
      ? {}
      : { 'Content-Length': String(contentLength) }),
    ...headers,
  };
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    headers: requestHeaders,
  });
  req.once('response', (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.once('end', () => resolveResponse({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
    res.once('error', rejectResponse);
  });
  req.once('error', rejectResponse);
  if (body !== undefined) req.end(body);
  return { req, response };
}

function hookBody(prompt = 'admission test prompt') {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-hook-0123456789',
    prompt_id: '550e8400-e29b-41d4-a716-446655440000',
    prompt,
  });
}

function tokenHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function assertNoSensitiveFields(body) {
  const serialized = JSON.stringify(body);
  for (const value of Object.values(SENSITIVE)) {
    assert.equal(serialized.includes(typeof value === 'string' ? value : JSON.stringify(value)), false);
  }
  for (const key of ['token', 'token_sha256', 'credential', 'oauth_token', 'audit']) {
    assert.equal(Object.hasOwn(body, key), false, `response unexpectedly exposes ${key}`);
  }
}

test('status authenticates the caller, returns a null machine id safely, and omits secrets', async (t) => {
  const { baseUrl, store } = await harness(t);
  const result = await request(baseUrl, '/claude/control/v1/status', {
    headers: tokenHeaders(TOKEN_A),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.device_id, 'device-a');
  assert.equal(result.body.machine_id, null);
  assert.equal(result.body.member_label, 'alice');
  assert.equal(result.body.account_id, 'account-a');
  assert.equal(result.body.original_account_id, null);
  assert.deepEqual(result.body.allowed_account_ids, ['account-a', 'account-b']);
  assertNoSensitiveFields(result.body);
  assert.deepEqual(store.deviceByTokenCalls, [TOKEN_A]);
});

test('status checks revocation on every request and never accepts cookie/CSRF alone', async (t) => {
  const { baseUrl, store } = await harness(t);
  const first = await request(baseUrl, '/claude/control/v1/status', {
    headers: tokenHeaders(TOKEN_A),
  });
  assert.equal(first.status, 200);

  const cookieOnly = await request(baseUrl, '/claude/control/v1/status', {
    headers: { Cookie: 'credential_console_session=session', 'X-CSRF-Token': 'csrf' },
  });
  assert.equal(cookieOnly.status, 401);

  store.active.delete(TOKEN_A);
  const revoked = await request(baseUrl, '/claude/control/v1/status', {
    headers: tokenHeaders(TOKEN_A),
  });
  assert.equal(revoked.status, 401);
  assert.equal(store.deviceByTokenCalls.length, 2);
});

test('Bearer, x-api-key, and conflicting headers follow the shared token contract', async (t) => {
  const { baseUrl } = await harness(t);
  const apiKey = await request(baseUrl, '/claude/control/v1/status', {
    headers: { 'X-Api-Key': TOKEN_B },
  });
  assert.equal(apiKey.status, 200);
  const conflict = await request(baseUrl, '/claude/control/v1/status', {
    headers: { ...tokenHeaders(TOKEN_A), 'X-Api-Key': TOKEN_B },
  });
  assert.equal(conflict.status, 401);
  const empty = await request(baseUrl, '/claude/control/v1/status', {
    headers: { 'X-Api-Key': '' },
  });
  assert.equal(empty.status, 401);
});

test('conversation hooks authenticate the device and enqueue only an opaque exact user round', async (t) => {
  const { baseUrl, requestMetrics } = await harness(t);
  const rawSessionId = 'session-hook-0123456789';
  const rawPromptId = '550e8400-e29b-41d4-a716-446655440000';
  const result = await request(baseUrl, '/claude/control/v1/conversation-hooks', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: rawSessionId,
      prompt_id: rawPromptId,
      prompt: 'the exact client-submitted prompt',
      transcript_path: '/must/not/be/stored',
      cwd: '/private/project',
    }),
  });
  assert.equal(result.status, 204);
  assert.equal(result.body, '');
  assert.equal(requestMetrics.hookEvents.length, 1);
  assert.deepEqual(requestMetrics.hookEvents[0], {
    kind: 'prompt',
    threadKey: 'a'.repeat(64),
    promptKey: 'b'.repeat(64),
    occurredAtMs: requestMetrics.hookEvents[0].occurredAtMs,
    text: 'the exact client-submitted prompt',
    truncated: false,
    failureCode: null,
    reason: null,
    deviceId: 'device-a',
    machineId: null,
    memberLabel: 'alice',
    accountId: 'account-a',
    accountAlias: 'claude-a',
  });
  assert.ok(Number.isSafeInteger(requestMetrics.hookEvents[0].occurredAtMs));
  const serialized = JSON.stringify(requestMetrics.hookEvents[0]);
  for (const forbidden of [rawSessionId, rawPromptId, TOKEN_A, 'transcript', '/private/project']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation hook continuations are ignored safely and invalid or unavailable capture never affects auth', async (t) => {
  const { baseUrl, requestMetrics } = await harness(t);
  const ignored = await request(baseUrl, '/claude/control/v1/conversation-hooks', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'session-hook-0123456789',
      stop_hook_active: false,
      last_assistant_message: 'subagent output',
      agent_id: 'private-agent-id',
    }),
  });
  assert.equal(ignored.status, 204);
  assert.equal(requestMetrics.hookEvents.length, 0);

  const legacyClient = await request(baseUrl, '/claude/control/v1/conversation-hooks', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-hook-legacy-client',
      prompt: 'cannot be paired without the official prompt id',
    }),
  });
  assert.equal(legacyClient.status, 204);
  assert.equal(requestMetrics.hookEvents.length, 0);

  const invalid = await request(baseUrl, '/claude/control/v1/conversation-hooks', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'short', prompt: 'x' }),
  });
  assert.equal(invalid.status, 400);

  const unauthorized = await request(baseUrl, '/claude/control/v1/conversation-hooks', {
    method: 'POST',
    headers: { Authorization: 'Bearer revoked-or-unknown', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-hook-0123456789',
      prompt: 'must not enqueue',
    }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(requestMetrics.hookEvents.length, 0);
});

test('POST account switches only the authenticated device and supports a no-op', async (t) => {
  const { baseUrl, store } = await harness(t);
  const switched = await request(baseUrl, '/claude/control/v1/account', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 'account-b' }),
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.device_id, 'device-a');
  assert.equal(switched.body.account_id, 'account-b');
  assert.equal(store.switchCalls.length, 1);
  assert.deepEqual(store.switchCalls[0], {
    deviceId: 'device-a',
    selectedAccountId: 'account-b',
    actorDeviceId: 'device-a',
  });
  assertNoSensitiveFields(switched.body);

  const noop = await request(baseUrl, '/claude/control/v1/account', {
    method: 'POST',
    headers: { 'X-Api-Key': TOKEN_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 'account-b' }),
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.account_id, 'account-b');

  const other = await request(baseUrl, '/claude/control/v1/status', {
    headers: tokenHeaders(TOKEN_B),
  });
  assert.equal(other.status, 200);
  assert.equal(other.body.device_id, 'device-b');
  assert.equal(other.body.account_id, 'account-b');
});

test('account switch maps allowlist, unavailable, and configuration errors safely', async (t) => {
  const { baseUrl, store } = await harness(t);
  const notAllowed = await request(baseUrl, '/claude/control/v1/account', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_B), 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 'account-a' }),
  });
  assert.equal(notAllowed.status, 403);

  for (const code of ['ACCOUNT_UNAVAILABLE', 'DEVICE_CONFIGURATION_INVALID']) {
    store.nextSwitchError = code;
    const unavailable = await request(baseUrl, '/claude/control/v1/account', {
      method: 'POST',
      headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: 'account-b' }),
    });
    assert.equal(unavailable.status, 409);
  }
  store.nextSummaryError = 'DEVICE_CONFIGURATION_INVALID';
  const badStatus = await request(baseUrl, '/claude/control/v1/status', {
    headers: tokenHeaders(TOKEN_A),
  });
  assert.equal(badStatus.status, 409);
});

test('POST accepts exactly account_id and rejects malformed/dangerous bodies', async (t) => {
  const { baseUrl, store } = await harness(t);
  const cases = [
    '',
    '{',
    '[]',
    '{}',
    JSON.stringify({ device_id: 'device-b', account_id: 'account-b' }),
    JSON.stringify({ account_id: 'account-b', audit: true }),
    JSON.stringify({ account_id: 42 }),
  ];
  for (const body of cases) {
    const result = await request(baseUrl, '/claude/control/v1/account', {
      method: 'POST',
      headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(result.status, 400, body);
  }
  assert.equal(store.switchCalls.length, 0);
});

test('POST rejects bodies over 16 KiB before invoking the Store', async (t) => {
  const { baseUrl, store } = await harness(t);
  const body = JSON.stringify({ account_id: 'account-b', padding: 'x'.repeat(16 * 1024) });
  const result = await request(baseUrl, '/claude/control/v1/account', {
    method: 'POST',
    headers: {
      ...tokenHeaders(TOKEN_A),
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(result.status, 400);
  assert.equal(store.switchCalls.length, 0);
});

test('unknown Store failures return fixed 500 text without leaking error details', async (t) => {
  const { baseUrl, store } = await harness(t);
  store.nextSwitchError = 'SENSITIVE_INTERNAL_ERROR';
  const result = await request(baseUrl, '/claude/control/v1/account', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 'account-b' }),
  });
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result.body).includes('internal switch details'), false);
  assert.equal(JSON.stringify(result.body).includes('SENSITIVE_INTERNAL_ERROR'), false);
});

test('reserved control prefix has no enroll endpoint and does not proxy upstream', async (t) => {
  const { baseUrl, store } = await harness(t);
  const result = await request(baseUrl, '/claude/control/v1/enroll', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 'account-b' }),
  });
  assert.equal(result.status, 404);
  assert.equal(store.switchCalls.length, 0);
});

test('wrong methods are rejected without Store access', async (t) => {
  const { baseUrl, store } = await harness(t);
  const status = await request(baseUrl, '/claude/control/v1/status', {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(status.status, 405);
  const account = await request(baseUrl, '/claude/control/v1/account', {
    method: 'GET',
    headers: tokenHeaders(TOKEN_A),
  });
  assert.equal(account.status, 405);
  assert.equal(store.switchCalls.length, 0);
});

test('repeated machine-control authentication failures are source-rate-limited', async (t) => {
  const { baseUrl } = await harness(t);
  let result;
  for (let attempt = 0; attempt < 31; attempt += 1) {
    result = await request(baseUrl, '/claude/control/v1/status', {
      headers: {
        Authorization: 'Bearer wrong-machine-token',
        'X-Forwarded-For': '203.0.113.199',
      },
    });
    if (attempt < 30) assert.equal(result.status, 401);
  }
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '60');
});

test('an authenticated device has a bounded machine-control request budget', async (t) => {
  const { baseUrl } = await harness(t);
  let result;
  for (let attempt = 0; attempt < 121; attempt += 1) {
    result = await request(baseUrl, '/claude/control/v1/status', {
      headers: { 'X-Api-Key': TOKEN_RATE },
    });
    if (attempt < 120) assert.equal(result.status, 200);
  }
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '60');
});

test('conversation hooks admit at most two slow bodies per device and recover after aborts', async (t) => {
  const { baseUrl, store } = await harness(t);
  const firstReady = deferred();
  const secondReady = deferred();
  let deviceAuthCalls = 0;
  store.deviceByTokenHook = (deviceId) => {
    if (deviceId !== 'device-a') return;
    deviceAuthCalls += 1;
    if (deviceAuthCalls === 1) firstReady.resolve();
    if (deviceAuthCalls === 2) secondReady.resolve();
  };
  const partial = hookBody('body is intentionally held open');
  const heldLength = Buffer.byteLength(partial) + 1024;
  const first = openRawHookRequest(baseUrl, {
    contentLength: heldLength,
  });
  first.req.write(partial);
  await firstReady.promise;

  const second = openRawHookRequest(baseUrl, {
    contentLength: heldLength,
  });
  second.req.write(partial);
  await secondReady.promise;

  const third = await request(baseUrl, CONVERSATION_HOOK_PATH, {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: hookBody('third body must be rejected while both reads are held'),
  });
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('retry-after'), '1');

  const firstClosed = first.response.catch(() => null);
  const secondClosed = second.response.catch(() => null);
  first.req.destroy();
  second.req.destroy();
  await Promise.all([firstClosed, secondClosed]);

  const recovered = await request(baseUrl, CONVERSATION_HOOK_PATH, {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: hookBody('the device can capture again after both clients abort'),
  });
  assert.equal(recovered.status, 204);
});

test('conversation hooks reserve four 3 MiB slots globally, then release every slot', async (t) => {
  const { baseUrl, requestMetrics } = await harness(t);
  const tokens = [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D];
  const recordGates = [];
  const recorded = [];
  requestMetrics.recordConversationHookEvent = (event) => {
    recorded.push(event);
    const gate = deferred();
    recordGates.push(gate);
    return gate.promise;
  };

  const clients = tokens.map((token, index) => openRawHookRequest(baseUrl, {
    token,
    body: hookBody(`global slot ${index + 1}`),
  }));
  await waitForCondition(() => recordGates.length === 4);
  assert.equal(recorded.length, 4);

  const rejected = await request(baseUrl, CONVERSATION_HOOK_PATH, {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_E), 'Content-Type': 'application/json' },
    body: hookBody('the fifth device exceeds the 12 MiB reservation'),
  });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('retry-after'), '1');

  recordGates[0].resolve(true);
  const firstResult = await clients[0].response;
  assert.equal(firstResult.status, 204);

  const retry = openRawHookRequest(baseUrl, {
    token: TOKEN_E,
    body: hookBody('the fifth device fits after one durable record finishes'),
  });
  await waitForCondition(() => recordGates.length === 5);
  for (const gate of recordGates.slice(1)) gate.resolve(true);
  const results = await Promise.all([
    clients[1].response,
    clients[2].response,
    clients[3].response,
    retry.response,
  ]);
  assert.deepEqual(results.map((result) => result.status), [204, 204, 204, 204]);
  assert.equal(recorded.length, 5);
});

test('a hook response waits for durable record=true and keeps admission while persistence is pending', async (t) => {
  const { baseUrl, requestMetrics } = await harness(t);
  const recordGates = [];
  requestMetrics.recordConversationHookEvent = () => {
    const gate = deferred();
    recordGates.push(gate);
    return gate.promise;
  };

  const first = openRawHookRequest(baseUrl, { body: hookBody('durability gate one') });
  await waitForCondition(() => recordGates.length === 1);
  let firstResponded = false;
  first.response.then(() => { firstResponded = true; }, () => { firstResponded = true; });
  await nextTurn();
  assert.equal(firstResponded, false);

  const second = openRawHookRequest(baseUrl, { body: hookBody('durability gate two') });
  await waitForCondition(() => recordGates.length === 2);
  const third = await request(baseUrl, CONVERSATION_HOOK_PATH, {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: hookBody('a third request cannot pass pending persistence'),
  });
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('retry-after'), '1');

  recordGates[0].resolve(true);
  assert.equal((await first.response).status, 204);
  assert.equal(firstResponded, true);
  assert.equal(recordGates.length, 2);

  recordGates[1].resolve(true);
  assert.equal((await second.response).status, 204);
});

test('a slow hook body times out at five seconds and releases its reservation', async (t) => {
  const { baseUrl } = await harness(t);
  const partial = hookBody('this request never sends its terminating bytes');
  const client = openRawHookRequest(baseUrl, {
    contentLength: Buffer.byteLength(partial) + 1024,
  });
  client.req.write(partial);
  const startedAt = Date.now();
  const result = await client.response;
  const elapsed = Date.now() - startedAt;
  assert.equal(result.status, 408);
  assert.ok(elapsed >= CONVERSATION_HOOK_BODY_TIMEOUT_MS - 250);
  assert.ok(elapsed < CONVERSATION_HOOK_BODY_TIMEOUT_MS + 2_000);

  const recovered = await request(baseUrl, CONVERSATION_HOOK_PATH, {
    method: 'POST',
    headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
    body: hookBody('capture is available after timeout cleanup'),
  });
  assert.equal(recovered.status, 204);
});

test('oversized and client-aborted hook bodies release reservations and leave the service usable', async (t) => {
  const { baseUrl, store } = await harness(t);
  const oversized = openRawHookRequest(baseUrl, {
    contentLength: CONVERSATION_HOOK_BODY_LIMIT + 1,
  });
  oversized.req.end();
  const oversizedResult = await oversized.response;
  assert.equal(oversizedResult.status, 400);

  const abortReady = deferred();
  store.deviceByTokenHook = (deviceId) => {
    if (deviceId === 'device-a') abortReady.resolve();
  };
  const partial = hookBody('client aborts after admission');
  const aborted = openRawHookRequest(baseUrl, {
    contentLength: Buffer.byteLength(partial) + 1024,
  });
  aborted.req.write(partial);
  await abortReady.promise;
  const abortedResult = aborted.response.catch(() => null);
  aborted.req.destroy();
  await abortedResult;

  let recovered;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    recovered = await request(baseUrl, CONVERSATION_HOOK_PATH, {
      method: 'POST',
      headers: { ...tokenHeaders(TOKEN_A), 'Content-Type': 'application/json' },
      body: hookBody(`post-abort recovery attempt ${attempt}`),
    });
    if (recovered.status !== 429) break;
    await nextTurn();
  }
  assert.equal(recovered.status, 204);
});
