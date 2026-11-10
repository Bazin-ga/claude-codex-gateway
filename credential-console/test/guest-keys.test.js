import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeProxy } from '../lib/proxy.js';
import { handleCodexProxy } from '../lib/codex-proxy.js';
import { CredentialStore } from '../lib/store.js';
import { QuotaExhaustion } from '../lib/account-failover.js';
import { ClaudeQuotaSignal } from '../lib/claude-quota-signal.js';
import { CodexQuotaSignal } from '../lib/codex-quota-signal.js';
import { accountUsableByDevice } from '../lib/account-restriction.js';
import {
  CLAUDE_UNPRICED_FALLBACK,
  claudeApiCostMicroUsd,
  claudeApiPrice,
  claudePricedModelName,
} from '../lib/claude-api-pricing.js';
import {
  GUEST_CLAUDE_USAGE_LIMITS,
  chargeGuestRequest,
  formatMicroUsd,
  guestBudgetMessage,
  guestCostMicroUsd,
  guestMachineId,
  isGuestDevice,
  parseUsdAmount,
} from '../lib/guest-keys.js';
import { createResponseUsageParser } from '../lib/response-usage.js';
import { createCredentialConsole } from '../server.js';

const PASSWORD = 'correct horse battery';
const USD = 1_000_000;

// --- the price list ---------------------------------------------------------

test('a Claude request is priced like the Messages API prices it', () => {
  // Opus 5.5: $4 in, $5 / $8 cache write (5 min / 1 h), $0.20 cache read, $20 out.
  assert.deepEqual(claudeApiCostMicroUsd('claude-opus-5-5', {
    input: 1000,
    cacheWrite5m: 1000,
    cacheWrite1h: 2000,
    cacheRead: 20_000,
    output: 500,
  }), { microUsd: 4000 + 5000 + 16_000 + 4000 + 10_000, priced: true });
  // A fraction of a micro-dollar is rounded up, never down to free.
  assert.deepEqual(claudeApiCostMicroUsd('claude-haiku-5-5', { cacheRead: 1 }), { microUsd: 1, priced: true });
  assert.deepEqual(claudeApiCostMicroUsd('claude-opus-5-5', {}), { microUsd: 0, priced: true });
  // Garbage counts are nothing, not NaN.
  assert.deepEqual(
    claudeApiCostMicroUsd('claude-opus-5-5', { input: -5, output: null, cacheRead: 1.5, cacheWrite5m: 'x' }),
    { microUsd: 0, priced: true },
  );
});

