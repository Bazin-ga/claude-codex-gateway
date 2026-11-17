import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { summarizeRelayDaily, summarizeRelaySources } from '../lib/relay-stats.js';
import { relayView } from '../lib/views.js';

const HOUR = 3_600_000;
const chains = [{
  model: 'deepseek-v4-flash',
  aliases: ['DeepSeek-V4.1-Flash'],
  sources: [
    { id: 'aaaaaaaa', name: 'direct', kind: 'endpoint', enabled: true, upstream_model: 'DeepSeek-V4.1-Flash', min_balance_usd: null, price: { input_usd_per_m: 0, output_usd_per_m: 0, cached_input_usd_per_m: 0 } },
    { id: 'bbbbbbbb', name: 'tensoris', kind: 'endpoint', enabled: true, upstream_model: 'flash-1017', min_balance_usd: null, price: { input_usd_per_m: 0.3, output_usd_per_m: 1, cached_input_usd_per_m: 0.03 }, balance_anchor: { usd: 100, at_ms: 10 * HOUR + HOUR / 2 } },
    { id: 'cccccccc', name: 'boyue', kind: 'platform', enabled: true, upstream_model: 'deepseek-v4-flash', min_balance_usd: 500, price: null },
  ],
}];
const catalog = { row: () => ({ input_usd_per_m: 0.1, output_usd_per_m: 0.5, cached_input_usd_per_m: 0.01 }) };
const settings = { name: 'boyue' };
// One million input, ten million cached, one million output per request.
const row = (alias, hour, requests, failures = 0) => ({
  hour_bucket_ms: hour * HOUR, account_alias: alias, model: 'deepseek-v4-flash', device_id: 'd1',
  requests, failures, input_tokens: 1e6 * requests, cache_read_tokens: 10e6 * requests, output_tokens: 1e6 * requests,
});
const perRequest = { tensoris: 0.3 + 0.3 + 1, boyue: 0.1 + 0.1 + 0.5 };

test('the month by source: what each carried and cost, and what the free one saved at the first paid price', () => {
  const spend = [row('relay:direct', 10, 2, 1), row('relay:direct', 11, 1), row('relay:tensoris', 10, 3), row('relay:tensoris', 12, 1), row('relay:boyue', 12, 1)];
  const usage = summarizeRelayDaily({ spend, chains, settings, catalog, nowMs: 20 * HOUR });
  assert.deepEqual(usage.sources.map((source) => [source.name, source.free, source.reference_name]), [
    ['direct', true, 'tensoris'], ['tensoris', false, null], ['boyue', false, null],
  ]);
  const [direct, tensoris, boyue] = usage.sources.map((source) => source.totals);
  assert.equal(direct.requests, 3);
  assert.equal(direct.failures, 1);
  assert.equal(direct.cost, 0, 'a free source costs nothing');
  assert.ok(Math.abs(direct.saved - 3 * perRequest.tensoris) < 1e-9, 'its tokens at the tensoris price');
  assert.ok(Math.abs(tensoris.cost - 4 * perRequest.tensoris) < 1e-9);
  assert.equal(tensoris.saved, null);
  assert.ok(Math.abs(boyue.cost - perRequest.boyue) < 1e-9, 'the platform at its list price');
  assert.equal(usage.hours.length, 5);
  assert.deepEqual(usage.hours[0].slice(0, 4), [10 * HOUR, 0, 2, 1]);
  assert.equal(usage.from_ms, 20 * HOUR - 30 * 24 * HOUR);
});

test('a source with its own address counts down from the balance it was given', () => {
  const spend = [row('relay:tensoris', 9, 5), row('relay:tensoris', 10, 2), row('relay:tensoris', 11, 1)];
  const window = { requests: 3, failures: 0, disconnects: 0, failure_statuses: {}, usage: [row('relay:tensoris', 11, 24)] };
  const stats = { now_ms: 12 * HOUR, sources: [{ alias: 'relay:tensoris', windows: { '15m': window, '1h': window, '24h': window } }], spend };
  const sources = summarizeRelaySources({ stats, window: '24h', chains, settings, catalog });
  const tensoris = sources.chains[0].sources[1];
  // Set halfway through hour 10: half of that hour, all of hour 11, nothing before.
  const spent = 0.5 * 2 * perRequest.tensoris + perRequest.tensoris;
  assert.ok(Math.abs(tensoris.balance.anchored.spent_usd - spent) < 1e-9);
  assert.ok(Math.abs(tensoris.balance.remaining_usd - (100 - spent)) < 1e-9);
  assert.ok(Math.abs(tensoris.balance.burn_usd_per_hour - perRequest.tensoris) < 1e-9, 'a day of spend over 24 hours');
  assert.equal(tensoris.balance.anchored.incomplete, false);
  assert.equal(sources.chains[0].sources[0].balance, null, 'a source nobody gave a balance has none');
});

