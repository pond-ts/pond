// LiveSeries through @pond-ts/rs ([PND-RUST-R4] J2b) against pond-ts's
// LiveSeries on the same 1M events (10 ms apart, one number column, the
// Python bridge's bench_live.py data), no retention (pond-ts's single
// `push` with `retention: { maxAge }` costs ~25 us an event, which would
// swamp the comparison):
//
// - bare: nothing built on the series (storage only);
// - pipeline: a 1-minute rolling average (updated on every event) and
//   1-minute buckets of avg / max, with a listener on the closed buckets;
// - pipeline + rolling listener: also a listener on every rolling update
//   (1M outputs crossing back to JavaScript);
//
// each fed by `push(row)` once per event and by `pushMany` batches of
// 1,000 rows. The rows are made before timing; each run builds a fresh
// series (and frees it on the bridge). Median of 5 runs after a warm-up,
// in ms. Checks both sides end with the same rolling value and buckets.
//
//     npm run build --workspace=pond-ts
//     packages/rs/build.sh
//     node packages/rs/scripts/perf-live.mjs

import { performance } from 'node:perf_hooks';
import * as rs from '../index.js';
import * as ts from '../../core/dist/index.js';

const N = Number(process.env.PERF_N ?? 1_000_000);
const WARMUP = 1;
const REPEATS = 5;
const BATCH = 1_000;

let seed = 20261031;
const next = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const rows = Array.from({ length: N }, (_, i) => [
  i * 10,
  50 + (next() + next() + next() - 1.5) * 20,
]);
const batches = [];
for (let i = 0; i < N; i += BATCH) batches.push(rows.slice(i, i + BATCH));

const options = {
  name: 'cpu',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
  ],
};

function build(lib, shape) {
  const live = new lib.LiveSeries(options);
  if (shape === 'bare') return { live };
  const roll = live.rolling('1m', { avg: { from: 'cpu', using: 'avg' } });
  const agg = live.aggregate(lib.Sequence.every('1m'), {
    avg: { from: 'cpu', using: 'avg' },
    max: { from: 'cpu', using: 'max' },
  });
  let buckets = 0;
  agg.on('event', () => buckets++);
  let updates = 0;
  if (shape === 'listen') roll.on('event', () => updates++);
  return { live, roll, agg, counts: () => ({ buckets, updates }) };
}

function feed(p, how) {
  if (how === 'push') {
    const { live } = p;
    for (let i = 0; i < N; i++) live.push(rows[i]);
  } else {
    for (const b of batches) p.live.pushMany(b);
  }
  return p;
}

const finish = (p) => {
  const out = {
    length: p.live.length,
    value: p.roll?.value(),
    closed: p.agg?.closed().toJSON().rows.slice(-3),
    ...p.counts?.(),
  };
  p.live.free?.();
  return out;
};

function benchmark(lib, shape, how) {
  let last;
  for (let i = 0; i < WARMUP; i++) last = finish(feed(build(lib, shape), how));
  const samples = [];
  for (let i = 0; i < REPEATS; i++) {
    const p = build(lib, shape);
    const start = performance.now();
    feed(p, how);
    samples.push(performance.now() - start);
    last = finish(p);
  }
  samples.sort((x, y) => x - y);
  return { ms: Number(samples[REPEATS >> 1].toFixed(1)), last };
}

const results = [];
for (const shape of ['bare', 'pipeline', 'listen']) {
  for (const how of ['push', 'pushMany']) {
    const a = benchmark(ts, shape, how);
    const b = benchmark(rs, shape, how);
    if (JSON.stringify(a.last) !== JSON.stringify(b.last))
      throw new Error(
        `${shape}/${how}: ${JSON.stringify(a.last)} vs ${JSON.stringify(b.last)}`,
      );
    results.push({
      case: `${shape} ${how}`,
      rsMs: b.ms,
      pondTsMs: a.ms,
      speedup: Number((a.ms / b.ms).toFixed(1)),
    });
  }
}
console.log(JSON.stringify({ events: N, results }, null, 2));
