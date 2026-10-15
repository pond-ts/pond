// Page side. Reads the scenario from the URL, starts the engine either in a
// worker (canvas control transferred) or right here on the main thread, and
// optionally keeps the main thread busy to simulate a heavy app.
import {
  startEngine,
  type DrawMode,
  type EngineOptions,
  type Pipeline,
  type Stats,
} from './engine.js';

const q = new URLSearchParams(location.search);
const mode = (q.get('mode') ?? 'worker') as 'worker' | 'main';
const rate = Number(q.get('rate') ?? 10_000);
const interval = Number(q.get('interval') ?? 16);
const windowSec = Number(q.get('window') ?? 60);
const pipeline = (q.get('pipeline') ?? 'chunk') as Pipeline;
const draw = (q.get('draw') ?? 'm4') as DrawMode;
const busy = Number(q.get('busy') ?? 0); // ms of main-thread work per 50 ms
const spin = Number(q.get('spin') ?? 0); // extra ms of work per chart frame
const prefill = q.has('prefill') ? Number(q.get('prefill')) : windowSec;

for (const [id, v] of Object.entries({
  mode,
  rate,
  interval,
  window: windowSec,
  pipeline,
  draw,
  busy,
})) {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  if (el) el.value = String(v);
}
document.getElementById('controls')!.addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement;
  q.set(el.id, el.value);
  location.search = q.toString();
});

const canvas = document.getElementById('chart') as HTMLCanvasElement;
const width = canvas.clientWidth;
const height = canvas.clientHeight;
const opts: EngineOptions = {
  url: `${location.origin.replace(/^http/, 'ws')}/stream?rate=${rate}&interval=${interval}&prefill=${prefill}`,
  windowSec,
  pipeline,
  draw,
  width,
  height,
  dpr: window.devicePixelRatio || 1,
  targetFps: 120,
  spin,
};

const w = window as any;
w.__stats = null as Stats | null;
// Every report kept, so a harness can take an exact run of consecutive ones.
w.__reports = [] as Stats[];
w.__mainReports = [] as unknown[];
const show = (s: Stats) => {
  w.__stats = s;
  w.__reports.push(s);
  const f = (n: number, d = 1) => n.toFixed(d);
  document.getElementById('stats')!.textContent = [
    `chart fps        ${f(s.fps, 0)}   (frame p50 ${f(s.frameP50)}ms  p95 ${f(s.frameP95)}ms  max ${f(s.frameMax)}ms)`,
    `missed frames    ${f(s.over120 * 100, 0)}% over 8.3ms   ${f(s.over60 * 100, 0)}% over 16.7ms`,
    `work / frame     ${f(s.workAvg, 2)}ms avg  ${f(s.workP95, 2)}ms p95  (view ${f(s.viewAvg, 2)}  extent ${f(s.extentAvg, 2)}  draw ${f(s.drawAvg, 2)})`,
    `ingest           ${f(s.ingestMsPerSec, 1)}ms per second  ${f(s.ticksPerSec, 0)} ticks/s  ${f(s.msgsPerSec, 0)} msgs/s  ${f(s.mbPerSec, 2)} MB/s${s.droppedPerSec > 0 ? `  DROPPED ${f(s.droppedPerSec, 0)}/s (client behind)` : ''}`,
    `points in view   ${s.points.toLocaleString()}${s.columns ? `  (${s.columns} pixel buckets)` : ''}`,
    `tick → pixel     ${f(s.latencyP50, 0)}ms p50  ${f(s.latencyP95, 0)}ms p95`,
    `thread           ${mode}${s.usingRaf ? '' : ' (no rAF in this thread: setTimeout pacing)'}`,
  ].join('\n');
};

if (mode === 'worker') {
  const off = canvas.transferControlToOffscreen();
  const worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => show(e.data as Stats);
  worker.postMessage({ canvas: off, opts }, [off]);
} else {
  startEngine(canvas, opts, show);
}

// Main-thread health: a JS-driven marker and an fps meter. If the main thread
// is blocked, this marker stutters, whatever the chart is doing.
const marker = document.getElementById('marker')!;
let mFrames = 0;
let mLast = performance.now();
const mIntervals: number[] = [];
let prev = 0;
// Timed with performance.now() at callback time, the same clock the chart
// uses, so on the main thread the two meters see the same frames the same way.
const tick = () => {
  const t = performance.now();
  if (prev) mIntervals.push(t - prev);
  prev = t;
  mFrames++;
  marker.style.transform = `translateX(${((t / 4) % 300).toFixed(1)}px)`;
  if (t - mLast >= 1000) {
    w.__mainReports.push({
      secs: (t - mLast) / 1000,
      intervals: mIntervals.map((v) => Math.round(v * 100) / 100),
    });
    const sorted = mIntervals.sort((a, b) => a - b);
    w.__main = {
      fps: (mFrames * 1000) / (t - mLast),
      frameP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      frameMax: sorted[sorted.length - 1] ?? 0,
    };
    document.getElementById('mainfps')!.textContent =
      `page fps ${w.__main.fps.toFixed(0)}  (p95 ${w.__main.frameP95.toFixed(1)}ms, max ${w.__main.frameMax.toFixed(1)}ms)`;
    mFrames = 0;
    mLast = t;
    mIntervals.length = 0;
  }
  requestAnimationFrame(tick);
};
// `meter=0` turns the page meter off: in an uncapped-frame-rate browser its
// rAF loop would spin and steal the CPU the chart is being measured on.
if (q.get('meter') !== '0') requestAnimationFrame(tick);

// Simulated heavy app: `busy` ms of synchronous work every 50 ms.
if (busy > 0) {
  setInterval(() => {
    const end = performance.now() + busy;
    while (performance.now() < end) {
      /* spin */
    }
  }, 50);
}
