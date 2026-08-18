import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

/**
 * Claude Code hook inputs are intentionally reduced to a small, non-secret
 * event projection before they can reach the conversation archive.  This
 * module accepts an already parsed JSON value; callers that read stdin/HTTP
 * must JSON.parse it before calling the normalizer.
 */

export const CONVERSATION_HOOK_EVENTS = Object.freeze({
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  STOP: 'Stop',
  STOP_FAILURE: 'StopFailure',
  SESSION_END: 'SessionEnd',
});

export const CONVERSATION_HOOK_KINDS = Object.freeze({
  USER_PROMPT_SUBMIT: 'user_prompt_submit',
  STOP: 'stop',
  STOP_FAILURE: 'stop_failure',
  SESSION_END: 'session_end',
  IGNORED_SUBAGENT: 'ignored_subagent',
  IGNORED_ACTIVE_WORK: 'ignored_active_work',
});

export const STOP_FAILURE_CODES = Object.freeze([
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
]);

export const SESSION_END_REASONS = Object.freeze([
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
]);

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const PROMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CONVERSATION_HOOK_PROMPT_MAX_BYTES = 256 * 1024;
export const CONVERSATION_HOOK_RESPONSE_MAX_BYTES = 1024 * 1024;

const EVENTS = new Set(Object.values(CONVERSATION_HOOK_EVENTS));
const FAILURE_CODES = new Set(STOP_FAILURE_CODES);
const END_REASONS = new Set(SESSION_END_REASONS);
const MISSING = Symbol('missing');

function isPlainJsonObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Read only own data properties. JSON.parse cannot create accessors, but this
 * also makes the boundary fail closed for test doubles, class instances, and
 * Proxy-backed values without evaluating malicious getters.
 */
function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return MISSING;
  if (!Object.hasOwn(descriptor, 'value')) return null;
  return descriptor.value;
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

function validText(value) {
  return typeof value === 'string'
    && !value.includes('\u0000')
    && !hasUnpairedSurrogate(value);
}

/**
 * Return a complete UTF-8 prefix. JavaScript strings can contain astral code
 * points, so a character-count slice is not sufficient for a byte contract.
 */
function boundedText(value, maxBytes) {
  if (!validText(value)) return null;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };

  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { text: '', truncated: true };
}

function optionalString(value) {
  if (value === MISSING) return { present: false, valid: true, value: null };
  return { present: true, valid: validText(value), value };
}

function output({ kind, sessionId, promptId = null, text = '', truncated = false, failureCode = null, reason = null }) {
  return Object.freeze({
    kind,
    sessionId,
    promptId,
    text,
    truncated,
    failureCode,
    reason,
  });
}

function ignoredSubagent(sessionId, promptId) {
  return output({
    kind: CONVERSATION_HOOK_KINDS.IGNORED_SUBAGENT,
    sessionId,
    promptId,
  });
}

function ignoredEvent(kind, sessionId, promptId) {
  return output({ kind, sessionId, promptId });
}

/**
 * Normalize one official Claude Code hook input. Invalid or unsupported input
 * returns null. The returned object has exactly seven public fields and never
 * carries transcript paths, cwd, permission fields, agent IDs, error details,
 * or arbitrary input properties.
 */
export function normalizeConversationHookEvent(input) {
  try {
    if (!isPlainJsonObject(input)) return null;

    const event = ownDataValue(input, 'hook_event_name');
    const sessionId = ownDataValue(input, 'session_id');
    if (event === MISSING || !EVENTS.has(event)) return null;
    if (sessionId === MISSING || typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return null;
    }

    const promptIdValue = ownDataValue(input, 'prompt_id');
    if (promptIdValue !== MISSING
      && (typeof promptIdValue !== 'string' || !PROMPT_ID_PATTERN.test(promptIdValue))) {
      return null;
    }
    const promptId = promptIdValue === MISSING ? null : promptIdValue;

    const agentIdValue = ownDataValue(input, 'agent_id');
    if (agentIdValue === null || (agentIdValue !== MISSING && !validText(agentIdValue))) return null;
    const hasAgentId = agentIdValue !== MISSING;

    if (event === CONVERSATION_HOOK_EVENTS.USER_PROMPT_SUBMIT) {
      const prompt = ownDataValue(input, 'prompt');
      const senderTruncated = ownDataValue(input, 'truncated');
      if (prompt === MISSING) return null;
      if (senderTruncated !== MISSING && typeof senderTruncated !== 'boolean') return null;
      const bounded = boundedText(prompt, CONVERSATION_HOOK_PROMPT_MAX_BYTES);
      if (!bounded || bounded.text.length === 0) return null;
      return hasAgentId
        ? ignoredSubagent(sessionId, promptId)
        : output({
          kind: CONVERSATION_HOOK_KINDS.USER_PROMPT_SUBMIT,
          sessionId,
          promptId,
          text: bounded.text,
          truncated: bounded.truncated || senderTruncated === true,
        });
    }

    if (event === CONVERSATION_HOOK_EVENTS.STOP) {
      const assistantMessage = ownDataValue(input, 'last_assistant_message');
      const stopHookActive = ownDataValue(input, 'stop_hook_active');
      const senderTruncated = ownDataValue(input, 'truncated');
      if (assistantMessage === MISSING || stopHookActive === MISSING || typeof stopHookActive !== 'boolean') {
        return null;
      }
      if (senderTruncated !== MISSING && typeof senderTruncated !== 'boolean') return null;
      const backgroundTasks = ownDataValue(input, 'background_tasks');
      const sessionCrons = ownDataValue(input, 'session_crons');
      if ((backgroundTasks !== MISSING && !Array.isArray(backgroundTasks))
        || (sessionCrons !== MISSING && !Array.isArray(sessionCrons))) return null;
      const bounded = boundedText(assistantMessage, CONVERSATION_HOOK_RESPONSE_MAX_BYTES);
      if (!bounded) return null;
      if (hasAgentId) return ignoredSubagent(sessionId, promptId);
      if ((backgroundTasks !== MISSING && backgroundTasks.length > 0)
        || (sessionCrons !== MISSING && sessionCrons.length > 0)) {
        return ignoredEvent(CONVERSATION_HOOK_KINDS.IGNORED_ACTIVE_WORK, sessionId, promptId);
      }
      return output({
          kind: CONVERSATION_HOOK_KINDS.STOP,
          sessionId,
          promptId,
          text: bounded.text,
          truncated: bounded.truncated || senderTruncated === true,
        });
    }

    if (event === CONVERSATION_HOOK_EVENTS.STOP_FAILURE) {
      const failureCode = ownDataValue(input, 'error');
      if (failureCode === MISSING || !FAILURE_CODES.has(failureCode)) return null;
      const details = optionalString(ownDataValue(input, 'error_details'));
      const assistantMessage = optionalString(ownDataValue(input, 'last_assistant_message'));
      if (!details.valid || !assistantMessage.valid) return null;
      return hasAgentId
        ? ignoredSubagent(sessionId, promptId)
        : output({
          kind: CONVERSATION_HOOK_KINDS.STOP_FAILURE,
          sessionId,
          promptId,
          failureCode,
        });
    }

    const reason = ownDataValue(input, 'reason');
    if (reason === MISSING || !END_REASONS.has(reason)) return null;
    return hasAgentId
      ? ignoredSubagent(sessionId, promptId)
      : output({
        kind: CONVERSATION_HOOK_KINDS.SESSION_END,
        sessionId,
        promptId,
        reason,
      });
  } catch {
    return null;
  }
}

// Explicit alias for callers that prefer parser terminology.
export const parseConversationHookEvent = normalizeConversationHookEvent;
