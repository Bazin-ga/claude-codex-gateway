import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dashboardView } from '../lib/views.js';

function page() {
  return dashboardView({ accounts: [], devices: [], openMode: true });
}

test('wide tables are given a card layout on narrow screens', () => {
  const html = page();
  const narrow = html.slice(html.indexOf('@media (max-width: 720px)'));
  assert.ok(narrow.startsWith('@media (max-width: 720px)'), 'the breakpoint exists');

  // Generic on purpose: the dashboard renders one unclassed table per account
  // for its device credentials, so enumerating class names would miss them.
  assert.match(narrow, /\.table-wrap table:has\(td\[data-label\]\)[^{]*\{[^}]*display: block/, 'tables become blocks');
  assert.match(narrow, /td\[data-label\]::before/, 'cells show their column label');
  assert.match(narrow, /thead[^{]*\{[^}]*clip-path/, 'headers are visually hidden, not removed');
  // Gating every rule on a stamped label is what keeps the scripting-off page
  // on its original scrolling table instead of unlabelled stacked cells.
  assert.equal(
    /\.table-wrap table(?!:has)/.test(narrow),
    false,
    'no card rule applies to a table without labels',
  );
});

test('touch targets meet a minimum height, including summary', () => {
  const html = page();
  const touch = html.slice(html.indexOf('@media (max-width: 800px)'));
  assert.match(touch, /button, \.button, input, select \{ min-height: 44px/);
  // <summary> is a real control and was previously left at its ~19px text height.
  assert.match(touch, /summary \{ min-height: 44px/);
});

test('the client stamps card labels from the live header, and re-stamps on language change', async () => {
  const source = (await readFile(new URL('../server.js', import.meta.url), 'utf8'))
    + (await readFile(new URL('../web/console-client.js', import.meta.url), 'utf8'));
  const fn = source.slice(source.indexOf('function stampTableCardLabels'));
  assert.ok(fn.startsWith('function stampTableCardLabels'), 'the stamping function is shipped');

  // Reading textContent off the header is what makes the label follow the
  // language switch; a hard-coded data-label in the markup would not.
  assert.match(fn.slice(0, 900), /querySelectorAll\('thead th'\)[\s\S]*textContent/);
  assert.match(fn.slice(0, 1600), /cell\.dataset\.label = label/);

  // display:block drops a table's implicit semantics, so they are restored.
  assert.match(fn.slice(0, 1600), /setAttribute\('role', 'table'\)/);
  assert.match(fn.slice(0, 1600), /setAttribute\('role', 'cell'\)/);

  // A colspan empty-state row is described by no single column.
  assert.match(fn.slice(0, 1600), /colspan/);

  assert.match(
    source,
    /addEventListener\('credential-console-language', \(\) => stampTableCardLabels/,
    'labels are refreshed when the language changes',
  );
});
