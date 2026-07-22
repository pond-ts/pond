/**
 * Drive the SciChart perf suite's per-library pages through the pond-relevant
 * test groups in Playwright Chromium (unthrottled rAF, one page at a time),
 * extracting each group's G_RESULT directly. Writes suite-results.json.
 *
 * Usage: node run-suite.mjs [libKey ...]  (default: all)
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8124';
const OUT = new URL('./suite-results.json', import.meta.url).pathname;

const LIBS = {
  pond: '/pond/pond.html',
  uplot: '/uPlot/uPlot.html',
  scichart: '/scichart/scichart.html',
  chartjs: '/chartjs/chartjs.html',
};

// Groups: 1 NxM line, 2 scatter, 3 xy-line, 4 point-line, 5 column,
// 6 candlestick, 7 FIFO/ECG, 8 mountain, 9 compression, 10 multi-chart.
const GROUPS = process.env.GROUPS
  ? process.env.GROUPS.split(',').map(Number)
  : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const GROUP_TIMEOUT_MS = 20 * 60 * 1000;

const only = process.argv.slice(2);
const libs = Object.entries(LIBS).filter(
  ([k]) => only.length === 0 || only.includes(k),
);

const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-precise-memory-info', '--use-angle=metal', '--enable-gpu'],
});

// Record the rendering backend once — canvas/WebGL parity caveat for the writeup.
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/pond/pond.html?test_group_id=8`, {
    waitUntil: 'domcontentloaded',
  });
  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    if (!gl) return 'no webgl';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg
      ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
  results.__gpu = gpu;
  console.log('GPU renderer:', gpu);
  await page.close();
}

for (const [libKey, path] of libs) {
  results[libKey] ??= {};
  for (const groupId of GROUPS) {
    if (results[libKey][String(groupId)]) {
      console.log(`skip ${libKey} group ${groupId} (already recorded)`);
      continue;
    }
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1000 },
    });
    const page = await context.newPage();
    page.on('pageerror', (e) =>
      console.error(
        `  [pageerror ${libKey} g${groupId}]`,
        e.message.slice(0, 200),
      ),
    );
    const t0 = Date.now();
    console.log(`\n=== ${libKey} group ${groupId} ===`);
    try {
      await page.goto(`${BASE}${path}?test_group_id=${groupId}`, {
        timeout: 60_000,
      });
      await page.waitForSelector('.results-table-ready', {
        timeout: GROUP_TIMEOUT_MS,
      });
      const groupResult = await page.evaluate(() => {
        return G_RESULT.map((r) => ({
          lib: `${r.configLibName} ${r.configLibVersion}`,
          points: r.config?.points,
          series: r.config?.series,
          charts: r.config?.charts,
          libLoadMs: r.benchmarkTimeLibLoad,
          firstFrameMs: r.benchmarkTimeFirstFrame,
          dataAppendMs: r.benchmarkTimeInitialDataAppend,
          memoryMB: r.memory,
          minFPS: r.minFPS,
          maxFPS: r.maxFPS,
          avgFPS: r.averageFPS,
          frames: r.numberOfFrames,
          status: r.isErrored ? r.errorReason || 'ERRORED' : 'OK',
          ingestion: r.dataIngestionRate,
        }));
      });
      results[libKey][String(groupId)] = groupResult;
      for (const r of groupResult) {
        console.log(
          `  ${String(r.points).padStart(9)} pts x${r.series}${r.charts ? ` x${r.charts}ch` : ''}: ` +
            `avg ${r.avgFPS?.toFixed(1)} fps (min ${r.minFPS?.toFixed(1)}), ` +
            `ff ${r.firstFrameMs?.toFixed(0)}ms, mem ${r.memoryMB?.toFixed(0)}MB, ${r.status}`,
        );
      }
    } catch (e) {
      console.error(`  FAILED: ${String(e).slice(0, 300)}`);
      results[libKey][String(groupId)] = { failed: String(e).slice(0, 500) };
    }
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    await context.close();
  }
}

await browser.close();
console.log('\nwrote', OUT);
