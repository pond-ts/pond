import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

// `.first()` is the data canvas — since M4 each plot also has a (transparent,
// not-hovering) tracker-overlay canvas on top, so a bare `canvas` locator would
// match two and fail strict mode.
test.describe('LineChart', () => {
  // The end-to-end proof: a pond TimeSeries flows through fromTimeSeries →
  // ChartContainer/ChartRow → LineChart → canvas. The gap (coast) must read as
  // a break in the line, not a drop to zero.
  test('renders a gap-aware line from a pond TimeSeries', async ({ page }) => {
    await page.goto(story('charts-linechart--with-gap'));
    const canvas = page.locator('canvas').first();
    await waitForCanvasPaint(canvas);
    await expect(canvas).toHaveScreenshot('linechart-with-gap.png');
  });

  // A flat series sits mid-row via the auto-domain's ±1 headroom (not on an
  // edge or NaN-scaled).
  test('renders a flat line with auto-domain headroom', async ({ page }) => {
    await page.goto(story('charts-linechart--flat'));
    const canvas = page.locator('canvas').first();
    await waitForCanvasPaint(canvas);
    await expect(canvas).toHaveScreenshot('linechart-flat.png');
  });

  // Gap-aware data smoothing: the raw noisy line + the smooth(missing:'skip')
  // line, both breaking at the coast (the denoise-vs-curve distinction).
  test('renders raw vs gap-aware-smoothed lines', async ({ page }) => {
    await page.goto(story('charts-linechart--gap-aware-smooth'));
    const canvas = page.locator('canvas').first();
    await waitForCanvasPaint(canvas);
    await expect(canvas).toHaveScreenshot('linechart-gap-aware-smooth.png');
  });
});
