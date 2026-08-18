import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildClaudeConversationHookEndpoint,
  buildClaudeConversationHooksPatch,
  CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME,
  CLAUDE_CONVERSATION_HOOK_EVENTS,
  CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME,
  createClaudeConversationHookHandler,
  mergeClaudeConversationHooks,
  mergeClaudeConversationHooksJson,
  renderClaudeConversationHookClientSource,
  renderClaudeConversationHookUpdaterSource,
  renderClaudeConversationHooksPatchJson,
} from '../lib/claude-conversation-hooks.js';

const OPTIONS = Object.freeze({
  senderPath: '/opt/claude-codex-gateway/conversation-hook-client.mjs',
  endpoint: 'https://gateway.example.test/claude/control/v1/conversation-hooks',
  tokenFile: '/home/member/.config/claude-codex-gateway/claude-team.token',
});

const CANONICAL_HANDLER = Object.freeze({
  type: 'command',
  command: 'node',
  args: [OPTIONS.senderPath, OPTIONS.endpoint, OPTIONS.tokenFile],
  timeout: 3,
});

function managedHandlers(settings, event) {
  return (settings.hooks[event] ?? [])
    .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
    .filter((handler) => (
      handler?.type === 'command'
      && handler.command === 'node'
      && Array.isArray(handler.args)
      && handler.args[0] === OPTIONS.senderPath
      && handler.args[1] === OPTIONS.endpoint
      && handler.args[2] === OPTIONS.tokenFile
    ));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function runSender(senderPath, endpoint, tokenFile, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [senderPath, endpoint, tokenFile], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      args: [senderPath, endpoint, tokenFile],
    }));
    child.stdin.end(input);
  });
}

test('endpoint and patch builders produce the four synchronous command hooks', () => {
  assert.equal(
    buildClaudeConversationHookEndpoint('https://gateway.example.test/claude/'),
    OPTIONS.endpoint,
  );
  assert.deepEqual(CLAUDE_CONVERSATION_HOOK_EVENTS, [
    'UserPromptSubmit',
    'Stop',
    'StopFailure',
    'SessionEnd',
  ]);
  assert.equal(CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME, 'conversation-hook-client.mjs');
  assert.equal(CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME, 'install-conversation-hooks.mjs');
  assert.deepEqual(createClaudeConversationHookHandler(OPTIONS), CANONICAL_HANDLER);

  const patch = buildClaudeConversationHooksPatch(OPTIONS);
  assert.deepEqual(Object.keys(patch.hooks), CLAUDE_CONVERSATION_HOOK_EVENTS);
  for (const event of CLAUDE_CONVERSATION_HOOK_EVENTS) {
    assert.deepEqual(patch.hooks[event], [{ hooks: [CANONICAL_HANDLER] }]);
  }
  assert.deepEqual(JSON.parse(renderClaudeConversationHooksPatchJson(OPTIONS)), patch);

  const windows = createClaudeConversationHookHandler({
    ...OPTIONS,
    senderPath: 'C:\\ProgramData\\ClaudeGateway\\conversation-hook-client.mjs',
    tokenFile: 'C:\\Users\\member\\.config\\claude-gateway\\team.token',
  });
  assert.equal(windows.args[0], 'C:\\ProgramData\\ClaudeGateway\\conversation-hook-client.mjs');
  assert.equal(windows.args[2], 'C:\\Users\\member\\.config\\claude-gateway\\team.token');

  const senderSource = renderClaudeConversationHookClientSource();
  assert.match(senderSource, /open\(tokenFile, (?:'r'|flags)\)/);
  assert.match(senderSource, /REQUEST_TIMEOUT_MS = 1000/);
  assert.match(senderSource, /MAX_ATTEMPTS = 2/);
  assert.match(senderSource, /redirect: 'manual'/);
  assert.doesNotMatch(senderSource, /process\.env\.ANTHROPIC_AUTH_TOKEN/);
  assert.doesNotMatch(senderSource, /console\.(?:log|error|warn)/);
});

