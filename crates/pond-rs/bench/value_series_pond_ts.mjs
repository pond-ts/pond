// pond-ts side of examples/perf_value_series.rs: same data, same calls,
// same checksum.
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/value_series_pond_ts.mjs [name prefix]
import { TimeSeries, ValueSeries } from '../../../packages/core/dist/index.js';
import {
  Float64,
  Table,
  Utf8,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';

const rows = 1_000_000;
const zones = ['easy', 'steady', 'tempo', 'hard', 'max'];
const s = new TimeSeries({
  name: 'bench',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'dist', kind: 'number' },
    { name: 'watts', kind: 'number', required: false },
    { name: 'zone', kind: 'string' },
  ],
  rows: Array.from({ length: rows }, (_, i) => [
    i * 1000,
    Math.floor(i / 3) / 100,
    i % 17 !== 5 ? ((i * 7919) % 10_007) / 8 : undefined,
    zones[Math.floor(i / 50) % 5],
  ]),
});
const checksum = (v) => {
  let axis = 0;
  for (const x of v.axisValues()) axis += x;
  let watts = 0;
  const w = v.column('watts');
  for (let i = 0; i < v.length; i += 1) {
    const x = w.read(i);
    if (x !== undefined) watts += x;
  }
  return v.length + axis + watts;
};
const v = s.byValue('dist');
const small = v.sliceByValue(0, 1000);
const rowsJson = JSON.stringify(small.toJSON());
const columnsJson = JSON.stringify(small.toColumns());
// The same 1M-row value series as an Arrow table (pond-rs: `to_arrow`).
const table = new Table({
  dist: vectorFromArray(v.axisValues(), new Float64()),
  watts: vectorFromArray(
    Array.from(
      { length: v.length },
      (_, i) => v.column('watts').read(i) ?? null,
    ),
    new Float64(),
  ),
  zone: vectorFromArray(
    Array.from({ length: v.length }, (_, i) => v.column('zone').read(i)),
    new Utf8(),
  ),
});
const ipc = tableToIPC(table, 'file');
const probes = Array.from(
  { length: 1_000_000 },
  (_, i) => ((i * 7919) % 333_400) / 100,
);

const cases = [
  ['by_value, 1M rows', () => checksum(s.byValue('dist'))],
  [
    'nearest_index, 1M probes',
    () => {
      let sum = 0;
      for (const p of probes) sum += v.nearestIndex(p);
      return sum;
    },
  ],
  [
    'slice_by_value, 100k slices',
    () => {
      let sum = 0;
      for (let i = 0; i < 100_000; i += 1) {
        sum += v.sliceByValue(probes[i], probes[i] + 5).length;
      }
      return sum;
    },
  ],
  // As pond-rs's to_json, which returns text: serialize too.
  ['to_json rows, 300k', () => JSON.stringify(small.toJSON()).length],
  [
    'from_json rows, 300k',
    () => checksum(ValueSeries.fromJSON(JSON.parse(rowsJson))),
  ],
  ['to_columns_json, 300k', () => JSON.stringify(small.toColumns()).length],
  [
    'from_columns_json, 300k',
    () => checksum(ValueSeries.fromColumns(JSON.parse(columnsJson))),
  ],
  ['to_arrow, 1M rows', () => v.toArrow().length * 3],
  [
    'from_arrow, 1M rows',
    () => checksum(ValueSeries.fromArrow(table, { axis: 'dist' })),
  ],
  // pond-ts has no IPC writer of its own: apache-arrow writes the table.
  ['write_ipc, 1M rows', () => tableToIPC(table, 'file').length],
  [
    'from_ipc_bytes, 1M rows',
    () => checksum(ValueSeries.fromArrow(tableFromIPC(ipc), { axis: 'dist' })),
  ],
];

const only = process.argv[2];
console.log('| Case | pond-ts | checksum |');
console.log('| --- | --- | --- |');
for (const [name, f] of cases) {
  if (only !== undefined && !name.startsWith(only)) continue;
  const out = f();
  const times = [];
  for (let k = 0; k < 7; k += 1) {
    const t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(
    `| ${name} | ${times[3].toFixed(1)} ms | ${out.toExponential(6)} |`,
  );
}
