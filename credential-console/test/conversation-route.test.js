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
    roundReads: [],
    sessionReads: [],
  };
  return {
    calls,
    stats: { conversation: { dropped: 2 }, conversationRounds: { dropped: 1 } },
    flush() {},
    searchConversationRoundSessions(options) {
      calls.searches.push(options);
      if (unavailable || searchError) {
        return {
          items: [], nextBeforeId: null, legacyFragmentCount: 3,
          error: searchError ?? 'search_unavailable',
        };
      }
      return {
        items: [{
          id: 7,
          turnCount: 2,
          firstPromptAtMs: Date.parse('2026-08-17T12:30:00.000Z'),
          lastActivityAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
          deviceId: 'device-safe',
          memberLabel: '<img src=x onerror=alert(1)>',
          accountAlias: 'account-safe',
          model: 'model-safe',
          firstPromptText: 'first exact prompt',
          latestPromptText: 'latest exact prompt',
          latestResponseText: 'latest final reply',
          latestResponseState: 'complete',
          pendingCount: 0,
          completeCount: 2,
          failedCount: 0,
          unavailableCount: 0,
        }],
        nextBeforeId: 17,
        nextBeforeActivityMs: Date.parse('2026-08-17T12:34:56.000Z'),
        legacyFragmentCount: 3,
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
    readConversationRoundSession(id) {
      calls.sessionReads.push(id);
      if (unavailable) {
        return { session: null, error: 'conversation_unavailable' };
      }
      if (id !== 7) return { session: null, error: null };
      return {
        session: {
          id,
          turnCount: 2,
          firstPromptAtMs: Date.parse('2026-08-17T12:30:00.000Z'),
          lastActivityAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
          truncated: false,
          turns: [{
            id: 41,
            turnIndex: 1,
            promptAtMs: Date.parse('2026-08-17T12:30:00.000Z'),
            completedAtMs: Date.parse('2026-08-17T12:31:00.000Z'),
            memberLabel: '<member>',
            accountAlias: 'account-safe',
            model: 'model-safe',
            promptText: 'first prompt',
            source: 'claude_hook',
            responseText: '',
            responseState: 'complete',
          }, {
            id: 42,
            turnIndex: 2,
            promptAtMs: Date.parse('2026-08-17T12:34:00.000Z'),
            completedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
            memberLabel: '<member>',
            accountAlias: 'account-safe',
            model: 'model-safe',
            promptText: 'second prompt',
            source: 'claude_hook',
            responseText: '<reply>&',
            responseState: 'complete',
          }],
        },
        error: null,
      };
    },
    readConversationRound(id) {
      calls.roundReads.push(id);
      if (unavailable) return { round: null, error: 'round_unavailable' };
      if (id !== 42) return { round: null, error: null };
      return {
        round: {
          id,
          conversationSessionId: 7,
          turnIndex: 2,
          promptAtMs: Date.parse('2026-08-17T12:34:00.000Z'),
          completedAtMs: Date.parse('2026-08-17T12:34:56.000Z'),
          memberLabel: '<member>',
          deviceId: 'device-safe',
          accountAlias: 'account-safe',
          promptText: 'second prompt',
          source: 'claude_hook',
          responseText: '<reply>&',
          responseState: 'complete',
        },
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

test('open conversation routes carry filter state in the URL', async () => {
  const metrics = conversationMetrics();
  const app = await fixture({ requestMetrics: metrics });
  try {
    // Filters are read from the query string so a filtered view survives a
    // refresh, is reachable with Back, and can be shared. This deliberately
    // reverses the earlier behaviour, where these parameters were ignored.
    // Rounds paginate by activity time; before_id belongs to the turns route.
    const list = await fetch(`${app.baseUrl}/conversations?q=needle&limit=1`);
    assert.equal(list.status, 200);
    const cookie = cookieFrom(list);
    assert.notEqual(cookie, '');
    const listHtml = await list.text();
    const applied = metrics.calls.searches.at(-1);
    assert.equal(applied.q, 'needle', 'the query string reached the store');
    assert.equal(applied.limit, 1, 'and so did the page size');
    assert.ok(listHtml.includes('needle'), 'the applied filter is reflected back into the form');
    assert.match(listHtml, /data-i18n="conversation-round-privacy-notice"/);
    assert.match(listHtml, /data-i18n="conversation-open-warning"/);
    assert.match(listHtml, /data-i18n="conversation-round-dropped"/);
    assert.match(listHtml, /method="post" action="\/conversations"/);
    assert.match(listHtml, /href="\/conversations\/session\/7"/);
    assert.match(listHtml, /data-i18n="conversation-captured-turns-notice"/);
    assert.match(listHtml, /href="\/conversation-turns\?q=needle"/);
    assert.equal(listHtml.includes('<img src=x'), false);
    assert.equal(listHtml.includes('threadKey'), false);
    assert.equal(listHtml.includes('data-i18n="open-banner"'), true);

    const filtered = await fetch(`${app.baseUrl}/conversations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        q: 'needle', before_id: '12', before_activity_ms: '1777777777000', limit: '1', period: '168',
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
      beforeActivityMs: sessionSearch.beforeActivityMs,
      limit: sessionSearch.limit,
      memberLabel: sessionSearch.memberLabel,
      deviceId: sessionSearch.deviceId,
      accountId: sessionSearch.accountId,
      model: sessionSearch.model,
      responseState: sessionSearch.responseState,
    }, {
      q: 'needle', beforeId: 12, beforeActivityMs: 1777777777000, limit: 1,
      memberLabel: 'member-safe', deviceId: 'device-safe',
      accountId: 'account-safe', model: 'model-safe', responseState: 'complete',
    });
    assert.equal(sessionSearch.toMs - sessionSearch.fromMs, 168 * 60 * 60 * 1000);
    assert.match(filteredHtml, /name="before_id" value="17"/);
    assert.match(filteredHtml, /name="before_activity_ms" value="1786970096000"/);
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
    assert.match(translationsText, /'conversation-round-privacy-notice':/);
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
    assert.match(sessionHtml, /data-i18n="conversation-round-empty-response"/);
    assert.match(sessionHtml, /data-prompt-source="claude_hook"/);
    assert.equal(sessionHtml.includes('threadKey'), false);

    const roundDetail = await fetch(`${app.baseUrl}/conversation-rounds/42`);
    assert.equal(roundDetail.status, 200);
    const roundHtml = await roundDetail.text();
    assert.deepEqual(metrics.calls.roundReads, [42]);
    assert.match(roundHtml, /data-conversation-round-id="42"/);
    assert.match(roundHtml, /&lt;reply&gt;&amp;/);

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
    assert.equal((await fetch(`${app.baseUrl}/conversation-rounds/999`)).status, 404);

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
    const roundPosted = await fetch(`${app.baseUrl}/conversation-rounds/42`, { method: 'POST' });
    assert.equal(roundPosted.status, 405);
    assert.equal(roundPosted.headers.get('allow'), 'GET');

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
    assert.equal((await fetch(`${app.baseUrl}/conversation-rounds/42`)).status, 403);
    assert.equal((await fetch(`${app.baseUrl}/conversations/42`)).status, 403);

    const first = await fetch(`${app.baseUrl}/conversations`, {
      headers: { 'Tailscale-User-Login': 'member@example.test' },
    });
    assert.equal(first.status, 200);
    const cookie = cookieFrom(first);
    const html = await first.text();
    assert.notEqual(cookie, '');
    assert.equal(html.includes('data-i18n="conversation-open-warning"'), false);
    assert.match(html, /data-i18n="conversation-round-privacy-notice"/);
    assert.equal((await fetch(`${app.baseUrl}/conversation-turns`, {
      headers: { 'Tailscale-User-Login': 'member@example.test', Cookie: cookie },
    })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/conversations/session/7`, {
      headers: { 'Tailscale-User-Login': 'member@example.test', Cookie: cookie },
    })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/conversation-turns/42`, {
      headers: { 'Tailscale-User-Login': 'member@example.test', Cookie: cookie },
    })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/conversation-rounds/42`, {
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
    const roundDetail = await fetch(`${app.baseUrl}/conversation-rounds/42`);
    assert.equal(roundDetail.status, 503);
    assert.match(await roundDetail.text(), /data-i18n="conversation-round-read-error"/);
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
      { before_id: '2' },
      { before_activity_ms: '1777777777000' },
      { before_id: '2', before_activity_ms: '-1' },
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

test('a fragment request returns only the results region from the same route', async () => {
  const metrics = conversationMetrics();
  const app = await fixture({ requestMetrics: metrics });
  try {
    const landing = await fetch(`${app.baseUrl}/conversations`);
    const cookie = cookieFrom(landing);
    const fullHtml = await landing.text();

    const fragment = await fetch(`${app.baseUrl}/conversations`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'x-fragment': 'conversation-results',
      },
      body: new URLSearchParams({ q: 'reliable', limit: '25' }).toString(),
    });
    assert.equal(fragment.status, 200);
    assert.match(fragment.headers.get('content-type') ?? '', /text\/html/);
    const fragmentHtml = await fragment.text();

    assert.match(fragmentHtml, /^\s*<section class="conversation-results"/);
    assert.equal(/<!doctype/i.test(fragmentHtml), false, 'no document wrapper');
    assert.equal(fragmentHtml.includes('conversation-filters'), false, 'no filter form');
    assert.ok(
      Buffer.byteLength(fragmentHtml) < Buffer.byteLength(fullHtml) / 2,
      'the fragment is the small response the client asked for',
    );

    // The filter still reached the store, so the fragment is a real search.
    const applied = metrics.calls.searches.at(-1);
    assert.equal(applied.q, 'reliable');
  } finally {
    await app.close();
  }
});

test('without the fragment header the same POST still returns a whole document', async () => {
  const app = await fixture({ requestMetrics: conversationMetrics() });
  try {
    const landing = await fetch(`${app.baseUrl}/conversation-turns`);
    const cookie = cookieFrom(landing);
    const response = await fetch(`${app.baseUrl}/conversation-turns`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: 'anything' }).toString(),
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<!doctype html>/i, 'scripting-off browsers keep working');
    assert.match(html, /conversation-filters/, 'and still get the filter form back');
  } finally {
    await app.close();
  }
});

test('a spoofed fragment header cannot bypass the session requirement', async () => {
  const app = await fixture({ requestMetrics: conversationMetrics(), adminAuth: 'tailscale' });
  try {
    const response = await fetch(`${app.baseUrl}/conversations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-fragment': 'conversation-results',
      },
      body: 'q=secret',
    });
    assert.notEqual(response.status, 200, 'auth is enforced before rendering anything');
  } finally {
    await app.close();
  }
});

test('a URL with no filters is still an unfiltered landing page', async () => {
  const metrics = conversationMetrics();
  const app = await fixture({ requestMetrics: metrics });
  try {
    const response = await fetch(`${app.baseUrl}/conversations`);
    assert.equal(response.status, 200);
    await response.text();
    const search = metrics.calls.searches.at(-1);
    assert.equal(search.q, '', 'no query means no filter');
    assert.equal(search.limit, 25, 'and the default page size');
  } finally {
    await app.close();
  }
});

test('the account filter names a Codex account instead of showing its id', async (t) => {
  // The facet query returns account *ids* out of request_metrics; the dropdown
  // turns them into names through a map the route builds from the account list.
  // That map held Claude accounts only, so a Codex id fell through to `?? value`
  // and the filter read `YfgZbzz1VmxLc40G (1)` instead of `codex-shared-1 (1)`.
  const home = await mkdtemp(join(tmpdir(), 'credential-console-codex-facet-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'claude-shared-1',
    emailLabel: 'owner@example.com',
    credential: { oauth_token: 'sk-ant-oat-example' },
  });
  const codex = await store.addAccount({
    provider: 'codex',
    alias: 'codex-shared-1',
    emailLabel: '',
    external: { kind: 'codex-credential', home: '/var/lib/codex-credential' },
  });

  const requestMetrics = conversationMetrics();
  const inner = requestMetrics.queryConversationFacets.bind(requestMetrics);
  requestMetrics.queryConversationFacets = (options) => ({
    ...inner(options),
    // Both providers now produce conversation rows, so both appear here.
    accounts: [{ value: codex.id, count: 1 }, { value: claude.id, count: 4 }],
  });

  const created = await createCredentialConsole({
    store,
    requestMetrics,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: { snapshotForAccount: () => null, stop() {} },
  });
  const baseUrl = await listen(created.server);
  t.after(() => new Promise((resolve) => created.server.close(resolve)));

  const response = await fetch(`${baseUrl}/conversation-turns`);
  assert.equal(response.status, 200);
  const select = /<select name="account_id"[\s\S]*?<\/select>/.exec(await response.text())?.[0] ?? '';
  assert.ok(select, 'the account filter is rendered');

  assert.ok(select.includes(`value="${codex.id}"`), 'the Codex account is offered');
  assert.match(select, /codex-shared-1 \(1\)/, 'and it is named, with its count');
  assert.equal(
    new RegExp(`>${codex.id}`).test(select),
    false,
    'the raw id is not what the operator reads',
  );
  assert.match(select, /claude-shared-1 \(4\)/, 'Claude accounts are unaffected');
});

test('filtering rounds to an account with none hands the same filter to the turns page', async () => {
  // Codex ships no Claude Code hook, so it writes no rounds at all and every
  // Codex conversation exists only as a captured turn. Filtering this page by a
  // Codex account is therefore always empty, and the useful thing the page can
  // do is carry the filter onward instead of offering a bare, unfiltered link.
  const metrics = conversationMetrics();
  metrics.searchConversationRoundSessions = (options) => {
    metrics.calls.searches.push(options);
    return {
      items: [],
      nextBeforeId: null,
      nextBeforeActivityMs: null,
      legacyFragmentCount: 3,
      totalMatches: 0,
      error: null,
    };
  };
  const app = await fixture({ requestMetrics: metrics });
  try {
    const response = await fetch(`${app.baseUrl}/conversations?account_id=codex-shared-1`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(metrics.calls.searches.at(-1).accountId, 'codex-shared-1');
    assert.match(html, /data-i18n="conversation-session-no-results"/);
    assert.match(html, /class="notice conversation-legacy-notice conversation-turns-pointer"/);
    assert.match(html, /href="\/conversation-turns\?account_id=codex-shared-1"/);
    assert.match(html, /data-i18n="conversation-captured-turns-notice"/);
    assert.equal(html.includes('Legacy API fragments'), false);
  } finally {
    await app.close();
  }
});

test('an absolute window can express a closed interval, which no period can', async (t) => {
  // The period presets are all `now - N`, so "yesterday 14:00-18:00" — the
  // question an incident review starts from — had no expression at all. The
  // store has always accepted a closed interval; the route pinned the upper
  // bound to now and threw that away.
  const requestMetrics = conversationMetrics();
  const seen = [];
  const inner = requestMetrics.searchConversations.bind(requestMetrics);
  requestMetrics.searchConversations = (options) => { seen.push(options); return inner(options); };
  const app = await fixture({ requestMetrics });
  t.after(() => app.close());

  const from = '2026-08-21T00:00';
  const to = '2026-08-21T23:59';
  const response = await fetch(`${app.baseUrl}/conversation-turns?from=${from}&to=${to}`);
  assert.equal(response.status, 200);
  const html = await response.text();

  const options = seen.at(-1);
  assert.equal(options.fromMs, Date.parse(`${from}Z`), 'the lower bound is read as UTC');
  assert.equal(options.toMs, Date.parse(`${to}Z`), 'and so is the upper one, rather than becoming now');

  // The values come back in the form, so the window survives a reload and
  // pagination rather than being lost on the next click.
  assert.match(html, new RegExp(`name="from" value="${from}"`));
  assert.match(html, new RegExp(`name="to" value="${to}"`));
});

test('one bound alone is a half-open window', async (t) => {
  const requestMetrics = conversationMetrics();
  const seen = [];
  const inner = requestMetrics.searchConversations.bind(requestMetrics);
  requestMetrics.searchConversations = (options) => { seen.push(options); return inner(options); };
  const app = await fixture({ requestMetrics });
  t.after(() => app.close());

  await fetch(`${app.baseUrl}/conversation-turns?from=2026-08-21T00:00`);
  assert.equal(seen.at(-1).fromMs, Date.parse('2026-08-21T00:00Z'));
  assert.ok(seen.at(-1).toMs >= Date.now() - 5000, 'an open end means up to now');

  await fetch(`${app.baseUrl}/conversation-turns?to=2026-08-18T00:00`);
  assert.equal(seen.at(-1).toMs, Date.parse('2026-08-18T00:00Z'));
  assert.equal(seen.at(-1).fromMs, undefined, 'an open start means from the beginning');
});

test('a window that runs backwards is refused rather than quietly emptied', async (t) => {
  const app = await fixture({ requestMetrics: conversationMetrics() });
  t.after(() => app.close());
  for (const query of [
    'from=2026-08-21T23:59&to=2026-08-21T00:00',
    'from=not-a-date',
    'to=also-not-a-date',
  ]) {
    const response = await fetch(`${app.baseUrl}/conversation-turns?${query}`);
    assert.equal(response.status, 400, query);
  }
});
