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

  assert.match(html, /<form method="post" action="\/conversations"/);
  assert.match(html, /name="q" value="&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/);
  assert.match(html, /data-i18n="conversation-response-truncated"/);
  assert.match(html, /data-i18n="conversation-queue-dropped"/);
  assert.match(html, />3<\/strong>/);
  assert.match(html, /href="\/conversations\/42"[^>]*data-i18n="conversation-open"/);
  assert.match(html, /name="before_id" value="17"/);
  assert.match(html, /name="period" value="all"/);
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
    assert.match(html, /conversation-detail-shell/);
    assert.match(html, /conversation-detail-meta/);
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

test('conversation filters render bounded facets, selected values, counts, chips, and compact safe rows', () => {
  const members = Array.from({ length: 150 }, (_, index) => ({ value: `member-${index}`, label: `Member ${index}`, count: index + 1 }));
  const html = conversationsView({
    q: '<script>bad</script>',
    period: '168',
    memberLabel: 'member-149',
    deviceId: 'device-1',
    accountId: 'account-1',
    model: 'model-1',
    responseState: 'truncated',
    limit: 50,
    result: {
      totalMatches: 151,
      facets: {
        members,
        devices: [{ value: 'device-1', label: 'Laptop', count: 4 }],
        accounts: [{ value: 'account-1', label: 'Shared', count: 5 }],
        models: [{ value: 'model-1', label: 'Opus', count: 6 }],
        responseStates: [{ value: 'truncated', count: 2 }],
        truncated: true,
      },
      items: [{
        id: 42,
        startedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
        memberLabel: '<member>',
        deviceName: 'Laptop',
        accountAlias: 'Shared',
        model: 'Opus',
        promptSnippet: 'p'.repeat(700),
        responseSnippet: 'r'.repeat(700),
        responseState: 'truncated',
      }],
      nextBeforeId: 17,
    },
  });
  assert.match(html, /method="post" action="\/conversations"/);
  assert.match(html, /name="member_label"[^>]*list="conversation-member-facets"/);
  assert.match(html, /name="period"[^>]*value="168"/);
  assert.match(html, /conversation-filter-query/);
  assert.match(html, /conversation-filter-state/);
  assert.match(html, /data-facet-count="4"/);
  assert.match(html, /data-facet-count="5"/);
  assert.match(html, /data-facet-count="6"/);
  assert.match(html, /data-i18n="conversation-facets-truncated"/);
  assert.match(html, />151<\/strong>/);
  assert.match(html, /name="before_id" value="17"/);
  assert.equal((html.match(/<option value="member-/g) ?? []).length, 101, '100 top facets plus selected value');
  assert.equal(html.includes('<script>bad</script>'), false);
  assert.equal(html.includes('conversation-result-row'), true);
  assert.equal((html.match(/<p>p/g) ?? []).length, 1);
  assert.ok(html.length < 100 * 1024);
});

test('bounded search errors give actionable guidance while unknown errors stay fixed and opaque', () => {
  const invalidFilter = conversationsView({
    result: { items: [], nextBeforeId: null, error: 'conversation_filter_invalid' },
  });
  assert.match(invalidFilter, /data-i18n="conversation-filter-invalid"/);

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

test('persistent tabs link to captured conversations and mark the active page', () => {
  const html = dashboardView({
    accounts: [],
    devices: [],
    csrf: 'csrf',
    adminIdentity: 'admin@example.test',
  });
  assert.match(html, /href="\/conversations" data-i18n="tab-conversations"/);
  assert.doesNotMatch(html, /data-i18n="conversations-dashboard-link"/);
  const list = conversationsView({ result: { items: [], nextBeforeId: null, error: null } });
  assert.match(list, /href="\/conversations" data-i18n="tab-conversations" aria-current="page"/);
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
    'tab-overview',
    'tab-metrics',
    'tab-conversations',
    'conversations-dashboard-link',
    'conversation-privacy-heading',
    'conversation-privacy-notice',
    'conversation-open-warning',
    'conversation-search',
    'conversation-filter-hint',
    'conversation-next-page',
    'conversation-search-error',
    'conversation-search-query-too-short',
    'conversation-search-requires-indexed-terms',
    'conversation-filter-invalid',
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
