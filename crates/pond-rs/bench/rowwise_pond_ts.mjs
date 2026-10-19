// pond-ts side of examples/perf_rowwise.rs: same data, same ops.
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/rowwise_pond_ts.mjs
import { TimeSeries } from '../../../packages/core/dist/index.js';

const ROWS = 1_000_000;
let seed = 20261019;
const next = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const rows = [];
let gap = 0;
for (let i = 0; i < ROWS; i++) {
  if (gap === 0 && next() < 0.02) gap = 1 + Math.floor(next() * 4);
  if (gap > 0) {
    gap -= 1;
    rows.push([i * 1000, undefined]);
  } else {
    rows.push([i * 1000, (i % 1000) + next()]);
  }
}
const s = new TimeSeries({
  name: 'data',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number', required: false },
  ],
  rows,
});
const median = (f) => {
  f();
  const t = [];
  for (let i = 0; i < 7; i++) {
    const a = performance.now();
    f();
    t.push(performance.now() - a);
  }
  t.sort((a, b) => a - b);
  return t[3];
};
const cases = [
  ['diff', () => s.diff('v')],
  ['diff drop', () => s.diff('v', { drop: true })],
  ['rate', () => s.rate('v')],
  ['pct_change', () => s.pctChange('v')],
  ['cumulative sum', () => s.cumulative({ v: 'sum' })],
  ['shift 1', () => s.shift('v', 1)],
  ['fill hold', () => s.fill('hold')],
  ['fill linear', () => s.fill('linear')],
  ['fill linear maxGap 3s', () => s.fill('linear', { maxGap: '3s' })],
];
const gaps = rows.filter((r) => r[1] === undefined).length;
const sum = rows.reduce((a, r) => a + (r[1] ?? 0), 0);
console.log(`${ROWS} rows, ${gaps} gaps, sum ${sum}`);
for (const [name, f] of cases) console.log(`| ${name} | ${median(f).toFixed(1)} ms |`);
