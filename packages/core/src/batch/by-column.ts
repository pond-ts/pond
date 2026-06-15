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
  // `start` / `end` carry the bin range in every record, so a mapping output
  // can't claim them (it would silently overwrite the range).
  for (const s of columnSpecs) {
    if (s.output === 'start' || s.output === 'end') {
      throw new RangeError(
        `byColumn: output name '${s.output}' is reserved for the bin range`,
      );
    }
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
    binOf = (v) => {
      let bin = Math.floor((v - origin) / width);
      // `floor((v−origin)/width)` (division) and the emitted boundary
      // `origin + i*width` (multiplication) round independently, so for
      // fractional widths a value can land just outside its floored bin's
      // `[start, end)` (e.g. width 0.1, v = −3*0.1 → bin −4 whose end *is* v).
      // Nudge the bin so `v ∈ [origin + bin*width, origin + (bin+1)*width)` —
      // a ≤1-step correction for normal inputs. The counter caps the loop so a
      // collapsed range (origin/width beyond float precision) can't spin; emit's
      // representability check then rejects that bin.
      let guard = 0;
      while (v < origin + bin * width && guard++ < 4) bin -= 1;
      while (v >= origin + (bin + 1) * width && guard++ < 4) bin += 1;
      return bin;
    };
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

  const out: BinRecord[] = [];
  const emit = (binIndex: number): void => {
    const { start, end } = rangeOf(binIndex);
    // Every emitted bin must be a representable half-open `[start, end)`. A safe
    // bin INDEX doesn't guarantee representable BOUNDARIES: at extreme
    // magnitudes `origin + i*width` can collapse (`start === end`, e.g.
    // origin 1e20 + width 1) or overflow (`end === Infinity`, e.g. width 1e308).
    // (Edges are pre-validated finite + strictly ascending, so this only ever
    // fires on a pathological width/origin.)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new RangeError(
        `byColumn: bin [${start}, ${end}) is not a representable range — the origin/width magnitude exceeds float precision; use a larger width or explicit edges`,
      );
    }
    const cells = states.get(binIndex);
    const rec: BinRecord = { start, end };
    for (let c = 0; c < columnSpecs.length; c += 1) {
      // Occupied bin → that bin's own accumulated snapshot. Empty bin → a FRESH
      // empty snapshot per bin (not a cached/shared value): array-kind reducers
      // would otherwise alias one `[]` across bins, and a custom reducer's empty
      // is `fn([])` which `aggregate` evaluates per empty bucket — match that.
      rec[columnSpecs[c]!.output] = cells
        ? cells[c]!.snapshot()
        : bucketStateFor(columnSpecs[c]!.reducer).snapshot();
    }
    out.push(rec);
  };

  if (usesEdges) {
    const binCount = spec.edges.length - 1;
    for (let b = 0; b < binCount; b += 1) emit(b);
  } else if (states.size > 0) {
    // A finite-but-huge value can floor to a bin index past the safe-integer
    // range (or to ±Infinity on overflow); the emit loop's `b += 1` would then
    // never advance. Reject it rather than spin.
    if (!Number.isSafeInteger(minBin) || !Number.isSafeInteger(maxBin)) {
      throw new RangeError(
        'byColumn: the data range and width produce a bin index outside the safe integer range; use a larger width',
      );
    }
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
