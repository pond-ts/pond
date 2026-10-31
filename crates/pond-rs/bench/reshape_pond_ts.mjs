// pond-ts side of examples/perf_reshape.rs: same data, same calls, same
// checksum (present values across the number columns, and their sum).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/reshape_pond_ts.mjs [name prefix]
import { TimeSeries } from '../../../packages/core/dist/index.js';

const value = (i) => (i % 17 !== 5 ? ((i * 7919) % 10_007) / 8 : undefined);
const long = (rows, hosts, copies) => {
  const perTime = hosts * copies;
  return new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'host', kind: 'string' },
      { name: 'v', kind: 'number', required: false },
      { name: 'w', kind: 'number', required: false },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      Math.floor(i / perTime) * 1000,
      `h${(Math.floor((i % perTime) / copies) * 37) % hosts}`,
      value(i),
      value(i + 3),
    ]),
  });
};
const parts = (count, rows) =>
  Array.from(
    { length: count },
    (_, p) =>
      new TimeSeries({
        name: 'bench',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'v', kind: 'number', required: false },
        ],
        rows: Array.from({ length: rows }, (_, i) => [
          (i * count + p) * 1000,
          value(i * count + p),
        ]),
      }),
  );
const wide = long(1_000_000, 100, 1);
const twice = long(1_000_000, 100, 2);
const few = long(1_000_000, 4, 1);
const ten = parts(10, 100_000);
const many = parts(1000, 1000);
const sum = ({ v, w }) =>
  v !== undefined && w !== undefined ? v + w : undefined;

const cases = [
  ['concat 10 x 100k', () => TimeSeries.concat(ten)],
  ['concat 1000 x 1k', () => TimeSeries.concat(many)],
  ['collapse sum', () => wide.collapse(['v', 'w'], 'out', sum)],
  [
    'collapse_keep sum',
    () => wide.collapse(['v', 'w'], 'out', sum, { append: true }),
  ],
  ['pivot 100 hosts', () => wide.pivotByGroup('host', 'v')],
  ['pivot 4 hosts', () => few.pivotByGroup('host', 'v')],
  [
    'pivot 100 hosts x2 avg',
    () => twice.pivotByGroup('host', 'v', { aggregate: 'avg' }),
  ],
  [
    'pivot 100 hosts x2 last',
    () => twice.pivotByGroup('host', 'v', { aggregate: 'last' }),
  ],
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
  let total = 0;
  const numberColumns = result.schema
    .slice(1)
    .filter((c) => c.kind === 'number')
    .map((c) => c.name);
  for (const e of result.events) {
    for (const c of numberColumns) {
      const v = e.get(c);
      if (v !== undefined) {
        n += 1;
        total += v;
      }
    }
  }
  console.log(
    `| ${name} | ${times[3].toFixed(1)} ms | ${n} ${total.toExponential(6)} |`,
  );
}
