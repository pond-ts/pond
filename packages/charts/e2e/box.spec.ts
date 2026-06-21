import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the box-and-whisker plot. Like the BandChart specs, these
 * snapshot the whole story root (`#storybook-root`) so the canvas boxes + DOM
 * axes are captured together; each gates on the first canvas having painted.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['charts-boxplot--percentiles', 'box-percentiles.png'],
  ['charts-boxplot--with-gap', 'box-with-gap.png'],
  ['charts-boxplot--themed', 'box-themed.png'],
];

test.describe('BoxPlot', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }

  /**
   * The box-flag cursor: hover a box and snapshot the **consolidated** flag — all
   * five values on one horizontal chip (median brighter, whiskers in the whisker
   * colour) with a single staff to the box's top-centre. Gates on the SVG staff.
   */
  test('renders the consolidated box flag on hover', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(story('charts-boxplot--cursor-flag'));
    const canvas = page.locator('canvas').first();
    await waitForCanvasPaint(canvas);
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('no canvas bounding box');
    // Hover mid-plot (a box near the window centre).
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.locator('svg line').first().waitFor({ state: 'attached' });
    await expect(page.locator('#storybook-root')).toHaveScreenshot(
      'box-cursor-flag.png',
    );
    expect(errors, 'no console/page errors while hovering a box').toEqual([]);
  });
});
