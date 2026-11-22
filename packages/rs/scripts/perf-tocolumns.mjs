// The hand-over from @pond-ts/wasm to a pond-ts series (what
// `@pond-ts/charts` takes): `TimeSeries.fromColumns(rs.toColumns())`
// against `TimeSeries.fromJSON(rs.toJSON())`, on a time column and two
// number columns, at 10k, 100k and 1M rows. Median of 7 after 2 warm-ups.
//
//     npm run build --workspace=pond-ts
//     packages/rs/build.sh
//     node packages/rs/scripts/perf-tocolumns.mjs

import { performance } from 'node:perf_hooks';
import * as rs from '../index.js';
import * as ts from '../../core/dist/index.js';

const median = (f) => {
  for (let i = 0; i < 2; i++) f();
  const t = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    f();
    t.push(performance.now() - t0);
  }
  return t.sort((a, b) => a - b)[3];
};

const results = [];
for (const n of [10_000, 100_000, 1_000_000]) {
  const rows = Array.from({ length: n }, (_, i) => [
    i * 1000,
    Math.sin(i / 50),
    Math.cos(i / 70),
  ]);
  const s = new rs.TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'a', kind: 'number' },
      { name: 'b', kind: 'number' },
    ],
    rows,
  });
  results.push({
    rows: n,
    toColumnsMs: +median(() =>
      ts.TimeSeries.fromColumns(s.toColumns()),
    ).toFixed(1),
    toJsonMs: +median(() => ts.TimeSeries.fromJSON(s.toJSON())).toFixed(1),
  });
  s.free();
}
console.log(JSON.stringify(results, null, 2));
