/**
 * `TimeSeries.toJSON` — the row-JSON export door, both row formats.
 *
 * Analytical cost (N rows, C columns): **O(N·C)** with one row allocation per
 * event (array or object) plus the event/data materialisation the row walk
 * already pays. The tuple path used to allocate a second, throwaway array per
 * row (`dataColumns.map(...)`) and spread it into the first; it now writes
 * cells by index into one pre-sized array, so tuple rows should cost no more
 * than object rows. If tuple rows drift back above object rows, a per-row
 * intermediate has crept back in.
 *
 * Run: `node scripts/perf-to-json.mjs` (after `npm run build`).
 */
import { performance } from 'node:perf_hooks';
import { Sequence, TimeSeries } from '../dist/index.js';

const NUMERIC = ['open', 'high', 'low', 'close', 'volume'];

const numericSchema = Object.freeze([
  { name: 'time', kind: 'time' },
  ...NUMERIC.map((name) => ({ name, kind: 'number' })),
]);

const mixedSchema = Object.freeze([
  ...numericSchema,
  { name: 'symbol', kind: 'string' },
]);

const sparseSchema = Object.freeze([
  numericSchema[0],
  ...numericSchema.slice(1).map((c) => ({ ...c, required: false })),
]);

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN'];

function makeSeries(length, { strings = false, sparse = false } = {}) {
  const schema = strings ? mixedSchema : sparse ? sparseSchema : numericSchema;
  const rows = new Array(length);
  for (let i = 0; i < length; i += 1) {
    const row = [i * 1_000];
    for (let c = 0; c < NUMERIC.length; c += 1) {
      row.push(sparse && i % 10 === 0 ? undefined : (i % 100) / 7);
    }
    if (strings) row.push(SYMBOLS[i % SYMBOLS.length]);
    rows[i] = row;
  }
  return new TimeSeries({ name: 'bench', schema, rows });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function benchmark(scenario, length, fn, { repeats = 9 } = {}) {
  fn(); // warmup
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    if (result == null) throw new Error(`no result for ${scenario}`);
    samples.push(end - start);
  }
  return {
    scenario,
    length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const LENGTH = 100_000;
const FLOOR = 1_000;

const numeric = makeSeries(LENGTH);
const mixed = makeSeries(LENGTH, { strings: true });
const sparse = makeSeries(LENGTH, { sparse: true });
const floor = makeSeries(FLOOR);
const wide = new TimeSeries({
  name: 'wide',
  schema: Object.freeze([
    { name: 'time', kind: 'time' },
    ...Array.from({ length: 40 }, (_, i) => ({
      name: `c${i}`,
      kind: 'number',
    })),
  ]),
  rows: Array.from({ length: 10_000 }, (_, i) => [
    i * 1_000,
    ...Array.from({ length: 40 }, (_, c) => (i + c) % 97),
  ]),
});
const bucketed = makeSeries(LENGTH).aggregate(Sequence.every('1m'), {
  close: 'avg',
  volume: 'sum',
});

// Events lazy-materialise on first access; touch them once so every scenario
// measures the serialisation, not the first-walk Event construction.
for (const s of [numeric, mixed, sparse, floor, wide, bucketed]) void s.events;

const cases = [
  ['dense numeric (100k x 6)', LENGTH, numeric],
  ['with a string column (100k x 7)', LENGTH, mixed],
  ['~10% gaps (100k x 6)', LENGTH, sparse],
  ['wide (10k x 41)', 10_000, wide],
  ['per-element floor (1k x 6)', FLOOR, floor],
  [`interval key (${bucketed.length} x 3)`, bucketed.length, bucketed],
];

// Optional substring filter: `node scripts/perf-to-json.mjs dense` runs one
// scenario in a fresh process (less GC carry-over between scenarios).
const filter = process.argv[2];
const results = [];
for (const [label, length, series] of cases) {
  if (filter && !label.includes(filter)) continue;
  results.push(
    benchmark(`toJSON tuple  — ${label}`, length, () => series.toJSON()),
    benchmark(`toJSON object — ${label}`, length, () =>
      series.toJSON({ rowFormat: 'object' }),
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
