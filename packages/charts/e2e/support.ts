import { expect, type Locator } from '@playwright/test';

/** Storybook story-iframe URL for a story id. */
export const story = (id: string): string =>
  `/iframe.html?id=${id}&viewMode=story`;

/**
 * Wait until the canvas has actually painted — i.e. its backing bitmap has at
 * least one non-transparent pixel. A canvas element is `visible` the instant
 * it's in the DOM, but its pixels aren't there until React's draw effect runs;
 * screenshotting on `toBeVisible` alone races that effect and captures a blank
 * frame. Every visual assertion gates on this first.
 */
export async function waitForCanvasPaint(canvas: Locator): Promise<void> {
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
