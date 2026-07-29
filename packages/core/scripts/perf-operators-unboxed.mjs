// Perf bench for the unboxed element-wise operator paths — [PND-BOXFREE].
//
// Covers `cumulative`, `diff`, `rate` and `pctChange`, which shared one
// shape: read every cell through the polymorphic `col.read(i)` into a
// boxed `Array<number | undefined>`, then hand that to
// `float64ColumnFromArray`, which walks it twice more (values, then
// validity). They now walk the source's `Float64Array` + validity bits
// directly and write into typed output buffers.
//
// ── Warm-up ──────────────────────────────────────────────────────────
//
// **Warm up by iteration count, not elapsed time.** The other perf
// scripts in this directory run `for (let i = 0; i < 3; i++) fn()` before
// sampling. That is fine for a microsecond kernel and badly wrong here:
// V8's optimising tier is a cliff, and these operations sit either side
// of it. Measured on `Float64Column.sum()` over 1M cells, the median held
// at 3.82 ms through 400 warm-up iterations and dropped to 1.41 ms
// between 400 and 800 — 2.7x, entirely from warm-up.
//
// The failure mode is nastier than a wrong absolute number: whichever
// configuration runs *first* in a process is the one that pays, so a
// before/after comparison can report a speedup that is really just
// ordering. Reversing the loop order reversed which side looked slow.
//
// So: 1000 warm-up iterations, and N kept small enough that a slow
// pre-change build can actually reach them. The ratio is what matters and
// it is stable across N; the absolute numbers here are deliberately not
// 1M-row figures, because a 1M-row pre-change `diff` cannot be warmed
// inside a sane time budget.

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const N = Number(process.env.PERF_N ?? 200_000);
const COLUMNS = Number(process.env.PERF_COLUMNS ?? 4);
const WARMUP_ITERATIONS = Number(process.env.PERF_WARMUP ?? 1000);
const STEP_MS = 1_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSeries(length, columnCount, missingFraction) {
  const rnd = mulberry32(0x5eed);
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
      row[k + 1] =
        rnd() < missingFraction
          ? undefined
          : 50 + 35 * Math.sin(i / 5_000 + k) + 10 * Math.sin(i / 137);
    }
    rows[i] = row;
  }
  return new TimeSeries({ name: 'metrics', schema, rows });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function benchmark(label, fn, repeats = 25) {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) fn();
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
for (const missing of [0, 0.04]) {
  const series = makeSeries(N, COLUMNS, missing);
  const cols = Array.from({ length: COLUMNS }, (_, i) => `v${i}`);
  const sumSpec = Object.fromEntries(cols.map((c) => [c, 'sum']));
  const maxSpec = Object.fromEntries(cols.map((c) => [c, 'max']));
  const label = missing === 0 ? 'dense' : `${missing * 100}% missing`;

  for (const [name, fn] of [
    ['cumulative(sum)', () => series.cumulative(sumSpec).length],
    ['cumulative(max)', () => series.cumulative(maxSpec).length],
    ['diff', () => series.diff(cols).length],
    ['rate', () => series.rate(cols).length],
    ['pctChange', () => series.pctChange(cols).length],
  ]) {
    results.push({
      n: N,
      columns: COLUMNS,
      shape: label,
      warmupIterations: WARMUP_ITERATIONS,
      ...benchmark(`${name} / ${label}`, fn),
    });
  }
}

console.log(JSON.stringify(results, null, 2));
