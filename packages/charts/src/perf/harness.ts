/**
 * The in-page bench API — the contract between the bench stories
 * (`Perf.stories.tsx`) and the Playwright perf spec (`e2e/perf.spec.ts`).
 *
 * Measurement runs **in the page** (accurate `performance.now()` / `mark`),
 * not in the Playwright driver (which would fold in nav + IPC latency). The spec
 * orchestrates — set args, wait, call `pan`/`zoom`, sample — and reads results
 * off `window.__bench`. Frame counting is a `requestAnimationFrame` loop the
 * spec runs via `page.evaluate` (per the RFC), so it measures main-thread frame
 * cadence directly and needs no instrumentation of the production renderer.
 *
 * Nothing here is shipped: this module is only imported by the perf stories,
 * which Storybook builds but the package's `dist` excludes (`*.stories.tsx` are
 * not in the `tsc` rootDir set).
 */

/** Which static scenario a bench story renders. */
export type StaticScenario = 'line' | 'three' | 'band';

/** Programmatic interaction hooks a static story installs for the spec. */
export interface BenchDriver {
  /** Pan the controlled view by `fraction` of its span (+ = later in time). */
  pan?(fraction: number): void;
  /** Zoom the controlled view about its centre (`<1` in, `>1` out). */
  zoom?(factor: number): void;
}

/** The shape the spec reads off `window.__bench`. */
export interface BenchApi extends BenchDriver {
  /** mount→first-paint latency in ms, set once after the first draw commits. */
  initialRenderMs: number | null;
}

declare global {
  interface Window {
    __bench?: BenchApi;
  }
}

function ensure(): BenchApi {
  if (typeof window === 'undefined') {
    // SSR / headless without a window — return a detached stub so callers don't
    // crash; the spec only ever runs in a real browser.
    return { initialRenderMs: null };
  }
  if (!window.__bench) {
    window.__bench = { initialRenderMs: null };
  }
  return window.__bench;
}

/**
 * Settling window (ms) over which {@link markFirstPaint} watches for the heavy
 * draw frame after the dataset mounts. Must comfortably exceed the slowest
 * single-frame draw we measure — a 1M-point stroke runs into the multi-second
 * range, so this is generous.
 */
const SETTLE_WINDOW_MS = 6_000;

/**
 * Measure mount→first-paint latency for the current dataset: from the
 * `bench:data-set` mark (stamped in the story's render, *before* any child draw
 * effect runs) to the end of the frame that actually does the heavy draw.
 *
 * **Why not a single `requestAnimationFrame`, and why not "first non-blank
 * pixel":** the expensive stroke runs in the descendant `<Canvas>`'s layout
 * effect, which React commits a *couple of frames after* the mark, and the
 * canvas paints its background in an earlier commit than the line. So a single
 * post-mark rAF (or a first-non-transparent-pixel poll) resolves *before* the
 * stroke lands and reports ~10 ms — confirmed by tracing the stroke to a much
 * later, long frame. (An earlier version had exactly this bug.)
 *
 * Instead we watch rAF cadence across a settling window and take the **largest
 * inter-frame gap** as the heavy-draw frame: mount→first-paint is the mark to
 * the end of that gap (when the browser unblocked and painted the stroked line).
 * For tiny datasets no frame is long, so the largest gap is ~one frame and the
 * latency is correctly small. This is robust to how many commits/frames React
 * takes to land the draw.
 *
 * Idempotent per dataset: the story clears the mark + resets on each dataset
 * change, and this is re-invoked, so it captures the current dataset's latency.
 */
export function markFirstPaint(): void {
  const api = ensure();
  const marks = performance.getEntriesByName('bench:data-set', 'mark');
  const start = marks.length > 0 ? marks[marks.length - 1]!.startTime : null;
  if (start === null) {
    api.initialRenderMs = null;
    return;
  }
  let prev = performance.now();
  let maxGapEnd = prev; // timestamp at the end of the largest gap seen so far
  let maxGap = 0;
  const tick = (now: number) => {
    const gap = now - prev;
    if (gap > maxGap) {
      maxGap = gap;
      maxGapEnd = now;
    }
    prev = now;
    if (now - start < SETTLE_WINDOW_MS) {
      requestAnimationFrame(tick);
      return;
    }
    // Settled: the heavy-draw frame is the largest gap; first-paint is the mark
    // to the end of that frame.
    api.initialRenderMs = maxGapEnd - start;
  };
  requestAnimationFrame(tick);
}

/**
 * Install / refresh the interaction driver hooks. Merges so a story can register
 * `pan`/`zoom` independently; calling with `{}` just ensures the API object
 * exists (a liveness signal the spec can poll for).
 */
export function installBench(driver: BenchDriver): void {
  const api = ensure();
  if (driver.pan) api.pan = driver.pan;
  if (driver.zoom) api.zoom = driver.zoom;
}
