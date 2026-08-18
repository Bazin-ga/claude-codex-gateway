import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function conversationMetrics({ unavailable = false, searchError = null } = {}) {
  const calls = {
    searches: [],
    turnSearches: [],
    facets: [],
    sessionFacets: [],
    reads: [],
    sessionReads: [],
  };
  return {
    calls,
    stats: { conversation: { dropped: 2 } },
    flush() {},
    searchConversationSessions(options) {
      calls.searches.push(options);
      if (unavailable || searchError) {
        return {
          items: [], nextBeforeId: null, standaloneCount: 3,
          error: searchError ?? 'search_unavailable',
        };
      }
      return {
        items: [{
          id: 7,
          turnCount: 2,
          firstStartedAtMs: Date.parse('2026-08-17T12:30:00.000Z'),
          lastStartedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
          deviceId: 'device-safe',
          memberLabel: '<img src=x onerror=alert(1)>',
          accountAlias: 'account-safe',
          model: 'model-safe',
          latestPromptSnippet: 'latest prompt snippet',
          latestPromptSource: 'captured_api_user_text',
          latestPromptSuffixOmitted: false,
          latestResponseSnippet: 'latest reply snippet',
          latestResponseState: 'complete',
        }],
        nextBeforeId: 17,
        standaloneCount: 3,
        totalMatches: 1,
        error: null,
      };
    },
    searchConversations(options) {
      calls.turnSearches.push(options);
      if (unavailable || searchError) {
        return { items: [], nextBeforeId: null, error: searchError ?? 'search_unavailable' };
      }
      return {
        items: [{
          id: 42,
          startedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
          memberLabel: '<img src=x onerror=alert(1)>',
          accountAlias: 'account-safe',
          model: 'model-safe',
          promptSnippet: 'prompt snippet',
          responseSnippet: 'reply snippet',
          responseState: 'complete',
        }],
        nextBeforeId: 17,
        error: null,
      };
    },
    queryConversationFacets(options) {
      calls.facets.push(options);
      return {
        members: [{ value: 'member-safe', count: 2 }],
        devices: [{ value: 'device-safe', count: 2 }],
        accounts: [{ value: 'account-safe', count: 2 }],
        models: [{ value: 'model-safe', count: 2 }],
        responseStates: [{ value: 'complete', count: 2 }],
        totalStored: 1,
        facetTruncated: {},
        truncated: false,
        error: null,
      };
    },
    queryConversationSessionFacets(options) {
      calls.sessionFacets.push(options);
      return {
        members: [{ value: 'member-safe', count: 1 }],
        devices: [{ value: 'device-safe', count: 1 }],
        accounts: [{ value: 'account-safe', count: 1 }],
        models: [{ value: 'model-safe', count: 1 }],
        responseStates: [{ value: 'complete', count: 1 }],
        totalStored: 1,
        facetTruncated: {},
        truncated: false,
        error: null,
      };
    },
    readConversation(id) {
      calls.reads.push(id);
      if (unavailable) return { turn: null, error: 'conversation_unavailable' };
      if (id !== 42) return { turn: null, error: null };
      return {
        turn: {
          id,
          startedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
          memberLabel: '<member>',
          accountAlias: 'account-safe',
          model: 'model-safe',
          promptText: '  prompt\nwith whitespace  ',
          responseText: '<reply>&',
          responseState: 'complete',
        },
        error: null,
      };
    },
    readConversationSession(id) {
      calls.sessionReads.push(id);
      if (unavailable) {
        return { session: null, standaloneCount: 3, error: 'conversation_unavailable' };
      }
      if (id !== 7) return { session: null, standaloneCount: 3, error: null };
      return {
        session: {
          id,
          turnCount: 2,
          firstStartedAtMs: Date.parse('2026-08-17T12:30:00.000Z'),
          lastStartedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
          standaloneCount: 3,
          truncated: false,
          turns: [{
            id: 41,
            turnIndex: 1,
            startedAtMs: Date.parse('2026-08-17T12:30:00.000Z'),
            memberLabel: '<member>',
            accountAlias: 'account-safe',
            model: 'model-safe',
            promptText: 'first prompt',
            promptSource: 'captured_api_user_text',
            promptSuffixOmitted: false,
            responseText: '',
            responseState: 'complete',
          }, {
            id: 42,
            turnIndex: 2,
            startedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
            memberLabel: '<member>',
            accountAlias: 'account-safe',
            model: 'model-safe',
            promptText: '<conversation>second prompt</conversation><tail>hidden</tail>',
            responseText: '<reply>&',
            responseState: 'incomplete',
          }],
        },
        standaloneCount: 3,
        error: null,
      };
    },
  };
}

