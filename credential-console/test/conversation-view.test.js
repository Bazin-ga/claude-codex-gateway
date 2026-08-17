import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  conversationDetailView,
  conversationsView,
  dashboardView,
} from '../lib/views.js';

const HOSTILE = '<img src=x onerror=alert(1)>&"\'\n';

function baseItem(overrides = {}) {
  return {
    id: 42,
    startedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
    deviceId: 'device-42',
    machineId: null,
    memberLabel: 'alice',
    accountId: 'account-42',
    accountAlias: 'claude-team',
    model: 'claude-test',
    promptBytes: 12,
    promptSnippet: 'hello\nworld',
    responseState: 'complete',
    responseBytes: 14,
    responseSnippet: 'assistant reply',
    ...overrides,
  };
}

test('conversation list renders search, escaped snippets, status, queue drop, and keyset next page', () => {
  const html = conversationsView({
    openMode: true,
    q: HOSTILE,
    limit: 20,
    queueDropped: 3,
    result: {
      items: [baseItem({
        memberLabel: HOSTILE,
        accountAlias: HOSTILE,
        model: HOSTILE,
        promptSnippet: ' prompt\n  whitespace ',
        responseSnippet: HOSTILE,
        responseState: 'truncated',
      })],
      nextBeforeId: 17,
      error: null,
    },
  });

  assert.match(html, /<form method="get" action="\/conversations"/);
  assert.match(html, /name="q" value="&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/);
  assert.match(html, /data-i18n="conversation-response-truncated"/);
  assert.match(html, /data-i18n="conversation-queue-dropped"/);
  assert.match(html, />3<\/strong>/);
  assert.match(html, /href="\/conversations\/42"[^>]*data-i18n="conversation-open"/);
  assert.match(html, /href="\/conversations\?q=%3Cimg%20src%3Dx%20onerror%3Dalert\(1\)%3E%26%22&#39;%0A&amp;before_id=17&amp;limit=20"/);
  assert.match(html, /prompt\n  whitespace/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>alert'), false);
  assert.match(html, /data-i18n="conversation-privacy-notice"/);
  assert.match(html, /data-i18n="conversation-open-warning"/);
});

test('conversation detail strictly escapes full text and preserves pre whitespace for every response state', () => {
  for (const responseState of ['complete', 'incomplete', 'truncated', 'unavailable']) {
    const html = conversationDetailView({
      openMode: false,
      result: {
        turn: {
          ...baseItem({
            responseState,
            promptText: '  first line\n\tsecond line  ',
            responseText: responseState === 'unavailable' ? '' : ` reply\n${HOSTILE}`,
          }),
        },
        error: null,
      },
    });
    assert.match(html, new RegExp(`data-i18n="conversation-response-${responseState}"`));
    assert.match(html, /<pre>  first line\n\tsecond line  <\/pre>/);
    if (responseState === 'unavailable') {
      assert.match(html, /data-i18n="conversation-empty-response"/);
    } else {
      assert.match(html, /<pre> reply\n&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/);
    }
    assert.equal(html.includes('<img src=x'), false);
  }
});

test('null and read/search errors fail closed without undefined content', () => {
  const list = conversationsView({
    result: { items: null, nextBeforeId: null, error: 'search_unavailable' },
  });
  assert.match(list, /data-i18n="conversation-search-error"/);
  assert.match(list, /Conversation search could not be completed/);
  assert.equal(list.includes('search_unavailable'), false);
  assert.match(list, /data-i18n="conversation-no-results"/);
  assert.equal(list.includes('undefined'), false);

  const detail = conversationDetailView({
    result: { turn: null, error: 'conversation_unavailable' },
  });
  assert.match(detail, /data-i18n="conversation-read-error"/);
  assert.match(detail, /conversation_unavailable/);
  assert.match(detail, /data-i18n="conversation-back"/);
  assert.equal(detail.includes('undefined'), false);
});

test('bounded search errors give actionable guidance while unknown errors stay fixed and opaque', () => {
  const tooShort = conversationsView({
    result: { items: [], nextBeforeId: null, error: 'search_query_too_short' },
  });
  assert.match(tooShort, /data-i18n="conversation-search-query-too-short"/);
  assert.match(tooShort, /three consecutive Chinese characters/);
  assert.match(tooShort, /remove standalone punctuation/);
  assert.equal(tooShort.includes('search_query_too_short'), false);

  const indexed = conversationsView({
    result: { items: [], nextBeforeId: null, error: 'search_query_requires_indexed_terms' },
  });
  assert.match(indexed, /data-i18n="conversation-search-requires-indexed-terms"/);
  assert.match(indexed, /split the query/);
  assert.equal(indexed.includes('search_query_requires_indexed_terms'), false);

  const unknown = conversationsView({
    result: { items: [], nextBeforeId: null, error: 'database_internal_detail_should_not_render' },
  });
  assert.match(unknown, /data-i18n="conversation-search-error"/);
  assert.match(unknown, /Conversation search could not be completed/);
  assert.equal(unknown.includes('database_internal_detail_should_not_render'), false);
});

test('dashboard management area links to captured conversations', () => {
  const html = dashboardView({
    accounts: [],
    devices: [],
    csrf: 'csrf',
    adminIdentity: 'admin@example.test',
  });
  assert.match(html, /href="\/conversations"[^>]*data-i18n="conversations-dashboard-link"/);
});

test('Chinese translations and operator documentation cover permanent conversation exposure', async () => {
  const [server, rootReadme, rootReadmeZh, consoleReadme, deploy] = await Promise.all([
    readFile(new URL('../server.js', import.meta.url), 'utf8'),
    readFile(new URL('../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../README.zh-CN.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../DEPLOY.md', import.meta.url), 'utf8'),
  ]);
  for (const key of [
    'conversations-dashboard-link',
    'conversation-privacy-heading',
    'conversation-privacy-notice',
    'conversation-open-warning',
    'conversation-search',
    'conversation-next-page',
    'conversation-search-error',
    'conversation-search-query-too-short',
    'conversation-search-requires-indexed-terms',
    'conversation-queue-dropped',
    'conversation-response-complete',
    'conversation-response-incomplete',
    'conversation-response-truncated',
    'conversation-response-unavailable',
  ]) {
    assert.match(server, new RegExp(`'${key}':`), `missing translation key ${key}`);
  }
  assert.match(consoleReadme, /three consecutive Chinese characters/i);
  assert.match(deploy, /three consecutive Chinese characters/i);
  for (const document of [rootReadme, rootReadmeZh, consoleReadme, deploy]) {
    assert.match(document, /permanently (?:stores|retain)|永久(?:保存|保留)/i);
    assert.match(document, /captured[\s\S]{0,40}conversation|已捕获[\s\S]{0,40}对话/i);
    assert.match(document, /Codex[^\n]{0,80}(?:not covered|outside|不在|范围)/i);
    assert.match(document, /open[^\n]{0,180}(?:anyone|tailnet|没有身份|无身份|阅读审计|read)/i);
  }
});
