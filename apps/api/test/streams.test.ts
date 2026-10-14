import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD, SETUP_TOKEN, makeApp } from './helpers.ts';

/** The event stream needs a real socket, so these tests run the app on an ephemeral port. */
const open: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.closeAllConnections();
          s.close(() => r(null));
        }),
    ),
  );
});

async function serve() {
  const h = makeApp();
  const server = http.createServer(h.app);
  open.push(server);
  const port = await new Promise<number>((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)),
  );
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return { h, port, cookie };
}

/** A minimal event-stream client that records what it receives and when the stream ends. */
function stream(port: number, cookie: string) {
  let received = '';
  let ended = false;
  const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/stream', headers: { cookie } });
  const done = new Promise<number>((resolve) => {
    req.on('response', (res) => {
      res.on('data', (d: Buffer) => (received += d));
      res.on('end', () => (ended = true));
      res.on('close', () => (ended = true));
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => (ended = true));
  });
  return {
    status: done,
    text: () => received,
    ended: () => ended,
    close: () => req.destroy(),
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('event stream', () => {
  it('sends a ready event and then a nudge for every collection', async () => {
    const { h, port, cookie } = await serve();
    const s = stream(port, cookie);
    expect(await s.status).toBe(200);
    await until(() => s.text().includes('event: ready'));
    h.collector.emit('update');
    await until(() => s.text().includes('event: update'));
    expect(s.text()).toMatch(/event: update\ndata: \{"at":\d+\}\n\n/);
    s.close();
  });

  it('requires a session', async () => {
    const { port } = await serve();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/stream`);
    expect(res.status).toBe(401);
  });

  it('stops sending to a session that has expired', async () => {
    const { h, port, cookie } = await serve();
    const s = stream(port, cookie);
    await s.status;
    await until(() => s.text().includes('event: ready'));
    h.time.t += h.ctx.cfg.sessionTtlMs + 1000;
    h.collector.emit('update');
    await until(() => s.ended());
    expect(s.text()).not.toContain('event: update');
  });

  it('ends every stream when the server shuts down', async () => {
    const { h, port, cookie } = await serve();
    const streams = [stream(port, cookie), stream(port, cookie), stream(port, cookie)];
    await Promise.all(streams.map((s) => s.status));
    h.collector.emit('shutdown');
    await until(() => streams.every((s) => s.ended()));
  });

  it('frees its slot when a client leaves, so the connection limit cannot be exhausted by churn', async () => {
    const { port, cookie } = await serve();
    const first = Array.from({ length: 20 }, () => stream(port, cookie));
    expect((await Promise.all(first.map((s) => s.status))).every((c) => c === 200)).toBe(true);

    const refused = stream(port, cookie);
    expect(await refused.status).toBe(503);

    first[0]!.close();
    first[1]!.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = stream(port, cookie);
    expect(await again.status).toBe(200);
    first.forEach((s) => s.close());
    again.close();
  });

  it('does not leak listeners when streams come and go', async () => {
    const { h, port, cookie } = await serve();
    const before = h.collector.listenerCount('update');
    for (let i = 0; i < 10; i++) {
      const s = stream(port, cookie);
      await s.status;
      s.close();
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(h.collector.listenerCount('update')).toBe(before);
    expect(h.collector.listenerCount('shutdown')).toBe(0);
  });

  it('does not buffer without limit for a client that stops reading', async () => {
    const { h, port, cookie } = await serve();
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((r) => socket.on('connect', () => r()));
    socket.write(`GET /api/v1/stream HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\n\r\n`);
    socket.pause(); // from here on the client never reads
    await new Promise((r) => setTimeout(r, 200));

    for (let i = 0; i < 400_000; i++) h.collector.emit('update');
    await new Promise((r) => setTimeout(r, 300));
    // The server gave up on the stalled client instead of queueing for it.
    const open = await new Promise<boolean>((resolve) => {
      const probe = stream(port, cookie);
      probe.status.then((c) => {
        probe.close();
        resolve(c === 200);
      });
    });
    expect(open).toBe(true); // its slot was freed (or never exhausted)
    expect(h.collector.listenerCount('update')).toBeLessThanOrEqual(2);
    socket.destroy();
  }, 20_000);
});
