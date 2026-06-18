import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the variance band (M3). Like the Layout specs, these
 * snapshot the whole story root (`#storybook-root`) so the canvas band + DOM
 * axes are captured together; each gates on the first canvas having painted.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['charts-bandchart--two-tone', 'band-two-tone.png'],
  ['charts-bandchart--with-gap', 'band-with-gap.png'],
  ['charts-bandchart--san-francisco-temperature', 'band-sf-temperature.png'],
  ['charts-bandchart--rolling-percentiles', 'band-rolling-percentiles.png'],
];

test.describe('BandChart', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }
});
