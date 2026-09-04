// Codex conversation capture — the Codex counterpart of `claude-conversation-hooks.js`.
//
// Codex 0.153+ ships its own lifecycle hooks whose payloads mirror Claude Code's:
// `UserPromptSubmit` carries the full `prompt`, and `Stop` carries the final
// `last_assistant_message`. The one shape difference is the pairing key — Codex
// calls it `turn_id` where Claude calls it `prompt_id` — and Codex's `turn_id` is
// already a UUIDv7, so it satisfies the console's strict `PROMPT_ID_PATTERN`
// unchanged. This module renders a tiny client that re-labels `turn_id` as
// `prompt_id` and posts to the same `/claude/control/v1/conversation-hooks`
// endpoint the Claude client uses; the ingestion side is provider-agnostic and
// already accepts a Codex device token, so no server change is required.

export const CODEX_CONVERSATION_HOOK_EVENTS = Object.freeze(['UserPromptSubmit', 'Stop']);

export const CODEX_CONVERSATION_HOOK_CLIENT_FILENAME = 'codex-conversation-hook-client.mjs';

// The control path is not provider-specific; it is mounted once under the Claude
// prefix and authenticates by device token alone. Kept as a literal so this
// module has no import cycle with `machine-control.js`.
const CONVERSATION_HOOK_PATH = '/claude/control/v1/conversation-hooks';

/**
 * Derive the conversation-hook endpoint from the Codex gateway URL. The hook
 * control path lives at the console origin, not under the `/codex-api` data
 * prefix, so only the origin of the gateway URL is reused.
 */
export function buildCodexConversationHookEndpoint(codexGatewayUrl) {
  if (typeof codexGatewayUrl !== 'string' || codexGatewayUrl.length === 0) {
    throw new TypeError('codexGatewayUrl must be an HTTP(S) URL');
  }
  let url;
  try {
    url = new URL(codexGatewayUrl);
  } catch {
    throw new TypeError('codexGatewayUrl must be an HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new TypeError('codexGatewayUrl must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return `${url.origin}${CONVERSATION_HOOK_PATH}`;
}

/**
 * The Codex hook client. Codex invokes it as a synchronous command hook, passing
 * the event JSON on stdin and `<endpoint> <token-file>` on argv. It maps the
 * Codex event to the console's conversation-hook shape and posts it. Best effort:
 * every failure is silent and bounded so a hook can never delay or break a turn.
 */
export function renderCodexConversationHookClientSource() {
  return `#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 1000;

function boundedText(value, limit) {
  if (typeof value !== 'string') return { text: '', truncated: false };
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return { text: value, truncated: false };
  let end = limit;
  while (end > 0) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)), truncated: true };
    } catch { end -= 1; }
  }
  return { text: '', truncated: true };
}

async function readToken(tokenFile) {
  const flags = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(tokenFile, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192) return null;
    const token = (await handle.readFile({ encoding: 'utf8' })).trim();
    return token && !/[\\r\\n]/.test(token) ? token : null;
  } finally {
    await handle.close();
  }
}

async function main() {
  const [endpoint, tokenFile] = process.argv.slice(2);
  if (!endpoint || !tokenFile) return;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4 * 1024 * 1024) return;
    chunks.push(buffer);
  }
  if (bytes === 0) return;
  let event;
  try { event = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { return; }
  if (!event || typeof event !== 'object') return;

  const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
  const promptId = typeof event.turn_id === 'string' ? event.turn_id : '';
  if (!sessionId || !promptId) return;

  let payload = null;
  if (event.hook_event_name === 'UserPromptSubmit' && typeof event.prompt === 'string') {
    const bounded = boundedText(event.prompt, MAX_PROMPT_BYTES);
    if (bounded.text.length === 0) return;
    payload = { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt_id: promptId, prompt: bounded.text, truncated: bounded.truncated };
  } else if (event.hook_event_name === 'Stop') {
    const bounded = boundedText(typeof event.last_assistant_message === 'string' ? event.last_assistant_message : '', MAX_RESPONSE_BYTES);
    payload = { hook_event_name: 'Stop', session_id: sessionId, prompt_id: promptId, stop_hook_active: event.stop_hook_active === true, last_assistant_message: bounded.text, truncated: bounded.truncated, background_tasks: [], session_crons: [] };
  }
  if (!payload) return;

  let token;
  try { token = await readToken(tokenFile); } catch { return; }
  if (!token) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    await response.body?.cancel();
  } catch {
    // Conversation observation is best effort.
  } finally {
    clearTimeout(timer);
  }
}

await main().catch(() => {});
process.exitCode = 0;
`;
}
