// Opens the page in headless Chromium and checks that the chart works:
// frames are drawn, every tick the feed sends arrives and the newest is
// drawn within 250 ms, the series holds one window of ticks, the line spans
// the chart, hovering picks the tick under the pointer and shows it in local
// time with the tooltip kept on the page, the chart keeps drawing while the
// page's own thread is busy, and a resize gives the canvas new pixels. It
// runs in a time zone away from UTC (Tokyo), so a clock shown in UTC would
// stand out.
//
//   npm run check
//
// Needs Playwright's Chromium (`npx playwright install chromium`), or
// CHROMIUM_PATH set to a Chrome or Chromium binary. Headless frame rates
// say the chart keeps up; they are not the numbers to quote for a real
// display.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const RATE = Number(process.env.RATE ?? 20_000);
const WINDOW = Number(process.env.WINDOW ?? 10);
const PAD = { left: 8, right: 64 }; // the plot's margins in render-worker.ts
const MAX_DELAY = 250; // ms: the newest tick drawn is never older than this

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server, port } = await startServer({ port: 0 });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 520 },
    locale: 'en-US',
    timezoneId: 'Asia/Tokyo',
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://localhost:${port}/?rate=${RATE}&window=${WINDOW}`);

  // The status line, parsed back into numbers.
  const stats = async () => {
    const problem = await page.textContent('#problem');
    if (problem) throw new Error(`page shows: ${problem}`);
    const text = await page.textContent('#status');
    const m = text.match(
      /chart (\d+) fps · page (\d+) fps · ([\d,]+) ticks\/s · ([\d,]+) ticks held · delay (\d+) ms(?: · ([\d,]+) dropped)?(?: · ([\d,]+) missing)?/,
    );
    if (!m) return null;
    const w = (await page.textContent('#work')).match(
      /fromColumns ([\d.]+) ms\/s · pushSeries ([\d.]+) ms\/s · buckets ([\d.]+) ms\/s · frame ([\d.]+) ms · canvas (\d+)×(\d+) px/,
    );
    const n = (s) => Number((s ?? '0').replaceAll(',', ''));
    return {
      fps: n(m[1]),
      pageFps: n(m[2]),
      ticksPerSec: n(m[3]),
      rows: n(m[4]),
      delayMs: n(m[5]),
      dropped: n(m[6]),
      missing: n(m[7]),
      seriesMs: n(w?.[1]),
      pushMs: n(w?.[2]),
      foldMs: n(w?.[3]),
      frameMs: n(w?.[4]),
      canvas: w ? `${w[5]}×${w[6]}` : '',
    };
  };
  // One stats report a second; collect `count` fresh ones.
  const sample = async (count) => {
    const out = [];
    let last = await page.textContent('#status');
    while (out.length < count) {
      await page.waitForFunction(
        (prev) => document.querySelector('#status').textContent !== prev,
        last,
        { timeout: 5000 },
      );
      last = await page.textContent('#status');
      out.push(await stats());
    }
    return out;
  };
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

  // Columns of the plot that hold any line-coloured pixel, as a share of
  // the plot's width. The line is #f5b740.
  const lineCoverage = async () => {
    const box = await page.locator('canvas').boundingBox();
    const png = await page.screenshot({ clip: box });
    return page.evaluate(
      async ({ b64, cssWidth, padLeft, padRight }) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const { data, width, height } = g.getImageData(
          0,
          0,
          bmp.width,
          bmp.height,
        );
        const scale = width / cssWidth; // screenshot pixels per CSS pixel
        const x0 = Math.round(padLeft * scale);
        const x1 = width - Math.round(padRight * scale);
        let hit = 0;
        for (let x = x0; x < x1; x++) {
          for (let y = 0; y < height; y++) {
            const i = (y * width + x) * 4;
            if (
              data[i] > 200 &&
              data[i + 1] > 140 &&
              data[i + 1] < 220 &&
              data[i + 2] < 120
            ) {
              hit++;
              break;
            }
          }
        }
        return hit / (x1 - x0);
      },
      {
        b64: png.toString('base64'),
        cssWidth: box.width,
        padLeft: PAD.left,
        padRight: PAD.right,
      },
    );
  };

  // Resolves true once `fn(arg)` holds in the page, false after `ms`.
  const becomes = (fn, arg = null, ms = 3000) =>
    page.waitForFunction(fn, arg, { timeout: ms }).then(
      () => true,
      () => false,
    );

  // Wait for the history to arrive: the series holds (nearly) a window and
  // the newest tick drawn is fresh.
  const caughtUp = await becomes(
    ({ want, maxDelay }) => {
      const m = /([\d,]+) ticks held · delay (\d+) ms/.exec(
        document.querySelector('#status').textContent,
      );
      return (
        m && Number(m[1].replaceAll(',', '')) >= want && Number(m[2]) < maxDelay
      );
    },
    { want: 0.99 * RATE * WINDOW, maxDelay: MAX_DELAY },
    60_000,
  );
  if (!caughtUp) {
    for (const id of ['#problem', '#status', '#work']) {
      console.log(`${id}: ${await page.textContent(id)}`);
    }
    throw new Error('the chart did not catch up with the feed within 60 s');
  }
  await sleep(1500);

  // Every tick arrived, none was dropped, and the newest was always fresh.
  const keptUp = (samples) =>
    samples.every(
      (s) => s.dropped === 0 && s.missing === 0 && s.delayMs < MAX_DELAY,
    );

  const steady = await sample(3);
  console.log('steady:', JSON.stringify(steady));
  const fps = median(steady.map((s) => s.fps));
  const tps = median(steady.map((s) => s.ticksPerSec));
  const rows = median(steady.map((s) => s.rows));
  check(fps >= 30, `chart draws (median ${fps} fps)`);
  check(
    Math.abs(tps - RATE) / RATE < 0.1,
    `ticks arrive at the feed's rate (${tps}/s of ${RATE}/s)`,
  );
  // Ticks are evenly spaced, so a window holds RATE × WINDOW of them, give
  // or take a couple (observed: exact, or one over).
  check(
    Math.abs(rows - RATE * WINDOW) <= Math.max(2, RATE * WINDOW * 0.001),
    `series holds one window (${rows} of ${RATE * WINDOW})`,
  );
  check(
    keptUp(steady),
    `every tick arrives, none dropped, and the newest is drawn within ${MAX_DELAY} ms`,
  );

  const covered = await lineCoverage();
  check(
    covered > 0.95,
    `line spans the plot (${(covered * 100).toFixed(1)}% of columns)`,
  );

  const tooltipShown = () => !document.querySelector('#tooltip').hidden;
  const box = await page.locator('canvas').boundingBox();
  const plotW = box.width - PAD.left - PAD.right;

  const hoverX = 600;
  await page.mouse.move(hoverX, 180);
  await becomes(tooltipShown);
  const tip = await page.textContent('#tooltip');
  check(
    /^\d\d:\d\d:\d\d\.\d{3} {2}\d+\.\d{3} × \d+$/.test(tip),
    `hover shows a tick ("${tip}")`,
  );
  // The pointer is a share of the way across a plot that ends now, so the
  // tick under it is (1 - share) × WINDOW seconds older than the page's
  // local clock. A clock shown in UTC would be hours out.
  const behind = await page.evaluate((text) => {
    const [h, m, s] = text.slice(0, 8).split(':').map(Number);
    const ms = Number(text.slice(9, 12));
    const d = new Date();
    const now =
      d.getHours() * 3600 +
      d.getMinutes() * 60 +
      d.getSeconds() +
      d.getMilliseconds() / 1000;
    return (now - (h * 3600 + m * 60 + s + ms / 1000) + 86_400) % 86_400;
  }, tip);
  const expected = (1 - (hoverX - box.x - PAD.left) / plotW) * WINDOW;
  check(
    Math.abs(behind - expected) < 1 + WINDOW * 0.02,
    `the tick is the one under the pointer, in local time ` +
      `(${behind.toFixed(1)} s behind the page's clock; expected ${expected.toFixed(1)})`,
  );

  // Near the plot's right edge the tooltip flips left of the pointer.
  await page.mouse.move(box.x + box.width - 66, 180);
  const moved = await becomes((prev) => {
    const t = document.querySelector('#tooltip');
    return !t.hidden && t.textContent !== prev;
  }, tip);
  const onPage = await page.evaluate(() => {
    const tip = document.querySelector('#tooltip').getBoundingClientRect();
    const chart = document.querySelector('canvas').getBoundingClientRect();
    const root = document.documentElement;
    return (
      tip.width > 0 &&
      tip.left >= chart.left &&
      tip.right <= chart.right &&
      root.scrollWidth <= root.clientWidth
    );
  });
  check(moved && onPage, 'the tooltip stays on the page at the right edge');

  await page.mouse.move(600, 500); // off the canvas
  check(
    await becomes(() => document.querySelector('#tooltip').hidden),
    'tooltip hides when the pointer leaves',
  );

  await page.check('#busy');
  // Share of 2 s the page's thread was blocked. (Headless Chromium runs
  // queued page frames back to back after a block, so the page's own fps
  // count is no measure of that here; on a real display it is.)
  const blocked = await page.evaluate(
    () =>
      new Promise((done) => {
        const start = performance.now();
        let last = start;
        let blocked = 0;
        const tick = () => {
          const now = performance.now();
          if (now - last > 20) blocked += now - last;
          last = now;
          if (now - start < 2000) setTimeout(tick, 0);
          else done(blocked / (now - start));
        };
        setTimeout(tick, 0);
      }),
  );
  const busy = await sample(3);
  console.log('busy page:', JSON.stringify(busy));
  await page.uncheck('#busy');
  const busyFps = median(busy.map((s) => s.fps));
  check(
    blocked > 0.6,
    `the page's thread is busy (${Math.round(blocked * 100)}% blocked)`,
  );
  check(
    busyFps >= 0.8 * fps,
    `the chart keeps its frame rate (${fps} -> ${busyFps} fps)`,
  );
  check(
    keptUp(busy) &&
      Math.abs(median(busy.map((s) => s.ticksPerSec)) - RATE) / RATE < 0.1,
    'ticks keep arriving on a busy page',
  );
  // A few seconds on, with the page busy, the newest tick is no further
  // behind: a chart slowly falling behind fails here before it reaches
  // MAX_DELAY.
  const steadyDelay = median(steady.map((s) => s.delayMs));
  const busyDelay = median(busy.map((s) => s.delayMs));
  check(
    busyDelay <= steadyDelay + 50,
    `the chart doesn't fall behind (newest tick ${steadyDelay} ms old, then ${busyDelay} ms)`,
  );

  // A narrower window: the worker must give the canvas new pixels (CSS
  // alone would stretch the old ones, and the line would still span).
  await page.setViewportSize({ width: 800, height: 520 });
  const after = await page.locator('canvas').boundingBox();
  const dpr = await page.evaluate(() => devicePixelRatio);
  const want = `${Math.round(after.width * dpr)}×${Math.round(after.height * dpr)}`;
  const resized = await becomes(
    (w) =>
      document.querySelector('#work').textContent.includes(`canvas ${w} px`),
    want,
  );
  check(
    resized,
    `a resize gives the canvas new pixels (${(await stats())?.canvas} of ${want})`,
  );
  await sleep(500);
  const coveredAfter = await lineCoverage();
  check(
    coveredAfter > 0.95,
    `line spans the plot after a resize (${(coveredAfter * 100).toFixed(1)}%)`,
  );

  check(
    errors.length === 0,
    `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`,
  );
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
process.exit(0);
