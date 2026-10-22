// @pond-ts/financial side of examples/perf_studies.rs: same data, same
// calls, same checksum (present values in the output, and their sum).
//
//     npm run build --workspace=pond-ts
//     npm run build --workspace=@pond-ts/financial
//     node crates/pond-rs/bench/studies_pond_ts.mjs [name prefix]
import { TimeSeries } from '../../../packages/core/dist/index.js';
import * as f from '../../../packages/financial/dist/index.js';

const price = (i) => 100 + ((i * 7919) % 10_007) / 800;
const make = (rows, gappy) =>
  new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number', required: false },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      i * 60_000,
      !gappy || i % 17 !== 5 ? price(i) : undefined,
    ]),
  });
const dense = make(1_000_000, false);
const gappy = make(1_000_000, true);

const cases = [
  ['sma 20', 'sma', () => f.sma(dense, { period: 20 })],
  ['sma 200', 'sma', () => f.sma(dense, { period: 200 })],
  ['sma 20 gaps', 'sma', () => f.sma(gappy, { period: 20 })],
  ['ema 20', 'ema', () => f.ema(dense, { period: 20 })],
  ['stdev 20', 'stdev', () => f.rollingStdev(dense, { period: 20 })],
  ['min 20', 'min', () => f.rollingMin(dense, { period: 20 })],
  ['max 200', 'max', () => f.rollingMax(dense, { period: 200 })],
  ['p90 20', 'p90', () => f.rollingPercentile(dense, { period: 20, q: 90 })],
  ['zscore 20', 'zscore', () => f.zScore(dense, { period: 20 })],
  ['zscore 20 gaps', 'zscore', () => f.zScore(gappy, { period: 20 })],
  ...f.MA_TYPES.map((type) => [
    `ma ${type} 20`,
    'ma',
    () => f.movingAverage(dense, { period: 20, type }),
  ]),
];

const only = process.argv[2];
console.log('| Case | pond-ts | checksum |');
console.log('| --- | --- | --- |');
for (const [name, column, run] of cases) {
  if (only && !name.startsWith(only)) continue;
  let result = run();
  const times = [];
  for (let k = 0; k < 7; k++) {
    const t = performance.now();
    result = run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const col = result.column(column);
  let n = 0;
  let sum = 0;
  for (let i = 0; i < result.length; i += 1) {
    const v = col.at(i);
    if (v !== undefined) {
      n += 1;
      sum += v;
    }
  }
  console.log(
    `| ${name} | ${times[3].toFixed(1)} ms | ${n} ${sum.toExponential(6)} |`,
  );
}
