/** Does a cursor mousemove repaint the data canvas? Count __drawStats identity
 *  changes (one fresh object per row-canvas repaint) during a 3 s CDP sweep. */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
for (const url of [
  'http://127.0.0.1:8123/pond.html',
  'http://127.0.0.1:8123/pond.html?decimate=0',
]) {
  const page = await browser.newPage({
    viewport: { width: 1980, height: 900 },
  });
  const cdp = await page.context().newCDPSession(page);
  await page.goto(url);
  await page.waitForFunction(() => window.__bench && window.__bench.done);
  const box = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.evaluate(() => {
    window.__repaints = 0;
    let last = window.__drawStats;
    window.__iv = setInterval(() => {
      if (window.__drawStats !== last) {
        window.__repaints += 1;
        last = window.__drawStats;
      }
    }, 2);
  });
  const t0 = Date.now();
  let x = box.x + 4,
    dir = 1,
    events = 0;
  const y = box.y + box.h / 2;
  while (Date.now() - t0 < 3000) {
    x += dir * 8;
    if (x > box.x + box.w - 4) dir = -1;
    else if (x < box.x + 4) dir = 1;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    events += 1;
    await new Promise((r) => setTimeout(r, 8));
  }
  const out = await page.evaluate(() => ({
    repaints: window.__repaints,
    drawMs: window.__drawStats.totalDrawMs,
  }));
  console.log(url, JSON.stringify({ events, ...out }));
  await page.close();
}
await browser.close();
