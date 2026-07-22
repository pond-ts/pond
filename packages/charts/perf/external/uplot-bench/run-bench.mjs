/**
 * Local uPlot-bench-protocol runner: loads each bench page in headless
 * Chromium under an identical measurement protocol and writes
 * results-local.json. Mirrors leeoniya/uPlot/bench semantics:
 *   - "done"  = page-reported chart create→painted ms (performance.now stamps)
 *   - load profile = CDP Performance.getMetrics at done (script/layout/style/task)
 *   - heap peak (25 ms sampler) / final (after forced GC)
 *   - 10 s mousemove sweep across the plot: metrics delta + rAF FPS
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8123';
const OUT_DIR = new URL('.', import.meta.url).pathname;

const TARGETS = [
  { key: 'uplot', name: 'uPlot v1.6.32', url: `${BASE}/uPlot.html` },
  { key: 'chartjs', name: 'Chart.js v4 (CDN)', url: `${BASE}/chartjs.html` },
  { key: 'pond', name: 'pond-charts (decimate on)', url: `${BASE}/pond.html` },
  {
    key: 'pond-nodecimate',
    name: 'pond-charts (decimate off)',
    url: `${BASE}/pond.html?decimate=0`,
  },
];

const LOAD_RUNS = 3;
const MOUSEMOVE_SECONDS = 10;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r1 = (v) => Math.round(v * 10) / 10;
const mb = (v) => Math.round((v / 1024 / 1024) * 10) / 10;

async function metricsMap(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function runOnce(browser, target, { interact }) {
  const context = await browser.newContext({
    viewport: { width: 1980, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) =>
    console.error(`  [pageerror ${target.key}]`, e.message),
  );
  await page.addInitScript(() => {
    window.__heapSamples = [];
    setInterval(() => {
      if (performance.memory)
        window.__heapSamples.push(performance.memory.usedJSHeapSize);
    }, 25);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(target.url);
  await page.waitForFunction(
    () => window.__bench && window.__bench.done,
    null,
    { timeout: 120_000 },
  );
  const loadMetrics = await metricsMap(cdp);
  const bench = await page.evaluate(() => window.__bench);
  const drawStats = await page.evaluate(() => window.__drawStats ?? null);

  // Settle, force GC, then read final heap; peak is the sampler max.
  await page.waitForTimeout(500);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(300);
  const heap = await page.evaluate(() => ({
    final: performance.memory ? performance.memory.usedJSHeapSize : null,
    peak: window.__heapSamples.length
      ? Math.max(...window.__heapSamples)
      : null,
  }));

  let interaction = null;
  if (interact) {
    const box = await page.evaluate(() => {
      let best = null;
      for (const c of document.querySelectorAll('canvas')) {
        const r = c.getBoundingClientRect();
        if (!best || r.width * r.height > best.w * best.h)
          best = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return best;
    });
    if (!box)
      throw new Error(`${target.key}: no canvas found for mousemove sweep`);
    await page.evaluate(() => {
      window.__fps = {
        frames: 0,
        maxGap: 0,
        last: performance.now(),
        running: true,
      };
      const tick = (t) => {
        const s = window.__fps;
        if (!s.running) return;
        s.frames += 1;
        s.maxGap = Math.max(s.maxGap, t - s.last);
        s.last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const m0 = await metricsMap(cdp);
    const t0 = Date.now();
    let x = box.x + 4;
    let dir = 1;
    const y = box.y + box.h / 2;
    let events = 0;
    while (Date.now() - t0 < MOUSEMOVE_SECONDS * 1000) {
      x += dir * 8;
      if (x > box.x + box.w - 4) dir = -1;
      else if (x < box.x + 4) dir = 1;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      events += 1;
      await new Promise((r) => setTimeout(r, 8));
    }
    const seconds = (Date.now() - t0) / 1000;
    const m1 = await metricsMap(cdp);
    const fps = await page.evaluate(() => {
      window.__fps.running = false;
      return { frames: window.__fps.frames, maxGap: window.__fps.maxGap };
    });
    interaction = {
      seconds: r1(seconds),
      events,
      scriptMs: r1((m1.ScriptDuration - m0.ScriptDuration) * 1000),
      layoutMs: r1((m1.LayoutDuration - m0.LayoutDuration) * 1000),
      recalcStyleMs: r1(
        (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000,
      ),
      taskMs: r1((m1.TaskDuration - m0.TaskDuration) * 1000),
      fps: r1(fps.frames / seconds),
      maxFrameGapMs: r1(fps.maxGap),
    };
    await page.screenshot({ path: `${OUT_DIR}shot-${target.key}.png` });
  }

  const result = {
    bench,
    drawStats,
    load: {
      scriptMs: r1(loadMetrics.ScriptDuration * 1000),
      layoutMs: r1(loadMetrics.LayoutDuration * 1000),
      recalcStyleMs: r1(loadMetrics.RecalcStyleDuration * 1000),
      taskMs: r1(loadMetrics.TaskDuration * 1000),
    },
    heap: {
      peakMB: heap.peak == null ? null : mb(heap.peak),
      finalMB: heap.final == null ? null : mb(heap.final),
    },
    interaction,
  };
  await context.close();
  return result;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-precise-memory-info'],
});

const only = process.argv[2];
const results = [];
for (const target of TARGETS.filter((t) => !only || t.key.startsWith(only))) {
  console.log(`\n=== ${target.name} ===`);
  const runs = [];
  for (let i = 0; i < LOAD_RUNS; i += 1) {
    const interact = i === LOAD_RUNS - 1;
    const run = await runOnce(browser, target, { interact });
    runs.push(run);
    console.log(
      `  run ${i + 1}: prep ${r1(run.bench.prepMs)} ms, chart ${r1(run.bench.chartMs)} ms, ` +
        `script ${run.load.scriptMs} ms, heap peak ${run.heap.peakMB} MB / final ${run.heap.finalMB} MB`,
    );
    if (run.drawStats) {
      const layers = run.drawStats.layers.map(
        (l) => `${l.sourceCount}→${l.drawnCount}${l.decimated ? ' (M4)' : ''}`,
      );
      console.log(
        `  drawStats: totalDrawMs ${r1(run.drawStats.totalDrawMs)}, layers [${layers.join(', ')}]`,
      );
    }
    if (run.interaction)
      console.log(`  mousemove 10s:`, JSON.stringify(run.interaction));
  }
  results.push({
    ...target,
    prepMs: r1(median(runs.map((r) => r.bench.prepMs))),
    chartSyncMs: r1(median(runs.map((r) => r.bench.chartSyncMs))),
    chartMs: r1(median(runs.map((r) => r.bench.chartMs))),
    load: {
      scriptMs: r1(median(runs.map((r) => r.load.scriptMs))),
      layoutMs: r1(median(runs.map((r) => r.load.layoutMs))),
      recalcStyleMs: r1(median(runs.map((r) => r.load.recalcStyleMs))),
      taskMs: r1(median(runs.map((r) => r.load.taskMs))),
    },
    heapPeakMB: r1(median(runs.map((r) => r.heap.peakMB))),
    heapFinalMB: r1(median(runs.map((r) => r.heap.finalMB))),
    drawStats: runs[runs.length - 1].drawStats,
    interaction: runs[runs.length - 1].interaction,
    count: runs[0].bench.count,
  });
}

await browser.close();
const outName = only
  ? `results-local-${only}-fixed.json`
  : 'results-local.json';
writeFileSync(`${OUT_DIR}${outName}`, JSON.stringify(results, null, 2));
console.log(`\nwrote ${outName}`);
