import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

// `.first()` is the data canvas. The cursor overlay is now SVG (not a second
// canvas), so a bare `canvas` locator already matches just the one — `.first()`
// stays as a defensive anchor.
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

  // The value axis (Phase 2): a ValueSeries (HR over cumulative distance) flows
  // through fromValueSeries → a linear x scale. Snapshot #storybook-root, not the
  // bare canvas, so the distance-formatted x-axis labels (0, 1,000, … — the
  // value-axis proof, vs wall-clock time) are captured alongside the line.
  test('renders a ValueSeries against a distance (value) x axis', async ({
    page,
  }) => {
    await page.goto(story('charts-linechart--value-axis-distance'));
    await waitForCanvasPaint(page.locator('canvas').first());
    await expect(page.locator('#storybook-root')).toHaveScreenshot(
      'linechart-value-axis-distance.png',
    );
  });
});
