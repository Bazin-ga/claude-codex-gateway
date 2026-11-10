import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CredentialStore } from '../lib/store.js';
import { MetricsStore } from '../lib/metrics.js';
import { createRelay, parseRelayRoutes } from '../lib/relay-proxy.js';
import { relayCatalogFromPricing, relayCostUsd, relayPriceMultiplier } from '../lib/relay.js';
import { billingWeekProfile, compileBillingExpression } from '../lib/relay-pricing.js';
import {
  RELAY_PIN_MS,
  createRelaySourceHealth,
  parseRelayChainInput,
  parseRelaySourceInput,
  planRelaySources,
  relayBalanceRefusal,
  relayFailoverStatus,
  relayRequestOnlyStatus,
  relayRequestWithoutThinking,
  relayRequestWithThinkingRestored,
} from '../lib/relay-chain.js';
import {
  createRelayStatsCache,
  relayPricer,
  summarizeRelaySources,
  summarizeRelaySpend,
} from '../lib/relay-stats.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PLATFORM_KEY = 'sk-relay-platform-key-0123456789';
const SOURCE_KEY = 'sk-source-own-key-0123456789';
const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SSE_MESSAGES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');
// The formula the platform publishes for its DeepSeek model: twice the price
// on weekday mornings and afternoons, Beijing time.
const PEAK_EXPRESSION = '(tier("base", p * 1 + c * 4 + cr * 0.02))'
  + ' * (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12 && weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") < 6 ? 2 : 1)'
  + ' * (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18 && weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") < 6 ? 2 : 1)';
/** 2026-11-10 is a Tuesday; the hour given is Beijing's. */
const beijing = (day, hour) => Date.UTC(2026, 10, day, hour - 8);

