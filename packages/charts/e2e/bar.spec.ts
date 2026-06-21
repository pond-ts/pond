import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the BarChart (interval-keyed bars + selection). Like the
 * other chart specs, these snapshot the whole story root (`#storybook-root`) so
 * the canvas bars + DOM axes are captured together; each gates on the first
 * canvas having painted.
 *
 * The static-render cases (no pointer needed): the bucket bars, the diverging
 * (straddles-zero) bars, and the controlled-selection highlight.
 */
const staticCases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['charts-barchart--buckets', 'bar-buckets.png'],
  ['charts-barchart--diverging', 'bar-diverging.png'],
  ['charts-barchart--controlled-selection', 'bar-controlled-selection.png'],
];

test.describe('BarChart', () => {
  for (const [id, file] of staticCases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }

  /**
   * The select path: click a bar and snapshot the highlight (brighter fill +
   * outline). Drives a deterministic click into the plot at the 12:00 bar (12/24
   * of the day) — the same bucket the controlled-selection story pins, so the two
   * baselines agree on what a selected bar looks like. Also asserts no render
   * error (the tracker + hit-test both read the series).
   */
  test('highlights a clicked bar', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(story('charts-barchart--hover-select'));
    const dataCanvas = page.locator('canvas').first();
    await waitForCanvasPaint(dataCanvas);
    const box = await dataCanvas.boundingBox();
    if (box === null) throw new Error('no canvas bounding box');
    // The 12:00 bucket sits at 12.5/24 across the plot (bar centre of bucket 12
    // of 24); click mid-height where a tall midday bar is filled.
    await page.mouse.click(
      box.x + (box.width * 12.5) / 24,
      box.y + box.height * 0.6,
    );
    // Move the pointer off the plot so the committed selection (outline) shows in
    // isolation — no transient hover-highlight / flag cursor layered over it.
    await page.mouse.move(box.x - 20, box.y - 20);
    await expect(page.locator('#storybook-root')).toHaveScreenshot(
      'bar-selected.png',
    );
    expect(errors, 'no console/page errors while selecting a bar').toEqual([]);
  });

  /**
   * The hover path (the bar-flag cursor + hover-highlight): hover the RIGHT half
   * of a wide bar and snapshot — the flag, dot, and highlight must land on **that**
   * bar, not the next one. (Regression guard for the nearest-by-`begin` →
   * wrong-bar bug, fixed by span containment in `barIndexAtTime`.) Gates on the
   * SVG flag dot.
   */
  test('flags the bar under the cursor (right half, not the next bar)', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(story('charts-barchart--hover-select'));
    const dataCanvas = page.locator('canvas').first();
    await waitForCanvasPaint(dataCanvas);
    const box = await dataCanvas.boundingBox();
    if (box === null) throw new Error('no canvas bounding box');
    // Hover the right portion of bucket 12 (12.78/24) — past its midpoint, where
    // nearest-by-begin used to flip the flag onto bucket 13.
    await page.mouse.move(
      box.x + (box.width * 12.78) / 24,
      box.y + box.height * 0.55,
    );
    await page.locator('svg circle').first().waitFor({ state: 'attached' });
    await expect(page.locator('#storybook-root')).toHaveScreenshot(
      'bar-hover-flag.png',
    );
    expect(errors, 'no console/page errors while hovering a bar').toEqual([]);
  });
});
