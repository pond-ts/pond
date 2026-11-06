// pond-ts side of examples/perf_array.rs: same data, same calls (the
// array calls and row JSON; pond-ts cannot read Arrow list columns, so the
// Arrow rows have no pond-ts side).
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/array_pond_ts.mjs
import { TimeSeries } from '../../../packages/core/dist/index.js';

const ROWS = 100_000;
const words = Array.from({ length: 20 }, (_, w) => `w${w}`);
const make = (single) =>
  new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'tags', kind: 'array', required: false },
      { name: 'nums', kind: 'array', required: false },
      { name: 'v', kind: 'number' },
    ],
    rows: Array.from({ length: ROWS }, (_, i) => {
      const t = single ? 1 : i % 7;
      const n = single ? 1 : i % 9;
      return [
        i * 1000,
        i % 10 === 9
          ? undefined
          : Array.from({ length: t }, (_, k) => words[(i * 7 + k * 3) % 20]),
        i % 10 === 9
          ? undefined
          : Array.from({ length: n }, (_, k) => ((i * 31 + k * 17) % 1000) / 8),
        i,
      ];
    }),
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

for (const [name, single] of [
  ['typical', false],
  ['single', true],
]) {
  const s = make(single);
  void s.events;
  const text = JSON.stringify(s.toJSON());
  const rows = [
    ['contains', () => s.arrayContains('tags', 'w3')],
    ['containsAny', () => s.arrayContainsAny('tags', ['w1', 'w4'])],
    ['containsAll', () => s.arrayContainsAll('tags', ['w1', 'w4'])],
    ['aggregate count', () => s.arrayAggregate('nums', 'count')],
    ['aggregate avg', () => s.arrayAggregate('nums', 'avg')],
    ['aggregate median', () => s.arrayAggregate('nums', 'median')],
    ['aggregate first', () => s.arrayAggregate('tags', 'first')],
    ['explode tags', () => s.arrayExplode('tags')],
    ['explode nums', () => s.arrayExplode('nums', { kind: 'number' })],
    ['toJSON', () => JSON.stringify(s.toJSON())],
    ['fromJSON', () => TimeSeries.fromJSON(JSON.parse(text))],
  ];
  for (const [op, f] of rows)
    console.log(
      `${name.padEnd(8)} ${op.padEnd(18)} ${time(f).toFixed(2).padStart(8)} ms`,
    );
}