test('a model is priced by the name it snapshots, whatever is wrapped around it', () => {
  assert.equal(claudePricedModelName('Claude-Opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(claudePricedModelName('us.anthropic.claude-sonnet-5-5-20261001-v1:0'), 'claude-sonnet-5-5-20261001-v1:0');
  assert.equal(claudeApiPrice('claude-opus-5-5[1m]'), claudeApiPrice('claude-opus-5-5'));
  assert.equal(claudeApiPrice('claude-haiku-4-5-20251001'), claudeApiPrice('claude-haiku-4-5'));
  assert.equal(claudeApiPrice('claude-opus-4-1-20250805').short.input, 15, 'Opus 4.1, not Opus 4 by a shorter prefix');
  assert.notEqual(claudeApiPrice('claude-opus-5-5-20261001'), claudeApiPrice('claude-opus-5'));
  assert.equal(claudeApiPrice('claude-opus-55'), null, 'a prefix match stops at a hyphen');
  assert.equal(claudeApiPrice(''), null);
  assert.equal(claudeApiPrice(null), null);
});

test('Haiku 5.5 bills the whole request at the long-prompt rate above 100k', () => {
  const short = claudeApiCostMicroUsd('claude-haiku-5-5', { input: 100_000, output: 1000 });
  assert.equal(short.microUsd, 100_000 * 0.10 + 1000 * 0.50);
  const long = claudeApiCostMicroUsd('claude-haiku-5-5', { input: 60_000, cacheRead: 40_001, output: 1000 });
  assert.equal(long.microUsd, Math.ceil(60_000 * 0.50 + 40_001 * 0.05 + 1000 * 2.50));
});

test('a model nobody priced is charged the dearest rate, and says so', () => {
  const cost = claudeApiCostMicroUsd('claude-nova-9', { input: 1000, output: 1000 });
  assert.equal(cost.priced, false);
  assert.equal(cost.microUsd, 1000 * CLAUDE_UNPRICED_FALLBACK.short.input + 1000 * CLAUDE_UNPRICED_FALLBACK.short.output);
  assert.equal(cost.microUsd, 90_000);
});

// --- the arithmetic ---------------------------------------------------------

test('a dollar amount from a form is exact micro-dollars or refused', () => {
  assert.equal(parseUsdAmount('20'), 20 * USD);
  assert.equal(parseUsdAmount(' $2.50 '), 2_500_000);
  assert.equal(parseUsdAmount('0.000001'), 1);
  assert.equal(parseUsdAmount('1000000'), 1_000_000 * USD);
  for (const value of ['', '0', '0.00', '-5', '1e3', '1,000', '2.5.0', 'abc', '.5', '5.', '0.0000001', '1000001', '99999999', undefined, null]) {
    assert.throws(() => parseUsdAmount(value), Error, String(value));
  }
});

test('micro-dollars are shown as dollars, with more digits when small', () => {
  assert.equal(formatMicroUsd(12_340_000), '$12.34');
  assert.equal(formatMicroUsd(39_000), '$0.0390');
  assert.equal(formatMicroUsd(0), '$0.00');
  assert.equal(formatMicroUsd(undefined), '$0.00');
});

test('a Claude answer is costed from its usage, the 1-hour cache write apart', () => {
  const snapshot = {
    inputTokens: 1000,
    cacheCreationInputTokens: 3000,
    cacheReadInputTokens: 20_000,
    outputTokens: 500,
    usageState: 'complete',
    bytesSeen: 4_000_000,
  };
  assert.deepEqual(
    guestCostMicroUsd({
      provider: 'claude',
      model: 'claude-opus-5-5',
      snapshot,
      cacheDetail: { ephemeral5mInputTokens: 1000, ephemeral1hInputTokens: 2000 },
    }),
    { microUsd: 39_000, priced: true, estimated: false },
  );
  // No split reported: all of the write is the cheaper five-minute kind.
  assert.equal(
    guestCostMicroUsd({ provider: 'claude', model: 'claude-opus-5-5', snapshot }).microUsd,
    4000 + 15_000 + 4000 + 10_000,
  );
  // A split larger than the write is not believed past the write.
  assert.equal(
    guestCostMicroUsd({
      provider: 'claude',
      model: 'claude-opus-5-5',
      snapshot,
      cacheDetail: { ephemeral1hInputTokens: 9_999_999 },
    }).microUsd,
    4000 + 24_000 + 4000 + 10_000,
  );
});

test('a Claude answer cut off before its final count is charged for what had streamed', () => {
  const partial = {
    inputTokens: 1000,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: 1,
    usageState: 'partial',
    bytesSeen: 40_000,
  };
  const cost = guestCostMicroUsd({ provider: 'claude', model: 'claude-opus-5-5', snapshot: partial });
  assert.equal(cost.estimated, true);
  assert.equal(cost.microUsd, 1000 * 4 + 1000 * 20, 'forty streamed bytes stand for one output token');
  // Never more than a model can write in one answer.
  const huge = guestCostMicroUsd({
    provider: 'claude',
    model: 'claude-opus-5-5',
    snapshot: { ...partial, bytesSeen: 500_000_000 },
  });
  assert.equal(huge.microUsd, 1000 * 4 + 128_000 * 20);
  // A count that is already larger than the guess is kept.
  const known = guestCostMicroUsd({
    provider: 'claude',
    model: 'claude-opus-5-5',
    snapshot: { ...partial, outputTokens: 5000 },
  });
  assert.deepEqual(known, { microUsd: 1000 * 4 + 5000 * 20, priced: true, estimated: false });
  // Nothing at all came back: nothing is charged.
  assert.equal(guestCostMicroUsd({ provider: 'claude', model: 'claude-opus-5-5', snapshot: null }).microUsd, 0);
});

test('a Codex turn is costed at the OpenAI list price, long context and unknown models included', () => {
  const snapshot = { inputTokens: 100, cacheCreationInputTokens: null, cacheReadInputTokens: 900, outputTokens: 42, usageState: 'complete' };
  assert.deepEqual(
    guestCostMicroUsd({ provider: 'codex', model: 'gpt-6-luna', snapshot }),
    { microUsd: 10 + 9 + 21, priced: true, estimated: false },
  );
  const long = guestCostMicroUsd({
    provider: 'codex',
    model: 'gpt-6-sol',
    snapshot: { inputTokens: 200_000, cacheReadInputTokens: 100_000, outputTokens: 1000 },
  });
  assert.equal(long.microUsd, 200_000 * 4 + 100_000 * 0.4 + 1000 * 15);
  const unknown = guestCostMicroUsd({ provider: 'codex', model: 'gpt-9-mystery', snapshot });
  assert.equal(unknown.priced, false);
  assert.equal(unknown.microUsd, 100 * 10 + 900 * 1 + 42 * 50, 'the dearest model on the list');
  // A turn that reported no usage costs nothing and is never estimated.
  assert.deepEqual(
    guestCostMicroUsd({ provider: 'codex', model: 'gpt-6-luna', snapshot: { usageState: 'unavailable', bytesSeen: 90_000 } }),
    { microUsd: 0, priced: true, estimated: false },
  );
});

test('the refusal is in both languages and tells a spent key from a revoked one', () => {
  const spent = guestBudgetMessage({ name: 'alice', budgetMicroUsd: 20 * USD });
  assert.match(spent, /Guest key "alice" has used up its \$20\.00 allowance/);
  assert.match(spent, /访客 Key「alice」的 \$20\.00 额度已用完/);
  const revoked = guestBudgetMessage({ name: 'alice', budgetMicroUsd: 20 * USD, revoked: true });
  assert.match(revoked, /has been revoked/);
  assert.match(revoked, /已被吊销/);
});

test('charging never throws at the proxy and ignores ordinary devices', () => {
  const calls = [];
  const store = { chargeGuestKey: (id, charge) => calls.push({ id, ...charge }) };
  const parser = { snapshot: () => ({ inputTokens: 1000, outputTokens: 100, usageState: 'complete' }) };
  assert.equal(chargeGuestRequest({ store, device: { id: 'd1' }, provider: 'claude', model: 'claude-opus-5-5', parser }), null);
  assert.equal(chargeGuestRequest({ store, device: { id: 'd1', guest_key_id: 'k1' }, provider: 'claude', model: 'claude-opus-5-5', parser: null }), null);
  assert.deepEqual(calls, []);

  const logged = [];
  const cost = chargeGuestRequest({
    store,
    device: { id: 'd1', guest_key_id: 'k1' },
    provider: 'claude',
    model: 'claude-nova-9',
    parser,
    log: (event, fields) => logged.push({ event, ...fields }),
  });
  assert.equal(cost.microUsd, 1000 * 15 + 100 * 75);
  assert.deepEqual(calls, [{ id: 'k1', provider: 'claude', microUsd: 22_500 }]);
  assert.equal(logged[0].event, 'guest_key_charge_approximate');
  assert.equal(logged[0].priced, false);

  const failing = { chargeGuestKey: () => { throw new Error('disk'); } };
  assert.equal(chargeGuestRequest({
    store: failing,
    device: { id: 'd1', guest_key_id: 'k1' },
    provider: 'claude',
    model: 'claude-opus-5-5',
    parser,
    log: (event) => logged.push({ event }),
  }), null);
  assert.equal(logged.at(-1).event, 'guest_key_charge_failed');
});

// --- the usage parser -------------------------------------------------------

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function claudeStream({ input = 1000, write5m = 1000, write1h = 2000, cacheRead = 20_000, output = 500, complete = true } = {}) {
  const usage = (outputTokens) => ({
    input_tokens: input,
    cache_creation_input_tokens: write5m + write1h,
    cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
    output_tokens: outputTokens,
  });
  const events = [
    sseEvent('message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: usage(1) } }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ];
  if (complete) {
    events.push(
      sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage(output) }),
      sseEvent('message_stop', { type: 'message_stop' }),
    );
  }
  return events.join('');
}

test('the usage parser reports the cache write by lifetime without changing its snapshot', () => {
  const parser = createResponseUsageParser({ format: 'sse', ...GUEST_CLAUDE_USAGE_LIMITS });
  parser.push(Buffer.from(claudeStream()));
  const snapshot = parser.finish();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'bytesSeen', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'completeness', 'eventsSeen',
    'inputTokens', 'outputTokens', 'parseState', 'usageState',
  ]);
  assert.equal(snapshot.cacheCreationInputTokens, 3000);
  assert.equal(snapshot.outputTokens, 500);
  assert.equal(snapshot.usageState, 'complete');
  assert.deepEqual(parser.cacheCreationDetail(), { ephemeral5mInputTokens: 1000, ephemeral1hInputTokens: 2000 });

  // A response that says nothing about lifetimes, or says nonsense, has none.
  const plain = createResponseUsageParser({ format: 'json' });
  plain.push(Buffer.from(JSON.stringify({
    id: 'msg',
    content: [],
    usage: { input_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 0, output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: -3, ephemeral_5m_input_tokens: 'x' } },
  })));
  assert.equal(plain.finish().usageState, 'complete', 'a bad detail never spoils the counts');
  assert.deepEqual(plain.cacheCreationDetail(), { ephemeral5mInputTokens: null, ephemeral1hInputTokens: null });
});

