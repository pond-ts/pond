// pond-ts side of examples/perf_json.rs: same series, same JSON calls, text
// in and out (`JSON.stringify` / `JSON.parse` included, as pond-rs reads and
// writes text).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/json_pond_ts.mjs
import { TimeSeries } from '../../../packages/core/dist/index.js';

const NUMERIC = ['open', 'high', 'low', 'close', 'volume'];
const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN'];
const make = (rows, { strings = false, sparse = false } = {}) =>
  new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'time', kind: 'time' },
      ...NUMERIC.map((name) => ({ name, kind: 'number', required: !sparse })),
      ...(strings ? [{ name: 'symbol', kind: 'string' }] : []),
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      i * 1000,
      ...NUMERIC.map(() =>
        sparse && i % 10 === 0 ? undefined : (i % 100) / 7,
      ),
      ...(strings ? [SYMBOLS[i % 4]] : []),
    ]),
  });
const wide = new TimeSeries({
  name: 'wide',
  schema: [
    { name: 'time', kind: 'time' },
    ...Array.from({ length: 40 }, (_, c) => ({
      name: `c${c}`,
      kind: 'number',
    })),
  ],
  rows: Array.from({ length: 10_000 }, (_, i) => [
    i * 1000,
    ...Array.from({ length: 40 }, (_, c) => (i + c) % 97),
  ]),
});

const time = (f) => {
  for (let k = 0; k < 3; k++) f();
  const times = [];
  for (let k = 0; k < 9; k++) {
    const t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[4];
};

for (const [label, s] of [
  ['dense numeric (100k x 6)', make(100_000)],
  ['with a string column (100k x 7)', make(100_000, { strings: true })],
  ['~10% gaps (100k x 6)', make(100_000, { sparse: true })],
  ['wide (10k x 41)', wide],
]) {
  void s.events;
  const text = JSON.stringify(s.toJSON());
  const columns = JSON.stringify(s.toColumns());
  const points = JSON.stringify(s.toPoints());
  const cells = {
    'to_json tuple': time(() => JSON.stringify(s.toJSON())),
    'to_json object': time(() =>
      JSON.stringify(s.toJSON({ rowFormat: 'object' })),
    ),
    from_json: time(() => TimeSeries.fromJSON(JSON.parse(text))),
    to_columns_json: time(() => JSON.stringify(s.toColumns())),
    from_columns_json: time(() => TimeSeries.fromColumns(JSON.parse(columns))),
    to_points_json: time(() => JSON.stringify(s.toPoints())),
    from_points_json: time(() =>
      TimeSeries.fromPoints(JSON.parse(points), {
        schema: s.schema,
        name: 'p',
      }),
    ),
  };
  console.log(
    `${label}: ${Object.entries(cells)
      .map(([k, v]) => `${k} ${v.toFixed(2)} ms`)
      .join(', ')}`,
  );
}
