import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the 2026-08 SPARC friction wave — threshold banding
 * ([PND-BANDBAR2]), `<YAxis hide>` ([PND-AXISHIDE]) and category band packing
 * ([PND-BANDPACK]).
 *
 * These three are exactly the changes a unit test cannot fully speak for:
 * every one of them is a claim about **where ink lands**. Banding says a bar's
 * length is sliced at the right values in the right colours; `hide` says a
 * gutter's width goes back to the plot *and* that a row still lines up with its
 * siblings; packing says a slot pitch is capped and the block sits where it was
 * asked to. The unit suite pins the geometry that produces those pixels, and
 * pixel baselines pin that the geometry is still what reaches the screen.
 *
 * Two of these stories exist because walking them by hand caught real defects —
 * a doubled x-axis and a stray rotated axis title — and one (`HiddenVsShown`)
 * covers the multi-row alignment case the Codex review found broken. Snapshots
 * are the cheap way to keep all three from coming back.
 *
 * Whole-root screenshots (`#storybook-root`) as the other chart specs do, so
 * canvas ink and DOM axis chrome are captured together — for `hide` and
 * `bandAlign` the *relationship* between the two is the thing under test.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  // ── Threshold banding: the ladder, both signs, both orientations. ──────────
  // Default: three bands, one bar per band-depth (all three / two / one), which
  // also pins that a band a bar never reaches draws nothing.
  ['bars-thresholds--default', 'sparc-bands-default.png'],
  // Negatives mirror the ladder below the baseline (the diverging case).
  ['bars-thresholds--signed', 'sparc-bands-signed.png'],
  // The transposed path — bands slice x while the bin span runs down y.
  ['bars-thresholds--horizontal', 'sparc-bands-horizontal.png'],
  // A five-band ladder: nothing in the geometry is fixed at three.
  ['bars-thresholds--five-bands', 'sparc-bands-five.png'],
  // Resolved from `BarStyle.bands` with no `bandColors` — the theme path.
  ['bars-thresholds--from-theme', 'sparc-bands-from-theme.png'],

  // ── <YAxis hide>: the gutter goes, the scale stays. ───────────────────────
  // Two rows on one pinned domain, one axis hidden. The lines must trace
  // identically and both plots must start at the same x — the multi-row
  // alignment case that shipped broken until the Codex pass caught it.
  ['axes--hidden-vs-shown', 'sparc-hidden-vs-shown.png'],
  // Gridlines survive a hidden axis (they belong to the plot, not the gutter).
  ['axes--hidden-axis-with-grid', 'sparc-hidden-axis-grid.png'],

  // ── Band packing: pitch capped, block placed. ─────────────────────────────
  // Three categories and six at the same cap — the bars must be the same width.
  ['axes-categoryaxis--stable-pitch', 'sparc-pack-stable-pitch.png'],
  ['axes-categoryaxis--band-align-center', 'sparc-pack-center.png'],
  ['axes-categoryaxis--band-align-end', 'sparc-pack-end.png'],
  // The cap stops binding as categories accumulate — degrades to fill, no clip.
  ['axes-categoryaxis--cap-does-not-bind', 'sparc-pack-unbound.png'],
];

test.describe('SPARC friction wave', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
      expect(errors, `no console/page errors rendering ${id}`).toEqual([]);
    });
  }

  /**
   * Selection on a banded bar: click low in the *alarm* slice of the tallest
   * bar and confirm the whole bar reads as selected — one outline around one
   * bar, not a third of one. This is [PND-BANDBAR2]'s load-bearing claim (a
   * banded bar is still one bar) asserted in pixels; the unit suite asserts the
   * same thing through `hitTest`, and the two together cover both halves of it.
   */
  test('selects the whole bar when a band is clicked', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(story('bars-thresholds--selectable'));
    const dataCanvas = page.locator('canvas').first();
    await waitForCanvasPaint(dataCanvas);
    const box = await dataCanvas.boundingBox();
    if (box === null) throw new Error('no canvas bounding box');
    // Bar 3 of 6 ('db', value 3.2 — the only one reaching the alarm band).
    // Click near its top, inside the red slice rather than the green base.
    await page.mouse.click(
      box.x + (box.width * 3.5) / 6,
      box.y + box.height * 0.12,
    );
    // Park the pointer off-plot so the committed selection shows without a
    // hover state layered over it (the convention bar.spec.ts uses).
    await page.mouse.move(box.x - 20, box.y - 20);
    await expect(page.locator('#storybook-root')).toHaveScreenshot(
      'sparc-bands-selected.png',
    );
    expect(errors, 'no console/page errors selecting a banded bar').toEqual([]);
  });
});
