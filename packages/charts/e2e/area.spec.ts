import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the area layer. Like the Band specs, these snapshot the
 * whole story root (`#storybook-root`) so the canvas fill + DOM axes are
 * captured together; each gates on the first canvas having painted.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['charts-areachart--elevation', 'area-elevation.png'],
  ['charts-areachart--above-below-axis', 'area-above-below-axis.png'],
];

test.describe('AreaChart', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }
});
