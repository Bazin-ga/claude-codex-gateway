import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONVERSATION_HOOK_KINDS,
  CONVERSATION_HOOK_PROMPT_MAX_BYTES,
  CONVERSATION_HOOK_RESPONSE_MAX_BYTES,
  normalizeConversationHookEvent,
  parseConversationHookEvent,
  PROMPT_ID_PATTERN,
  SESSION_END_REASONS,
  SESSION_ID_PATTERN,
  STOP_FAILURE_CODES,
} from '../lib/conversation-hook-event.js';

const sessionId = 'session-0123456789abcdef';
const promptId = '550e8400-e29b-41d4-a716-446655440000';

function common(hookEventName, extra = {}) {
  return { session_id: sessionId, hook_event_name: hookEventName, ...extra };
}

test('normalizes UserPromptSubmit and exposes only the fixed public shape', () => {
  const result = normalizeConversationHookEvent(common('UserPromptSubmit', {
    prompt_id: promptId,
    prompt: '用户输入🙂',
    transcript_path: '/private/transcript.jsonl',
    cwd: '/private/worktree',
    permission_mode: 'bypassPermissions',
  }));
  assert.deepEqual(result, {
    kind: CONVERSATION_HOOK_KINDS.USER_PROMPT_SUBMIT,
    sessionId,
    promptId,
    text: '用户输入🙂',
    truncated: false,
    failureCode: null,
    reason: null,
  });
  assert.deepEqual(Object.keys(result), [
    'kind', 'sessionId', 'promptId', 'text', 'truncated', 'failureCode', 'reason',
  ]);
  assert.equal(JSON.stringify(result).includes('transcript'), false);
  assert.equal(JSON.stringify(result).includes('worktree'), false);
  assert.equal(JSON.stringify(result).includes('permission'), false);
});

test('normalizes Stop and preserves complete Unicode response text', () => {
  assert.deepEqual(normalizeConversationHookEvent(common('Stop', {
    prompt_id: promptId,
    stop_hook_active: false,
    last_assistant_message: '完成🙂',
  })), {
    kind: CONVERSATION_HOOK_KINDS.STOP,
    sessionId,
    promptId,
    text: '完成🙂',
    truncated: false,
    failureCode: null,
    reason: null,
  });
});

