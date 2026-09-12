import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore, GATEWAY_PROVIDERS } from '../lib/store.js';

const API_KEY = 'ABSK-synthetic-test-key';
const MODEL_ID = 'us.openai.gpt-6-astra';

async function newStore(t) {
  const home = await mkdtemp(join(tmpdir(), 'bedrock-account-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return new CredentialStore(home, { allowKeyInit: true }).init();
}

function bedrockInput(overrides = {}) {
  return {
    provider: 'bedrock',
    alias: 'bedrock-astra-1',
    emailLabel: '',
    credential: { api_key: API_KEY },
    bedrock: { region: 'us-west-2', modelId: MODEL_ID },
    ...overrides,
  };
}

test('bedrock is a gateway provider alongside claude and codex', () => {
  assert.deepEqual([...GATEWAY_PROVIDERS], ['claude', 'codex', 'bedrock']);
});

test('a Bedrock account stores its pin in the clear and its key encrypted', async (t) => {
  const store = await newStore(t);
  const account = await store.addAccount(bedrockInput());

  assert.equal(account.provider, 'bedrock');
  assert.equal(account.status, 'stored');
  assert.deepEqual(account.bedrock, { region: 'us-west-2', model_id: MODEL_ID });
  // The proxy compares every turn's model against the pin and must not need the
  // master key to do it; the key itself must never be readable that way.
  assert.equal(JSON.stringify(account.bedrock).includes(API_KEY), false);
  assert.equal(String(account.credential).includes(API_KEY), false);
  assert.equal(store.accountCredential(account.id).api_key, API_KEY);

  const published = store.publicAccounts().find((entry) => entry.id === account.id);
  assert.deepEqual(published.bedrock, { region: 'us-west-2', model_id: MODEL_ID });
  assert.equal('credential' in published, false);
});

test('a Bedrock account without a region, model or key is refused at registration', async (t) => {
  const store = await newStore(t);
  await assert.rejects(
    store.addAccount(bedrockInput({ bedrock: { region: 'not a region', modelId: MODEL_ID } })),
    /valid AWS region/,
  );
  await assert.rejects(
    store.addAccount(bedrockInput({ bedrock: { region: 'us-west-2', modelId: '' } })),
    /valid Bedrock model id/,
  );
  await assert.rejects(
    store.addAccount(bedrockInput({ credential: null })),
    /Bedrock API key is required/,
  );
  assert.deepEqual(store.publicAccounts(), []);
});

test('a region and model pin is refused on a provider that has no such concept', async (t) => {
  const store = await newStore(t);
  await assert.rejects(
    store.addAccount({
      provider: 'claude',
      alias: 'claude-1',
      emailLabel: 'owner@example.com',
      bedrock: { region: 'us-west-2', modelId: MODEL_ID },
    }),
    /only meaningful for a Bedrock account/,
  );
});

test('a Bedrock account can be issued a device credential and switched between', async (t) => {
  const store = await newStore(t);
  const first = await store.addAccount(bedrockInput());
  const second = await store.addAccount(bedrockInput({
    alias: 'bedrock-astra-2',
    bedrock: { region: 'us-east-1', modelId: MODEL_ID },
  }));

  const issued = await store.issueDeviceCredential({
    accountId: first.id,
    memberLabel: 'member@example.com',
    deviceName: 'laptop',
  });
  assert.equal(issued.account.provider, 'bedrock');
  assert.equal(store.deviceByToken(issued.token).id, issued.device.id);

  const summary = await store.configureDeviceAccount({
    deviceId: issued.device.id,
    selectedAccountId: second.id,
    actor: 'admin',
  });
  assert.equal(summary.selected_account_id, second.id);
  assert.equal(summary.account.has_credential, true);
});

// The store's existing rule: an allowlist may hold one provider, not two. A
// third provider has to obey it rather than quietly become the exception.
test('a device cannot be switched from a Bedrock account to another provider', async (t) => {
  const store = await newStore(t);
  const bedrock = await store.addAccount(bedrockInput());
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'claude-1',
    emailLabel: 'owner@example.com',
    credential: { oauth_token: 'sk-ant-oat01-test' },
  });
  const issued = await store.issueDeviceCredential({
    accountId: bedrock.id,
    memberLabel: 'member@example.com',
    deviceName: 'laptop',
  });

  await assert.rejects(
    store.configureDeviceAccount({
      deviceId: issued.device.id,
      selectedAccountId: claude.id,
      actor: 'admin',
    }),
    (error) => error.code === 'DEVICE_CONFIGURATION_INVALID',
  );
});

