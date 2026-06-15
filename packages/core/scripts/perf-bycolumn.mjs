import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

// Perf check for `byColumn` value-axis aggregation (docs/notes/bycolumn-value-axis.md).
// Complexity: O(N) scatter (one bin-index per row + one bucketState.add per
// mapped column) + O(B) output. Linear in rows × mapped columns; bins B are
// bounded by the data range / width (or the explicit edge count). Covers the
// width (histogram + monotonic splits) and edges regimes plus a wide-bin case.

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number' }, // monotonic axis
  { name: 'watts', kind: 'number' }, // non-monotonic axis
  { name: 'ele', kind: 'number' },
]);

function makeSeries(length) {
  return new TimeSeries({
    name: 'ride',
    schema,
    rows: Array.from({ length }, (_, i) => [
      i * 1_000,
      i * 7, // cumulative distance (monotonic)
      150 + Math.sin(i / 11) * 120, // power, ~[30, 270]
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
  // Power distribution: ~20 even bins over [30, 270], one count reducer.
  benchmark('100k · width 25 histogram (count)', () =>
    s.byColumn(
      'watts',
      { width: 25 },
      { secs: { from: 'watts', using: 'count' } },
    ),
  ),
  // FTP-style zones: 7 explicit edges, count per zone.
  benchmark('100k · edges (7 zones, count)', () =>
    s.byColumn(
      'watts',
      { edges: [0, 100, 150, 200, 250, 300, 400] },
      { secs: { from: 'watts', using: 'count' } },
    ),
  ),
  // Monotonic splits: ~700 contiguous 1 km bins, two reducers.
  benchmark('100k · width 1000 splits (avg+sum, ~700 bins)', () =>
    s.byColumn(
      'dist',
      { width: 1000 },
      {
        speed: { from: 'watts', using: 'avg' },
        gain: { from: 'ele', using: 'sum' },
      },
    ),
  ),
  // stdev per bin (the float-sensitive reducer) over the histogram.
  benchmark('100k · width 25 histogram (stdev)', () =>
    s.byColumn(
      'watts',
      { width: 25 },
      { sd: { from: 'watts', using: 'stdev' } },
    ),
  ),
];

console.log(JSON.stringify(results, null, 2));
