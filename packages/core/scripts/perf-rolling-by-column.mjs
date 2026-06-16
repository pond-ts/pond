import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

// Perf check for `rollingByColumn` windowed value-axis aggregation
// (docs/notes/rolling-by-column.md).
//
// Complexity: O(N) to compact + monotonic-validate the axis, then a single
// two-pointer sweep where `lo`/`hi` each advance ≤ N total — O(N) pointer
// moves. Per move costs the reducer's add/remove: O(1) for count/sum/avg and
// the min/max monotone deque (amortized); O(w) for percentile (sorted-array
// splice, w = window occupancy). So value/extrema reducers are O(N) regardless
// of window width; the percentile band is O(N · w). Output is always exactly N
// records. Scenarios: moderate window (value reducers), the estela percentile
// band, the per-row floor (window ≈ 1), a wide window with an O(1) reducer (to
// isolate sweep cost), and the monotone-deque reducers.

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number' }, // monotonic axis (spacing 7/row)
  { name: 'watts', kind: 'number' },
  { name: 'ele', kind: 'number' },
]);

function makeSeries(length) {
  return new TimeSeries({
    name: 'ride',
    schema,
    rows: Array.from({ length }, (_, i) => [
      i * 1_000,
      i * 7, // cumulative distance (monotonic)
      150 + Math.sin(i / 11) * 120, // power
      100 + (i % 50),
    ]),
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, fn, repeats = 7) {
  fn(); // warm-up
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

const N = 100_000;
const s = makeSeries(N);

const results = [
  // Moderate window (~100 rows), value reducers — the O(N) path.
  benchmark('100k · radius 350 (count+sum+avg, ~100-row window)', () =>
    s.rollingByColumn(
      'dist',
      { radius: 350 },
      {
        n: { from: 'watts', using: 'count' },
        sum: { from: 'watts', using: 'sum' },
        avg: { from: 'watts', using: 'avg' },
      },
    ),
  ),
  // The estela rollingSpread band: percentiles over a moderate window — O(N·w).
  benchmark('100k · radius 350 band (p5/p25/median/p75/p95)', () =>
    s.rollingByColumn(
      'dist',
      { radius: 350 },
      {
        lo: { from: 'watts', using: 'p5' },
        iqlo: { from: 'watts', using: 'p25' },
        mid: { from: 'watts', using: 'median' },
        iqhi: { from: 'watts', using: 'p75' },
        hi: { from: 'watts', using: 'p95' },
      },
    ),
  ),
  // Per-row floor: window ≈ 1 row (radius < axis spacing) — fixed per-row cost.
  benchmark('100k · radius 3 (count, ~1-row window)', () =>
    s.rollingByColumn(
      'dist',
      { radius: 3 },
      {
        n: { from: 'watts', using: 'count' },
      },
    ),
  ),
  // Wide window (~10k rows) with an O(1) reducer — isolates the sweep cost from
  // the reducer (count stays O(1)/move, so this is still O(N) overall).
  benchmark('100k · radius 35000 (count, ~10k-row window)', () =>
    s.rollingByColumn(
      'dist',
      { radius: 35_000 },
      {
        n: { from: 'watts', using: 'count' },
      },
    ),
  ),
  // Monotone-deque reducers (min/max) over a moderate window — amortized O(1).
  benchmark('100k · radius 350 (min+max monotone deque)', () =>
    s.rollingByColumn(
      'dist',
      { radius: 350 },
      {
        lo: { from: 'watts', using: 'min' },
        hi: { from: 'watts', using: 'max' },
      },
    ),
  ),
];

console.log(JSON.stringify(results, null, 2));
