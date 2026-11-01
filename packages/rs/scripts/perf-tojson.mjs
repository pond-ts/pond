// `toJSON()` through @pond-ts/rs against pond-ts's on the same 1M rows:
// (a) one number column, (b) four, (c) number + text (100 labels) +
// boolean, (d) time-range keys + one number, (e) = (c) as object rows.
// Median of 5 after 2 warm-ups; with `--expose-gc` each sample starts after
// a collection, so neither side pays for the last sample's garbage.
//
//     npm run build --workspace=pond-ts
//     packages/rs/build.sh
//     node --expose-gc packages/rs/scripts/perf-tojson.mjs
//
// PERF_RS=<dir> times another build of the package (its index.js), to
// compare before and after a change.

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const rs = await import(
  process.env.PERF_RS
    ? pathToFileURL(`${process.env.PERF_RS}/index.js`).href
    : '../index.js'
);
const ts = await import('../../core/dist/index.js');
const N = Number(process.env.PERF_N ?? 1_000_000);
const WARMUP = 2;
const REPEATS = 5;

const labels = Array.from({ length: 100 }, (_, i) => `host-${i}`);
const number = (name) => ({ name, kind: 'number' });
const specs = {
  a: {
    schema: [{ name: 'time', kind: 'time' }, number('v')],
    row: (i) => [i * 1000, i * 0.5],
  },
  b: {
    schema: [
      { name: 'time', kind: 'time' },
      ...['a', 'b', 'c', 'd'].map(number),
    ],
    row: (i) => [i * 1000, i, i * 0.5, -i, i + 0.25],
  },
  c: {
    schema: [
      { name: 'time', kind: 'time' },
      number('v'),
      { name: 'host', kind: 'string' },
      { name: 'up', kind: 'boolean' },
    ],
    row: (i) => [i * 1000, i * 0.5, labels[i % 100], i % 3 === 0],
  },
  d: {
    schema: [{ name: 'timeRange', kind: 'timeRange' }, number('v')],
    row: (i) => [[i * 1000, i * 1000 + 500], i * 0.5],
  },
};

function benchmark(fn) {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const samples = [];
  for (let i = 0; i < REPEATS; i += 1) {
    globalThis.gc?.();
    const start = performance.now();
    const out = fn();
    samples.push(performance.now() - start);
    if (out.rows.length !== N) throw new Error('wrong row count');
  }
  samples.sort((x, y) => x - y);
  return Number(samples[REPEATS >> 1].toFixed(1));
}

const results = [];
for (const [scenario, spec, options] of [
  ['a', specs.a],
  ['b', specs.b],
  ['c', specs.c],
  ['d', specs.d],
  ['e', specs.c, { rowFormat: 'object' }],
]) {
  const input = {
    name: 'perf',
    schema: spec.schema,
    rows: Array.from({ length: N }, (_, i) => spec.row(i)),
  };
  const a = new ts.TimeSeries(input);
  const b = new rs.TimeSeries(input);
  const pondTsMs = benchmark(() => a.toJSON(options));
  const rsMs = benchmark(() => b.toJSON(options));
  b.free();
  results.push({
    scenario,
    rsMs,
    pondTsMs,
    speedup: Number((pondTsMs / rsMs).toFixed(1)),
  });
}
console.log(JSON.stringify({ rows: N, gc: !!globalThis.gc, results }, null, 2));
