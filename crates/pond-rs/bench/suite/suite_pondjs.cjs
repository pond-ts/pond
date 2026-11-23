// pondjs side of the six-engine benchmark suite.
//
//     node --max-old-space-size=12288 suite_pondjs.cjs [rows] [case id]
//
// pondjs (0.9.0) is the predecessor of pond-ts. It has no rolling windows,
// no filter, no dedupe, no keyed join and no pivot outside its Pipeline, so
// only five of the suite's cases have a pondjs form; the rest are left out,
// not approximated. Same data as `examples/suite.rs`; see README.md. Prints
//
//     RESULT <tab> case id <tab> median ms <tab> rows out <tab> sum
//
// Timing: one warm-up call, then the median of 5. A case whose first call
// takes over 5 s is timed on that one call. pondjs's answers differ from
// pond's in places (which rows an align keeps at the edges, for one), and
// `collect.py` marks a case whose rows or sum differ.

const path = require('node:path');
const pond = require(
  require.resolve('pondjs', {
    paths: [__dirname, path.join(__dirname, '../../../../packages/core')],
  }),
);

// pondjs warns on the console once per missing value it meets; with 59,000
// gaps that is most of the run time and all of the output. Results go
// straight to stdout instead.
const print = (line) => process.stdout.write(`${line}\n`);
console.log = console.warn = console.error = () => {};

const ROWS = Number(process.argv[2] ?? 1_000_000);
const only = process.argv[3];

const value = (i) => (i % 17 !== 5 ? ((i * 7919) % 10_007) / 8 : null);
const host = (i) => `host-${Math.floor(i / 90) % 8}`;
const series = (name, time) =>
  new pond.TimeSeries({
    name,
    columns: ['time', 'v', 'host'],
    points: Array.from({ length: ROWS }, (_, i) => [
      time(i),
      value(i),
      host(i),
    ]),
  });

// Built on first use: a 1M-row pondjs series takes a while to make.
const lazy = (make) => {
  let made;
  return () => (made ??= make());
};
const even = lazy(() => series('even', (i) => i * 1000));
const uneven = lazy(() => series('uneven', (i) => i * 1000 + (i % 7) * 13));
// pondjs wants strictly ordered times, so `wide` here has one row per time:
// the sum of two columns does not depend on the times.
const wide = lazy(
  () =>
    new pond.TimeSeries({
      name: 'wide',
      columns: ['time', 'host', 'v', 'w'],
      points: Array.from({ length: ROWS }, (_, i) => [
        i * 1000,
        `h${((i % 100) * 37) % 100}`,
        value(i),
        value(i + 3),
      ]),
    }),
);

const cases = {
  agg_1m: () =>
    even().fixedWindowRollup({
      windowSize: '1m',
      aggregation: { out: { v: pond.avg(pond.filter.ignoreMissing) } },
    }),
  fill: () => even().fill({ fieldSpec: ['v'], method: 'linear' }),
  add: () =>
    wide().collapse({
      fieldSpecList: ['v', 'w'],
      name: 'out',
      reducer: (values) =>
        values.some((x) => x === null || x === undefined)
          ? null
          : values[0] + values[1],
      append: true,
    }),
  align_hold: () =>
    uneven().align({ fieldSpec: 'v', period: '1s', method: 'hold' }),
  align_linear: () =>
    uneven().align({ fieldSpec: 'v', period: '1s', method: 'linear' }),
};

// Rows, and the total of every present number in the value columns.
const check = (result) => {
  let rows = 0;
  let sum = 0;
  for (const event of result.events()) {
    rows += 1;
    const data = event.toJSON().data;
    for (const x of Object.values(data)) {
      if (typeof x === 'number' && Number.isFinite(x)) sum += x;
    }
  }
  return [rows, sum];
};

const timed = (f) => {
  const start = performance.now();
  const result = f();
  return [performance.now() - start, result];
};

print(`VERSION\tpondjs\t${require('pondjs/package.json').version}`);
for (const [id, f] of Object.entries(cases)) {
  if (only && id !== only) continue;
  try {
    const [first, result] = timed(f);
    const [rows, sum] = check(result);
    let ms = first;
    if (first <= 5_000) {
      const times = [];
      for (let k = 0; k < 5; k++) times.push(timed(f)[0]);
      times.sort((a, b) => a - b);
      ms = times[2];
    }
    print(`RESULT\t${id}\t${ms.toFixed(3)}\t${rows}\t${sum}`);
  } catch (error) {
    print(`SKIP\t${id}\t${String(error?.message ?? error).slice(0, 200)}`);
  }
}