async function newStore(t) {
  const home = await mkdtemp(join(tmpdir(), 'relay-chain-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { home, store: await new CredentialStore(home, { allowKeyInit: true }).init() };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const answerJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const completion = (res) => answerJson(res, 200, {
  id: 'x',
  choices: [{ message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
});

/** An upstream whose answer the test decides turn by turn. */
async function upstream(t, answer = (req, res) => completion(res)) {
  const source = { seen: [], answer };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    source.seen.push({ url: req.url, headers: req.headers, body });
    await source.answer(req, res, body);
  });
  source.url = await listen(server);
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return source;
}

/**
 * The relay alone behind a listener, with a clock the test moves: a platform,
 * two endpoints of their own, and one chain made of whichever the test names.
 */
async function chainRelay(t, { sources, aliases = [], routes = '', remaining = null }) {
  const { store } = await newStore(t);
  const platform = await upstream(t);
  const first = await upstream(t);
  const second = await upstream(t);
  const account = await store.addAccount({ provider: 'claude', alias: 'claude-1', credential: { oauth_token: 'sk-ant-oat01-real' } });
  const issued = await store.issueDeviceCredential({ accountId: account.id, memberLabel: 'm', deviceName: 'laptop' });
  await store.setRelayPlatform({ name: 'boyue', baseUrl: `${platform.url}/v1`, apiKey: PLATFORM_KEY });
  const described = {
    first: { name: 'first', kind: 'endpoint', base_url: `${first.url}/v1`, api_key: SOURCE_KEY, upstream_model: 'flash-at-first' },
    second: { name: 'second', kind: 'endpoint', base_url: `${second.url}/v1`, upstream_model: 'flash-at-second' },
    platform: { name: 'boyue', kind: 'platform', upstream_model: 'deepseek-v4-flash' },
  };
  await store.importRelayChains({
    chains: [{
      model: 'deepseek-v4-flash',
      aliases,
      sources: sources.map((entry) => (typeof entry === 'string' ? described[entry] : { ...described[entry.use], ...entry.with })),
    }],
  });
  const state = { clock: Date.UTC(2026, 10, 10, 2), remaining };
  const metrics = [];
  const relay = createRelay({
    store,
    catalog: { remainingUsd: () => state.remaining, refreshBalance: async () => {} },
    requestMetrics: { enqueueRequest: (row) => { metrics.push(row); } },
    enabled: true,
    now: () => state.clock,
    routes: parseRelayRoutes(routes),
  });
  const server = http.createServer((req, res) => relay.handle(req, res));
  const baseUrl = await listen(server);
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await store.serialized(async () => {});
  });
  const post = (body, { path = '/relay/v1/chat/completions', headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const turn = (options) => post({ model: 'deepseek-v4-flash', messages: [] }, options);
  const sourceId = (name) => store.relayChains()[0].sources.find((source) => source.name === name).id;
  return { store, relay, state, metrics, platform, first, second, baseUrl, token: issued.token, post, turn, sourceId };
}

const attempts = (metrics) => metrics.map((row) => `${row.accountAlias} ${row.statusCode} ${row.outcome}`);

test('a billing formula is evaluated, peak hours included, and anything else is refused', () => {
  const billing = compileBillingExpression(PEAK_EXPRESSION);
  const tokens = { p: 1e6, c: 1e6, cr: 1e6 };
  assert.equal(billing(tokens, beijing(10, 13)), 1e6 * 5.02);
  assert.equal(billing(tokens, beijing(10, 10)), 2e6 * 5.02, 'weekday morning');
  assert.equal(billing(tokens, beijing(10, 17)), 2e6 * 5.02, 'weekday afternoon');
  assert.equal(billing(tokens, beijing(10, 18)), 1e6 * 5.02);
  assert.equal(billing(tokens, beijing(14, 10)), 1e6 * 5.02, 'Saturday');
  assert.equal(billingWeekProfile(billing).peakMultiplier, 2);

  for (const text of ['process.exit()', 'p * ', 'p + c)', 'hour("Nowhere/Zone") > 1 ? p : c', '"a".constructor', '', 'p; c']) {
    assert.equal(compileBillingExpression(text), null, text);
  }
  assert.equal(compileBillingExpression('0 - p')({ p: 5 }), null, 'a negative bill is not a bill');
});

test('a model priced by formula is quoted off-peak and costed at the hour it ran', () => {
  const [row] = relayCatalogFromPricing({
    group_ratio: { vip: 0.147473, default: 1 },
    data: [{
      model_name: 'deepseek-v4-flash',
      quota_type: 0,
      model_ratio: 0.5,
      completion_ratio: 2,
      cache_ratio: 0.02,
      enable_groups: ['vip'],
      supported_endpoint_types: ['openai'],
      billing_mode: 'tiered_expr',
      billing_expr: PEAK_EXPRESSION,
    }],
  });
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
  near(row.input_usd_per_m, 0.147473);
  near(row.output_usd_per_m, 0.589892);
  near(row.cached_input_usd_per_m, 0.00294946);
  assert.equal(row.peak_multiplier, 2);

  const used = { inputTokens: 2e6, outputTokens: 1e6, cacheReadInputTokens: 10e6, requests: 40 };
  const offPeak = 0.147473 * (2 + 4 + 0.2);
  near(relayCostUsd(row, used, beijing(10, 13)), offPeak);
  near(relayCostUsd(row, used, beijing(10, 15)), offPeak * 2);
  near(relayPriceMultiplier(row, beijing(10, 13)), 1);
  near(relayPriceMultiplier(row, beijing(10, 15)), 2);
  assert.equal(relayPriceMultiplier({ input_usd_per_m: 1, output_usd_per_m: 2 }, beijing(10, 15)), 1, 'no formula, no peak');

  // A formula this gateway cannot read leaves the row on the listed ratios.
  const [plain] = relayCatalogFromPricing({
    group_ratio: { vip: 0.147473 },
    data: [{ model_name: 'm', quota_type: 0, model_ratio: 0.5, completion_ratio: 2, enable_groups: ['vip'], supported_endpoint_types: ['openai'], billing_mode: 'tiered_expr', billing_expr: 'surprise(p)' }],
  });
  assert.equal(plain.billing, null);
  near(plain.output_usd_per_m, 0.294946);
});

test('chain and source input is validated before anything is stored', () => {
  assert.deepEqual(parseRelayChainInput({ model: ' deepseek-v4-flash ', aliases: 'DeepSeek-V4.1-Flash, deepseek-v4-flash;other' }), {
    model: 'deepseek-v4-flash',
    aliases: ['DeepSeek-V4.1-Flash', 'other'],
  });
  assert.throws(() => parseRelayChainInput({ model: 'bad name' }), /valid model name/);
  assert.throws(() => parseRelayChainInput({ model: 'a', aliases: 'b' }, { others: [{ model: 'x', aliases: ['b'] }] }), /already names another chain/);

  const ok = parseRelaySourceInput({ name: 'tensoris', kind: 'endpoint', base_url: 'https://api.example/v1', api_key: SOURCE_KEY, upstream_model: 'flash', input_usd_per_m: '0.278', output_usd_per_m: '1.111', cached_input_usd_per_m: '0.0278', first_byte_timeout_s: '30' });
  assert.equal(ok.apiKey, SOURCE_KEY);
  assert.equal(JSON.stringify(ok.source).includes(SOURCE_KEY), false);
  assert.deepEqual(ok.source.price, { input_usd_per_m: 0.278, output_usd_per_m: 1.111, cached_input_usd_per_m: 0.0278 });
  assert.equal(ok.source.base_url, 'https://api.example');
  assert.equal(ok.source.first_byte_timeout_s, 30);
  assert.equal(ok.source.enabled, true);
  assert.equal(parseRelaySourceInput({ name: 'free', kind: 'endpoint', base_url: 'http://127.0.0.1:1', upstream_model: 'm', input_usd_per_m: '0', output_usd_per_m: '0' }).source.price.input_usd_per_m, 0);
  assert.equal(parseRelaySourceInput({ name: 'p', kind: 'platform', upstream_model: 'm', min_balance_usd: '500', base_url: 'http://ignored', api_key: SOURCE_KEY }).source.base_url, null);

  const refused = [
    [{ name: 'Tensoris', kind: 'endpoint', base_url: 'https://x.example', upstream_model: 'm' }, /source name/],
    [{ name: 'a', kind: 'other', upstream_model: 'm' }, /platform or its own endpoint/],
    [{ name: 'a', kind: 'endpoint', base_url: 'ftp://x', upstream_model: 'm' }, /http\(s\) address/],
    [{ name: 'a', kind: 'endpoint', base_url: 'https://x.example', upstream_model: 'm', api_key: 'short' }, /malformed/],
    [{ name: 'a', kind: 'platform', upstream_model: 'm', input_usd_per_m: '1' }, /both the input and the output/],
    [{ name: 'a', kind: 'platform', upstream_model: 'm', input_usd_per_m: '1e3', output_usd_per_m: '1' }, /plain number/],
    [{ name: 'a', kind: 'platform', upstream_model: 'm', first_byte_timeout_s: '2' }, /first-byte wait/],
    [{ name: 'a', kind: 'endpoint', base_url: 'https://x.example', upstream_model: 'm', min_balance_usd: '5' }, /only the platform source/],
  ];
  for (const [input, message] of refused) assert.throws(() => parseRelaySourceInput(input), message);
});

test('a failing source rests longer each time, and a moved conversation is held for half an hour', () => {
  let clock = 1_000_000;
  const health = createRelaySourceHealth({ now: () => clock });
  assert.equal(health.coolingUntil('a'), 0);
  health.failure('a', { status: 500 });
  assert.equal(health.coolingUntil('a'), clock + 30_000);
  clock += 30_000;
  assert.equal(health.coolingUntil('a'), 0, 'the rest is over');
  health.failure('a', { status: 500 });
  assert.equal(health.coolingUntil('a'), clock + 60_000, 'twice in a row: twice as long');
  health.success('a');
  assert.equal(health.coolingUntil('a'), 0);
  health.failure('a', { status: 402, balance: true });
  assert.equal(health.coolingUntil('a'), clock + 600_000, 'out of money: no point asking again soon');
  assert.equal(health.describe('a').last_failure.balance, true);
  assert.equal(health.describe('never-seen').cooling_until_ms, null);

  health.pin('device:session', 'b');
  assert.equal(health.pinned('device:session'), 'b');
  clock += RELAY_PIN_MS - 1;
  health.pin('device:session', 'b');
  assert.equal(health.pinned('device:session'), 'b');
  clock += 1;
  assert.equal(health.pinned('device:session'), null, 'using the hold does not extend it');
  assert.equal(health.pinned(null), null);

  // Order: the pinned source, then the ready ones in chain order, then the
  // resting ones, soonest back first.
  const sources = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const fresh = createRelaySourceHealth({ now: () => clock });
  fresh.failure('a', { status: 500 });
  fresh.failure('a', { status: 500 });
  fresh.failure('b', { status: 500 });
  const order = (pinnedId) => planRelaySources(sources, { health: fresh, pinnedId }).map((source) => source.id);
  assert.deepEqual(order(null), ['c', 'd', 'b', 'a']);
  assert.deepEqual(order('d'), ['d', 'c', 'b', 'a']);
  assert.deepEqual(order('a'), ['c', 'd', 'b', 'a'], 'a resting source is not preferred for being pinned');

  assert.equal(relayFailoverStatus(500), true);
  assert.equal(relayFailoverStatus(429), true);
  assert.equal(relayFailoverStatus(400), false);
  assert.equal(relayFailoverStatus(422), false);
  assert.equal(relayBalanceRefusal(402, ''), true);
  assert.equal(relayBalanceRefusal(403, '{"error":"Insufficient account balance"}'), true);
  assert.equal(relayBalanceRefusal(429, '{"error":"余额不足"}'), true);
  assert.equal(relayBalanceRefusal(429, '{"error":"slow down"}'), false);
  assert.equal(relayBalanceRefusal(500, 'quota'), false);
});

test('a request is rewritten without reasoning for each of the three protocols', () => {
  const messages = relayRequestWithoutThinking('messages', {
    model: 'm',
    thinking: { type: 'enabled', budget_tokens: 1000 },
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only this' }] },
    ],
  });
  assert.deepEqual(messages.thinking, { type: 'disabled' });
  assert.deepEqual(messages.messages[1].content, [{ type: 'text', text: 'a' }]);
  assert.equal(messages.messages[2].content.length, 1, 'a turn that was only reasoning is not emptied');
  assert.equal(relayRequestWithoutThinking('messages', { thinking: { type: 'disabled' } }), null);

  const chat = relayRequestWithoutThinking('chat', {
    model: 'm',
    messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'user', content: 'q' }],
  });
  assert.deepEqual(chat.thinking, { type: 'disabled' });
  assert.deepEqual(chat.messages[0], { role: 'assistant', content: 'a' });

  const responses = relayRequestWithoutThinking('responses', {
    model: 'm',
    include: ['reasoning.encrypted_content', 'other'],
    input: [{ type: 'reasoning', id: 'r' }, { type: 'message', role: 'user', content: 'q' }],
  });
  assert.deepEqual(responses.reasoning, { effort: 'none' });
  assert.deepEqual(responses.include, ['other']);
  assert.deepEqual(responses.input.map((item) => item.type), ['message']);
  assert.equal(relayRequestWithoutThinking('responses', { reasoning: { effort: 'none' } }), null);
  assert.equal(relayRequestWithoutThinking('chat', null), null);
});

test('reasoning a turn lacks is put back as an empty block, for the Messages protocol only', () => {
  const placeholder = { type: 'thinking', thinking: '', signature: '' };
  const request = {
    model: 'm',
    thinking: { type: 'enabled', budget_tokens: 1000 },
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'kept', signature: 's' }, { type: 'text', text: 'a' }] },
      { role: 'assistant', content: 'said plainly' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: [] },
    ],
  };
  const restored = relayRequestWithThinkingRestored('messages', request);
  assert.deepEqual(restored.thinking, request.thinking, 'reasoning stays on');
  assert.deepEqual(restored.messages[1].content, [placeholder, request.messages[1].content[0]]);
  assert.deepEqual(restored.messages[4].content, [placeholder, { type: 'text', text: 'said plainly' }]);
  for (const index of [0, 2, 3, 5, 6]) assert.equal(restored.messages[index], request.messages[index]);
  assert.equal(request.messages[1].content.length, 1, 'the request it was made from is not touched');

  assert.equal(relayRequestWithThinkingRestored('messages', { messages: [request.messages[0], request.messages[3]] }), null, 'no turn lacks it');
  assert.equal(relayRequestWithThinkingRestored('messages', { ...request, thinking: { type: 'disabled' } }), null);
  assert.equal(relayRequestWithThinkingRestored('chat', { messages: [{ role: 'assistant', content: 'a' }] }), null);
  assert.equal(relayRequestWithThinkingRestored('responses', { input: [] }), null);
  assert.equal(relayRequestWithThinkingRestored('messages', null), null);
});