// A row can only lose its pin through hand-editing, but the switch gate is the
// last thing standing between that row and a device pointed at a 503.
test('a Bedrock account whose pin was removed is no longer switchable', async (t) => {
  const store = await newStore(t);
  const first = await store.addAccount(bedrockInput());
  const second = await store.addAccount(bedrockInput({ alias: 'bedrock-astra-2' }));
  const issued = await store.issueDeviceCredential({
    accountId: first.id,
    memberLabel: 'member@example.com',
    deviceName: 'laptop',
  });

  delete store.accountById(second.id).bedrock;
  await assert.rejects(
    store.configureDeviceAccount({
      deviceId: issued.device.id,
      selectedAccountId: second.id,
      actor: 'admin',
    }),
    (error) => error.code === 'ACCOUNT_UNAVAILABLE',
  );
});

// The single-codebase strategy rests on this: the same build runs on a console
// that has a Bedrock account and one that does not, and the second must show
// members exactly what it showed them before the provider existed. The gate is
// state (is there an account?), not an environment variable somebody has to
// remember to leave unset.
//
// The admin registration form is deliberately NOT gated: it is the only way to
// create the first account, so gating it on having one would be a door locked
// from the inside. A console with no Bedrock account therefore gains one form
// in the administrator area and nothing else.
test('the member-facing Bedrock panel is absent until an account is registered', async (t) => {
  const { dashboardView } = await import('../lib/views.js');
  const base = {
    accounts: [],
    devices: [],
    machines: [],
    codexClients: [],
    csrf: 'csrf-token',
    openMode: true,
  };

  const without = dashboardView(base);
  assert.equal(without.includes('data-i18n="bedrock-description"'), false);
  assert.equal(without.includes('data-persist-draft="bedrock-self-service"'), false);
  // The way in still exists for an administrator.
  assert.match(without, /name="provider" value="bedrock"/);

  const store = await newStore(t);
  const account = await store.addAccount(bedrockInput());
  const withOne = dashboardView({ ...base, accounts: store.publicAccounts() });
  assert.match(withOne, /data-i18n="bedrock-description"/);
  assert.match(withOne, /data-persist-draft="bedrock-self-service"/);
  assert.match(withOne, new RegExp(`<option value="${account.id}">`));
});

// Billed per token, with no rolling allowance to read. Rendering the ordinary
// quota block would report a reading as pending or unavailable, which claims a
// fetch failed when there was never a fetch to make.
test('a Bedrock account shows no quota window', async (t) => {
  const { dashboardView } = await import('../lib/views.js');
  const store = await newStore(t);
  await store.addAccount(bedrockInput());
  const html = dashboardView({
    accounts: store.publicAccounts(),
    devices: [],
    machines: [],
    codexClients: [],
    csrf: 'csrf-token',
    openMode: true,
  });
  assert.match(html, /data-i18n="usage-per-token"/);
  assert.equal(html.includes('data-i18n="usage-loading"'), false);
  assert.equal(html.includes('data-i18n="usage-quota-hidden"'), false);
});

// A Bedrock row is `stored` from the moment it exists, so without this it would
// offer no delete control and refuse deletion anyway: one mistyped model id
// would be permanent. The Claude rule it inherited exists for credentials the
// operator cannot recreate, and a pasted AWS key is not one of those.
test('a Bedrock account can be corrected by deleting and re-registering it', async (t) => {
  const store = await newStore(t);
  const typo = await store.addAccount(bedrockInput({
    alias: 'bedrock-typo',
    bedrock: { region: 'us-west-2', modelId: 'us.openai.gpt-6-astrA-wrong' },
  }));

  await store.deleteAccount(typo.id);
  assert.equal(store.accountById(typo.id), null);

  const fixed = await store.addAccount(bedrockInput({ alias: 'bedrock-typo' }));
  assert.equal(fixed.bedrock.model_id, MODEL_ID);
});

// Deleting the row must not strand a device that is still pointed at it.
test('a Bedrock account with an active device is still refused deletion', async (t) => {
  const store = await newStore(t);
  const account = await store.addAccount(bedrockInput());
  await store.issueDeviceCredential({
    accountId: account.id,
    memberLabel: 'member@example.com',
    deviceName: 'laptop',
  });

  await assert.rejects(store.deleteAccount(account.id), /active device/);
});

// A Claude account holding a real OAuth token stays undeletable: that rule is
// the reason this one had to be narrowed rather than dropped.
test('a Claude account holding a stored credential is still undeletable', async (t) => {
  const store = await newStore(t);
  const claude = await store.addAccount({
    provider: 'claude',
    alias: 'claude-1',
    emailLabel: 'owner@example.com',
    credential: { oauth_token: 'sk-ant-oat01-test' },
  });

  await assert.rejects(store.deleteAccount(claude.id), /cannot be deleted/);
});
