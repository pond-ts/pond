import { performance } from 'node:perf_hooks';

// ── Perf check for building every row's Event (`series.events`) ──────────
//
// Complexity: O(N·C) for N rows and C value columns: one key, one data
// object and one Event per row. Before, each row also went through two
// per-row `Map` caches (key and event), which on 1M rows was most of the
// time and most of the garbage. Every Event-callback operator pays this on
// a series whose events were not built yet: `filter`, `map`, `toArray`, …
//
// Each run builds a fresh series from columns (not timed), so no event is
// cached. Usage: node scripts/perf-events.mjs [path/to/dist/index.js]

const { TimeSeries } = await import(process.argv[2] ?? '../dist/index.js');
const N = Number(process.env.N ?? 1_000_000);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

const time = new Float64Array(N).map((_, i) => i * 1000);
const a = new Float64Array(N).map((_, i) => i % 100);
const b = new Float64Array(N).map((_, i) => i % 7);
const host = Array.from({ length: N }, (_, i) => `h${i % 10}`);

function fresh(kind) {
  if (kind === 'interval') {
    return TimeSeries.fromColumns({
      name: 's',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'a', kind: 'number' },
      ],
      columns: {
        interval: time,
        intervalEnd: time.map((t) => t + 1000),
        intervalLabel: host,
        a,
      },
    });
  }
  return TimeSeries.fromColumns({
    name: 's',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'a', kind: 'number' },
      { name: 'b', kind: 'number' },
      { name: 'host', kind: 'string' },
    ],
    columns: { time, a, b, host },
  });
}

const cases = {
  'events, time key, 3 columns': [() => fresh('time'), (s) => s.events],
  'events, interval key': [() => fresh('interval'), (s) => s.events],
  'filter a > 50': [
    () => fresh('time'),
    (s) => s.filter((e) => e.get('a') > 50),
  ],
  'toArray then at(i) loop': [
    () => fresh('time'),
    (s) => {
      s.toArray();
      let sum = 0;
      for (let i = 0; i < s.length; i += 1) sum += s.at(i).get('a');
      return sum;
    },
  ],
};

const results = [];
for (const [name, [make, run]] of Object.entries(cases)) {
  run(make()); // warm-up
  const samples = [];
  for (let r = 0; r < 5; r += 1) {
    const s = make();
    const start = performance.now();
    run(s);
    samples.push(performance.now() - start);
  }
  results.push({ name, rows: N, medianMs: +median(samples).toFixed(0) });
}
console.log(JSON.stringify(results, null, 2));
