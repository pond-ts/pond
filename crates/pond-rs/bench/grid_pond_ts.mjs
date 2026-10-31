// pond-ts side of examples/perf_grid.rs: same data, same ops, same checksum
// (rows, and the sum of `v` where present).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/grid_pond_ts.mjs
import { TimeSeries, Sequence } from '../../../packages/core/dist/index.js';

let seed = 20261019;
const next = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const N = 1_000_000;
const HOSTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const values = new Array(N);
const text = new Array(N);
for (let i = 0; i < N; i++) {
  const r = next();
  values[i] = r >= 0.02 ? Math.floor(r * 1000) / 8 : undefined;
  text[i] = HOSTS[i % 8];
}
const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
];
const make = (name, n, time) =>
  new TimeSeries({
    name,
    schema: SCHEMA,
    rows: Array.from({ length: n }, (_, i) => [time(i), values[i], text[i]]),
  });
const dense = make('dense', N, (i) => i * 1000 + (i % 7) * 13);
const repeats = make('repeats', N, (i) => (i - Math.floor(i / 10)) * 1000);
const sparse = make('sparse', 10_000, (i) => (i * 1000 + (i % 7) * 13) * 100);

const SYMBOLS = 500;
const BARS = 1000;
const panelRows = [];
for (let b = 0; b < BARS; b++) {
  for (let s = 0; s < SYMBOLS; s++) {
    const r = next();
    panelRows.push([
      b * 60_000 + (s % 5) * 7_000,
      `s${String(s).padStart(3, '0')}`,
      r >= 0.02 ? Math.floor(r * 1000) / 8 : undefined,
    ]);
  }
}
// Stable, so rows at one time keep symbol order, as in the Rust side.
panelRows.sort((a, b) => a[0] - b[0]);
const panel = new TimeSeries({
  name: 'panel',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'symbol', kind: 'string' },
    { name: 'v', kind: 'number', required: false },
  ],
  rows: panelRows,
});

const minute = Sequence.every('1m');
const second = Sequence.every('1s');
// Five warm-up runs, as in rowwise_pond_ts.mjs.
const median = (f) => {
  for (let i = 0; i < 5; i++) f();
  const t = [];
  for (let i = 0; i < 7; i++) {
    const a = performance.now();
    f();
    t.push(performance.now() - a);
  }
  t.sort((a, b) => a - b);
  return t[3];
};
const checksum = (s) => {
  let sum = 0;
  for (const e of s.events) {
    const v = e.get('v');
    if (v !== undefined) sum += v;
  }
  return `${s.length} rows, sum ${sum}`;
};
const cases = [
  ['align hold 1m (1M rows)', () => dense.align(minute)],
  ['align hold 1s (1M rows)', () => dense.align(second)],
  [
    'align linear 1s (1M rows)',
    () => dense.align(second, { method: 'linear' }),
  ],
  ['align hold 1s (10k rows, 1M buckets)', () => sparse.align(second)],
  ['materialize last 1s (1M rows)', () => dense.materialize(second)],
  [
    'materialize nearest 1m (1M rows)',
    () => dense.materialize(minute, { select: 'nearest' }),
  ],
  [
    'materialize last 1s (10k rows, 1M buckets)',
    () => sparse.materialize(second),
  ],
  ['dedupe last (1M rows, 10% repeats)', () => repeats.dedupe()],
  [
    'dedupe max v (1M rows, 10% repeats)',
    () => repeats.dedupe({ keep: { max: 'v' } }),
  ],
  [
    'panel: align 1m per symbol + collect',
    () => panel.partitionBy('symbol').align(minute).collect(),
  ],
  [
    'panel: materialize 1m per symbol + collect',
    () => panel.partitionBy('symbol').materialize(minute).collect(),
  ],
  [
    'panel: dedupe per symbol + collect',
    () => panel.partitionBy('symbol').dedupe().collect(),
  ],
];
const only = process.argv[2];
for (const [name, f] of cases) {
  if (only && !name.includes(only)) continue;
  const sum = checksum(f());
  console.log(`| ${name} | ${median(f).toFixed(1)} ms | ${sum} |`);
}
