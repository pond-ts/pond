import { performance } from 'node:perf_hooks';
import {
  Dictionary,
  Int32,
  Table,
  Utf8,
  makeVector,
  vectorFromArray,
} from 'apache-arrow';

// ── Perf check for fromArrow on text columns [PND-ARROWTEXT] ──────────────
//
// Complexity: O(N + bytes) per Utf8 column — one hash over each row's bytes,
// one decode per distinct value (D decodes), then the column build. A
// Dictionary<Utf8> column is O(N + dictionary). The old path decoded every
// row through apache-arrow's `toArray()` (N TextDecoder calls) and then
// hashed the N strings again to dictionary-encode them.
//
// Scenarios (1M rows, a Float64 time column plus one text column):
//   low-card     100 distinct labels ("host-17")
//   high-card    every row distinct ("id-123456")
//   nulls        low-card, 10% null rows
//   non-ascii    100 distinct labels with accents / CJK
//   dictionary   Dictionary<Utf8, Int32> with 100 entries
//   reorder      low-card with ordering: 'reorder' (strings handed back)
//   value-series ValueSeries.fromArrow, low-card
//
// Usage: node scripts/perf-arrow-text.mjs [path/to/dist/index.js]

const lib = await import(process.argv[2] ?? '../dist/index.js');
const { TimeSeries, ValueSeries } = lib;
const N = Number(process.env.N ?? 1_000_000);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function time(n, reverse = false) {
  const t = new Float64Array(n);
  for (let i = 0; i < n; i += 1) t[i] = reverse ? (n - i) * 1000 : i * 1000;
  return makeVector(t);
}

function table(text, { reverse = false, key = 'time' } = {}) {
  return new Table({ [key]: time(text.length, reverse), s: text });
}

const LABELS = Array.from({ length: 100 }, (_, i) => `host-${i}`);
const ACCENTS = Array.from({ length: 100 }, (_, i) => `café-日本-${i}`);

const scenarios = {
  'low-card': () =>
    table(
      vectorFromArray(
        Array.from({ length: N }, (_, i) => LABELS[i % 100]),
        new Utf8(),
      ),
    ),
  'high-card': () =>
    table(
      vectorFromArray(
        Array.from({ length: N }, (_, i) => `id-${i}`),
        new Utf8(),
      ),
    ),
  nulls: () =>
    table(
      vectorFromArray(
        Array.from({ length: N }, (_, i) =>
          i % 10 === 0 ? null : LABELS[i % 100],
        ),
        new Utf8(),
      ),
    ),
  'non-ascii': () =>
    table(
      vectorFromArray(
        Array.from({ length: N }, (_, i) => ACCENTS[i % 100]),
        new Utf8(),
      ),
    ),
  dictionary: () =>
    table(
      vectorFromArray(
        Array.from({ length: N }, (_, i) => LABELS[i % 100]),
        new Dictionary(new Utf8(), new Int32()),
      ),
    ),
  reorder: () =>
    table(
      vectorFromArray(
        Array.from({ length: N }, (_, i) => LABELS[i % 100]),
        new Utf8(),
      ),
      {
        reverse: true,
      },
    ),
  'value-series': () =>
    table(
      vectorFromArray(
        Array.from({ length: N }, (_, i) => LABELS[i % 100]),
        new Utf8(),
      ),
      {
        key: 'axis',
      },
    ),
};

function read(name, t) {
  if (name === 'value-series')
    return ValueSeries.fromArrow(t, { axis: 'axis' });
  if (name === 'reorder')
    return TimeSeries.fromArrow(t, { ordering: 'reorder' });
  return TimeSeries.fromArrow(t);
}

const results = [];
for (const [name, build] of Object.entries(scenarios)) {
  const t = build();
  read(name, t); // warm-up
  const samples = [];
  for (let run = 0; run < 7; run += 1) {
    const start = performance.now();
    const out = read(name, t);
    samples.push(performance.now() - start);
    if (out.length !== N) throw new Error(`${name}: wrong length`);
  }
  results.push({
    scenario: name,
    rows: N,
    medianMs: +median(samples).toFixed(1),
  });
}
console.log(JSON.stringify(results, null, 2));