test('a guest answer is read to its last event where an ordinary one stops counting', () => {
  // 10,000 small events: past the ordinary 8,192-event limit.
  const body = [
    sseEvent('message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }),
    ...Array.from({ length: 10_000 }, () => sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4321 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
  const ordinary = createResponseUsageParser({ format: 'sse' });
  ordinary.push(Buffer.from(body));
  assert.notEqual(ordinary.finish().usageState, 'complete');
  const guest = createResponseUsageParser({ format: 'sse', ...GUEST_CLAUDE_USAGE_LIMITS });
  guest.push(Buffer.from(body));
  const snapshot = guest.finish();
  assert.equal(snapshot.usageState, 'complete');
  assert.equal(snapshot.outputTokens, 4321);
});

// --- the store --------------------------------------------------------------

async function codexHome(root, name) {
  const home = join(root, name);
  await mkdir(join(home, 'public'), { recursive: true });
  await writeFile(join(home, 'public', 'current.json'), JSON.stringify({
    access_token: `access-${name}`,
    account_id: `chatgpt-${name}`,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  return home;
}

/**
 * Two Claude and two Codex subscription accounts, the first of each in the
 * guest pool, plus one member device on the shared Claude account.
 */
async function fleet(t) {
  const root = await mkdtemp(join(tmpdir(), 'credential-console-guest-'));
  const home = join(root, 'console');
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  // Spend still waiting for its timer is written before the directory goes.
  t?.after(async () => {
    await store.flushGuestSpend().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const accounts = {
    claudeGuest: await store.addAccount({ provider: 'claude', alias: 'claude-guest', credential: { oauth_token: 'token-guest' } }),
    claudeTeam: await store.addAccount({ provider: 'claude', alias: 'claude-team', credential: { oauth_token: 'token-team' } }),
    codexGuest: await store.addAccount({ provider: 'codex', alias: 'codex-guest', external: { kind: 'codex-credential', home: await codexHome(root, 'guest') } }),
    codexTeam: await store.addAccount({ provider: 'codex', alias: 'codex-team', external: { kind: 'codex-credential', home: await codexHome(root, 'team') } }),
  };
  await store.setAccountGuestPool(accounts.claudeGuest.id, { enabled: true, actor: 'test' });
  await store.setAccountGuestPool(accounts.codexGuest.id, { enabled: true, actor: 'test' });
  const member = await store.issueDeviceCredential({
    accountId: accounts.claudeTeam.id,
    memberLabel: 'member@example.com',
    deviceName: 'member-laptop',
    machineId: 'machine-aaaaaaaaaaaaaaaa',
  });
  return { root, home, store, accounts, member };
}

async function issue(store, accounts, { name = 'alice', budgetMicroUsd = 20 * USD, providers = ['claude', 'codex'], note = '' } = {}) {
  const accountIds = {};
  if (providers.includes('claude')) accountIds.claude = accounts.claudeGuest.id;
  if (providers.includes('codex')) accountIds.codex = accounts.codexGuest.id;
  return store.createGuestKey({ name, budgetMicroUsd, accountIds, note, actor: 'admin' });
}

test('a guest key is one secret over one device per provider, on pool accounts only', async (t) => {
  const { home, store, accounts } = await fleet(t);
  const { key, token } = await issue(store, accounts, { note: 'trial for Acme' });

  assert.match(token, /^sk-ant-api03-/);
  assert.equal(key.budget_micro_usd, 20 * USD);
  assert.equal(key.spent_micro_usd, 0);
  assert.equal(key.note, 'trial for Acme');
  assert.equal(key.created_by, 'admin');
  assert.deepEqual(Object.keys(key.devices), ['claude', 'codex']);
  assert.equal(key.devices.claude.home_account_id, accounts.claudeGuest.id);
  assert.equal(key.devices.codex.account_id, accounts.codexGuest.id);

  const claude = store.deviceByToken(token, 'claude');
  const codex = store.deviceByToken(token, 'codex');
  assert.equal(claude.id, key.devices.claude.device_id);
  assert.equal(codex.id, key.devices.codex.device_id);
  assert.ok(isGuestDevice(claude) && isGuestDevice(codex));
  assert.equal(claude.member_label, 'guest:alice');
  assert.equal(claude.name, 'alice');
  assert.equal(claude.machine_id, guestMachineId(key.id));
  assert.equal(claude.machine_id, codex.machine_id, 'one guest is one machine');
  assert.equal(claude.account_id, accounts.claudeGuest.id);

  // No other route knows a guest key: they look tokens up without a provider.
  assert.equal(store.deviceByToken(token), null);
  assert.equal(store.deviceByToken(token, 'bedrock'), null);
  assert.equal(store.deviceByToken(token, 'relay'), null);
  assert.equal(store.deviceByToken('sk-ant-api03-not-a-key', 'claude'), null);

  // Only the digest is kept, and the key survives a restart.
  const raw = await readFile(join(home, 'state.json'), 'utf8').catch(() => null);
  if (raw !== null) assert.equal(raw.includes(token), false, 'the secret is never written');
  const reopened = await new CredentialStore(home).init();
  assert.equal(reopened.deviceByToken(token, 'codex').id, codex.id);
  assert.equal(reopened.publicGuestKeys()[0].name, 'alice');

  const audit = store.state.audit.filter((entry) => entry.event === 'guest_key_created');
  assert.equal(audit.length, 1);
  assert.equal(JSON.stringify(audit).includes(token), false);
});

test('a key is refused when its name, allowance or accounts are not acceptable', async (t) => {
  const { store, accounts } = await fleet(t);
  const base = { name: 'bob', budgetMicroUsd: USD, accountIds: { claude: accounts.claudeGuest.id }, actor: 'admin' };
  await assert.rejects(store.createGuestKey({ ...base, name: 'has space' }), /1-64 letters/);
  await assert.rejects(store.createGuestKey({ ...base, name: '' }), /1-64 letters/);
  await assert.rejects(store.createGuestKey({ ...base, budgetMicroUsd: 0 }), /more than zero/);
  await assert.rejects(store.createGuestKey({ ...base, budgetMicroUsd: 1.5 }), /more than zero/);
  await assert.rejects(store.createGuestKey({ ...base, accountIds: {} }), /at least one account/);
  await assert.rejects(store.createGuestKey({ ...base, accountIds: { claude: accounts.claudeTeam.id } }), /claude-team is not open to guest keys/);
  await assert.rejects(store.createGuestKey({ ...base, accountIds: { claude: accounts.codexGuest.id } }), /claude account not found/);
  await assert.rejects(store.createGuestKey({ ...base, accountIds: { codex: 'nope' } }), /codex account not found/);
  assert.deepEqual(store.publicGuestKeys(), [], 'a refused key leaves nothing behind');
  assert.equal(store.state.devices.filter(isGuestDevice).length, 0);

  await store.createGuestKey(base);
  await assert.rejects(store.createGuestKey(base), /already has this name/);
  // A revoked key's name is free again.
  await store.revokeGuestKey(store.publicGuestKeys()[0].id, { actor: 'admin' });
  const again = await store.createGuestKey(base);
  assert.deepEqual(Object.keys(again.key.devices), ['claude'], 'a provider left out is one the key cannot use');
  assert.equal(store.deviceByToken(again.token, 'codex'), null);
});

test('only subscription accounts join the pool, and one in use cannot leave it', async (t) => {
  const { store, accounts } = await fleet(t);
  const apiKey = await store.addAccount({ provider: 'codex', alias: 'codex-api', codexApiKey: 'sk-proj-test-0000000000000000000000000000' });
  await assert.rejects(store.setAccountGuestPool(apiKey.id, { enabled: true, actor: 'admin' }), /only Claude and Codex subscription accounts/);
  await assert.rejects(store.setAccountGuestPool('missing', { enabled: true }), /account not found/);

  const listed = Object.fromEntries(store.publicAccounts().map((account) => [account.alias, account.guest_pool]));
  assert.deepEqual(listed, { 'claude-guest': true, 'claude-team': false, 'codex-guest': true, 'codex-team': false, 'codex-api': false });

  const { key } = await issue(store, accounts);
  await assert.rejects(store.setAccountGuestPool(accounts.claudeGuest.id, { enabled: false, actor: 'admin' }), /revoke them first/);
  await store.revokeGuestKey(key.id, { actor: 'admin' });
  await store.setAccountGuestPool(accounts.claudeGuest.id, { enabled: false, actor: 'admin' });
  assert.equal(store.publicAccounts().find((account) => account.alias === 'claude-guest').guest_pool, false);
  assert.equal(store.state.audit.filter((entry) => entry.event === 'account_guest_pool_updated').length, 3);
});

test('a private pool account takes guests and its listed machines, nobody else', async (t) => {
  const { store, accounts, member } = await fleet(t);
  const { token } = await issue(store, accounts);
  const guest = store.deviceByToken(token, 'claude');

  // Made private with no machines listed: the guest already on it stays.
  const plan = store.accountRestrictionPlan(accounts.claudeGuest.id, { enabled: true, machineIds: [] });
  assert.deepEqual(plan.affected, [], 'guest devices are not asked to move');
  await store.setAccountRestriction(accounts.claudeGuest.id, { enabled: true, machineIds: [], actor: 'admin' });

  const account = store.accountById(accounts.claudeGuest.id);
  assert.equal(accountUsableByDevice(account, guest), true);
  assert.equal(accountUsableByDevice(account, member.device), false);
  // The same private account outside the pool admits no guest.
  assert.equal(accountUsableByDevice({ ...account, guest_pool: { enabled: false } }, guest), false);
  // A shared account takes a guest only as anyone's backup, never as a home.
  assert.equal(accountUsableByDevice(store.accountById(accounts.claudeTeam.id), guest), true);

  // New keys can still be issued on the private pool account.
  const second = await issue(store, accounts, { name: 'bob', providers: ['claude'] });
  assert.equal(store.deviceByToken(second.token, 'claude').account_id, accounts.claudeGuest.id);
});

test('spend is counted at once, written shortly after, and survives a restart', async (t) => {
  const { home, store, accounts } = await fleet(t);
  const { key, token } = await issue(store, accounts, { budgetMicroUsd: 100_000 });
  const device = store.deviceByToken(token, 'claude');
  assert.equal(store.guestKeyBudget(store.state.devices[0]), null, 'an ordinary device has no allowance');
  assert.deepEqual(store.guestKeyBudget(device), {
    id: key.id, name: 'alice', budgetMicroUsd: 100_000, spentMicroUsd: 0, revoked: false, exhausted: false,
  });

  store.chargeGuestKey(key.id, { provider: 'claude', microUsd: 39_000 });
  store.chargeGuestKey(key.id, { provider: 'codex', microUsd: 40 });
  store.chargeGuestKey(key.id, { provider: 'codex', microUsd: -7 });
  store.chargeGuestKey(key.id, { provider: 'bedrock', microUsd: 1_000_000 });
  assert.equal(store.chargeGuestKey('missing', { provider: 'claude', microUsd: 5 }), null);
  assert.equal(store.guestKeyBudget(device).spentMicroUsd, 39_040, 'the next check sees it immediately');
  assert.equal(store.guestKeyBudget(device).exhausted, false);

  await store.flushGuestSpend();
  await store.flushGuestSpend();
  const reopened = await new CredentialStore(home).init();
  const [saved] = reopened.publicGuestKeys();
  assert.equal(saved.spent_micro_usd, 39_040);
  assert.deepEqual(saved.spent_by_provider, { claude: 39_000, codex: 40 });
  assert.equal(saved.requests, 3);
  assert.ok(saved.last_charged_at);

  store.chargeGuestKey(key.id, { provider: 'claude', microUsd: 60_960 });
  assert.equal(store.guestKeyBudget(device).exhausted, true, 'spent up to the allowance is spent');
  await store.flushGuestSpend();
});

test('a top-up adds to the allowance, and a revoked key is gone for good', async (t) => {
  const { store, accounts } = await fleet(t);
  const { key, token } = await issue(store, accounts, { budgetMicroUsd: USD });
  store.chargeGuestKey(key.id, { provider: 'claude', microUsd: USD });
  const device = store.deviceByToken(token, 'claude');
  assert.equal(store.guestKeyBudget(device).exhausted, true);

  await assert.rejects(store.topUpGuestKey(key.id, { microUsd: 0, actor: 'admin' }), /more than zero/);
  await assert.rejects(store.topUpGuestKey('missing', { microUsd: USD, actor: 'admin' }), /guest key not found/);
  const topped = await store.topUpGuestKey(key.id, { microUsd: 5 * USD, actor: 'admin' });
  assert.equal(topped.budget_micro_usd, 6 * USD);
  assert.equal(topped.spent_micro_usd, USD, 'the spend so far is untouched');
  assert.equal(topped.topups.length, 1);
  assert.equal(topped.topups[0].micro_usd, 5 * USD);
  assert.equal(topped.topups[0].by, 'admin');
  assert.equal(store.guestKeyBudget(device).exhausted, false);

  const revoked = await store.revokeGuestKey(key.id, { actor: 'admin' });
  assert.ok(revoked.revoked_at);
  assert.equal(revoked.revoked_by, 'admin');
  assert.equal(store.deviceByToken(token, 'claude'), null);
  assert.equal(store.deviceByToken(token, 'codex'), null);
  assert.equal(store.guestKeyBudget(device).revoked, true);
  assert.equal(store.guestKeyBudget(device).exhausted, true);
  assert.ok(store.state.devices.filter(isGuestDevice).every((entry) => entry.revoked_at));
  await assert.rejects(store.topUpGuestKey(key.id, { microUsd: USD, actor: 'admin' }), /revoked/);
  // Revoking twice is harmless, and what was in flight is still counted.
  await store.revokeGuestKey(key.id, { actor: 'admin' });
  store.chargeGuestKey(key.id, { provider: 'claude', microUsd: 10 });
  assert.equal(store.publicGuestKeys()[0].spent_micro_usd, USD + 10);
  assert.deepEqual(
    store.state.audit.map((entry) => entry.event).filter((event) => event.startsWith('guest_key_')),
    ['guest_key_created', 'guest_key_topped_up', 'guest_key_revoked'],
  );
  await store.flushGuestSpend();
});

test('nothing but the two subscription proxies looks a token up as a guest key', async () => {
  const lib = new URL('../lib/', import.meta.url);
  const files = [
    ...(await readdir(lib)).filter((name) => name.endsWith('.js')).map((name) => new URL(name, lib)),
    new URL('../server.js', import.meta.url),
  ];
  const withProvider = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\.deviceByToken\(([^)]*)\)/g)) {
      if (match[1].includes(',')) withProvider.push(`${file.pathname.split('/').at(-1)}: ${match[1]}`);
    }
  }
  assert.deepEqual(withProvider.sort(), ["codex-proxy.js: token, 'codex'", "proxy.js: token, 'claude'"]);
});

// --- the gateways -----------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function post(url, headers, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(url), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(body);
  });
}

/** Both proxies in front of one fake upstream; `answer(req, res)` writes the reply. */
async function gateways(t, { store, answer, relay = null }) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      seen.push({ path: req.url, authorization: String(req.headers.authorization ?? '') });
      answer(req, res);
    });
  });
  const upstreamUrl = await listen(upstream);
  const exhaustion = new QuotaExhaustion();
  const failed = (res) => (error) => {
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy(error);
  };
  const claude = http.createServer((req, res) => {
    Promise.resolve(handleClaudeProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      exhaustion,
      quotaSignal: new ClaudeQuotaSignal(),
      relay,
    })).catch(failed(res));
  });
  const codex = http.createServer((req, res) => {
    Promise.resolve(handleCodexProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      openaiApiBaseUrl: `${upstreamUrl}/v1`,
      exhaustion,
      quotaSignal: new CodexQuotaSignal(),
      relay,
    })).catch(failed(res));
  });
  const [claudeUrl, codexUrl] = await Promise.all([listen(claude), listen(codex)]);
  t.after(async () => {
    for (const server of [upstream, claude, codex]) server.closeAllConnections?.();
    await Promise.all([close(claude), close(codex), close(upstream)]);
  });
  return {
    seen,
    messages: (token, { model = 'claude-opus-5-5', path = '/claude/v1/messages' } = {}) => post(
      `${claudeUrl}${path}`,
      { 'X-Api-Key': token },
      { model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    ),
    responses: (token, { model = 'gpt-6-luna' } = {}) => post(
      `${codexUrl}/codex-api/responses`,
      { Authorization: `Bearer ${token}` },
      { model, instructions: 'x', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true, store: false },
    ),
  };
}

