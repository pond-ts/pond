import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

// ── Perf check for TimeSeries.fromArrow ───────────────────────────────────
//
// Complexity: O(N) to recombine the int64 time column + O(N·C) to adopt/convert
// C value columns. The load-bearing claim is that the time column converts
// BigInt-free (two-int32 recombination) rather than `Number(bigint)` ×N — the
// ~30ms/500k-row cost the fromArrow ingest note called out. This script pins
// both the real path and a naive `Number(bigint)` baseline for the same column
// so the reclaim is measured, not asserted.
//
// pond doesn't depend on apache-arrow, so we hand fromArrow a structural
// stand-in for a decoded Table (the same shape a real `tableFromIPC` Table
// presents to the duck-typed reader).

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

const VALUE_NAMES = ['open', 'high', 'low', 'close', 'volume', 'vwap'];

/** Build a structural Arrow Table: int64 (ms) time + C Float64 value columns. */
function makeTable(length, { sparse = false } = {}) {
  const base = 1_700_000_000_000n;
  const time = new BigInt64Array(length);
  for (let i = 0; i < length; i += 1) time[i] = base + BigInt(i * 1000);

  const vectors = new Map();
  vectors.set('time', {
    length,
    nullCount: 0,
    toArray: () => time,
    get: (i) => time[i],
  });
  for (const name of VALUE_NAMES) {
    const col = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      col[i] = sparse && i % 10 === 0 ? NaN : i % 100;
    }
    vectors.set(name, {
      length,
      nullCount: 0,
      toArray: () => col,
      get: (i) => col[i],
    });
  }

  const fields = [{ name: 'time', type: { unit: 1 } }];
  for (const name of VALUE_NAMES) fields.push({ name, type: {} });

  return {
    numRows: length,
    schema: { fields },
    getChild: (name) => vectors.get(name) ?? null,
  };
}

function benchmark(name, table, { repeats = 7 } = {}) {
  TimeSeries.fromArrow(table); // warmup

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const series = TimeSeries.fromArrow(table);
    const end = performance.now();
    if (series.length !== table.numRows) {
      throw new Error(`unexpected length for ${name}`);
    }
    samples.push(end - start);
  }
  return {
    scenario: name,
    length: table.numRows,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

// Baseline: the cost fromArrow avoids — `Number(bigint)` per row for the time
// column. Same length, isolated so the delta is the BigInt-free reclaim.
function benchmarkBigIntBaseline(length, { repeats = 7 } = {}) {
  const base = 1_700_000_000_000n;
  const time = new BigInt64Array(length);
  for (let i = 0; i < length; i += 1) time[i] = base + BigInt(i * 1000);

  const convert = () => {
    const out = new Float64Array(length);
    for (let i = 0; i < length; i += 1) out[i] = Number(time[i]);
    return out;
  };
  convert(); // warmup

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const out = convert();
    const end = performance.now();
    if (out.length !== length) throw new Error('unexpected length');
    samples.push(end - start);
  }
  return {
    scenario: `time-only baseline: Number(bigint) ×N (${length})`,
    length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

// Reference: the BigInt-free recombination in isolation, so the delta vs the
// baseline above is attributable to the two-int32 trick alone.
function benchmarkBigIntFree(length, { repeats = 7 } = {}) {
  const base = 1_700_000_000_000n;
  const time = new BigInt64Array(length);
  for (let i = 0; i < length; i += 1) time[i] = base + BigInt(i * 1000);

  const convert = () => {
    const out = new Float64Array(length);
    const halves = new Int32Array(time.buffer, time.byteOffset, length * 2);
    for (let i = 0; i < length; i += 1) {
      const lo = halves[i * 2] >>> 0;
      const hi = halves[i * 2 + 1];
      out[i] = hi * 4294967296 + lo;
    }
    return out;
  };
  convert(); // warmup

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const out = convert();
    const end = performance.now();
    if (out.length !== length) throw new Error('unexpected length');
    samples.push(end - start);
  }
  return {
    scenario: `time-only reference: BigInt-free two-int32 (${length})`,
    length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const LENGTH = 500_000;

const results = [
  benchmark(
    'fromArrow: int64 time + 6 Float64 cols, dense (500k)',
    makeTable(LENGTH),
  ),
  benchmark(
    'fromArrow: int64 time + 6 Float64 cols, sparse ~10% (500k)',
    makeTable(LENGTH, { sparse: true }),
  ),
  benchmark('fromArrow: per-element floor (1k)', makeTable(1_000)),
  benchmarkBigIntBaseline(LENGTH),
  benchmarkBigIntFree(LENGTH),
];

console.log(JSON.stringify(results, null, 2));
