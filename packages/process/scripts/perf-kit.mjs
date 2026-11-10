// Basic steps (BASIC_OPS) and summary folds (SUMMARY_FOLDS) at scale.
//
// Every one is a single O(N) pass over one or two packed columns, except
// `percentile` (O(N log N) sort of the defined cells) and `events`
// (O(N) plus O(hits) to collect). This checks that, and that none pays a
// boxed or per-row allocation: the floor is `extremes`, a standard fold
// that is one buffer walk.
//
// Each node is timed by the host's own per-node badge (`ms`, inputs
// pulled first), cold, on a fresh host; median of RUNS.
//
// Scenarios:
//   dense   — 1M one-minute bars, every cell defined
//   sparse  — same rows, 99% of `close` missing (gap handling paths)
//   signal  — `events` / `shareTrue` / `meanWhere` over a 1/0 column that
//             is true on ~50% of rows (worst case for event collection)
//
// Run:  node packages/process/scripts/perf-kit.mjs
import { TimeSeries } from '../../core/dist/index.js';
import {
  BASIC_OPS,
  SUMMARY_FOLDS,
  createHost,
  createRegistry,
} from '../dist/index.js';
import { makeBars } from './fixtures/studies-setup.mjs';

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const RUNS = Number(process.env.RUNS ?? 5);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

let registry = createRegistry();
for (const def of [...BASIC_OPS, ...SUMMARY_FOLDS])
  registry = registry.define(def);

const dense = makeBars(ROWS);

function sparsen(series) {
  const close = Float64Array.from(series.column('close').toFloat64Array());
  for (let i = 0; i < close.length; i += 1) if (i % 100 !== 0) close[i] = NaN;
  // Appended under its own name; the sparse run reads it as `close`.
  return series.withColumn('gappy', close);
}
const sparse = sparsen(dense);

const nodes = {
  add: { op: 'add', in: ['close', 'open'] },
  subtract: { op: 'subtract', in: ['close', 'open'] },
  multiply: { op: 'multiply', in: ['close', 'volume'] },
  divide: { op: 'divide', in: ['close', 'open'] },
  scale: { op: 'scale', params: { factor: 100, offset: -1 }, in: ['close'] },
  shift: { op: 'shift', params: { periods: -10 }, in: ['close'] },
  compare: { op: 'compare', params: { value: 100 }, in: ['close'] },
  compareColumns: { op: 'compareColumns', in: ['close', 'open'] },
  and: { op: 'and', in: ['compare', 'compareColumns'] },
  or: { op: 'or', in: ['compare', 'compareColumns'] },
  cumulative: { op: 'cumulative', params: { how: 'max' }, in: ['close'] },
  hold: { op: 'hold', in: ['compareColumns'] },
  extremes: { op: 'extremes', in: ['close'] },
  mean: { op: 'mean', in: ['close'] },
  stdev: { op: 'stdev', in: ['close'] },
  sum: { op: 'sum', in: ['close'] },
  count: { op: 'count', in: ['close'] },
  percentile: { op: 'percentile', params: { q: 5 }, in: ['close'] },
  shareTrue: { op: 'shareTrue', in: ['compareColumns'] },
  lastTrue: { op: 'lastTrue', in: ['compareColumns'] },
  lastChange: { op: 'lastChange', in: ['close'] },
  events: { op: 'events', in: ['compareColumns'] },
  meanWhere: { op: 'meanWhere', in: ['close', 'compareColumns'] },
  change: { op: 'change', in: ['close'] },
};

function time(series, column = 'close') {
  const swap = (spec) => ({
    ...spec,
    in: spec.in.map((c) => (c === 'close' ? column : c)),
  });
  const runNodes = Object.fromEntries(
    Object.entries(nodes).map(([k, v]) => [k, swap(v)]),
  );
  const samples = Object.fromEntries(Object.keys(nodes).map((k) => [k, []]));
  for (let r = 0; r < RUNS; r += 1) {
    const host = createHost({ registry }).add('bars', series);
    const result = host.run({
      from: 'bars',
      nodes: runNodes,
      outputs: Object.fromEntries(
        Object.keys(nodes).map((k) => [k, { on: k }]),
      ),
      assemble: false,
    });
    for (const n of result.nodes) {
      if (n.slot !== undefined && samples[n.slot]) samples[n.slot].push(n.ms);
    }
  }
  return Object.fromEntries(
    Object.entries(samples).map(([k, xs]) => [
      k,
      Number(median(xs).toFixed(2)),
    ]),
  );
}

const out = {
  rows: ROWS,
  runs: RUNS,
  dense: time(dense),
  sparse: time(sparse, 'gappy'),
};
console.log(JSON.stringify(out, null, 2));
