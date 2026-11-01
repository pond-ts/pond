// The render worker: keeps the data and draws every frame onto the
// OffscreenCanvas the page handed over. The page never touches the data.
import { LiveSeries, TimeSeries } from 'pond-ts';
import { Buckets, drawBuckets } from './buckets.js';
import type { Batch, FromRender, Tick, ToRender } from './messages.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
] as const;

const PAD = { left: 8, right: 64, top: 8, bottom: 22 };
const COLOR = {
  background: '#0b0f14',
  grid: '#1f2933',
  label: '#7b8794',
  line: '#f5b740',
  cursor: '#cbd2d9',
};

let ctx: OffscreenCanvasRenderingContext2D;
let live: LiveSeries<typeof schema>;
let buckets: Buckets;
let windowMs = 60_000;
let width = 0;
let height = 0;
let dpr = 1;

let newestTime = -Infinity; // time of the newest tick
let newestArrival = 0; // performance.now() when it arrived
let changed = false;
let yLow = 0;
let yHigh = 1;
let hovered: Tick | null = null; // the tick picked by the pointer

// Counters for the once-a-second stats message.
let frames = 0;
let ticks = 0;
let dropped = 0;
let pushMs = 0;
let foldMs = 0;
let frameMs = 0;
const delays: number[] = [];

const post = (msg: FromRender) => self.postMessage(msg);

self.onmessage = (ev: MessageEvent<ToRender>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    ctx = msg.canvas.getContext('2d', { alpha: false })!;
    windowMs = msg.windowMs;
    live = new LiveSeries({
      name: 'ticks',
      schema,
      retention: { maxAge: windowMs },
    });
    buckets = new Buckets(windowMs, msg.columns);
    resize(msg.width, msg.height, msg.dpr);
    msg.feed.onmessage = (m: MessageEvent<Batch>) => ingest(m.data);
    nextFrame();
    setInterval(report, 1000);
  } else if (msg.type === 'resize') {
    resize(msg.width, msg.height, msg.dpr);
  } else {
    pick(msg.x);
  }
};

function resize(w: number, h: number, ratio: number) {
  width = w;
  height = h;
  dpr = ratio;
  ctx.canvas.width = Math.round(w * ratio);
  ctx.canvas.height = Math.round(h * ratio);
}

function ingest(batch: Batch) {
  const n = batch.time.length;
  if (n === 0) return;
  const { time, price, size } = batch;
  const t0 = performance.now();
  // The live series keeps these arrays as they are, so nothing may write to
  // them after this line. Reading them, as the loop below does, is fine.
  live.pushSeries(
    TimeSeries.fromColumns({
      name: 'ticks',
      schema,
      columns: { time, price, size },
    }),
  );
  const t1 = performance.now();
  for (let i = 0; i < n; i++) buckets.add(time[i]!, price[i]!);
  buckets.evictBefore(time[n - 1]! - windowMs - buckets.ms);
  newestTime = time[n - 1]!;
  newestArrival = performance.now();
  changed = true;
  ticks += n;
  dropped = batch.dropped;
  pushMs += t1 - t0;
  foldMs += newestArrival - t1;
}

// Workers in current browsers have requestAnimationFrame; fall back to a
// timer where one doesn't.
const nextFrame = () =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(frame)
    : setTimeout(frame, 1000 / 60);

// Ticks arrive every 16 ms; between them, move the right edge on with the
// clock so the chart scrolls smoothly instead of in steps.
const rightEdge = (now: number) => newestTime + (now - newestArrival);

