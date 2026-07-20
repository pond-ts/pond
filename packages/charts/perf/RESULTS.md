# `@pond-ts/charts` performance bench — Phase 1 baseline

**The un-optimized, draw-everything renderer, measured.** This is the empirical
foundation for the M4 decimation work (RFC `docs/rfcs/charts.md` →
"Performance"). As of this baseline, **none of the scale machinery exists** — no
decimation, no viewport culling, no Path2D cache. Every point is stroked every
frame the data canvas repaints. The bench finds where that tops out and on which
metric, so the decimator work is ordered by evidence, not guess.

> **Numbers are directional and machine-recorded — never absolute.** They were
> taken on one machine (below), as medians with a warm-up discarded, with the
> tab in the foreground. Treat the **shape** of the curve as the signal (where it
> degrades, how steeply, which metric goes first); treat the absolute
> milliseconds as "this machine, this day." Re-run `npm run perf` to regenerate
> `baseline.json` on yours; the relative ordering is what transfers.

## The two ceilings (read this before the numbers)

This is a **render** bench. It measures the cost of drawing — stroke time, frame
cadence, the renderer's heap. It does **not** measure the **data-side** ceiling:
the cost of rebuilding the snapshot `TimeSeries` on each live flush, partition
fan-out, and the GC churn from per-flush allocation. The dashboard use-case
review (RFC) showed, with real traces, that for a **live-streaming** consumer the
data-side ceiling **hits first** — chart draw stayed at 50–150 μs even at 256
series, while `view.toTimeSeries()` rebuilds and React commits pegged the CPU.

So: **a clean render curve here is not "perf solved."** M4 decimation lifts the
_render_ ceiling measured below; the data-side ceiling is separate work (the
LiveView gather path the dashboard review points to). This document names the
render ceiling only. The live-append scenario below deliberately runs through the
_real_ `useSnapshot` path so its FPS/heap numbers include that data-side cost —
which is why the live numbers, not the static curve, are the gating invariant.

## Machine

|          |                                                                     |
| -------- | ------------------------------------------------------------------- |
| Model    | MacBook Pro, **Apple M4 Pro** (10 performance + 4 efficiency cores) |
| Memory   | 48 GB                                                               |
| OS       | macOS 15.4.1                                                        |
| Browser  | Playwright-pinned Chromium (headless), Playwright 1.61              |
| Node     | v22.22.2                                                            |
| Recorded | 2026-06-20                                                          |

This is a fast, idle developer laptop — the **absolute** numbers are a
best-case ceiling; a CI box or a loaded machine will be slower. The raw run is
`perf/baseline.json`. Heap is read from Chrome's `performance.memory` with
`--enable-precise-memory-info` (exact `usedJSHeapSize`); still directional — GC
timing makes any single sample noisy, so we read trend, not level.

## What's measured

| Metric                     | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Initial render**         | A `mark` stamped in the story's render (before any child draw effect), then mount→first-paint is the mark to the end of the **heavy-draw frame** — the largest rAF gap in a settling window (the stroke runs in a descendant layout effect React commits a few frames after the mark, so a naive single post-mark rAF under-measures by ~1000×; the largest-gap method is robust to commit/frame count). Data generation is in `useMemo` _before_ the mark, **outside** the timed region. |
| **Pan / zoom FPS**         | A `requestAnimationFrame` frame-count loop over a ~1 s window while a programmatic driver pans (or zooms) the controlled time range each frame. Measures the frame cadence the main thread actually delivers under redraw load. `null` = the redraw was too slow to sample inside the phase deadline (itself a finding).                                                                                                                                                                  |
| **Live-append FPS + heap** | A `LiveSeries` ring fed at a fixed rate through `useSnapshot({ throttle: 0 })` — the real consumer path. FPS via the same rAF loop; heap sampled across a multi-second sustained window, reported as a least-squares **slope** (bytes/sample) so a leak (unbounded growth) is distinguishable from a healthy plateau.                                                                                                                                                                     |

**Sizes:** 1k / 10k / 100k / 500k / 1M points. **Scenarios:** single line, 3
series (3 overlaid lines), band (filled envelope + median line). Deterministic
seeded generators (sine + reproducible jitter), so the data is never a source of
variance. Generators: `src/perf/generators.ts`.

> **Seam for Bar / Scatter.** Those layers are being built in parallel and are
> deliberately **not** a dependency here. Adding them to the bench is a one-line
> change to `STATIC_SCENARIOS` in `e2e/perf.spec.ts` plus a branch in the
> `Perf/Bench:Static` story — the harness, generators, and metric collection are
> already scenario-parameterized.

## Static curve — initial render + interaction FPS

Higher FPS is better; `60 fps` is the smooth-interaction target, `120 fps` is
this display's cap (the renderer is keeping up with the monitor). "too slow to
sample" = the redraw was so slow the frame loop couldn't complete a sample
inside the 30 s phase deadline — i.e. pan is effectively frozen.

**single line**

