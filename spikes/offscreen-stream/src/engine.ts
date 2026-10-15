/**
 * The streaming chart engine — runs identically in a Web Worker (on an
 * OffscreenCanvas) or on the main thread (on a regular canvas), so the two
 * modes can be compared like for like.
 *
 * Data path, per WebSocket frame:   decode → ingest (pipeline) → mark dirty
 * Draw path, per animation frame:   [refresh view if dirty] → extent → draw
 *
 * Four ingest pipelines, to separate pond's cost from the floor:
 *  - `raw`      — decode straight into a typed ring buffer (or, with `buckets`,
 *                 into the buckets only). No pond. The floor.
 *  - `chunk`    — `LiveSeries.pushMany`; each appended chunk is read back value
 *                 by value (time, price) into the ring through the internal
 *                 `_onChunk` hook. Stands in for a column hand-over pond lacks.
 *  - `snapshot` — `LiveSeries.pushMany`, then on each dirty frame the public
 *                 path a chart uses today: `toTimeSeries()` → `fromTimeSeries`.
 *  - `view`     — `LiveSeries.pushMany` plus a `live.window()` `LiveView`, read
 *                 on each dirty frame through the public column readers
 *                 `keyColumn()` / `column()` (no `TimeSeries` built).
 */
import { LiveSeries } from 'pond-ts';
import { scaleLinear } from 'd3-scale';
import { drawLine } from '../../../packages/charts/src/line.js';
import {
  fromTimeSeries,
  type ChartSeries,
} from '../../../packages/charts/src/data.js';

export type Pipeline = 'raw' | 'chunk' | 'snapshot' | 'view';
/**
 * How the visible window is reduced to pixels.
 *  - `m4`      — the @pond-ts/charts line kernel: cull + M4-decimate the raw
 *                points on every frame. O(points in view) per frame.
 *  - `buckets` — fold each tick, as it arrives, into one min/max/first/last
 *                bucket per device-pixel column of the window. O(columns) per
 *                frame, whatever the rate or window length.
 */
export type DrawMode = 'm4' | 'buckets';

export interface EngineOptions {
  url: string;
  windowSec: number;
  pipeline: Pipeline;
  draw: DrawMode;
  width: number;
  height: number;
  dpr: number;
  /** Fallback frame pacing when the thread has no requestAnimationFrame. */
  targetFps: number;
}

export interface Stats {
  /** Wall seconds this report covers. */
  secs: number;
  /** Raw per-frame series for this report, so a harness can aggregate
   *  several reports exactly (not a median of per-second summaries). */
  raw: {
    intervals: number[];
    work: number[];
    draw: number[];
    view: number[];
    extent: number[];
    /** View time on frames that had new data only. */
    viewDirty: number[];
    latency: number[];
    ingestMs: number;
    ticks: number;
    msgs: number;
    bytes: number;
    dropped: number;
  };
  dpr: number;
  /** Frames painted per second. */
  fps: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  /** Share of frame intervals over the 120 fps budget (8.33 ms). */
  over120: number;
  /** Share of frame intervals over the 60 fps budget (16.7 ms). */
  over60: number;
  /** Per-frame work, ms (view refresh + extent + draw). */
  workAvg: number;
  workP95: number;
  drawAvg: number;
  viewAvg: number;
  extentAvg: number;
  /** Ingest cost: ms spent ingesting per second of wall time. */
  ingestMsPerSec: number;
  ticksPerSec: number;
  /** Ticks the server dropped because this client fell behind (backpressure). */
  droppedPerSec: number;
  msgsPerSec: number;
  mbPerSec: number;
  points: number;
  /** Buckets drawn (draw mode `buckets`). */
  columns: number;
  /** Wall clock → newest painted tick (same-machine clocks). */
  latencyP50: number;
  latencyP95: number;
  frames: number;
  usingRaf: boolean;
}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
] as const;

