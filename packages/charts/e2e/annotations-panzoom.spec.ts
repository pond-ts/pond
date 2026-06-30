import { expect, test, type Page } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * **Behavior (Layer 3) — `panZoom` + a *selectable but non-editable* mark.** The
 * `PanZoomSelect` story turns on pan/zoom and places a `<Region>`/`<Marker>` with
 * no `onChange` (selectable, not editable). Two gestures must both keep working on
 * the same mark, and the render is identical whether or not the select fires — so
 * only real pointer events can tell them apart (a screenshot can't):
 *
 * - a **single click** (press + release, no drag) still **selects** the mark
 *   (`onSelectAnnotation` → the `selected:` readout), even though the plot owns
 *   pan/zoom and `setPointerCapture`s the pointer on press;
 * - a **press-drag** still **pans** (the mark is non-editable, so the gesture
 *   reads straight through to the plot → the `panned:` readout) and must not fire
 *   a spurious select.
 *
 * Regression guard for the deferred Codex P1 from #308: a non-editable mark's
 * press bubbles to the plot, which captures the pointer; click-retargeting after
 * capture must not swallow the select.
 */

const STORY = 'charts-annotations-scenarios--pan-zoom-select';
// Marker is at index 32 of 40 (fraction 0.8); the region spans 14..24 (centre 19
// → 0.475). 0.9 is clear of both marks (empty plot). Vertically centred.
const MARKER_FRAC = 32 / 40;
const REGION_FRAC = 19 / 40;
const EMPTY_FRAC = 0.9;

/** Screen-space point at horizontal `frac` of the (painted) data canvas, vertically
 *  centred. The data canvas sits at the plot's left edge and spans the plot width,
 *  so a canvas-relative x is the plot pixel — the same mapping the tracker e2e uses. */
async function plotPoint(
  page: Page,
  frac: number,
): Promise<{ x: number; y: number }> {
  const canvas = page.locator('canvas').first();
  await waitForCanvasPaint(canvas);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas bounding box');
  return { x: box.x + box.width * frac, y: box.y + box.height / 2 };
}

/** A pure click: move, press, release at the *same* point (no drag → `moved` stays
 *  false, so it reads as a select, not the tail of a pan). */
async function click(page: Page, frac: number): Promise<void> {
  const p = await plotPoint(page, frac);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** A horizontal press-drag from `frac` (leftwards, well past the 4px pan slop). */
async function drag(page: Page, frac: number): Promise<void> {
  const p = await plotPoint(page, frac);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 80, p.y, { steps: 12 });
  await page.mouse.up();
}

test.describe('Annotations · panZoom + select', () => {
  // No-throw guard (the repo convention): an interactive mark that threw on
  // render/interaction could otherwise leave the behavior assertions to fail with
  // a confusing message; surface the real error instead.
  let errors: string[];
  test.beforeEach(({ page }) => {
    errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
  });
  test.afterEach(() => {
    expect(
      errors,
      'no console/page errors during the panZoom+select gesture',
    ).toEqual([]);
  });

  test('click on a selectable non-editable MARKER selects it (panZoom on)', async ({
    page,
  }) => {
    await page.goto(story(STORY));
    await expect(page.getByTestId('panzoom')).toHaveText('panZoom: on');
    await expect(page.getByTestId('selected')).toHaveText('selected: none');
    await click(page, MARKER_FRAC);
    await expect(page.getByTestId('selected')).toHaveText('selected: marker');
  });

  test('click on a selectable non-editable REGION selects it (panZoom on)', async ({
    page,
  }) => {
    await page.goto(story(STORY));
    await click(page, REGION_FRAC);
    await expect(page.getByTestId('selected')).toHaveText('selected: region');
  });

  test('press-drag starting ON the marker pans and does not select (pan reads through)', async ({
    page,
  }) => {
    await page.goto(story(STORY));
    await drag(page, MARKER_FRAC);
    await expect(page.getByTestId('panned')).toHaveText('panned: yes');
    await expect(page.getByTestId('selected')).toHaveText('selected: none');
  });

  test('press-drag on empty plot pans (panZoom baseline)', async ({ page }) => {
    await page.goto(story(STORY));
    await drag(page, EMPTY_FRAC);
    await expect(page.getByTestId('panned')).toHaveText('panned: yes');
  });
});
