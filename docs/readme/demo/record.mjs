// Records docs/readme/live-demo.gif from demo.tsx running in headless
// Chromium. Needs the core, react and charts packages built first:
//
//   npm run build --workspace=pond-ts --workspace=@pond-ts/react --workspace=@pond-ts/charts
//   node docs/readme/demo/record.mjs
//
// Each frame: call window.step() (pushes one second of events and
// re-renders), wait for two animation frames so the canvases have painted,
// then screenshot the card. ffmpeg turns the PNGs into a GIF with one
// shared palette.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'live-demo.gif');
const FRAMES = 150;
const FPS = 12;
const work = mkdtempSync(join(tmpdir(), 'pond-readme-'));

const bundle = await build({
  entryPoints: [join(here, 'demo.tsx')],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

const css = `
  html, body { margin: 0; background: #ffffff; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #0f172a; }
  .card { width: 880px; padding: 14px 16px 10px; box-sizing: border-box; background: #fff; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .title { display: flex; align-items: center; gap: 8px; font-size: 15px; }
  .sub { color: #64748b; font-weight: 400; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #d64545; box-shadow: 0 0 0 3px rgba(214,69,69,0.18); }
  .stats { display: flex; gap: 22px; }
  .stat { text-align: right; }
  .stat .v { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 10.5px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
`;
writeFileSync(
  join(work, 'index.html'),
  `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`,
);

// PLAYWRIGHT_CHROMIUM points at a Chromium binary when the one matching
// this playwright version isn't installed.
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {},
);
const page = await browser.newPage({
  viewport: { width: 880, height: 600 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (e) => {
  console.error(e);
  process.exit(1);
});
await page.goto(`file://${join(work, 'index.html')}`);
await page.waitForSelector('.card canvas');
const card = page.locator('.card');
const box = await card.boundingBox();

const paint = () =>
  page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );

for (let f = 0; f < FRAMES; f++) {
  await page.evaluate(() => window.step());
  // The pointer sweeps across the middle stretch of the recording, so the
  // crosshair reads values off all three rows; then it leaves.
  if (f >= 55 && f < 125) {
    const p = (f - 55) / 70;
    const x = box.x + 120 + p * (box.width - 200);
    const y = box.y + 70 + 60 + 25 * Math.sin(p * Math.PI * 2);
    await page.mouse.move(x, y);
  } else if (f === 125) {
    await page.mouse.move(box.x + box.width + 50, box.y + 10);
  }
  await paint();
  await card.screenshot({
    path: join(work, `f${String(f).padStart(4, '0')}.png`),
  });
}
await browser.close();

execFileSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(FPS),
    '-i',
    join(work, 'f%04d.png'),
    '-vf',
    'split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    out,
  ],
  { stdio: 'inherit' },
);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}`);
