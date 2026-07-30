// Perf check for `partitionBy` — [PND-SPLITCOST].
//
// Complexity: O(N) to assign every row a group, plus O(N) total to gather
// the groups. The agent benchmark found this was 43% of a cross-sectional
// question and entirely serial, which capped partition-level parallelism
// at 2x — so it is worth more as ordinary optimisation than as threads.
//
// Two changes are measured here:
//
//   1. A DICT-ENCODED FAST PATH. Partitioning a panel by symbol used to
//      build a key string per row and hash it into a Map. A
//      dictionary-backed string column already stores an integer per
//      row, so the grouping indexes an array instead — no string
//      materialised, nothing hashed. Symbols are exactly what dict
//      encoding is for.
//   2. TWO-PASS FILL. The old path pushed into a `number[]` per group
//      and converted each to a typed array at the end: one boxed push
//      per row plus a full copy per group. Counting first and filling an
//      exactly sized Int32Array removes both.
//
// The panel shape (N symbols x M bars) is the one the agent benchmark
// showed matters; `interleaved` is the same data in the other plausible
// layout (time-ordered, symbols mixed) and exists so the fast path is not
// only measured where it flatters.

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
function bench(fn, reps = 9) {
  for (let i = 0; i < 3; i += 1) fn();
  const t = [];
  for (let i = 0; i < reps; i += 1) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

function panel(symbols, bars, interleaved) {
  const n = symbols * bars;
  const time = new Float64Array(n);
  const close = new Float64Array(n);
  const symbol = new Array(n);
  let w = 0;
  if (interleaved) {
    // Time-ordered: t0:A, t0:B, … t1:A, … Keys tie, which is legal, and
    // every partition's rows are then n-strided rather than contiguous.
    for (let b = 0; b < bars; b += 1) {
      for (let s = 0; s < symbols; s += 1) {
        time[w] = b * 60_000;
        close[w] = (w % 97) + 1;
        symbol[w] = `S${s}`;
        w += 1;
      }
    }
  } else {
    for (let s = 0; s < symbols; s += 1) {
      for (let b = 0; b < bars; b += 1) {
        time[w] = w * 60_000;
        close[w] = (w % 97) + 1;
        symbol[w] = `S${s}`;
        w += 1;
      }
    }
  }
  return TimeSeries.fromColumns({
    name: 'panel',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
      { name: 'symbol', kind: 'string' },
    ],
    columns: { time, close, symbol },
  });
}

const results = [];
for (const [label, symbols, bars, interleaved] of [
  ['panel 500 x 1000, contiguous', 500, 1000, false],
  ['panel 500 x 1000, interleaved', 500, 1000, true],
  ['panel 1000 x 1000, contiguous', 1000, 1000, false],
  ['wide groups: 10 x 50000', 10, 50_000, false],
]) {
  const p = panel(symbols, bars, interleaved);
  results.push({
    scenario: label,
    rows: symbols * bars,
    groups: symbols,
    partitionToMapMs: Number(
      bench(() => p.partitionBy('symbol').toMap((g) => g)).toFixed(3),
    ),
    distinctKeysMs: Number(
      bench(() => p._distinctPartitionKeys(['symbol'])).toFixed(3),
    ),
  });
}
console.log(JSON.stringify(results, null, 2));