async function fixture({ adminAuth = 'open', requestMetrics } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-conversation-route-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('gateway fixture');
  });
  const upstreamUrl = await listen(upstream);
  const created = await createCredentialConsole({
    store,
    requestMetrics,
    adminAuth,
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    claudeUpstreamBaseUrl: upstreamUrl,
    usageMonitor: { snapshotForAccount: () => null, stop() {} },
  });
  const baseUrl = await listen(created.server);
  return {
    ...created,
    baseUrl,
    async close() {
      await Promise.all([
        new Promise((resolve) => created.server.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
      await rm(home, { recursive: true, force: true });
    },
  };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

test('open conversation routes use a default GET and POST-only filter/search state', async () => {
  const metrics = conversationMetrics();
  const app = await fixture({ requestMetrics: metrics });
  try {
    const list = await fetch(`${app.baseUrl}/conversations?q=secret-query&before_id=12&limit=1`);
    assert.equal(list.status, 200);
    const cookie = cookieFrom(list);
    assert.notEqual(cookie, '');
    const listHtml = await list.text();
    assert.deepEqual(metrics.calls.searches[0], { q: '', beforeId: null, limit: 25 });
    assert.equal(listHtml.includes('secret-query'), false);
    assert.match(listHtml, /data-i18n="conversation-privacy-notice"/);
    assert.match(listHtml, /data-i18n="conversation-open-warning"/);
    assert.match(listHtml, /data-i18n="conversation-queue-dropped"/);
    assert.match(listHtml, /method="post" action="\/conversations"/);
    assert.match(listHtml, /href="\/conversations\/session\/7"/);
    assert.match(listHtml, /data-i18n="conversation-standalone-notice"/);
    assert.match(listHtml, /href="\/conversation-turns"/);
    assert.equal(listHtml.includes('<img src=x'), false);
    assert.equal(listHtml.includes('threadKey'), false);
    assert.equal(listHtml.includes('data-i18n="open-banner"'), true);

    const filtered = await fetch(`${app.baseUrl}/conversations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        q: 'needle', before_id: '12', limit: '1', period: '168',
        member_label: 'member-safe', device_id: 'device-safe',
        account_id: 'account-safe', model: 'model-safe', response_state: 'complete',
      }),
    });
    assert.equal(filtered.status, 200);
    const filteredHtml = await filtered.text();
    const sessionSearch = metrics.calls.searches[1];
    assert.deepEqual({
      q: sessionSearch.q,
      beforeId: sessionSearch.beforeId,
      limit: sessionSearch.limit,
      memberLabel: sessionSearch.memberLabel,
      deviceId: sessionSearch.deviceId,
      accountId: sessionSearch.accountId,
      model: sessionSearch.model,
      responseState: sessionSearch.responseState,
    }, {
      q: 'needle', beforeId: 12, limit: 1,
      memberLabel: 'member-safe', deviceId: 'device-safe',
      accountId: 'account-safe', model: 'model-safe', responseState: 'complete',
    });
    assert.equal(sessionSearch.toMs - sessionSearch.fromMs, 168 * 60 * 60 * 1000);
    assert.equal(metrics.calls.sessionFacets[1].memberLabel, 'member-safe');
    assert.equal(metrics.calls.sessionFacets[1].responseState, 'complete');
    assert.match(filteredHtml, /data-facet-count="1"/);
    assert.match(filteredHtml, /name="before_id" value="17"/);
    assert.match(filteredHtml, /conversation-next-page/);

    const turnList = await fetch(`${app.baseUrl}/conversation-turns`);
    assert.equal(turnList.status, 200);
    const turnListHtml = await turnList.text();
    assert.deepEqual(metrics.calls.turnSearches[0], { q: '', beforeId: null, limit: 25 });
    assert.match(turnListHtml, /method="post" action="\/conversation-turns"/);
    assert.match(turnListHtml, /href="\/conversation-turns\/42"/);
    assert.match(turnListHtml, /href="\/conversations"[^>]*data-i18n="conversation-subnav-sessions"/);
    const filteredTurns = await fetch(`${app.baseUrl}/conversation-turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: 'turn needle', limit: '1' }),
    });
    assert.equal(filteredTurns.status, 200);
    assert.deepEqual(metrics.calls.turnSearches[1], { q: 'turn needle', beforeId: null, limit: 1 });

    const translations = await fetch(`${app.baseUrl}/assets/app.js`);
    assert.equal(translations.status, 200);
    const translationsText = await translations.text();
    assert.match(translationsText, /'conversation-privacy-notice':/);
    assert.match(translationsText, /永久保存/);
    assert.match(translationsText, /'conversation-open-warning':/);

    const detail = await fetch(`${app.baseUrl}/conversations/42`);
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    assert.deepEqual(metrics.calls.reads, [42]);
    assert.match(detailHtml, /<pre>  prompt\nwith whitespace  <\/pre>/);
    assert.match(detailHtml, /&lt;reply&gt;&amp;/);
    assert.equal(detailHtml.includes('<reply>'), false);

    const newTurnDetail = await fetch(`${app.baseUrl}/conversation-turns/42`);
    assert.equal(newTurnDetail.status, 200);
    assert.deepEqual(metrics.calls.reads, [42, 42]);

    const sessionDetail = await fetch(`${app.baseUrl}/conversations/session/7`);
    assert.equal(sessionDetail.status, 200);
    const sessionHtml = await sessionDetail.text();
    assert.deepEqual(metrics.calls.sessionReads, [7]);
    assert.ok(sessionHtml.indexOf('first prompt') < sessionHtml.indexOf('second prompt'));
    assert.match(sessionHtml, /data-i18n="conversation-session-empty-assistant"/);
    assert.match(sessionHtml, /data-i18n="conversation-session-incomplete-turn"/);
    assert.equal(sessionHtml.includes('<tail>hidden</tail>'), false);
    assert.equal(sessionHtml.includes('threadKey'), false);

    const missing = await fetch(`${app.baseUrl}/conversations/999`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /data-i18n="conversation-not-found"/);
    const malformed = await fetch(`${app.baseUrl}/conversations/not-a-number`);
    assert.equal(malformed.status, 404);
    const missingSession = await fetch(`${app.baseUrl}/conversations/session/999`);
    assert.equal(missingSession.status, 404);
    assert.match(await missingSession.text(), /data-i18n="conversation-session-not-found"/);
    const malformedSession = await fetch(`${app.baseUrl}/conversations/session/not-a-number`);
    assert.equal(malformedSession.status, 404);

    const posted = await fetch(`${app.baseUrl}/conversations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });
    assert.equal(posted.status, 200);
    const detailPosted = await fetch(`${app.baseUrl}/conversations/42`, { method: 'POST' });
    assert.equal(detailPosted.status, 405);
    assert.equal(detailPosted.headers.get('allow'), 'GET');
    const explicitTurnPosted = await fetch(`${app.baseUrl}/conversation-turns/42`, { method: 'POST' });
    assert.equal(explicitTurnPosted.status, 405);
    assert.equal(explicitTurnPosted.headers.get('allow'), 'GET');
    const turnCollectionPut = await fetch(`${app.baseUrl}/conversation-turns`, { method: 'PUT' });
    assert.equal(turnCollectionPut.status, 405);
    assert.equal(turnCollectionPut.headers.get('allow'), 'GET, POST');
    const sessionPosted = await fetch(`${app.baseUrl}/conversations/session/7`, { method: 'POST' });
    assert.equal(sessionPosted.status, 405);
    assert.equal(sessionPosted.headers.get('allow'), 'GET');

    const notArchive = await fetch(`${app.baseUrl}/claude/conversations/42`);
    assert.notEqual(notArchive.status, 200);
    const notArchiveBody = await notArchive.text();
    assert.equal(notArchiveBody.includes('Conversation archive'), false);
    assert.equal(notArchiveBody.includes('conversation-privacy-notice'), false);
  } finally {
    await app.close();
  }
});

test('tailscale conversation routes require identity and bind a session to it', async () => {
  const app = await fixture({ adminAuth: 'tailscale', requestMetrics: conversationMetrics() });
  try {
    const refused = await fetch(`${app.baseUrl}/conversations`);
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.has('set-cookie'), false);
    assert.equal((await fetch(`${app.baseUrl}/conversation-turns`)).status, 403);
    assert.equal((await fetch(`${app.baseUrl}/conversations/session/7`)).status, 403);
    assert.equal((await fetch(`${app.baseUrl}/conversation-turns/42`)).status, 403);
    assert.equal((await fetch(`${app.baseUrl}/conversations/42`)).status, 403);

    const first = await fetch(`${app.baseUrl}/conversations`, {
      headers: { 'Tailscale-User-Login': 'member@example.test' },
    });
    assert.equal(first.status, 200);
    const cookie = cookieFrom(first);
    const html = await first.text();
    assert.notEqual(cookie, '');
    assert.equal(html.includes('data-i18n="conversation-open-warning"'), false);
    assert.match(html, /data-i18n="conversation-privacy-notice"/);
    assert.equal((await fetch(`${app.baseUrl}/conversation-turns`, {
      headers: { 'Tailscale-User-Login': 'member@example.test', Cookie: cookie },
    })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/conversations/session/7`, {
      headers: { 'Tailscale-User-Login': 'member@example.test', Cookie: cookie },
    })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/conversation-turns/42`, {
      headers: { 'Tailscale-User-Login': 'member@example.test', Cookie: cookie },
    })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/conversations/42`, {
      headers: { 'Tailscale-User-Login': 'member@example.test', Cookie: cookie },
    })).status, 200);

    const stolen = await fetch(`${app.baseUrl}/conversations`, { headers: { Cookie: cookie } });
    assert.equal(stolen.status, 403);
    const other = await fetch(`${app.baseUrl}/conversations`, {
      headers: { Cookie: cookie, 'Tailscale-User-Login': 'other@example.test' },
    });
    assert.equal(other.status, 200);
    assert.notEqual(cookieFrom(other), cookie);
  } finally {
    await app.close();
  }
});