const CODEX_TURN = `data: ${JSON.stringify({
  type: 'response.completed',
  response: { id: 'r1', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 42 } },
})}\n\n`;

function answerBoth(req, res) {
  if (req.url.includes('/messages')) {
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 9 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(claudeStream());
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(CODEX_TURN);
}

/** The charge is made as the response ends; give the proxy a turn to get there. */
async function spent(store, keyId, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const key = store.publicGuestKeys().find((entry) => entry.id === keyId);
    if (key.spent_micro_usd === expected) return key;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.publicGuestKeys().find((entry) => entry.id === keyId);
}

test('a guest is charged list price for every answer on either gateway', { timeout: 20_000 }, async (t) => {
  const { store, accounts, member } = await fleet(t);
  const { key, token } = await issue(store, accounts);
  const gateway = await gateways(t, { store, answer: answerBoth });

  const claude = await gateway.messages(token);
  assert.equal(claude.status, 200);
  assert.match(claude.text, /message_stop/, 'the answer reaches the guest untouched');
  assert.equal((await spent(store, key.id, 39_000)).spent_micro_usd, 39_000);

  const codex = await gateway.responses(token);
  assert.equal(codex.status, 200);
  assert.match(codex.text, /response\.completed/);
  const after = await spent(store, key.id, 39_040);
  assert.equal(after.spent_micro_usd, 39_040);
  assert.deepEqual(after.spent_by_provider, { claude: 39_000, codex: 40 });
  assert.equal(after.requests, 2);

  // Each provider's request went out on that provider's pool account.
  assert.deepEqual(gateway.seen.map((entry) => entry.authorization), ['Bearer token-guest', 'Bearer access-guest']);

  // Counting tokens is free, and a member's request never touches a key.
  const counted = await gateway.messages(token, { path: '/claude/v1/messages/count_tokens' });
  assert.equal(counted.status, 200);
  assert.equal((await gateway.messages(member.token)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.publicGuestKeys()[0].spent_micro_usd, 39_040);
  assert.equal(store.publicGuestKeys()[0].requests, 2);
});

test('a spent allowance is refused before anything is sent, until it is topped up', { timeout: 20_000 }, async (t) => {
  const { store, accounts } = await fleet(t);
  const { key, token } = await issue(store, accounts, { budgetMicroUsd: 50_000 });
  const gateway = await gateways(t, { store, answer: answerBoth });

  assert.equal((await gateway.messages(token)).status, 200);
  await spent(store, key.id, 39_000);
  // $0.039 of $0.05 spent: the next request still runs, and overshoots.
  assert.equal((await gateway.messages(token)).status, 200);
  await spent(store, key.id, 78_000);
  const upstreamCalls = gateway.seen.length;

  const claude = await gateway.messages(token);
  assert.equal(claude.status, 403);
  assert.equal(claude.json.error.type, 'permission_error');
  assert.match(claude.json.error.message, /Guest key "alice" has used up its \$0\.0500 allowance/);
  assert.match(claude.json.error.message, /额度已用完/);
  assert.equal(claude.headers['x-should-retry'], 'false');
  assert.equal(claude.headers['x-gateway-guest-budget'], 'exhausted');

  // One allowance for both routes.
  const codex = await gateway.responses(token);
  assert.equal(codex.status, 403);
  assert.match(codex.text, /permission_error/);
  assert.match(codex.text, /used up its \$0\.0500 allowance/);
  assert.equal(gateway.seen.length, upstreamCalls, 'nothing reached an account');
  assert.equal(store.publicGuestKeys()[0].spent_micro_usd, 78_000, 'a refusal costs nothing');

  // Not inference, so not refused.
  assert.equal((await gateway.messages(token, { path: '/claude/v1/messages/count_tokens' })).status, 200);

  await store.topUpGuestKey(key.id, { microUsd: USD, actor: 'admin' });
  assert.equal((await gateway.messages(token)).status, 200);
  assert.equal((await gateway.responses(token)).status, 200);
  assert.equal((await spent(store, key.id, 78_000 + 39_040)).spent_micro_usd, 117_040);

  await store.revokeGuestKey(key.id, { actor: 'admin' });
  assert.equal((await gateway.messages(token)).status, 401);
  assert.equal((await gateway.responses(token)).status, 401);
});

test('an answer cut short is charged for what streamed, and an error for nothing', { timeout: 20_000 }, async (t) => {
  const { store, accounts } = await fleet(t);
  const { key, token } = await issue(store, accounts, { providers: ['claude'] });
  let mode = 'cut';
  const gateway = await gateways(t, {
    store,
    answer: (req, res) => {
      if (mode === 'error') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }));
        return;
      }
      // message_start and some text, then the stream simply ends.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(claudeStream({ input: 1000, write5m: 0, write1h: 0, cacheRead: 0, complete: false }));
    },
  });

  assert.equal((await gateway.messages(token)).status, 200);
  const bytes = Buffer.byteLength(claudeStream({ input: 1000, write5m: 0, write1h: 0, cacheRead: 0, complete: false }));
  const expected = 1000 * 4 + Math.ceil(bytes / 40) * 20;
  assert.equal((await spent(store, key.id, expected)).spent_micro_usd, expected);

  mode = 'error';
  assert.equal((await gateway.messages(token)).status, 400);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = store.publicGuestKeys()[0];
  assert.equal(after.spent_micro_usd, expected);
  assert.equal(after.requests, 1);
});

