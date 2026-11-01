// Why is a 10 s window at 1M ticks/s only 70-80% full in the sweep, even
// though 10 s of history is sent? Opens that one scenario (raw + buckets,
// 1M ticks/s, 10 s window, 10 s of history) and logs, from each
// once-a-second engine report: ticks in view, bucket columns filled, ticks the
// server dropped, and the delay. Run from the repo root:
//
//   node spikes/offscreen-stream/fill-probe.mjs > spikes/offscreen-stream/results/cloud-fill-probe.txt
//
// Other scenarios: fill-probe.mjs <ticks/s> <window s> <m4|buckets> (history = the window).
import { chromium } from '@playwright/test';
import { startServer } from './server.mjs';
const { server, port } = await startServer({ port: 0 });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? undefined,
});
const page = await browser.newPage({
  viewport: { width: 1232, height: 700 },
  deviceScaleFactor: 1,
});
const [rate = 1_000_000, window = 10, draw = 'buckets'] = process.argv.slice(2);
const qs = new URLSearchParams({
  mode: 'worker',
  busy: 0,
  interval: 16,
  pipeline: 'raw',
  draw,
  rate,
  window,
  dpr: 1,
  prefill: window,
}).toString();
console.log(
  `# raw + ${draw}, ${rate} ticks/s, ${window} s window, ${window} s of history`,
);
const t0 = Date.now();
await page.goto(`http://localhost:${port}/?${qs}`);
let droppedTotal = 0;
let seen = 0;
console.log(
  't(s)  points     columns  dropped-this-report  dropped-total  delay-p50',
);
for (let s = 0; s < Number(window) + 25; s++) {
  await page.waitForTimeout(1000);
  const reps = await page.evaluate((a) => window.__reports.slice(a), seen);
  seen += reps.length;
  for (const r of reps) {
    droppedTotal += r.raw.dropped;
    console.log(
      `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} ${String(r.points).padStart(9)} ${String(r.columns).padStart(8)} ${String(r.raw.dropped).padStart(20)} ${String(droppedTotal).padStart(14)} ${String(r.latencyP50).padStart(9)}`,
    );
  }
}
await browser.close();
server.close();
process.exit(0);
