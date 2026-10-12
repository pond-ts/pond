// Perf check — [PND-NANREP]: how a missing number is stored.
//
// Number columns used to mark a missing cell with a separate validity
// bitmap (one bit per row) next to the Float64Array. They now store the
// missing cell as NaN inside the Float64Array itself, and the bitmap is
// gone from number columns (string / boolean / array columns keep it —
// they have no NaN to borrow).
//
// What the switch is expected to move, and why:
//   - reducers on a gappy column: the guarded loop already skips
//     non-finite cells, so a NaN gap costs nothing extra; the bitmap
//     path tested a bit per cell on top of that.
//   - operators that write a gappy output (diff, fill, shift, sma's
//     warm-up head): no bitmap to allocate and fill; they write NaN.
//   - fromColumns with a NaN-gapped Float64Array: adopts the buffer
//     instead of deriving a bitmap from it.
//   - count / nullCount / hasMissing: the bitmap cached the count at
//     construction; NaN storage derives it on first ask (one scan) and
//     caches it. Reported so the cost is visible, not hidden.
//
// Complexity is unchanged everywhere (O(N) per column); this is about
// the constant.
//
//   npm run build --workspace=pond-ts
//   node scripts/perf-nan-missing.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const N = Number(process.env.PERF_N ?? 1_000_000);
const MISSING_EVERY = 25; // 4% missing

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(fn, repeats = 15) {
  for (let i = 0; i < 5; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(3));
}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
];

function makeColumns(gappy) {
  const time = new Float64Array(N);
  const v = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    time[i] = 1_000 + i * 1_000;
    v[i] = gappy && i % MISSING_EVERY === 7 ? NaN : Math.sin(i / 100) * 50;
  }
  return { time, v };
}

function build(cols) {
  return TimeSeries.fromColumns({ name: 's', schema, columns: cols });
}

const results = [];
function record(label, ms) {
  results.push({ label, medianMs: ms });
}

for (const gappy of [false, true]) {
  const tag = gappy ? 'gappy 4%' : 'dense';
  const cols = makeColumns(gappy);
  record(
    `fromColumns / ${tag}`,
    bench(() => build(cols)),
  );
  const s = build(cols);
  for (const r of ['sum', 'count', 'avg', 'min', 'stdev', 'p95']) {
    record(
      `reduce ${r} / ${tag}`,
      bench(() => s.reduce('v', r)),
    );
  }
  record(
    `diff / ${tag}`,
    bench(() => s.diff('v')),
  );
  record(
    `cumulative sum / ${tag}`,
    bench(() => s.cumulative({ v: 'sum' })),
  );
  record(
    `fill linear / ${tag}`,
    bench(() => s.fill({ v: 'linear' })),
  );
  record(
    `shift 1 / ${tag}`,
    bench(() => s.shift('v', 1)),
  );
  record(
    `rolling 20 avg / ${tag}`,
    bench(() => s.rolling({ count: 20 }, { v: 'avg' }), 7),
  );
  record(
    `nullCount (fresh column) / ${tag}`,
    bench(() => build(cols).column('v').nullCount()),
  );
  record(
    `toColumns / ${tag}`,
    bench(() => s.toColumns()),
  );
}

console.log(JSON.stringify({ N, results }, null, 2));
