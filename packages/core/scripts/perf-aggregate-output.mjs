// Perf bench for `aggregate()`'s result construction — [PND-IVLCOL].
//
// `scripts/perf-aggregate.mjs` sweeps row count at a fixed 1-minute
// bucket. That misses the axis this change actually moves: the cost being
// removed is **per output bucket**, not per input row, so a row sweep at
// one bucket width holds the interesting variable constant.
//
// Complexity. Both the old and new paths are O(N + B·C) — one merge walk
// over N keys, then a reduce per (bucket, column). They differ in what
// happens to the B·C results:
//
//   before  reduce → box each bucket into a frozen `[Interval, …]` row
//           (B arrays + B freezes) → `new TimeSeries({ rows })` walks all
//           B·C cells again through row intake into columns.
//   after   reduce → write each cell straight into its output buffer.
//           One pass over the result grid, no row objects.
//
// So the win is a constant factor on the B·C term plus B fewer array
// allocations — and it should grow as buckets get narrower (B large
// relative to N) and vanish as they get wide (B → 1, where the reduce
// dominates and there is nothing to save).
//
// Workloads (N = 1M events on a 1 s grid, so bucket width sets B):
//   - 10 s buckets   → B = 100,000 (~10 events/bucket)   narrow
//   - 60 s buckets   → B =  16,667 (~60 events/bucket)   typical metrics
//   - 600 s buckets  → B =   1,667                        wide
//   - 3600 s buckets → B =     278                        hourly rollup
//   - 86400 s buckets→ B =      12                        daily rollup
// each at C = 1 and C = 4 mapped columns.

import { performance } from 'node:perf_hooks';
import { Sequence, TimeRange, TimeSeries } from '../dist/index.js';

const STEP_MS = 1_000;
const N = Number(process.env.PERF_N ?? 1_000_000);

function makeSeries(length, columnCount) {
  const schema = Object.freeze([
    { name: 'time', kind: 'time' },
    ...Array.from({ length: columnCount }, (_, i) => ({
      name: `v${i}`,
      kind: 'number',
      required: false,
    })),
  ]);
  const rows = new Array(length);
  for (let i = 0; i < length; i += 1) {
    const row = new Array(columnCount + 1);
    row[0] = i * STEP_MS;
    for (let k = 0; k < columnCount; k += 1) {
      row[k + 1] = 50 + 35 * Math.sin(i / 5_000 + k) + 10 * Math.sin(i / 137);
    }
    rows[i] = row;
  }
  return new TimeSeries({ name: 'metrics', schema, rows });
}

function mappingFor(columnCount) {
  const mapping = {};
  for (let i = 0; i < columnCount; i += 1) {
    mapping[`v${i}`] = i % 2 === 0 ? 'avg' : 'sum';
  }
  return mapping;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function benchmark(label, fn, repeats = 15) {
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

const BUCKET_WIDTHS_MS = [10_000, 60_000, 600_000, 3_600_000, 86_400_000];
const COLUMN_COUNTS = [1, 4];

const results = [];
for (const columnCount of COLUMN_COUNTS) {
  const series = makeSeries(N, columnCount);
  const range = new TimeRange({ start: 0, end: (N - 1) * STEP_MS });
  const mapping = mappingFor(columnCount);
  for (const bucketMs of BUCKET_WIDTHS_MS) {
    const sequence = Sequence.every(bucketMs);
    const buckets = sequence
      .bounded(range, { sample: 'begin' })
      .intervals().length;
    const sample = benchmark(
      `C=${columnCount} bucket=${bucketMs / 1000}s`,
      () => {
        const out = series.aggregate(sequence, mapping, { range });
        if (out.length !== buckets) {
          throw new Error(
            `unexpected bucket count: ${out.length} vs ${buckets}`,
          );
        }
      },
    );
    results.push({
      n: N,
      columnCount,
      bucketSeconds: bucketMs / 1000,
      buckets,
      eventsPerBucket: Math.round(N / buckets),
      ...sample,
    });
  }
}

console.log(JSON.stringify(results, null, 2));
