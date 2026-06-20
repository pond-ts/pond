import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { story, waitForCanvasPaint } from './support.js';

/**
 * The render bench (Phase 1) — the directional, machine-recorded curve.
 *
 * This is **not** a pass/fail CI gate (FPS / timing absolutes are runner-noisy
 * — those live in the perf-invariant specs). It drives the bench stories at each
 * size × scenario, collects metrics in-page off `window.__bench` + a rAF frame
 * loop, and writes `packages/charts/perf/baseline.json` for the committed
 * results writeup. Run it deliberately:
 *
 *   npm run perf            # (script added in package.json)
 *
 * Numbers are directional and relative — the machine is recorded in the JSON
 * (`perf/RESULTS.md` interprets them). What's stable across machines is the
 * *shape* of the curve (where draw-everything tops out, on which metric), which
 * is what orders the decimator work.
 */

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'perf');

/** Static-curve sizes (the competitive profile) — 1k…1M. */
const STATIC_SIZES = [1_000, 10_000, 100_000, 500_000, 1_000_000] as const;
/** Static scenarios — single line, 3 series, band. (Bar/Scatter: future seam.) */
const STATIC_SCENARIOS = ['line', 'three', 'band'] as const;

/** rAF-loop frame budget for an interaction sample (ms). ~1s of frames. */
const FRAME_WINDOW_MS = 1_000;

/**
 * Per-interaction-phase deadline (ms). At extreme sizes a single pan-driven
 * full redraw can take seconds; the rAF window then stretches far past
 * `FRAME_WINDOW_MS`. This caps each phase so the test budget survives — on
 * timeout the FPS field is recorded as null ("too slow to sample"), itself a
 * finding.
 */
const INTERACTION_DEADLINE_MS = 30_000;

interface FrameStats {
  frames: number;
  durationMs: number;
  fps: number;
  /** Worst single inter-frame gap (ms) — a stutter the mean would hide. */
  maxFrameGapMs: number;
}

/** Median of a numeric list (sorted copy; mean of the two middles if even). */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Resolve `p`, or `null` if it doesn't settle within `ms`. Used to bound an
 * interaction sample so a pathologically slow redraw records as "unsampled"
 * rather than hanging the whole test past its timeout.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Story-iframe URL with Storybook args appended (`key:value;key:value`). */
function storyWithArgs(
  id: string,
  args: Record<string, string | number>,
): string {
  const enc = Object.entries(args)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return `${story(id)}&args=${enc}`;
}

/**
 * Run a `requestAnimationFrame` loop in the page for ~`windowMs` and return
 * frame stats. Measures main-thread frame cadence directly (the FPS the user
 * sees), which folds in whatever draw / React / GC work is happening.
 */
