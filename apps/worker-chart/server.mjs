// A made-up market feed over a WebSocket, plus a static file host.
//
//   ws://host/stream?rate=<ticks a second>&prefill=<seconds of history>
//
// Every 16 ms it sends the ticks due since the last send, as binary messages:
//   Float64Array [sendTime, n, droppedSoFar, sentSoFar, time0, price0, size0, time1, …]
// sentSoFar counts the ticks sent before this message, so the browser can
// tell if any went missing. Times are epoch ms, spread evenly, so they only
// go up. `prefill` starts the feed that many seconds in the past, the way a
// real feed sends a snapshot and then streams. No message holds more than
// 50,000 ticks.
//
// History goes out at most 100,000 ticks a round, and only while the socket
// holds less than about half a second of ticks (at least 256 KB), so it
// never floods the browser. Then the feed catches up with the clock the
// same way. If the browser took the history no faster than the live rate,
// it never will; if faster, it gets twice the time catching up should take,
// plus 2 s. After that, a browser that falls behind (the socket over the
// limit) has the ticks due dropped and counted, as a real feed would
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
const CATCH_UP = 100_000; // ticks per round, at most, while behind
const HEADER = 4; // sendTime, n, droppedSoFar, sentSoFar

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

function frame(tape, n, from, to, dropped, sent) {
  const buf = new Float64Array(HEADER + n * 3);
  buf[0] = Date.now();
  buf[1] = n;
  buf[2] = dropped;
  buf[3] = sent;
  tape(n, from, to, buf, HEADER);
  return buf;
}

/**
 * Sends n ticks spread over (from, to], at most CHUNK to a message.
 * `sent` is the count of ticks sent before these.
 */
function sendTicks(ws, tape, n, from, to, dropped, sent) {
  for (let i = 0; i < n; i += CHUNK) {
    const k = Math.min(CHUNK, n - i);
    const a = from + ((to - from) * i) / n;
    const b = from + ((to - from) * (i + k)) / n;
    ws.send(frame(tape, k, a, b, dropped, sent + i));
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

    // Bytes the socket may hold waiting to go: about half a second of ticks
    // (24 bytes each), and at least 256 KB.
    const full = Math.max(256 * 1024, rate * 0.5 * 24);

    // The feed starts `prefill` seconds ago. Ticks due are counted from the
    // wall clock, so the rate stays exact when the timer fires late, and
    // nothing is missed between history and live.
    const start = Date.now();
    const origin = start - prefill * 1000;
    let last = origin; // time of the last tick generated
    let generated = 0; // ticks generated (sent or dropped)
    let sent = 0;
    let dropped = 0;
    let deadline = Infinity; // when catching up must be over
    let live = false; // caught up, or out of time to: drop if behind
    const timer = setInterval(() => {
      const now = Date.now();
      const due = Math.floor(((now - origin) / 1000) * rate) - generated;
      if (due <= 0 || now <= last) return;
      // History has all gone. The rate the browser took it at says how long
      // catching up with the clock should take, if it can at all.
      if (last >= start && deadline === Infinity) {
        const took = now - start;
        const readRate = (sent / took) * 1000;
        deadline =
          readRate <= rate
            ? now
            : now + (2 * took * rate) / (readRate - rate) + 2000;
      }
      if (now > deadline) live = true;
      if (ws.bufferedAmount > full) {
        // Full socket: still catching up, so wait; or live and fallen
        // behind, so drop what's due.
        if (live) {
          dropped += due;
          generated += due;
          last = now;
        }
        return;
      }
      const n = Math.min(due, CATCH_UP);
      const to = n === due ? now : last + ((now - last) * n) / due;
      sendTicks(ws, tape, n, last, to, dropped, sent);
      generated += n;
      sent += n;
      last = to;
      // Caught up: nothing left due and the socket nearly empty.
      if (n === due && ws.bufferedAmount < full / 4) live = true;
    }, INTERVAL_MS);
    ws.on('close', () => clearInterval(timer));
    // A malformed frame from a client emits 'error'; unhandled, it would
    // take the whole server down.
    ws.on('error', () => clearInterval(timer));
  });

  return new Promise((resolve) =>
    server.listen(port, () => resolve({ server, port: server.address().port })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  startServer({ port }).then(({ port }) =>
    console.log(`worker-chart on http://localhost:${port}/`),
  );
}
