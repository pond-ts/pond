// pond-ts side of examples/perf_join.rs: same data, same ops, same checksum
// (rows, and the sum of every number column where present).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/join_pond_ts.mjs
import { TimeSeries } from '../../../packages/core/dist/index.js';

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
const make = (name, n, time, col, txt, shift) =>
  new TimeSeries({
    name,
    schema: [
      { name: 'time', kind: 'time' },
      { name: col, kind: 'number', required: false },
      { name: txt, kind: 'string' },
    ],
    rows: Array.from({ length: n }, (_, i) => [
      time(i),
      values[(i + shift) % N],
      text[(i + shift) % N],
    ]),
  });
const a = make('a', N, (i) => i * 1000, 'v', 'host', 0);
const b = make('b', N, (i) => i * 1500, 'w', 'tag', 1);
const c = make('c', N, (i) => i * 1000, 'x', 'c_host', 2);
const d = make('d', N, (i) => i * 1000, 'y', 'd_host', 3);
const sparse = make('s', 10_000, (i) => i * 100_000, 'w', 'tag', 4);

// Five warm-up runs, as in rowwise_pond_ts.mjs.
const median = (f) => {
  for (let i = 0; i < 5; i++) f();
  const t = [];
  for (let i = 0; i < 7; i++) {
    const s = performance.now();
    f();
    t.push(performance.now() - s);
  }
  t.sort((x, y) => x - y);
  return t[3];
};
const checksum = (s) => {
  const cols = s.schema.slice(1).filter((c) => c.kind === 'number');
  let sum = 0;
  for (const col of cols) {
    let part = 0;
    for (const e of s.events) {
      const v = e.get(col.name);
      if (v !== undefined) part += v;
    }
    sum += part;
  }
  return `${s.length} rows, sum ${sum}`;
};
const cases = [
  ['left join, 1M x 1M, 1/3 match', () => a.join(b, { type: 'left' })],
  ['inner join, 1M x 1M', () => a.join(b, { type: 'inner' })],
  ['outer join, 1M x 1M', () => a.join(b)],
  ['left join, 1M x 10k sparse', () => a.join(sparse, { type: 'left' })],
  ['outer join, same keys', () => a.join(c)],
  ['joinMany 3 on same keys', () => TimeSeries.joinMany([a, c, d])],
];
const only = process.argv[2];
for (const [name, f] of cases) {
  if (only && !name.includes(only)) continue;
  const sum = checksum(f());
  console.log(`| ${name} | ${median(f).toFixed(1)} ms | ${sum} |`);
}