test('chains are stored with their keys encrypted; changing a source keeps its key, its place and whether it is on', async (t) => {
  const { home, store } = await newStore(t);
  await store.setRelayPlatform({ name: 'boyue', baseUrl: 'http://1.2.3.4:3888/v1', apiKey: PLATFORM_KEY });
  await store.saveRelayChain({ model: 'deepseek-v4-flash', aliases: 'DeepSeek-V4.1-Flash', actor: 'ops' });
  await assert.rejects(store.saveRelayChain({ model: 'DeepSeek-V4.1-Flash' }), /already names another chain/);
  const source = { name: 'tensoris', kind: 'endpoint', base_url: 'https://api.example/v1', api_key: SOURCE_KEY, upstream_model: 'flash-1017' };
  await store.saveRelaySource({ model: 'deepseek-v4-flash', actor: 'ops', ...source });
  await store.saveRelaySource({ model: 'deepseek-v4-flash', name: 'boyue', kind: 'platform', upstream_model: 'deepseek-v4-flash', min_balance_usd: '500' });
  await assert.rejects(store.saveRelaySource({ model: 'deepseek-v4-flash', ...source }), /already has a source named/);
  await assert.rejects(store.saveRelaySource({ model: 'nope', ...source }), /unknown chain/);

  let [chain] = store.relayChains();
  const [tensoris, boyue] = chain.sources;
  assert.deepEqual(chain.sources.map((entry) => entry.name), ['tensoris', 'boyue']);
  assert.equal(tensoris.has_key, true);
  assert.equal(boyue.has_key, false);
  assert.equal(boyue.min_balance_usd, 500);
  assert.equal(JSON.stringify(chain).includes(SOURCE_KEY), false);
  assert.equal((await readFile(join(home, 'state.json'), 'utf8')).includes(SOURCE_KEY), false);
  assert.equal(store.relaySourceApiKey('deepseek-v4-flash', tensoris.id), SOURCE_KEY);
  assert.equal(JSON.stringify(store.state.audit).includes(SOURCE_KEY), false);

  await store.setRelaySourceEnabled({ model: 'deepseek-v4-flash', sourceId: tensoris.id, enabled: false });
  await store.saveRelaySource({ model: 'deepseek-v4-flash', sourceId: tensoris.id, ...source, api_key: '', upstream_model: 'flash-1101' });
  [chain] = store.relayChains();
  assert.equal(chain.sources[0].id, tensoris.id);
  assert.equal(chain.sources[0].upstream_model, 'flash-1101');
  assert.equal(chain.sources[0].enabled, false, 'saving the form does not switch it back on');
  assert.equal(store.relaySourceApiKey('deepseek-v4-flash', tensoris.id), SOURCE_KEY, 'an empty key keeps the stored one');

  await store.moveRelaySource({ model: 'deepseek-v4-flash', sourceId: tensoris.id, direction: 'down' });
  await store.moveRelaySource({ model: 'deepseek-v4-flash', sourceId: tensoris.id, direction: 'down' });
  assert.deepEqual(store.relayChains()[0].sources.map((entry) => entry.name), ['boyue', 'tensoris']);

  await store.saveRelayChain({ model: 'ds-flash', aliases: ['deepseek-v4-flash'], previousModel: 'deepseek-v4-flash' });
  assert.equal(store.relayChains()[0].sources.length, 2, 'a rename keeps the sources');
  assert.equal(store.relaySourceApiKey('ds-flash', tensoris.id), SOURCE_KEY);

  // A fresh store reads the same thing back from disk.
  const reopened = await new CredentialStore(home).init();
  assert.deepEqual(reopened.relayChains(), store.relayChains());
  assert.equal(reopened.relaySourceApiKey('ds-flash', tensoris.id), SOURCE_KEY);

  await store.deleteRelaySource({ model: 'ds-flash', sourceId: tensoris.id });
  assert.equal(store.relaySourceApiKey('ds-flash', tensoris.id), null);
  await store.deleteRelayChain({ model: 'ds-flash' });
  assert.deepEqual(store.relayChains(), []);
  assert.deepEqual(
    store.state.audit.map((entry) => entry.event).filter((event) => event.startsWith('relay_chain') || event.startsWith('relay_source')),
    ['relay_chain_created', 'relay_source_added', 'relay_source_added', 'relay_source_disabled', 'relay_source_updated',
      'relay_source_moved', 'relay_source_moved', 'relay_chain_updated', 'relay_source_deleted', 'relay_chain_deleted'],
  );
});

test('a turn tries the sources in order: a failing one is rested and the next answers, and both attempts are recorded', { timeout: 20_000 }, async (t) => {
  const { first, second, platform, state, metrics, turn, relay, sourceId } = await chainRelay(t, { sources: ['first', 'second', 'platform'] });
  first.answer = (req, res) => answerJson(res, 503, { error: 'overloaded' });

  const moved = await turn();
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).choices[0].message.content, 'hi');
  assert.equal(first.seen[0].headers.authorization, `Bearer ${SOURCE_KEY}`);
  assert.equal(first.seen[0].body.model, 'flash-at-first');
  assert.equal(second.seen[0].body.model, 'flash-at-second', 'each source is asked for the model under its own name');
  assert.equal(second.seen[0].headers.authorization, undefined, 'a source without a key gets none, least of all the platform key');
  assert.deepEqual(attempts(metrics), ['relay:first 503 upstream_error', 'relay:second 200 completed']);
  assert.ok(metrics.every((row) => row.model === 'deepseek-v4-flash' && row.accountId === 'relay'));
  assert.equal(metrics[1].inputTokens, 5);
  assert.equal(relay.sourceStates().get(sourceId('first')).cooling_until_ms, state.clock + 30_000);
  assert.equal(relay.sourceStates().get(sourceId('first')).last_failure.status, 503);

  // While it rests it is not asked at all.
  first.answer = (req, res) => completion(res);
  await (await turn()).text();
  assert.equal(first.seen.length, 1);
  assert.equal(second.seen.length, 2);

  // Rested, it is the first choice again.
  state.clock += 31_000;
  await (await turn()).text();
  assert.equal(first.seen.length, 2);
  assert.equal(second.seen.length, 2);
  assert.equal(platform.seen.length, 0);
  assert.equal(relay.sourceStates().get(sourceId('first')).cooling_until_ms, null);
});

test('a conversation moved to a fallback stays on it for half an hour; other conversations go back at once', { timeout: 20_000 }, async (t) => {
  const { first, second, state, turn } = await chainRelay(t, { sources: ['first', 'second'] });
  const session = { headers: { 'session-id': 'conversation-0001' } };
  first.answer = (req, res) => answerJson(res, 500, { error: 'down' });
  assert.equal((await turn(session)).status, 200);
  first.answer = (req, res) => completion(res);
  state.clock += 31_000;

  await (await turn(session)).text();
  assert.equal(first.seen.length, 1, 'the moved conversation is not bounced back');
  assert.equal(second.seen.length, 2);
  await (await turn({ headers: { 'session-id': 'conversation-0002' } })).text();
  await (await turn()).text();
  assert.equal(first.seen.length, 3, 'a different conversation, and one without a session, take the first choice');

  state.clock += RELAY_PIN_MS;
  await (await turn(session)).text();
  assert.equal(first.seen.length, 4, 'the hold has lapsed');
  assert.equal(second.seen.length, 2);
});

test('a refusal about the request itself is passed on without trying another source', { timeout: 20_000 }, async (t) => {
  const { first, second, metrics, turn, relay, sourceId } = await chainRelay(t, { sources: ['first', 'second'] });
  first.answer = (req, res) => answerJson(res, 400, { error: { message: 'max_tokens is too large' } });
  const refused = await turn();
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.message, 'max_tokens is too large');
  assert.equal(second.seen.length, 0);
  assert.deepEqual(attempts(metrics), ['relay:first 400 upstream_error']);
  assert.equal(relay.sourceStates().get(sourceId('first')).cooling_until_ms, null, 'the source did nothing wrong');
});

