import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines for the ScatterChart. The static stories snapshot the whole
 * story root (`#storybook-root`) so the canvas points + DOM axes are captured
 * together; each gates on the first canvas having painted.
 *
 * `ControlledSelect` is interaction-driven (click → panel), so it's exercised by
 * the behavioural tests below rather than a static baseline.
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['charts-scatterchart--encoded', 'scatter-encoded.png'],
  ['charts-scatterchart--labelled', 'scatter-labelled.png'],
  ['charts-scatterchart--over-line', 'scatter-over-line.png'],
];

test.describe('ScatterChart', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      await page.goto(story(id));
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
    });
  }

  // Hover snaps the tracker to the nearest point (sampleAt). Drive a
  // deterministic pointer to mid-plot and snapshot the crosshair + snapped dot
  // (overlay canvas) — and guard against a throwing render (the detached-method
  // class of bug that crashed the tracker silently).
  test('hover snaps the tracker to the nearest point', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(story('charts-scatterchart--encoded'));
    const dataCanvas = page.locator('canvas').first();
    await waitForCanvasPaint(dataCanvas);
    const box = await dataCanvas.boundingBox();
    if (box === null) throw new Error('no canvas bounding box');
    // Hover at 24/47 of the window (the 'peak' point's neighbourhood), centred
    // vertically — the dot snaps to whichever point is nearest in time.
    await page.mouse.move(
      box.x + (box.width * 24) / 47,
      box.y + box.height / 2,
    );
    // The overlay (2nd canvas) is transparent until the crosshair + dot paint.
    await waitForCanvasPaint(page.locator('canvas').nth(1));
    await expect(page.locator('#storybook-root')).toHaveScreenshot(
      'scatter-hover-snap.png',
    );
    expect(errors, 'no console/page errors while hovering').toEqual([]);
  });

  // Click selection: the ControlledSelect story wires onSelect → a panel. Click a
  // point and assert the panel reflects a selection (DOM, robust to sub-pixel
  // geometry), then click empty space to clear. Exercises hitTest + the
  // highlight-ring draw end to end.
  test('clicking a point selects it; empty space clears', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(story('charts-scatterchart--controlled-select'));
    const dataCanvas = page.locator('canvas').first();
    await waitForCanvasPaint(dataCanvas);
    const box = await dataCanvas.boundingBox();
    if (box === null) throw new Error('no canvas bounding box');

    const panel = page.locator('#storybook-root');
    await expect(panel).toContainText('click a point');

    // Sweep a vertical line of clicks across mid-plot until one lands on a point
    // (the price wanders, so a single y guess can miss). Mid-window x is dense.
    const cx = box.x + box.width * 0.5;
    let selected = false;
    for (let f = 0.1; f <= 0.9 && !selected; f += 0.05) {
      await page.mouse.click(cx, box.y + box.height * f);
      if (await panel.locator('text=price').count()) selected = true;
    }
    expect(selected, 'a click landed on a point and selected it').toBe(true);
    await expect(panel).toContainText('price');

    // Click a corner (empty) to clear — the panel returns to its prompt.
    await page.mouse.click(box.x + 2, box.y + 2);
    await expect(panel).toContainText('click a point');

    expect(errors, 'no console/page errors while selecting').toEqual([]);
  });
});