/** Contiguous x/y typed buffer with time eviction from the head. */
class Ring {
  x = new Float64Array(1 << 16);
  y = new Float64Array(1 << 16);
  head = 0;
  len = 0;
  append(t: number, v: number) {
    if (this.head + this.len === this.x.length) this.#make(this.len + 1);
    const i = this.head + this.len++;
    this.x[i] = t;
    this.y[i] = v;
  }
  evictBefore(cutoff: number) {
    const { x } = this;
    while (this.len > 0 && x[this.head]! < cutoff) {
      this.head++;
      this.len--;
    }
  }
  /** Compact to the front, growing only when more than half full. */
  #make(need: number) {
    let cap = this.x.length;
    while (need > cap / 2) cap *= 2;
    if (cap === this.x.length) {
      this.x.copyWithin(0, this.head, this.head + this.len);
      this.y.copyWithin(0, this.head, this.head + this.len);
    } else {
      const nx = new Float64Array(cap);
      const ny = new Float64Array(cap);
      nx.set(this.x.subarray(this.head, this.head + this.len));
      ny.set(this.y.subarray(this.head, this.head + this.len));
      this.x = nx;
      this.y = ny;
    }
    this.head = 0;
  }
  view(): ChartSeries {
    return {
      x: this.x.subarray(this.head, this.head + this.len),
      y: this.y.subarray(this.head, this.head + this.len),
      length: this.len,
    };
  }
}

/**
 * Incremental per-pixel-column reduction of the tape. Bucket `k` covers
 * `[k·ms, (k+1)·ms)`; a tick either updates the newest bucket or opens a new
 * one. Memory and draw cost are O(columns), independent of rate × window.
 */
class Buckets {
  cap: number;
  k: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
  first: Float64Array;
  last: Float64Array;
  n: Float64Array;
  head = 0;
  len = 0;
  ticks = 0;
  constructor(
    readonly ms: number,
    columns: number,
  ) {
    this.cap = columns * 2 + 16;
    this.k = new Float64Array(this.cap);
    this.lo = new Float64Array(this.cap);
    this.hi = new Float64Array(this.cap);
    this.first = new Float64Array(this.cap);
    this.last = new Float64Array(this.cap);
    this.n = new Float64Array(this.cap);
  }
  add(t: number, v: number) {
    const k = Math.floor(t / this.ms);
    this.ticks++;
    if (this.len > 0) {
      const i = (this.head + this.len - 1) % this.cap;
      if (this.k[i] === k) {
        if (v < this.lo[i]!) this.lo[i] = v;
        if (v > this.hi[i]!) this.hi[i] = v;
        this.last[i] = v;
        this.n[i]!++;
        return;
      }
    }
    if (this.len === this.cap) this.#drop();
    const i = (this.head + this.len++) % this.cap;
    this.k[i] = k;
    this.lo[i] = this.hi[i] = this.first[i] = this.last[i] = v;
    this.n[i] = 1;
  }
  evictBefore(cutoff: number) {
    const kc = Math.floor(cutoff / this.ms);
    while (this.len > 0 && this.k[this.head]! < kc) this.#drop();
  }
  #drop() {
    this.ticks -= this.n[this.head]!;
    this.head = (this.head + 1) % this.cap;
    this.len--;
  }
}

const now = () => performance.now();
const r2 = (v: number) => Math.round(v * 100) / 100;

