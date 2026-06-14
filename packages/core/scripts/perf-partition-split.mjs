import { performance } from 'node:perf_hooks';
import { Sequence, TimeSeries } from '../dist/index.js';

// Perf check for the columnar partitionBy split (audit v2 §3.2). The old
// `applyToSource` / `toMap` walked `source.events` to bucket, then rebuilt
// each partition via `fromEvents` (re-validating + re-packing) — silently
// re-paying the ~495 ns/row event-materialization tax the columnar wave
// removed. `partitionBy(host).fill(hold).collect()` was the measured #1
// batch hotspot at ~923 ns/row. The new path groups row indices off the
// store and gathers each partition via `withRowSelection` — no events.

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

// Fresh series per sample: the split reads the store, but `collect()` /
// `fill()` would otherwise let later samples reuse warmed lazy state. A
// fresh cold series per sample is the realistic one-shot-pipeline shape.
function benchmark(label, length, run, repeats = 7) {
  const fresh = Array.from({ length: repeats }, () => makeSeries(length));
  run(makeSeries(1_000)); // warm-up (JIT)

  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const series = fresh[i];
    const start = performance.now();
    const out = run(series);
    const end = performance.now();
    if (out.length === 0) throw new Error(`empty output for ${label}`);
    samples.push(end - start);
  }
  const med = median(samples);
  return {
    scenario: label,
    length,
    medianMs: Number(med.toFixed(3)),
    nsPerRow: Number(((med * 1e6) / length).toFixed(0)),
    minMs: Number(Math.min(...samples).toFixed(3)),
  };
}

const results = [];
for (const n of [100_000]) {
  results.push(
    benchmark('partitionBy(host).fill(hold).collect()', n, (s) =>
      s.partitionBy('host').fill({ cpu: 'hold' }).collect(),
    ),
  );
  results.push(
    benchmark('partitionBy(host).diff(cpu).collect()', n, (s) =>
      s.partitionBy('host').diff('cpu').collect(),
    ),
  );
  results.push(
    benchmark('partitionBy(host).rolling(5m,avg).collect()', n, (s) =>
      s.partitionBy('host').rolling('5m', { cpu: 'avg' }).collect(),
    ),
  );
  results.push(
    benchmark('partitionBy(host).toMap()', n, (s) =>
      // toMap returns a Map; wrap so the harness's `.length` check sees a
      // non-empty result (use the partition count).
      ({ length: s.partitionBy('host').toMap().size }),
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
