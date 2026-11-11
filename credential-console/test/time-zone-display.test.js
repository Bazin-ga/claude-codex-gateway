import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { dashboardView } from '../lib/views.js';

function renderWith(usage, extra = {}) {
  return dashboardView({
    accounts: [{ id: 'account-1', provider: 'claude', alias: 'claude-cheng', status: 'healthy', usage, ...extra }],
    devices: [],
    machines: [],
    codexClients: [],
    csrf: 'csrf-token',
    adminIdentity: 'admin@example.com',
    deviceGroups: [],
  });
}

test('a quota window counts down to its reset and carries the instant for the client', () => {
  const resetsAt = new Date(Date.now() + (3 * 60 + 20) * 60_000 + 20_000).toISOString();
  const fetchedAt = '2026-11-11T06:40:00Z';
  const html = renderWith({
    provider: 'claude',
    status: 'available',
    fetched_at: fetchedAt,
    windows: [{ kind: 'five_hour', remaining_percent: 40, resets_at: resetsAt }],
  });
  const instant = resetsAt.replace('.000Z', 'Z');
  assert.match(html, new RegExp(`<span class="until" data-until="resets" data-until-at="${instant.replace(/[.]/g, '\\.')}"><span class="until-left">resets in 3h 20m</span>`));
  // The moment itself follows, written in UTC until the script rewrites it.
  assert.match(html, new RegExp(`<time datetime="${instant.replace(/[.]/g, '\\.')}">\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC</time>`));
  // A past moment is plain: no countdown, and never the server's local zone.
  assert.match(html, /<time datetime="2026-11-11T06:40:00Z">2026-11-11 06:40 UTC<\/time>/);
  assert.equal(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/.test(html), false, 'no toLocaleString output in the server zone');
});

test('a reset already past says so instead of counting down', () => {
  const resetsAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const html = renderWith({
    provider: 'claude', status: 'available', windows: [{ kind: 'weekly', remaining_percent: 0, resets_at: resetsAt }],
  });
  assert.match(html, /<span class="until passed" data-until="resets"[^>]*><span class="until-left">reset due 5m ago<\/span>/);
});

/**
 * Runs the real client script against just enough of a document to exercise
 * the time zone code: the picker, formatting in a chosen zone, and countdowns.
 */
function clientHarness({ storedZone = null, language = 'en' } = {}) {
  const storage = new Map(storedZone ? [['credential_console_time_zone', storedZone]] : []);
  const listeners = {};
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.dataset = {};
      this.textContent = '';
      this.classList = { toggle() {}, add() {}, remove() {} };
      this.isConnected = true;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    closest() { return null; }
    append(...nodes) { this.children.push(...nodes); }
    prepend(...nodes) { this.children.unshift(...nodes); }
    add(node) { this.children.push(node); }
  }
  const times = [];
  const document = {
    documentElement: Object.assign(new Node('html'), { lang: language === 'zh' ? 'zh-CN' : 'en' }),
    cookie: '',
    visibilityState: 'visible',
    querySelectorAll(selector) {
      return selector.startsWith('time[datetime]') ? times : [];
    },
    querySelector() { return null; },
    createElement: (tag) => new Node(tag),
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
  };
  const window = {
    addEventListener() {},
    dispatchEvent() {},
    location: { href: 'https://console.example/', pathname: '/' },
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { language: 'en-US' },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    history: { pushState() {}, replaceState() {}, scrollRestoration: 'auto' },
    location: window.location,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    HTMLElement: Node,
    Option: class extends Node { constructor(text, value) { super('option'); this.text = text; this.value = value; } },
    Intl,
    Date,
    URL,
    URLSearchParams,
    performance: { getEntriesByType: () => [], now: () => 0 },
    setTimeout: () => 0,
    setInterval: () => 0,
    requestAnimationFrame: () => 0,
    MutationObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    console,
  });
  context.globalThis = context;
  return { context, times, storage, Node };
}

const clientSource = await readFile(new URL('../web/console-client.js', import.meta.url), 'utf8');

function runClient(options) {
  const harness = clientHarness(options);
  vm.runInContext(clientSource, harness.context, { filename: 'console-client.js' });
  return harness;
}

test('the client writes a moment in the chosen zone, naming the offset', () => {
  const { context } = runClient({ storedZone: 'Asia/Shanghai' });
  const format = context.window.credentialConsoleTime.format;
  const thisYear = new Date().getUTCFullYear();
  const ms = Date.UTC(thisYear, 5, 15, 6, 40);
  assert.equal(format(ms), '06-15 14:40 UTC+8');
  assert.equal(format(ms, { bare: true }), '06-15 14:40');
  assert.equal(format(Date.UTC(2020, 0, 1, 20, 0)), '2020-01-02 04:00 UTC+8', 'another year keeps the year');
  assert.equal(format(ms, { date: true }), `${thisYear}-06-15`);
});

test('the offset follows daylight saving and half-hour zones', () => {
  const chicago = runClient({ storedZone: 'America/Chicago' }).context.window.credentialConsoleTime;
  assert.equal(chicago.zoneLabel(Date.UTC(2026, 6, 1, 12)), 'UTC-5');
  assert.equal(chicago.zoneLabel(Date.UTC(2026, 0, 15, 12)), 'UTC-6');
  const kolkata = runClient({ storedZone: 'Asia/Kolkata' }).context.window.credentialConsoleTime;
  assert.equal(kolkata.zoneLabel(Date.UTC(2026, 0, 15, 12)), 'UTC+5:30');
  const utc = runClient({ storedZone: 'UTC' }).context.window.credentialConsoleTime;
  assert.equal(utc.zoneLabel(Date.UTC(2026, 0, 15, 12)), 'UTC');
});

test('a stored zone the engine does not know falls back to the browser', () => {
  const { context } = runClient({ storedZone: 'Mars/Olympus_Mons' });
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ms = Date.UTC(2026, 0, 15, 12);
  const expected = runClient({ storedZone: browser }).context.window.credentialConsoleTime.format(ms);
  assert.equal(context.window.credentialConsoleTime.format(ms), expected);
});

test('the metrics bundle draws hour labels through the page clock', async () => {
  const entry = await readFile(new URL('../web/metrics-echarts.entry.js', import.meta.url), 'utf8');
  assert.match(entry, /window\.credentialConsoleTime/);
  assert.match(entry, /'credential-console-time-zone'/);
  assert.match(entry, /axisPointer: \{ label: \{ formatter:/, 'the tooltip heading follows the zone too');
});
