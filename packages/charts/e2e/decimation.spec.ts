import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * The M4 decimation **pixel-identity contract** (charts decimator wave, Phase 3).
 * M4 is auto-on and sold as *visually lossless*, so the regression net is a
 * direct pixel diff: the same 200k-point series drawn **decimated** (the default)
 * vs **full-resolution** (`decimate={false}`) must rasterize to (near-)identical
 * canvases. If the M4 bucketing ever drops or mis-places the per-pixel min/max,
 * the mismatch fraction spikes and this fails.
 *
 * A pixel diff (not a committed screenshot) because the contract is *decimated
 * === full*, not *decimated === a golden image* — it pins the two draws against
 * each other, immune to font/AA drift that would churn a golden.
 */

/** The device-pixel bytes of the data canvas for `storyId`. */
async function canvasBytes(
  page: import('@playwright/test').Page,
  storyId: string,
): Promise<{ data: number[]; width: number; height: number }> {
  await page.goto(story(storyId));
  const canvas = page.locator('canvas').first();
  await waitForCanvasPaint(canvas);
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext('2d')!;
    const img = ctx.getImageData(0, 0, el.width, el.height);
    return { data: Array.from(img.data), width: el.width, height: el.height };
  });
}

test.describe('M4 decimation — pixel identity', () => {
  test('decimated 200k line matches the full-resolution draw', async ({
    page,
  }) => {
    const on = await canvasBytes(page, 'performance-decimation--default');
    const off = await canvasBytes(page, 'performance-decimation--off');

    expect(on.width).toBe(off.width);
    expect(on.height).toBe(off.height);

    // Count pixels whose RGBA differs beyond a small per-channel tolerance
    // (sub-pixel AA at column boundaries can nudge a channel a few levels).
    const a = on.data;
    const b = off.data;
    let differing = 0;
    const totalPx = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
      if (
        Math.abs(a[i]! - b[i]!) > 24 ||
        Math.abs(a[i + 1]! - b[i + 1]!) > 24 ||
        Math.abs(a[i + 2]! - b[i + 2]!) > 24 ||
        Math.abs(a[i + 3]! - b[i + 3]!) > 24
      ) {
        differing += 1;
      }
    }
    const fraction = differing / totalPx;
    // Lossless to within AA: well under 1% of pixels may differ (in practice a
    // thin seam along the envelope edge). A broken M4 would diff a large area.
    expect(fraction).toBeLessThan(0.01);
  });
});