test('when every source fails the client gets the last one\'s answer, and resting sources are still tried', { timeout: 20_000 }, async (t) => {
  const { first, second, metrics, turn } = await chainRelay(t, { sources: ['first', 'second'] });
  first.answer = (req, res) => answerJson(res, 503, { error: 'first is down' });
  second.answer = (req, res) => answerJson(res, 429, { error: 'second is busy' });
  const failed = await turn();
  assert.equal(failed.status, 429);
  assert.equal((await failed.json()).error, 'second is busy');
  assert.deepEqual(attempts(metrics), ['relay:first 503 upstream_error', 'relay:second 429 upstream_error']);

  // Both rest now; a source that failed a moment ago still beats no answer.
  second.answer = (req, res) => completion(res);
  assert.equal((await turn()).status, 200);
  assert.equal(first.seen.length, 2);
  assert.equal(second.seen.length, 2);
});

test('a source that is unreachable fails over like one that answers with an error', { timeout: 20_000 }, async (t) => {
  const { second, metrics, turn } = await chainRelay(t, {
    sources: [{ use: 'first', with: { base_url: 'http://127.0.0.1:1/v1' } }, 'second'],
  });
  assert.equal((await turn()).status, 200);
  assert.equal(second.seen.length, 1);
  assert.deepEqual(attempts(metrics), ['relay:first 502 upstream_error', 'relay:second 200 completed']);
});

test('a conversation whose history lacks reasoning is retried on the same source without it', { timeout: 20_000 }, async (t) => {
  const { first, second, metrics, post } = await chainRelay(t, { sources: ['first', 'second'] });
  first.answer = (req, res, body) => (body.thinking?.type === 'disabled'
    ? completion(res)
    : answerJson(res, 400, { error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.' } }));
  const answered = await post({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'user', content: 'q' }],
  });
  assert.equal(answered.status, 200);
  assert.equal(first.seen.length, 2);
  assert.equal('reasoning_content' in first.seen[1].body.messages[0], false);
  assert.equal(first.seen[1].body.model, 'flash-at-first');
  assert.equal(second.seen.length, 0, 'not a reason to change source');
  assert.deepEqual(attempts(metrics), ['relay:first 200 completed']);

  // If that does not help either, the first refusal is what the client sees.
  first.answer = (req, res) => answerJson(res, 400, { error: { message: 'thinking is not supported' } });
  const refused = await post({ model: 'deepseek-v4-flash', messages: [] });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.message, 'thinking is not supported');
});

test('a Messages conversation whose turns lack reasoning keeps reasoning on: the source is asked again with empty blocks', { timeout: 20_000 }, async (t) => {
  const { first, second, metrics, post } = await chainRelay(t, { sources: ['first', 'second'] });
  const refusal = { error: { message: 'The `content[].thinking` in the thinking mode must be passed back to the API.' } };
  const reasoned = (body) => body.messages
    .filter((message) => message.role === 'assistant')
    .every((message) => Array.isArray(message.content) && message.content[0]?.type === 'thinking');
  const request = {
    model: 'deepseek-v4-flash',
    max_tokens: 10,
    thinking: { type: 'enabled', budget_tokens: 1000 },
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
    ],
  };
  const ask = () => post(request, { path: '/relay/v1/messages' });
  first.answer = (req, res, body) => (reasoned(body) ? completion(res) : answerJson(res, 400, refusal));
  assert.equal((await ask()).status, 200);
  assert.equal(first.seen.length, 2);
  assert.deepEqual(first.seen[1].body.thinking, request.thinking, 'reasoning is still on');
  assert.deepEqual(first.seen[1].body.messages[1].content, [{ type: 'thinking', thinking: '', signature: '' }, request.messages[1].content[0]]);
  assert.equal(first.seen[1].body.model, 'flash-at-first');
  assert.equal(second.seen.length, 0, 'not a reason to change source');
  assert.deepEqual(attempts(metrics), ['relay:first 200 completed']);

  // A source an empty block does not satisfy is asked a third time, without reasoning.
  first.seen.length = 0;
  first.answer = (req, res, body) => (body.thinking?.type === 'disabled' ? completion(res) : answerJson(res, 400, refusal));
  assert.equal((await ask()).status, 200);
  assert.equal(first.seen.length, 3);
  assert.equal(reasoned(first.seen[1].body), true);
  assert.deepEqual(first.seen[2].body.thinking, { type: 'disabled' });
  assert.deepEqual(first.seen[2].body.messages[1].content, request.messages[1].content);

  // And when nothing helps, the first refusal is what the client sees.
  first.seen.length = 0;
  first.answer = (req, res) => answerJson(res, 400, refusal);
  const refused = await ask();
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), refusal);
  assert.equal(first.seen.length, 3);
  assert.equal(second.seen.length, 0);
});

test('the platform source is skipped below its balance line, and used while the balance is unknown', { timeout: 20_000 }, async (t) => {
  const { platform, second, state, turn, relay, sourceId, metrics } = await chainRelay(t, {
    sources: [{ use: 'platform', with: { min_balance_usd: 500 } }, 'second'],
    remaining: 499.99,
  });
  await (await turn()).text();
  assert.equal(platform.seen.length, 0);
  assert.equal(second.seen.length, 1);
  assert.equal(relay.sourceStates().get(sourceId('boyue')).balance_low, true);

  state.remaining = 500;
  await (await turn()).text();
  assert.equal(platform.seen.length, 1);
  assert.equal(platform.seen[0].headers.authorization, `Bearer ${PLATFORM_KEY}`);
  assert.equal(platform.seen[0].body.model, 'deepseek-v4-flash');
  assert.equal(relay.sourceStates().get(sourceId('boyue')).balance_low, false);

  state.remaining = null;
  await (await turn()).text();
  assert.equal(platform.seen.length, 2, 'an unread balance is not a low one');
  assert.deepEqual(attempts(metrics), ['relay:second 200 completed', 'relay:boyue 200 completed', 'relay:boyue 200 completed']);
});

test('a source that says it is out of money rests ten minutes; with no source left the turn is refused here', { timeout: 20_000 }, async (t) => {
  const { first, state, turn, relay, sourceId, store, metrics } = await chainRelay(t, {
    sources: ['first', { use: 'platform', with: { min_balance_usd: 500 } }],
    remaining: 100,
  });
  first.answer = (req, res) => answerJson(res, 403, { error: { message: 'Insufficient account balance' } });
  const refused = await turn();
  assert.equal(refused.status, 403, 'the only usable source: its answer is the answer');
  const standing = relay.sourceStates().get(sourceId('first'));
  assert.equal(standing.cooling_until_ms, state.clock + 600_000);
  assert.equal(standing.last_failure.balance, true);

  await store.setRelaySourceEnabled({ model: 'deepseek-v4-flash', sourceId: sourceId('first'), enabled: false });
  const none = await turn();
  assert.equal(none.status, 503);
  assert.match((await none.json()).error.message, /no source of model "deepseek-v4-flash"/);
  assert.equal(metrics.at(-1).outcome, 'rejected');
});

test('a stream that has not begun in time is given up on while another source can take it', { timeout: 30_000 }, async (t) => {
  const { first, second, metrics, post } = await chainRelay(t, {
    sources: [{ use: 'first', with: { first_byte_timeout_s: 5 } }, 'second'],
  });
  first.answer = () => {}; // never answers
  second.answer = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE_MESSAGES);
  };
  const started = Date.now();
  const streamed = await post({ model: 'deepseek-v4-flash', max_tokens: 10, stream: true, messages: [] }, { path: '/relay/v1/messages' });
  assert.equal(streamed.status, 200);
  assert.equal(await streamed.text(), SSE_MESSAGES);
  assert.ok(Date.now() - started >= 4_900, 'waited for the first source');
  assert.deepEqual(attempts(metrics), ['relay:first 502 upstream_error', 'relay:second 200 completed']);
  assert.equal(metrics[1].outputTokens, 7);
  assert.equal(second.seen[0].url, '/v1/messages');
});

