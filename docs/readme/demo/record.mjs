// Records a README GIF from one scene in ./scenes, running in headless
// Chromium. Needs the core, react and charts packages built first:
//
//   npm run build --workspace=pond-ts --workspace=@pond-ts/react --workspace=@pond-ts/charts
//   node docs/readme/demo/record.mjs live      # -> docs/readme/live.gif
//
// A scene renders into #root and sets `window.scene = { frames, fps?,
// step(f), pointer?(f, width) }`. Each frame: call step(f) (the scene moves
// its data or parameters on and re-renders synchronously), move the pointer
// if the scene asks, wait for two animation frames so the canvases have
// painted, then screenshot the card. ffmpeg turns the PNGs into a GIF with
// one shared palette.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] ?? 'live';
const out = join(here, '..', `${name}.gif`);
const work = mkdtempSync(join(tmpdir(), 'pond-readme-'));

const bundle = await build({
  entryPoints: [join(here, 'scenes', `${name}.tsx`)],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  minify: true,
  // The website's tsconfig extends a package this build doesn't install.
  tsconfigRaw: {},
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
  .call { display: inline-block; margin-top: 5px; font: 12px ui-monospace, 'SF Mono', Menlo, monospace; color: #0f172a; background: #f1f5f9; border-radius: 4px; padding: 2px 6px; }
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

const { frames, fps } = await page.evaluate(() => ({
  frames: window.scene.frames,
  fps: window.scene.fps ?? 12,
}));
let pointerIn = false;
for (let f = 0; f < frames; f++) {
  const p = await page.evaluate(
    ([f, w]) => {
      window.scene.step(f);
      return window.scene.pointer ? window.scene.pointer(f, w) : null;
    },
    [f, box.width],
  );
  if (p) {
    await page.mouse.move(box.x + p.x, box.y + p.y);
    pointerIn = true;
  } else if (pointerIn) {
    await page.mouse.move(box.x + box.width + 50, box.y + 10);
    pointerIn = false;
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
    String(fps),
    '-i',
    join(work, 'f%04d.png'),
    '-vf',
    'split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    out,
  ],
  { stdio: 'inherit' },
);
// KEEP=1 keeps the frame PNGs and prints where they are.
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
else console.log(work);
console.log(`wrote ${out}`);