test('a guest turn is never handed to a third-party platform', { timeout: 20_000 }, async (t) => {
  const { store, accounts, member } = await fleet(t);
  const { token } = await issue(store, accounts);
  const intercepted = [];
  const relay = {
    intercept: async (req, res, { device, kind }) => {
      intercepted.push({ device: device.id, kind });
      return { handled: false, prefix: null };
    },
  };
  const gateway = await gateways(t, { store, answer: answerBoth, relay });
  assert.equal((await gateway.messages(token)).status, 200);
  assert.equal((await gateway.responses(token)).status, 200);
  assert.deepEqual(intercepted, [], 'the relay is not even asked');
  assert.equal((await gateway.messages(member.token)).status, 200);
  assert.deepEqual(intercepted, [{ device: member.device.id, kind: 'messages' }]);
});

// --- the console ------------------------------------------------------------

async function consoleFixture(t, { adminAuth = 'open' } = {}) {
  const { store, accounts } = await fleet(t);
  if (adminAuth === 'password') await store.addAdminUser({ username: 'root', password: PASSWORD });
  const created = await createCredentialConsole({
    store,
    adminAuth,
    cookieSecure: false,
    metricsQueryService: false,
    publicBaseUrl: 'http://console.test',
    usageMonitor: { snapshotForAccount: () => null, refreshAccount: async () => null, stop() {} },
    codexManagedRefresher: false,
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await created.stop?.();
  });
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  let cookie = null;
  const request = async (path, { method = 'GET', form = null } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        'Tailscale-User-Login': 'member@example.com',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.text() };
  };
  const csrf = async () => (await request('/')).body.match(/name="csrf" value="([^"]+)"/)[1];
  return {
    store,
    accounts,
    request,
    csrf,
    post: async (path, fields = {}) => request(path, { method: 'POST', form: { csrf: await csrf(), ...fields } }),
    async login() {
      const token = (await request('/login')).body.match(/name="csrf" value="([^"]+)"/)[1];
      return request('/login', { method: 'POST', form: { csrf: token, username: 'root', password: PASSWORD, next: '/' } });
    },
  };
}