test('a source that accepts a stream and then says nothing, or stalls on the retry without reasoning, is given up on too', { timeout: 40_000 }, async (t) => {
  const { first, platform, second, metrics, post, relay, sourceId } = await chainRelay(t, {
    sources: [{ use: 'first', with: { first_byte_timeout_s: 5 } }, { use: 'platform', with: { first_byte_timeout_s: 5 } }, 'second'],
  });
  first.answer = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders(); // and not a byte more
  };
  platform.answer = (req, res, body) => {
    if (body.thinking?.type !== 'disabled') answerJson(res, 400, { error: { message: 'reasoning_content must be passed back' } });
  };
  const chunk = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  second.answer = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk);
  };
  const streamed = await post({
    model: 'deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'user', content: 'q' }],
  });
  assert.equal(streamed.status, 200);
  assert.equal(await streamed.text(), chunk, 'nothing of the silent sources reached the client');
  assert.deepEqual(attempts(metrics), ['relay:first 502 upstream_error', 'relay:boyue 502 upstream_error', 'relay:second 200 completed']);
  assert.equal(platform.seen.length, 2, 'asked again without reasoning before it was given up on');
  assert.equal(relay.sourceStates().get(sourceId('first')).last_failure.reason, 'first_byte_timeout');
  assert.equal(relay.sourceStates().get(sourceId('boyue')).last_failure.reason, 'first_byte_timeout');
});

test('a source is cleared of its failures by finishing an answer, not by starting one', { timeout: 20_000 }, async (t) => {
  const { first, state, post, relay, sourceId, metrics } = await chainRelay(t, { sources: ['first', 'second'] });
  const cut = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"h"}}]}\n\n', () => res.destroy());
  };
  const whole = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  };
  const stream = async () => {
    const response = await post({ model: 'deepseek-v4-flash', stream: true, messages: [] });
    await response.text().catch(() => {});
  };
  const resting = () => relay.sourceStates().get(sourceId('first')).cooling_until_ms - state.clock;

  first.answer = cut;
  await stream();
  assert.equal(metrics.at(-1).outcome, 'upstream_error');
  assert.equal(resting(), 30_000);
  state.clock += 31_000;
  await stream();
  assert.equal(resting(), 60_000, 'the second break in a row, though each began well');

  state.clock += 61_000;
  first.answer = whole;
  await stream();
  assert.equal(relay.sourceStates().get(sourceId('first')).cooling_until_ms, null);
  first.answer = cut;
  await stream();
  assert.equal(resting(), 30_000, 'a finished answer in between starts the count again');
});

test('a source that does not serve an endpoint passes the turn on without being rested', { timeout: 20_000 }, async (t) => {
  const { first, second, metrics, post, turn, relay, sourceId } = await chainRelay(t, { sources: ['first', 'second'] });
  first.answer = (req, res) => (req.url === '/v1/responses'
    ? answerJson(res, 404, { error: { message: 'Not Found' } })
    : completion(res));
  const session = { headers: { 'session-id': 'conversation-0001' } };
  const moved = await post({ model: 'deepseek-v4-flash', input: 'q' }, { path: '/relay/v1/responses', ...session });
  assert.equal(moved.status, 200);
  assert.deepEqual(attempts(metrics), ['relay:first 404 upstream_error', 'relay:second 200 completed']);
  assert.equal(relay.sourceStates().get(sourceId('first')).cooling_until_ms, null);
  assert.equal(relay.sourceStates().get(sourceId('first')).last_failure, null);

  // Everybody else's turns still go to it; the conversation that needed the
  // other source stays there.
  await (await turn()).text();
  assert.equal(first.seen.length, 2);
  await (await post({ model: 'deepseek-v4-flash', input: 'q' }, { path: '/relay/v1/responses', ...session })).text();
  assert.equal(first.seen.length, 2);
  assert.equal(second.seen.length, 2);

  assert.equal(relayRequestOnlyStatus(404), true);
  assert.equal(relayRequestOnlyStatus(405), true);
  assert.equal(relayFailoverStatus(405), true);
  assert.equal(relayRequestOnlyStatus(429), false);
});

test('a rate limit that speaks of quota is not taken for an empty balance', () => {
  assert.equal(relayBalanceRefusal(429, 'Rate limit reached: requests per minute quota'), false);
  assert.equal(relayBalanceRefusal(429, '当前分组额度限流，请稍后再试'), false);
  assert.equal(relayBalanceRefusal(429, 'You exceeded your current quota, please check your plan and billing details'), true);
  assert.equal(relayBalanceRefusal(403, '用户额度不足'), true);
  assert.equal(relayBalanceRefusal(403, 'token quota is not enough'), true);
  assert.equal(relayBalanceRefusal(401, '该令牌额度已用尽'), true);
  assert.equal(relayBalanceRefusal(402, ''), true);
  assert.equal(relayBalanceRefusal(500, 'insufficient balance'), false);
});

test('a model with one source is forwarded as it always was: a refusal about reasoning is the client\'s to see', { timeout: 20_000 }, async (t) => {
  const { platform, first, metrics, post, store } = await chainRelay(t, { sources: ['first'] });
  await store.setRelayModelAllowed({ model: 'plain-model', allowed: true });
  platform.answer = (req, res) => answerJson(res, 400, { error: { message: 'reasoning_content must be passed back' } });
  const refused = await post({
    model: 'plain-model',
    messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'user', content: 'q' }],
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.message, 'reasoning_content must be passed back');
  assert.equal(platform.seen.length, 1, 'not asked a second time with the request changed');
  assert.equal(platform.seen[0].body.messages[0].reasoning_content, 'r');
  assert.equal(first.seen.length, 0);
  assert.deepEqual(attempts(metrics), ['relay:boyue 400 upstream_error']);
});

test('a chain answers to its aliases and outranks a renaming route; with every source off it is as good as absent', { timeout: 20_000 }, async (t) => {
  const { first, platform, metrics, post, baseUrl, token, store, sourceId } = await chainRelay(t, {
    sources: ['first'],
    aliases: ['DeepSeek-V4.1-Flash'],
    routes: 'DeepSeek-V4.1-Flash=deepseek-v4-flash',
  });
  const models = async () => (await (await fetch(`${baseUrl}/relay/v1/models`, { headers: { authorization: `Bearer ${token}` } })).json()).data.map((entry) => entry.id);
  assert.deepEqual(await models(), ['deepseek-v4-flash', 'DeepSeek-V4.1-Flash']);
  assert.equal((await post({ model: 'DeepSeek-V4.1-Flash', messages: [] })).status, 200);
  assert.equal(first.seen[0].body.model, 'flash-at-first');
  assert.equal(metrics[0].model, 'deepseek-v4-flash', 'recorded under the one name the chain has');
  assert.equal(platform.seen.length, 0);

  // With every source off the name is the platform's again: refused while
  // it is not on the allowed list, forwarded there once it is.
  await store.setRelaySourceEnabled({ model: 'deepseek-v4-flash', sourceId: sourceId('first'), enabled: false });
  assert.equal((await post({ model: 'deepseek-v4-flash', messages: [] })).status, 403, 'not a model this console allows');
  assert.deepEqual(await models(), []);
  await store.setRelayModelAllowed({ model: 'deepseek-v4-flash', allowed: true });
  assert.equal((await post({ model: 'DeepSeek-V4.1-Flash', messages: [] })).status, 200, 'the route renames it as before');
  assert.equal(platform.seen.length, 1);
  assert.equal(first.seen.length, 1);
});

