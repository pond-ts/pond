import { defineConfig, devices } from '@playwright/test';

const PORT = 6010;

/**
 * The directional render bench (`e2e/perf.spec.ts`) is opt-in: it's slow (1M
 * points × scenarios) and produces noisy absolute numbers, so it must not run in
 * the normal gate. Enable it with `PERF_BENCH=1` (the `perf` npm script does
 * this). When off, it's excluded from discovery; the perf *invariants*
 * (`perf-invariants.spec.ts`) always run — they're robust pass/fail gates.
 */
const PERF_BENCH = process.env.PERF_BENCH === '1';

/**
 * Playwright drives the real-browser test layers — behavior, visual regression,
 * and the perf invariants — against a static Storybook build (the stories in
 * `src/` are the fixtures). Canvas pixels differ across OS / GPU / fonts, so
 * screenshot baselines are platform-suffixed (Playwright does this by default)
 * and **CI (Linux) owns the committed baselines**; local (darwin / win32)
 * baselines are git-ignored and best-effort. See PLAN.md → Current focus →
 * Testing strategy.
 */
export default defineConfig({
  testDir: './e2e',
  // Exclude the directional bench from the default gate; the `perf` script
  // re-includes it via PERF_BENCH=1.
  testIgnore: PERF_BENCH ? [] : ['**/perf.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    // The time axis uses d3 `scaleTime`, which ticks + formats in the browser's
    // local timezone/locale. Pin both so visual baselines are reproducible
    // across machines (the component still renders local time in production).
    timezoneId: 'UTC',
    locale: 'en-US',
    launchOptions: {
      // --enable-precise-memory-info makes performance.memory report exact
      // usedJSHeapSize (otherwise it's bucketed, hiding small trends).
      // --expose-gc lets the heap invariant nudge GC before sampling.
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
    },
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
