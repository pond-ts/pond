import { chromium } from 'playwright';

const configs = [
  {
    name: 'headless+metal+novsync',
    headless: true,
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    ],
  },
  { name: 'headless default', headless: true, args: [] },
  {
    name: 'headed',
    headless: false,
    args: ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
  },
];

for (const cfg of configs) {
  try {
    const browser = await chromium.launch({
      headless: cfg.headless,
      args: cfg.args,
    });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8124/pond/pond.html', {
      waitUntil: 'domcontentloaded',
    });
    const info = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl
        ? dbg
          ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER)
        : 'no webgl';
      // measure rAF cadence over 60 frames
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) await new Promise(requestAnimationFrame);
      const rafHz = 60000 / (performance.now() - t0);
      return { renderer, rafHz: Math.round(rafHz) };
    });
    console.log(cfg.name, '→', JSON.stringify(info));
    await browser.close();
  } catch (e) {
    console.log(cfg.name, '→ FAILED', String(e).slice(0, 150));
  }
}