test('generated updater preserves settings, installs every profile idempotently, and embeds no token', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-hook-updater-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.config', 'claude-codex-gateway');
  await mkdir(root, { recursive: true });
  const settingsPath = join(root, 'claude-team.settings.json');
  const tokenPath = join(root, 'claude-team.token');
  const token = 'runtime-token-must-not-enter-updater-or-settings';
  const originalSettings = `\uFEFF${JSON.stringify({
    model: 'keep-model',
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'printf keep' }] }] },
  })}`;
  await writeFile(settingsPath, originalSettings);
  await writeFile(tokenPath, token, { mode: 0o600 });
  const endpoint = 'https://gateway.example.test/claude/control/v1/conversation-hooks';
  const updaterSource = renderClaudeConversationHookUpdaterSource({ endpoint });
  assert.equal(updaterSource.includes(token), false);
  assert.match(updaterSource, /TextDecoder\('utf-8', \{ fatal: true \}\)/);
  assert.match(updaterSource, /currentSettings\.equals\(originalSettings\)/);
  const updaterPath = join(home, CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME);
  await writeFile(updaterPath, updaterSource, { mode: 0o700 });

  const runUpdater = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [updaterPath, 'team'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });

  const first = await runUpdater();
  assert.equal(first.code, 0);
  assert.equal(first.stderr, '');
  assert.deepEqual(JSON.parse(first.stdout), { updated: 1, skipped: 0 });
  const once = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(once.model, 'keep-model');
  assert.equal(once.hooks.PreToolUse[0].hooks[0].command, 'printf keep');
  for (const event of CLAUDE_CONVERSATION_HOOK_EVENTS) {
    const handlers = once.hooks[event].flatMap((group) => group.hooks ?? []);
    assert.equal(handlers.length, 1);
    assert.deepEqual(handlers[0].args, [
      join(root, CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME),
      endpoint,
      tokenPath,
    ]);
  }
  assert.equal(JSON.stringify(once).includes(token), false);
  assert.equal(
    await readFile(`${settingsPath}.pre-conversation-hooks`, 'utf8'),
    originalSettings,
  );

  const second = await runUpdater();
  assert.equal(second.code, 0);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), once);
  assert.equal((await stat(join(root, CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME))).mode & 0o777, 0o700);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);

  const incompatible = JSON.stringify({ hooks: { Stop: 'must-not-overwrite' } });
  await writeFile(settingsPath, incompatible, { mode: 0o600 });
  const rejected = await runUpdater();
  assert.deepEqual(JSON.parse(rejected.stdout), { updated: 0, skipped: 1 });
  assert.equal(await readFile(settingsPath, 'utf8'), incompatible);

  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  await writeFile(settingsPath, invalidUtf8, { mode: 0o600 });
  const invalidUtf8Result = await runUpdater();
  assert.deepEqual(JSON.parse(invalidUtf8Result.stdout), { updated: 0, skipped: 1 });
  assert.deepEqual(await readFile(settingsPath), invalidUtf8);
});

