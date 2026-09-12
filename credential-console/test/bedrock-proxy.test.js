import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  BEDROCK_PROXY_PREFIX,
  bedrockUsageSnapshot,
  handleBedrockProxy,
  parseBedrockPath,
} from '../lib/bedrock-proxy.js';

const DEVICE_TOKEN = 'bedrock-device-test-token';
const API_KEY = 'bedrock-upstream-api-key';
const MODEL_ID = 'us.openai.gpt-6-astra';

const DEVICE = {
  id: 'device-bedrock-test',
  account_id: 'account-bedrock-test',
  machine_id: 'machine-bedrock-test-1',
  member_label: 'member@example.com',
};

function bedrockAccount(overrides = {}) {
  return {
    id: DEVICE.account_id,
    provider: 'bedrock',
    alias: 'bedrock-test-account',
    status: 'stored',
    bedrock: { region: 'us-west-2', model_id: MODEL_ID },
    ...overrides,
  };
}

function storeFixture(account, { apiKey = API_KEY } = {}) {
  return {
    deviceByToken(token) {
      return token === DEVICE_TOKEN ? DEVICE : null;
    },
    accountById(id) {
      return id === account?.id ? account : null;
    },
    accountCredential(id) {
      return id === account?.id && apiKey ? { api_key: apiKey } : null;
    },
    resolveDeviceAccount() {
      if (!account) throw Object.assign(new Error('no account'), { code: 'DEVICE_CONFIGURATION_INVALID' });
      return { device: DEVICE, account, effective_account_id: account.id };
    },
  };
}

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

function sink() {
  return { rows: [], enqueueRequest(row) { this.rows.push(row); } };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for a metric row');
}

const CONVERSE_BODY = {
  output: { message: { role: 'assistant', content: [{ text: 'CONNECTION_OK' }] } },
  stopReason: 'end_turn',
  usage: {
    inputTokens: 14,
    outputTokens: 8,
    cacheReadInputTokens: 3,
    totalTokens: 22,
  },
};

async function startHarness(t, {
  store,
  requestMetrics = null,
  upstreamHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(CONVERSE_BODY));
  },
  seen = {},
} = {}) {
  const upstream = http.createServer((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.headers = req.headers;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.body = Buffer.concat(chunks).toString('utf8');
      upstreamHandler(req, res);
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleBedrockProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      requestMetrics,
    })).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await Promise.all([close(proxy), close(upstream)]); });
  return { proxyUrl, seen };
}

function converse(url, {
  modelId = MODEL_ID,
  token = DEVICE_TOKEN,
  path = null,
  method = 'POST',
} = {}) {
  const target = path ?? `/model/${encodeURIComponent(modelId)}/converse`;
  return fetch(`${url}${BEDROCK_PROXY_PREFIX}${target}`, {
    method,
    headers: {
      ...(token ? { 'x-api-key': token } : {}),
      'content-type': 'application/json',
    },
    ...(method === 'POST'
      ? { body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'hi' }] }] }) }
      : {}),
  });
}

test('only converse and converse-stream are recognised paths', () => {
  assert.deepEqual(parseBedrockPath('/model/us.openai.gpt-6-astra/converse'), {
    modelId: 'us.openai.gpt-6-astra',
    streaming: false,
  });
  assert.deepEqual(parseBedrockPath('/model/us.openai.gpt-6-astra/converse-stream'), {
    modelId: 'us.openai.gpt-6-astra',
    streaming: true,
  });
  assert.equal(parseBedrockPath('/model/us.openai.gpt-6-astra/invoke'), null);
  assert.equal(parseBedrockPath('/converse'), null);
  // A slash in the model segment would let a crafted path reach another route.
  assert.equal(parseBedrockPath('/model/a/b/converse'), null);
});

test('Converse usage maps onto the four recorded token counts', () => {
  assert.deepEqual(bedrockUsageSnapshot(CONVERSE_BODY), {
    inputTokens: 14,
    // Bedrock reports no cache-creation count. Null says "not reported";
    // zero would claim it reported none.
    cacheCreationInputTokens: null,
    cacheReadInputTokens: 3,
    outputTokens: 8,
    usageState: 'complete',
  });
  assert.equal(bedrockUsageSnapshot({}).usageState, 'unavailable');
  assert.equal(bedrockUsageSnapshot(null).usageState, 'unavailable');
  assert.equal(bedrockUsageSnapshot({ usage: { inputTokens: 5 } }).usageState, 'partial');
});

