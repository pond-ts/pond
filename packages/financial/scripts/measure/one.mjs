/**
 * One TypeScript measurement, in its own process so its memory peak is its
 * own: `node one.mjs <market|telemetry> <rows> <runs>`. Prints one JSON
 * line (timings in ms, peak memory, the facts). `run.mjs` drives it.
 */
import { TimeSeries } from 'pond-ts';
import * as proc from '@pond-ts/process';
import { studyOps } from '../../dist/process/index.js';
import { COLUMNS, REQUESTS } from './workloads.mjs';

// With `ask` in place of <runs> and a request file after it, runs that
// request once and prints the wire response without timings, or the error:
// the agent trial's tool (crates/pond-process/bench/agent-trial/).
const [workload, rowsArg, runsArg, requestFile] = process.argv.slice(2);
const rows = Number(rowsArg);
const runs = Number(runsArg ?? 3);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

let registry = proc.createRegistry();
for (const def of [...proc.BASIC_OPS, ...proc.SUMMARY_FOLDS, ...studyOps()])
  registry = registry.define(def);

let t = process.hrtime.bigint();
const cols = COLUMNS[workload](rows);
const generateMs = ms(t);

t = process.hrtime.bigint();
const names = Object.keys(cols).filter((k) => k !== 'time');
const series = TimeSeries.fromColumns({
  name: workload,
  schema: [
    { name: 'time', kind: 'time' },
    ...names.map((name) => ({ name, kind: 'number' })),
  ],
  columns: cols,
});
const loadMs = ms(t);

if (runsArg === 'ask') {
  const { readFileSync } = await import('node:fs');
  const asked = JSON.parse(readFileSync(requestFile, 'utf8'));
  let out;
  try {
    const wire = proc.toWire(proc.createHost({ registry }).add('d', series).run(asked));
    out = { ...wire, nodes: wire.nodes.map(({ ms: _ms, ...rest }) => rest) };
  } catch (e) {
    out = { error: `${e.name}: ${e.message}` };
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const request = REQUESTS[workload];
const cold = [];
let host;
let result;
for (let i = 0; i < runs; i += 1) {
  host = proc.createHost({ registry }).add('d', series);
  t = process.hrtime.bigint();
  result = host.run(request);
  cold.push(ms(t));
}
t = process.hrtime.bigint();
host.run(request);
const warmMs = ms(t);

const wire = proc.toWire(result);
console.log(
  JSON.stringify({
    language: 'typescript',
    workload,
    rows,
    generateMs,
    loadMs,
    coldMs: cold,
    warmMs,
    peakRssMb: process.resourceUsage().maxRSS / 1024,
    retainedMb: host.graphFor('d').retainedBytes / 1048576,
    nodes: wire.nodes.map((n) => [n.id, n.ms]),
    facts: wire.facts,
    skipped: wire.skipped,
  }),
);