function pct(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
const avg = (a: number[]) =>
  a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

export function startEngine(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  opts: EngineOptions,
  report: (s: Stats) => void,
): () => void {
  const { width, height, dpr, windowSec, pipeline } = opts;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d', {
    alpha: false,
  }) as CanvasRenderingContext2D;
  const windowMs = windowSec * 1000;

  const ring = new Ring();
  const plotWEarly = width - 8 - 64;
  const buckets =
    opts.draw === 'buckets' && pipeline !== 'snapshot' && pipeline !== 'view'
      ? new Buckets(
          windowMs / Math.round(plotWEarly * dpr),
          Math.round(plotWEarly * dpr),
        )
      : null;
  // `raw` + `buckets` keeps no point buffer at all: memory is O(columns).
  const keepPoints = !(pipeline === 'raw' && buckets);
  const live =
    pipeline === 'raw'
      ? null
      : new LiveSeries({
          name: 'tape',
          schema,
          retention: { maxAge: `${windowSec}s` },
        });
  // `view`: a LiveView over the same window, read through its public column
  // readers. It holds the window as per-tick events, so attaching it also
  // switches the LiveSeries onto its per-tick event fan-out.
  const liveView =
    pipeline === 'view' && live ? live.window(`${windowSec}s`) : null;
  if (pipeline === 'chunk' && live) {
    // Mirror every appended chunk into the ring, column-native.
    (live as any)._onChunk((store: any) => {
      const price = store.columns.get('price');
      for (let i = 0; i < store.length; i++) {
        const t = store.beginAt(i);
        const v = price.read(i);
        ring.append(t, v);
        buckets?.add(t, v);
      }
    });
  }

  const fromLiveSeries = pipeline === 'snapshot' || pipeline === 'view';
  let latestT = -Infinity;
  let droppedTotal = 0;
  let droppedReported = 0;
  let latestArrival = 0;
  let dirty = false;
  let snapshotView: ChartSeries = {
    x: new Float64Array(0),
    y: new Float64Array(0),
    length: 0,
  };

  // Window counters, reset each report.
  let ingestMs = 0;
  let ticks = 0;
  let msgs = 0;
  let bytes = 0;
  const frameIntervals: number[] = [];
  const work: number[] = [];
  const draws: number[] = [];
  const views: number[] = [];
  const viewsDirty: number[] = [];
  const extents: number[] = [];
  const latencies: number[] = [];
  let frames = 0;

  const ws = new WebSocket(opts.url);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    const t0 = now();
    const buf = new Float64Array(ev.data as ArrayBuffer);
    const n = buf[1]!;
    droppedTotal = Math.max(droppedTotal, buf[2]!);
    if (pipeline === 'raw') {
      for (let i = 0; i < n; i++) {
        const t = buf[3 + i * 3]!;
        const v = buf[4 + i * 3]!;
        if (keepPoints) ring.append(t, v);
        buckets?.add(t, v);
      }
    } else {
      const rows = new Array(n);
      for (let i = 0; i < n; i++) {
        const o = 3 + i * 3;
        rows[i] = [buf[o]!, buf[o + 1]!, buf[o + 2]!];
      }
      live!.pushMany(rows as any);
    }
    if (n > 0) {
      latestT = buf[3 + (n - 1) * 3]!;
      if (!fromLiveSeries) ring.evictBefore(latestT - windowMs);
      buckets?.evictBefore(latestT - windowMs - buckets.ms);
    }
    latestArrival = t0;
    dirty = true;
    ingestMs += now() - t0;
    ticks += n;
    msgs += 1;
    bytes += buf.byteLength;
  };

  const padL = 8;
  const padR = 64;
  const padT = 8;
  const padB = 22;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  let yLo = 0;
  let yHi = 1;
  let lastFrame = 0;
  let painted = -Infinity;

  function frame() {
    const f0 = now();
    if (lastFrame) frameIntervals.push(f0 - lastFrame);
    lastFrame = f0;

    // 1. View: the visible series as typed arrays.
    let v0 = now();
    if (pipeline === 'snapshot' && dirty) {
      snapshotView = fromTimeSeries(live!.toTimeSeries(), 'price');
    } else if (pipeline === 'view' && dirty) {
      const x = liveView!.keyColumn().begin;
      const col = liveView!.column('price') as any;
      let y: Float64Array;
      if (typeof col.toFloat64Array === 'function') y = col.toFloat64Array();
      else {
        y = new Float64Array(x.length);
        for (let i = 0; i < x.length; i++) y[i] = col.read(i) ?? NaN;
      }
      snapshotView = { x, y, length: x.length };
    }
    const fromLive = pipeline === 'snapshot' || pipeline === 'view';
    const view = fromLive ? snapshotView : ring.view();
    const vt = now() - v0;
    views.push(vt);
    if (dirty) viewsDirty.push(vt);

    // 2. Extent — only when data changed (the window is a moving max/min).
    v0 = now();
    if (dirty && buckets && buckets.len > 0) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < buckets.len; j++) {
        const i = (buckets.head + j) % buckets.cap;
        if (buckets.lo[i]! < lo) lo = buckets.lo[i]!;
        if (buckets.hi[i]! > hi) hi = buckets.hi[i]!;
      }
      const pad = (hi - lo) * 0.05 || 1;
      yLo = lo - pad;
      yHi = hi + pad;
    } else if (dirty && view.length > 0) {
      let lo = Infinity;
      let hi = -Infinity;
      const ys = view.y;
      for (let i = 0; i < view.length; i++) {
        const y = ys[i]!;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      const pad = (hi - lo) * 0.05 || 1;
      yLo = lo - pad;
      yHi = hi + pad;
    }
    extents.push(now() - v0);
    dirty = false;

    // 3. Draw. The x edge is extrapolated from the newest tick's arrival, so
    // the tape scrolls smoothly between 16 ms frames instead of stepping.
    v0 = now();
    const edge =
      latestT === -Infinity ? Date.now() : latestT + (now() - latestArrival);
    // Fresh scale objects per frame, as ChartContainer does: the charts M4
    // cache is keyed on (series identity, xScale identity), so mutating one
    // scale in place would let an unchanged series reuse a polyline binned
    // for an older domain.
    const xScale = scaleLinear()
      .domain([edge - windowMs, edge])
      .range([0, plotW]);
    const yScale = scaleLinear().domain([yLo, yHi]).range([plotH, 0]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, width, height);

    // Grid + labels.
    ctx.strokeStyle = '#1f2933';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#7b8794';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    for (const t of yScale.ticks(6)) {
      const py = Math.round(padT + yScale(t)) + 0.5;
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.fillText(t.toFixed(3), padL + plotW + 6, py);
    }
    const step = niceStep(windowMs / 6);
    const firstTick = Math.ceil((edge - windowMs) / step) * step;
    ctx.textBaseline = 'top';
    for (let t = firstTick; t <= edge; t += step) {
      const px = Math.round(padL + xScale(t)) + 0.5;
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.fillText(clock(t, step), px - 22, padT + plotH + 5);
    }
    ctx.stroke();

    // The series, through the real @pond-ts/charts line kernel (M4 decimated).
    ctx.save();
    ctx.translate(padL, padT);
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();
    if (buckets) {
      drawBuckets(ctx, buckets, xScale, yScale);
    } else if (view.length > 0) {
      drawLine(ctx, view, xScale as any, yScale as any, {
        color: '#f5b740',
        width: 1.25,
      });
    }
    ctx.restore();
    const lastV = buckets
      ? buckets.len > 0
        ? buckets.last[(buckets.head + buckets.len - 1) % buckets.cap]!
        : undefined
      : view.length > 0
        ? view.y[view.length - 1]!
        : undefined;
    if (lastV !== undefined) {
      const last = lastV;
      const py = padT + yScale(last);
      ctx.fillStyle = '#f5b740';
      ctx.fillRect(padL + plotW + 2, py - 8, padR - 4, 16);
      ctx.fillStyle = '#0b0f14';
      ctx.textBaseline = 'middle';
      ctx.fillText(last.toFixed(3), padL + plotW + 6, py);
      painted = latestT;
    }
    draws.push(now() - v0);
    work.push(now() - f0);
    // Delay: wall clock at the end of this frame's JS, minus the newest tick
    // drawn. The server stamps the newest tick of each frame with its send
    // time, so this covers network + queueing + ingest + time since the last
    // batch arrived + this frame's work. It stops before the browser
    // composites and the display shows the frame.
    if (painted > -Infinity) latencies.push(Date.now() - painted);
    frames++;
  }

  const hasRaf =
    typeof (globalThis as any).requestAnimationFrame === 'function';
  let running = true;
  const loop = () => {
    if (!running) return;
    frame();
    if (hasRaf) requestAnimationFrame(loop);
    else setTimeout(loop, 1000 / opts.targetFps);
  };
  loop();

  let lastReport = now();
  const reporter = setInterval(() => {
    const t = now();
    const secs = (t - lastReport) / 1000;
    lastReport = t;
    const fi = [...frameIntervals].sort((a, b) => a - b);
    const wk = [...work].sort((a, b) => a - b);
    const lat = [...latencies].sort((a, b) => a - b);
    report({
      secs,
      raw: {
        intervals: frameIntervals.map(r2),
        work: work.map(r2),
        draw: draws.map(r2),
        view: views.map(r2),
        extent: extents.map(r2),
        viewDirty: viewsDirty.map(r2),
        latency: latencies.map(r2),
        ingestMs,
        ticks,
        msgs,
        bytes,
        dropped: droppedTotal - droppedReported,
      },
      dpr,
      fps: frameIntervals.length / secs,
      frameP50: pct(fi, 0.5),
      frameP95: pct(fi, 0.95),
      frameMax: fi.length ? fi[fi.length - 1]! : 0,
      over120: fi.length
        ? fi.filter((d) => d > 1000 / 120 + 1).length / fi.length
        : 0,
      over60: fi.length
        ? fi.filter((d) => d > 1000 / 60 + 1).length / fi.length
        : 0,
      workAvg: avg(work),
      workP95: pct(wk, 0.95),
      drawAvg: avg(draws),
      viewAvg: avg(views),
      extentAvg: avg(extents),
      ingestMsPerSec: ingestMs / secs,
      ticksPerSec: ticks / secs,
      droppedPerSec: (droppedTotal - droppedReported) / secs,
      msgsPerSec: msgs / secs,
      mbPerSec: bytes / secs / 1e6,
      points:
        pipeline === 'snapshot'
          ? live!.length
          : pipeline === 'view'
            ? snapshotView.length
            : keepPoints
              ? ring.len
              : buckets!.ticks,
      columns: buckets ? buckets.len : 0,
      latencyP50: pct(lat, 0.5),
      latencyP95: pct(lat, 0.95),
      frames,
      usingRaf: hasRaf,
    });
    frameIntervals.length = work.length = draws.length = views.length = 0;
    extents.length = latencies.length = viewsDirty.length = 0;
    ingestMs = ticks = msgs = bytes = 0;
    droppedReported = droppedTotal;
  }, 1000);

  return () => {
    running = false;
    clearInterval(reporter);
    ws.close();
  };
}

/** One polyline through every bucket: first → low → high → last per column. */
function drawBuckets(
  ctx: CanvasRenderingContext2D,
  b: Buckets,
  xScale: (t: number) => number,
  yScale: (v: number) => number,
) {
  ctx.strokeStyle = '#f5b740';
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let j = 0; j < b.len; j++) {
    const i = (b.head + j) % b.cap;
    const x = xScale((b.k[i]! + 0.5) * b.ms);
    const f = yScale(b.first[i]!);
    if (j === 0) ctx.moveTo(x, f);
    else ctx.lineTo(x, f);
    if (b.n[i]! > 1) {
      ctx.lineTo(x, yScale(b.lo[i]!));
      ctx.lineTo(x, yScale(b.hi[i]!));
      ctx.lineTo(x, yScale(b.last[i]!));
    }
  }
  ctx.stroke();
}

function niceStep(ms: number) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * 1000);
  return steps.find((s) => s >= ms) ?? 600_000;
}

function clock(t: number, step: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return step < 60_000
    ? `${p(d.getMinutes())}:${p(d.getSeconds())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}`;
}