function frame() {
  nextFrame();
  const now = performance.now();
  if (newestTime === -Infinity || width <= PAD.left + PAD.right) return;

  if (changed) {
    const [lo, hi] = buckets.range()!;
    const pad = (hi - lo) * 0.05 || 1;
    yLow = lo - pad;
    yHigh = hi + pad;
    changed = false;
  }

  const edge = rightEdge(now);
  const start = edge - windowMs;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - start) / windowMs) * plotW;
  const y = (v: number) => PAD.top + ((yHigh - v) / (yHigh - yLow)) * plotH;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLOR.background;
  ctx.fillRect(0, 0, width, height);
  drawAxes(start, edge, x, y, plotW, plotH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, PAD.top, plotW, plotH);
  ctx.clip();
  ctx.strokeStyle = COLOR.line;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  drawBuckets(ctx, buckets, x, y);
  ctx.restore();

  const last = buckets.newest();
  if (last !== undefined) {
    ctx.fillStyle = COLOR.line;
    ctx.fillRect(PAD.left + plotW + 2, y(last) - 8, PAD.right - 4, 16);
    ctx.fillStyle = COLOR.background;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(last.toFixed(3), PAD.left + plotW + 6, y(last));
  }

  drawHover(start, x, y, plotH);

  frames++;
  frameMs += performance.now() - now;
  delays.push(Date.now() - newestTime);
}

/** Price lines and labels on the right, time lines and labels below. */
function drawAxes(
  start: number,
  edge: number,
  x: (t: number) => number,
  y: (v: number) => number,
  plotW: number,
  plotH: number,
) {
  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = COLOR.label;
  ctx.font = '11px ui-monospace, monospace';
  ctx.beginPath();

  const priceStep = niceStep((yHigh - yLow) / 6);
  const digits = Math.max(0, -Math.floor(Math.log10(priceStep)));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (
    let v = Math.ceil(yLow / priceStep) * priceStep;
    v <= yHigh;
    v += priceStep
  ) {
    const py = Math.round(y(v)) + 0.5;
    ctx.moveTo(PAD.left, py);
    ctx.lineTo(PAD.left + plotW, py);
    ctx.fillText(v.toFixed(digits), PAD.left + plotW + 6, py);
  }

  const timeStep = TIME_STEPS.find((s) => s >= windowMs / 6) ?? 600_000;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (
    let t = Math.ceil(start / timeStep) * timeStep;
    t <= edge;
    t += timeStep
  ) {
    const px = Math.round(x(t)) + 0.5;
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, PAD.top + plotH);
    ctx.fillText(clock(t), px, PAD.top + plotH + 5);
  }
  ctx.stroke();
}

/**
 * The pointer's x, sent by the page, becomes a time, and the live series
 * finds the tick at or before it. That tick stays picked until the pointer
 * moves again, so the cursor scrolls left with the data and the tooltip
 * holds still long enough to read. Looking up only when the pointer moves
 * also keeps lookups off the frame loop.
 */
function pick(px: number | null) {
  const plotW = width - PAD.left - PAD.right;
  const inside =
    px !== null &&
    newestTime > -Infinity &&
    px >= PAD.left &&
    px <= PAD.left + plotW;
  const start = rightEdge(performance.now()) - windowMs;
  const event = inside
    ? live.atOrBefore(start + ((px - PAD.left) / plotW) * windowMs)
    : undefined;
  hovered = event
    ? {
        time: event.begin(),
        price: event.get('price'),
        size: event.get('size'),
      }
    : null;
  post({ type: 'hover', tick: hovered });
}

/** The picked tick's cursor, until it scrolls out of the window. */
function drawHover(
  start: number,
  x: (t: number) => number,
  y: (v: number) => number,
  plotH: number,
) {
  if (hovered === null) return;
  if (hovered.time < start) {
    hovered = null;
    post({ type: 'hover', tick: null });
    return;
  }
  const px = Math.round(x(hovered.time)) + 0.5;
  ctx.strokeStyle = COLOR.cursor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, PAD.top);
  ctx.lineTo(px, PAD.top + plotH);
  ctx.stroke();
  ctx.fillStyle = COLOR.cursor;
  ctx.beginPath();
  ctx.arc(px, y(hovered.price), 3, 0, 2 * Math.PI);
  ctx.fill();
}

function report() {
  delays.sort((a, b) => a - b);
  post({
    type: 'stats',
    fps: frames,
    ticksPerSec: ticks,
    rows: live.length,
    delayMs: delays[Math.floor(delays.length / 2)] ?? 0,
    dropped,
    pushMs,
    foldMs,
    frameMs: frames ? frameMs / frames : 0,
  });
  frames = ticks = pushMs = foldMs = frameMs = delays.length = 0;
}

/** 1, 2 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power;
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map(
  (s) => s * 1000,
);

function clock(t: number) {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
