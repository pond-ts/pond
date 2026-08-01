// Perf bench for the single-series bar's stable per-bar identity
// (`BarSeries.marks` — the sample's own axis key, mirrored from the categorical
// stack onto `drawBars`).
//
// What it guards: the marks are `string`s, one per bar, so building them eagerly
// in `barsFromTimeSeries` / `barsFromValueSeries` would put ~10 ms of string
// allocation per 100k bars in front of *every* chart on *every* data update —
// a >10x reader regression to pay for a channel most charts never touch. So the
// readers expose `marks` through a memoized getter, and `drawBars` reads it only
// when the live selection / hover actually carries a `mark`.
//
// Complexity: the reader is O(N) over events either way (it already allocates
// the two Float64Array spans); the marks add O(N) *string* allocations, which
// are ~an order of magnitude more expensive per element than a typed-array
// write. `drawBars` is O(visible) with an O(1) match per bar in both modes —
// the mark match replaces a number compare with a string compare, no allocation.
//
// The three invariants the numbers must show:
//   1. `barsFromTimeSeries` is unchanged when nothing reads `marks`.
//   2. `drawBars` with a key-pinned (or absent) selection never materializes
//      them — its cost matches the no-selection draw.
//   3. Materializing them, when a mark-pinned selection asks, is a bounded
//      one-off (memoized per series object), not a per-frame cost.
//
// Run: node scripts/perf-barmarks.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import { barsFromTimeSeries } from '../dist/data.js';
import { drawBars } from '../dist/bars.js';

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
}

console.log(JSON.stringify({ results }, null, 2));
