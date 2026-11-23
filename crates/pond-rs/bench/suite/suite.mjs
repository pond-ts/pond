// pond-ts and @pond-ts/wasm sides of the six-engine benchmark suite. The two
// share method names, so they share this file.
//
//     npm run build --workspace=pond-ts          # for pond-ts
//     bash packages/rs/build.sh                  # for wasm
//     node suite.mjs pond-ts [rows] [case id]
//     node suite.mjs wasm    [rows] [case id]
//
// Same data and the same cases as `examples/suite.rs`; see README.md. Prints
//
//     RESULT <tab> case id <tab> median ms <tab> rows out <tab> sum
//
// where `sum` is the total of every present value in the result's number
// columns. Timing: five warm-up calls (V8 is still compiling during the
// first few), then the median of 7. A case whose first call takes over 20 s
// is timed on that one call.
//
// A wasm series lives in WebAssembly memory, which the garbage collector
// cannot see, so every result is freed as soon as it has been read.

const engine = process.argv[2];
const ROWS = Number(process.argv[3] ?? 1_000_000);
const only = process.argv[4];

const paths = {
  'pond-ts': '../../../../packages/core/dist/index.js',
  wasm: '../../../../packages/rs/index.js',
};
if (!paths[engine]) {
  console.error(`unknown engine ${engine}: use pond-ts or wasm`);
  process.exit(2);
}
const { TimeSeries, Sequence, col } = await import(paths[engine]);

const value = (i) => (i % 17 !== 5 ? ((i * 7919) % 10_007) / 8 : undefined);
const host = (i) => `host-${Math.floor(i / 90) % 8}`;
const SERIES = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
];
const series = (name, time) =>
  new TimeSeries({
    name,
    schema: SERIES,
    rows: Array.from({ length: ROWS }, (_, i) => [time(i), value(i), host(i)]),
  });

// Even one-second steps.
const even = series('even', (i) => i * 1000);
// The same rows a few milliseconds off the second, for `align`.
const uneven = series('uneven', (i) => i * 1000 + (i % 7) * 13);
// Every tenth time repeated, for `dedupe`.
const repeats = series('repeats', (i) => (i - Math.floor(i / 10)) * 1000);
// The right-hand side of the join: every third time matches.
const other = new TimeSeries({
  name: 'other',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'w', kind: 'number', required: false },
    { name: 'tag', kind: 'string' },
  ],
  rows: Array.from({ length: ROWS }, (_, i) => [
    i * 1500,
    value(i + 1),
    host(i + 1),
  ]),
});
// 100 hosts per time, two number columns: for `pivot` and the sum of two
// columns.
const wide = new TimeSeries({
  name: 'wide',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'host', kind: 'string' },
    { name: 'v', kind: 'number', required: false },
    { name: 'w', kind: 'number', required: false },
  ],
  rows: Array.from({ length: ROWS }, (_, i) => [
    Math.floor(i / 100) * 1000,
    `h${((i % 100) * 37) % 100}`,
    value(i),
    value(i + 3),
  ]),
});

const minute = Sequence.every('1m');
const second = Sequence.every('1s');
const out = (using) => ({ out: { from: 'v', using } });
const add = col('v').add(col('w'));

const cases = {
  agg_1m: () => even.aggregate(minute, out('avg')),
  roll_5m: () => even.rolling('5m', out('avg')),
  roll_20: () => even.rolling({ count: 20 }, out('avg')),
  roll_20_sd: () => even.rolling({ count: 20 }, out('stdev')),
  roll_20_host: () => {
    const parts = even.partitionBy('host');
    const rolled = parts.rolling({ count: 20 }, out('avg'));
    const result = rolled.collect();
    rolled.free?.();
    parts.free?.();
    return result;
  },
  roll_grid: () => even.rolling(second, '5m', out('avg')),
  diff: () => even.diff('v'),
  fill: () => even.fill('linear'),
  cumsum: () => even.cumulative({ v: 'sum' }),
  filter: () => even.filter(col('v').gt(500)),
  add: () => wide.withColumn('out', add),
  align_hold: () => uneven.align(second),
  align_linear: () => uneven.align(second, { method: 'linear' }),
  dedupe: () => repeats.dedupe(),
  join_left: () => even.join(other, { type: 'left' }),
  pivot: () => wide.pivotByGroup('host', 'v'),
};

// Rows, and the total of every present value in the number columns.
const check = (result) => {
  const { schema, columns } = result.toColumns();
  let sum = 0;
  for (const column of schema.slice(1)) {
    if (column.kind !== 'number') continue;
    let part = 0;
    for (const x of columns[column.name]) {
      if (x !== null && x !== undefined && !Number.isNaN(x)) part += x;
    }
    sum += part;
  }
  return [result.length, sum];
};

const timed = (f) => {
  const start = performance.now();
  const result = f();
  const ms = performance.now() - start;
  return [ms, result];
};

console.log(`VERSION\t${engine}\tnode ${process.version}`);
for (const [id, f] of Object.entries(cases)) {
  if (only && id !== only) continue;
  try {
    const [first, result] = timed(f);
    const [rows, sum] = check(result);
    result.free?.();
    let ms = first;
    if (first <= 20_000) {
      for (let k = 0; k < 4; k++) f().free?.();
      const times = [];
      for (let k = 0; k < 7; k++) {
        const [t, r] = timed(f);
        r.free?.();
        times.push(t);
      }
      times.sort((a, b) => a - b);
      ms = times[3];
    }
    console.log(`RESULT\t${id}\t${ms.toFixed(3)}\t${rows}\t${sum}`);
  } catch (error) {
    // one failing case must not hide the rest
    console.log(
      `SKIP\t${id}\t${String(error?.message ?? error).slice(0, 200)}`,
    );
  }
}