async function measureFrames(
  page: import('@playwright/test').Page,
  windowMs: number,
): Promise<FrameStats> {
  return page.evaluate(async (ms) => {
    return new Promise<FrameStats>((resolve) => {
      let frames = 0;
      let maxGap = 0;
      let last = performance.now();
      const start = last;
      function tick(now: number) {
        const gap = now - last;
        if (gap > maxGap) maxGap = gap;
        last = now;
        frames += 1;
        if (now - start >= ms) {
          const durationMs = now - start;
          resolve({
            frames,
            durationMs,
            fps: (frames / durationMs) * 1000,
            maxFrameGapMs: maxGap,
          });
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }, windowMs);
}

/** Read the JS heap (bytes) if Chromium exposes it, else null. */
async function readHeap(
  page: import('@playwright/test').Page,
): Promise<number | null> {
  return page.evaluate(() => {
    const mem = (
      performance as unknown as { memory?: { usedJSHeapSize: number } }
    ).memory;
    return mem ? mem.usedJSHeapSize : null;
  });
}

interface StaticResult {
  scenario: string;
  size: number;
  initialRenderMs: number;
  /** Null if the interaction sample failed (e.g. a hang at extreme sizes). */
  panFps: number | null;
  panMaxFrameGapMs: number | null;
  zoomFps: number | null;
}

interface LiveResult {
  scenario: string;
  windowSize: number;
  pushMs: number;
  batch: number;
  fps: number;
  maxFrameGapMs: number;
  /** Heap samples (bytes) across the window, or null if unavailable. */
  heapSamples: (number | null)[];
  /** Linear-fit slope of heap vs sample index (bytes/sample); null if no heap. */
  heapSlopeBytesPerSample: number | null;
}

const staticResults: StaticResult[] = [];
const liveResults: LiveResult[] = [];

test.describe('perf bench (directional curve)', () => {
  // Generous timeout: a 1M-point initial render + pan/zoom windows can take a
  // while — that slowness is itself a finding the bench must *record*, not fail
  // on. This spec is opt-in, not part of the gating run.
  test.setTimeout(240_000);

  for (const scenario of STATIC_SCENARIOS) {
    for (const size of STATIC_SIZES) {
      test(`static ${scenario} @ ${size}`, async ({ page }) => {
        await page.goto(
          storyWithArgs('perf-bench--static', { scenario, size }),
        );

        // The ready signal *is* `initialRenderMs` — set by markFirstPaint once
        // it has watched rAF cadence for the heavy-draw frame (harness.ts), so
        // it only goes non-null after the chart actually painted. Polling it
        // (generous timeout) tolerates a slow many-point render, which is the
        // point — we want to record how slow it is, not time out on it.
        await expect
          .poll(
            () => page.evaluate(() => window.__bench?.initialRenderMs ?? null),
            { timeout: 120_000 },
          )
          .not.toBeNull();
        const initialRenderMs = await page.evaluate(
          () => window.__bench!.initialRenderMs!,
        );

        // Record the headline row *now*, before interactions. A pan/zoom phase
        // at extreme sizes can be slow enough to hit the test-level timeout
        // (which kills the test from outside any try/catch) — pushing first
        // guarantees every size contributes its initial-render number. The
        // interaction fields are filled in below if they complete in budget.
        const row: StaticResult = {
          scenario,
          size,
          initialRenderMs: Math.round(initialRenderMs * 100) / 100,
          panFps: null,
          panMaxFrameGapMs: null,
          zoomFps: null,
        };
        staticResults.push(row);

        // Interaction FPS, bounded so a slow redraw can't blow the test budget:
        // each phase races a deadline; on timeout the field stays null and we
        // move on. The driver updates the controlled range each call; the rAF
        // loop counts the frames the main thread actually delivered.
        const panFrames = await withDeadline(
          Promise.all([
            measureFrames(page, FRAME_WINDOW_MS),
            page.evaluate(async () => {
              const b = window.__bench!;
              for (let i = 0; i < 20; i += 1) {
                b.pan?.(0.01);
                await new Promise((r) => setTimeout(r, 16));
              }
            }),
          ]).then(([stats]) => stats),
          INTERACTION_DEADLINE_MS,
        );
        if (panFrames) {
          row.panFps = Math.round(panFrames.fps * 10) / 10;
          row.panMaxFrameGapMs = Math.round(panFrames.maxFrameGapMs * 10) / 10;
        }

        const zoomFrames = await withDeadline(
          Promise.all([
            measureFrames(page, FRAME_WINDOW_MS),
            page.evaluate(async () => {
              const b = window.__bench!;
              for (let i = 0; i < 20; i += 1) {
                b.zoom?.(i % 2 === 0 ? 0.9 : 1 / 0.9);
                await new Promise((r) => setTimeout(r, 16));
              }
            }),
          ]).then(([stats]) => stats),
          INTERACTION_DEADLINE_MS,
        );
        if (zoomFrames) row.zoomFps = Math.round(zoomFrames.fps * 10) / 10;
      });
    }
  }

  // Live-append — the gating invariant, measured. Two tiers: the references'
  // fast ~100pts/20ms, and a slower 100ms tier. Window sizes are dashboard-real
  // (≤1,500 pts/series in-window). We sustain the feed for a CI-reasonable
  // window (a few seconds of frames), sample heap throughout, and record the
  // FPS + heap-slope so the writeup can assert "no decay, no growth trend".
  const liveCases = [
    { scenario: 'line', windowSize: 1_500, pushMs: 20, batch: 100 },
    { scenario: 'line', windowSize: 1_500, pushMs: 100, batch: 100 },
    { scenario: 'three', windowSize: 1_500, pushMs: 20, batch: 100 },
  ] as const;

  for (const c of liveCases) {
    test(`live ${c.scenario} ${c.batch}pts/${c.pushMs}ms (win ${c.windowSize})`, async ({
      page,
    }) => {
      await page.goto(
        storyWithArgs('perf-bench--live', {
          scenario: c.scenario,
          windowSize: c.windowSize,
          pushMs: c.pushMs,
          batch: c.batch,
        }),
      );
      const dataCanvas = page.locator('canvas').first();
      await waitForCanvasPaint(dataCanvas);

      // Let the feed warm up (discard the first stretch), then sample heap over
      // a sequence of frame windows so we can fit a growth trend.
      await page.waitForTimeout(1_000);
      const heapSamples: (number | null)[] = [];
      const fpsSamples: number[] = [];
      const gapSamples: number[] = [];
      const SAMPLES = 6; // ~6s of sustained append
      for (let i = 0; i < SAMPLES; i += 1) {
        heapSamples.push(await readHeap(page));
        const stats = await measureFrames(page, FRAME_WINDOW_MS);
        fpsSamples.push(stats.fps);
        gapSamples.push(stats.maxFrameGapMs);
      }
      heapSamples.push(await readHeap(page));

      // Linear least-squares slope of heap vs index (bytes/sample), if heap is
      // available. A flat / negative slope = no growth trend (GC keeps up).
      let slope: number | null = null;
      const present = heapSamples.filter((h): h is number => h !== null);
      if (present.length === heapSamples.length && present.length >= 2) {
        const n = present.length;
        const xs = present.map((_, i) => i);
        const xMean = xs.reduce((a, b) => a + b, 0) / n;
        const yMean = present.reduce((a, b) => a + b, 0) / n;
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i += 1) {
          num += (xs[i]! - xMean) * (present[i]! - yMean);
          den += (xs[i]! - xMean) ** 2;
        }
        slope = den === 0 ? 0 : num / den;
      }

      liveResults.push({
        scenario: c.scenario,
        windowSize: c.windowSize,
        pushMs: c.pushMs,
        batch: c.batch,
        fps: Math.round(median(fpsSamples) * 10) / 10,
        maxFrameGapMs: Math.round(Math.max(...gapSamples) * 10) / 10,
        heapSamples,
        heapSlopeBytesPerSample: slope === null ? null : Math.round(slope),
      });
    });
  }

  // Write the results JSON after all bench tests run. The bench runs
  // `--workers=1` (one process, sequential), so the module-level arrays
  // accumulate every row before this fires. Records the machine so the numbers
  // are interpretable.
  test.afterAll(async () => {
    const machine = {
      // Captured from the Node side; the browser is Chromium (Playwright pins it).
      platform: process.platform,
      arch: process.arch,
      cpus: (await import('node:os')).cpus().length,
      node: process.version,
      recordedAt: new Date().toISOString(),
      note:
        'Directional, machine-recorded — numbers are relative, never absolute. ' +
        'The durable signal is the shape of the curve (where draw-everything ' +
        'tops out, on which metric). Heap via Chrome performance.memory ' +
        '(--enable-precise-memory-info set in playwright.config); directional.',
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'baseline.json'),
      JSON.stringify(
        { machine, static: staticResults, live: liveResults },
        null,
        2,
      ) + '\n',
    );
  });
});
