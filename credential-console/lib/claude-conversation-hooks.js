import { isAbsolute, win32 } from 'node:path';

export const CLAUDE_CONVERSATION_HOOK_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionEnd',
]);

export const CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME = 'conversation-hook-client.mjs';
export const CLAUDE_CONVERSATION_HOOK_UPDATER_FILENAME = 'install-conversation-hooks.mjs';

const CLIENT_SOURCE = `#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { TextDecoder } from 'node:util';

const MAX_EVENT_BYTES = 3 * 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 1000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 75;

function absolutePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\u0000')
    && (isAbsolute(value) || win32.isAbsolute(value));
}

function endpointUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readEvent() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_EVENT_BYTES) return null;
    chunks.push(buffer);
  }
  if (bytes === 0) return null;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  const parsed = JSON.parse(text);
  return projectEvent(parsed);
}

function boundedText(value, limit) {
  if (typeof value !== 'string' || value.includes('\\u0000') || hasUnpairedSurrogate(value)) return null;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return { text: value, truncated: false };
  let end = limit;
  while (end > 0) {
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    }
    catch { end -= 1; }
  }
  return { text: '', truncated: true };
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function projectEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const base = {
    hook_event_name: event.hook_event_name,
    session_id: event.session_id,
    ...(typeof event.prompt_id === 'string' ? { prompt_id: event.prompt_id } : {}),
    ...(typeof event.agent_id === 'string' ? { agent_id: 'present' } : {}),
  };
  if (event.hook_event_name === 'UserPromptSubmit') {
    const prompt = boundedText(event.prompt, MAX_PROMPT_BYTES);
    return prompt === null ? null : {
      ...base,
      prompt: prompt.text,
      truncated: prompt.truncated,
    };
  }
  if (event.hook_event_name === 'Stop') {
    const response = boundedText(event.last_assistant_message, MAX_RESPONSE_BYTES);
    if (response === null || typeof event.stop_hook_active !== 'boolean') return null;
    if ((event.background_tasks !== undefined && !Array.isArray(event.background_tasks))
      || (event.session_crons !== undefined && !Array.isArray(event.session_crons))) return null;
    return {
      ...base,
      stop_hook_active: event.stop_hook_active,
      last_assistant_message: response.text,
      truncated: response.truncated,
      background_tasks: event.background_tasks?.length ? [true] : [],
      session_crons: event.session_crons?.length ? [true] : [],
    };
  }
  if (event.hook_event_name === 'StopFailure') {
    return typeof event.error === 'string' ? { ...base, error: event.error } : null;
  }
  if (event.hook_event_name === 'SessionEnd') {
    return typeof event.reason === 'string' ? { ...base, reason: event.reason } : null;
  }
  return null;
}

async function readToken(tokenFile) {
  const flags = process.platform === 'win32'
    ? 'r'
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(tokenFile, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192) return null;
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return null;
    const token = (await handle.readFile({ encoding: 'utf8' })).trim();
    return token && !/[\\r\\n]/.test(token) ? token : null;
  } finally {
    await handle.close();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postOnce(endpoint, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      // Inspect redirects without following them so neither the bearer token
      // nor the captured text can be replayed to another origin.
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    await response.body?.cancel();
    if (response.ok) return 'success';
    return response.status === 429 || response.status >= 500 ? 'retry' : 'stop';
  } catch {
    return 'retry';
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  try {
    const [endpointInput, tokenFile] = process.argv.slice(2);
    const endpoint = endpointUrl(endpointInput);
    if (!endpoint || !absolutePath(tokenFile)) return;
    const event = await readEvent();
    if (!event) return;
    const token = await readToken(tokenFile);
    if (!token) return;

    const body = JSON.stringify(event);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await postOnce(endpoint, token, body);
      if (result !== 'retry') return;
      if (attempt + 1 < MAX_ATTEMPTS) await wait(RETRY_DELAY_MS);
    }
  } catch {
    // Conversation observation is best effort. Failures are silent and the
    // synchronous command hook has a strict, bounded runtime.
  }
}

await main().catch(() => {});
process.exitCode = 0;
`;

