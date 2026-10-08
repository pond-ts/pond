// Perf check — column-native `join` / `joinMany` ([PND-JOINCOL]).
//
// Driver: Tidal's friction report (2026-10-08). One year of regular-session
// 1-minute bars for two instruments (~97.5k rows each, ~97.4k shared
// timestamps), left-joined. The event-walking `join` took 1.3–1.6 s at 59
// value columns a side; a consumer-side merge-walk + gather took ~0.1 s for
// the same output, cell for cell.
//
// Complexity. N = left rows, M = right rows, R = output rows, CL / CR = value
// columns per side.
//   Old: materialize N + M events (each a per-row data object over CL / CR
//        fields), one `merge` per output row (an object spread over CL + CR
//        fields), then re-columnarize every cell — O((N + M)·(CL + CR)) with
//        per-cell boxing and a per-row allocation.
//   New: one merge-walk over the two key buffers → two Int32 match indices,
//        O(N + M). Then per column either pass through by reference (when that
//        side's index is the identity — always so for the primary of a left
//        join), or one typed gather, O(R). Total O(N + M + R·(gathered cols)),
//        no events, no boxing.
//
// Inputs are rebuilt (untimed) before every sample: the old path caches the
// input series' events on first use, so timing repeated joins over one input
// pair would hide the event-materialization cost a fresh pipeline pays.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc packages/core/scripts/perf-join.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/** Time `run(setup())`, with `setup` excluded from the measurement. */
function bench(setup, run, repeats = 7) {
  for (let i = 0; i < 2; i += 1) run(setup());
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const input = setup();
    globalThis.gc?.();
    const t0 = performance.now();
    run(input);
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(2));
}

// Deterministic PRNG so every run sees the same gaps.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// 252 sessions × 390 minutes, minus a sparse random set of missing bars.
const SESSION_MINUTES = 390;
const SESSIONS = 252;
const DAY = 86_400_000;
const OPEN = 13.5 * 3_600_000;

function sessionTimes(dropRate, seed) {
  const rand = lcg(seed);
  const out = [];
  for (let d = 0; d < SESSIONS; d += 1) {
    for (let m = 0; m < SESSION_MINUTES; m += 1) {
      if (rand() < dropRate) continue;
      out.push(d * DAY + OPEN + m * 60_000);
    }
  }
  return out;
}

function makeSeriesBuilder(name, times, nCols, prefix) {
  const schema = [{ name: 'time', kind: 'time' }];
  for (let c = 0; c < nCols; c += 1) {
    schema.push({ name: `${prefix}${c}`, kind: 'number' });
  }
  const n = times.length;
  const timeCol = Float64Array.from(times);
  const valueCols = [];
  for (let c = 0; c < nCols; c += 1) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i += 1) col[i] = 100 + c + Math.sin(i / 50 + c);
    valueCols.push(col);
  }
  return () => {
    const columns = { time: timeCol.slice() };
    for (let c = 0; c < nCols; c += 1) {
      columns[`${prefix}${c}`] = valueCols[c].slice();
    }
    return TimeSeries.fromColumns({ name, schema, columns });
  };
}

const leftTimes = sessionTimes(0.0071, 1);
const rightTimes = sessionTimes(0.0072, 2);
const leftSet = new Set(leftTimes);
const shared = rightTimes.filter((t) => leftSet.has(t)).length;

const SCENARIOS = [
  { label: '59 value cols each side', leftCols: 59, rightCols: 59 },
  { label: '5 value cols each side (OHLCV)', leftCols: 5, rightCols: 5 },
  { label: '59-col primary, 2-col other', leftCols: 59, rightCols: 2 },
];

const results = [];
for (const s of SCENARIOS) {
  const mkLeft = makeSeriesBuilder('a', leftTimes, s.leftCols, 'a');
  const mkRight = makeSeriesBuilder('b', rightTimes, s.rightCols, 'b');
  const setup = () => [mkLeft(), mkRight()];
  const row = { scenario: s.label };
  for (const type of ['left', 'outer', 'inner']) {
    row[`${type}Ms`] = bench(setup, ([l, r]) => l.join(r, { type }));
  }
  results.push(row);
}

// Per-row floor: two narrow series on the same grid (every key matches) —
// surfaces the fixed per-row cost of the walk, and on the new path the
// both-sides-identity pass-through.
{
  const n = 1_000_000;
  const times = Array.from({ length: n }, (_, i) => i * 1000);
  const mkLeft = makeSeriesBuilder('a', times, 1, 'a');
  const mkRight = makeSeriesBuilder('b', times, 1, 'b');
  const setup = () => [mkLeft(), mkRight()];
  results.push({
    scenario: '1M rows, 1 col each, identical keys',
    outerMs: bench(setup, ([l, r]) => l.join(r)),
  });
}

// Disjoint keys: every row is one-sided, so every gather pads.
{
  const n = 500_000;
  const lt = Array.from({ length: n }, (_, i) => i * 2000);
  const rt = Array.from({ length: n }, (_, i) => i * 2000 + 1000);
  const mkLeft = makeSeriesBuilder('a', lt, 2, 'a');
  const mkRight = makeSeriesBuilder('b', rt, 2, 'b');
  const setup = () => [mkLeft(), mkRight()];
  results.push({
    scenario: '500k + 500k rows, disjoint keys, 2 cols each',
    outerMs: bench(setup, ([l, r]) => l.join(r)),
  });
}

// joinMany: four instruments, OHLCV each, outer — the wide-frame build.
{
  const builders = [1, 2, 3, 4].map((seed, k) =>
    makeSeriesBuilder(`s${k}`, sessionTimes(0.007, seed), 5, `s${k}_`),
  );
  const setup = () => builders.map((b) => b());
  results.push({
    scenario: 'joinMany, 4 × ~97.5k rows × 5 cols, outer',
    outerMs: bench(setup, (series) => TimeSeries.joinMany(series)),
  });
}

console.log(
  JSON.stringify(
    {
      join: {
        leftRows: leftTimes.length,
        rightRows: rightTimes.length,
        sharedKeys: shared,
        results,
      },
    },
    null,
    2,
  ),
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
