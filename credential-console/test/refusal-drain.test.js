import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { refuseAfterDraining, sendJson } from '../lib/http.js';
import { uploadThenRead } from './upload-then-read-client.js';

async function refusingServer(t, options) {
  const seen = { sentAfterBytes: [] };
  const server = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk) => { bytes += chunk.length; });
    refuseAfterDraining(req, res, () => {
      seen.sentAfterBytes.push(bytes);
      sendJson(res, 403, { error: 'refused' }, { Connection: 'close' });
    }, options);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('the refusal goes out once the whole body has been read', async (t) => {
  const { url, seen } = await refusingServer(t, { limitBytes: 32 * 1024 * 1024 });
  const body = 'b'.repeat(768 * 1024);
  const result = await uploadThenRead(url, '/', {}, body);
  assert.equal(result.closedEarly, false);
  assert.equal(result.status, 403);
  assert.deepEqual(seen.sentAfterBytes, [body.length]);
});

test('a body past the drain limit is not read to the end: the refusal is sent and the connection closed', async (t) => {
  const { url, seen } = await refusingServer(t, { limitBytes: 128 * 1024 });
  const result = await uploadThenRead(url, '/', {}, 'b'.repeat(2 * 1024 * 1024));
  assert.equal(result.closedEarly, true, 'the server stopped reading');
  assert.equal(seen.sentAfterBytes.length, 1);
  assert.ok(seen.sentAfterBytes[0] < 2 * 1024 * 1024);
});

test('a body that stops arriving is given up on after the timeout', async (t) => {
  const { url, seen } = await refusingServer(t, { limitBytes: 32 * 1024 * 1024, timeoutMs: 200 });
  const { port } = new URL(url);
  const status = await new Promise((resolve) => {
    const req = http.request({ port, method: 'POST', path: '/', headers: { 'content-length': 1000 } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => {});
    // Ten bytes of a thousand, and then nothing.
    req.write('0123456789');
  });
  assert.equal(status, 403);
  assert.deepEqual(seen.sentAfterBytes, [10]);
});

test('a client that leaves while its body is drained is sent nothing', async (t) => {
  const { url, seen } = await refusingServer(t, { limitBytes: 32 * 1024 * 1024 });
  const { port } = new URL(url);
  await new Promise((resolve) => {
    const req = http.request({ port, method: 'POST', path: '/', headers: { 'content-length': 1000 } });
    req.on('error', () => {});
    req.write('0123456789', () => setTimeout(() => { req.destroy(); resolve(); }, 50));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(seen.sentAfterBytes, []);
});