async function metricsStore(t) {
  const home = await mkdtemp(join(tmpdir(), 'relay-stats-'));
  const metrics = await new MetricsStore({ home, flushIntervalMs: 60_000 }).init();
  t.after(async () => {
    try {
      metrics.close();
    } catch {
      // Already closed by the console under test.
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return metrics;
}

function recordTurn(metrics, { alias, atMs, accountId = 'relay', model = 'deepseek-v4-flash', deviceId = 'device-1', status = 200, outcome = 'completed', ttfbMs = 1000, durationMs = 5000, input = 1000, cached = 9000, output = 400, stream = true }) {
  const usage = outcome === 'completed';
  assert.equal(metrics.enqueueRequest({
    startedAtMs: atMs,
    method: 'POST',
    path: '/v1/messages',
    deviceId,
    machineId: null,
    memberLabel: 'm',
    accountId,
    accountAlias: alias,
    model,
    stream,
    statusCode: status,
    outcome,
    ttfbMs: usage ? ttfbMs : null,
    durationMs,
    requestBytes: 10,
    responseBytes: 10,
    upstreamRequestId: null,
    inputTokens: usage ? input : null,
    cacheCreationInputTokens: usage ? 0 : null,
    cacheReadInputTokens: usage ? cached : null,
    outputTokens: usage ? output : null,
    usageState: usage ? 'complete' : 'unavailable',
  }), true);
}

test('source figures are read per window from recorded turns, and turns the gateway refused are left out', async (t) => {
  const metrics = await metricsStore(t);
  const nowMs = Date.UTC(2026, 10, 10, 6, 30);
  const minutes = (count) => nowMs - count * 60_000;
  // Five minutes ago: three streams of 400 tokens, generating for 2, 4 and 8 seconds.
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(5), ttfbMs: 1000, durationMs: 3000 });
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(5), ttfbMs: 2000, durationMs: 6000 });
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(5), ttfbMs: 3000, durationMs: 11000 });
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(40), status: 429, outcome: 'upstream_error', durationMs: 300 });
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(41), status: 200, outcome: 'upstream_error', durationMs: 900 });
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(42), status: null, outcome: 'client_disconnected', durationMs: 900 });
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(43), status: 403, outcome: 'model_blocked' });
  recordTurn(metrics, { alias: 'relay:tensoris', atMs: minutes(44), status: 429, outcome: 'rejected' });
  recordTurn(metrics, { alias: 'relay:boyue', atMs: minutes(300), deviceId: 'device-2', stream: false });
  recordTurn(metrics, { alias: 'relay:boyue', atMs: nowMs - 3 * DAY_MS, deviceId: 'device-2' });
  recordTurn(metrics, { alias: 'claude-1', accountId: 'account-1', atMs: minutes(5) });
  metrics.flush();

  assert.throws(() => metrics.queryRelayStats({}), /accountId/);
  const stats = metrics.queryRelayStats({ accountId: 'relay', nowMs });
  assert.deepEqual(stats.sources.map((source) => source.alias).sort(), ['relay:boyue', 'relay:tensoris']);
  const tensoris = stats.sources.find((source) => source.alias === 'relay:tensoris');
  const recent = tensoris.windows['15m'];
  assert.equal(recent.requests, 3);
  assert.equal(recent.failures, 0);
  assert.equal(recent.ttfb_p50_ms, 2000);
  assert.equal(recent.ttfb_p90_ms, 3000);
  assert.equal(recent.duration_p50_ms, 6000);
  assert.equal(recent.output_tokens_per_s, 100, 'the median of 200, 100 and 50 tokens a second');
  assert.deepEqual(recent.usage, [{ model: 'deepseek-v4-flash', hour_bucket_ms: Date.UTC(2026, 10, 10, 6), requests: 3, input_tokens: 3000, cache_read_tokens: 27000, output_tokens: 1200 }]);
  const hour = tensoris.windows['1h'];
  assert.equal(hour.requests, 6, 'refused by the gateway: never reached the source');
  assert.equal(hour.failures, 2);
  assert.equal(hour.disconnects, 1);
  assert.deepEqual(hour.failure_statuses, { 200: 1, 429: 1 });
  assert.equal(tensoris.last_request_at_ms, minutes(5));

  const boyue = stats.sources.find((source) => source.alias === 'relay:boyue');
  assert.equal(boyue.windows['1h'].requests, 0);
  assert.equal(boyue.windows['24h'].requests, 1);
  assert.equal(boyue.windows['24h'].output_tokens_per_s, null, 'not a stream: no speed');

  // Spend goes back as far as asked, by hour, source, model and device.
  assert.equal(stats.spend.length, 4);
  assert.equal(stats.spend.reduce((sum, row) => sum + row.requests, 0), 8);
  const narrow = metrics.queryRelayStats({ accountId: 'relay', nowMs, spendFromMs: nowMs - HOUR_MS });
  assert.deepEqual(narrow.spend.map((row) => row.account_alias), ['relay:tensoris', 'relay:tensoris']);
});

