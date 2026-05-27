// Perf bench for Float64Column.bin — the chart's per-pixel
// downsampler. Driven by friction from the chart-experiment M2
// milestone (multi-column overlay) showing that per-bin slice +
// reducer-dispatch costs dominate the per-frame work even after
// the { out } buffer option closed the per-frame allocation churn.
//
// Workloads:
//   - "chart-typical": N=1M column, W=1024 bins, 'minMax' — the
//     M2 hot path on a 1M-row time series rendered at 1024px.
//   - "chart-large":   N=10M column, W=1024 bins, 'minMax' — the
//     stress case where M2 is currently above 60fps budget.
//   - "scalar-min":    N=1M column, W=1024 bins, 'min' — the
//     scalar reducer baseline to compare against minMax.
//   - "fine-bins":     N=100k column, W=1024 bins, 'minMax' —
//     bins ≈ N case where per-bin overhead is most visible
//     (very small inner loops).
//
// Each workload is benched on packed columns; chunked variants
// delegate through materialize+packed.bin so the packed numbers
// drive everything.

import { performance } from 'node:perf_hooks';
import { Float64Column } from '../dist/columnar/column.js';
// Side-effect import — installs bin / minMax / etc.
import '../dist/column-api.js';

function makeColumn(length) {
  const buf = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    buf[i] = 50 + 35 * Math.sin(i / 5_000) + 10 * Math.sin(i / 137);
  }
  return new Float64Column(buf, length);
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

// chart-typical: N=1M, W=1024, minMax
{
  const col = makeColumn(1_000_000);
  const out = { lo: new Float64Array(W), hi: new Float64Array(W) };
  results.push(
    benchmark('chart-typical / N=1M W=1024 minMax', () => {
      col.bin(W, 'minMax', { out });
    }),
  );
  // Lower bound: a single .minMax() walks the same buffer once
  // (1M values, same work). The gap between single-walk and bin's
  // 1024-walk is the per-bin overhead (sliceByRange + dispatch).
  results.push(
    benchmark('chart-typical / N=1M minMax (single walk)', () => {
      col.minMax();
    }),
  );
}

// chart-large: N=10M, W=1024, minMax
{
  const col = makeColumn(10_000_000);
  const out = { lo: new Float64Array(W), hi: new Float64Array(W) };
  results.push(
    benchmark('chart-large / N=10M W=1024 minMax', () => {
      col.bin(W, 'minMax', { out });
    }),
  );
}

// scalar-min: N=1M, W=1024, min
{
  const col = makeColumn(1_000_000);
  const out = new Float64Array(W);
  results.push(
    benchmark('scalar-min / N=1M W=1024 min', () => {
      col.bin(W, 'min', { out });
    }),
  );
}

// fine-bins: N=100k, W=1024, minMax — bins ≈ N case
{
  const col = makeColumn(100_000);
  const out = { lo: new Float64Array(W), hi: new Float64Array(W) };
  results.push(
    benchmark('fine-bins / N=100k W=1024 minMax', () => {
      col.bin(W, 'minMax', { out });
    }),
  );
}

// chart-typical 3 columns — simulates M2's 3-line chart
{
  const cols = [
    makeColumn(1_000_000),
    makeColumn(1_000_000),
    makeColumn(1_000_000),
  ];
  const outs = [
    { lo: new Float64Array(W), hi: new Float64Array(W) },
    { lo: new Float64Array(W), hi: new Float64Array(W) },
    { lo: new Float64Array(W), hi: new Float64Array(W) },
  ];
  results.push(
    benchmark('chart-3col / N=1M×3 W=1024 minMax', () => {
      cols[0].bin(W, 'minMax', { out: outs[0] });
      cols[1].bin(W, 'minMax', { out: outs[1] });
      cols[2].bin(W, 'minMax', { out: outs[2] });
    }),
  );
}

console.log(JSON.stringify(results, null, 2));
console.log('\nSummary:');
for (const r of results) {
  console.log(
    `  ${r.label.padEnd(48)} ${r.medianMs.toFixed(3).padStart(8)} ms (min ${r.minMs.toFixed(3)}, max ${r.maxMs.toFixed(3)})`,
  );
}
