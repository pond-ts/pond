import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Visual baselines + no-throw guards for the annotation primitives (`<Region>`,
 * `<Marker>`, `<Baseline>`). Each story renders the marks in the turquoise
 * register above the data canvas; the snapshot of `#storybook-root` captures the
 * SVG overlay (band / lines / handles) plus the DOM flag chips, the legend, and
 * the create toolbar.
 *
 * These are **initial-render** baselines — the interactive stories (Editable /
 * Select / Create / MultiRow) draw their marks statically until you drag/click,
 * so the static frame is stable to baseline; the drag/select/create *behaviour*
 * is exercised in the unit tests + by hand in Storybook. The error guard is the
 * regression net against a render-time throw (the class of bug that once crashed
 * the tracker without a large enough pixel diff to fail on its own).
 */
const cases: ReadonlyArray<readonly [id: string, file: string]> = [
  ['charts-annotations-scenarios--in-context', 'annotations-in-context.png'],
  ['charts-annotations-scenarios--value-axis', 'annotations-value-axis.png'],
  ['charts-annotations-scenarios--selectable', 'annotations-selectable.png'],
  ['charts-annotations-scenarios--highlight', 'annotations-highlight.png'], // hover-to-highlight regions
  [
    'charts-annotations-scenarios--background-zones',
    'annotations-background-zones.png',
  ], // label-less inert bands
  ['charts-annotations-scenarios--editable', 'annotations-editable.png'],
  ['charts-annotations-scenarios--select', 'annotations-select.png'],
  ['charts-annotations-scenarios--multi-row', 'annotations-multi-row.png'],
  ['charts-annotations-scenarios--create', 'annotations-create.png'],
];

test.describe('Annotations', () => {
  for (const [id, file] of cases) {
    test(`renders ${id}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(story(id));
      // Gate on the data canvas painting; the SVG mark overlays render in the
      // same commit, and `toHaveScreenshot` re-samples until the frame is stable,
      // so any multi-render settle (the cross-row guides register via an effect)
      // resolves before capture. Don't gate on a mark element — the `Create`
      // story starts with *no* marks (an empty draw surface), only the canvas.
      await waitForCanvasPaint(page.locator('canvas').first());
      await expect(page.locator('#storybook-root')).toHaveScreenshot(file);
      expect(errors, 'no console/page errors rendering annotations').toEqual(
        [],
      );
    });
  }
});
