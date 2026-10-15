// Headless-Chromium sweep over the scenario space. Starts the server in
// process, opens the page per scenario, lets it settle, then samples the
// engine's once-a-second stats and the page's own frame rate.
//
//   node spikes/offscreen-stream/bench.mjs [--uncapped] [--headed] [--channel chrome]
//     [--dpr 2] [--settle ms] [--sample s] [--only group] [--where k=v,…] [--out file]
//   node spikes/offscreen-stream/bench.mjs --print results/x.json
//
// Per scenario: open the page, wait for the history to land, wait until the
// chart is less than 1 s behind the feed ("caught up"; recorded, and the row
// is flagged if it never gets there), settle, then aggregate every frame from
// a run of consecutive once-a-second engine reports. All figures in a row
// come from the same frames.
//
// --uncapped launches Chromium without the vsync frame cap, so rAF runs as
// fast as the work allows: that is the honest "could this hold 120 fps"
// number on a machine with no 120 Hz display. Capped runs pace at the
// headless default (60 Hz).
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.mjs';

const args = process.argv.slice(2);
const uncapped = args.includes('--uncapped');
// --headed runs a visible browser: on a machine with a real 120 Hz display
// this is the only way to measure frame pacing against actual vsync.
// --channel chrome uses the installed Google Chrome instead of Playwright's.
const headed = args.includes('--headed');
const channelIdx = args.indexOf('--channel');
const channel = channelIdx >= 0 ? args[channelIdx + 1] : undefined;
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
// Playwright pins a page's devicePixelRatio to 1 unless told otherwise, even
// on a Retina screen; --dpr 2 renders the canvas at Retina resolution.
const dpr = num('--dpr', 1);
const SETTLE_MS = num('--settle', 3000);
const SAMPLE_S = num('--sample', 4);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
// --where pipeline=raw,draw=buckets,rate=1000000 — run only matching scenarios.
const whereIdx = args.indexOf('--where');
const where =
  whereIdx >= 0
    ? Object.fromEntries(
        args[whereIdx + 1].split(',').map((kv) => kv.split('=')),
      )
    : {};

function formatRow(r) {
  const f = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
  return (
    `${r.group.padEnd(7)} ${r.mode.padEnd(6)} ${r.pipeline.padEnd(8)} ${r.draw.padEnd(7)} ${String(r.rate).padStart(7)}/s ${String(r.window).padStart(3)}s ` +
    `busy ${String(r.busy).padStart(2)}${r.spin ? ` spin ${r.spin}` : ''} every ${String(r.interval).padStart(2)}ms dpr ${r.dpr ?? 1} | pts ${String(r.points).padStart(9)} ` +
    `fps ${f(r.fps, 0).padStart(4)} p95 ${f(r.frameP95)}ms work ${f(r.workAvg, 2)}ms (view ${f(r.viewAvg, 2)}${r.viewDirtyAvg != null ? `/${f(r.viewDirtyAvg, 2)}` : ''} ext ${f(r.extentAvg, 2)} draw ${f(r.drawAvg, 2)}) ` +
    `ingest ${f(r.ingestMsPerSec, 0)}ms/s ${f(r.ticksPerSec, 0)}t/s${r.droppedPerSec ? ` DROP ${f(r.droppedPerSec, 0)}/s` : ''} lat ${f(r.latencyP50, 0)}/${f(r.latencyP95, 0)}ms page ${f(r.pageFps, 0)}fps max ${f(r.pageFrameMax, 0)}ms` +
    (r.caughtUp === false ? '  NOT-CAUGHT-UP' : '') +
    (r.errors?.length ? `  ERR ${r.errors.join('; ')}` : '') +
    (r.note ? `  [${r.note}]` : '')
  );
}