test('a turn is forwarded with the account key and recorded with its token counts', async (t) => {
  const metrics = sink();
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(bedrockAccount()),
    requestMetrics: metrics,
    seen,
  });

  const response = await converse(proxyUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), CONVERSE_BODY);

  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, `/model/${encodeURIComponent(MODEL_ID)}/converse`);
  assert.equal(seen.headers.authorization, `Bearer ${API_KEY}`);
  // The device token authenticated the caller to this console and must never
  // reach AWS.
  assert.equal(seen.headers['x-api-key'], undefined);
  assert.equal(JSON.parse(seen.body).messages[0].content[0].text, 'hi');

  const row = await waitFor(() => metrics.rows[0]);
  assert.equal(row.statusCode, 200);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.model, MODEL_ID);
  assert.equal(row.stream, false);
  assert.equal(row.inputTokens, 14);
  assert.equal(row.outputTokens, 8);
  assert.equal(row.cacheReadInputTokens, 3);
  assert.equal(row.deviceId, DEVICE.id);
  assert.equal(row.accountAlias, 'bedrock-test-account');
});

// Forwarding a stream would work for the client and silently record every turn
// as zero tokens, which defeats the one thing this gateway is for.
test('streaming is refused with its reason rather than passed through unmetered', async (t) => {
  const metrics = sink();
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(bedrockAccount()),
    requestMetrics: metrics,
    seen,
  });

  const response = await converse(proxyUrl, {
    path: `/model/${encodeURIComponent(MODEL_ID)}/converse-stream`,
  });
  assert.equal(response.status, 501);
  assert.match((await response.json()).message, /cannot be metered/);
  assert.equal(seen.method, undefined, 'the upstream must not be called');

  const row = await waitFor(() => metrics.rows[0]);
  assert.equal(row.statusCode, 501);
  assert.equal(row.outcome, 'rejected');
});

// The API key is account-wide; the pin is the only thing between a device token
// and every model the AWS account can invoke.
test('a model other than the account pin is refused before the key is used', async (t) => {
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(bedrockAccount()),
    seen,
  });

  const response = await converse(proxyUrl, { modelId: 'anthropic.claude-3-sonnet' });
  assert.equal(response.status, 403);
  assert.match((await response.json()).message, /may only invoke/);
  assert.equal(seen.method, undefined, 'the upstream must not be called');
});

test('a device whose account is not a Bedrock account gets nothing from this route', async (t) => {
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(bedrockAccount({ provider: 'claude' })),
    seen,
  });

  const response = await converse(proxyUrl);
  assert.equal(response.status, 403);
  assert.equal(seen.method, undefined);
});

test('an unknown device token never reaches an account', async (t) => {
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(bedrockAccount()),
    seen,
  });

  const response = await converse(proxyUrl, { token: 'not-a-device-token' });
  assert.equal(response.status, 401);
  assert.equal(seen.method, undefined);
});

test('an account missing its region and model pin is refused, not defaulted', async (t) => {
  const seen = {};
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(bedrockAccount({ bedrock: null })),
    seen,
  });

  const response = await converse(proxyUrl);
  assert.equal(response.status, 503);
  assert.equal(seen.method, undefined);
});

test('an upstream error is forwarded verbatim and recorded without inventing usage', async (t) => {
  const metrics = sink();
  const { proxyUrl } = await startHarness(t, {
    store: storeFixture(bedrockAccount()),
    requestMetrics: metrics,
    upstreamHandler: (req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'malformed input' }));
    },
  });

  const response = await converse(proxyUrl);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, 'malformed input');

  const row = await waitFor(() => metrics.rows[0]);
  assert.equal(row.statusCode, 400);
  assert.equal(row.outcome, 'upstream_error');
  assert.equal(row.inputTokens, null);
  assert.equal(row.usageState, 'unavailable');
});

test('GET is refused on a recognised converse path', async (t) => {
  const { proxyUrl } = await startHarness(t, { store: storeFixture(bedrockAccount()) });
  const response = await converse(proxyUrl, { method: 'GET' });
  assert.equal(response.status, 405);
});
