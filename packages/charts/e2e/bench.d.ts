/**
 * Ambient `window.__bench` shape for the perf specs' in-page `page.evaluate`
 * callbacks. Mirrors `BenchApi` in `src/perf/harness.ts` (the source of truth,
 * which the bench *stories* implement) — duplicated here because the e2e specs
 * compile in their own context and don't import from `src`. Keep the two in
 * sync; the shape is tiny and stable.
 */
declare global {
  interface Window {
    __bench?: {
      initialRenderMs: number | null;
      pan?: (fraction: number) => void;
      zoom?: (factor: number) => void;
    };
  }
}

export {};
