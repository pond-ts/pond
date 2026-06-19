import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the M4 tracker. These stories pin a controlled
 * `trackerPosition`, so the crosshair + per-series dots (overlay canvas) and the
 * readout chips (DOM) render deterministically without a live pointer. Snapshots
 * `#storybook-root` so the overlay + chips are captured together.
 *
 * The uncontrolled / animated stories (`OutsideReadout`, `Playground/LiveSine`)
 * are hover- and time-driven, so they're intentionally not baselined.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['interactions--cursor-sync', 'interactions-cursor-sync.png'],
  ['interactions--flag-readout', 'interactions-flag-readout.png'],
  ['interactions--inline-readout', 'interactions-inline-readout.png'],
];

test.describe('Interactions', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      // These stories render the tracker (sampleAt → value read), so guard
      // against a throwing/erroring render — a regression test for the
      // detached-method bug that crashed the tracker without a screenshot diff
      // big enough to fail on its own.
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
      expect(
        errors,
        'no console/page errors while rendering the tracker',
      ).toEqual([]);
    });
  }
});
