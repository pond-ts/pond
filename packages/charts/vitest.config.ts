import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // Unit tests only. The Playwright behavior/visual specs live in `e2e/` and
    // use `.spec.ts` — keep vitest from picking them up (its default glob
    // includes `*.spec.*`).
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
