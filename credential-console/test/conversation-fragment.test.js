import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationSessionsView, conversationsView } from '../lib/views.js';

const TURN_ITEMS = [{
  id: 11,
  promptText: 'first captured prompt',
  responseText: 'first captured response',
  responseState: 'complete',
  model: 'claude-test',
  startedAtMs: 1_700_000_000_000,
}];

const SESSION_ITEMS = [{
  id: 7,
  turnCount: 2,
  lastActivityMs: 1_700_000_000_000,
  firstPromptText: 'a reliable round',
}];

function turns(overrides = {}) {
  return conversationsView({ items: TURN_ITEMS, nextBeforeId: 5, ...overrides });
}

function sessions(overrides = {}) {
  return conversationSessionsView({
    items: SESSION_ITEMS,
    nextBeforeId: 3,
    // Sessions page by activity time, not by row id.
    nextBeforeActivityMs: 1_699_999_000_000,
    ...overrides,
  });
}

for (const [name, render, heading] of [
  ['API fragment diagnostics', turns, 'conversation-results-heading'],
  ['reliable conversations', sessions, 'conversation-sessions-results-heading'],
]) {
  test(`${name}: a fragment is the results region and nothing else`, () => {
    const fragment = render({ fragment: true });

    assert.match(fragment, /^\s*<section class="conversation-results"/, 'starts at the region');
    assert.match(fragment, /<\/section>\s*$/, 'ends with it');
    assert.match(fragment, new RegExp(heading), 'carries the results heading');

    // None of the page chrome a full document would bring.
    assert.equal(/<!doctype/i.test(fragment), false, 'no document type');
    assert.equal(fragment.includes('<html'), false, 'no document element');
    assert.equal(fragment.includes('<head'), false, 'no head');
    assert.equal(fragment.includes('conversation-filters'), false, 'no filter form');
    assert.equal(fragment.includes('<nav'), false, 'no navigation');
  });

  test(`${name}: the full page still contains the same results`, () => {
    const full = render();
    const fragment = render({ fragment: true });

    assert.match(full, /<!doctype html>/i, 'full render is a document');
    assert.match(full, /conversation-filters/, 'full render keeps the filter form');
    assert.ok(full.includes(fragment.trim()), 'the document embeds the identical region');
  });

  test(`${name}: a fragment is materially smaller than the document`, () => {
    const full = Buffer.byteLength(render(), 'utf8');
    const fragment = Buffer.byteLength(render({ fragment: true }), 'utf8');
    assert.ok(
      fragment < full / 2,
      `fragment ${fragment}B should be far under half of ${full}B — that saving is the point`,
    );
  });

  test(`${name}: a fragment still carries pagination and translation hooks`, () => {
    const fragment = render({ fragment: true });
    // Swapped-in markup must remain translatable and navigable, or the page
    // silently reverts to English and loses its next-page control.
    assert.match(fragment, /data-i18n="/, 'has translation keys');
    assert.match(fragment, /conversation-pagination/, 'has the pagination control');
  });

  test(`${name}: an empty result set renders a fragment, not an empty string`, () => {
    const fragment = render({ items: [], nextBeforeId: null, nextBeforeActivityMs: null, fragment: true });
    assert.match(fragment, /<section class="conversation-results"/);
    assert.match(fragment, /data-i18n="/, 'the empty state is still translatable');
  });
}

test('a rendering error is reported inside the fragment rather than lost', () => {
  const fragment = conversationsView({ error: 'search_unavailable', fragment: true });
  assert.match(fragment, /<section class="conversation-results"/);
  assert.match(fragment, /notice|error/i, 'the error notice travels with the region');
});
