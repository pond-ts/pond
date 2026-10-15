// Headless-Chromium sweep over the scenario space. Starts the server in
// process, opens the page per scenario, lets it settle, then samples the
// engine's once-a-second stats and the page's own frame rate.
//
//   node spikes/offscreen-stream/bench.mjs [--uncapped] [--only group] [--where k=v,…] [--out file]
//
// --uncapped launches Chromium without the vsync frame cap, so rAF runs as
// fast as the work allows: that is the honest "could this hold 120 fps"
// number on a machine with no 120 Hz display. Capped runs pace at the
// headless default (60 Hz).
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { startServer } from './server.mjs';

const args = process.argv.slice(2);
const uncapped = args.includes('--uncapped');
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

const SETTLE_MS = 3000;
const SAMPLE_S = 4;

const scenarios = [];
const base = { mode: 'worker', busy: 0, interval: 16 };
// 1. The space: pipeline × draw × rate × window, worker thread, quiet page.
for (const [pipeline, draw] of [
  ['raw', 'm4'],
  ['chunk', 'm4'],
  ['snapshot', 'm4'],
  ['raw', 'buckets'],
  ['chunk', 'buckets'],
])
  for (const rate of [1_000, 10_000, 100_000, 1_000_000])
    for (const window of [10, 60, 300]) {
      const points = rate * window;
      // Raw points held in memory (everything except raw+buckets).
      if (!(pipeline === 'raw' && draw === 'buckets') && points > 10_000_000)
        continue;
      if (pipeline === 'chunk' && points > 6_000_000) continue; // LiveSeries row memory
      if (pipeline === 'snapshot' && points > 600_000) continue; // seconds per frame; see REPORT
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

const { server, port } = await startServer({ port: 0 });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? undefined,
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
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // History to prefill: the whole window, capped at 10M ticks (a 5-minute
  // window at 1M/s would be 7 GB on the wire; bucket draw cost does not
  // depend on it).
  const prefill = Math.min(s.window, Math.floor(10_000_000 / s.rate));
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
  await page.waitForTimeout(SETTLE_MS);
  const samples = [];
  for (let i = 0; i < SAMPLE_S; i++) {
    await page.waitForTimeout(1000);
    samples.push(
      await page.evaluate(() => ({
        chart: window.__stats,
        page: window.__main,
      })),
    );
  }
  await page.close();
  const med = (k, src = 'chart') => {
    const v = samples
      .map((x) => x[src]?.[k])
      .filter((n) => typeof n === 'number')
      .sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const max = (k, src = 'chart') =>
    Math.max(...samples.map((x) => x[src]?.[k] ?? 0));
  const r = {
    ...s,
    prefill,
    points: med('points'),
    columns: med('columns'),
    fps: med('fps'),
    frameP95: med('frameP95'),
    frameMax: max('frameMax'),
    over120: med('over120'),
    workAvg: med('workAvg'),
    workP95: med('workP95'),
    viewAvg: med('viewAvg'),
    extentAvg: med('extentAvg'),
    drawAvg: med('drawAvg'),
    ingestMsPerSec: med('ingestMsPerSec'),
    ticksPerSec: med('ticksPerSec'),
    droppedPerSec: med('droppedPerSec'),
    mbPerSec: med('mbPerSec'),
    latencyP50: med('latencyP50'),
    latencyP95: med('latencyP95'),
    pageFps: med('fps', 'page'),
    pageFrameMax: max('frameMax', 'page'),
    prefillMs,
    errors,
  };
  results.push(r);
  const f = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
  console.log(
    `${s.group.padEnd(7)} ${s.mode.padEnd(6)} ${s.pipeline.padEnd(8)} ${s.draw.padEnd(7)} ${String(s.rate).padStart(7)}/s ${String(s.window).padStart(3)}s ` +
      `busy ${String(s.busy).padStart(2)} every ${String(s.interval).padStart(2)}ms | pts ${String(r.points).padStart(9)} ` +
      `fps ${f(r.fps, 0).padStart(4)} p95 ${f(r.frameP95)}ms work ${f(r.workAvg, 2)}ms (view ${f(r.viewAvg, 2)} ext ${f(r.extentAvg, 2)} draw ${f(r.drawAvg, 2)}) ` +
      `ingest ${f(r.ingestMsPerSec, 0)}ms/s ${f(r.ticksPerSec, 0)}t/s${r.droppedPerSec ? ` DROP ${f(r.droppedPerSec, 0)}/s` : ''} lat ${f(r.latencyP50, 0)}/${f(r.latencyP95, 0)}ms page ${f(r.pageFps, 0)}fps max ${f(r.pageFrameMax, 0)}ms` +
      (errors.length ? `  ERR ${errors.join('; ')}` : ''),
  );
}
await browser.close();
server.close();
if (out) await writeFile(out, JSON.stringify({ uncapped, results }, null, 2));
process.exit(0);
