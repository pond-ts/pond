import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the layout system (axes + theme — M2). Unlike the
 * LineChart specs (which screenshot the bare `canvas`), these snapshot the whole
 * story root (`#storybook-root`) so the DOM chrome — y-axis gutters, the shared
 * time axis, unit labels — is captured alongside the canvas (gridlines + lines).
 * Each gates on the first canvas having actually painted.
 *
 * The time axis uses `scaleTime`; Playwright pins `timezoneId: 'UTC'` +
 * `locale: 'en-US'` (see `playwright.config.ts`) so the wall-clock labels are
 * deterministic across machines.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['layout--single-row', 'layout-single-row.png'],
  ['layout--left-axis', 'layout-left-axis.png'],
  ['layout--dual-axis', 'layout-dual-axis.png'],
  ['layout--same-series-two-axes', 'layout-same-series-two-axes.png'],
  ['layout--multi-row', 'layout-multi-row.png'],
  ['layout--varying-gutters', 'layout-varying-gutters.png'],
  ['layout--estela-shaped', 'layout-estela-shaped.png'],
  // Multi-axis per-slot layout + rowGap + optional time axis.
  ['layout--two-left-axes', 'layout-two-left-axes.png'],
  ['layout--per-slot-alignment', 'layout-per-slot-alignment.png'],
  ['layout--multi-axis-both-sides', 'layout-multi-axis-both-sides.png'],
  ['layout--row-gap', 'layout-row-gap.png'],
  ['layout--different-heights', 'layout-different-heights.png'],
  ['layout--no-time-axis', 'layout-no-time-axis.png'],
];

test.describe('Layout', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      // Multi-row stories have several canvases; the first paints with the rest.
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }
});
