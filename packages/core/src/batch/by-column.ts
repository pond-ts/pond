import type { ColumnSchema, ColumnarStore } from '../columnar/index.js';
import type { AggregateBucketState } from '../reducers/types.js';
import { bucketStateFor } from '../reducers/index.js';
import type { ColumnValue } from '../schema/index.js';
import type { AggregateColumnSpec } from './aggregate-columns.js';

/**
 * Binning for {@link TimeSeries.byColumn}: even-`width` bins (optionally shifted
 * by `origin`, default 0) or explicit ascending `edges`. See
 * `docs/notes/bycolumn-value-axis.md`.
 */
export type BinSpec =
  | { width: number; origin?: number }
  | { edges: readonly number[] };

/** One value-bin's record: its `[start, end)` range plus the mapped aggregates. */
export type BinRecord = { start: number; end: number } & Record<
  string,
  ColumnValue | undefined
>;

// Guards a `width` spec from an accidental explosion (e.g. a sub-unit width over
// a huge range) that would allocate millions of empty output records.
const MAX_WIDTH_BINS = 1_000_000;

/**
 * Value-axis aggregation runtime. Buckets the store's rows by the value of
 * `binColName` and reduces each bin via `columnSpecs`, returning one
 * {@link BinRecord} per bin in ascending order. Reads straight off the columnar
 * store (no event materialization); rows whose bin value is missing / non-finite
 * (or, for `edges`, out of range) contribute to no bin. Empty bins emit each
 * reducer's empty value, like an empty `aggregate` bucket.
 */
export function computeByColumn(
  store: ColumnarStore<ColumnSchema>,
  binColName: string,
  spec: BinSpec,
  columnSpecs: ReadonlyArray<AggregateColumnSpec>,
): BinRecord[] {
  const binCol = store.columns.get(binColName);
  if (binCol === undefined) {
    throw new RangeError(`byColumn: unknown column '${binColName}'`);
  }
  if (binCol.kind !== 'number') {
    throw new TypeError(
      `byColumn: column '${binColName}' must be a number column (got '${binCol.kind}')`,
    );
  }
  const sourceCols = columnSpecs.map((s) => store.columns.get(s.source)!);
  const n = store.length;

  // Resolve the bin assignment + the [start, end) of a given bin index.
  const usesEdges = 'edges' in spec;
  let binOf: (v: number) => number;
  let rangeOf: (binIndex: number) => { start: number; end: number };

  if (usesEdges) {
    const edges = spec.edges;
    if (edges.length < 2) {
      throw new RangeError('byColumn: edges must have at least 2 entries');
    }
    for (let i = 0; i < edges.length; i += 1) {
      if (!Number.isFinite(edges[i]!)) {
        throw new RangeError(`byColumn: edges[${i}] is not finite`);
      }
      if (i > 0 && edges[i]! <= edges[i - 1]!) {
        throw new RangeError('byColumn: edges must be strictly ascending');
      }
    }
    const last = edges.length - 1;
    binOf = (v) => {
      if (v < edges[0]! || v >= edges[last]!) return NaN; // out of range → drop
      // rightmost edge <= v, clamped to a valid bin [0, last)
      let lo = 0;
      let hi = last; // bins are [0, last)
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (edges[mid]! <= v) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    rangeOf = (i) => ({ start: edges[i]!, end: edges[i + 1]! });
  } else {
    const width = spec.width;
    const origin = spec.origin ?? 0;
    if (!Number.isFinite(width) || width <= 0) {
      throw new RangeError('byColumn: width must be a positive finite number');
    }
    if (!Number.isFinite(origin)) {
      throw new RangeError('byColumn: origin must be finite');
    }
    binOf = (v) => Math.floor((v - origin) / width);
    rangeOf = (i) => ({
      start: origin + i * width,
      end: origin + (i + 1) * width,
    });
  }

  // Scatter: one bucket-state set per occupied bin index.
  const states = new Map<number, AggregateBucketState[]>();
  let minBin = Infinity;
  let maxBin = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const bv = binCol.read(i);
    if (typeof bv !== 'number' || !Number.isFinite(bv)) continue;
    const bin = binOf(bv);
    if (Number.isNaN(bin)) continue; // edges out-of-range (width bins may be negative)
    let cells = states.get(bin);
    if (cells === undefined) {
      cells = columnSpecs.map((s) => bucketStateFor(s.reducer));
      states.set(bin, cells);
    }
    for (let c = 0; c < columnSpecs.length; c += 1) {
      cells[c]!.add(sourceCols[c]!.read(i));
    }
    if (bin < minBin) minBin = bin;
    if (bin > maxBin) maxBin = bin;
  }

  // Empty-bin value per output column. A scalar reducer's empty value is an
  // immutable primitive (count → 0, avg → undefined) safe to share across every
  // empty bin; an array-kind reducer (samples / unique / top) yields a fresh
  // `[]` that must NOT be aliased between bins, so those are re-snapshotted per
  // empty bin below.
  const emptyScalar = columnSpecs.map((s) =>
    s.kind === 'array' ? undefined : bucketStateFor(s.reducer).snapshot(),
  );

  const out: BinRecord[] = [];
  const emit = (binIndex: number): void => {
    const { start, end } = rangeOf(binIndex);
    const cells = states.get(binIndex);
    const rec: BinRecord = { start, end };
    for (let c = 0; c < columnSpecs.length; c += 1) {
      const spec = columnSpecs[c]!;
      rec[spec.output] = cells
        ? cells[c]!.snapshot()
        : spec.kind === 'array'
          ? bucketStateFor(spec.reducer).snapshot() // fresh array per empty bin
          : emptyScalar[c];
    }
    out.push(rec);
  };

  if (usesEdges) {
    const binCount = spec.edges.length - 1;
    for (let b = 0; b < binCount; b += 1) emit(b);
  } else if (states.size > 0) {
    const binCount = maxBin - minBin + 1;
    if (binCount > MAX_WIDTH_BINS) {
      throw new RangeError(
        `byColumn: width produces ${binCount} bins (> ${MAX_WIDTH_BINS}); use a larger width or explicit edges`,
      );
    }
    for (let b = minBin; b <= maxBin; b += 1) emit(b);
  }
  return out;
}
