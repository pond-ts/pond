import { performance } from 'node:perf_hooks';
import { TimeSeries, ValueSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
  { name: 'vwap', kind: 'number' },
]);

function makeColumns(length, { typed, sparse = false, shuffled = false } = {}) {
  const time = new Float64Array(length);
  // `shuffled` builds a descending key so `sort: true` does a full reorder
  // (worst case for the permutation + copy); otherwise ascending (the fast path).
  for (let i = 0; i < length; i += 1) {
    time[i] = (shuffled ? length - 1 - i : i) * 1_000;
  }

  const valueNames = ['open', 'high', 'low', 'close', 'volume', 'vwap'];
  const columns = { time };
  for (const name of valueNames) {
    if (typed) {
      const col = new Float64Array(length);
      for (let i = 0; i < length; i += 1) {
        col[i] = sparse && i % 10 === 0 ? NaN : i % 100;
      }
      columns[name] = col;
    } else {
      const col = new Array(length);
      for (let i = 0; i < length; i += 1) {
        col[i] = sparse && i % 10 === 0 ? null : i % 100;
      }
      columns[name] = col;
    }
  }
  return columns;
}

const vsSchema = Object.freeze([
  { name: 'strike', kind: 'value' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
  { name: 'vwap', kind: 'number' },
]);

/** The `makeColumns` output with the key renamed `time` -> `strike`. */
function asValueColumns(columns) {
  const { time, ...rest } = columns;
  return { strike: time, ...rest };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function benchmarkValueSeries(
  name,
  columns,
  { sort = false, repeats = 7 } = {},
) {
  const vsColumns = asValueColumns(columns);
  // warmup
  ValueSeries.fromColumns({
    name: 'w',
    schema: vsSchema,
    columns: vsColumns,
    sort,
  });

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const series = ValueSeries.fromColumns({
      name,
      schema: vsSchema,
      columns: vsColumns,
      sort,
    });
    const end = performance.now();
    if (series.length !== vsColumns.strike.length) {
      throw new Error(`unexpected length for ${name}`);
    }
    samples.push(end - start);
  }

  return {
    scenario: name,
    length: vsColumns.strike.length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

function benchmark(name, columns, { sort = false, repeats = 7 } = {}) {
  // warmup
  TimeSeries.fromColumns({ name: 'w', schema, columns, sort });

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const series = TimeSeries.fromColumns({ name, schema, columns, sort });
    const end = performance.now();
    if (series.length !== columns.time.length) {
      throw new Error(`unexpected length for ${name}`);
    }
    samples.push(end - start);
  }

  return {
    scenario: name,
    length: columns.time.length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

// ── Two-edged keys ────────────────────────────────────────────────────────
// The flattened key convention: a `timeRange` / `interval` key arrives across
// extra columns named off it. Costs one more edge buffer than a point key
// (plus a label column for an interval), and — when sorting — a `(begin, end)`
// comparator instead of a bare subtraction.
const rangeSchema = Object.freeze([
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
  { name: 'vwap', kind: 'number' },
]);

const intervalSchema = Object.freeze([
  { name: 'interval', kind: 'interval' },
  ...rangeSchema.slice(1),
]);

/** `makeColumns` output re-keyed as a flattened two-edged key. */
function asTwoEdged(columns, { kind, labels }) {
  const { time, ...rest } = columns;
  const name = kind === 'interval' ? 'interval' : 'timeRange';
  const end = new Float64Array(time.length);
  for (let i = 0; i < time.length; i += 1) end[i] = time[i] + 1_000;
  const out = { [name]: time, [`${name}End`]: end, ...rest };
  if (kind === 'interval') {
    const label = new Array(time.length);
    for (let i = 0; i < time.length; i += 1) {
      label[i] = labels === 'string' ? `b${i % 512}` : time[i];
    }
    out[`${name}Label`] = label;
  }
  return out;
}

function benchmarkKeyed(
  name,
  schema,
  columns,
  { sort = false, repeats = 7 } = {},
) {
  const keyName = schema[0].name;
  TimeSeries.fromColumns({ name: 'w', schema, columns, sort });
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const series = TimeSeries.fromColumns({ name, schema, columns, sort });
    const end = performance.now();
    if (series.length !== columns[keyName].length) {
      throw new Error(`unexpected length for ${name}`);
    }
    samples.push(end - start);
  }
  return {
    scenario: name,
    length: columns[keyName].length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const LENGTH = 100_000;

const results = [
  benchmark(
    'number[] columns, dense (100k x 7 cols)',
    makeColumns(LENGTH, { typed: false }),
  ),
  benchmark(
    'number[] columns, sparse ~10% gaps (100k x 7 cols)',
    makeColumns(LENGTH, { typed: false, sparse: true }),
  ),
  benchmark(
    'Float64Array columns, dense — adopt path (100k x 7 cols)',
    makeColumns(LENGTH, { typed: true }),
  ),
  benchmark(
    'Float64Array columns, sparse ~10% gaps — adopt path (100k x 7 cols)',
    makeColumns(LENGTH, { typed: true, sparse: true }),
  ),
  benchmark(
    'number[] columns, per-element floor (1k x 7 cols)',
    makeColumns(1_000, { typed: false }),
  ),
  // sort: true — the opt-in reorder path. Descending input so the sort does a
  // full O(n log n) permutation + a per-column copy (no zero-copy adoption).
  benchmark(
    'number[] columns, sort: true, descending (100k x 7 cols)',
    makeColumns(LENGTH, { typed: false, shuffled: true }),
    { sort: true },
  ),
  benchmark(
    'Float64Array columns, sort: true, descending — copy path (100k x 7 cols)',
    makeColumns(LENGTH, { typed: true, shuffled: true }),
    { sort: true },
  ),
  // ValueSeries.fromColumns — same ingest engine behind a value-kind key;
  // pins the direct value-land door (cross-sectional construction) so a
  // regression on either door surfaces here.
  benchmarkValueSeries(
    'ValueSeries: Float64Array columns, dense — adopt path (100k x 7 cols)',
    makeColumns(LENGTH, { typed: true }),
  ),
  benchmarkValueSeries(
    'ValueSeries: number[] columns, sort: true, descending (100k x 7 cols)',
    makeColumns(LENGTH, { typed: false, shuffled: true }),
    { sort: true },
  ),
  benchmarkValueSeries(
    'ValueSeries: per-element floor (1k x 7 cols, number[])',
    makeColumns(1_000, { typed: false }),
  ),
  // Two-edged keys — one extra edge buffer over the point-key baseline above,
  // and for an interval a label column on top of that.
  benchmarkKeyed(
    'timeRange key, Float64Array edges — adopt path (100k x 7 cols)',
    rangeSchema,
    asTwoEdged(makeColumns(LENGTH, { typed: true }), { kind: 'timeRange' }),
  ),
  benchmarkKeyed(
    'interval key, numeric labels (100k x 7 cols)',
    intervalSchema,
    asTwoEdged(makeColumns(LENGTH, { typed: true }), {
      kind: 'interval',
      labels: 'number',
    }),
  ),
  benchmarkKeyed(
    'interval key, string labels — dict encode (100k x 7 cols)',
    intervalSchema,
    asTwoEdged(makeColumns(LENGTH, { typed: true }), {
      kind: 'interval',
      labels: 'string',
    }),
  ),
  benchmarkKeyed(
    'timeRange key, sort: true, descending — (begin, end) (100k x 7 cols)',
    rangeSchema,
    asTwoEdged(makeColumns(LENGTH, { typed: false, shuffled: true }), {
      kind: 'timeRange',
    }),
    { sort: true },
  ),
];

console.log(JSON.stringify(results, null, 2));
