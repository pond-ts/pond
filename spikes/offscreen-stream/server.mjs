// Synthetic market-data WebSocket server + static file host for the
// offscreen-stream spike. One connection = one independent tick stream.
//
//   ws://host/stream?rate=<ticks/s>&interval=<ms>&prefill=<seconds>
//
// Every `interval` ms (default 16) it sends one binary frame:
//   Float64Array [sendTimeMs, n, t0, price0, size0, t1, price1, size1, …]
// Tick times are spread evenly across the interval (fractional ms), so the
// stream is strictly time-ordered. The tick count per frame is drift-corrected
// against wall time so the delivered rate is exact even when Node's timer
// jitters. `prefill` first sends that many seconds of history (the
// "snapshot, then stream" shape a real feed has), in 50k-tick frames.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
};

function gauss() {
  return (
    Math.sqrt(-2 * Math.log(1 - Math.random())) *
    Math.cos(2 * Math.PI * Math.random())
  );
}

/** A geometric random walk with occasional bursts — enough texture to look like a tape. */
function makeTape(start) {
  let price = 100;
  let vol = 0.00002;
  return (n, t0, t1, out, offset) => {
    const step = (t1 - t0) / n;
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.0005) vol = 0.00002 * (1 + 4 * Math.random());
      price *= Math.exp(vol * gauss());
      const o = offset + i * 3;
      out[o] = t0 + step * (i + 1);
      out[o + 1] = price;
      out[o + 2] = 1 + Math.floor(Math.random() * 100);
    }
  };
}

export function startServer({ port = 8787 } = {}) {
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    const root = file === 'index.html' ? join(here, 'src') : join(here, 'dist');
    try {
      const body = await readFile(join(root, file));
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
    const interval = Number(q.get('interval') ?? 16);
    const prefill = Number(q.get('prefill') ?? 0);
    const tape = makeTape();
    const start = Date.now();
    let lastT = start - prefill * 1000;

    // History first, in bounded frames.
    let owed = Math.round(rate * prefill);
    const CHUNK = 50_000;
    while (owed > 0) {
      const n = Math.min(CHUNK, owed);
      const t1 = lastT + (n / rate) * 1000;
      const buf = new Float64Array(2 + n * 3);
      buf[0] = Date.now();
      buf[1] = n;
      tape(n, lastT, t1, buf, 2);
      ws.send(buf);
      lastT = t1;
      owed -= n;
    }

    let sent = 0;
    const live0 = Date.now();
    lastT = Math.max(lastT, live0);
    const timer = setInterval(() => {
      const now = Date.now();
      const due = Math.floor(((now - live0) / 1000) * rate);
      const n = due - sent;
      if (n <= 0 || now <= lastT) return;
      // Don't let a slow client balloon server memory: skip a frame while the
      // socket has > 32MB queued (reported as a backpressure count).
      if (ws.bufferedAmount > 32 * 1024 * 1024) return;
      const buf = new Float64Array(2 + n * 3);
      buf[0] = now;
      buf[1] = n;
      tape(n, lastT, now, buf, 2);
      lastT = now;
      sent = due;
      ws.send(buf);
    }, interval);
    ws.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) =>
    server.listen(port, () =>
      resolve({ server, wss, port: server.address().port }),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  startServer({ port }).then(() =>
    console.log(`offscreen-stream on http://localhost:${port}/`),
  );
}