| Points    | Initial render | Pan FPS  | Worst pan frame gap | Zoom FPS |
| --------- | -------------- | -------- | ------------------- | -------- |
| 1,000     | 2,570 ms ⚠️    | 121      | 16 ms               | 121      |
| 10,000    | **41 ms**      | 120      | 17 ms               | 121      |
| 100,000   | 666 ms         | **8**    | 333 ms              | 8        |
| 500,000   | 1,915 ms       | _frozen_ | —                   | 2        |
| 1,000,000 | **6,976 ms**   | _frozen_ | —                   | _frozen_ |

**3 series (3 overlaid lines)**

| Points (×3) | Initial render | Pan FPS  | Worst pan frame gap | Zoom FPS |
| ----------- | -------------- | -------- | ------------------- | -------- |
| 1,000       | 1,094 ms ⚠️    | 121      | 10 ms               | 120      |
| 10,000      | **82 ms**      | 86       | 50 ms               | 101      |
| 100,000     | 1,764 ms       | **2.9**  | 875 ms              | 3        |
| 500,000     | 5,629 ms       | _frozen_ | —                   | _frozen_ |
| 1,000,000   | **16,287 ms**  | _frozen_ | —                   | _frozen_ |

**band (filled envelope + median line)**

| Points    | Initial render | Pan FPS  | Worst pan frame gap | Zoom FPS |
| --------- | -------------- | -------- | ------------------- | -------- |
| 1,000     | 3,649 ms ⚠️    | 121      | 18 ms               | 121      |
| 10,000    | 3,988 ms ⚠️    | 119      | 17 ms               | 120      |
| 100,000   | 1,152 ms       | **4.8**  | 533 ms              | 7        |
| 500,000   | 2,810 ms       | _frozen_ | —                   | _frozen_ |
| 1,000,000 | 3,048 ms       | _frozen_ | —                   | _frozen_ |

