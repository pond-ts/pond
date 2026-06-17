import { defineConfig, devices } from '@playwright/test';

const PORT = 6010;

/**
 * Playwright drives the real-browser test layers — behavior and visual
 * regression — against a static Storybook build (the stories in `src/` are the
 * fixtures). Canvas pixels differ across OS / GPU / fonts, so screenshot
 * baselines are platform-suffixed (Playwright does this by default) and **CI
 * (Linux) owns the committed baselines**; local (darwin / win32) baselines are
 * git-ignored and best-effort. See PLAN.md → Current focus → Testing strategy.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  expect: {
    // A small tolerance absorbs sub-pixel anti-aliasing differences without
    // hiding a real rendering regression.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build the static Storybook once, then serve it — deterministic, no HMR.
    command: `npm run build-storybook -- --quiet && npx http-server storybook-static -p ${PORT} -s -c-1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
