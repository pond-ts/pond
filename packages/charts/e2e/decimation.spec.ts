import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * The M4 decimation **visual-losslessness contract** (charts decimator wave,
 * Phase 3). M4 is auto-on and sold as visually lossless, so the regression net is
 * a direct pixel diff: the same 200k-point series drawn **decimated** (the
 * default) vs **full-resolution** (`decimate={false}`) must rasterize to
 * near-identical canvases — differences confined to a thin sub-pixel AA seam
 * along the envelope edges. If the M4 bucketing ever drops, swaps, or grossly
 * mis-places the per-pixel min/max, the mismatch spreads across the envelope area
 * and the fraction blows past the bound.
 *
 * A pixel diff (not a committed screenshot) because the contract is *decimated
 * ≈ full*, not *decimated === a golden image* — it pins the two draws against
 * each other, immune to font drift that would churn a golden. (The exact M4
 * bucket math is pinned tighter by the `decimate.test.ts` unit tests; this is the
 * gross-breakage net.)
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
    // Lossless to within the AA seam: the noise envelope has two long edges the
    // sub-pixel min/max placement antialiases slightly differently, so a few % of
    // pixels differ (measured ~1.8% on CI). The bound catches gross breakage — a
    // dropped/swapped min/max would recolour the whole band (tens of %), not a
    // seam. The exact bucket math is pinned by the unit tests.
    expect(fraction).toBeLessThan(0.04);
  });
});
