// Perf bench for the single-series bar's stable per-bar identity
// (`BarSeries.marks` — the sample's own axis key, mirrored from the categorical
// stack onto `drawBars`).
//
// What it guards: the marks are `string`s, one per bar, so building them eagerly
// in `barsFromTimeSeries` / `barsFromValueSeries` would put ~10 ms of string
// allocation per 100k bars in front of *every* chart on *every* data update —
// a >10x reader regression to pay for a channel most charts never touch. So the
// readers expose `marks` through a memoized getter.
//
// Complexity: the reader is O(N) over events either way (it already allocates
// the two Float64Array spans); the marks add O(N) *string* allocations, which
// are ~an order of magnitude more expensive per element than a typed-array
// write. `drawBars` is O(visible) with an O(1) match per bar in both modes —
// the mark match replaces a number compare with a string compare, no allocation.
//
// WHO ACTUALLY PAYS (L2 review, PR #568 — the first cut of this bench measured
// a path `<BarChart>` does not take, and claimed too much for the getter):
//
//   * A **non-interactive** layer (no `id`) registers no `hitTest`, so nothing
//     ever reads `marks` — it genuinely never pays.
//   * An **interactive** layer (`id` set) hit-tests on every *pointer move*
//     (`Layers` → `resolveSelection`), and that echo reads `marks` for the bar
//     under the cursor. So the **first pointer move that lands on a bar**
//     materializes the array — once per data identity, on the input path.
//     From then on the hover carries a `mark`, so `drawBars` takes the mark
//     branch too (already warm — no further cost).
//
// The getter still strictly dominates an eager array — eager pays on *every*
// data update for *every* chart, interactive or not, hovered or not — but
// "never pays" only holds for the non-interactive case. The `hover N=…` case
// below is the honest one: it is what an interactive chart's first hover costs.
//
// The invariants the numbers must show:
//   1. `barsFromTimeSeries` is unchanged when nothing reads `marks`.
//   2. `drawBars` never materializes them on its own — a key-pinned (or absent)
//      selection costs the same as no selection. (This is the *draw* path in
//      isolation; see the hover case for what the component actually does.)
//   3. The first hover on an interactive layer materializes them: a bounded
//      one-off, memoized per series object, not a per-frame or per-move cost.
//
// Run: node scripts/perf-barmarks.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import { barsFromTimeSeries } from '../dist/data.js';
import { barAt, drawBars } from '../dist/bars.js';

const SIZES = [10_000, 100_000];
const BASE = 1.7e12;

const style = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

/** A **point-keyed** series of `n` samples on a uniform 1s grid — the shape
 *  whose bar spans are neighbour-derived, so `begin` is not the sample key
 *  (the case the mark identity exists for). */
function makeSeries(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [BASE + i * 1000, 50 + 35 * Math.sin(i / 5_000)];
  }
  return new TimeSeries({
    name: 's',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    rows,
  });
}

/** A callable value→pixel scale carrying the `.domain()` culling reads. */
function scale(d0, d1, width) {
  const f = (v) => ((v - d0) / (d1 - d0)) * width;
  f.domain = () => [d0, d1];
  f.range = () => [0, width];
  return f;
}

/** A no-op 2D context — the timing is pure JS, not rasterization. */
function stubContext() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get: (_t, p) => (p === 'measureText' ? () => ({ width: 0 }) : noop),
      set: () => true,
    },
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, fn, repeats = 30) {
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(4)),
    minMs: Number(Math.min(...samples).toFixed(4)),
    maxMs: Number(Math.max(...samples).toFixed(4)),
  };
}

const results = [];
const ctx = stubContext();
/** Consumes each hover case's result so the read can't be optimized away. */
let sink = 0;

for (const n of SIZES) {
  const series = makeSeries(n);
  const last = BASE + (n - 1) * 1000;
  const xScale = scale(BASE - 500, last + 500, 1200);
  const yScale = scale(0, 100, 400);
  // Every draw case runs undecimated (`decimate: false`) so it exercises the
  // per-bar highlight loop — the path the match rule lives in.
  const draw = (bs, selection) =>
    drawBars(ctx, bs, xScale, yScale, style, 0, 0, 'v', selection, null, false);

  // (1) The reader itself — nothing reads `marks`, so no strings are built.
  results.push(
    benchmark(`read N=${n} barsFromTimeSeries (marks untouched)`, () =>
      barsFromTimeSeries(series, 'v'),
    ),
  );
  // (3) The same read, forcing the marks — the cost the getter defers.
  results.push(
    benchmark(`read N=${n} + first marks read (materializes)`, () => {
      const bs = barsFromTimeSeries(series, 'v');
      void bs.marks;
    }),
  );

  const bs = barsFromTimeSeries(series, 'v');
  const midKey = BASE + Math.floor(n / 2) * 1000;
  // (2) The two shipped selection shapes must cost the same as no selection.
  results.push(benchmark(`draw N=${n} no selection`, () => draw(bs, null)));
  results.push(
    benchmark(`draw N=${n} key-pinned selection (no mark)`, () =>
      draw(bs, { id: 'v', key: bs.begin[Math.floor(n / 2)] }),
    ),
  );
  // Mark-pinned, marks already warm — the steady-state repaint cost.
  const warm = barsFromTimeSeries(series, 'v');
  void warm.marks;
  results.push(
    benchmark(`draw N=${n} mark-pinned selection (marks warm)`, () =>
      draw(warm, { id: 'v', key: NaN, mark: String(midKey) }),
    ),
  );

  // (3) What an **interactive** layer's first pointer-move-over-a-bar costs —
  // `<BarChart>`'s `hitTest` echoes `bs.marks?.[bi]`, so the hit materializes
  // the array on a cold series. This is the case the first cut of this bench
  // missed. A fresh series per rep, since the point is the *cold* read.
  const hitPx = xScale(midKey);
  // Bars rest on baseline 0 and every value is >= 15, so any y inside
  // [yScale(0), yScale(15)] is inside the bar under `hitPx`. Assert the hit
  // rather than trust it — an off-rect probe would silently measure a full
  // no-hit scan and never read `marks` at all (which is exactly what the first
  // version of this case did).
  const hitPy = yScale(10);
  const probe = barAt(
    barsFromTimeSeries(series, 'v'),
    hitPx,
    hitPy,
    xScale,
    yScale,
    0,
    0,
    1,
  );
  if (probe === null) {
    throw new Error(
      `perf-barmarks: hover probe missed every bar at N=${n} — the case would measure nothing`,
    );
  }
  results.push(
    benchmark(
      `hover N=${n} first hitTest hit on a cold series (materializes)`,
      () => {
        const cold = barsFromTimeSeries(series, 'v');
        const hit = barAt(cold, hitPx, hitPy, xScale, yScale, 0, 0, 1);
        sink += cold.marks[hit[0]].length;
      },
      10,
    ),
  );
  // The same move on a warm series — every subsequent pointer move.
  const hovered = barsFromTimeSeries(series, 'v');
  void hovered.marks;
  results.push(
    benchmark(`hover N=${n} subsequent hitTest hit (marks warm)`, () => {
      const hit = barAt(hovered, hitPx, hitPy, xScale, yScale, 0, 0, 1);
      sink += hovered.marks[hit[0]].length;
    }),
  );
}

console.log(JSON.stringify({ results }, null, 2));
