// Benchmark for array-column operators ([PND-ARRAYSLOW]): `arrayAggregate`,
// `arrayExplode`, and two paths that build array columns (`aggregate` with
// an array result, `filter` gathering an array column). Prints one JSON
// line per case. `DIST=/path/to/dist/index.js` benchmarks another build;
// `ONLY=substr` runs the matching cases.
import { performance } from 'node:perf_hooks';

const dist = process.env.DIST ?? '../dist/index.js';
const { Sequence, TimeSeries } = await import(dist);
const only = process.env.ONLY ?? null;
const repeats = Number(process.env.REPEATS ?? 7);
const warmups = Number(process.env.WARMUPS ?? 5);
const N = Number(process.env.N ?? 100_000);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'tags', kind: 'array', required: false },
  { name: 'nums', kind: 'array', required: false },
  { name: 'v', kind: 'number' },
]);
const TAGS = ['web', 'db', 'cache', 'east', 'west', 'canary'];
const series = new TimeSeries({
  name: 's',
  schema,
  rows: Array.from({ length: N }, (_, i) => [
    i * 1_000,
    i % 11 === 0
      ? undefined
      : Array.from({ length: i % 6 }, (_, j) => TAGS[(i + j) % 6]),
    Array.from({ length: (i % 8) + 1 }, (_, j) => ((i * 31 + j * 7) % 97) / 4),
    i,
  ]),
});

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function benchmark(name, run) {
  if (only && !name.includes(only)) return;
  for (let i = 0; i < warmups; i += 1) run();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  console.log(
    JSON.stringify({
      name,
      medianMs: Number(median(samples).toFixed(2)),
      minMs: Number(Math.min(...samples).toFixed(2)),
      maxMs: Number(Math.max(...samples).toFixed(2)),
    }),
  );
}

for (const red of ['count', 'avg', 'median', 'unique']) {
  benchmark(`arrayAggregate nums ${red}`, () =>
    series.arrayAggregate('nums', red, { as: 'out' }),
  );
}
benchmark('arrayAggregate nums first', () =>
  series.arrayAggregate('nums', 'first', { as: 'out', kind: 'number' }),
);
benchmark('arrayAggregate tags count', () =>
  series.arrayAggregate('tags', 'count'),
);
benchmark('arrayExplode tags', () => series.arrayExplode('tags'));
benchmark('arrayExplode nums', () =>
  series.arrayExplode('nums', { kind: 'number' }),
);
benchmark('arrayExplode tags keep array', () =>
  series.arrayExplode('tags', { as: 'tag' }),
);
benchmark('aggregate 1s unique (array out)', () =>
  series.aggregate(Sequence.every('1s'), {
    u: { from: 'v', using: 'unique' },
  }),
);
benchmark('filter half (array gather)', () =>
  series.filter((e) => e.get('v') % 2 === 0),
);
