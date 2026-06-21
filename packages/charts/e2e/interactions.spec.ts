import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the M4 cursor (tracker). The stories are hover-driven (no
 * controlled `trackerPosition`), so the test drives a deterministic pointer to
 * 12:30 — the same x the stories used to pin — before snapshotting. Each story
 * sets a different `cursor` mode; the snapshot of `#storybook-root` captures the
 * mode's marks (the line / dots / staff on the SVG overlay + the chips in the DOM).
 *
 * The uncontrolled / animated stories (`OutsideReadout`, `Playground/LiveSine`)
 * are panel- and time-driven, so they're intentionally not baselined.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['interactions--cursor-sync', 'interactions-cursor-sync.png'], // line (default)
  ['interactions--point-cursor', 'interactions-point-cursor.png'], // point
  ['interactions--flag-readout', 'interactions-flag-readout.png'], // flag
  ['interactions--inline-readout', 'interactions-inline-readout.png'], // inline
  ['interactions--formats', 'interactions-formats.png'], // format → readout (multi)
  ['interactions--cursor-time', 'interactions-cursor-time.png'], // time atop readout
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
      const dataCanvas = page.locator('canvas').first();
      await waitForCanvasPaint(dataCanvas);
      // Drive the hover to 12:30 (30/59 of the window). The wrapper maps
      // clientX − left → plot pixel and the data canvas sits at the plot's left
      // edge, so a canvas-relative x is the plot pixel — this lands the crosshair
      // exactly where the controlled-tracker baseline expects it.
      const box = await dataCanvas.boundingBox();
      if (box === null) throw new Error('no canvas bounding box');
      await page.mouse.move(
        box.x + (box.width * 30) / 59,
        box.y + box.height / 2,
      );
      // Wait for the cursor's SVG marks (line / dots / staff) to render post-hover.
      await page.locator('svg line, svg circle').first().waitFor();
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
      expect(
        errors,
        'no console/page errors while rendering the tracker',
      ).toEqual([]);
    });
  }

  // The controlled-tracker path draws the crosshair from `trackerPosition` (no
  // pointer), so the hover-driven cases above don't exercise it. Anchor it with
  // a no-throw smoke check — not screenshotted, since a controlled crosshair at
  // time T is the same render as a hover at T (already baselined above).
  test('renders controlled-cursor without error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(story('interactions--controlled-cursor'));
    // The cursor's SVG marks render from the controlled position.
    await page.locator('svg line, svg circle').first().waitFor();
    expect(
      errors,
      'no console/page errors rendering the controlled tracker',
    ).toEqual([]);
  });
});