> ⚠️ **Small-N initial-render values are a measurement artifact, not signal.**
> Initial render is the largest rAF frame gap in a settling window (the
> heavy-draw frame). At ≤1k points — and for band at ≤10k — there is no
> heavy-draw frame, so the heuristic catches unrelated first-load jank
> (Storybook/React boot on the page's first test) instead. The trustworthy
> small-N reference is **line @ 10k = 41 ms** and **three @ 10k = 82 ms**; the
> values flagged ⚠️ over-report. The heuristic is accurate from 100k up, where
> the draw genuinely is the dominant frame — which is the range that matters.
> (Band's curve is also non-monotonic for the same reason: its real cost shows
> in the FPS columns, where 100k already collapses to 4.8 fps.)

## Live-append — the gating invariant

The dashboard-real shape: ≤1,500 points/series in-window, fed through the real
`useSnapshot` path. The invariant is **no heap-growth trend, no FPS decay** while
sustaining the append.

| Scenario | Window | Rate                     | Median FPS | Worst frame gap | Heap samples over ~6 s (MB)      |
| -------- | ------ | ------------------------ | ---------- | --------------- | -------------------------------- |
| 1 line   | 1,500  | 100 pts / 20 ms (≈5 kHz) | **52**     | 27 ms           | 49 → 77 → 25 → 60 → 62 → 59 → 49 |
| 1 line   | 1,500  | 100 pts / 100 ms (1 kHz) | **108**    | 25 ms           | 13 → 18 → 21 → 17 → 17 → 17 → 17 |
| 3 series | 1,500  | 100 pts / 20 ms (≈5 kHz) | **29**     | 43 ms           | 33 → 46 → 31 → 45 → 63 → 43 → 58 |

**Reading it:** all three sustain an interactive frame rate (29–108 fps) with no
decay over the window, and the heap **oscillates** (GC sawtooth) rather than
climbing monotonically — the ring's eviction keeps the working set bounded. The
least-squares heap slopes (`baseline.json`) are too noisy over 7 samples to
trust as a level (one is −33 KB/sample, one +3.6 MB/sample) — the **oscillating
sample sequence is the real "no leak" evidence**, not the slope. The faster
20 ms tier runs lower FPS and heavier heap churn than the 100 ms tier — that
churn is the **data-side** cost (per-flush snapshot rebuild + GC), which is the
ceiling the next paragraph distinguishes from draw.

## Diagnosis — where draw-everything tops out

**Draw-everything tops out between 10k and 100k points, and the metric that
goes first is interaction FPS — not initial render.** A single line pans at the
full 120 fps display cap through 10k points, then **falls off a cliff to 8 fps
at 100k** (a 333 ms worst frame — a third of a second frozen per pan step) and
is unsamplable ("frozen") by 500k. Initial render degrades more gracefully and
later: it's a trustworthy 41 ms at 10k and only becomes painful in the
multi-second range at 500k–1M (≈7 s for a 1M line). So **the interactive
experience breaks an order of magnitude before the static one does** — by the
time a 1M static line eventually paints (≈7 s, annoying but survivable), pan and
zoom on that same line have been unusable since ~100k. The 3-series and band
scenarios just move the cliff earlier: 3 series collapses to **2.9 fps at
100k** (it strokes ~3× the points) and a 1M 3-series line takes **16 s** to
first paint; band collapses to **4.8 fps at 100k** (the filled `area` is
roughly twice a line's path length).

**Why: per-frame cost scales linearly with rendered point count, and every pan
or zoom step re-strokes every point.** There is no decimation, no viewport
culling, and no Path2D cache, so a pan frame on a 100k line walks and strokes
all 100k points through a fresh d3-shape generator — ~333 ms of main-thread
work, ~20× over the 16 ms budget. That is the un-optimized draw-everything
ceiling the bench set out to find.

**This orders the decimator work, and the ordering matches the RFC's plan:**

1. **Pixel-bucket decimation (M4) + viewport culling first** — they attack the
   metric that fails first (interaction FPS) and the dominant cost (points
   stroked per frame). Culling alone bounds a zoomed-in pan to the visible
   slice; M4 (min/max/first/last per pixel column) bounds the _zoomed-out_ draw
   to ~plot-width points regardless of N. Together they target the exact
   100k-point cliff above and should pull pan FPS at 100k–1M back toward 60.
2. **Path2D caching second** — once decimation has cut the per-frame point
   count, caching the decimated path across redraws is the next lever, but it
   only pays where the path is stable (pan at one zoom); on a live 5–10 Hz
   append it invalidates every frame, so it ranks below decimation. (This
   matches the dashboard review's "decimation first, Path2D second.")

**The live-append gating invariant passes for the un-optimized renderer** — all
three live cases sustain 29–108 fps with a bounded, oscillating heap (no leak,
no FPS decay) at dashboard-real window sizes (≤1,500 pts in-window). That is the
expected result and the reason the dashboard sits _below_ where M4 starts to
matter for the **render** side. But re-read "The two ceilings": this bench does
**not** measure the **data-side** ceiling (snapshot rebuild + GC on each flush),
which the heavier 20 ms-tier heap churn above hints at and which the dashboard's
own traces show hits first for live consumers. M4 lifts the render ceiling the
static curve exposes; it does not address the data-side one. A clean live-append
result here is necessary, not sufficient — "perf solved" needs both ceilings,
and only one is measured here.

## Re-bench — after the decimator wave (Phase 4)

The wave shipped: **viewport culling** (Phase 2) + **M4 decimation** (Phase 3,
auto-on, all gap modes + session breaks). Re-running the same static harness with
decimation on collapses the collapse — the `panFps` cliff at 100k is gone and 1M
stays interactive.

> **Cross-machine caveat.** This re-bench ran on a **different, weaker** machine
> than the Phase-1 baseline above (10-core vs the M4 Pro's 14, Node v22.15). So
> the columns are **not** apples-to-apples in absolute ms — but the **shape**
> change is machine-independent and is the whole point: an 8 fps → 118 fps pan
> at 100k is not explained by a CPU delta. (`baseline.json` now holds this run;
> the Phase-1 tables above are the pre-decimation "before".)

**Pan FPS — before (no decimation, M4 Pro) → after (decimation on, 10-core):**

| Points    | line before → after | three before → after | band before → after |
| --------- | ------------------- | -------------------- | ------------------- |
| 100,000   | **8 → 118**         | **2.9 → 44**         | **4.8 → 120**       |
| 500,000   | frozen → **90**     | frozen → **8**       | frozen → **54**     |
| 1,000,000 | frozen → **91**     | frozen → **24**      | frozen → **88**     |

**Initial render at 1M also drops** (the first heavy-draw frame): line
6,976 ms → **69 ms**, three 16,287 ms → **139 ms**, band 3,048 ms → **30 ms** —
the first frame now decimates instead of stroking every point. (The lone
first-frame `panMaxFrameGap` ~34 ms at line 1M is the initial full-series `binBy`
walk; sustained frames are ≤17 ms.)

**Reading it.** `line` and `band` hold **90–120 fps to 1M** — decimation makes
the draw ceiling effectively flat in the point count (cost is ~plot-width, not
N). `three` (3 overlaid lines) is the floor: 3× the per-frame decimation walk
_and_ 3× the data-side snapshot cost, so 500k dips to 8 fps and 1M to 24 —
interactive but the weakest, and the reminder from "The two ceilings" that the
**data-side** cost (snapshot rebuild + React commit) is the next lever, not the
render one. Path2D caching (Phase 4-deferred) is the follow-up only if a real
consumer needs `three`-at-1M above 24 fps.

## How to re-run

```sh
cd packages/charts
npm run perf          # directional bench → writes perf/baseline.json
```

The bench is **opt-in** (gated behind `PERF_BENCH=1`, which `npm run perf` sets)
so its slow, noisy run never blocks the normal test gate. The **perf invariants**
(`e2e/perf-invariants.spec.ts`) — the robust pass/fail checks (no unbounded heap
growth under live-append; sustained pan stays responsive at a fixed fixture) —
**do** run in the normal `playwright test` gate. Absolute FPS/timing lives only
here, never as a CI assertion (runner noise).