test('normalizes StopFailure by retaining only the safe failure enum', () => {
  for (const error of STOP_FAILURE_CODES) {
    const result = normalizeConversationHookEvent(common('StopFailure', {
      error,
      error_details: 'secret provider detail',
      last_assistant_message: 'API Error: secret response body',
    }));
    assert.deepEqual(result, {
      kind: CONVERSATION_HOOK_KINDS.STOP_FAILURE,
      sessionId,
      promptId: null,
      text: '',
      truncated: false,
      failureCode: error,
      reason: null,
    });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('normalizes every current SessionEnd reason and rejects removed/unknown reasons', () => {
  for (const reason of SESSION_END_REASONS) {
    assert.deepEqual(normalizeConversationHookEvent(common('SessionEnd', { reason })), {
      kind: CONVERSATION_HOOK_KINDS.SESSION_END,
      sessionId,
      promptId: null,
      text: '',
      truncated: false,
      failureCode: null,
      reason,
    });
  }
  assert.equal(normalizeConversationHookEvent(common('SessionEnd', {
    reason: 'bypass_permissions_disabled',
  })), null);
  assert.equal(normalizeConversationHookEvent(common('SessionEnd', { reason: 'secret' })), null);
});

test('agent_id classifies otherwise valid events as ignored_subagent without leaking it', () => {
  const result = normalizeConversationHookEvent(common('Stop', {
    agent_id: 'subagent-42',
    stop_hook_active: false,
    last_assistant_message: 'subagent response',
  }));
  assert.deepEqual(result, {
    kind: CONVERSATION_HOOK_KINDS.IGNORED_SUBAGENT,
    sessionId,
    promptId: null,
    text: '',
    truncated: false,
    failureCode: null,
    reason: null,
  });
  assert.equal(JSON.stringify(result).includes('subagent-42'), false);
});

test('rejects arrays, wrong prototypes, accessors, proxies, and invalid field types', () => {
  assert.equal(normalizeConversationHookEvent([]), null);
  assert.equal(normalizeConversationHookEvent(Object.create({
    session_id: sessionId,
    hook_event_name: 'SessionEnd',
    reason: 'clear',
  })), null);

  const accessor = common('UserPromptSubmit', { prompt: 'safe' });
  Object.defineProperty(accessor, 'prompt', { get() { throw new Error('must not read'); } });
  assert.equal(normalizeConversationHookEvent(accessor), null);

  const proxy = new Proxy(common('SessionEnd', { reason: 'clear' }), {
    getOwnPropertyDescriptor() { throw new Error('hostile proxy'); },
  });
  assert.equal(normalizeConversationHookEvent(proxy), null);

  assert.equal(normalizeConversationHookEvent(common('Stop', {
    stop_hook_active: 'false',
    last_assistant_message: 'response',
  })), null);
  assert.equal(normalizeConversationHookEvent(common('StopFailure', { error: 'not-an-enum' })), null);
  assert.equal(normalizeConversationHookEvent(common('UserPromptSubmit', {
    prompt: 'safe',
    prompt_id: 'not-a-uuid',
  })), null);
});

test('enforces session and prompt identifier formats', () => {
  assert.equal(SESSION_ID_PATTERN.test(sessionId), true);
  assert.equal(PROMPT_ID_PATTERN.test(promptId), true);
  for (const value of ['', 'short', 'session/unsafe', 'session space', 'x'.repeat(129)]) {
    assert.equal(normalizeConversationHookEvent({
      session_id: value,
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    }), null, value);
  }
  for (const value of ['', '550e8400-e29b-41d4-a716-44665544000', '550e8400-e29b-01d4-a716-446655440000']) {
    assert.equal(normalizeConversationHookEvent(common('SessionEnd', {
      prompt_id: value,
      reason: 'clear',
    })), null, value);
  }
});

test('truncates oversized prompt and response at complete UTF-8 boundaries', () => {
  const prompt = 'a'.repeat(CONVERSATION_HOOK_PROMPT_MAX_BYTES - 1) + '🙂tail';
  const promptResult = normalizeConversationHookEvent(common('UserPromptSubmit', { prompt }));
  assert.equal(promptResult.truncated, true);
  assert.equal(Buffer.byteLength(promptResult.text, 'utf8') <= CONVERSATION_HOOK_PROMPT_MAX_BYTES, true);
  assert.equal(promptResult.text.endsWith('\uFFFD'), false);
  assert.equal(promptResult.text.endsWith('🙂'), false);
  assert.equal(promptResult.text, 'a'.repeat(CONVERSATION_HOOK_PROMPT_MAX_BYTES - 1));

  const response = 'b'.repeat(CONVERSATION_HOOK_RESPONSE_MAX_BYTES - 1) + '🙂tail';
  const responseResult = normalizeConversationHookEvent(common('Stop', {
    stop_hook_active: false,
    last_assistant_message: response,
  }));
  assert.equal(responseResult.truncated, true);
  assert.equal(Buffer.byteLength(responseResult.text, 'utf8') <= CONVERSATION_HOOK_RESPONSE_MAX_BYTES, true);
  assert.equal(responseResult.text.endsWith('\uFFFD'), false);
  assert.equal(responseResult.text, 'b'.repeat(CONVERSATION_HOOK_RESPONSE_MAX_BYTES - 1));
});

test('rejects invalid UTF-16 text rather than allowing replacement characters', () => {
  assert.equal(normalizeConversationHookEvent(common('UserPromptSubmit', { prompt: '\ud800' })), null);
  assert.equal(normalizeConversationHookEvent(common('Stop', {
    stop_hook_active: false,
    last_assistant_message: 'bad\u0000text',
  })), null);
});

test('parser alias has the same fail-closed behavior and output contract', () => {
  const input = common('UserPromptSubmit', { prompt: 'alias' });
  assert.deepEqual(parseConversationHookEvent(input), normalizeConversationHookEvent(input));
  assert.equal(normalizeConversationHookEvent(common('Unknown', { prompt: 'secret' })), null);
});