test('conversation sessions and legacy turn detail return 503 when metrics storage is unavailable', async () => {
  const app = await fixture({ requestMetrics: null });
  try {
    const list = await fetch(`${app.baseUrl}/conversations`);
    assert.equal(list.status, 503);
    assert.match(await list.text(), /data-i18n="conversation-session-search-error"/);
    const turnList = await fetch(`${app.baseUrl}/conversation-turns`);
    assert.equal(turnList.status, 503);
    assert.match(await turnList.text(), /data-i18n="conversation-search-error"/);
    const sessionDetail = await fetch(`${app.baseUrl}/conversations/session/42`);
    assert.equal(sessionDetail.status, 503);
    assert.match(await sessionDetail.text(), /data-i18n="conversation-session-read-error"/);
    const detail = await fetch(`${app.baseUrl}/conversations/42`);
    assert.equal(detail.status, 503);
    assert.match(await detail.text(), /data-i18n="conversation-read-error"/);
  } finally {
    await app.close();
  }
});

test('bounded search errors return actionable 400 guidance while unknown errors stay generic', async () => {
  for (const [searchError, marker] of [
    ['search_query_too_short', 'conversation-session-search-query-too-short'],
    ['search_query_requires_indexed_terms', 'conversation-session-search-requires-indexed-terms'],
  ]) {
    const app = await fixture({ requestMetrics: conversationMetrics({ searchError }) });
    try {
      const landing = await fetch(`${app.baseUrl}/conversations`);
      const response = await fetch(`${app.baseUrl}/conversations`, {
        method: 'POST',
        headers: { Cookie: cookieFrom(landing), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q: 'short' }),
      });
      assert.equal(response.status, 400);
      const html = await response.text();
      assert.match(html, new RegExp(`data-i18n="${marker}"`));
      assert.equal(html.includes(searchError), false);
      assert.equal(html.includes('temporarily unavailable'), false);
    } finally {
      await app.close();
    }
  }

  const app = await fixture({ requestMetrics: conversationMetrics({ searchError: 'private_search_failure' }) });
  try {
    const landing = await fetch(`${app.baseUrl}/conversations`);
    const response = await fetch(`${app.baseUrl}/conversations`, {
      method: 'POST',
      headers: { Cookie: cookieFrom(landing), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: 'short' }),
    });
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.match(html, /data-i18n="conversation-session-search-error"/);
    assert.match(html, /Conversation search could not be completed/);
    assert.equal(html.includes('private_search_failure'), false);
  } finally {
    await app.close();
  }
});

test('conversation filters reject malformed and oversized UTF-8 values before metrics queries', async () => {
  const metrics = conversationMetrics();
  const app = await fixture({ requestMetrics: metrics });
  try {
    const landing = await fetch(`${app.baseUrl}/conversations`);
    const cookie = cookieFrom(landing);
    const baselineSearches = metrics.calls.searches.length;
    for (const body of [
      { q: '中'.repeat(100) },
      { device_id: 'd'.repeat(129) },
      { before_id: '-2' },
      { period: 'yesterday' },
    ]) {
      const response = await fetch(`${app.baseUrl}/conversations`, {
        method: 'POST',
        headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      });
      assert.equal(response.status, 400);
      const html = await response.text();
      assert.match(html, /data-i18n="conversation-session-filter-invalid"/);
      assert.equal(html.includes('中'.repeat(100)), false);
    }
    const oversized = await fetch(`${app.baseUrl}/conversations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: 'x'.repeat(8 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(metrics.calls.searches.length, baselineSearches);
  } finally {
    await app.close();
  }
});
