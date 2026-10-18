import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { BEDROCK_PROXY_PREFIX, handleBedrockProxy } from '../lib/bedrock-proxy.js';
import { BedrockEventStreamUsageParser } from '../lib/bedrock-event-stream.js';
import { bedrockModelAllowed, normalizeBedrockModelPin } from '../lib/bedrock-models.js';

const DEVICE_TOKEN = 'bedrock-device-test-token';
const API_KEY = 'bedrock-upstream-api-key';
const CLAUDE = 'us.anthropic.claude-opus-5-5';
const GPT = 'us.openai.gpt-6.1-sol';
const PIN = `${CLAUDE}, us.anthropic.claude-haiku-*, us.openai.gpt-6*`;

const DEVICE = {
  id: 'device-bedrock-stream',
  account_id: 'account-bedrock-stream',
  machine_id: null,
  member_label: 'member@example.com',
};
const ACCOUNT = {
  id: DEVICE.account_id,
  provider: 'bedrock',
  alias: 'bedrock-stream-account',
  status: 'stored',
  bedrock: { region: 'us-west-2', model_id: PIN },
};

const store = {
  deviceByToken: (token) => (token === DEVICE_TOKEN ? DEVICE : null),
  accountById: (id) => (id === ACCOUNT.id ? ACCOUNT : null),
  accountCredential: (id) => (id === ACCOUNT.id ? { api_key: API_KEY } : null),
  resolveDeviceAccount: () => ({ device: DEVICE, account: ACCOUNT, effective_account_id: ACCOUNT.id }),
};

/** One AWS event-stream frame with string headers, as Bedrock sends it. */
function frame(headers, payload) {
  const headerBytes = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const nameBytes = Buffer.from(name);
    const valueBytes = Buffer.from(value);
    const out = Buffer.alloc(4 + nameBytes.length + valueBytes.length);
    out[0] = nameBytes.length;
    nameBytes.copy(out, 1);
    out[1 + nameBytes.length] = 7;
    out.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
    valueBytes.copy(out, 4 + nameBytes.length);
    return out;
  }));
  const payloadBytes = Buffer.from(payload);
  const total = 16 + headerBytes.length + payloadBytes.length;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  headerBytes.copy(out, 12);
  payloadBytes.copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return out;
}

function chunkFrame(event) {
  return frame(
    { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' },
    JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64'), p: 'abc' }),
  );
}

const CLAUDE_STREAM = Buffer.concat([
  chunkFrame({
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
      usage: { input_tokens: 11, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 1 },
    },
  }),
  chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }),
  chunkFrame({ type: 'content_block_stop', index: 0 }),
  chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
  chunkFrame({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 11 } }),
]);

// Bedrock's Responses stream carries no `event:` lines, only typed data.
const RESPONSES_STREAM = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_text.delta', delta: 'OK' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, output_tokens: 9 },
    },
  },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function harness(t, upstreamHandler) {
  const seen = [];
  const rows = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      upstreamHandler(req, res);
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    handleBedrockProxy(req, res, {
      store,
      upstreamBaseUrl: upstreamUrl,
      requestMetrics: { enqueueRequest: (row) => rows.push(row) },
    }).catch(() => res.destroy());
  });
  const proxyUrl = await listen(proxy);
  t.after(() => Promise.all([
    new Promise((resolve) => proxy.close(resolve)),
    new Promise((resolve) => upstream.close(resolve)),
  ]));
  return { proxyUrl, seen, rows };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

test('a model pin is a list of ids and whole-id patterns', () => {
  assert.equal(normalizeBedrockModelPin(' us.a.one ,us.b.*\nus.a.one '), 'us.a.one, us.b.*');
  assert.equal(normalizeBedrockModelPin('us.openai.gpt-6-astra'), 'us.openai.gpt-6-astra');
  assert.equal(normalizeBedrockModelPin(''), null);
  assert.equal(normalizeBedrockModelPin('bad model id!'), null);
  assert.equal(normalizeBedrockModelPin(Array.from({ length: 21 }, (_, i) => `m${i}`).join(',')), null);

  assert.ok(bedrockModelAllowed(PIN, CLAUDE));
  assert.ok(bedrockModelAllowed(PIN, 'us.anthropic.claude-haiku-5-5'));
  assert.ok(bedrockModelAllowed(PIN, GPT));
  // Whole-id: a pinned model does not admit everything that starts with it.
  assert.equal(bedrockModelAllowed(PIN, `${CLAUDE}-preview`), false);
  assert.equal(bedrockModelAllowed(PIN, 'us.anthropic.claude-sonnet-5-5'), false);
  assert.equal(bedrockModelAllowed(PIN, 'us.openai.gpt-5.5'), false);
  assert.ok(bedrockModelAllowed('*', 'anything.at-all'));
  assert.equal(bedrockModelAllowed(PIN, null), false);
});

test('the event-stream parser reads usage across frames split at any byte', () => {
  for (const size of [1, 7, 64, CLAUDE_STREAM.length]) {
    const parser = new BedrockEventStreamUsageParser();
    for (let offset = 0; offset < CLAUDE_STREAM.length; offset += size) {
      parser.push(CLAUDE_STREAM.subarray(offset, offset + size));
    }
    const usage = parser.finish();
    assert.equal(usage.usageState, 'complete', `split every ${size} bytes`);
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.cacheCreationInputTokens, 5);
    assert.equal(usage.cacheReadInputTokens, 7);
    assert.equal(usage.outputTokens, 4);
  }
});