test('the guest keys tab lists the pool, issues a key once, tops it up and revokes it', { timeout: 30_000 }, async (t) => {
  const app = await consoleFixture(t);
  const overview = await app.request('/');
  assert.match(overview.body, /<a href="\/guests" data-i18n="tab-guests" data-tab="guests">Guest keys<\/a>/);

  const page = await app.request('/guests');
  assert.equal(page.response.status, 200);
  assert.match(page.body, /<a href="\/guests" data-i18n="tab-guests" aria-current="page"/);
  assert.match(page.body, /data-i18n="guest-keys-none"/);
  for (const alias of ['claude-guest', 'claude-team', 'codex-guest', 'codex-team']) {
    assert.match(page.body, new RegExp(`<strong>${alias}</strong>`));
  }
  assert.match(page.body, /name="claude_account_id"/);
  assert.equal(page.body.match(/data-i18n="guest-pool-close"/g).length, 2);
  assert.equal(page.body.match(/data-i18n="guest-pool-add"/g).length, 2);
  // Only pool accounts are offered as a key's account.
  assert.doesNotMatch(page.body, new RegExp(`<option value="${app.accounts.claudeTeam.id}"`));
  assert.match(page.body, new RegExp(`<option value="${app.accounts.claudeGuest.id}" selected>claude-guest</option>`));

  // Opening and closing the pool.
  const opened = await app.post('/guests/pool', { account_id: app.accounts.claudeTeam.id, enabled: '1' });
  assert.equal(opened.response.status, 303);
  assert.equal(opened.response.headers.get('location'), '/guests#guest-pool');
  assert.equal(app.store.publicAccounts().find((account) => account.alias === 'claude-team').guest_pool, true);
  await app.post('/guests/pool', { account_id: app.accounts.claudeTeam.id, enabled: '0' });
  assert.equal(app.store.publicAccounts().find((account) => account.alias === 'claude-team').guest_pool, false);

  // Issuing: the secret is on this response and nowhere else.
  const created = await app.post('/guests', {
    name: 'alice-acme',
    budget: '20',
    claude_account_id: app.accounts.claudeGuest.id,
    codex_account_id: app.accounts.codexGuest.id,
    note: 'trial <b>',
  });
  assert.equal(created.response.status, 200);
  assert.match(created.response.headers.get('cache-control') ?? '', /no-store/);
  const token = created.body.match(/<pre id="guest-key-token">([^<]+)<\/pre>/)[1];
  assert.match(token, /^sk-ant-api03-/);
  assert.match(created.body, /export ANTHROPIC_BASE_URL=&#39;http:\/\/console\.test\/claude&#39;/);
  assert.match(created.body, /export ANTHROPIC_AUTH_TOKEN=&#39;sk-ant-api03-/);
  assert.match(created.body, /base_url = &quot;http:\/\/console\.test\/codex-api&quot;/);
  assert.match(created.body, /export CODEX_GATEWAY_TOKEN=&#39;sk-ant-api03-/);
  assert.equal(app.store.deviceByToken(token, 'claude').name, 'alice-acme');
  assert.equal(app.store.deviceByToken(token, 'codex').name, 'alice-acme');

  const [key] = app.store.publicGuestKeys();
  assert.equal(key.budget_micro_usd, 20 * USD);
  const listed = await app.request('/guests');
  assert.equal(listed.body.includes(token), false, 'the list never shows the secret');
  assert.match(listed.body, /<strong>alice-acme<\/strong>/);
  assert.match(listed.body, /trial &lt;b&gt;/);
  assert.match(listed.body, /data-i18n="guest-status-active"/);
  assert.match(listed.body, new RegExp(`action="/guests/${key.id}/top-up"`));

  // A key for one provider only shows only that provider's setup.
  const claudeOnly = await app.post('/guests', { name: 'bob', budget: '$1.50', claude_account_id: app.accounts.claudeGuest.id, codex_account_id: '' });
  assert.equal(claudeOnly.response.status, 200);
  assert.match(claudeOnly.body, /ANTHROPIC_AUTH_TOKEN/);
  assert.doesNotMatch(claudeOnly.body, /CODEX_GATEWAY_TOKEN/);

  // Bad input comes back as a message, not a key.
  for (const [fields, message] of [
    [{ name: 'alice-acme', budget: '5', claude_account_id: app.accounts.claudeGuest.id }, /already has this name/],
    [{ name: 'carol', budget: 'lots', claude_account_id: app.accounts.claudeGuest.id }, /amount in US dollars/],
    [{ name: 'carol', budget: '5' }, /at least one account/],
    [{ name: 'carol', budget: '5', claude_account_id: app.accounts.claudeTeam.id }, /not open to guest keys/],
  ]) {
    const refused = await app.post('/guests', fields);
    assert.equal(refused.response.status, 303);
    const location = refused.response.headers.get('location');
    assert.match(decodeURIComponent(location), message);
    assert.match((await app.request(location)).body, /class="notice error"/);
  }
  assert.equal(app.store.publicGuestKeys().length, 2);

  // Spend shows up, a top-up raises the allowance, a revoke ends the key.
  app.store.chargeGuestKey(key.id, { provider: 'claude', microUsd: 20 * USD });
  assert.match((await app.request('/guests')).body, /data-i18n="guest-status-exhausted"/);
  const topped = await app.post(`/guests/${key.id}/top-up`, { amount: '5.25' });
  assert.equal(topped.response.headers.get('location'), '/guests#guest-keys');
  assert.equal(app.store.publicGuestKeys().find((entry) => entry.id === key.id).budget_micro_usd, 25_250_000);
  const badTopUp = await app.post(`/guests/${key.id}/top-up`, { amount: '-1' });
  assert.match(decodeURIComponent(badTopUp.response.headers.get('location')), /amount in US dollars/);

  const revoked = await app.post(`/guests/${key.id}/revoke`);
  assert.equal(revoked.response.status, 303);
  assert.equal(app.store.deviceByToken(token, 'claude'), null);
  assert.match((await app.request('/guests')).body, /data-i18n="guest-status-revoked"/);

  // No CSRF token, no change.
  const forged = await app.request('/guests', { method: 'POST', form: { csrf: 'nope', name: 'mallory', budget: '9', claude_account_id: app.accounts.claudeGuest.id } });
  assert.equal(forged.response.status, 403);
  assert.equal(app.store.publicGuestKeys().some((entry) => entry.name === 'mallory'), false);
  await app.store.flushGuestSpend();
});

test('in password mode guest keys are an administrator matter', { timeout: 30_000 }, async (t) => {
  const app = await consoleFixture(t, { adminAuth: 'password' });

  // A member: no tab, no page, no action.
  const overview = await app.request('/');
  assert.equal(overview.response.status, 200);
  assert.doesNotMatch(overview.body, /data-tab="guests"/);
  const page = await app.request('/guests');
  assert.equal(page.response.status, 303);
  assert.match(page.response.headers.get('location'), /^\/login\?next=/);
  for (const [path, fields] of [
    ['/guests', { name: 'mallory', budget: '9', claude_account_id: app.accounts.claudeGuest.id }],
    ['/guests/pool', { account_id: app.accounts.claudeTeam.id, enabled: '1' }],
    ['/guests/anything/top-up', { amount: '100' }],
    ['/guests/anything/revoke', {}],
  ]) {
    const refused = await app.post(path, fields);
    assert.equal(refused.response.status, 403, path);
    assert.match(refused.body, /Administrator sign-in required/);
  }
  assert.deepEqual(app.store.publicGuestKeys(), []);
  assert.equal(app.store.publicAccounts().find((account) => account.alias === 'claude-team').guest_pool, false);

  // An administrator: the tab, the page and the key.
  await app.login();
  assert.match((await app.request('/')).body, /data-tab="guests"/);
  assert.equal((await app.request('/guests')).response.status, 200);
  const created = await app.post('/guests', { name: 'alice', budget: '10', claude_account_id: app.accounts.claudeGuest.id });
  assert.equal(created.response.status, 200);
  const [key] = app.store.publicGuestKeys();
  assert.equal(key.created_by, 'admin:root');
  assert.equal(app.store.state.audit.find((entry) => entry.event === 'guest_key_created').actor, 'admin:root');
});
