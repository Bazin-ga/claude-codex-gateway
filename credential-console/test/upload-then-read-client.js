import net from 'node:net';

/**
 * A client that sends its whole body before it reads a byte of the response,
 * the way Claude Code does over a real network, and reports whether the server
 * let it finish.
 *
 * A reset that reaches such a client before it reads loses the response, so
 * the client sees ECONNRESET where the server sent a refusal. On loopback a
 * well-behaved Node client usually reads the early response anyway and hides
 * the problem; this one makes "the server closed while I was still writing"
 * an observable result instead of a race.
 *
 * @returns {Promise<{ closedEarly: boolean, error: string|null, status: number|null, body: string }>}
 */
export function uploadThenRead(url, path, headers, body, { chunkBytes = 64 * 1024, gapMs = 5 } = {}) {
  const target = new URL(url);
  const payload = Buffer.from(body);
  return new Promise((resolve) => {
    const socket = net.connect(Number(target.port), target.hostname);
    const received = [];
    let finishedWriting = false;
    let closedEarly = false;
    let error = null;
    socket.on('data', (chunk) => received.push(chunk));
    socket.on('end', () => {
      if (!finishedWriting) closedEarly = true;
    });
    socket.on('error', (err) => {
      error ??= err.code ?? err.message;
      if (!finishedWriting) closedEarly = true;
    });
    socket.on('close', () => {
      if (!finishedWriting) closedEarly = true;
      const raw = Buffer.concat(received).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1];
      resolve({
        closedEarly,
        error,
        status: status ? Number(status) : null,
        body: split >= 0 ? raw.slice(split + 4) : '',
      });
    });
    socket.once('connect', async () => {
      const head = [`POST ${path} HTTP/1.1`, `Host: ${target.host}`, `Content-Length: ${payload.length}`];
      for (const [name, value] of Object.entries(headers)) head.push(`${name}: ${value}`);
      socket.write(`${head.join('\r\n')}\r\n\r\n`);
      for (let offset = 0; offset < payload.length; offset += chunkBytes) {
        if (socket.destroyed || closedEarly) return;
        // Set before the last write: the server cannot have read it, let alone
        // answered and closed, until this write has gone out.
        if (offset + chunkBytes >= payload.length) finishedWriting = true;
        const more = socket.write(payload.subarray(offset, offset + chunkBytes));
        if (!more) await new Promise((r) => socket.once('drain', r));
        await new Promise((r) => setTimeout(r, gapMs));
      }
    });
  });
}