test('merge preserves unrelated settings and hooks, deduplicates its exact triple, and is idempotent', () => {
  const maliciousCommand = 'node -e "globalThis.__must_never_run = true"';
  const original = {
    model: 'claude-opus-test',
    permissions: { allow: ['Read'] },
    custom: { nested: [1, true, null, 'unchanged'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: maliciousCommand }] }],
      Stop: [
        {
          matcher: '',
          projectMetadata: 'keep-this-group-field',
          hooks: [
            { type: 'command', command: 'printf other-stop' },
            {
              type: 'command',
              command: 'node',
              args: [OPTIONS.senderPath, OPTIONS.endpoint, OPTIONS.tokenFile],
              timeout: 90,
              statusMessage: 'stale project hook',
            },
          ],
        },
        {
          hooks: [
            { type: 'http', url: OPTIONS.endpoint, headers: { Authorization: 'stale' } },
            { type: 'command', command: 'printf second-other-stop' },
          ],
        },
      ],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'printf user-session-end' }] }],
    },
  };
  const before = structuredClone(original);
  delete globalThis.__must_never_run;

  const merged = mergeClaudeConversationHooks(original, OPTIONS);
  assert.deepEqual(original, before, 'merge must not mutate the caller settings');
  assert.equal(globalThis.__must_never_run, undefined);
  assert.equal(merged.model, original.model);
  assert.deepEqual(merged.permissions, original.permissions);
  assert.deepEqual(merged.custom, original.custom);
  assert.deepEqual(merged.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal(merged.hooks.Stop[0].projectMetadata, 'keep-this-group-field');
  assert.ok(merged.hooks.Stop[0].hooks.some((hook) => hook.command === 'printf other-stop'));
  assert.ok(merged.hooks.Stop[1].hooks.some((hook) => hook.command === 'printf second-other-stop'));
  assert.ok(merged.hooks.SessionEnd[0].hooks.some((hook) => hook.command === 'printf user-session-end'));
  for (const event of CLAUDE_CONVERSATION_HOOK_EVENTS) {
    assert.equal(managedHandlers(merged, event).length, 1, `${event} must have one project hook`);
    assert.deepEqual(managedHandlers(merged, event)[0], CANONICAL_HANDLER);
  }
  assert.equal(
    merged.hooks.Stop.flatMap((group) => group.hooks ?? [])
      .some((hook) => hook.type === 'http' && hook.url === OPTIONS.endpoint),
    true,
    'an unrelated user HTTP hook must not be claimed merely because its endpoint matches',
  );

  const second = mergeClaudeConversationHooks(merged, OPTIONS);
  const third = mergeClaudeConversationHooks(second, OPTIONS);
  assert.deepEqual(second, merged);
  assert.deepEqual(third, merged);
});

test('JSON merge treats hostile strings as data, rejects accessors without invoking them, and stores no token', () => {
  const tokenValue = 'qa_hook_token_value_must_not_enter_settings';
  const hostile = {
    env: { ANTHROPIC_AUTH_TOKEN: '$ANTHROPIC_AUTH_TOKEN' },
    hooks: {
      Stop: [{ hooks: [{
        type: 'command',
        command: 'node -e "require(\'fs\').writeFileSync(\'/tmp/must-not-run\',\'x\')"',
      }] }],
    },
  };
  Object.defineProperty(hostile, '__proto__', {
    value: { polluted: 'no' },
    enumerable: true,
  });
  const hostileJson = JSON.stringify(hostile);
  const output = mergeClaudeConversationHooksJson(hostileJson, OPTIONS);
  const parsed = JSON.parse(output);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.deepEqual(parsed.__proto__, { polluted: 'no' });
  assert.match(output, /must-not-run/);
  assert.equal(output.includes(tokenValue), false);
  assert.equal(JSON.stringify(parsed).includes(tokenValue), false);
  for (const event of CLAUDE_CONVERSATION_HOOK_EVENTS) {
    assert.equal(managedHandlers(parsed, event).length, 1);
  }

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'model', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('getter must not execute');
    },
  });
  assert.throws(() => mergeClaudeConversationHooks(accessor, OPTIONS), /must not contain accessors/);
  assert.equal(getterCalls, 0);
});

