// pond-ts side of examples/perf_reducers.rs: same data (no decimal column;
// pond-ts has no decimals), same calls.
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/reducers_pond_ts.mjs [name prefix]
//
// A cell whose warm-up run takes over 5 s is timed once more and that run
// reported (rolling `samples` takes ~100 s a run); other cells are the
// median of 7 after one warm-up.
import { TimeSeries, Sequence } from '../../../packages/core/dist/index.js';

const ROWS = 1_000_000;
const raw = (i) => ((Math.floor(i / 40) * 7919) % 10_007) - 5000;
const s = new TimeSeries({
  name: 'bench',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number', required: false },
    { name: 'host', kind: 'string', required: false },
  ],
  rows: Array.from({ length: ROWS }, (_, i) => [
    i * 1000,
    i % 17 !== 5 ? raw(i) / 100 : undefined,
    `host-${Math.floor(i / 90) % 8}`,
  ]),
});

const time = (f) => {
  let t = performance.now();
  f();
  const first = performance.now() - t;
  const runs = first > 5000 ? 1 : 7;
  const times = [];
  for (let k = 0; k < runs; k++) {
    t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
};

const cases = [
  ['min v', 'v', 'min'],
  ['keep v', 'v', 'keep'],
  ['difference v', 'v', 'difference'],
  ['keep host', 'host', 'keep'],
  ['unique v', 'v', 'unique'],
  ['unique host', 'host', 'unique'],
  ['top3 v', 'v', 'top3'],
  ['top3 host', 'host', 'top3'],
  ['samples v', 'v', 'samples'],
];
const minute = Sequence.every('1m');
const second = Sequence.every('1s');
const only = process.argv[2];
console.log('| Reducer | agg 1m | agg 1s | rolling 5m | rolling 1d | reduce |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const [name, column, using] of cases) {
  if (only && !name.startsWith(only)) continue;
  const aggs = { out: { from: column, using } };
  const lists = ['unique', 'top3', 'samples'].includes(using);
  const cells = [
    time(() => s.aggregate(minute, aggs)),
    time(() => s.aggregate(second, aggs)),
    time(() => s.rolling('5m', aggs)),
    lists ? undefined : time(() => s.rolling('1d', aggs)),
    time(() => s.reduce(column, using)),
  ];
  console.log(
    `| ${name} | ${cells.map((c) => (c === undefined ? '-' : `${c.toFixed(1)} ms`)).join(' | ')} |`,
  );
}
