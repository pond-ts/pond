// Perf bench for Float64Column.bin — the chart's per-pixel
// downsampler. Pinned by the chart-experiment M2 milestone's
// 60fps-at-N=10M-with-three-lines requirement (data layer must
// stay under 16.67ms with room left for canvas draw).
//
// History note: an earlier revision benched a `{ out }` optional
// output buffer (PR #161 upstream); after M2.3's bench showed it
// contributed zero measurable win on top of the chart-side
// Y-from-bin-output reorganization, the option was reverted to
// keep the API small. This bench script reflects that final
// shape — no buffer reuse, fresh allocation per call.
//
// Workloads:
//   - "chart-typical": N=1M column, W=1024 bins, 'minMax' — the
//     M2 hot path on a 1M-row time series rendered at 1024px.
//   - "chart-large":   N=10M column, W=1024 bins, 'minMax' — the
//     stress case the chart needs to keep under 60fps budget.
//   - "scalar-min":    N=1M column, W=1024 bins, 'min' — scalar
//     reducer baseline.
//   - "fine-bins":     N=100k column, W=1024 bins, 'minMax' —
//     bins ≈ N case where per-bin overhead is most visible.
//   - "chart-3col":    N=1M×3 columns — simulates M2's 3-line
//     chart per-frame bin work.

import { performance } from 'node:perf_hooks';
import { Float64Column } from '../dist/columnar/column.js';
import { createValidityBitmap } from '../dist/columnar/index.js';
// Side-effect import — installs bin / minMax / etc.
import '../dist/column.js';

function makeColumn(length) {
  const buf = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    buf[i] = 50 + 35 * Math.sin(i / 5_000) + 10 * Math.sin(i / 137);
  }
  return new Float64Column(buf, length);
}

// Gappy variant — ~30% of cells missing, forcing the validity-aware
// bin path (the M4 decimator's realistic case: time data with holes).
function makeGappyColumn(length) {
  const buf = new Float64Array(length);
  const v = createValidityBitmap(length);
  for (let i = 0; i < length; i += 1) {
    buf[i] = 50 + 35 * Math.sin(i / 5_000) + 10 * Math.sin(i / 137);
    // Deterministic ~30% drop pattern (no Math.random — reproducible).
    if (i % 10 >= 7) continue;
    v.set(i);
  }
  return new Float64Column(buf, length, v.freeze());
}

// A monotonic key axis parallel to a column of the given length —
// the packed-time array a chart would hand to binBy. Uniform 1s grid.
function makeKey(length) {
  const key = new Float64Array(length);
  for (let i = 0; i < length; i += 1) key[i] = i * 1000;
  return key;
}

// W+1 evenly spaced pixel-column edges spanning the key range — the
// device-pixel bucket boundaries binBy buckets against.
function makeEdges(key, W) {
  const lo = key[0];
  const hi = key[key.length - 1];
  const edges = new Float64Array(W + 1);
  for (let b = 0; b <= W; b += 1) edges[b] = lo + ((hi - lo) * b) / W;
  return edges;
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
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const results = [];
const W = 1024;

{
  const col = makeColumn(1_000_000);
  results.push(
    benchmark('chart-typical / N=1M W=1024 minMax', () => {
      col.bin(W, 'minMax');
    }),
  );
  // The M4 reducer: minMax + per-bin first/last. Same single buffer
  // walk as minMax, two extra channel writes (first once per bin,
  // last on every counted cell). This row measures the incremental
  // cost of the first/last channels over plain minMax — the delta
  // is the price of continuity-preserving decimation.
  results.push(
    benchmark('chart-typical / N=1M W=1024 minMaxFirstLast', () => {
      col.bin(W, 'minMaxFirstLast');
    }),
  );
  // Lower bound: a single .minMax() walks the same buffer once
  // (1M values, same work). The gap to bin's 1024-walk is the
  // per-bin overhead (loop bookkeeping + accumulator reset).
  results.push(
    benchmark('chart-typical / N=1M minMax (single walk)', () => {
      col.minMax();
    }),
  );
}

{
  const col = makeColumn(10_000_000);
  results.push(
    benchmark('chart-large / N=10M W=1024 minMax', () => {
      col.bin(W, 'minMax');
    }),
  );
}

{
  const col = makeColumn(1_000_000);
  results.push(
    benchmark('scalar-min / N=1M W=1024 min', () => {
      col.bin(W, 'min');
    }),
  );
}

{
  const col = makeColumn(100_000);
  results.push(
    benchmark('fine-bins / N=100k W=1024 minMax', () => {
      col.bin(W, 'minMax');
    }),
  );
  results.push(
    benchmark('fine-bins / N=100k W=1024 minMaxFirstLast', () => {
      col.bin(W, 'minMaxFirstLast');
    }),
  );
}

{
  // Validity path — the M4 decimator over gappy (~30% missing) time
  // data at the 10k–100k band the pan-FPS bench flagged (#256).
  const col = makeGappyColumn(100_000);
  results.push(
    benchmark('gappy-30pct / N=100k W=1024 minMax', () => {
      col.bin(W, 'minMax');
    }),
  );
  results.push(
    benchmark('gappy-30pct / N=100k W=1024 minMaxFirstLast', () => {
      col.bin(W, 'minMaxFirstLast');
    }),
  );
}

{
  const cols = [
    makeColumn(1_000_000),
    makeColumn(1_000_000),
    makeColumn(1_000_000),
  ];
  results.push(
    benchmark('chart-3col / N=1M×3 W=1024 minMax', () => {
      cols[0].bin(W, 'minMax');
      cols[1].bin(W, 'minMax');
      cols[2].bin(W, 'minMax');
    }),
  );
}

// ─── binBy (key-domain / M4) vs bin (index-domain) ───────────────
//
// binBy adds an O(n + W) merge walk to derive per-bucket boundaries,
// then runs the same shared reduction engine as bin. These rows
// measure that the merge walk is cheap relative to the reduction —
// binBy should track bin closely — and double as the refactor guard
// (bin routed through the shared engine must not regress vs the
// pre-refactor numbers in PR #362's commit message).
{
  const col = makeColumn(1_000_000);
  const key = makeKey(1_000_000);
  const edges = makeEdges(key, W);
  results.push(
    benchmark('binBy / N=1M W=1024 minMax', () => {
      col.binBy(key, edges, 'minMax');
    }),
  );
  results.push(
    benchmark('binBy / N=1M W=1024 minMaxFirstLast', () => {
      col.binBy(key, edges, 'minMaxFirstLast');
    }),
  );
  // Same size through index-domain bin — the merge-walk overhead is
  // the gap between this row and the two above.
  results.push(
    benchmark(
      'bin / N=1M W=1024 minMaxFirstLast (index, refactor guard)',
      () => {
        col.bin(W, 'minMaxFirstLast');
      },
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
console.log('\nSummary:');
for (const r of results) {
  console.log(
    `  ${r.label.padEnd(48)} ${r.medianMs.toFixed(3).padStart(8)} ms (min ${r.minMs.toFixed(3)}, max ${r.maxMs.toFixed(3)})`,
  );
}
