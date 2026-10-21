// [PND-ROLLDIFF] Rolling `difference` (largest minus smallest in the window)
// across window sizes. Before the fix the cost grew with window size (the
// window was kept as a sorted array and each row spliced in and out); after,
// it should be flat. Usage: node scripts/perf-rolling-difference.mjs [dist]
import { performance } from 'node:perf_hooks';

const distPath = process.argv[2] ?? '../dist/index.js';
const { TimeSeries } = await import(
  distPath.startsWith('.') ? distPath : `file://${distPath}`
);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
]);

// Deterministic pseudo-random walk, so runs are comparable.
function makeSeries(length, shape = 'walk') {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let v = 100;
  return new TimeSeries({
    name: 'm',
    schema,
    rows: Array.from({ length }, (_, i) => {
      // 'mixed' matches pond-rs's perf_reducers example: runs of 40 equal
      // values scattered across the range, a gap every 17th row.
      if (shape === 'mixed')
        v =
          i % 17 === 5
            ? undefined
            : (((Math.floor(i / 40) * 7919) % 10_007) - 5000) / 100;
      else if (shape === 'walk') v = (v ?? 100) + rand() - 0.5;
      else if (shape === 'rising') v = i;
      else if (shape === 'falling') v = -i;
      return [i * 1_000, v, i % 2 === 0 ? 'a' : 'b'];
    }),
  });
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// argv[3], if given, runs only the cases whose label contains it.
const only = process.argv[3];

function benchmark(label, fn, repeats) {
  if (only && !label.includes(only)) return null;
  // The slow (old) build takes minutes per call on big windows, so those
  // skip the warm-up; a call that long is not dominated by start-up.
  if (repeats > 1) fn();
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  const result = { label, medianMs: Number(median(samples).toFixed(1)) };
  console.log(JSON.stringify(result)); // as it goes: a slow run can be cut off
  return result;
}

const N = 1_000_000;
const mixed = makeSeries(N, 'mixed');
const walk = makeSeries(N, 'walk');
const rising = makeSeries(N, 'rising');
const falling = makeSeries(N, 'falling');
const big = (w) => (w >= 3_600_000 ? 1 : 5);

const results = [];
for (const [name, w] of [
  ['1s (1 row per window)', 1_000],
  ['5m', 300_000],
  ['1h', 3_600_000],
  ['1d', 86_400_000],
]) {
  for (const [shape, s] of [
    ['mixed', mixed],
    ['walk', walk],
  ])
    results.push(
      benchmark(
        `${shape}, 1M rows, window ${name}`,
        () => s.rolling(w, { value: 'difference' }),
        big(w),
      ),
    );
}
for (const [name, s] of [
  ['rising', rising],
  ['falling', falling],
]) {
  results.push(
    benchmark(
      `${name}, 1M rows, window 1h`,
      () => s.rolling(3_600_000, { value: 'difference' }),
      1,
    ),
  );
}
// No sparse-source-on-a-dense-grid case: rolling over a `Sequence` scans
// every row for every output point, whatever the reducer ([PND-ROLLGRID]),
// so it would measure that, not `difference`.
results.push(
  benchmark(
    'partitioned by host, 1M rows, window 1h',
    () =>
      mixed
        .partitionBy('host')
        .rolling(3_600_000, { value: 'difference' })
        .collect(),
    1,
  ),
);
