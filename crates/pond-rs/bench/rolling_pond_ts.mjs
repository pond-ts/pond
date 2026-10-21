// pond-ts side of examples/perf_rolling.rs: same data, same calls, same
// checksum (present values in the output column, and their sum).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/rolling_pond_ts.mjs [name prefix]
import { TimeSeries, Sequence } from '../../../packages/core/dist/index.js';

const make = (rows) =>
  new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
      { name: 'host', kind: 'string' },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      i * 1000,
      i % 17 !== 5 ? ((i * 7919) % 10_007) / 8 : undefined,
      `host-${Math.floor(i / 90) % 8}`,
    ]),
  });
const big = make(1_000_000);
const small = make(100_000);
const minute = Sequence.every('1m');
const out = (using) => ({ out: { from: 'v', using } });

const cases = [
  ['time 5m avg trailing', () => big.rolling('5m', out('avg'))],
  [
    'time 5m avg leading',
    () => big.rolling('5m', out('avg'), { alignment: 'leading' }),
  ],
  [
    'time 5m avg centered',
    () => big.rolling('5m', out('avg'), { alignment: 'centered' }),
  ],
  [
    'time 5m stdev centered',
    () => big.rolling('5m', out('stdev'), { alignment: 'centered' }),
  ],
  [
    'time 5m avg min 300',
    () => big.rolling('5m', out('avg'), { minSamples: 300 }),
  ],
  ['rows 20 avg', () => big.rolling({ count: 20 }, out('avg'))],
  [
    'rows 20 avg min 20',
    () => big.rolling({ count: 20 }, out('avg'), { minSamples: 20 }),
  ],
  ['rows 20 stdev', () => big.rolling({ count: 20 }, out('stdev'))],
  [
    'rows 300 avg centered',
    () => big.rolling({ count: 300 }, out('avg'), { alignment: 'centered' }),
  ],
  [
    'rows 20 avg by host',
    () => big.partitionBy('host').rolling({ count: 20 }, out('avg')).collect(),
  ],
  ['grid 1m, 5m avg, 100k rows', () => small.rolling(minute, '5m', out('avg'))],
];

const only = process.argv[2];
console.log('| Case | pond-ts | checksum |');
console.log('| --- | --- | --- |');
for (const [name, f] of cases) {
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
    const v = e.get('out');
    if (v !== undefined) {
      n += 1;
      sum += v;
    }
  }
  console.log(
    `| ${name} | ${times[3].toFixed(1)} ms | ${n} ${sum.toExponential(6)} |`,
  );
}