test('the kept reading re-reads only the hours that can still change, however long it was left', async () => {
  let clock = Date.UTC(2026, 10, 10, 6, 30);
  const asked = [];
  let answer = () => ({ now_ms: clock, sources: [{ alias: 'relay:boyue' }], spend: [] });
  const cache = createRelayStatsCache({
    query: async (params) => {
      asked.push(params);
      return answer(params);
    },
    now: () => clock,
  });
  const row = (hourMs, requests) => ({ hour_bucket_ms: hourMs, account_alias: 'relay:boyue', model: 'm', device_id: 'd', requests });
  const hourOf = (hours) => Date.UTC(2026, 10, 10, 6) - hours * HOUR_MS;

  answer = () => ({ now_ms: clock, sources: [], spend: [row(hourOf(0), 1), row(hourOf(1), 5), row(hourOf(200), 7), row(hourOf(719), 9)] });
  const first = await cache.read();
  assert.deepEqual(asked[0], { accountId: 'relay', nowMs: clock, spendFromMs: clock - 30 * DAY_MS });
  assert.equal(first.spend.length, 4);

  // Within a minute: shown as it is, nothing asked.
  clock += 30_000;
  await cache.read();
  assert.equal(asked.length, 1);

  // A few minutes old: shown as it is while a new one is fetched, which asks
  // only for the last hours and replaces exactly those.
  clock += 3 * 60_000;
  answer = () => ({ now_ms: clock, sources: [], spend: [row(hourOf(0), 2), row(hourOf(1), 6)] });
  const stale = await cache.read();
  assert.equal(stale.spend.find((entry) => entry.hour_bucket_ms === hourOf(0)).requests, 1);
  await cache.pending();
  assert.equal(asked[1].spendFromMs, hourOf(2), 'from two hours before the previous reading, on the hour');
  clock += 1000;
  const fresh = await cache.read();
  assert.deepEqual(
    fresh.spend.map((entry) => [entry.hour_bucket_ms, entry.requests]).sort((a, b) => a[0] - b[0]),
    [[hourOf(719), 9], [hourOf(200), 7], [hourOf(1), 6], [hourOf(0), 2]],
  );

  // Left alone for ten hours: the next reading is waited for, covers the gap,
  // and drops what has fallen out of the month.
  const previous = clock;
  clock += 10 * HOUR_MS;
  answer = () => ({ now_ms: clock, sources: [], spend: [row(hourOf(-10), 3)] });
  const later = await cache.read();
  assert.equal(asked[2].spendFromMs, Math.floor((previous - 1000 - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS);
  assert.deepEqual(
    later.spend.map((entry) => [entry.hour_bucket_ms, entry.requests]).sort((a, b) => a[0] - b[0]),
    [[hourOf(200), 7], [hourOf(-10), 3]],
    'the two re-read hours came back empty; the oldest hour is now older than a month',
  );

  // A reading that cannot be had keeps the last one; a failing one too.
  clock += 10 * 60_000;
  answer = () => null;
  assert.equal((await cache.read()).spend.length, 2);
  answer = () => { throw new Error('worker gone'); };
  assert.equal((await cache.read()).spend.length, 2);

  // The timer keeps it warm only while somebody has looked lately.
  const before = asked.length;
  cache.tick();
  await cache.pending();
  assert.equal(asked.length, before + 1);
  clock += 31 * 60_000;
  cache.tick();
  assert.equal(cache.pending(), null);
  assert.equal(asked.length, before + 1);
});

test('each source is priced at its own price and the platform balance is projected at the rate it is spent', () => {
  const chains = [{
    model: 'deepseek-v4-flash',
    aliases: ['DeepSeek-V4.1-Flash'],
    sources: [
      { id: 'aaaaaaaa', name: 'tensoris', kind: 'endpoint', enabled: true, upstream_model: 'flash-1017', min_balance_usd: null, price: { input_usd_per_m: 0.3, output_usd_per_m: 1, cached_input_usd_per_m: 0.03 } },
      { id: 'bbbbbbbb', name: 'direct', kind: 'endpoint', enabled: true, upstream_model: 'DeepSeek-V4.1-Flash', min_balance_usd: null, price: null },
      { id: 'cccccccc', name: 'boyue', kind: 'platform', enabled: true, upstream_model: 'deepseek-v4-flash', min_balance_usd: 500, price: null },
      { id: 'dddddddd', name: 'spare', kind: 'endpoint', enabled: false, upstream_model: 'x', min_balance_usd: null, price: null },
    ],
  }];
  const listed = { 'deepseek-v4-flash': { input_usd_per_m: 0.1, output_usd_per_m: 0.5, cached_input_usd_per_m: 0.01 }, 'kimi-k2.5': { input_usd_per_m: 1, output_usd_per_m: 2 } };
  const catalog = { row: (model) => listed[model] ?? null };
  const settings = { name: 'boyue' };
  const usage = (requests) => [{ model: 'deepseek-v4-flash', hour_bucket_ms: 0, requests, input_tokens: 1e6 * requests, cache_read_tokens: 10e6 * requests, output_tokens: 1e6 * requests }];
  const window = (requests, extra = {}) => ({ requests, failures: 0, disconnects: 0, failure_statuses: {}, ttfb_p50_ms: 1500, ttfb_p90_ms: 3000, duration_p50_ms: 9000, duration_p90_ms: 20000, output_tokens_per_s: 90, usage: usage(requests), ...extra });
  const stats = {
    now_ms: 1_000,
    sources: [
      { alias: 'relay:tensoris', last_request_at_ms: 900, windows: { '15m': window(1), '1h': window(2), '24h': window(12, { failures: 3, failure_statuses: { 429: 3 } }) } },
      { alias: 'relay:boyue', last_request_at_ms: 800, windows: { '15m': window(0, { usage: [] }), '1h': window(1), '24h': window(24) } },
      { alias: 'relay:direct', last_request_at_ms: 100, windows: { '15m': window(0, { usage: [] }), '1h': window(0, { usage: [] }), '24h': window(4) } },
      { alias: 'relay:elsewhere', last_request_at_ms: 100, windows: { '15m': window(0, { usage: [] }), '1h': window(0, { usage: [] }), '24h': window(1) } },
    ],
  };
  const sourceStates = new Map([
    ['aaaaaaaa', { configured: true, balance_low: false, cooling_until_ms: 5_000, last_failure: { status: 429 } }],
    ['cccccccc', { configured: true, balance_low: false, cooling_until_ms: null }],
  ]);
  const price = relayPricer({ chains, settings, catalog });
  assert.equal(price('relay:tensoris', 'deepseek-v4-flash').input_usd_per_m, 0.3);
  assert.equal(price('relay:direct', 'deepseek-v4-flash'), null, 'no price was given for it');
  assert.equal(price('relay:boyue', 'deepseek-v4-flash').input_usd_per_m, 0.1, 'the platform source at the list price of the model it asks for');
  assert.equal(price('relay:boyue', 'kimi-k2.5').input_usd_per_m, 0.1, 'whatever name the turn was recorded under');
  assert.equal(price('relay:elsewhere', 'deepseek-v4-flash'), null);
  assert.equal(relayPricer({ chains: [], settings, catalog })('relay:boyue', 'kimi-k2.5').input_usd_per_m, 1, 'outside a chain: the model named');

  const balance = { remaining_usd: 3170, burn_usd_per_hour: 54 };
  const day = summarizeRelaySources({ stats, window: '24h', chains, settings, catalog, balance, sourceStates });
  assert.equal(day.window, '24h');
  assert.equal(day.at_ms, 1_000);
  const [tensoris, direct, boyue, spare] = day.chains[0].sources;
  assert.deepEqual(day.chains[0].sources.map((row) => [row.order, row.name, row.first]), [[1, 'tensoris', false], [2, 'direct', true], [3, 'boyue', false], [4, 'spare', false]]);
  assert.equal(tensoris.state.cooling_until_ms, 5_000, 'resting: the next usable source is the first choice now');
  assert.equal(tensoris.error_rate, 0.25);
  assert.ok(Math.abs(tensoris.cost_usd - 12 * 1.6) < 1e-9);
  assert.ok(Math.abs(tensoris.usd_per_hour - 0.8) < 1e-9);
  assert.equal(direct.cost_usd, null);
  assert.equal(direct.usd_per_hour, null);
  assert.ok(Math.abs(boyue.cost_usd - 24 * 0.7) < 1e-9);
  assert.equal(spare.requests, 0);
  assert.equal(spare.state.enabled, false);
  assert.equal(tensoris.balance, null);
  assert.equal(boyue.balance.remaining_usd, 3170);
  assert.equal(boyue.balance.burn_estimated, false);
  assert.ok(Math.abs(boyue.balance.hours_left - 3170 / 54) < 1e-9);
  assert.ok(Math.abs(boyue.balance.hours_to_line - 2670 / 54) < 1e-9);
  assert.deepEqual(day.others.map((row) => row.name), ['elsewhere']);
  assert.equal(day.others[0].cost_usd, null);

  // Before the key's own counter has been watched long enough, the last
  // hour's estimate stands in for the rate.
  const hour = summarizeRelaySources({ stats, window: 'nonsense', chains, settings, catalog, balance: { remaining_usd: 400, burn_usd_per_hour: null }, sourceStates });
  assert.equal(hour.window, '1h');
  const early = hour.chains[0].sources[2].balance;
  assert.equal(early.burn_estimated, true);
  assert.ok(Math.abs(early.burn_usd_per_hour - 0.7) < 1e-9);
  assert.equal(early.hours_to_line, 0, 'already below the line');

  // Nothing measured and no chain: an empty table, not an error.
  const empty = summarizeRelaySources({ stats: null, chains: [], settings, catalog });
  assert.deepEqual([empty.chains, empty.others, empty.at_ms], [[], [], null]);

  const spend = summarizeRelaySpend({
    spend: [
      { hour_bucket_ms: 0, account_alias: 'relay:tensoris', model: 'deepseek-v4-flash', device_id: 'd1', requests: 2, input_tokens: 2e6, cache_read_tokens: 0, output_tokens: 0 },
      { hour_bucket_ms: 0, account_alias: 'relay:boyue', model: 'deepseek-v4-flash', device_id: 'd1', requests: 1, input_tokens: 1e6, cache_read_tokens: 1e6, output_tokens: 0 },
      { hour_bucket_ms: 0, account_alias: 'relay:direct', model: 'deepseek-v4-flash', device_id: 'd2', requests: 5, input_tokens: 9e6, cache_read_tokens: 0, output_tokens: 0 },
    ],
    price,
    describeDevice: (id) => `device ${id}`,
  });
  assert.equal(spend.models.length, 1);
  assert.equal(spend.models[0].requestCount, 8);
  assert.equal(spend.models[0].inputTokens, 12e6);
  assert.equal(spend.models[0].cachedTokens, 1e6);
  assert.ok(Math.abs(spend.models[0].costUsd - (0.6 + 0.11)) < 1e-9);
  assert.ok(Math.abs(spend.totalUsd - 0.71) < 1e-9);
  assert.deepEqual(spend.devices.map((row) => [row.label, row.costUsd === null]), [['device d1', false], ['device d2', true]]);
});

test('the page sets up a chain form by form and shows its sources with what was measured', { timeout: 30_000 }, async (t) => {
  const { store } = await newStore(t);
  const metrics = await metricsStore(t);
  const platform = await upstream(t);
  const own = await upstream(t);
  const account = await store.addAccount({ provider: 'claude', alias: 'claude-1', credential: { oauth_token: 'sk-ant-oat01-real' } });
  const issued = await store.issueDeviceCredential({ accountId: account.id, memberLabel: 'm', deviceName: 'laptop' });
  await store.setRelayPlatform({ name: 'boyue', baseUrl: `${platform.url}/v1`, apiKey: PLATFORM_KEY });
  await store.setRelayModelAllowed({ model: 'deepseek-v4-flash', allowed: true });
  const { createCredentialConsole } = await import('../server.js');
  // The page keeps a reading for a minute; the test's turns must not wait.
  let skewMs = 0;
  const created = await createCredentialConsole({
    relayStatsClock: () => Date.now() + skewMs,
    store,
    adminAuth: 'open',
    cookieSecure: false,
    publicBaseUrl: 'http://console.test',
    relayEnabled: true,
    relayCatalog: {
      snapshot: () => ({ rows: [], balance: { limit_usd: 20000, used_usd: 16830, remaining_usd: 3170, burn_usd_per_hour: 54, fetched_at: null }, fetched_at: null, error: null }),
      row: () => null,
      remainingUsd: () => 3170,
      refresh: async () => {},
      refreshBalance: async () => {},
      stop() {},
    },
    requestMetrics: metrics,
    metricsQueryService: false,
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  t.after(async () => {
    created.server.closeAllConnections?.();
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
    await store.serialized(async () => {});
  });

  const landing = await fetch(`${baseUrl}/relay`);
  const cookie = landing.headers.getSetCookie()[0].split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await landing.text())[1];
  const submit = async (path, body, { token = csrf } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...(token ? { csrf: token } : {}), ...body }),
    });
    return { status: response.status, location: response.headers.get('location') };
  };
  const page = async (query = '') => (await fetch(`${baseUrl}/relay${query}`, { headers: { Cookie: cookie } })).text();

  assert.equal((await submit('/relay/chain', { op: 'save', model: 'deepseek-v4-flash' }, { token: null })).status, 403);
  assert.deepEqual(await submit('/relay/chain', { op: 'save', model: 'deepseek-v4-flash', aliases: 'DeepSeek-V4.1-Flash' }), { status: 303, location: '/relay?chains=1#relay-chains' });
  const chain = { model: 'deepseek-v4-flash' };
  await submit('/relay/chain/source', { ...chain, op: 'save', name: 'own', kind: 'endpoint', base_url: `${own.url}/v1`, api_key: SOURCE_KEY, upstream_model: 'flash-at-own', input_usd_per_m: '0.278', output_usd_per_m: '1.111', cached_input_usd_per_m: '0.0278', first_byte_timeout_s: '30' });
  await submit('/relay/chain/source', { ...chain, op: 'save', name: 'boyue', kind: 'platform', upstream_model: 'deepseek-v4-flash', min_balance_usd: '500' });
  const ids = () => Object.fromEntries(store.relayChains()[0].sources.map((source) => [source.name, source.id]));
  assert.deepEqual(Object.keys(ids()), ['own', 'boyue']);

  const refused = await submit('/relay/chain/source', { ...chain, op: 'save', name: 'own', kind: 'platform', upstream_model: 'x' });
  assert.equal(refused.status, 303);
  assert.match(refused.location, /^\/relay\?chains=1&error=[^#]+#relay-chains$/);
  const complaint = await page(refused.location.slice('/relay'.length).split('#')[0]);
  assert.match(complaint, /<details open>\s*<summary data-i18n="relay-chains-heading">/);
  assert.match(complaint, /class="notice error">this chain already has a source named &quot;own&quot;/);
  assert.match((await submit('/relay/chain/source', { ...chain, op: 'sideways', source_id: ids().own })).location, /error=unknown%20action/);

  await submit('/relay/chain/source', { ...chain, op: 'down', source_id: ids().own });
  assert.deepEqual(Object.keys(ids()), ['boyue', 'own']);
  await submit('/relay/chain/source', { ...chain, op: 'up', source_id: ids().own });
  await submit('/relay/chain/source', { ...chain, op: 'disable', source_id: ids().boyue });
  assert.equal(store.relayChains()[0].sources[1].enabled, false);
  await submit('/relay/chain/source', { ...chain, op: 'enable', source_id: ids().boyue });

  // Turns through the gateway, by the chain's other name.
  const turn = () => fetch(`${baseUrl}/relay/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash', messages: [] }),
  });
  assert.equal((await turn()).status, 200);
  own.answer = (req, res) => answerJson(res, 502, { error: 'bad gateway' });
  assert.equal((await turn()).status, 200);
  assert.equal(own.seen.length, 2);
  assert.equal(own.seen[0].headers.authorization, `Bearer ${SOURCE_KEY}`);
  assert.equal(platform.seen.length, 1);

  skewMs = 6 * 60_000;
  const html = await page('?window=24h');
  assert.equal(html.includes(SOURCE_KEY), false);
  assert.equal(html.includes(PLATFORM_KEY), false);
  const table = /<table class="relay-sources">[\s\S]*?<\/table>/.exec(html)[0];
  const rows = table.split('<tr').slice(2);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /<strong>own<\/strong>/);
  assert.match(rows[0], /data-i18n="relay-src-cooling"/, 'it failed a moment ago');
  assert.match(rows[0], /502×1/);
  assert.match(rows[0], />50% </);
  assert.match(rows[1], /<strong>boyue<\/strong>/);
  assert.match(rows[1], /data-i18n="relay-src-first"/);
  assert.match(rows[1], /\$3,170/);
  assert.match(rows[1], /\$500/);
  assert.match(html, /href="\/relay\?window=24h#relay-sources"[^>]*class="relay-window active"|class="relay-window active"[^>]*href="\/relay\?window=24h#relay-sources"/);
  assert.match(html, /claude --model deepseek-v4-flash/);
  // Every cell holds one element, so the narrow layout can label it.
  for (const cell of table.split('<td').slice(1)) assert.match(cell, /^[^>]*>\s*<div[\s>]/);

  assert.equal((await submit('/relay/chain/source', { ...chain, op: 'delete', source_id: ids().own })).status, 303);
  assert.equal((await submit('/relay/chain', { op: 'delete', model: 'deepseek-v4-flash' })).status, 303);
  assert.deepEqual(store.relayChains(), []);
  // The sources that served turns are still shown, as ones outside any chain.
  skewMs = 12 * 60_000;
  assert.match(await page('?window=24h'), /data-i18n="relay-src-unchained"/);
});

test('the command line shows the chains without keys and replaces them from a file', { timeout: 30_000 }, async (t) => {
  const { home, store } = await newStore(t);
  await store.setRelayPlatform({ name: 'boyue', baseUrl: 'http://1.2.3.4:3888/v1', apiKey: PLATFORM_KEY });
  await store.serialized(async () => {});
  const run = (...args) => promisify(execFile)(process.execPath, [join(CONSOLE_DIR, 'cli.js'), ...args], {
    env: { ...process.env, CREDENTIAL_CONSOLE_HOME: home },
  });
  const keyFile = join(home, 'source.key');
  const chainsFile = join(home, 'chains.json');
  await writeFile(keyFile, `${SOURCE_KEY}\n`, { mode: 0o600 });
  const chains = [{
    model: 'deepseek-v4-flash',
    aliases: ['DeepSeek-V4.1-Flash'],
    sources: [
      { name: 'tensoris', kind: 'endpoint', base_url: 'https://api.example/v1', api_key_file: keyFile, upstream_model: 'flash-1017', price: { input_usd_per_m: 0.278, output_usd_per_m: 1.111, cached_input_usd_per_m: 0.0278 } },
      { name: 'direct', kind: 'endpoint', base_url: 'http://127.0.0.1:18540/v1', upstream_model: 'DeepSeek-V4.1-Flash', input_usd_per_m: 0, output_usd_per_m: 0, first_byte_timeout_s: 30 },
      { name: 'boyue', kind: 'platform', upstream_model: 'deepseek-v4-flash', min_balance_usd: 500 },
    ],
  }];
  await writeFile(chainsFile, JSON.stringify(chains));

  const imported = await run('relay-chain', 'import', chainsFile);
  assert.equal(imported.stdout.includes(SOURCE_KEY), false);
  const shown = JSON.parse((await run('relay-chain', 'show')).stdout);
  assert.deepEqual(shown[0].sources.map((source) => [source.name, source.has_key, source.enabled]), [['tensoris', true, true], ['direct', false, true], ['boyue', false, true]]);
  assert.equal(shown[0].sources[0].price.output_usd_per_m, 1.111);
  assert.equal(shown[0].sources[2].min_balance_usd, 500);
  const reopened = await new CredentialStore(home).init();
  const tensorisId = shown[0].sources[0].id;
  assert.equal(reopened.relaySourceApiKey('deepseek-v4-flash', tensorisId), SOURCE_KEY);
  assert.equal((await readFile(join(home, 'state.json'), 'utf8')).includes(SOURCE_KEY), false);

  // What `show` prints goes straight back in: same ids, the key kept, the
  // order and the switches as edited.
  const edited = [{ ...shown[0], sources: [shown[0].sources[1], { ...shown[0].sources[0], enabled: false }, shown[0].sources[2]] }];
  await writeFile(chainsFile, JSON.stringify({ chains: edited }));
  await run('relay-chain', 'import', chainsFile);
  const again = await new CredentialStore(home).init();
  assert.deepEqual(again.relayChains()[0].sources.map((source) => [source.name, source.id === tensorisId, source.enabled]), [['direct', false, true], ['tensoris', true, false], ['boyue', false, true]]);
  assert.equal(again.relaySourceApiKey('deepseek-v4-flash', tensorisId), SOURCE_KEY);

  await writeFile(chainsFile, JSON.stringify([{ model: 'deepseek-v4-flash', sources: [{ name: 'a', kind: 'endpoint', upstream_model: 'm' }] }]));
  await assert.rejects(run('relay-chain', 'import', chainsFile), /valid http\(s\) address/);
  await assert.rejects(run('relay-chain', 'import'), /usage:/);
  assert.equal((await new CredentialStore(home).init()).relayChains()[0].sources.length, 3, 'a refused file changes nothing');
});
