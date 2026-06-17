import { expect, test, type Locator } from '@playwright/test';

/** Build the Storybook story-iframe URL for a story id. */
const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

/**
 * Wait until the canvas has actually painted — i.e. the backing bitmap has at
 * least one non-transparent pixel. A canvas element is `visible` the instant
 * it's in the DOM, but its pixels aren't there until React's draw effect runs;
 * screenshotting on `toBeVisible` alone races that effect and captures a blank
 * frame. Every visual assertion gates on this first.
 */
async function waitForCanvasPaint(canvas: Locator): Promise<void> {
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      () =>
        canvas.evaluate((el: HTMLCanvasElement) => {
          const ctx = el.getContext('2d');
          if (!ctx) return false;
          const { data } = ctx.getImageData(0, 0, el.width, el.height);
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) return true; // any non-transparent pixel
          }
          return false;
        }),
      { timeout: 5000 },
    )
    .toBe(true);
}

test.describe('Canvas primitive', () => {
  // Behavior: the component's core contract — backing buffer sized to CSS px ×
  // the real device-pixel ratio — verified in an actual browser (the unit test
  // pins this with a forced dpr; this pins it against the real environment).
  test('sizes its backing buffer to CSS size × devicePixelRatio', async ({
    page,
  }) => {
    await page.goto(story('primitives-canvas--diagonal'));
    const canvas = page.locator('canvas');
    await waitForCanvasPaint(canvas);
    const dims = await canvas.evaluate((el: HTMLCanvasElement) => ({
      cssWidth: Math.round(el.getBoundingClientRect().width),
      bufferWidth: el.width,
      dpr: window.devicePixelRatio,
    }));
    expect(dims.bufferWidth).toBe(Math.round(dims.cssWidth * dims.dpr));
  });

  // Visual: the actual pixels. These catch the regressions a draw-call unit
  // test cannot (wrong colour, missing stroke, inverted shape).
  test('Diagonal matches its visual baseline', async ({ page }) => {
    await page.goto(story('primitives-canvas--diagonal'));
    const canvas = page.locator('canvas');
    await waitForCanvasPaint(canvas);
    await expect(canvas).toHaveScreenshot('canvas-diagonal.png');
  });

  test('Wedge matches its visual baseline', async ({ page }) => {
    await page.goto(story('primitives-canvas--wedge'));
    const canvas = page.locator('canvas');
    await waitForCanvasPaint(canvas);
    await expect(canvas).toHaveScreenshot('canvas-wedge.png');
  });
});
