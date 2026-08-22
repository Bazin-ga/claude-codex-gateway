/**
 * Behavioural checks that need a real engine: CSS cascade, media queries,
 * focus, and the client script. The rest of the suite can only assert that
 * certain source strings exist, which cannot distinguish a working card layout
 * from one that labels every cell with the first column's header.
 *
 * Skipped unless a browser is present, so this stays additive: set
 * CONSOLE_BROWSER_TEST=1 with playwright-core resolvable and a Chromium at
 * CONSOLE_BROWSER_PATH (or the usual playwright cache) to run it.
 */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER_PATH = process.env.CONSOLE_BROWSER_PATH
  ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell`;

async function loadChromium() {
  try {
    await access(BROWSER_PATH);
  } catch {
    return null;
  }
  for (const specifier of ['playwright-core', '/tmp/kbshot/node_modules/playwright-core/index.js']) {
    try {
      const mod = await import(specifier);
      return (mod.default ?? mod).chromium ?? null;
    } catch {
      // try the next location
    }
  }
  return null;
}

const chromium = await loadChromium();
const describe = chromium ? test : test.skip;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'console-browser-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const created = await createCredentialConsole({
    store,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: { snapshotForAccount: () => null, stop() {} },
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  return {
    baseUrl,
    async close() {
      await new Promise((resolve) => created.server.close(resolve));
      await created.stop?.();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function withPage(viewport, fn) {
  const app = await fixture();
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await fn(page, app.baseUrl, errors);
  } finally {
    await browser.close();
    await app.close();
  }
}

describe('no page fits its content to a wider viewport than the phone has', async () => {
  await withPage({ width: 390, height: 844 }, async (page, baseUrl, errors) => {
    for (const path of ['/', '/conversations', '/conversation-turns', '/metrics']) {
      await page.goto(baseUrl + path, { waitUntil: 'networkidle' });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.equal(width, 390, `${path} must not scroll sideways on a phone`);
    }
    assert.deepEqual(errors, [], 'no page raised a script error');
  });
});

describe('every touch control clears the minimum target height', async () => {
  await withPage({ width: 390, height: 844 }, async (page, baseUrl) => {
    for (const path of ['/', '/metrics', '/conversation-turns']) {
      await page.goto(baseUrl + path, { waitUntil: 'networkidle' });
      const small = await page.evaluate(() => Array.from(
        document.querySelectorAll('a.button, button, input, select, summary'),
      )
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.height < 40;
        })
        .map((el) => `${el.tagName}:${(el.textContent || '').trim().slice(0, 20)}`));
      assert.deepEqual(small, [], `${path} has controls under 40px`);
    }
  });
});

describe('card labels come from the header, not from the first column', async () => {
  await withPage({ width: 390, height: 844 }, async (page, baseUrl) => {
    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });

    // An empty console has only a colspan empty-state row, so give the shipped
    // stamping function a real table and let the page's own language event
    // invoke it — the function itself is not exported.
    const result = await page.evaluate(() => {
      const wrap = document.querySelector('.table-wrap') ?? document.body.appendChild(
        Object.assign(document.createElement('div'), { className: 'table-wrap' }),
      );
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>Account</th><th>Status</th><th>Expires</th></tr></thead>'
        + '<tbody><tr><td>alpha</td><td>healthy</td><td>360d</td></tr>'
        + '<tr><td colspan="3" class="empty">nothing</td></tr></tbody>';
      wrap.appendChild(table);

      window.dispatchEvent(new CustomEvent('credential-console-language', { detail: { language: 'en' } }));

      const row = table.querySelector('tbody tr');
      const emptyRow = table.querySelectorAll('tbody tr')[1];
      return {
        headers: Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim()),
        labels: Array.from(row.children).map((td) => td.dataset.label ?? null),
        display: getComputedStyle(row.children[0]).display,
        theadClipped: getComputedStyle(table.querySelector('thead')).position,
        colspanLabel: emptyRow.children[0].dataset.label ?? null,
        roles: {
          table: table.getAttribute('role'),
          cell: row.children[0].getAttribute('role'),
        },
      };
    });

    // The failure this catches: labelling every cell with headers[0].
    assert.deepEqual(result.labels, result.headers, 'each cell is labelled with its own column');
    assert.equal(new Set(result.labels).size, 3, 'labels differ per column');
    assert.equal(result.display, 'grid', 'the card layout is actually applied at 390px');
    assert.equal(result.theadClipped, 'absolute', 'the header row is visually removed');
    assert.equal(result.colspanLabel, null, 'a colspan cell is described by no single column');
    assert.equal(result.roles.table, 'table', 'table semantics survive display:block');
    assert.equal(result.roles.cell, 'cell');
  });
});

describe('desktop keeps real table layout', async () => {
  await withPage({ width: 1440, height: 900 }, async (page, baseUrl) => {
    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    const display = await page.evaluate(() => {
      const td = document.querySelector('.table-wrap table tbody td');
      return td ? getComputedStyle(td).display : null;
    });
    if (display !== null) assert.equal(display, 'table-cell', 'cards must not leak to desktop');
  });
});

describe('a filter updates in place, shows progress, and announces the result', async () => {
  await withPage({ width: 1280, height: 900 }, async (page, baseUrl) => {
    await page.goto(baseUrl + '/conversation-turns', { waitUntil: 'networkidle' });
    await page.evaluate(() => { window.__stillHere = true; });

    // Hold the response open long enough to observe the in-flight state.
    await page.route('**/conversation-turns', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });

    await page.click('.conversation-filters button[type="submit"]');
    await page.waitForTimeout(80);
    const busy = await page.evaluate(() => {
      const region = document.querySelector('.conversation-results');
      return {
        marked: region?.classList.contains('is-loading') ?? false,
        opacity: region ? getComputedStyle(region).opacity : null,
      };
    });
    assert.equal(busy.marked, true, 'the region is marked busy while in flight');
    assert.ok(Number(busy.opacity) < 1, 'and that is actually visible to the user');

    await page.waitForFunction(() => !document.querySelector('.conversation-results.is-loading'));
    const after = await page.evaluate(() => ({
      sameDocument: window.__stillHere === true,
      announced: document.getElementById('conversation-live-status')?.textContent?.trim() ?? '',
    }));
    assert.equal(after.sameDocument, true, 'no full navigation happened');
    assert.ok(after.announced.length > 0, 'a persistent live region carries the announcement');
  });
});

describe('tab navigation replaces the page, not the document', async () => {
  await withPage({ width: 1280, height: 900 }, async (page, baseUrl, errors) => {
    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    // A marker on the window survives only if the document is never rebuilt.
    await page.evaluate(() => { window.__documentIdentity = 'original'; });
    let fullLoads = 0;
    page.on('load', () => { fullLoads += 1; });

    for (const [href, expectedPath] of [
      ['/metrics', '/metrics'],
      ['/conversations', '/conversations'],
      ['/', '/'],
    ]) {
      await page.click(`.page-tabs a[href="${href}"]`);
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-navigating'));
      const state = await page.evaluate(() => ({
        alive: window.__documentIdentity === 'original',
        path: location.pathname,
        current: document.querySelector('.page-tabs a[aria-current="page"]')?.getAttribute('href'),
        title: document.title,
      }));
      assert.equal(state.alive, true, `${href} rebuilt the document`);
      assert.equal(state.path, expectedPath, 'the address bar follows');
      assert.equal(state.current, href, 'the active tab follows');
      assert.ok(state.title.length > 0, 'the title follows');
    }
    assert.equal(fullLoads, 0, 'no navigation caused a document load');
    assert.deepEqual(errors, []);

    // Back must return within the console rather than leaving it.
    await page.goBack();
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(() => window.__documentIdentity === 'original'),
      true,
      'Back stayed in the same document',
    );
  });
});

describe('a page that needs a lazily-loaded script still gets it', async () => {
  await withPage({ width: 1280, height: 900 }, async (page, baseUrl) => {
    // The chart bundle is referenced from the document head, which a swapped
    // page region does not contain — it has to be carried across explicitly.
    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    await page.click('.page-tabs a[href="/metrics"]');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-navigating'));
    await page.waitForFunction(
      () => document.querySelector('[data-metrics-dashboard]')?.dataset.metricsBound === 'true',
      { timeout: 10_000 },
    );
    const bound = await page.evaluate(
      () => document.querySelector('[data-metrics-dashboard]').dataset.metricsBound,
    );
    assert.equal(bound, 'true', 'the dashboard bound to DOM that arrived after load');
  });
});

describe('a GET filter form navigates without reloading, and the chart survives', async () => {
  await withPage({ width: 1440, height: 1000 }, async (page, baseUrl, errors) => {
    await page.goto(baseUrl + '/metrics', { waitUntil: 'networkidle' });
    await page.evaluate(() => { window.__documentIdentity = 'original'; });
    await page.waitForFunction(
      () => document.querySelector('[data-metrics-dashboard]')?.dataset.metricsBound === 'true',
      { timeout: 10_000 },
    );
    let fullLoads = 0;
    page.on('load', () => { fullLoads += 1; });

    await page.evaluate(() => { window.__outgoingDashboard = document.querySelector('[data-metrics-dashboard]'); });
    const select = await page.$('.metrics-filters select');
    if (select) {
      const values = await page.evaluate((el) => [...el.options].map((o) => o.value), select);
      await page.selectOption('.metrics-filters select', values[values.length - 1]);
    }
    await page.click('.metrics-filters button[type="submit"]');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-navigating'));

    assert.equal(fullLoads, 0, 'filtering metrics reloaded the document');
    assert.equal(
      await page.evaluate(() => window.__documentIdentity === 'original'),
      true,
      'the document survived the filter',
    );
    assert.ok(
      await page.evaluate(() => location.search.length > 0),
      'the filter is in the address bar',
    );
    // The chart is the reason this page was the hardest to do in place.
    await page.waitForFunction(
      () => document.querySelector('[data-metrics-dashboard]')?.dataset.metricsBound === 'true',
      { timeout: 10_000 },
    );
    // Filtering replaces the dashboard node too, so the outgoing one must be
    // released as the incoming one binds — otherwise every filter leaks a full
    // set of chart instances against a node no longer in the document.
    assert.equal(
      await page.evaluate(() => document.contains(window.__outgoingDashboard)),
      false,
      'the dashboard really was replaced',
    );
    assert.equal(
      await page.evaluate(() => window.__outgoingDashboard.dataset.metricsBound),
      undefined,
      'the replaced dashboard was released, not left bound',
    );
    assert.deepEqual(errors, []);
  });
});

describe('leaving the metrics page disposes its charts', async () => {
  await withPage({ width: 1440, height: 1000 }, async (page, baseUrl) => {
    await page.goto(baseUrl + '/metrics', { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => document.querySelector('[data-metrics-dashboard]')?.dataset.metricsBound === 'true',
      { timeout: 10_000 },
    );
    // Hold a reference to a live chart host, then navigate away. ECharts marks
    // its host with _echarts_instance_ and clears it on dispose, so the
    // detached node tells us whether the instance was released or leaked.
    // Hold a reference to the live dashboard, then navigate away. Teardown
    // clears its bound flag, which is the state this module actually owns —
    // ECharts does not remove its own marker attribute on dispose.
    await page.evaluate(() => {
      window.__dashboard = document.querySelector('[data-metrics-dashboard]');
      window.__wasBound = window.__dashboard?.dataset.metricsBound === 'true';
      window.__hadChart = !!window.__dashboard?.querySelector('[data-metrics-chart] svg, [data-metrics-chart] canvas');
    });
    assert.equal(await page.evaluate(() => window.__wasBound), true, 'the dashboard was bound');
    assert.equal(await page.evaluate(() => window.__hadChart), true, 'and had rendered a chart');

    await page.click('.page-tabs a[href="/conversations"]');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-navigating'));
    await page.waitForTimeout(300);

    assert.equal(
      await page.evaluate(() => window.__dashboard.dataset.metricsBound),
      undefined,
      'the detached dashboard was released rather than left bound and leaking',
    );

    // And coming back binds a working dashboard again.
    await page.click('.page-tabs a[href="/metrics"]');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-navigating'));
    await page.waitForFunction(
      () => document.querySelector('[data-metrics-dashboard]')?.dataset.metricsBound === 'true',
      { timeout: 10_000 },
    );
  });
});

describe('filtering keeps your place; changing page does not', async () => {
  await withPage({ width: 1440, height: 900 }, async (page, baseUrl) => {
    await page.goto(baseUrl + '/metrics', { waitUntil: 'networkidle' });
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => Math.round(window.scrollY));
    assert.ok(before > 300, 'scrolled far enough for the test to mean something');

    await page.click('.metrics-filters button[type="submit"]');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-navigating'));
    const afterFilter = await page.evaluate(() => Math.round(window.scrollY));
    // Re-running a filter on the page you are reading is not a new page.
    assert.ok(afterFilter > 0, `filtering jumped to the top (${before} -> ${afterFilter})`);

    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(150);
    await page.click('.page-tabs a[href="/conversations"]');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-navigating'));
    assert.equal(
      await page.evaluate(() => Math.round(window.scrollY)),
      0,
      'a real page change starts at the top',
    );
  });
});

describe('the sticky tab bar does not cover what you scroll to', async () => {
  await withPage({ width: 390, height: 844 }, async (page, baseUrl) => {
    for (const path of ['/metrics', '/conversation-turns']) {
      await page.goto(baseUrl + path, { waitUntil: 'networkidle' });
      const covered = await page.evaluate(() => {
        const nav = document.querySelector('.page-tabs');
        if (!nav) return [];
        const hidden = [];
        for (const control of document.querySelectorAll('select, input, button[type="submit"]')) {
          control.scrollIntoView({ block: 'start' });
          const box = control.getBoundingClientRect();
          const bar = nav.getBoundingClientRect();
          if (box.width > 0 && box.top < bar.bottom && box.bottom > bar.top) {
            hidden.push(`${control.tagName}[${control.name || ''}]`);
          }
        }
        return hidden;
      });
      // On a phone the bar wraps to two lines (~110px) and used to sit over the
      // control you had just scrolled to.
      assert.deepEqual(covered, [], `${path} has controls under the sticky bar`);
    }
  });
});
