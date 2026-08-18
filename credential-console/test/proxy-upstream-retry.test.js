import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { handleClaudeProxy } from '../lib/proxy.js';

const DEVICE_TOKEN = 'device-retry-token';
const DEVICE = {
  id: 'device-retry-test',
  account_id: 'account-retry-test',
  machine_id: 'machine-retry-test-0001',
  member_label: 'retry@example.com',
};
const ACCOUNT = {
  id: DEVICE.account_id,
  provider: 'claude',
  alias: 'claude-retry-account',
  status: 'healthy',
  expires_at: null,
};

// A body large enough to span multiple chunks, so a retry that fails to replay
// the buffered copy cannot accidentally pass.
const PAYLOAD = Buffer.from(JSON.stringify({
  model: 'claude-opus-4-8',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }],
}));

function storeFixture() {
  return {
    deviceByToken(token) {
      return token === DEVICE_TOKEN ? DEVICE : null;
    },
    accountById(id) {
      return id === ACCOUNT.id ? ACCOUNT : null;
    },
    accountCredential() {
      return { oauth_token: 'upstream-retry-credential' };
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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startHarness(t, upstreamHandler) {
  const upstream = http.createServer((req, res) => {
    Promise.resolve(upstreamHandler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    Promise.resolve(handleClaudeProxy(req, res, {
      store: storeFixture(),
      upstreamBaseUrl: upstreamUrl,
    })).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await Promise.all([close(proxy), close(upstream)]);
  });
  return proxyUrl;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(url), {
      method: 'POST',
      headers: {
        'X-Api-Key': DEVICE_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks),
      }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(body);
  });
}

// Regression guard for the 2026-08-18 incident: the retry path buffered the
// request body but replayed `null`, so every retried attempt was sent with the
// original content-length and no payload. Those requests never completed - they
// hung until the client gave up minutes later, which is strictly worse than
// surfacing the upstream 529. The retry must replay the body byte for byte.
test('a transient upstream 529 is retried with the request body replayed in full', { timeout: 20_000 }, async (t) => {
  const received = [];
  const proxyUrl = await startHarness(t, async (req, res) => {
    received.push(await readBody(req));
    if (received.length === 1) {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attempts: received.length }));
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, PAYLOAD);

  assert.equal(response.status, 200, 'the client should see the successful retry, not the upstream 529');
  assert.equal(received.length, 2, 'the proxy should have retried exactly once');
  assert.equal(received[0].length, PAYLOAD.length, 'the first attempt must carry the whole body');
  assert.equal(received[1].length, PAYLOAD.length, 'the retry must carry the whole body, not an empty one');
  assert.ok(received[1].equals(received[0]), 'the retry must replay the identical body');
});

test('a transient upstream 503 is retried the same way', { timeout: 20_000 }, async (t) => {
  const received = [];
  const proxyUrl = await startHarness(t, async (req, res) => {
    received.push(await readBody(req));
    if (received.length === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'unavailable' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, PAYLOAD);

  assert.equal(response.status, 200);
  assert.equal(received.length, 2);
  assert.ok(received[1].equals(received[0]));
});

test('a persistently overloaded upstream surfaces 529 after the attempt budget', { timeout: 30_000 }, async (t) => {
  const received = [];
  const proxyUrl = await startHarness(t, async (req, res) => {
    received.push(await readBody(req));
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  });

  const response = await post(`${proxyUrl}/claude/v1/messages`, PAYLOAD);

  assert.equal(response.status, 529, 'the upstream status must still reach the client once retries are exhausted');
  assert.equal(received.length, 3, 'the proxy should stop after MAX_UPSTREAM_ATTEMPTS');
  for (const body of received) {
    assert.equal(body.length, PAYLOAD.length, 'every attempt must carry the whole body');
  }
});
