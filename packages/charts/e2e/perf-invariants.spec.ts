import { expect, test } from '@playwright/test';
import { story, waitForCanvasPaint } from './support.js';

/**
 * Perf **invariants** — the CI-gating, pass/fail half of the bench (Codex-9).
 *
 * Unlike `perf.spec.ts` (directional absolute numbers, opt-in), these are
 * robust binary checks chosen so runner noise can't flip them: they assert the
 * renderer doesn't *catastrophically* misbehave, with generous slack, not that
 * it hits a target FPS. The two invariants the RFC names for Phase 1, plus a
 * third from the 2026-07 uPlot bench comparison:
 *
 *  1. **No heap-growth trend** under sustained live-append over a fixed-size
 *     ring (the gating invariant — a leak shows as unbounded growth; eviction
 *     must make heap plateau).
 *  2. **Bounded draw time** at a fixed fixture size — sustained pan must keep
 *     the main thread responsive (no multi-hundred-ms stall, FPS above a low
 *     floor far under the 60 target).
 *  3. **Hover never repaints the data canvas** — the cursor is a pure
 *     SVG-overlay concern; a pointer sweep must leave the row canvas untouched.
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

/** Median of a sample list — robust to the GC-sawtooth a single reading lands on. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
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

    // Warm up (let the ring fill + initial allocations settle), then take a
    // *median* baseline. A single reading lands anywhere on the GC sawtooth, so
    // a post-gc trough would inflate the peak/baseline ratio — the bench's own
    // committed samples swing ~3x on sawtooth alone, no leak. The median sits
    // mid-sawtooth, so the ratio reflects real growth, not GC phase.
    await page.waitForTimeout(1_500);
    // Nudge GC if exposed (it isn't by default; harmless otherwise).
    await page.evaluate(() => {
      (globalThis as { gc?: () => void }).gc?.();
    });
    const warmed: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await page.waitForTimeout(300);
      warmed.push((await readHeap(page))!);
    }
    const baseline = median(warmed);

    // Sustain the append for several seconds while sampling.
    const samples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await page.waitForTimeout(750);
      samples.push((await readHeap(page))!);
    }
    const peak = Math.max(...samples);

    // Unbounded-growth guard: peak heap during sustained append must stay within
    // a generous multiple of the median warmed baseline. A leak (no eviction,
    // retained snapshots) blows far past this; healthy GC sawtooth stays well
    // under — median baseline + 4x headroom so runner noise can't flip the gate.
    expect(
      peak,
      `peak heap ${(peak / 1e6).toFixed(1)}MB vs median baseline ${(baseline / 1e6).toFixed(1)}MB`,
    ).toBeLessThan(baseline * 4);
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

  // INVARIANT 3 — hovering never repaints the data canvas. The cursor is an
  // SVG/DOM overlay above the data; a pointer sweep across the plot must leave
  // the row canvas untouched. Regression guard for the frame `timeRange`
  // identity leak: a fresh `[d0, d1]` array per ContainerFrame rebuild (the
  // frame rebuilds on every cursor move — cursorX is a frame field) gave the
  // Layers draw callback a new dep identity per mousemove → the Canvas layout
  // effect re-fired → full replot including per-layer M4 re-decimation on every
  // hover frame (measured 105 repaints per 122 mousemove events; ~10 fps hover
  // with decimation off).
  //
  // Repaint counting: a Canvas draw pass calls `ctx.clearRect` exactly once,
  // it's the only `clearRect` in the render path, and `<Canvas>` is rendered
  // only by `<Layers>` (the row data canvas) — so clearRect calls ≡ data-canvas
  // repaints. An init-script patch counts them; the count must not move during
  // the sweep. Binary and noise-proof: the overlay contract is *zero*, not few.
  test('hover sweep never repaints the data canvas', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __canvasClears: number };
      w.__canvasClears = 0;
      const orig = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (
        ...args: Parameters<typeof orig>
      ) {
        w.__canvasClears += 1;
        return orig.apply(this, args);
      };
    });
    await page.goto(
      `${story('perf-bench--static')}&args=scenario:line;size:10000`,
    );
    const dataCanvas = page.locator('canvas').first();
    await waitForCanvasPaint(dataCanvas);

    // Wait for mount-time draws to finish (the two-pass extent settle, late
    // layout) by polling the clear count until it holds still, then zero it —
    // the invariant covers *hover*, from first plot entry onward.
    let last = -1;
    await expect
      .poll(
        async () => {
          const now = await page.evaluate(
            () =>
              (window as unknown as { __canvasClears: number }).__canvasClears,
          );
          const stable = now === last;
          last = now;
          return stable;
        },
        { intervals: [400], timeout: 15_000 },
      )
      .toBe(true);
    await page.evaluate(() => {
      (window as unknown as { __canvasClears: number }).__canvasClears = 0;
    });

    // Sweep the pointer across the plot at mid-height — right, left, then park
    // at 2/3 width. `steps` interpolates real mousemove events (~150 total).
    const box = await dataCanvas.boundingBox();
    if (box === null) throw new Error('no canvas bounding box');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.move(box.x + box.width - 4, y, { steps: 60 });
    await page.mouse.move(box.x + 4, y, { steps: 60 });
    const parkPlotX = Math.round((box.width * 2) / 3);
    await page.mouse.move(box.x + parkPlotX, y, { steps: 30 });

    // Liveness gate: the sweep must actually have driven the cursor — the
    // line-mode cursor draws a full-row-height vertical overlay `<line>` at the
    // hovered plot pixel (`x1 = x2 = round(cursorX)`, `y1 = 0 → y2 =
    // row.height`; the data canvas sits at the plot's left edge, so page x −
    // canvas left ≡ plot x). Without this, a dead event surface would pass the
    // zero-repaint assertion vacuously. The height floor keeps a short axis
    // tick mark that happens to sit near the parked x from satisfying the gate.
    await expect
      .poll(
        () =>
          page.evaluate((expected) => {
            const lines = document.querySelectorAll('svg line');
            return Array.from(lines).some((l) => {
              const x1 = Number(l.getAttribute('x1'));
              const x2 = Number(l.getAttribute('x2'));
              const y1 = Number(l.getAttribute('y1'));
              const y2 = Number(l.getAttribute('y2'));
              return x1 === x2 && Math.abs(x1 - expected) <= 1 && y2 - y1 >= 50;
            });
          }, parkPlotX),
        { timeout: 5_000 },
      )
      .toBe(true);

    const clears = await page.evaluate(
      () => (window as unknown as { __canvasClears: number }).__canvasClears,
    );
    expect(clears, `data-canvas repaints during hover sweep`).toBe(0);
  });
});
