/**
 * CPU-profile the pond NxM line test at a fixed size: drive the adapter's
 * eLinePerformanceTest directly (invalid test_group_id keeps the harness
 * inert), run the y-zoom update loop ~3s under the V8 sampling profiler,
 * and bucket self-time by subsystem (React / decimation / d3-shape / charts
 * draw / pond core / other).
 * Usage: node profile-nxm.mjs [series] [points]
 */
import { chromium } from 'playwright';

const SERIES = Number(process.argv[2] ?? 1000);
const POINTS = Number(process.argv[3] ?? 1000);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', () => {}); // after.js throws on the bogus group id — expected
await page.goto('http://127.0.0.1:8124/pond/pond.html?test_group_id=99', {
  waitUntil: 'load',
});
await page.waitForFunction(() => typeof eLinePerformanceTest === 'function');

// Set up the chart outside the profiled window.
await page.evaluate(
  async ([series, points]) => {
    window.__pt = eLinePerformanceTest(series, points);
    await window.__pt.createChart();
    window.__pt.generateData();
    window.__pt.appendData();
  },
  [SERIES, POINTS],
);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');

const stats = await page.evaluate(async () => {
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < 3000) {
    window.__pt.updateChart(frames);
    frames += 1;
    await new Promise(requestAnimationFrame);
  }
  return { frames, ms: performance.now() - t0 };
});

const { profile } = await cdp.send('Profiler.stop');

// Aggregate self time per node.
const interval = 200; // µs
const selfByFn = new Map();
const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
for (const n of profile.nodes) {
  const hits = n.hitCount ?? 0;
  if (!hits) continue;
  const name = n.callFrame.functionName || '(anonymous)';
  selfByFn.set(name, (selfByFn.get(name) ?? 0) + hits);
}
const totalHits = [...selfByFn.values()].reduce((a, b) => a + b, 0);

const BUCKETS = [
  [
    'react',
    /^(beginWork|completeWork|performUnitOfWork|workLoopSync|renderWithHooks|reconcileChild|commit|updateFunctionComponent|mountIndeterminate|prepareFreshStack|flushSync|updateContainer|scheduleUpdate|markUpdate|createFiber|createChildReconciler|bailoutOnAlreadyFinishedWork|propagateContextChange|readContext|useMemo|useRef|useCallback|useContext|basicStateReducer|updateReducer|updateMemo|areHookInputsEqual|pushProvider|popProvider|completeUnitOfWork|insertOrAppendPlacementNode|commitPlacement|recursivelyTraverse|runWithFiberInDEV|performWorkOnRoot|finishConcurrentRender|flushPassiveEffects|commitHookEffectList|safelyCallDestroy|detachFiberAfterEffects)/,
  ],
  ['decimate', /decimate|binBy|m4/i],
  [
    'd3-shape',
    /^(line|area|curve|point|Linear|output|lineStart|lineEnd|areaStart)/,
  ],
  [
    'charts-draw',
    /^(drawLine|drawArea|drawBand|drawGrid|drawDividers|draw$|stroke|buildPath|collectGapEdges|bridgeGaps|thinPixels|sessionRuns|cullToViewport|viewportSlice)/,
  ],
  [
    'pond-core',
    /^(fromColumns|toChartSeries|columnValues|materialize|ColumnarStore|TimeSeries|validate)/i,
  ],
  ['canvas-native', /^(stroke|fill|beginPath|moveTo|lineTo)$/],
];

const bucketTotals = new Map(BUCKETS.map(([b]) => [b, 0]));
bucketTotals.set('other', 0);
bucketTotals.set('(gc/program/idle)', 0);
for (const [name, hits] of selfByFn) {
  if (
    name === '(garbage collector)' ||
    name === '(program)' ||
    name === '(idle)' ||
    name === '(root)'
  ) {
    bucketTotals.set(
      '(gc/program/idle)',
      bucketTotals.get('(gc/program/idle)') + hits,
    );
    continue;
  }
  const bucket = BUCKETS.find(([, re]) => re.test(name));
  const key = bucket ? bucket[0] : 'other';
  bucketTotals.set(key, bucketTotals.get(key) + hits);
}

const fmt = (h) =>
  `${((h * interval) / 1000).toFixed(0)}ms (${((100 * h) / totalHits).toFixed(1)}%)`;
console.log(
  `\nNxM ${SERIES}x${POINTS}: ${stats.frames} frames in ${stats.ms.toFixed(0)}ms → ${((1000 * stats.frames) / stats.ms).toFixed(1)} fps, ${(stats.ms / stats.frames).toFixed(1)}ms/frame`,
);
console.log(
  `profiled self-time total ≈ ${((totalHits * interval) / 1000).toFixed(0)}ms\n`,
);
for (const [bucket, hits] of [...bucketTotals.entries()].sort(
  (a, b) => b[1] - a[1],
)) {
  if (hits) console.log(`  ${bucket.padEnd(18)} ${fmt(hits)}`);
}
console.log('\nTop 25 self-time functions:');
for (const [name, hits] of [...selfByFn.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)) {
  console.log(`  ${fmt(hits).padStart(16)}  ${name}`);
}
await browser.close();