// --print results/x.json re-prints a saved run as the console table.
const printIdx = args.indexOf('--print');
if (printIdx >= 0) {
  const { results } = JSON.parse(await readFile(args[printIdx + 1], 'utf8'));
  for (const r of results) console.log(formatRow(r));
  process.exit(0);
}

const scenarios = [];
const base = { mode: 'worker', busy: 0, interval: 16 };
// 1. The space: pipeline × draw × rate × window, worker thread, quiet page.
for (const [pipeline, draw] of [
  ['raw', 'm4'],
  ['chunk', 'm4'],
  ['snapshot', 'm4'],
  ['view', 'm4'],
  ['raw', 'buckets'],
  ['chunk', 'buckets'],
])
  for (const rate of [1_000, 10_000, 100_000, 1_000_000])
    for (const window of [10, 60, 300]) {
      const points = rate * window;
      // Raw points held in memory (everything except raw+buckets).
      if (!(pipeline === 'raw' && draw === 'buckets') && points > 10_000_000)
        continue;
      // Memory precaution: `chunk` holds every tick twice (LiveSeries chunks
      // + the mirror ring).
      if (pipeline === 'chunk' && points > 10_000_000) continue;
      // A full rebuild per frame: ~0.5 s at 600k in the cloud already.
      if (pipeline === 'snapshot' && points > 600_000) continue;
      // A `live.window()` LiveView costs O(window) per tick to evict (see
      // REPORT §3); at 100k points the worker already can't keep up.
      if (pipeline === 'view' && points > 100_000) continue;
      scenarios.push({ group: 'space', ...base, pipeline, draw, rate, window });
    }
// 2. The busy page: worker vs main thread, quiet vs heavy app.
for (const draw of ['m4', 'buckets'])
  for (const busy of [0, 20, 40])
    for (const mode of ['worker', 'main'])
      scenarios.push({
        group: 'busy',
        ...base,
        mode,
        pipeline: 'chunk',
        draw,
        rate: 100_000,
        window: 10,
        busy,
      });
// 3. Push cadence at a fixed rate.
for (const interval of [4, 8, 16, 50])
  scenarios.push({
    group: 'cadence',
    ...base,
    pipeline: 'chunk',
    draw: 'buckets',
    rate: 100_000,
    window: 60,
    interval,
  });

// 4. Receiving vs a busy drawing thread: the cheapest draw at 1M ticks/s,
// with `spin` ms of extra work added to every frame. Only 1 s of history,
// so no history backlog is mixed in.
for (const spin of [0, 4, 8, 12, 16, 24])
  scenarios.push({
    group: 'receive',
    ...base,
    pipeline: 'raw',
    draw: 'buckets',
    rate: 1_000_000,
    window: 10,
    spin,
  });

