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
});
