import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { handleClaudeProxy } from '../lib/proxy.js';
import { normalizeModelBlockRules } from '../lib/model-block-rules.js';

const DEVICE_TOKEN = 'device-block-token';
const DEVICE = {
  id: 'device-block-test',
  account_id: 'account-block-test',
  machine_id: 'machine-block-test-0001',
  member_label: 'block@example.com',
};
const ACCOUNT = {
  id: DEVICE.account_id,
  provider: 'claude',
  alias: 'claude-block-account',
  status: 'healthy',
  expires_at: null,
};

const RULES = [
  {
    id: 'rule-fable',
    enabled: true,
    patterns: ['claude-fable-5-1*'],
    message_zh: '不建议使用 Fable 5.1，使用 Opus 5.5 更便宜且模型能力更强。',
    message_en: 'Fable 5.1 is not recommended: Opus 5.5 is cheaper and more capable.',
  },
  {
    id: 'rule-opus5',
    enabled: true,
    patterns: ['claude-opus-5', 'claude-opus-5-2*'],
    message_zh: '建议使用 Opus 5.5，更便宜且模型能力更强。',
    message_en: 'Use Opus 5.5 instead: cheaper and more capable.',
  },
];

function storeFixture(rules = RULES) {
  return {
    deviceByToken(token) {
      return token === DEVICE_TOKEN ? DEVICE : null;
    },
    accountById(id) {
      return id === ACCOUNT.id ? ACCOUNT : null;
    },
    accountCredential() {
      return { oauth_token: 'upstream-block-credential' };
    },
    modelBlockRules() {
      return normalizeModelBlockRules(rules);
    },
    markDeviceSeen() {
      return Promise.resolve();
    },
    updateAccountHealth() {
      return Promise.resolve();
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
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
  throw new Error('timed out waiting');
}

async function startHarness(t, { rules = RULES, respond = null } = {}) {
  const upstream = { calls: 0, completeBodies: [] };
  const metrics = sink();
  const upstreamServer = http.createServer((req, res) => {
    upstream.calls += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      upstream.completeBodies.push(body);
      if (respond) {
        respond(res, upstream);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upstreamUrl = await listen(upstreamServer);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleClaudeProxy(req, res, {
      store: storeFixture(rules),
      upstreamBaseUrl: upstreamUrl,
      requestMetrics: metrics,
    })).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await Promise.all([close(proxy), close(upstreamServer)]);
  });
  return { proxyUrl, upstream, metrics };
}

function postInChunks(url, parts, { gapMs = 30, path = '/claude/v1/messages' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(`${url}${path}`), {
      method: 'POST',
      headers: { 'X-Api-Key': DEVICE_TOKEN, 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    // A refusal closes the connection while later parts may still be queued.
    req.on('error', (error) => {
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') return;
      reject(error);
    });
    (async () => {
      for (const part of parts) {
        if (req.destroyed) return;
        req.write(part);
        await new Promise((r) => setTimeout(r, gapMs));
      }
      if (!req.destroyed) req.end();
    })();
  });
}

function turn(model, text = 'hello') {
  return JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: text }] });
}

test('a blocked Claude model is refused in the shape Claude Code reads, with the rule\'s message', async (t) => {
  const { proxyUrl, upstream, metrics } = await startHarness(t);

  const response = await postInChunks(proxyUrl, [turn('claude-fable-5-1')]);
  assert.equal(response.status, 403);
  const body = JSON.parse(response.body);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'permission_error');
  assert.match(body.error.message, /不建议使用 Fable 5\.1/);
  assert.match(body.error.message, /Opus 5\.5 is cheaper/);
  assert.equal(upstream.calls, 0, 'nothing reached Anthropic');

  const row = await waitFor(() => metrics.rows[0]);
  assert.equal(row.outcome, 'model_blocked');
  assert.equal(row.statusCode, 403);
  assert.equal(row.model, 'claude-fable-5-1');
});

test('blocking Opus 5 leaves Opus 5.5 alone, and its body arrives byte for byte', async (t) => {
  const { proxyUrl, upstream } = await startHarness(t);

  const blocked = await postInChunks(proxyUrl, [turn('claude-opus-5')]);
  assert.equal(blocked.status, 403);
  assert.match(JSON.parse(blocked.body).error.message, /建议使用 Opus 5\.5/);
  const dated = await postInChunks(proxyUrl, [turn('claude-opus-5-20250930')]);
  assert.equal(dated.status, 403, 'a dated Opus 5 id is the same model');

  const parts = [
    '{"model":"claude-opus-5-5","max_tokens":16,',
    `"messages":[{"role":"user","content":"${'y'.repeat(80 * 1024)}"}]`,
    ',"stream":false}',
  ];
  const allowed = await postInChunks(proxyUrl, parts);
  assert.equal(allowed.status, 200);
  assert.equal(upstream.calls, 1);
  assert.equal(upstream.completeBodies[0].toString('utf8'), parts.join(''));
});

test('counting tokens against a blocked model is not refused', async (t) => {
  const { proxyUrl, upstream } = await startHarness(t);
  const response = await postInChunks(proxyUrl, [turn('claude-opus-5')], {
    path: '/claude/v1/messages/count_tokens',
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.calls, 1);
});

test('with every rule switched off the body is forwarded untouched', async (t) => {
  const { proxyUrl, upstream } = await startHarness(t, {
    rules: RULES.map((rule) => ({ ...rule, enabled: false })),
  });
  const response = await postInChunks(proxyUrl, [turn('claude-fable-5-1')]);
  assert.equal(response.status, 200);
  assert.equal(upstream.calls, 1);
});

test('a blocked model that only turns up past the head never reaches Anthropic whole', async (t) => {
  const { proxyUrl, upstream, metrics } = await startHarness(t);
  const filler = 'z'.repeat(70 * 1024);

  const response = await postInChunks(proxyUrl, [
    `{"system":"${filler}","max_tokens":16`,
    ',"model":"claude-opus-5"',
    ',"messages":[]}',
  ]);

  assert.equal(response.status, 403);
  assert.match(JSON.parse(response.body).error.message, /Opus 5\.5/);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(upstream.completeBodies, [], 'the upstream never held a body it could run');
  const row = await waitFor(() => metrics.rows[0]);
  assert.equal(row.outcome, 'model_blocked');
  assert.equal(row.model, 'claude-opus-5');
});

test('a second model key cannot slip a blocked model past an allowed one', async (t) => {
  const { proxyUrl, upstream } = await startHarness(t);
  const response = await postInChunks(proxyUrl, [
    '{"model":"claude-opus-5-5","max_tokens":16,"messages":[],"model":"claude-opus-5"}',
  ]);
  assert.equal(response.status, 403);
  assert.equal(upstream.calls, 0);
});

test('an overload retry still replays the whole body when rules are on', { timeout: 20_000 }, async (t) => {
  const { proxyUrl, upstream } = await startHarness(t, {
    respond(res, state) {
      if (state.completeBodies.length === 1) {
        res.writeHead(529, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  const parts = [
    '{"model":"claude-opus-5-5","max_tokens":16,',
    `"messages":[{"role":"user","content":"${'r'.repeat(100 * 1024)}"}]}`,
  ];

  const response = await postInChunks(proxyUrl, parts);
  assert.equal(response.status, 200);
  assert.equal(upstream.completeBodies.length, 2);
  assert.equal(upstream.completeBodies[0].toString('utf8'), parts.join(''));
  assert.ok(upstream.completeBodies[1].equals(upstream.completeBodies[0]), 'the retry replays the identical body');
});