test('the calibration is kept on the source, survives an edit of it, and is refused for the platform', async () => {
  const store = await new CredentialStore(await mkdtemp(join(tmpdir(), 'relay-balance-')), { allowKeyInit: true }).init();
  await store.saveRelayChain({ model: 'deepseek-v4-flash' });
  await store.saveRelaySource({ model: 'deepseek-v4-flash', name: 'tensoris', kind: 'endpoint', upstream_model: 'x', base_url: 'https://api.example.com/v1', api_key: 'sk-test-0123456789abcdef' });
  await store.saveRelaySource({ model: 'deepseek-v4-flash', name: 'boyue', kind: 'platform', upstream_model: 'deepseek-v4-flash' });
  const [tensoris, boyue] = store.relayChains()[0].sources;
  await store.setRelaySourceBalance({ model: 'deepseek-v4-flash', sourceId: tensoris.id, usd: 250, nowMs: 5_000 });
  assert.deepEqual(store.relayChains()[0].sources[0].balance_anchor, { usd: 250, at_ms: 5_000, by: null });
  await store.saveRelaySource({ model: 'deepseek-v4-flash', sourceId: tensoris.id, name: 'tensoris', kind: 'endpoint', upstream_model: 'y', base_url: 'https://api.example.com/v1' });
  assert.equal(store.relayChains()[0].sources[0].balance_anchor.usd, 250, 'editing the source keeps it');
  await assert.rejects(store.setRelaySourceBalance({ model: 'deepseek-v4-flash', sourceId: boyue.id, usd: 1 }), /read from the platform/);
  await store.setRelaySourceBalance({ model: 'deepseek-v4-flash', sourceId: tensoris.id, usd: null });
  assert.equal(store.relayChains()[0].sources[0].balance_anchor, null);
});

test('the page leads with the sources, carries the month for the charts, and keeps the platform in its settings', () => {
  const spend = [row('relay:direct', 10, 2, 1), row('relay:tensoris', 10, 3)];
  const window = { requests: 3, failures: 0, disconnects: 0, failure_statuses: {}, usage: [row('relay:tensoris', 10, 3)] };
  const stats = { now_ms: 12 * HOUR, sources: [{ alias: 'relay:tensoris', windows: { '15m': window, '1h': window, '24h': window } }], spend };
  const html = relayView({
    settings: { name: 'boyue', base_url: 'http://example.com', allowed_models: [], has_key: true },
    catalog: { rows: [], balance: { used_usd: 19149.82, limit_usd: 20000, remaining_usd: 850, fetched_at: '2026-11-17T06:53:00Z' } },
    chains,
    sources: summarizeRelaySources({ stats, window: '1h', chains, settings, catalog }),
    usage: summarizeRelayDaily({ spend, chains, settings, catalog, nowMs: 12 * HOUR }),
    csrf: 'tok',
    gatewayBaseUrl: 'https://gw.example',
    nowMs: 12 * HOUR,
  });
  const top = html.slice(html.indexOf('data-relay-page'), html.indexOf('id="relay-sources"'));
  assert.match(top, /class="relay-overview"/);
  assert.match(top, /relay-tile is-main/, 'the paid source with its own address leads');
  assert.match(top, /name="op" value="balance"/);
  assert.doesNotMatch(top, /Platform key spend/, 'the platform is no longer the headline');
  const settingsBlock = html.slice(html.lastIndexOf('<details'));
  assert.match(settingsBlock, /Platform key spend/);
  assert.match(settingsBlock, /plain HTTP/);
  const data = JSON.parse(html.match(/<script type="application\/json" data-relay-usage-data>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.sources.map((source) => source.name), ['direct', 'tensoris', 'boyue']);
  assert.equal(data.hours.length, 2);
  assert.match(html, /data-relay-usage-fallback/);
});
