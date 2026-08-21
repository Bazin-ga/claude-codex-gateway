import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { sendHtml, sendJson, sendText } from '../lib/http.js';

const BIG = `<!doctype html><html><body>${'<p>content that repeats</p>'.repeat(400)}</body></html>`;

/** Round-trip through a real server so res.req and header handling are genuine. */
async function fetchWith(headers, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers });
    const raw = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      raw,
    };
  } finally {
    server.close();
    await new Promise((resolve) => server.on('close', resolve));
  }
}

// Node's fetch decodes automatically, so ask for a single encoding and decode by
// hand to assert on the bytes actually put on the wire.
async function rawFetch(acceptEncoding, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        { port, path: '/', headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
    await new Promise((resolve) => server.on('close', resolve));
  }
}

test('a large HTML response is brotli-compressed when the client accepts br', async () => {
  const { headers, body } = await rawFetch('br, gzip', (req, res) => sendHtml(res, 200, BIG));
  assert.equal(headers['content-encoding'], 'br');
  assert.equal(headers.vary, 'Accept-Encoding');
  assert.equal(brotliDecompressSync(body).toString('utf8'), BIG, 'decompresses to the original');
  assert.equal(Number(headers['content-length']), body.length, 'length describes the wire bytes');
  assert.ok(body.length < Buffer.byteLength(BIG) / 4, 'materially smaller');
});

test('gzip is used when br is not on offer', async () => {
  const { headers, body } = await rawFetch('gzip, deflate', (req, res) => sendHtml(res, 200, BIG));
  assert.equal(headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(body).toString('utf8'), BIG);
});

test('a client that accepts nothing still gets a correct, uncompressed response', async () => {
  const { headers, body } = await rawFetch(null, (req, res) => sendHtml(res, 200, BIG));
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(body.toString('utf8'), BIG);
  assert.equal(Number(headers['content-length']), Buffer.byteLength(BIG));
});

test('an unknown encoding is not guessed at', async () => {
  const { headers, body } = await rawFetch('zstd, compress', (req, res) => sendHtml(res, 200, BIG));
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(body.toString('utf8'), BIG);
});

test('small bodies are left alone', async () => {
  const small = '<p>tiny</p>';
  const { headers, body } = await rawFetch('br', (req, res) => sendHtml(res, 200, small));
  assert.equal(headers['content-encoding'], undefined, 'not worth the framing overhead');
  assert.equal(body.toString('utf8'), small);
  assert.equal(headers.vary, 'Accept-Encoding', 'still varies, so caches stay correct');
});

test('JSON and text responses compress on the same terms', async () => {
  const payload = { rows: Array.from({ length: 300 }, (_, i) => ({ i, label: 'repeated value' })) };
  const json = await rawFetch('br', (req, res) => sendJson(res, 200, payload));
  assert.equal(json.headers['content-encoding'], 'br');
  assert.deepEqual(JSON.parse(brotliDecompressSync(json.body).toString('utf8')), payload);

  const script = `// ${'x'.repeat(4000)}`;
  const text = await rawFetch('gzip', (req, res) => sendText(res, 200, script, 'text/javascript; charset=utf-8'));
  assert.equal(text.headers['content-encoding'], 'gzip');
  assert.equal(text.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(gunzipSync(text.body).toString('utf8'), script);
});

test('a caller that already encoded its body is not encoded again', async () => {
  const preEncoded = Buffer.from('already handled');
  const { headers, body } = await rawFetch('br', (req, res) => {
    sendText(res, 200, preEncoded.toString('utf8'), 'text/plain; charset=utf-8', {
      'Content-Encoding': 'identity',
    });
  });
  assert.equal(headers['content-encoding'], 'identity');
  assert.equal(body.toString('utf8'), 'already handled');
});

test('security headers and caller headers survive compression', async () => {
  const { headers } = await rawFetch('br', (req, res) => {
    sendText(res, 200, `// ${'y'.repeat(4000)}`, 'text/javascript; charset=utf-8', {
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: '"abc123"',
    });
  });
  assert.equal(headers['content-encoding'], 'br');
  assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable', 'caller header wins');
  assert.equal(headers.etag, '"abc123"');
  assert.equal(headers['x-content-type-options'], 'nosniff', 'baseHeaders still applied');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.ok(headers['content-security-policy'], 'CSP still present');
});

test('the response body is byte-identical after a full fetch round trip', async () => {
  // fetch() negotiates and decodes for us; the result must equal what we sent.
  const { raw, headers } = await fetchWith({}, (req, res) => sendHtml(res, 200, BIG));
  assert.equal(raw.toString('utf8'), BIG);
  assert.equal(headers['content-type'], 'text/html; charset=utf-8');
});
