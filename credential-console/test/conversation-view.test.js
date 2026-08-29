import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  conversationDetailView,
  conversationRoundDetailView,
  conversationSessionDetailView,
  conversationSessionsView,
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

  assert.match(html, /<form method="post" action="\/conversation-turns"/);
  assert.match(html, /name="q" value="&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/);
  assert.match(html, /data-i18n="conversation-response-truncated"/);
  assert.match(html, /data-i18n="conversation-queue-dropped"/);
  assert.match(html, />3<\/strong>/);
  assert.match(html, /href="\/conversation-turns\/42"[^>]*data-i18n="conversation-open"/);
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

test('conversation prompt display unwraps known client wrappers, falls back safely, and exposes omission state', () => {
  const wrapperHtml = conversationsView({
    result: {
      items: [baseItem({
        promptText: '<conversation>\nsafe user text\n</conversation>\n\n<img src=x onerror=alert(1)>',
        promptSnippet: '<img src=x onerror=alert(1)>',
        promptBytes: 96,
      })],
      nextBeforeId: null,
      error: null,
    },
  });
  assert.match(wrapperHtml, /Captured API user text/);
  assert.match(wrapperHtml, /safe user text/);
  assert.match(wrapperHtml, /data-prompt-source="wrapper_removed"/);
  assert.match(wrapperHtml, /data-prompt-suffix-omitted="true"/);
  assert.match(wrapperHtml, /conversation-prompt-suffix-omitted/);
  assert.match(wrapperHtml, /conversation-prompt-disclaimer/);
  assert.equal(wrapperHtml.includes('<img src=x'), false);

  const fallbackHtml = conversationsView({
    result: {
      items: [baseItem({ promptSnippet: '<unknown-wrapper><img src=x onerror=alert(1)></unknown-wrapper>' })],
      nextBeforeId: null,
      error: null,
    },
  });
  assert.match(fallbackHtml, /data-prompt-source="fallback_raw"/);
  assert.match(fallbackHtml, /conversation-prompt-source-fallback/);
  assert.equal(fallbackHtml.includes('<img src=x'), false);
});

test('conversation detail trusts persisted prompt provenance and keeps long text wrapped on mobile', () => {
  const html = conversationDetailView({
    result: {
      turn: baseItem({
        promptText: 'already displayed API text',
        promptSource: 'wrapper_removed',
        promptSuffixOmitted: true,
        responseText: 'reply',
      }),
      error: null,
    },
  });
  assert.match(html, /already displayed API text/);
  assert.match(html, /data-prompt-source="wrapper_removed"/);
  assert.match(html, /data-prompt-suffix-omitted="true"/);
  assert.match(html, /conversation-prompt-disclaimer/);
  assert.match(html, /word-break: break-word/);
  assert.match(html, /overflow-wrap: anywhere/);
});

test('conversation session list renders only hook-backed rounds and links captured turns separately', () => {
  const html = conversationSessionsView({
    openMode: true,
    q: '<script>query</script>',
    result: {
      totalMatches: 1,
      nextBeforeId: 6,
      nextBeforeActivityMs: Date.parse('2026-08-17T12:30:00Z'),
      legacyFragmentCount: 4,
      droppedConversations: 2,
      facets: {
        members: [{ value: 'alice', count: 3 }],
        devices: [], accounts: [], models: [], responseStates: [],
      },
      items: [{
        id: 7,
        threadKey: 'must-never-render-thread-key',
        rawSessionId: 'must-never-render-session-id',
        turnCount: 3,
        firstPromptAtMs: Date.parse('2026-08-17T12:00:00Z'),
        lastActivityAtMs: Date.parse('2026-08-17T12:30:00Z'),
        deviceId: 'device-7',
        memberLabel: HOSTILE,
        accountAlias: 'account-safe',
        model: 'model-safe',
        firstPromptText: 'exact first prompt',
        latestPromptText: 'exact latest prompt',
        latestResponseText: HOSTILE,
        latestResponseState: 'complete',
        pendingCount: 0,
        completeCount: 3,
        failedCount: 0,
        unavailableCount: 0,
      }],
      error: null,
    },
  });
  assert.match(html, /href="\/conversations\/session\/7"/);
  assert.match(html, /method="post" action="\/conversations"/);
  assert.match(html, /name="before_id" value="6"/);
  assert.match(html, /name="before_activity_ms" value="1786969800000"/);
  assert.match(html, /data-i18n="conversation-session-turn-count">Turns<\/span>: 3/);
  assert.match(html, /data-i18n="conversation-captured-turns-notice"/);
  assert.match(html, /href="\/conversation-turns\?q=%3Cscript%3Equery%3C%2Fscript%3E"/);
  assert.match(html, /data-prompt-source="claude_hook"/);
  assert.match(html, /data-prompt-suffix-omitted="false"/);
  assert.equal(html.includes('must-never-render-thread-key'), false);
  assert.equal(html.includes('must-never-render-session-id'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>query</script>'), false);
});

function filteredSessions(overrides = {}) {
  return conversationSessionsView({
    q: 'needle',
    period: '168',
    memberLabel: 'alice',
    deviceId: 'device-9',
    accountId: 'codex-shared-1',
    model: 'gpt-5',
    responseState: 'pending',
    result: {
      totalMatches: 1,
      legacyFragmentCount: 4,
      facets: { members: [], devices: [], accounts: [], models: [], responseStates: [] },
      items: [{
        id: 7,
        turnCount: 1,
        firstPromptAtMs: Date.parse('2026-08-17T12:00:00Z'),
        lastActivityAtMs: Date.parse('2026-08-17T12:30:00Z'),
        deviceId: 'device-9',
        memberLabel: 'alice',
        accountAlias: 'account-safe',
        model: 'gpt-5',
        latestPromptText: 'exact latest prompt',
        latestResponseText: 'exact latest response',
        latestResponseState: 'complete',
      }],
      error: null,
    },
    ...overrides,
  });
}

test('the captured-turns link carries the active rounds filters', () => {
  // The link used to be bare, so narrowing the rounds list to one account and
  // following it landed on the unfiltered turns page — the failure that made a
  // Codex account, which produces no rounds at all, look like a broken feature.
  const html = filteredSessions();
  assert.match(
    html,
    /href="\/conversation-turns\?q=needle&amp;period=168&amp;member_label=alice&amp;device_id=device-9&amp;account_id=codex-shared-1&amp;model=gpt-5"/,
  );
  assert.match(html, /data-i18n="conversation-captured-turns-notice"/);
  // `pending` is a round state; the turns route answers it with
  // conversation_filter_invalid, so carrying it would trade the page for a 400.
  assert.equal(html.includes('response_state=pending'), false);
});

test('the captured-turns link keeps a response state both conversation pages accept', () => {
  assert.match(filteredSessions({ responseState: 'complete' }), /&amp;response_state=complete"/);
  assert.match(
    filteredSessions({ period: 'all', q: '', fromText: '2026-08-20T00:00', toText: '2026-08-21T00:00' }),
    /href="\/conversation-turns\?from=2026-08-20T00%3A00&amp;to=2026-08-21T00%3A00[^"]*"/,
  );
});

// The stylesheet names the class too, so an element check has to be anchored to
// the rendered attribute rather than the bare class name.
const TURNS_POINTER = 'class="notice conversation-legacy-notice conversation-turns-pointer"';

test('an emptied filter promotes the captured-turns pointer out of the footnotes', () => {
  const empty = { totalMatches: 0, legacyFragmentCount: 4, items: [], error: null };
  const html = filteredSessions({ result: { ...empty, facets: {} } });
  assert.match(html, /data-i18n="conversation-session-no-results"/);
  assert.ok(html.includes(TURNS_POINTER));
  assert.match(html, /data-i18n="conversation-captured-turns-filtered"/);
  assert.match(html, /account_id=codex-shared-1/);
  // Promoted, not duplicated: the footnote copy stands down while the pointer
  // is answering the question, and the pointer sits after the collapsible
  // filter panel rather than inside it.
  assert.equal((html.match(/data-i18n="conversation-captured-turns-heading"/g) ?? []).length, 1);
  assert.ok(html.indexOf(TURNS_POINTER) > html.indexOf('aria-labelledby="conversation-sessions-results-heading"'));
  // The results region is what an in-place filter change re-renders, so the
  // pointer has to live there or it never appears for a scripted browser.
  assert.ok(filteredSessions({ fragment: true, result: { ...empty, facets: {} } }).includes(TURNS_POINTER));
});

test('an unfiltered empty rounds list keeps the hook-install card', () => {
  const html = conversationSessionsView({
    result: { totalMatches: 0, legacyFragmentCount: 4, items: [], facets: {}, error: null },
  });
  assert.match(html, /data-i18n="conversation-round-empty-heading"/);
  assert.equal(html.includes(TURNS_POINTER), false);
  assert.match(html, /data-i18n="conversation-captured-turns-heading"/);
});

test('conversation session detail renders a bounded forward timeline with explicit empty states', () => {
  const turns = Array.from({ length: 201 }, (_, index) => {
    const turnIndex = index + 1;
    return {
      id: 1_000 + turnIndex,
      turnIndex,
      promptAtMs: Date.parse('2026-08-17T00:00:00Z') + turnIndex,
      completedAtMs: Date.parse('2026-08-17T00:00:01Z') + turnIndex,
      memberLabel: `member-${turnIndex}`,
      accountAlias: 'account-safe',
      model: 'model-safe',
      promptText: turnIndex === 2 ? 'safe prompt' : `prompt-${String(turnIndex).padStart(3, '0')}`,
      source: 'claude_hook',
      responseText: turnIndex === 1
        ? ''
        : turnIndex === 3
          ? 'r'.repeat((16 * 1024) + 20)
          : `response-${turnIndex}`,
      responseState: turnIndex === 1 ? 'complete' : turnIndex === 2 ? 'failed' : 'complete',
      failureCode: turnIndex === 2 ? 'server_error' : null,
      responseDisplayTruncated: turnIndex === 3,
      threadKey: 'must-never-render-turn-thread-key',
    };
  }).reverse();
  const html = conversationSessionDetailView({
    result: {
      session: {
        id: 7,
        turnCount: 201,
        firstPromptAtMs: Date.parse('2026-08-17T00:00:00Z') + 1,
        lastActivityAtMs: Date.parse('2026-08-17T00:00:01Z') + 201,
        turns,
        truncated: true,
        threadKey: 'must-never-render-session-thread-key',
        rawSessionId: 'must-never-render-raw-session-id',
      },
      error: null,
    },
  });
  assert.equal((html.match(/class="conversation-timeline-turn"/g) ?? []).length, 200);
  assert.ok(html.indexOf('prompt-001') < html.indexOf('safe prompt'));
  assert.match(html, /prompt-200/);
  assert.equal(html.includes('prompt-201'), false);
  assert.match(html, /data-i18n="conversation-session-truncated"/);
  assert.match(html, /data-i18n="conversation-round-empty-response"/);
  assert.match(html, /data-i18n="conversation-round-failed"/);
  assert.match(html, /data-i18n="conversation-session-timeline-clipped"/);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<tail>'), false);
  assert.equal(html.includes('must-never-render-session-thread-key'), false);
  assert.equal(html.includes('must-never-render-turn-thread-key'), false);
  assert.equal(html.includes('must-never-render-raw-session-id'), false);
  assert.ok(Buffer.byteLength(html, 'utf8') < 10 * 1024 * 1024);
  assert.match(html, /\.conversation-message \{ width: min\(92%, 820px\)/);
  assert.match(html, /\.conversation-message \{ width: 100%; \}/);
});

test('conversation session detail has safe 404 and unavailable states', () => {
  const missing = conversationSessionDetailView({ result: { session: null, error: null } });
  assert.match(missing, /data-i18n="conversation-session-not-found"/);
  assert.match(missing, /href="\/conversations"/);
  const unavailable = conversationSessionDetailView({
    result: { session: null, error: 'private_database_detail' },
  });
  assert.match(unavailable, /data-i18n="conversation-session-read-error"/);
  assert.equal(unavailable.includes('private_database_detail'), false);
});

test('reliable round detail keeps hook text exact, paired, escaped, and linked to its session', () => {
  const literalWrapper = '<session>\nliteral user text\n</session>';
  const html = conversationRoundDetailView({
    result: {
      round: {
        id: 9,
        conversationSessionId: 7,
        turnIndex: 2,
        promptAtMs: Date.parse('2026-08-17T12:00:00Z'),
        completedAtMs: Date.parse('2026-08-17T12:00:01Z'),
        memberLabel: HOSTILE,
        deviceId: 'device-safe',
        accountAlias: 'account-safe',
        promptText: literalWrapper,
        source: 'claude_hook',
        responseText: HOSTILE,
        responseState: 'complete',
      },
      error: null,
    },
  });
  assert.match(html, /data-conversation-round-id="9"/);
  assert.match(html, /href="\/conversations\/session\/7"/);
  assert.match(html, /data-prompt-source="claude_hook"/);
  assert.match(html, /&lt;session&gt;\nliteral user text\n&lt;\/session&gt;/);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /data-i18n="conversation-final-response"/);
});

test('null and read/search errors fail closed without undefined content', () => {
  const list = conversationsView({
    result: { items: null, nextBeforeId: null, error: 'search_unavailable' },
  });
  assert.match(list, /data-i18n="conversation-search-error"/);
  assert.match(list, /API-turn search could not be completed/);
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
  assert.match(html, /method="post" action="\/conversation-turns"/);
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
  assert.match(unknown, /API-turn search could not be completed/);
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
  const turnList = conversationsView({ result: { items: [], nextBeforeId: null, error: null } });
  assert.match(turnList, /href="\/conversations" data-i18n="tab-conversations" aria-current="page"/);
  assert.match(turnList, /href="\/conversation-turns" data-i18n="conversation-subnav-turns" aria-current="page"/);
  const sessions = conversationSessionsView({ result: { items: [], nextBeforeId: null, error: null } });
  assert.match(sessions, /href="\/conversations" data-i18n="conversation-subnav-sessions" aria-current="page"/);
});

test('dashboard exposes a token-free, profile-scoped hook updater for existing Claude installs', () => {
  const html = dashboardView({
    accounts: [{
      id: 'account-1', provider: 'claude', alias: 'claude-team', status: 'healthy',
      active_devices: 1, email_label: 'owner@example.test', expires_at: null,
    }],
    devices: [],
    csrf: 'csrf',
    adminIdentity: 'admin@example.test',
    claudeGatewayUrl: 'https://gateway.example.test/claude',
  });
  assert.match(html, /id="conversation-capture-upgrade"/);
  assert.match(html, /data-download-name="install-conversation-hooks\.mjs"/);
  assert.match(html, /claude\/control\/v1\/conversation-hooks/);
  assert.match(html, /node &quot;\$HOME\/Downloads\/install-conversation-hooks\.mjs&quot; claude-team/);
  assert.match(html, /UserPromptSubmit/);
  assert.match(html, /Claude user-submitted prompts and final visible assistant responses are permanently stored[\s\S]*do not deny or terminate Claude[\s\S]*failed synchronous command hook[\s\S]*bounded delay/i);
  assert.match(html, /Reliable prompt pairing requires Claude Code 2\.1\.196 or newer/);
  assert.doesNotMatch(html, /Bearer [A-Za-z0-9_-]{16,}/);
  assert.doesNotMatch(html, /oauth_token|token_sha256/);
});

test('Chinese translations and operator documentation cover permanent captured-turn exposure', async () => {
  const [server, rootReadme, rootReadmeZh, consoleReadme, deploy] = await Promise.all([
    Promise.all([
      readFile(new URL('../server.js', import.meta.url), 'utf8'),
      readFile(new URL('../web/console-client.js', import.meta.url), 'utf8'),
    ]).then((parts) => parts.join('\n')),
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
    'conversation-round-dropped',
    'conversation-response-complete',
    'conversation-response-incomplete',
    'conversation-response-truncated',
    'conversation-response-unavailable',
    'conversation-prompt-disclaimer',
    'conversation-prompt-source-captured',
    'conversation-prompt-source-wrapper',
    'conversation-prompt-source-fallback',
    'conversation-prompt-source-empty',
    'conversation-prompt-suffix-omitted',
    'conversation-subnav-sessions',
    'conversation-subnav-turns',
    'conversation-sessions-label',
    'conversation-sessions-heading',
    'conversation-sessions-intro',
    'conversation-session-heading',
    'conversation-session-open',
    'conversation-session-open-turn',
    'conversation-session-turn-count',
    'conversation-session-first-at',
    'conversation-session-last-at',
    'conversation-session-latest-preview',
    'conversation-session-total-matches',
    'conversation-session-no-results',
    'conversation-session-pagination-hint',
    'conversation-session-filter-hint',
    'conversation-session-search',
    'conversation-session-filter-invalid',
    'conversation-session-search-query-too-short',
    'conversation-session-search-requires-indexed-terms',
    'conversation-session-search-error',
    'conversation-session-read-error',
    'conversation-session-not-found',
    'conversation-session-back',
    'conversation-session-detail-intro',
    'conversation-session-turn',
    'conversation-session-incomplete-turn',
    'conversation-session-truncated-turn',
    'conversation-session-empty-assistant',
    'conversation-session-timeline-clipped',
    'conversation-session-truncated',
    'conversation-session-empty',
    'conversation-standalone-heading',
    'conversation-standalone-notice',
    'conversation-standalone-link',
    'conversation-round-privacy-heading',
    'conversation-round-privacy-notice',
    'conversation-captured-turns-heading',
    'conversation-captured-turns-notice',
    'conversation-captured-turns-filtered',
    'conversation-captured-turns-link',
    'conversation-round-empty-heading',
    'conversation-round-empty-copy',
    'conversation-round-install-hooks',
    'conversation-user-message',
    'conversation-final-response',
    'conversation-hook-prompt-disclaimer',
    'conversation-prompt-source-hook',
    'conversation-response-pending',
    'conversation-response-failed',
    'conversation-round-pending',
    'conversation-round-failed',
    'conversation-round-unavailable',
    'conversation-round-response-pending',
    'conversation-round-empty-response',
    'conversation-round-prompt-truncated',
    'conversation-round-response-truncated',
    'conversation-hook-upgrade-heading',
    'conversation-hook-upgrade-copy',
    'conversation-hook-upgrade-privacy',
    'conversation-hook-version-note',
    'conversation-hook-download',
    'conversation-hook-copy',
    'conversation-hook-run-heading',
    'conversation-hook-restart-note',
    'conversation-hook-installer-privacy',
    'conversation-failure-rate-limit',
    'conversation-failure-overloaded',
    'conversation-failure-authentication-failed',
    'conversation-failure-oauth-org-not-allowed',
    'conversation-failure-billing-error',
    'conversation-failure-invalid-request',
    'conversation-failure-model-not-found',
    'conversation-failure-server-error',
    'conversation-failure-max-output-tokens',
    'conversation-failure-session-end',
    'conversation-failure-unavailable',
    'conversation-failure-unknown',
  ]) {
    assert.match(server, new RegExp(`'${key}':`), `missing translation key ${key}`);
  }
  assert.match(server, /'conversation-hook-upgrade-privacy':\s*'[^']*永久保存[^']*提示词[^']*最终可见[^']*拒绝或终止 Claude[^']*同步命令 Hook[^']*有界延迟/);
  assert.match(server, /'conversation-hook-installer-privacy':\s*'[^']*永久保存[^']*提示词[^']*最终可见[^']*拒绝或终止 Claude[^']*同步命令 Hook[^']*有界延迟/);
  assert.match(consoleReadme, /three consecutive Chinese characters/i);
  assert.match(deploy, /three consecutive Chinese characters/i);
  for (const document of [rootReadme, rootReadmeZh, consoleReadme, deploy]) {
    assert.match(document, /permanently (?:store|stores|retain|send)|永久(?:保存|保留|发送)/i);
    assert.match(document, /API[\s-]*(?:fragment|request)|API[^\n]{0,40}片段/i);
    assert.match(document, /Codex[^\n]{0,80}(?:not covered|outside|不在|范围)/i);
    assert.match(document, /open[^\n]{0,180}(?:anyone|tailnet|没有身份|无身份|阅读审计|read)/i);
    assert.match(document, /(?:(?:not|never) (?:represented|presented) as|rather than)\s+(?:a )?human|不是(?:用户|人类)回合|不.*冒充人类对话/i);
  }
});