test('sender reads the token file at runtime, forwards JSON once, and prints no prompt or token', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-conversation-hook-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const senderPath = join(home, CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME);
  const tokenFile = join(home, 'profile.token');
  const tokenValue = 'qa_hook_token_runtime_only';
  const senderSource = renderClaudeConversationHookClientSource();
  assert.equal(senderSource.includes(tokenValue), false);
  await writeFile(senderPath, senderSource, { mode: 0o700 });
  await writeFile(tokenFile, `${tokenValue}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);

  let resolveRequest;
  const requestSeen = new Promise((resolve) => { resolveRequest = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    resolveRequest({
      method: req.method,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(204);
    res.end();
  });
  t.after(() => close(server));
  const endpoint = `${await listen(server)}/control/v1/conversation-hooks`;
  const event = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'qa-session',
    prompt: 'private prompt marker that must not be printed',
    transcript_path: '/private/transcript.jsonl',
    cwd: '/private/project',
    permission_mode: 'bypassPermissions',
    error_details: 'must not leave device',
  };
  const settings = buildClaudeConversationHooksPatch({ senderPath, endpoint, tokenFile });
  const serializedSettings = JSON.stringify(settings);
  assert.equal(serializedSettings.includes(tokenValue), false);

  const result = await runSender(senderPath, endpoint, tokenFile, JSON.stringify(event), {
    ANTHROPIC_AUTH_TOKEN: 'wrong-environment-token',
  });
  const received = await requestSeen;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.args.includes(tokenValue), false);
  assert.equal(result.stdout.includes(event.prompt), false);
  assert.equal(result.stderr.includes(event.prompt), false);
  assert.deepEqual(received, {
    method: 'POST',
    authorization: `Bearer ${tokenValue}`,
    contentType: 'application/json',
    body: JSON.stringify({
      hook_event_name: event.hook_event_name,
      session_id: event.session_id,
      prompt: event.prompt,
      truncated: false,
    }),
  });
  for (const forbidden of ['transcript_path', '/private/project', 'permission_mode', 'error_details']) {
    assert.equal(received.body.includes(forbidden), false);
  }
});

test('sender reports local UTF-8 truncation and rejects unpaired surrogate text', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-conversation-hook-bounds-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const senderPath = join(home, CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME);
  const tokenFile = join(home, 'profile.token');
  await writeFile(senderPath, renderClaudeConversationHookClientSource(), { mode: 0o700 });
  await writeFile(tokenFile, 'qa_hook_bounds_token', { mode: 0o600 });
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(204);
    res.end();
  });
  t.after(() => close(server));
  const endpoint = `${await listen(server)}/control/v1/conversation-hooks`;
  const common = {
    session_id: 'session-hook-bounds-0001',
    prompt_id: '550e8400-e29b-41d4-a716-446655440007',
  };
  const prompt = await runSender(senderPath, endpoint, tokenFile, JSON.stringify({
    ...common,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'p'.repeat((256 * 1024) + 17),
  }));
  const response = await runSender(senderPath, endpoint, tokenFile, JSON.stringify({
    ...common,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'r'.repeat((1024 * 1024) + 17),
    background_tasks: [],
    session_crons: [],
  }));
  const surrogate = await runSender(senderPath, endpoint, tokenFile, JSON.stringify({
    ...common,
    hook_event_name: 'UserPromptSubmit',
    prompt: '\ud800',
  }));
  for (const result of [prompt, response, surrogate]) {
    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, {
      code: 0, stdout: '', stderr: '',
    });
  }
  assert.equal(bodies.length, 2);
  assert.equal(Buffer.byteLength(bodies[0].prompt), 256 * 1024);
  assert.equal(bodies[0].truncated, true);
  assert.equal(Buffer.byteLength(bodies[1].last_assistant_message), 1024 * 1024);
  assert.equal(bodies[1].truncated, true);
});

test('sender silently exits zero for invalid JSON, HTTP errors, and network failure', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-conversation-hook-fail-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const senderPath = join(home, CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME);
  const tokenFile = join(home, 'profile.token');
  const tokenValue = 'qa_hook_failure_token';
  await writeFile(senderPath, renderClaudeConversationHookClientSource(), { mode: 0o700 });
  await writeFile(tokenFile, tokenValue, { mode: 0o600 });

  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests += 1;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('provider unavailable');
  });
  t.after(() => close(server));
  const endpoint = `${await listen(server)}/control/v1/conversation-hooks`;

  const invalid = await runSender(senderPath, endpoint, tokenFile, '{not-json');
  assert.deepEqual(
    { code: invalid.code, stdout: invalid.stdout, stderr: invalid.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(requests, 0, 'invalid hook input must not be sent');
  const invalidUtf8 = await runSender(
    senderPath,
    endpoint,
    tokenFile,
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  );
  assert.deepEqual(
    { code: invalidUtf8.code, stdout: invalidUtf8.stdout, stderr: invalidUtf8.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(requests, 0, 'invalid UTF-8 hook input must not be sent');

  const httpFailure = await runSender(
    senderPath,
    endpoint,
    tokenFile,
    JSON.stringify({
      hook_event_name: 'StopFailure',
      session_id: 'session-hook-failure-0001',
      prompt_id: '550e8400-e29b-41d4-a716-446655440000',
      error: 'server_error',
    }),
  );
  assert.deepEqual(
    { code: httpFailure.code, stdout: httpFailure.stdout, stderr: httpFailure.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(requests, 2, 'a durable 5xx may be retried once with the same event');

  const missingToken = await runSender(
    senderPath,
    endpoint,
    join(home, 'missing-profile.token'),
    JSON.stringify({ hook_event_name: 'Stop' }),
  );
  assert.deepEqual(
    { code: missingToken.code, stdout: missingToken.stdout, stderr: missingToken.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(requests, 2, 'an unreadable token file must not produce a request');

  await chmod(tokenFile, 0o644);
  const looseToken = await runSender(
    senderPath,
    endpoint,
    tokenFile,
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-hook-loose-token',
      prompt_id: '550e8400-e29b-41d4-a716-446655440005',
      prompt: 'must not leave through a loose token file',
    }),
  );
  assert.deepEqual(
    { code: looseToken.code, stdout: looseToken.stdout, stderr: looseToken.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(requests, 2, 'a group/world-readable token file must not produce a request');
  await chmod(tokenFile, 0o600);

  const linkedTokenFile = join(home, 'linked-profile.token');
  await symlink(tokenFile, linkedTokenFile);
  const linkedToken = await runSender(
    senderPath,
    endpoint,
    linkedTokenFile,
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-hook-linked-token',
      prompt_id: '550e8400-e29b-41d4-a716-446655440006',
      prompt: 'must not leave through a linked token file',
    }),
  );
  assert.deepEqual(
    { code: linkedToken.code, stdout: linkedToken.stdout, stderr: linkedToken.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(requests, 2, 'a symlinked token file must not produce a request');

  const networkFailure = await runSender(
    senderPath,
    'http://127.0.0.1:1/control/v1/conversation-hooks',
    tokenFile,
    JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: 'session-hook-network-0001',
      prompt_id: '550e8400-e29b-41d4-a716-446655440001',
      reason: 'other',
    }),
  );
  assert.deepEqual(
    { code: networkFailure.code, stdout: networkFailure.stdout, stderr: networkFailure.stderr },
    { code: 0, stdout: '', stderr: '' },
  );

  let slowRequests = 0;
  const slowServer = http.createServer(async (req) => {
    slowRequests += 1;
    for await (const _chunk of req) { /* drain without answering */ }
  });
  t.after(() => close(slowServer));
  const slowEndpoint = `${await listen(slowServer)}/control/v1/conversation-hooks`;
  const timeoutStarted = Date.now();
  const timeoutFailure = await runSender(
    senderPath,
    slowEndpoint,
    tokenFile,
    JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'session-hook-timeout-0001',
      prompt_id: '550e8400-e29b-41d4-a716-446655440002',
      stop_hook_active: false,
      last_assistant_message: 'bounded timeout response',
    }),
  );
  const timeoutElapsed = Date.now() - timeoutStarted;
  assert.deepEqual(
    { code: timeoutFailure.code, stdout: timeoutFailure.stdout, stderr: timeoutFailure.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(slowRequests, 2);
  assert.ok(timeoutElapsed >= 1_900 && timeoutElapsed < 3_000, `timeout took ${timeoutElapsed}ms`);

  for (const result of [
    invalid,
    httpFailure,
    missingToken,
    looseToken,
    linkedToken,
    networkFailure,
    timeoutFailure,
  ]) {
    assert.equal(result.args.includes(tokenValue), false);
    assert.equal(result.stdout.includes(tokenValue), false);
    assert.equal(result.stderr.includes(tokenValue), false);
  }
});

test('sender never follows redirects and cancels a streaming HTTP error body', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-conversation-hook-http-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const senderPath = join(home, CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME);
  const tokenFile = join(home, 'profile.token');
  const tokenValue = 'qa_hook_redirect_token';
  await writeFile(senderPath, renderClaudeConversationHookClientSource(), { mode: 0o700 });
  await writeFile(tokenFile, tokenValue, { mode: 0o600 });

  let redirectTargets = 0;
  const targetServer = http.createServer(async (req, res) => {
    redirectTargets += 1;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(204);
    res.end();
  });
  t.after(() => close(targetServer));
  const targetEndpoint = `${await listen(targetServer)}/must-not-receive`;

  let redirectSources = 0;
  const redirectServer = http.createServer(async (req, res) => {
    redirectSources += 1;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(307, { Location: targetEndpoint });
    res.end();
  });
  t.after(() => close(redirectServer));
  const redirectEndpoint = `${await listen(redirectServer)}/control/v1/conversation-hooks`;
  const redirected = await runSender(
    senderPath,
    redirectEndpoint,
    tokenFile,
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-hook-redirect-0001',
      prompt_id: '550e8400-e29b-41d4-a716-446655440003',
      prompt: 'redirect-private-prompt',
    }),
  );
  assert.deepEqual(
    { code: redirected.code, stdout: redirected.stdout, stderr: redirected.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(redirectSources, 1);
  assert.equal(redirectTargets, 0, 'Bearer and event body must not be replayed to a redirect target');

  let streamRequests = 0;
  const streamingServer = http.createServer(async (req, res) => {
    streamRequests += 1;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.flushHeaders();
    res.write('partial error body that deliberately never ends');
  });
  t.after(async () => {
    streamingServer.closeAllConnections?.();
    await close(streamingServer);
  });
  const streamingEndpoint = `${await listen(streamingServer)}/control/v1/conversation-hooks`;
  const started = Date.now();
  const streamed = await runSender(
    senderPath,
    streamingEndpoint,
    tokenFile,
    JSON.stringify({
      hook_event_name: 'StopFailure',
      session_id: 'session-hook-stream-0001',
      prompt_id: '550e8400-e29b-41d4-a716-446655440004',
      error: 'server_error',
    }),
  );
  const elapsed = Date.now() - started;
  assert.deepEqual(
    { code: streamed.code, stdout: streamed.stdout, stderr: streamed.stderr },
    { code: 0, stdout: '', stderr: '' },
  );
  assert.equal(streamRequests, 2);
  assert.ok(elapsed < 1_000, `streaming HTTP error cleanup took ${elapsed}ms`);
  assert.equal(streamed.args.includes(tokenValue), false);
  assert.equal(streamed.stdout.includes(tokenValue), false);
  assert.equal(streamed.stderr.includes(tokenValue), false);
});

test('invalid endpoints, relative paths, and incompatible settings fail without lossy overwrite', () => {
  assert.throws(
    () => buildClaudeConversationHookEndpoint('file:///tmp/claude'),
    /HTTP\(S\)/,
  );
  assert.throws(
    () => createClaudeConversationHookHandler({ ...OPTIONS, senderPath: 'relative/client.mjs' }),
    /absolute path/,
  );
  assert.throws(
    () => createClaudeConversationHookHandler({ ...OPTIONS, tokenFile: 'relative/token' }),
    /absolute path/,
  );
  assert.throws(
    () => createClaudeConversationHookHandler({ ...OPTIONS, endpoint: 'javascript:alert(1)' }),
    /HTTP\(S\)/,
  );
  assert.throws(
    () => mergeClaudeConversationHooks({ hooks: 'preserve-invalid-value' }, OPTIONS),
    /settings\.hooks must be a JSON object/,
  );
  assert.throws(
    () => mergeClaudeConversationHooks({ hooks: { Stop: 'preserve-invalid-value' } }, OPTIONS),
    /settings\.hooks\.Stop must be an array/,
  );
});
