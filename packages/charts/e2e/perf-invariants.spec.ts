import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Perf **invariants** — the CI-gating, pass/fail half of the bench (Codex-9).
 *
 * Unlike `perf.spec.ts` (directional absolute numbers, opt-in), these are
 * robust binary checks chosen so runner noise can't flip them: they assert the
 * renderer doesn't *catastrophically* misbehave, with generous slack, not that
 * it hits a target FPS. The two invariants the RFC names for Phase 1:
 *
 *  1. **No heap-growth trend** under sustained live-append over a fixed-size
 *     ring (the gating invariant — a leak shows as unbounded growth; eviction
 *     must make heap plateau).
 *  2. **Bounded draw time** at a fixed fixture size — sustained pan must keep
 *     the main thread responsive (no multi-hundred-ms stall, FPS above a low
 *     floor far under the 60 target).
 *
 * Absolute FPS / timing stays in the directional results writeup, never here.
 * Sparse-marker preservation (a decimation invariant) is N/A in Phase 1 — there
 * is no decimator yet — and is called out as a seam for Phase 2.
 */

/** Read the JS heap (bytes), or null if Chromium doesn't expose it here. */
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

/** Count frames over `ms` via a rAF loop; return fps + worst inter-frame gap. */
async function measureFrames(
  page: import('@playwright/test').Page,
  ms: number,
): Promise<{ fps: number; maxFrameGapMs: number }> {
  return page.evaluate(async (windowMs) => {
    return new Promise<{ fps: number; maxFrameGapMs: number }>((resolve) => {
      let frames = 0;
      let maxGap = 0;
      let last = performance.now();
      const start = last;
      function tick(now: number) {
        const gap = now - last;
        if (gap > maxGap) maxGap = gap;
        last = now;
        frames += 1;
        if (now - start >= windowMs) {
          resolve({
            fps: (frames / (now - start)) * 1000,
            maxFrameGapMs: maxGap,
          });
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }, ms);
}

test.describe('perf invariants (CI-gating)', () => {
  test.setTimeout(60_000);

  // INVARIANT 1 — no heap-growth trend under sustained live-append. A fixed-size
  // ring (windowSize) must keep the snapshot+draw working set bounded; a leak
  // would grow the heap without limit. We sample heap across many append frames
  // and assert the late heap isn't a large multiple of the early baseline. The
  // factor is deliberately generous (GC is lazy; the snapshot path allocates
  // per flush) — a real leak is unbounded and trips even 3×.
  test('live-append heap does not grow unboundedly', async ({ page }) => {
    await page.goto(
      `${story('perf-bench--live')}&args=scenario:line;windowSize:1500;pushMs:16;batch:100`,
    );
    await waitForCanvasPaint(page.locator('canvas').first());

    const heapAvailable = (await readHeap(page)) !== null;
    test.skip(
      !heapAvailable,
      'performance.memory unavailable in this Chromium build',
    );

    // Warm up (let the ring fill + initial allocations settle), then baseline.
    await page.waitForTimeout(1_500);
    // Nudge GC if exposed (it isn't by default; harmless otherwise).
    await page.evaluate(() => {
      (globalThis as { gc?: () => void }).gc?.();
    });
    const baseline = (await readHeap(page))!;

    // Sustain the append for several seconds while sampling.
    const samples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await page.waitForTimeout(750);
      samples.push((await readHeap(page))!);
    }
    const peak = Math.max(...samples);

    // Unbounded-growth guard: peak heap during sustained append must stay within
    // a generous multiple of the warmed baseline. A leak (no eviction, retained
    // snapshots) blows far past this; a healthy ring plateaus.
    expect(
      peak,
      `peak heap ${(peak / 1e6).toFixed(1)}MB vs baseline ${(baseline / 1e6).toFixed(1)}MB`,
    ).toBeLessThan(baseline * 3);
  });

  // INVARIANT 2 — bounded draw time at a fixed fixture size. With a fixed
  // 10k-point static fixture, sustained pan (each step forces a full redraw)
  // must keep the main thread responsive: FPS above a low floor and no single
  // frame gap in the hundreds of ms. This is the "draw doesn't blow the budget"
  // guard — a quadratic or pathological draw would stall hard and trip it. The
  // thresholds are loose on purpose (the absolute FPS curve lives in the
  // directional spec); this only catches catastrophic regressions.
  test('sustained pan stays responsive at a fixed fixture', async ({
    page,
  }) => {
    await page.goto(
      `${story('perf-bench--static')}&args=scenario:line;size:10000`,
    );
    await waitForCanvasPaint(page.locator('canvas').first());
    await expect
      .poll(() => page.evaluate(() => window.__bench?.pan !== undefined), {
        timeout: 10_000,
      })
      .toBe(true);

    const stats = await Promise.all([
      measureFrames(page, 2_000),
      page.evaluate(async () => {
        const b = window.__bench!;
        for (let i = 0; i < 60; i += 1) {
          b.pan?.(0.005);
          await new Promise((r) => setTimeout(r, 16));
        }
      }),
    ]).then(([s]) => s);

    // No catastrophic stall: worst frame gap well under a "frozen tab" threshold.
    expect(
      stats.maxFrameGapMs,
      `worst frame gap ${stats.maxFrameGapMs.toFixed(0)}ms during sustained pan`,
    ).toBeLessThan(250);
    // Responsiveness floor: far below the 60fps target so noise can't trip it,
    // but a draw that blew the budget (single-digit fps) fails.
    expect(stats.fps, `pan fps ${stats.fps.toFixed(1)}`).toBeGreaterThan(20);
  });
});
