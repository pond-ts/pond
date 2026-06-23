// Perf check — scan() (typed-accumulator running fold; the cumulative generalization).
//
// scan is column-native by construction (the same no-events path as
// cumulativeOp): one pass over the source column via col.read(i), a single
// (number|undefined)[] of length N, float64ColumnFromArray to derive validity,
// then withColumnReplaced (replace) or withColumnAppended (append) referencing
// the untouched columns + key axis zero-copy.
//
// Complexity (N rows, C columns): O(N) reads + O(N) validity derive + O(C)
// zero-copy column references = O(N + C). The step closure is invoked once per
// DEFINED cell; a missing cell skips it (carry).
//
// The one per-element cost scan has that cumulative does NOT: the mapAccumL
// contract returns a fresh `[next, output]` tuple per defined cell, where
// cumulative's fold returns a bare number. This script quantifies that tuple
// tax (scalarSum: scan vs cumulative for the identical running sum) and the
// real motivating pipeline (split = scan + byColumn). If the tuple tax is a
// small fraction of the shared build, it's the inherent cost of the
// accumulator/output decoupling and ships as-is.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-scan.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(fn, repeats = 7) {
  for (let i = 0; i < 2; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(3));
}

// Dense track: cumDist monotonic (~3 m/step), ele a noisy climb, host alternating.
function makeRows(n, { sparse = false, hosts = 1 } = {}) {
  const rows = new Array(n);
  let cum = 0;
  for (let i = 0; i < n; i += 1) {
    cum += 2 + (i % 3);
    const ele = 100 + Math.sin(i / 50) * 20 + (i % 7);
    const eleCell = sparse && i % 2 === 1 ? undefined : ele;
    rows[i] = [1000 + i, cum, eleCell, `h${i % hosts}`];
  }
  return rows;
}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cumDist', kind: 'number' },
  { name: 'ele', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
];

// Hysteresis elevation gain — the motivating typed accumulator (carry (ref,
// gain), emit only gain). The per-cell {ref,gain} object is the user step's
// own cost; included because it's the realistic shape, not a pond cost.
const T = 3;
const gainStep = (acc, e) => {
  if (acc.ref === null) return [{ ref: e, gain: 0 }, 0];
  const d = e - acc.ref;
  if (d >= T) return [{ ref: e, gain: acc.gain + d }, acc.gain + d];
  if (d <= -T) return [{ ref: e, gain: acc.gain }, acc.gain];
  return [acc, acc.gain];
};
const gainInit = { ref: null, gain: 0 };

const CELLS = [100_000, 1_000_000];
const out = [];

for (const n of CELLS) {
  const rows = makeRows(n);
  const sparseRows = makeRows(n, { sparse: true });
  const multiRows = makeRows(n, { hosts: 8 });

  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // scalarSum: scan running sum over cumDist (the cumulative-equivalent) — the
  // per-element tuple tax shows up against cumulative on the identical fold.
  const scanSumMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s
      .scan('cumDist', (a, v) => [a + v, a + v], 0, { output: 'run' })
      .column('run')
      .sum();
  });
  const cumulativeSumMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.cumulative({ cumDist: 'sum' }).column('cumDist').sum();
  });

  // typedAccum: hysteresis gain (structured acc, decoupled output) — what
  // cumulative cannot express.
  const typedAccumMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s
      .scan('ele', gainStep, gainInit, { output: 'cumGain' })
      .column('cumGain')
      .last();
  });

  // sparse: 50% missing ele cells — step skipped on the gaps (carry path).
  const sparseMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows: sparseRows });
    return s
      .scan('ele', gainStep, gainInit, { output: 'cumGain' })
      .column('cumGain')
      .last();
  });

  // splitPipeline: the real motivating workload — materialize cumGain with
  // scan, then segment per-1000m with byColumn (pure reducer).
  const splitPipelineMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.scan('ele', gainStep, gainInit, { output: 'cumGain' }).byColumn(
      'cumDist',
      { width: 1000 },
      {
        gain: { from: 'cumGain', using: (vs) => vs[vs.length - 1] - vs[0] },
      },
    ).length;
  });

  // partitioned: per-host scoped scan (8 hosts) → collect.
  const partitionedMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows: multiRows });
    return s
      .partitionBy('host')
      .scan('cumDist', (a, v) => [a + v, a + v], 0, { output: 'run' })
      .collect()
      .column('run')
      .sum();
  });

  out.push({
    rows: n,
    buildMs,
    scanSumMs,
    cumulativeSumMs,
    tupleTaxRatio: Number((scanSumMs / cumulativeSumMs).toFixed(2)),
    typedAccumMs,
    sparseMs,
    splitPipelineMs,
    partitionedMs,
  });
}

console.log(JSON.stringify({ scan: out }, null, 2));
console.log(
  '\nbuild is shared. scanSum ≈ build + one column scan + the [next,output]\n' +
    'tuple per cell; tupleTaxRatio = scanSum / cumulativeSum on the identical\n' +
    'fold (the inherent cost of decoupling the accumulator from the output).\n' +
    'splitPipeline is the real workload: scan materializes the carried state,\n' +
    'byColumn segments it with a pure reducer.',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
