// pond-ts side of examples/perf_smooth.rs: same data, same calls, same
// checksum (present values in the checked column, and their sum).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/smooth_pond_ts.mjs [name prefix]
import { TimeSeries } from '../../../packages/core/dist/index.js';

const value = (i) => (i % 17 !== 5 ? ((i * 7919) % 10_007) / 8 : undefined);
const make = (rows) =>
  new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ],
    rows: Array.from({ length: rows }, (_, i) => [i * 1000, value(i)]),
  });
// Time ranges 0 to 4 s long on a 1 s grid, so their middles run backwards.
const ranges = (rows) =>
  new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number', required: false },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      [i * 1000, i * 1000 + ((i * 37) % 5) * 1000],
      value(i),
    ]),
  });
const big = make(1_000_000);
const spans = ranges(1_000_000);
const small = make(20_000);
const tiny = make(5_000);
const names = { upper: 'out' };

const cases = [
  [
    'ema alpha 0.1',
    'out',
    () => big.smooth('v', 'ema', { alpha: 0.1, output: 'out' }),
  ],
  [
    'ema span 20 min 20',
    'out',
    () => big.smooth('v', 'ema', { span: 20, minSamples: 20, output: 'out' }),
  ],
  [
    'moving average 5m',
    'out',
    () => big.smooth('v', 'movingAverage', { window: '5m', output: 'out' }),
  ],
  [
    'moving average 5m centered skip',
    'out',
    () =>
      big.smooth('v', 'movingAverage', {
        window: '5m',
        alignment: 'centered',
        missing: 'skip',
        output: 'out',
      }),
  ],
  [
    'moving average 5m, ranges',
    'out',
    () => spans.smooth('v', 'movingAverage', { window: '5m', output: 'out' }),
  ],
  [
    'loess 0.05, 20k rows',
    'out',
    () => small.smooth('v', 'loess', { span: 0.05, output: 'out' }),
  ],
  [
    'loess 0.3, 5k rows',
    'out',
    () => tiny.smooth('v', 'loess', { span: 0.3, output: 'out' }),
  ],
  [
    'baseline 5m',
    'out',
    () => big.baseline('v', { window: '5m', sigma: 2, names }),
  ],
  ['outliers 5m', 'v', () => big.outliers('v', { window: '5m', sigma: 1.5 })],
  [
    'scan sum',
    'out',
    () => big.scan('v', (a, v) => [a + v, a + v], 0, { output: 'out' }),
  ],
  [
    'scan gain',
    'out',
    () =>
      big.scan(
        'v',
        (acc, v) => {
          if (acc.ref === null) return [{ ref: v, gain: 0 }, 0];
          const d = v - acc.ref;
          if (d >= 300) return [{ ref: v, gain: acc.gain + d }, acc.gain + d];
          if (d <= -300) return [{ ref: v, gain: acc.gain }, acc.gain];
          return [acc, acc.gain];
        },
        { ref: null, gain: 0 },
        { output: 'out' },
      ),
  ],
  ['sample stride 10', 'v', () => big.sample({ stride: 10 })],
  [
    'sample reservoir 1000',
    'v',
    () => big.sample({ reservoir: { size: 1000 } }),
  ],
];

const only = process.argv[2];
console.log('| Case | pond-ts | checksum |');
console.log('| --- | --- | --- |');
for (const [name, column, f] of cases) {
  if (only && !name.startsWith(only)) continue;
  let result = f();
  const times = [];
  for (let k = 0; k < 7; k++) {
    const t = performance.now();
    result = f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  let n = 0;
  let sum = 0;
  for (const e of result.events) {
    const v = e.get(column);
    if (v !== undefined) {
      n += 1;
      sum += v;
    }
  }
  console.log(
    `| ${name} | ${times[3].toFixed(1)} ms | ${n} ${sum.toExponential(6)} |`,
  );
}