const { server, port } = await startServer({ port: 0 });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? undefined,
  headless: !headed,
  channel,
  args: uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [],
});
const results = [];
const selected = scenarios.filter(
  (s) =>
    (!only || s.group === only) &&
    Object.entries(where).every(([k, v]) => String(s[k]) === v),
);
for (const s of selected) {
  const page = await browser.newPage({
    viewport: { width: 1232, height: 700 },
    deviceScaleFactor: dpr,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // History to prefill: the whole window, capped at 10M ticks (a 5-minute
  // window at 1M/s would be 7 GB on the wire; bucket draw cost does not
  // depend on it).
  const prefill =
    s.group === 'receive'
      ? 1
      : Math.min(s.window, Math.floor(10_000_000 / s.rate));
  const { group, ...params } = s;
  const qs = new URLSearchParams({
    ...params,
    prefill,
    ...(uncapped ? { meter: 0 } : {}),
  }).toString();
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/?${qs}`);
  // Wait for the prefill to land (points ≈ rate × window), then settle.
  const target = s.rate * prefill * 0.95;
  await page
    .waitForFunction((t) => (window.__stats?.points ?? 0) >= t, target, {
      timeout: 120_000,
      polling: 250,
    })
    .catch(() => errors.push('prefill timeout'));
  const prefillMs = Date.now() - t0;
  // Caught up: the newest drawn tick is under 1 s old. A row that never gets
  // there is still showing the history backlog (or can't keep up) and is
  // flagged rather than silently mixed in.
  const c0 = Date.now();
  const caughtUp = await page
    .waitForFunction(
      () => {
        const s = window.__stats;
        return s != null && s.latencyP50 > 0 && s.latencyP50 < 1000;
      },
      null,
      { timeout: 60_000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);
  const catchUpMs = Date.now() - c0;
  await page.waitForTimeout(SETTLE_MS);
  const i0 = await page.evaluate(() => [
    window.__reports.length,
    window.__mainReports.length,
  ]);
  await page.waitForTimeout(SAMPLE_S * 1000 + 300);
  const { reps, mains } = await page.evaluate(([a, b]) => {
    return {
      reps: window.__reports.slice(a),
      mains: window.__mainReports.slice(b),
    };
  }, i0);
  await page.close();
  const cat = (k) => reps.flatMap((x) => x.raw[k]);
  const sum = (k) => reps.reduce((a, x) => a + x.raw[k], 0);
  const secs = reps.reduce((a, x) => a + x.secs, 0) || 1;
  const sorted = (a) => [...a].sort((p, q) => p - q);
  const pct = (a, p) =>
    a.length
      ? sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))]
      : null;
  const mean = (a) =>
    a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;
  const intervals = cat('intervals');
  const pageIntervals = mains.flatMap((m) => m.intervals);
  const pageSecs = mains.reduce((a, m) => a + m.secs, 0);
  const last = reps[reps.length - 1];
  const r = {
    ...s,
    dpr,
    prefill,
    reports: reps.length,
    points: last?.points ?? null,
    columns: last?.columns ?? null,
    usingRaf: last?.usingRaf ?? null,
    fps: intervals.length / secs,
    frameP50: pct(intervals, 0.5),
    frameP95: pct(intervals, 0.95),
    frameMax: intervals.length ? Math.max(...intervals) : null,
    over120: intervals.length
      ? intervals.filter((d) => d > 1000 / 120 + 1).length / intervals.length
      : null,
    workAvg: mean(cat('work')),
    workP95: pct(cat('work'), 0.95),
    viewAvg: mean(cat('view')),
    viewDirtyAvg:
      s.pipeline === 'snapshot' || s.pipeline === 'view'
        ? mean(cat('viewDirty'))
        : null,
    extentAvg: mean(cat('extent')),
    drawAvg: mean(cat('draw')),
    ingestMsPerSec: sum('ingestMs') / secs,
    ticksPerSec: sum('ticks') / secs,
    droppedPerSec: sum('dropped') / secs,
    mbPerSec: sum('bytes') / secs / 1e6,
    latencyP50: pct(cat('latency'), 0.5),
    latencyP95: pct(cat('latency'), 0.95),
    pageFps: pageSecs ? pageIntervals.length / pageSecs : null,
    pageFrameP95: pct(pageIntervals, 0.95),
    pageFrameMax: pageIntervals.length ? Math.max(...pageIntervals) : null,
    // Per-second trend, to see a backlog shrinking or growing.
    perSecond: reps.map((x) => ({
      fps: Math.round(x.fps),
      latencyP50: Math.round(x.latencyP50),
      ticksPerSec: Math.round(x.ticksPerSec),
    })),
    prefillMs,
    caughtUp,
    catchUpMs,
    errors,
  };
  results.push(r);
  console.log(formatRow(r));
}
await browser.close();
server.close();
if (out)
  await writeFile(
    out,
    JSON.stringify(
      {
        uncapped,
        headed,
        channel: channel ?? null,
        dpr,
        settleMs: SETTLE_MS,
        sampleS: SAMPLE_S,
        results,
      },
      null,
      2,
    ),
  );
process.exit(0);
