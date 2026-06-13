import { performance } from 'node:perf_hooks';
import { Sequence, TimeSeries } from '../dist/index.js';

// Perf check for the columnar `timeRange()` rewrite (audit v2 §3.3).
//
// The old implementation reduced over `this.events`, materializing every
// Event (the ~495 ns/row + heap tax) on the FIRST call. Because that first
// call is the one `aggregate()` makes when defaulting its `range` to
// `series.timeRange()`, a one-shot `aggregate()` paid full materialization
// before the "zero events materialized" 3B fast path could run — erasing
// the win. The new implementation reads the key column's begin/end axis:
// O(1) for time keys (begins sorted, end === begin), a typed-array scan
// for range/interval keys (no Event materialization either way).
//
// "Cold" is the metric that matters: `.events` is lazy + cached, so only the
// FIRST touch pays. Each sample below uses a FRESH series whose `.events`
// has never been accessed, which is exactly the one-shot-pipeline shape.

const timeSchema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'load', kind: 'number' },
]);

function makeTimeSeries(length) {
  return new TimeSeries({
    name: 'cpu',
    schema: timeSchema,
    rows: Array.from({ length }, (_, index) => [
      index * 1_000,
      index % 100,
      (index % 7) + 1,
    ]),
  });
}

// timeRange-keyed series (kind !== 'time') to exercise the max-end scan
// branch. The rekey produces zero-width ranges, but the scan walks all N
// ends regardless of their values, so this measures the scan cost honestly.
function makeRangeSeries(length) {
  return makeTimeSeries(length).asTimeRange();
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

// Build `repeats` fresh series up front (outside the timed region), then run
// `op` once against each — so every sample observes a cold `.events`.
function coldBenchmark(label, makeFn, op, length, repeats = 7) {
  const fresh = Array.from({ length: repeats }, () => makeFn(length));
  // Warm the code paths on a throwaway series (JIT), not on a sample.
  op(makeFn(Math.min(length, 1_000)));

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const series = fresh[run];
    const start = performance.now();
    const out = op(series);
    const end = performance.now();
    if (out === undefined || out === null) {
      throw new Error(`unexpected empty result for ${label} @ ${length}`);
    }
    samples.push(end - start);
  }
  return {
    scenario: label,
    length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const seq = Sequence.every(60_000);
const results = [];

// 1. Direct timeRange() — time-keyed (the O(1) headline).
for (const n of [100_000, 1_000_000]) {
  results.push(
    coldBenchmark(
      'timeRange() time-keyed',
      makeTimeSeries,
      (s) => s.timeRange(),
      n,
    ),
  );
}

// 2. Direct timeRange() — range-keyed (the typed-array max-end scan branch).
for (const n of [100_000, 1_000_000]) {
  results.push(
    coldBenchmark(
      'timeRange() range-keyed',
      makeRangeSeries,
      (s) => s.timeRange(),
      n,
    ),
  );
}

// 3. Cold aggregate() with NO explicit range — defaults to timeRange().
//    This is the §3.3 cliff: the win is gated on timeRange() being cheap.
for (const n of [100_000, 1_000_000]) {
  results.push(
    coldBenchmark(
      'aggregate() cold (no range)',
      makeTimeSeries,
      (s) => s.aggregate(seq, { value: 'avg', load: 'sum' }),
      n,
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
