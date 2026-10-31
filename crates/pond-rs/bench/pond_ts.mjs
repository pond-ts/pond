// pond-ts side of the R1a baseline: Arrow IPC in → compute → Arrow IPC out.
//
//   node pond_ts.mjs <workload A|B> <data.arrow> [runs] [dump.arrow]
//
// Prints one JSON line: median read / compute / write ms over `runs` timed
// runs (after one warm-up), and memory for one run: on Linux, the peak
// resident size during the warm-up minus the size just before it (the peak
// is reset first, so the Node runtime and imports are not counted); null
// elsewhere. With a 4th argument the
// workload's outputs are written there for compare.py.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  tableFromIPC,
  tableToIPC,
  makeData,
  makeVector,
  Float64,
  Table,
} from 'apache-arrow';
import { TimeSeries, Sequence } from '../../../packages/core/dist/index.js';

const [workload, path, runsArg, dumpPath] = process.argv.slice(2);
const RUNS = Number(runsArg ?? 7);
const COLS = ['c0', 'c1', 'c2', 'c3'];

const aggMapping = Object.fromEntries(
  COLS.flatMap((c) =>
    ['avg', 'min', 'max', 'count'].map((r) => [
      `${c}_${r}`,
      { from: c, using: r },
    ]),
  ),
);
const rollMapping = Object.fromEntries(
  COLS.flatMap((c) =>
    ['avg', 'stdev'].map((r) => [`${c}_${r}`, { from: c, using: r }]),
  ),
);

function compute(series) {
  if (workload === 'A') {
    return {
      agg: series.aggregate(Sequence.every('1m'), aggMapping),
      roll: series.rolling('5m', rollMapping),
    };
  }
  if (workload === 'B') {
    return {
      agg: series.aggregate(
        Sequence.calendar('day', { timeZone: 'America/New_York' }),
        aggMapping,
      ),
    };
  }
  throw new Error(`unknown workload ${workload}`);
}

/** pond's toArrow buffers → an apache-arrow Table → IPC bytes. */
function toIPC(series) {
  const { fields } = series.toArrow();
  const columns = {};
  for (const f of fields) {
    if (f.type !== 'float64' && f.type !== 'timestamp') {
      throw new Error(`unexpected field type ${f.type} for ${f.name}`);
    }
    columns[f.name] = makeVector(
      makeData({
        type: new Float64(),
        length: f.length,
        nullCount: f.nullCount,
        nullBitmap: f.nullBitmap,
        data: f.values,
      }),
    );
  }
  return tableToIPC(new Table(columns), 'file');
}

function once() {
  const bytes = readFileSync(path);
  const t0 = performance.now();
  const series = TimeSeries.fromArrow(tableFromIPC(bytes), { name: 'data' });
  const t1 = performance.now();
  const out = compute(series);
  const t2 = performance.now();
  const ipc = Object.fromEntries(
    Object.entries(out).map(([k, s]) => [k, toIPC(s)]),
  );
  const t3 = performance.now();
  return { read: t1 - t0, compute: t2 - t1, write: t3 - t2, out, ipc };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Linux only: reset the peak resident size to the current one, read both
// from /proc/self/status. null elsewhere. Same method in all three runners.
const statusMb = (field) => {
  const line = readFileSync('/proc/self/status', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(field));
  return parseFloat(line.slice(field.length)) / 1024;
};
const resetPeakMb = () => {
  try {
    writeFileSync('/proc/self/clear_refs', '5');
    return statusMb('VmRSS:');
  } catch {
    return null;
  }
};
const baseMb = resetPeakMb();
let warm = once();
const runMemMb = baseMb === null ? null : statusMb('VmHWM:') - baseMb;
if (dumpPath) {
  for (const [k, bytes] of Object.entries(warm.ipc)) {
    writeFileSync(`${dumpPath}.${k}.arrow`, bytes);
  }
}
const rows = Object.fromEntries(
  Object.entries(warm.out).map(([k, s]) => [k, s.length]),
);
const outputMb =
  Object.values(warm.ipc).reduce((n, b) => n + b.length, 0) / 2 ** 20;
// Keep only these numbers from the warm-up and free the rest before the
// timed runs, as every runner does, so each starts from the same state.
warm = null;
globalThis.gc?.(); // run.sh passes --expose-gc
const timings = [];
for (let i = 0; i < RUNS; i++) {
  // Keep only the numbers, so earlier runs' outputs can be collected.
  const { read, compute, write } = once();
  timings.push({ read, compute, write });
}
const pick = (key) => median(timings.map((t) => t[key]));
const total = median(timings.map((t) => t.read + t.compute + t.write));
console.log(
  JSON.stringify({
    engine: 'pond-ts',
    threads: 1,
    workload,
    runs: RUNS,
    read_ms: +pick('read').toFixed(1),
    compute_ms: +pick('compute').toFixed(1),
    write_ms: +pick('write').toFixed(1),
    total_ms: +total.toFixed(1),
    run_mem_mb: runMemMb === null ? null : Math.round(runMemMb),
    input_mb: +(readFileSync(path).length / 2 ** 20).toFixed(1),
    output_mb: +outputMb.toFixed(1),
    output_rows: rows,
  }),
);
