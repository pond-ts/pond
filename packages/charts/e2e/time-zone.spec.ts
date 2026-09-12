import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the time axis in a named zone ([PND-TZAXIS]). The
 * Playwright project pins `timezoneId: 'UTC'`, so a zoned story is
 * deterministic: `Kolkata` puts day ticks at 18:30Z with +05:30 dates, and
 * `StackedBands` turns its date bands at Kolkata midnights. Snapshots the
 * whole story root (canvas + DOM axis strip), gated on the canvas painting.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['axes-timeaxis-timezone--kolkata', 'time-zone-kolkata.png'],
  ['axes-timeaxis-timezone--stacked-bands', 'time-zone-stacked-bands.png'],
];

test.describe('TimeZone', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }
});
