/**
 * `TimeSeries.toColumns` — the columnar-JSON export door.
 *
 * Same store walk `ValueSeries.toColumns` already uses (one `storeToColumns`,
 * two callers — see `scripts/perf-value-series-io.mjs` for the value-axis
 * numbers); this script is the durable benchmark for the time-key side, and
 * for the comparison that decides when a caller should reach for it.
 *
 * Analytical cost (N rows, C columns): **O(N·C) with C allocations** — one
 * array per column, no per-row object. That is the whole difference from the
 * row exports, which are also O(N·C) but mint N objects; the gap should widen
 * with N, and `toArrow` (a buffer handoff, O(C)) should be ~three orders of
 * magnitude below both. If `toColumns` ever approaches the row doors, the
 * per-row allocation has crept back in.
 *
 * Run: `node scripts/perf-to-columns.mjs` (after `npm run build`).
 */
import { performance } from 'node:perf_hooks';
import { Sequence, TimeSeries } from '../dist/index.js';

const NUMERIC = ['open', 'high', 'low', 'close', 'volume'];

const numericSchema = Object.freeze([
  { name: 'time', kind: 'time' },
  ...NUMERIC.map((name) => ({ name, kind: 'number' })),
]);

const mixedSchema = Object.freeze([
  { name: 'time', kind: 'time' },
  ...NUMERIC.map((name) => ({ name, kind: 'number' })),
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

function benchmark(scenario, length, fn, { repeats = 7 } = {}) {
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

// 100k one-second rows aggregated to 1-minute buckets — an interval key with
// numeric labels, the shape `aggregate` actually produces.
const bucketed = makeSeries(LENGTH).aggregate(Sequence.every('1m'), {
  close: 'avg',
  volume: 'sum',
});

const results = [
  benchmark('toColumns — dense numeric (100k x 6)', LENGTH, () =>
    numeric.toColumns(),
  ),
  benchmark('toColumns — with a string column (100k x 7)', LENGTH, () =>
    mixed.toColumns(),
  ),
  benchmark('toColumns — ~10% gaps (100k x 6)', LENGTH, () =>
    sparse.toColumns(),
  ),
  benchmark('toColumns — wide (10k x 41)', 10_000, () => wide.toColumns()),
  benchmark('toColumns — per-element floor (1k x 6)', FLOOR, () =>
    floor.toColumns(),
  ),
  // A two-edged key flattens into extra columns, so it walks one more edge
  // buffer plus the label column. Note the row count: aggregating 100k
  // one-second rows to 1-minute buckets leaves ~1.7k rows, so this is a
  // per-row cost comparison against the 1k floor above, NOT against the 100k
  // rows.
  benchmark(
    `toColumns — interval key, flattened (${bucketed.length} x 3)`,
    bucketed.length,
    () => bucketed.toColumns(),
  ),

  // The comparison that motivates the door: same data, three export shapes.
  benchmark('   vs toJSON — tuple rows (100k x 6)', LENGTH, () =>
    numeric.toJSON(),
  ),
  benchmark('   vs toJSON — object rows (100k x 6)', LENGTH, () =>
    numeric.toJSON({ rowFormat: 'object' }),
  ),
  benchmark('   vs toArrow — buffer handoff (100k x 6)', LENGTH, () =>
    numeric.toArrow(),
  ),
];

console.log(JSON.stringify(results, null, 2));