function safeAbsolutePath(value, name) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\u0000')
    || (!isAbsolute(value) && !win32.isAbsolute(value))) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function safeEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('endpoint must be an HTTP(S) URL');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('endpoint must be an HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash) {
    throw new TypeError('endpoint must be an HTTP(S) URL without credentials or a fragment');
  }
  return url.href;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('settings must contain finite JSON numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('settings must not contain cycles');
    seen.add(value);
    const result = value.map((entry) => cloneJsonData(entry, seen));
    seen.delete(value);
    return result;
  }
  if (!plainObject(value)) throw new TypeError('settings must contain JSON objects only');
  if (seen.has(value)) throw new TypeError('settings must not contain cycles');
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('settings must not contain accessors');
    }
    Object.defineProperty(result, key, {
      value: cloneJsonData(descriptor.value, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return result;
}

function normalizeOptions({ senderPath, endpoint, tokenFile } = {}) {
  return {
    senderPath: safeAbsolutePath(senderPath, 'senderPath'),
    endpoint: safeEndpoint(endpoint),
    tokenFile: safeAbsolutePath(tokenFile, 'tokenFile'),
  };
}

function managedHandler(handler, options) {
  if (!plainObject(handler)) return false;
  return handler.type === 'command'
    && handler.command === 'node'
    && Array.isArray(handler.args)
    && handler.args.length === 3
    && handler.args[0] === options.senderPath
    && handler.args[1] === options.endpoint
    && handler.args[2] === options.tokenFile;
}

function canonicalHandler(options) {
  return {
    type: 'command',
    command: 'node',
    args: [options.senderPath, options.endpoint, options.tokenFile],
    timeout: 3,
  };
}

function mergeEvent(existing, options) {
  const groups = Array.isArray(existing) ? existing : [];
  let installed = false;
  const merged = groups.map((group) => {
    if (!plainObject(group) || !Array.isArray(group.hooks)) return group;
    const hooks = [];
    for (const handler of group.hooks) {
      if (!managedHandler(handler, options)) {
        hooks.push(handler);
      } else if (!installed) {
        hooks.push(canonicalHandler(options));
        installed = true;
      }
    }
    return { ...group, hooks };
  });
  if (!installed) merged.push({ hooks: [canonicalHandler(options)] });
  return merged;
}

export function buildClaudeConversationHookEndpoint(claudeGatewayUrl) {
  if (typeof claudeGatewayUrl !== 'string' || claudeGatewayUrl.length === 0) {
    throw new TypeError('claudeGatewayUrl must be an HTTP(S) URL');
  }
  let url;
  try {
    url = new URL(claudeGatewayUrl);
  } catch {
    throw new TypeError('claudeGatewayUrl must be an HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new TypeError('claudeGatewayUrl must be an HTTP(S) URL without credentials, query, or fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/control/v1/conversation-hooks`;
  return url.href;
}

export function createClaudeConversationHookHandler(input) {
  return canonicalHandler(normalizeOptions(input));
}

export function buildClaudeConversationHooksPatch(input) {
  const options = normalizeOptions(input);
  return {
    hooks: Object.fromEntries(CLAUDE_CONVERSATION_HOOK_EVENTS.map((event) => [
      event,
      [{ hooks: [canonicalHandler(options)] }],
    ])),
  };
}

export function mergeClaudeConversationHooks(settings, input) {
  const options = normalizeOptions(input);
  const source = settings === undefined || settings === null ? {} : settings;
  if (!plainObject(source)) throw new TypeError('settings must be a JSON object');
  const merged = cloneJsonData(source);
  if (merged.hooks === undefined) merged.hooks = {};
  if (!plainObject(merged.hooks)) throw new TypeError('settings.hooks must be a JSON object');
  for (const event of CLAUDE_CONVERSATION_HOOK_EVENTS) {
    const existing = merged.hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new TypeError(`settings.hooks.${event} must be an array`);
    }
    merged.hooks[event] = mergeEvent(existing, options);
  }
  return merged;
}

export function mergeClaudeConversationHooksJson(settingsJson, input, { space = 2 } = {}) {
  if (typeof settingsJson !== 'string') throw new TypeError('settingsJson must be a string');
  const parsed = settingsJson.trim() ? JSON.parse(settingsJson) : {};
  return `${JSON.stringify(mergeClaudeConversationHooks(parsed, input), null, space)}\n`;
}

export function renderClaudeConversationHooksPatchJson(input, { space = 2 } = {}) {
  return `${JSON.stringify(buildClaudeConversationHooksPatch(input), null, space)}\n`;
}

export function renderClaudeConversationHookClientSource() {
  return CLIENT_SOURCE;
}

export function renderClaudeConversationHookUpdaterSource({ endpoint } = {}) {
  const safeHookEndpoint = safeEndpoint(endpoint);
  return `#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

const EVENTS = ${JSON.stringify(CLAUDE_CONVERSATION_HOOK_EVENTS)};
const ENDPOINT = ${JSON.stringify(safeHookEndpoint)};
const SENDER_FILENAME = ${JSON.stringify(CLAUDE_CONVERSATION_HOOK_CLIENT_FILENAME)};
const SENDER_SOURCE = ${JSON.stringify(CLIENT_SOURCE)};
const root = join(homedir(), '.config', 'claude-codex-gateway');
const senderPath = join(root, SENDER_FILENAME);
const profile = process.argv[2] ?? '';
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
  process.stdout.write(JSON.stringify({ updated: 0, skipped: 1 }) + '\\n');
  process.exit(0);
}
const targetSettings = 'claude-' + profile + '.settings.json';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function managed(handler) {
  return plainObject(handler)
    && handler.type === 'command'
    && handler.command === 'node'
    && Array.isArray(handler.args)
    && handler.args[0] === senderPath;
}

function canonical(tokenFile) {
  return { type: 'command', command: 'node', args: [senderPath, ENDPOINT, tokenFile], timeout: 3 };
}

function mergeEvent(value, tokenFile) {
  if (value !== undefined && !Array.isArray(value)) throw new Error('hook event must be an array');
  const groups = value ?? [];
  let installed = false;
  const next = groups.map((group) => {
    if (!plainObject(group) || !Array.isArray(group.hooks)) return group;
    const hooks = [];
    for (const handler of group.hooks) {
      if (!managed(handler)) hooks.push(handler);
      else if (!installed) { hooks.push(canonical(tokenFile)); installed = true; }
    }
    return { ...group, hooks };
  });
  if (!installed) next.push({ hooks: [canonical(tokenFile)] });
  return next;
}

async function writeAtomic(path, content, mode) {
  const temporary = path + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await chmod(temporary, mode).catch(() => {});
    await rename(temporary, path);
    await chmod(path, mode).catch(() => {});
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

await mkdir(root, { recursive: true, mode: 0o700 });
await writeAtomic(senderPath, SENDER_SOURCE, 0o700);
let updated = 0;
let skipped = 0;
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name !== targetSettings) continue;
  const settingsPath = join(root, entry.name);
  const tokenFile = join(root, entry.name.replace(/\\.settings\\.json$/, '.token'));
  try {
    if (!(await lstat(settingsPath)).isFile() || !(await lstat(tokenFile)).isFile()) {
      skipped += 1;
      continue;
    }
    const originalSettings = await readFile(settingsPath);
    const settings = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(originalSettings).replace(/^\\uFEFF/, ''),
    );
    if (!plainObject(settings)) throw new Error('settings root is not an object');
    if (settings.hooks === undefined) settings.hooks = {};
    if (!plainObject(settings.hooks)) throw new Error('settings hooks is not an object');
    for (const event of EVENTS) {
      if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event])) {
        throw new Error('hook event must be an array');
      }
    }
    for (const event of EVENTS) settings.hooks[event] = mergeEvent(settings.hooks[event], tokenFile);
    const currentSettings = await readFile(settingsPath);
    if (!currentSettings.equals(originalSettings)) {
      throw new Error('settings changed while hooks were being prepared');
    }
    const backupPath = settingsPath + '.pre-conversation-hooks';
    await copyFile(settingsPath, backupPath, constants.COPYFILE_EXCL).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await chmod(backupPath, 0o600).catch(() => {});
    await writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\\n', 0o600);
    updated += 1;
  } catch {
    skipped += 1;
  }
}
process.stdout.write(JSON.stringify({ updated, skipped }) + '\\n');
`;
}
