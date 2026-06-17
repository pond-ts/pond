import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

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
