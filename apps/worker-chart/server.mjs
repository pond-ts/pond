// A made-up market feed over a WebSocket, plus a static file host.
//
//   ws://host/stream?rate=<ticks a second>&prefill=<seconds of history>
//
// Every 16 ms it sends one binary message:
//   Float64Array [sendTime, n, droppedSoFar, time0, price0, size0, time1, …]
// Times are epoch ms, spread evenly across the 16 ms, so they only go up.
// `prefill` first sends that much history, the way a real feed sends a
// snapshot and then streams. No message holds more than 50,000 ticks.
//
// Once streaming, if the browser falls behind (more than 32 MB waiting on the
// socket), the ticks due are dropped and counted, as a real feed would
// conflate or disconnect rather than queue without limit.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
};
const INTERVAL_MS = 16;
const CHUNK = 50_000; // ticks per message, at most
const MAX_BUFFERED = 32 * 1024 * 1024;

function gauss() {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** A random walk with the odd burst of volatility. */
function makeTape() {
  let price = 100;
  let vol = 0.00002;
  return (n, from, to, out, offset) => {
    const step = (to - from) / n;
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.0005) vol = 0.00002 * (1 + 4 * Math.random());
      price *= Math.exp(vol * gauss());
      const o = offset + i * 3;
      out[o] = from + step * (i + 1);
      out[o + 1] = price;
      out[o + 2] = 1 + Math.floor(Math.random() * 100);
    }
  };
}

function frame(tape, n, from, to, dropped) {
  const buf = new Float64Array(3 + n * 3);
  buf[0] = Date.now();
  buf[1] = n;
  buf[2] = dropped;
  tape(n, from, to, buf, 3);
  return buf;
}

/** Sends n ticks spread over (from, to], at most CHUNK to a message. */
function sendTicks(ws, tape, n, from, to, dropped) {
  for (let i = 0; i < n; i += CHUNK) {
    const k = Math.min(CHUNK, n - i);
    const a = from + ((to - from) * i) / n;
    const b = from + ((to - from) * (i + k)) / n;
    ws.send(frame(tape, k, a, b, dropped));
  }
}

export function startServer({ port = 8787 } = {}) {
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    const dir = file === 'index.html' ? 'src' : 'dist';
    try {
      const body = await readFile(join(here, dir, file));
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({
    server,
    path: '/stream',
    perMessageDeflate: false,
  });
  wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const rate = Number(q.get('rate') ?? 10_000);
    const prefill = Number(q.get('prefill') ?? 0);
    const tape = makeTape();

    // History first: the last `prefill` seconds.
    const origin = Date.now();
    sendTicks(
      ws,
      tape,
      Math.round(rate * prefill),
      origin - prefill * 1000,
      origin,
      0,
    );

    // Then live, counted from where the history ended so nothing is missed.
    // The count comes from the wall clock, so the rate stays exact when the
    // timer fires late. While the history is still leaving the socket, ticks
    // are held and then sent as one catch-up; after that, a backed-up socket
    // drops them.
    let last = origin;
    let sent = 0;
    let dropped = 0;
    let caughtUp = false;
    const timer = setInterval(() => {
      const now = Date.now();
      const n = Math.floor(((now - origin) / 1000) * rate) - sent;
      if (n <= 0 || now <= last) return;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        if (!caughtUp) return;
        dropped += n;
      } else {
        caughtUp = true;
        sendTicks(ws, tape, n, last, now, dropped);
      }
      sent += n;
      last = now;
    }, INTERVAL_MS);
    ws.on('close', () => clearInterval(timer));
  });

  return new Promise((resolve) =>
    server.listen(port, () => resolve({ server, port: server.address().port })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  startServer({ port }).then(() =>
    console.log(`worker-chart on http://localhost:${port}/`),
  );
}
