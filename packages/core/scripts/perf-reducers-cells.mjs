// Benchmark for the reducers without a numeric column kernel — `keep`,
// `difference`, `unique`, `top3`, `samples` — on a number column and a text
// column: whole-series `reduce`, and `aggregate` with ~1 row per bucket (1s)
// and 60 rows per bucket (1m). Prints one JSON line per case as it finishes.
// `DIST=/path/to/dist/index.js` benchmarks another build; `ONLY=substr`
// runs the cases whose name contains it.
import { performance } from 'node:perf_hooks';

const dist = process.env.DIST ?? '../dist/index.js';
const { Sequence, TimeSeries } = await import(dist);
const only = process.env.ONLY ?? null;
const repeats = Number(process.env.REPEATS ?? 7);
const warmups = Number(process.env.WARMUPS ?? 5);
const N = Number(process.env.N ?? 1_000_000);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
]);

// Repeating values (100 distinct) with a gap every 17th row; 4 hosts.
const series = new TimeSeries({
  name: 's',
  schema,
  rows: Array.from({ length: N }, (_, i) => [
    i * 1_000,
    i % 17 === 0 ? undefined : (i * 7919) % 100,
    i % 23 === 0 ? undefined : `host-${i % 4}`,
  ]),
});
// Same, but every value differs (hash-heavy control for unique / top).
const distinct = new TimeSeries({
  name: 'd',
  schema,
  rows: Array.from({ length: N }, (_, i) => [
    i * 1_000,
    i % 17 === 0 ? undefined : i * 0.5,
    `host-${i}`,
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

const cases = [
  ['v', 'keep'],
  ['v', 'difference'],
  ['v', 'unique'],
  ['v', 'top3'],
  ['v', 'samples'],
  ['host', 'keep'],
  ['host', 'unique'],
  ['host', 'top3'],
  ['host', 'samples'],
];

for (const [col, red] of cases) {
  benchmark(`reduce ${col} ${red}`, () => series.reduce(col, red));
}
for (const [col, red] of cases) {
  if (red === 'keep' || red === 'samples') continue;
  benchmark(`reduce distinct ${col} ${red}`, () => distinct.reduce(col, red));
}
for (const step of ['1m', '1s']) {
  for (const [col, red] of cases) {
    benchmark(`aggregate ${step} ${col} ${red}`, () =>
      series.aggregate(Sequence.every(step), {
        out: { from: col, using: red },
      }),
    );
  }
}