test('an event-stream cut off mid-frame is recorded as partial, not complete', () => {
  const parser = new BedrockEventStreamUsageParser();
  parser.push(CLAUDE_STREAM.subarray(0, CLAUDE_STREAM.length - 10));
  assert.notEqual(parser.finish().usageState, 'complete');
});

test('a Claude Code stream is relayed byte for byte and metered from its frames', async (t) => {
  const { proxyUrl, seen, rows } = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'req-1' });
    // Written in pieces, so the proxy sees frames that straddle chunks.
    res.write(CLAUDE_STREAM.subarray(0, 50));
    setTimeout(() => res.end(CLAUDE_STREAM.subarray(50)), 10);
  });

  const response = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/model/${CLAUDE}/invoke-with-response-stream`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${DEVICE_TOKEN}`,
      'content-type': 'application/json',
      'anthropic-beta': 'claude-code-20250219',
      'x-claude-code-session-id': 'session-1',
    },
    body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 10, messages: [] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.amazon.eventstream');
  assert.equal(response.headers.get('x-amzn-requestid'), 'req-1');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), CLAUDE_STREAM);

  assert.equal(seen[0].url, `/model/${CLAUDE}/invoke-with-response-stream`);
  assert.equal(seen[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(seen[0].headers['anthropic-beta'], 'claude-code-20250219');
  // The client's own headers are not the upstream's business.
  assert.equal(seen[0].headers['x-claude-code-session-id'], undefined);

  const row = await waitFor(() => rows[0]);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.stream, true);
  assert.equal(row.model, CLAUDE);
  assert.equal(row.upstreamRequestId, 'req-1');
  assert.equal(row.inputTokens, 11);
  assert.equal(row.outputTokens, 4);
  assert.equal(row.cacheReadInputTokens, 7);
  assert.equal(row.usageState, 'complete');
  assert.equal(row.responseBytes, CLAUDE_STREAM.length);
});

test('a Codex Responses stream is relayed and metered from its last event', async (t) => {
  const { proxyUrl, seen, rows } = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(RESPONSES_STREAM);
  });

  const response = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/openai/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: GPT, input: 'hi', stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), RESPONSES_STREAM);
  assert.equal(seen[0].url, '/openai/v1/responses');
  assert.equal(JSON.parse(seen[0].body).model, GPT);

  const row = await waitFor(() => rows[0]);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.stream, true);
  assert.equal(row.model, GPT);
  assert.equal(row.inputTokens, 30);
  assert.equal(row.cacheReadInputTokens, 60);
  assert.equal(row.cacheCreationInputTokens, 10);
  assert.equal(row.outputTokens, 9);
  assert.equal(row.usageState, 'complete');
});

test('a Responses model outside the pin is refused before the key is used', async (t) => {
  const { proxyUrl, seen, rows } = await harness(t, (req, res) => res.end());
  for (const body of [{ model: 'us.openai.gpt-5.5', input: 'hi' }, { input: 'no model' }]) {
    const response = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/openai/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal(seen.length, 0, 'the upstream must not be called');
  await waitFor(() => rows.length === 2);
  assert.equal(rows[0].model, 'us.openai.gpt-5.5');
  assert.equal(rows[0].statusCode, 403);
  assert.equal(rows[1].statusCode, 400);
});

test('a streamed invoke of a model outside the pin is refused', async (t) => {
  const { proxyUrl, seen } = await harness(t, (req, res) => res.end());
  const response = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/invoke-with-response-stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.equal(seen.length, 0);
});

test('a non-streaming invoke is metered from the Anthropic body', async (t) => {
  const { proxyUrl, rows } = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 },
    }));
  });
  const response = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/model/us.anthropic.claude-haiku-5-5/invoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const row = await waitFor(() => rows[0]);
  assert.equal(row.stream, false);
  assert.equal(row.inputTokens, 20);
  assert.equal(row.outputTokens, 2);
});

test('the inference-profile listing is forwarded with the key and not recorded', async (t) => {
  const { proxyUrl, seen, rows } = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"inferenceProfileSummaries":[]}');
  });
  const response = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/inference-profiles?type=SYSTEM_DEFINED`, {
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { inferenceProfileSummaries: [] });
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/inference-profiles?type=SYSTEM_DEFINED');
  assert.equal(seen[0].headers.authorization, `Bearer ${API_KEY}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rows.length, 0);

  const unauthenticated = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/inference-profiles`);
  assert.equal(unauthenticated.status, 401);
});

test('a client that leaves mid-stream is recorded as disconnected and the upstream is released', async (t) => {
  let upstreamClosed = false;
  const { proxyUrl, rows } = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    // Exactly the first frame, message_start, which carries the input count.
    res.write(CLAUDE_STREAM.subarray(0, CLAUDE_STREAM.readUInt32BE(0)));
    res.on('close', () => { upstreamClosed = true; });
    // Never ends on its own.
  });
  const controller = new AbortController();
  const response = await fetch(`${proxyUrl}${BEDROCK_PROXY_PREFIX}/model/${CLAUDE}/invoke-with-response-stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  const row = await waitFor(() => rows[0]);
  assert.equal(row.outcome, 'client_disconnected');
  assert.equal(row.inputTokens, 11, 'what was seen before the cut is still counted');
  await waitFor(() => upstreamClosed);
});
