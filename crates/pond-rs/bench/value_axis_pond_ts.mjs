// pond-ts side of examples/perf_value_axis.rs: same data, same calls, same
// checksum (present numbers across every record, and their sum).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/value_axis_pond_ts.mjs [name prefix]
import { TimeSeries } from '../../../packages/core/dist/index.js';

const rows = 1_000_000;
const value = (i) => (i % 17 !== 5 ? ((i * 7919) % 10_007) / 8 : undefined);
const s = new TimeSeries({
  name: 'bench',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'dist', kind: 'number', required: false },
    { name: 'watts', kind: 'number', required: false },
  ],
  rows: Array.from({ length: rows }, (_, i) => [
    i * 1000,
    i % 23 !== 7 ? i / 100 : undefined,
    value(i),
  ]),
});
const avg = { avg: { from: 'watts', using: 'avg' } };
const counts = {
  n: { from: 'watts', using: 'count' },
  sum: { from: 'watts', using: 'sum' },
  avg: { from: 'watts', using: 'avg' },
};
const spread = {
  p5: { from: 'watts', using: 'p5' },
  p95: { from: 'watts', using: 'p95' },
};
const zones = { edges: [0, 200, 400, 600, 800, 1000, 1300], inclusive: '(]' };
const centers = Array.from({ length: 1000 }, (_, i) => i * 10);

const cases = [
  [
    'by_column width 10, 1000 bins',
    () => s.byColumn('dist', { width: 10 }, counts),
  ],
  ['by_column 6 zones', () => s.byColumn('watts', zones, counts)],
  [
    'by_column histogram, 1251 bins',
    () => s.byColumn('watts', { width: 1 }, { n: counts.n }),
  ],
  [
    'by_column width 10, p5 p95',
    () => s.byColumn('dist', { width: 10 }, spread),
  ],
  [
    'rolling_by_column radius 0.5, avg',
    () => s.rollingByColumn('dist', { radius: 0.5 }, avg),
  ],
  [
    'rolling_by_column radius 0.5, p5 p95',
    () => s.rollingByColumn('dist', { radius: 0.5 }, spread),
  ],
  [
    'rolling_by_column radius 5, p5 p95',
    () => s.rollingByColumn('dist', { radius: 5 }, spread),
  ],
  [
    'rolling_by_column at 1000 centers, radius 5',
    () => s.rollingByColumn('dist', { radius: 5, at: centers }, counts),
  ],
];

const checksum = (records) => {
  let n = 0;
  let sum = 0;
  for (const r of records) {
    for (const v of Object.values(r)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        n += 1;
        sum += v;
      }
    }
  }
  return [n, sum];
};

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
  const [n, sum] = checksum(out);
  console.log(
    `| ${name} | ${times[3].toFixed(1)} ms | ${n} ${sum.toExponential(6)} |`,
  );
}
