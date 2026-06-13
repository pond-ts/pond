import { performance } from 'node:perf_hooks';
import { Sequence, TimeRange, TimeSeries } from '../dist/index.js';

// Perf check for the `first`/`last` columnar aggregate fast path (audit v2
// §3.2/§3.3). Before this change, a mapping containing ANY `first`/`last`
// column bailed the whole `aggregate()` call to the row path (those reducers
// lack a numeric `reduceColumn`). Because the partitioned `aggregate` auto-
// injects `{ host: { from: 'host', using: 'first' } }`, EVERY partitioned
// call was excluded from the fast path. Now `first`/`last` qualify via a
// boundary scan over any column kind.
//
// An explicit `range` is passed so this isolates the aggregate work from
// `timeRange()` (already made columnar in #214).

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

function makeSeries(length, hosts = 64) {
  return new TimeSeries({
    name: 'metrics',
    schema,
    rows: Array.from({ length }, (_, i) => [
      i * 1_000,
      (i % 100) + (i % 7) * 0.5,
      `host-${i % hosts}`,
    ]),
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function benchmark(label, length, run, repeats = 7) {
  const series = makeSeries(length);
  const range = new TimeRange({ start: 0, end: (length - 1) * 1_000 });
  const seq = Sequence.every(60_000);
  run(series, seq, range); // warm-up (JIT), not a sample

  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    const out = run(series, seq, range);
    const end = performance.now();
    if (out.length === 0) throw new Error(`empty output for ${label}`);
    samples.push(end - start);
  }
  return {
    scenario: label,
    length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const results = [];

// 1. Flat mapping with a `first` column alongside a numeric reducer — the
//    clean isolation of fast-path engagement. Before: the `host:'first'`
//    bailed the WHOLE call (incl. cpu:'avg') to the row path.
for (const n of [100_000, 1_000_000]) {
  results.push(
    benchmark('flat {cpu:avg, host:first}', n, (s, seq, range) =>
      s.aggregate(seq, { cpu: 'avg', host: 'first' }, { range }),
    ),
  );
}

// 2. Control: flat numeric-only mapping (already fast path before & after).
//    Guards against a regression on the pure-numeric path.
for (const n of [100_000, 1_000_000]) {
  results.push(
    benchmark('flat {cpu:avg} (control)', n, (s, seq, range) =>
      s.aggregate(seq, { cpu: 'avg' }, { range }),
    ),
  );
}

// 3. Partitioned end-to-end (64 hosts). Each per-partition aggregate now
//    takes the fast path. NOTE: the `partitionBy` scatter tax (source.events
//    materialization + per-partition fromEvents) is NOT addressed here —
//    that's the columnar partitionBy split (next PR). This measures the
//    per-partition fast-path engagement only.
for (const n of [100_000]) {
  results.push(
    benchmark('partitionBy(host).aggregate({cpu:avg})', n, (s, seq, range) =>
      s.partitionBy('host').aggregate(seq, { cpu: 'avg' }, { range }).collect(),
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
