// Opens the page in headless Chromium and checks that the chart works:
// frames are drawn, every tick arrives, the series holds one window of ticks,
// the line spans the chart (also after a resize), hovering answers, and the
// chart keeps drawing while the page's own thread is busy.
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
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://localhost:${port}/?rate=${RATE}&window=${WINDOW}`);

  // The status line, parsed back into numbers.
  const stats = async () => {
    const text = await page.textContent('#status');
    if (text.startsWith('error:')) throw new Error(`worker ${text}`);
    const m = text.match(
      /chart (\d+) fps · page (\d+) fps · ([\d,]+) ticks\/s · ([\d,]+) ticks held · delay (\d+) ms(?: · ([\d,]+) dropped)?/,
    );
    if (!m) return null;
    const w = (await page.textContent('#work')).match(
      /pushSeries ([\d.]+) ms\/s · buckets ([\d.]+) ms\/s · frame ([\d.]+) ms/,
    );
    const n = (s) => Number((s ?? '0').replaceAll(',', ''));
    return {
      fps: n(m[1]),
      pageFps: n(m[2]),
      ticksPerSec: n(m[3]),
      rows: n(m[4]),
      delayMs: n(m[5]),
      dropped: n(m[6]),
      pushMs: n(w?.[1]),
      foldMs: n(w?.[2]),
      frameMs: n(w?.[3]),
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
        padLeft: 8,
        padRight: 64,
      },
    );
  };

  // Wait for the history to arrive: the newest tick drawn is under a second
  // old once the chart has caught up.
  await page.waitForFunction(
    () => {
      const m = /delay (\d+) ms/.exec(
        document.querySelector('#status').textContent,
      );
      return m && Number(m[1]) < 1000;
    },
    null,
    { timeout: 60_000 },
  );
  await sleep(1500);

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
  check(
    Math.abs(rows - RATE * WINDOW) / (RATE * WINDOW) < 0.05,
    `series holds one window (${rows} of ${RATE * WINDOW})`,
  );
  check(
    steady.every((s) => s.dropped === 0),
    'no ticks dropped by the server',
  );

  const covered = await lineCoverage();
  check(
    covered > 0.95,
    `line spans the plot (${(covered * 100).toFixed(1)}% of columns)`,
  );

  await page.mouse.move(600, 180);
  await page.waitForFunction(
    () => !document.querySelector('#tooltip').hidden,
    null,
    { timeout: 3000 },
  );
  const tip = await page.textContent('#tooltip');
  check(
    /^\d\d:\d\d:\d\d\.\d{3} {2}\d+\.\d{3} × \d+$/.test(tip),
    `hover shows the tick under the pointer ("${tip}")`,
  );
  await page.mouse.move(600, 500); // off the canvas
  await page.waitForFunction(() => document.querySelector('#tooltip').hidden);
  check(true, 'tooltip hides when the pointer leaves');

  await page.setViewportSize({ width: 800, height: 520 });
  await sleep(500);
  const coveredAfter = await lineCoverage();
  check(
    coveredAfter > 0.95,
    `line spans the plot after a resize (${(coveredAfter * 100).toFixed(1)}%)`,
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
    busy.every((s) => s.dropped === 0) &&
      Math.abs(median(busy.map((s) => s.ticksPerSec)) - RATE) / RATE < 0.1,
    'ticks keep arriving on a busy page',
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
