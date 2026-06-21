import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the shared gap-rendering modes (`none` / `empty` /
 * `dashed` / `step` / `fade`) on each gap-aware layer. Each story stacks the five
 * modes top→bottom over one gapped series, so a single snapshot captures all five
 * renderings of the same coast side by side. Snapshots the whole story root
 * (`#storybook-root`) — multiple rows + DOM axes — and gates on the first canvas
 * having painted.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['charts-gapmodes--line', 'gap-modes-line.png'],
  ['charts-gapmodes--area', 'gap-modes-area.png'],
  ['charts-gapmodes--band', 'gap-modes-band.png'],
];

test.describe('GapModes', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }
});
