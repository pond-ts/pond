import { chromium } from 'playwright';
const [test, series, points] = [
  process.argv[2] ?? 'line',
  Number(process.argv[3] ?? 1000),
  Number(process.argv[4] ?? 1000),
];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', () => {});
await page.goto('http://127.0.0.1:8124/pond/pond.html?test_group_id=99', {
  waitUntil: 'load',
});
await page.waitForFunction(() => typeof eLinePerformanceTest === 'function');
await page.evaluate(
  async ([test, series, points]) => {
    const factory = {
      line: eLinePerformanceTest,
      mountain: eMountainPerformanceTest,
    }[test];
    window.__pt = factory(series, points);
    await window.__pt.createChart();
    window.__pt.generateData();
    window.__pt.appendData();
  },
  [test, series, points],
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
    frames++;
    await new Promise(requestAnimationFrame);
  }
  return { frames, ms: performance.now() - t0 };
});
const { profile } = await cdp.send('Profiler.stop');
const agg = new Map();
for (const n of profile.nodes) {
  if (!n.hitCount) continue;
  const f = n.callFrame;
  const url = (f.url || '').split('/').pop();
  const key = `${f.functionName || '(anon)'} @ ${url}:${f.lineNumber}`;
  agg.set(key, (agg.get(key) ?? 0) + n.hitCount);
}
const total = [...agg.values()].reduce((a, b) => a + b, 0);
console.log(
  `${test} ${series}x${points}: ${((1000 * stats.frames) / stats.ms).toFixed(1)} fps, ${(stats.ms / stats.frames).toFixed(1)}ms/frame`,
);
for (const [k, h] of [...agg.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 18))
  console.log(`  ${((100 * h) / total).toFixed(1).padStart(5)}%  ${k}`);
await browser.close();
