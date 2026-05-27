/**
 * Public column-API method augmentation.
 *
 * Phase 4.7 step 8b. The substrate classes in
 * `packages/core/src/columnar/` are pure — they have no
 * dependency on `reducers/`, `core/`, or any higher-level pond-ts
 * concept (the `series-store` substrate-purity test enforces
 * this). This file lives _outside_ the `columnar/` subdirectory
 * precisely so it can compose substrate primitives + reducers to
 * mount the public column-API method surface documented in
 * `docs/rfcs/column-api.md` §7.3.
 *
 * Pattern: declaration-merge interface members onto the per-kind
 * column classes, then assign the runtime implementations to each
 * class's `.prototype`. The `pond-ts` top-level barrel
 * (`src/index.ts`) imports this module for the side effect; the
 * methods are then available on any instance returned by
 * `series.column('x')` / `series.keyColumn()`.
 *
 * **Why prototype assignment and not class inheritance?** The
 * substrate classes are constructed all over pond-ts (intake
 * paths, view operations, reducer fast paths, ring buffers, etc.).
 * If we made `PublicFloat64Column extends Float64Column` and tried
 * to swap that in everywhere, we'd churn the entire substrate.
 * Augmenting the existing class in-place — runtime _and_ at the
 * type level — keeps the substrate untouched and ships the
 * methods on every existing construction site.
 */

import {
  ArrayColumn,
  BooleanColumn,
  ChunkedArrayColumn,
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
  Float64Column,
  IntervalKeyColumn,
  StringColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  materializeChunkedArray,
  materializeChunkedBoolean,
  materializeChunkedFloat64,
  materializeChunkedString,
} from './columnar/index.js';
import type { ScalarValue } from './columnar/index.js';
import { resolveReducer } from './reducers/index.js';
import { percentileReducer } from './reducers/percentile.js';
import type { SeriesSchema } from './schema/series.js';

/**
 * Public column type for a given declared schema kind. Used by the
 * schema-narrowed `TimeSeries.column(name)` signature (RFC §7.2)
 * so `series.column('value')` is typed as `Float64Column |
 * ChunkedFloat64Column`, `series.column('host')` as
 * `StringColumn | ChunkedStringColumn`, etc.
 *
 * Both packed and chunked variants carry the full public method
 * surface (per the augmentations below). Chunked methods delegate
 * to `materialize().method()` for v1 — correct, but ~2× the cost
 * of the packed-native path. A future PR may add chunked-native
 * implementations for the hot reductions; the v1 contract holds
 * either way.
 *
 * Why include chunked in the narrow return rather than packing-
 * only? An earlier draft narrowed to packed-only and pushed
 * chunked callers to the wide `column(name: string)` overload,
 * but L2 review on PR #155 flagged this as a runtime type-safety
 * hole: `concatSorted` and other substrate paths can produce
 * chunked columns at runtime where the type system would say
 * packed. Better to widen the type and pay the
 * materialize-per-method cost on the rare chunked path than to
 * lie at the type level about what `column(name)` can return.
 */
export type PublicColumnForKind<
  K extends 'number' | 'boolean' | 'string' | 'array',
> = K extends 'number'
  ? Float64Column | ChunkedFloat64Column
  : K extends 'boolean'
    ? BooleanColumn | ChunkedBooleanColumn
    : K extends 'string'
      ? StringColumn | ChunkedStringColumn
      : K extends 'array'
        ? ArrayColumn | ChunkedArrayColumn
        : never;

/**
 * Reducer-name string accepted by `Float64Column.bin(W,
 * reducer)`. Built-in scalar reducers (`'min'`, `'max'`, `'sum'`,
 * `'mean'`, `'stdev'`, `'median'`, `'count'`) produce one number per
 * bin. The percentile family is reached via the `'p${q}'`
 * convention (e.g. `'p95'`, `'p99.9'`) where `q` is in `[0, 100]` —
 * runtime check enforces the range. The fused `'minMax'` is special:
 * it returns a two-channel `{ lo, hi }` rather than a single
 * `Float64Array`.
 */
export type BinReducerName =
  | 'min'
  | 'max'
  | 'sum'
  | 'mean'
  | 'stdev'
  | 'median'
  | 'count'
  | `p${number}`
  | 'minMax';

/**
 * Output type for `Float64Column.bin(W, reducer)`. Narrows
 * on the reducer name so consumers don't need a runtime cast:
 *
 * - Scalar reducers (min/max/sum/mean/stdev/median/count/p${q})
 *   produce `Float64Array(W)` — one number per bin. Empty bins
 *   land as `NaN` (or `0` for `'count'` and `'sum'`, where empty
 *   has a well-defined mathematical value).
 * - `'minMax'` produces `{ lo: Float64Array(W); hi: Float64Array(W) }`
 *   — stride-1 access per channel matches the canvas-2D inner draw
 *   loop's per-pixel `lo[px]` / `hi[px]` reads. Empty bins on both
 *   channels are `NaN`.
 *
 * Generalized for future multi-point reducers (e.g. LTTB) — those
 * would land as their own output shape (e.g. `{ keys, values }`
 * with W output points). The shape per reducer is the contract.
 */
export type BinOutput<R extends BinReducerName> = R extends 'minMax'
  ? { lo: Float64Array; hi: Float64Array }
  : Float64Array;

/**
 * Public key-column class for a single first-column kind.
 * Distributes over its naked type parameter, so a broad union
 * like `'time' | 'timeRange' | 'interval'` produces the matching
 * union of key-column classes rather than collapsing to `never`.
 */
export type KeyColumnForKind<K extends 'time' | 'timeRange' | 'interval'> =
  K extends 'time'
    ? TimeKeyColumn
    : K extends 'timeRange'
      ? TimeRangeKeyColumn
      : K extends 'interval'
        ? IntervalKeyColumn
        : never;

/**
 * Public column type for a schema's key column, narrowed by the
 * first-column kind. Mirrors `PublicColumnForKind` on the value
 * side. Used by the schema-narrowed `TimeSeries.keyColumn()`
 * signature (RFC §7.5) so a `time`-keyed series returns
 * `TimeKeyColumn`, an `interval`-keyed series returns
 * `IntervalKeyColumn`, etc., without a cast at the consumer site.
 *
 * Implemented in two steps so the inner conditional distributes
 * over the kind union — `S[0]['kind']` is a union for a broad
 * `S` like `SeriesSchema`, and a non-naked conditional check
 * would collapse to `never` rather than producing the matching
 * key-column union. The `KeyColumnForKind<K>` helper takes `K` as
 * a naked type parameter so distribution applies; a
 * `TimeSeries<SeriesSchema>.keyColumn()` then types as
 * `TimeKeyColumn | TimeRangeKeyColumn | IntervalKeyColumn` as
 * expected. Closes Codex finding on PR #159.
 *
 * Why a single concrete class per kind (no chunked variant)? Key
 * columns are never chunked in the substrate — `ColumnarStore`'s
 * key column is the single source of truth for row ordering, and
 * chunked storage shows up only on the value side (typically post-
 * `concatSorted`). If chunked keys ever land they'll widen this
 * type the same way `PublicColumnForKind` widens for values.
 */
export type KeyColumnForSchema<S extends SeriesSchema> = KeyColumnForKind<
  S[0]['kind']
>;

/**
 * Shape returned by `TimeRangeKeyColumn.at(i)` — a POJO with both
 * endpoints. POJO (not a class instance) keeps the column-API in
 * the substrate idiom of raw values; consumers that want the
 * `TimeRange` wrapper can reach it via the row-API path
 * (`series.events[i].key`). The `readonly` modifiers are compile-
 * time only — the returned object is not `Object.freeze`'d at
 * runtime. Treat as read-only by convention (same discipline as
 * the substrate's typed-array `.values` / `.begin` / `.end`).
 */
export type TimeRangeKeyAt = {
  readonly begin: number;
  readonly end: number;
};

/**
 * Shape returned by `IntervalKeyColumn.at(i)` — the begin / end
 * timestamps plus the row's label (discriminated by `labelKind` on
 * the column). Numeric labels are finite; string labels come from
 * the dictionary-encoded label column. Same read-only-by-convention
 * note as `TimeRangeKeyAt` — `readonly` is compile-time only.
 */
export type IntervalKeyAt = {
  readonly begin: number;
  readonly end: number;
  readonly label: string | number;
};

// ─── Type-level augmentations ────────────────────────────────────
//
// `declare module` adds members to each class's interface. The
// runtime members are mounted via prototype assignment below.

declare module './columnar/column.js' {
  interface Float64Column {
    // Public alias for `read(i)` matching the Array.at() /
    // TypedArray.at() JS convention.
    at(i: number): number | undefined;

    // Public alias for `sliceByRange(start, end)` matching the
    // data-frame idiom. Zero-copy view; O(1) length.
    slice(start: number, end: number): Float64Column;

    // Scalar reductions. See `docs/rfcs/column-api.md` §7.3.
    min(): number | undefined;
    max(): number | undefined;
    sum(): number;
    mean(): number | undefined;
    stdev(): number | undefined;
    median(): number | undefined;
    percentile(q: number): number | undefined;

    /**
     * Count of **defined cells** (validity-bitmap-aware). NOT the
     * event count — diverges from `series.length` when the column
     * has any undefined cells. For an all-defined column equals
     * `col.length`. Matches the data-frame `count` idiom (Polars /
     * Pandas / numpy all use `count` for non-null counting on a
     * column).
     */
    count(): number;
    minMax(): [number, number] | undefined;

    // Value-vector predicates.
    hasMissing(): boolean;
    nullCount(): number;

    // Position-indexed.
    first(): number | undefined;
    last(): number | undefined;
    firstDefined(): number | undefined;
    lastDefined(): number | undefined;

    /**
     * Index-bucketed reduction. See `docs/rfcs/column-api.md` §7.3
     * and §8 worked example.
     *
     * The optional `options.out` lets callers supply a pre-
     * allocated output buffer matching the reducer's `BinOutput<R>`
     * shape — `Float64Array(bins)` for scalar reducers,
     * `{ lo: Float64Array(bins); hi: Float64Array(bins) }` for
     * `'minMax'`. When provided, `bin` writes into it instead of
     * allocating a fresh buffer; the returned object is the
     * `out` itself (same reference). Lengths must match `bins`
     * exactly — mismatch throws `RangeError`.
     *
     * Constraints on `out` for `'minMax'`: `lo` and `hi` must be
     * **distinct** `Float64Array`s. Passing the same reference for
     * both throws `TypeError` (the loop's `lo[b]=` / `hi[b]=`
     * writes would otherwise alias and silently produce
     * `[max, max, ...]` output).
     *
     * Resizable / shared array buffers: `bin` captures length at
     * call time. Mid-call resize / detach is undefined behavior;
     * keep the buffer stable for the duration of the call.
     *
     * The motivating use case is a chart adapter's per-frame
     * pixel-bin loop. Without `out`, each frame allocates two
     * `Float64Array(W)` for `'minMax'` (or one for scalar
     * reducers); at 60 fps with multiple columns this is real
     * allocation churn — the chart-experiment M2 milestone
     * measured ~2× cost vs a fused / pre-allocated walk
     * ([friction note](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/friction-notes/M2-multi-column-overlay.md)).
     * Reusing a buffer across frames retires that churn.
     */
    bin<R extends BinReducerName>(
      bins: number,
      reducer: R,
      options?: { out: BinOutput<R> },
    ): BinOutput<R>;
  }

  interface BooleanColumn {
    at(i: number): boolean | undefined;
    slice(start: number, end: number): BooleanColumn;
    all(): boolean;
    any(): boolean;
    none(): boolean;
    count(): number;
    hasMissing(): boolean;
    nullCount(): number;
    first(): boolean | undefined;
    last(): boolean | undefined;
    firstDefined(): boolean | undefined;
    lastDefined(): boolean | undefined;
  }
}

declare module './columnar/string-column.js' {
  interface StringColumn {
    at(i: number): string | undefined;
    slice(start: number, end: number): StringColumn;
    uniqueCount(): number;
    hasMissing(): boolean;
    nullCount(): number;
    first(): string | undefined;
    last(): string | undefined;
    firstDefined(): string | undefined;
    lastDefined(): string | undefined;
  }
}

declare module './columnar/array-column.js' {
  interface ArrayColumn {
    at(i: number): ReadonlyArray<ScalarValue> | undefined;
    slice(start: number, end: number): ArrayColumn;
    hasMissing(): boolean;
    nullCount(): number;
    first(): ReadonlyArray<ScalarValue> | undefined;
    last(): ReadonlyArray<ScalarValue> | undefined;
    firstDefined(): ReadonlyArray<ScalarValue> | undefined;
    lastDefined(): ReadonlyArray<ScalarValue> | undefined;
  }
}

// ─── Chunked variants — same public surface, materialize-backed ───
//
// Each chunked class delegates reductions to its `materialize*()`
// helper, then dispatches the method on the packed result. This is
// ~2× the cost of the packed-native path but is correct without
// chunked-native algorithm work. A future PR can replace the
// delegations with chunked-native implementations for the hot
// reductions (`min`/`max` decompose per-chunk; `sum` decomposes;
// `stdev` doesn't in general — see §B of the column-api RFC's V3
// amendment for the friction-driven sequencing).
//
// `slice` uses the chunked-native `sliceByRange` which preserves
// chunked storage where possible. `at(i)` uses the chunked `read(i)`
// which is already O(log chunks) via the offset binary search.

declare module './columnar/chunked-column.js' {
  interface ChunkedFloat64Column {
    at(i: number): number | undefined;
    slice(start: number, end: number): Float64Column | ChunkedFloat64Column;
    min(): number | undefined;
    max(): number | undefined;
    sum(): number;
    mean(): number | undefined;
    stdev(): number | undefined;
    median(): number | undefined;
    percentile(q: number): number | undefined;
    count(): number;
    minMax(): [number, number] | undefined;
    hasMissing(): boolean;
    nullCount(): number;
    first(): number | undefined;
    last(): number | undefined;
    firstDefined(): number | undefined;
    lastDefined(): number | undefined;
    bin<R extends BinReducerName>(
      bins: number,
      reducer: R,
      options?: { out: BinOutput<R> },
    ): BinOutput<R>;
  }

  interface ChunkedBooleanColumn {
    at(i: number): boolean | undefined;
    slice(start: number, end: number): BooleanColumn | ChunkedBooleanColumn;
    all(): boolean;
    any(): boolean;
    none(): boolean;
    count(): number;
    hasMissing(): boolean;
    nullCount(): number;
    first(): boolean | undefined;
    last(): boolean | undefined;
    firstDefined(): boolean | undefined;
    lastDefined(): boolean | undefined;
  }

  interface ChunkedStringColumn {
    at(i: number): string | undefined;
    slice(start: number, end: number): StringColumn | ChunkedStringColumn;
    uniqueCount(): number;
    hasMissing(): boolean;
    nullCount(): number;
    first(): string | undefined;
    last(): string | undefined;
    firstDefined(): string | undefined;
    lastDefined(): string | undefined;
  }

  interface ChunkedArrayColumn {
    at(i: number): ReadonlyArray<ScalarValue> | undefined;
    slice(start: number, end: number): ArrayColumn | ChunkedArrayColumn;
    hasMissing(): boolean;
    nullCount(): number;
    first(): ReadonlyArray<ScalarValue> | undefined;
    last(): ReadonlyArray<ScalarValue> | undefined;
    firstDefined(): ReadonlyArray<ScalarValue> | undefined;
    lastDefined(): ReadonlyArray<ScalarValue> | undefined;
  }
}

declare module './columnar/key-column.js' {
  interface TimeKeyColumn {
    /**
     * Returns the begin timestamp at row `i` as a raw number, or
     * `undefined` for out-of-range. For point-in-time keys
     * `begin === end`, so this is the only timestamp at row `i`.
     *
     * The columnar idiom: returns the raw value, not a `Time`
     * class instance. Consumers that want the `Time` wrapper (with
     * methods like `.toISOString()`) can reach for it via the
     * row-API path (`series.events[i].key`).
     */
    at(i: number): number | undefined;

    /**
     * Zero-copy index-range view. `start` clamps to `[0, length]`,
     * `end` clamps to `[start, length]`. Composes with the column-
     * side `slice` so chart adapters can slice both axes the same
     * way: `series.keyColumn().slice(s, e)` /
     * `series.column('x').slice(s, e)`.
     */
    slice(start: number, end: number): TimeKeyColumn;
  }

  interface TimeRangeKeyColumn {
    /**
     * Returns `{ begin, end }` at row `i`, or `undefined` for
     * out-of-range. Raw POJO; consumers wanting the `TimeRange`
     * class use the row-API path.
     */
    at(i: number): TimeRangeKeyAt | undefined;
    slice(start: number, end: number): TimeRangeKeyColumn;
  }

  interface IntervalKeyColumn {
    /**
     * Returns `{ begin, end, label }` at row `i`, or `undefined`
     * for out-of-range. The label type matches the column's
     * `labelKind` (`'string'` → `string`; `'number'` → `number`),
     * preserving the `string | number` `IntervalValue` semantics
     * the schema declared.
     */
    at(i: number): IntervalKeyAt | undefined;
    slice(start: number, end: number): IntervalKeyColumn;
  }
}

// ─── Float64Column runtime implementations ───────────────────────

Float64Column.prototype.at = function (i: number): number | undefined {
  return this.read(i);
};

Float64Column.prototype.slice = function (
  start: number,
  end: number,
): Float64Column {
  return this.sliceByRange(start, end);
};

Float64Column.prototype.min = function (): number | undefined {
  return resolveReducer('min').reduceColumn!(this) as number | undefined;
};

Float64Column.prototype.max = function (): number | undefined {
  return resolveReducer('max').reduceColumn!(this) as number | undefined;
};

Float64Column.prototype.sum = function (): number {
  return resolveReducer('sum').reduceColumn!(this) as number;
};

Float64Column.prototype.mean = function (): number | undefined {
  return resolveReducer('avg').reduceColumn!(this) as number | undefined;
};

Float64Column.prototype.stdev = function (): number | undefined {
  return resolveReducer('stdev').reduceColumn!(this) as number | undefined;
};

Float64Column.prototype.median = function (): number | undefined {
  return resolveReducer('median').reduceColumn!(this) as number | undefined;
};

Float64Column.prototype.percentile = function (q: number): number | undefined {
  if (!Number.isFinite(q) || q < 0 || q > 100) {
    throw new RangeError(
      `Float64Column.percentile: q must be a finite number in [0, 100], got ${q}`,
    );
  }
  return percentileReducer(q).reduceColumn!(this) as number | undefined;
};

Float64Column.prototype.count = function (): number {
  return resolveReducer('count').reduceColumn!(this) as number;
};

/**
 * Fused single-pass `[min, max]`. Cheaper than `[col.min(),
 * col.max()]` (one scan vs two) — the chart's per-frame Y-extent
 * primitive. NaN-laundered comparisons match the row-API min/max
 * (PR #153 Codex fix); on contract-violating NaN-bearing input the
 * result is bug-for-bug parity with `[col.min(), col.max()]`.
 */
Float64Column.prototype.minMax = function (): [number, number] | undefined {
  const v = this.validity;
  const values = this.values;
  const n = this.length;
  if (n === 0) return undefined;
  let i = 0;
  let lo: number;
  let hi: number;
  if (!v) {
    lo = values[0]!;
    hi = lo;
    for (i = 1; i < n; i += 1) {
      const x = values[i]!;
      lo = lo <= x ? lo : x;
      hi = hi >= x ? hi : x;
    }
    return [lo, hi];
  }
  while (i < n && !v.isDefined(i)) i += 1;
  if (i >= n) return undefined;
  lo = values[i]!;
  hi = lo;
  for (i += 1; i < n; i += 1) {
    if (!v.isDefined(i)) continue;
    const x = values[i]!;
    lo = lo <= x ? lo : x;
    hi = hi >= x ? hi : x;
  }
  return [lo, hi];
};

Float64Column.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};

Float64Column.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};

Float64Column.prototype.first = function (): number | undefined {
  return this.read(0);
};

Float64Column.prototype.last = function (): number | undefined {
  return this.read(this.length - 1);
};

Float64Column.prototype.firstDefined = function (): number | undefined {
  const v = this.validity;
  if (!v) return this.length > 0 ? this.values[0] : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = 0; i < this.length; i += 1) {
    if (v.isDefined(i)) return this.values[i];
  }
  return undefined;
};

Float64Column.prototype.lastDefined = function (): number | undefined {
  const v = this.validity;
  if (!v) return this.length > 0 ? this.values[this.length - 1] : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = this.length - 1; i >= 0; i -= 1) {
    if (v.isDefined(i)) return this.values[i];
  }
  return undefined;
};

/**
 * Equal-width index-bucketed reduction. Splits `[0, length)` into
 * `bins` ranges of (near-)equal index count, applies the reducer
 * to each range's column slice, and packs the results into the
 * output buffer.
 *
 * The chart's per-frame downsampler:
 *
 * ```ts
 * const visible = series.column('value').slice(startIdx, endIdx);
 * const { lo, hi } = visible.bin(cssWidth, 'minMax');
 * for (let px = 0; px < cssWidth; px += 1) {
 *   ctx.moveTo(px, scaleY(hi[px]!));
 *   ctx.lineTo(px, scaleY(lo[px]!));
 * }
 * ```
 *
 * Empty bins (which happen when `bins > length`) land as `NaN` for
 * reducers whose mathematical empty is undefined (min / max /
 * mean / stdev / median / percentile), and as `0` for reducers
 * whose empty has a well-defined value (sum / count). The `NaN`
 * convention is canvas-friendly: `ctx.lineTo(px, NaN)` breaks the
 * sub-path, which is the correct visual for "no data here."
 *
 * **Uniform-sampling precondition** (per RFC §8): equal-width
 * **index** bins match equal-width **pixel** bins only when adjacent
 * samples are uniformly time-spaced. For bursty / irregular data
 * the chart needs time-aware binning (deferred to step 8g
 * `series.binnedByTime`); `bin` then becomes "correct
 * for uniform input, lying for non-uniform" and is the wrong
 * tool. The method name spells out the index-domain semantics so
 * the call site can't confuse the two.
 */
Float64Column.prototype.bin = function <R extends BinReducerName>(
  bins: number,
  reducer: R,
  options?: { out: BinOutput<R> },
): BinOutput<R> {
  if (!Number.isInteger(bins) || bins <= 0) {
    throw new RangeError(
      `Float64Column.bin: bins must be a positive integer, got ${bins}`,
    );
  }
  const n = this.length;

  // ─── Fused minMax — two-channel output ─────────────────────────
  //
  // Special-cased because it's the chart's per-pixel hot path and
  // its output shape ({lo, hi}) doesn't fit the scalar Float64Array
  // mold. Each bin walks once, fuses both reductions, writes both
  // channels — half the memory traffic of `[min(), max()]`.

  if (reducer === 'minMax') {
    let lo: Float64Array;
    let hi: Float64Array;
    if (options?.out !== undefined) {
      // Validate the caller-supplied out has the minMax shape and
      // matching lengths. Length-mismatch throws rather than
      // silently writing past the end / leaving stale slots — the
      // out-buffer contract is "this is exactly the output."
      const provided = options.out as unknown as {
        lo?: Float64Array;
        hi?: Float64Array;
      };
      if (
        !(provided.lo instanceof Float64Array) ||
        !(provided.hi instanceof Float64Array)
      ) {
        throw new TypeError(
          `Float64Column.bin: 'minMax' reducer requires options.out to be { lo: Float64Array, hi: Float64Array }`,
        );
      }
      if (provided.lo.length !== bins || provided.hi.length !== bins) {
        throw new RangeError(
          `Float64Column.bin: options.out.lo / options.out.hi length must equal bins (${bins}); got lo.length=${provided.lo.length}, hi.length=${provided.hi.length}`,
        );
      }
      if (provided.lo === provided.hi) {
        // Aliased buffers — `lo[b] = extent[0]; hi[b] = extent[1]`
        // would silently produce `[max]` over the same slots because
        // `hi`'s write follows `lo`'s. Throw rather than producing
        // wrong output. Closes L2 finding on PR #161.
        throw new TypeError(
          `Float64Column.bin: options.out.lo and options.out.hi must be distinct buffers; got the same reference`,
        );
      }
      lo = provided.lo;
      hi = provided.hi;
    } else {
      lo = new Float64Array(bins);
      hi = new Float64Array(bins);
    }

    // Inlined per-bin walk over `this.values[start..end)` rather
    // than `this.sliceByRange(start, end).minMax()` per bin. The
    // sliced version allocated a Float64Column + Float64Array
    // subarray view + optionally a validity-bitmap slice on every
    // bin, then dispatched into the minMax method. Inlining
    // hoists the validity branch (it's the same for every bin)
    // and removes the per-bin construction overhead.
    //
    // Measured wins (`scripts/perf-bin.mjs`, median of 30 × 3
    // runs): ~23% on fine-bins (N=100k, W=1024) where per-bin
    // overhead is the biggest fraction of work; ~9% on chart-
    // typical (N=1M, W=1024); within noise (~5%) on N=10M where
    // the inner buffer walk dominates and the per-bin construction
    // is a small relative cost. The chart-experiment M2.1
    // friction note motivated this; the actual win is smaller than
    // its initial framing suggested but real where it counts most
    // (fine zoom levels where the chart writes the most bins per
    // unit of input data).
    //
    // The inner-loop math is byte-identical to
    // `Float64Column.prototype.minMax` (same NaN parity, same
    // empty handling) — just over a (start, end) slice of the
    // underlying buffer.
    const values = this.values;
    const validity = this.validity;
    if (validity === undefined) {
      for (let b = 0; b < bins; b += 1) {
        const start = Math.floor((b * n) / bins);
        const end = Math.floor(((b + 1) * n) / bins);
        if (end <= start) {
          lo[b] = NaN;
          hi[b] = NaN;
          continue;
        }
        let loVal = values[start]!;
        let hiVal = loVal;
        for (let i = start + 1; i < end; i += 1) {
          const x = values[i]!;
          loVal = loVal <= x ? loVal : x;
          hiVal = hiVal >= x ? hiVal : x;
        }
        lo[b] = loVal;
        hi[b] = hiVal;
      }
    } else {
      // Validity path — use isDefined directly on the original
      // bitmap with the original index. Avoids the per-bin
      // validity-bitmap slice that sliceByRange would have done.
      for (let b = 0; b < bins; b += 1) {
        const start = Math.floor((b * n) / bins);
        const end = Math.floor(((b + 1) * n) / bins);
        if (end <= start) {
          lo[b] = NaN;
          hi[b] = NaN;
          continue;
        }
        let i = start;
        while (i < end && !validity.isDefined(i)) i += 1;
        if (i >= end) {
          // All cells in this bin are undefined.
          lo[b] = NaN;
          hi[b] = NaN;
          continue;
        }
        let loVal = values[i]!;
        let hiVal = loVal;
        for (i += 1; i < end; i += 1) {
          if (!validity.isDefined(i)) continue;
          const x = values[i]!;
          loVal = loVal <= x ? loVal : x;
          hiVal = hiVal >= x ? hiVal : x;
        }
        lo[b] = loVal;
        hi[b] = hiVal;
      }
    }
    return { lo, hi } as BinOutput<R>;
  }

  // ─── Scalar reducers ──────────────────────────────────────────
  //
  // Dispatch to the registered reducer's reduceColumn fast path
  // (PR #153) once per bin. The 'mean' → 'avg' mapping mirrors
  // the public Float64Column.mean() shim. Percentile-via-string
  // ('p95', 'p99.9', etc.) routes through resolveReducer's
  // parsePercentile.

  const internalName = reducer === 'mean' ? 'avg' : reducer;
  let reducerDef;
  try {
    reducerDef = resolveReducer(internalName);
  } catch {
    throw new TypeError(`Float64Column.bin: unknown reducer '${reducer}'`);
  }
  if (reducerDef.reduceColumn === undefined) {
    throw new TypeError(
      `Float64Column.bin: reducer '${reducer}' has no reduceColumn fast path`,
    );
  }

  let out: Float64Array;
  if (options?.out !== undefined) {
    const provided = options.out as unknown;
    if (!(provided instanceof Float64Array)) {
      throw new TypeError(
        `Float64Column.bin: scalar reducer '${reducer}' requires options.out to be a Float64Array`,
      );
    }
    if (provided.length !== bins) {
      throw new RangeError(
        `Float64Column.bin: options.out length must equal bins (${bins}); got ${provided.length}`,
      );
    }
    out = provided;
  } else {
    out = new Float64Array(bins);
  }
  for (let b = 0; b < bins; b += 1) {
    const start = Math.floor((b * n) / bins);
    const end = Math.floor(((b + 1) * n) / bins);
    if (end <= start) {
      // Preserve mathematical-empty for sum / count (both = 0);
      // NaN for reducers whose empty is undefined.
      out[b] = reducer === 'sum' || reducer === 'count' ? 0 : NaN;
      continue;
    }
    const result = reducerDef.reduceColumn(this.sliceByRange(start, end));
    out[b] = typeof result === 'number' ? result : NaN;
  }
  return out as BinOutput<R>;
};

// ─── BooleanColumn runtime implementations ───────────────────────

BooleanColumn.prototype.at = function (i: number): boolean | undefined {
  return this.read(i);
};

BooleanColumn.prototype.slice = function (
  start: number,
  end: number,
): BooleanColumn {
  return this.sliceByRange(start, end);
};

/**
 * `true` iff every defined cell is true. Vacuously `true` for an
 * empty / all-invalid column (matches the standard `every`
 * convention).
 */
BooleanColumn.prototype.all = function (): boolean {
  const v = this.validity;
  const values = this.values;
  const n = this.length;
  if (!v) {
    for (let i = 0; i < n; i += 1) {
      if ((values[i >> 3]! & (1 << (i & 7))) === 0) return false;
    }
    return true;
  }
  for (let i = 0; i < n; i += 1) {
    if (!v.isDefined(i)) continue;
    if ((values[i >> 3]! & (1 << (i & 7))) === 0) return false;
  }
  return true;
};

/**
 * `true` iff at least one defined cell is true. Vacuously `false`
 * for empty / all-invalid.
 */
BooleanColumn.prototype.any = function (): boolean {
  const v = this.validity;
  const values = this.values;
  const n = this.length;
  if (!v) {
    for (let i = 0; i < n; i += 1) {
      if ((values[i >> 3]! & (1 << (i & 7))) !== 0) return true;
    }
    return false;
  }
  for (let i = 0; i < n; i += 1) {
    if (!v.isDefined(i)) continue;
    if ((values[i >> 3]! & (1 << (i & 7))) !== 0) return true;
  }
  return false;
};

BooleanColumn.prototype.none = function (): boolean {
  return !this.any();
};

BooleanColumn.prototype.count = function (): number {
  if (!this.validity) return this.length;
  return this.validity.definedCount;
};

BooleanColumn.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};

BooleanColumn.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};

BooleanColumn.prototype.first = function (): boolean | undefined {
  return this.read(0);
};

BooleanColumn.prototype.last = function (): boolean | undefined {
  return this.read(this.length - 1);
};

BooleanColumn.prototype.firstDefined = function (): boolean | undefined {
  const v = this.validity;
  const values = this.values;
  const n = this.length;
  if (!v) return n > 0 ? this.read(0) : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = 0; i < n; i += 1) {
    if (v.isDefined(i)) return (values[i >> 3]! & (1 << (i & 7))) !== 0;
  }
  return undefined;
};

BooleanColumn.prototype.lastDefined = function (): boolean | undefined {
  const v = this.validity;
  const values = this.values;
  const n = this.length;
  if (!v) return n > 0 ? this.read(n - 1) : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (v.isDefined(i)) return (values[i >> 3]! & (1 << (i & 7))) !== 0;
  }
  return undefined;
};

// ─── StringColumn runtime implementations ────────────────────────

StringColumn.prototype.at = function (i: number): string | undefined {
  return this.read(i);
};

StringColumn.prototype.slice = function (
  start: number,
  end: number,
): StringColumn {
  return this.sliceByRange(start, end);
};

/**
 * Count of distinct string values among defined cells. For
 * dict-encoded storage this is the active dictionary entry count;
 * for fallback it's a `Set` walk.
 */
StringColumn.prototype.uniqueCount = function (): number {
  const seen = new Set<string>();
  const n = this.length;
  const v = this.validity;
  for (let i = 0; i < n; i += 1) {
    if (v && !v.isDefined(i)) continue;
    const s = this.read(i);
    if (s !== undefined) seen.add(s);
  }
  return seen.size;
};

StringColumn.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};

StringColumn.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};

StringColumn.prototype.first = function (): string | undefined {
  return this.read(0);
};

StringColumn.prototype.last = function (): string | undefined {
  return this.read(this.length - 1);
};

StringColumn.prototype.firstDefined = function (): string | undefined {
  const v = this.validity;
  const n = this.length;
  if (!v) return n > 0 ? this.read(0) : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = 0; i < n; i += 1) {
    if (v.isDefined(i)) return this.read(i);
  }
  return undefined;
};

StringColumn.prototype.lastDefined = function (): string | undefined {
  const v = this.validity;
  const n = this.length;
  if (!v) return n > 0 ? this.read(n - 1) : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (v.isDefined(i)) return this.read(i);
  }
  return undefined;
};

// ─── ArrayColumn runtime implementations ─────────────────────────

ArrayColumn.prototype.at = function (
  i: number,
): ReadonlyArray<ScalarValue> | undefined {
  return this.read(i);
};

ArrayColumn.prototype.slice = function (
  start: number,
  end: number,
): ArrayColumn {
  return this.sliceByRange(start, end);
};

ArrayColumn.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};

ArrayColumn.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};

ArrayColumn.prototype.first = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  return this.read(0);
};

ArrayColumn.prototype.last = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  return this.read(this.length - 1);
};

ArrayColumn.prototype.firstDefined = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  const v = this.validity;
  const n = this.length;
  if (!v) return n > 0 ? this.read(0) : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = 0; i < n; i += 1) {
    if (v.isDefined(i)) return this.read(i);
  }
  return undefined;
};

ArrayColumn.prototype.lastDefined = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  const v = this.validity;
  const n = this.length;
  if (!v) return n > 0 ? this.read(n - 1) : undefined;
  if (v.definedCount === 0) return undefined;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (v.isDefined(i)) return this.read(i);
  }
  return undefined;
};

// ─── ChunkedFloat64Column runtime implementations ────────────────

ChunkedFloat64Column.prototype.at = function (i: number): number | undefined {
  return this.read(i);
};
ChunkedFloat64Column.prototype.slice = function (start: number, end: number) {
  return this.sliceByRange(start, end);
};
ChunkedFloat64Column.prototype.min = function (): number | undefined {
  return materializeChunkedFloat64(this).min();
};
ChunkedFloat64Column.prototype.max = function (): number | undefined {
  return materializeChunkedFloat64(this).max();
};
ChunkedFloat64Column.prototype.sum = function (): number {
  return materializeChunkedFloat64(this).sum();
};
ChunkedFloat64Column.prototype.mean = function (): number | undefined {
  return materializeChunkedFloat64(this).mean();
};
ChunkedFloat64Column.prototype.stdev = function (): number | undefined {
  return materializeChunkedFloat64(this).stdev();
};
ChunkedFloat64Column.prototype.median = function (): number | undefined {
  return materializeChunkedFloat64(this).median();
};
ChunkedFloat64Column.prototype.percentile = function (
  q: number,
): number | undefined {
  return materializeChunkedFloat64(this).percentile(q);
};
ChunkedFloat64Column.prototype.count = function (): number {
  // Validity-defined-count is available without materializing.
  if (!this.validity) return this.length;
  return this.validity.definedCount;
};
ChunkedFloat64Column.prototype.minMax = function ():
  | [number, number]
  | undefined {
  return materializeChunkedFloat64(this).minMax();
};
ChunkedFloat64Column.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};
ChunkedFloat64Column.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};
ChunkedFloat64Column.prototype.first = function (): number | undefined {
  return this.read(0);
};
ChunkedFloat64Column.prototype.last = function (): number | undefined {
  return this.read(this.length - 1);
};
ChunkedFloat64Column.prototype.firstDefined = function (): number | undefined {
  return materializeChunkedFloat64(this).firstDefined();
};
ChunkedFloat64Column.prototype.lastDefined = function (): number | undefined {
  return materializeChunkedFloat64(this).lastDefined();
};
ChunkedFloat64Column.prototype.bin = function <R extends BinReducerName>(
  bins: number,
  reducer: R,
  options?: { out: BinOutput<R> },
): BinOutput<R> {
  // v1: materialize then delegate. Future PR can walk chunks per
  // bin without the materialize copy when bin boundaries align with
  // chunk boundaries (the common case after concatSorted of two
  // equal-sized chunks at a chart-friendly bin count). The `out`
  // option passes straight through — the same buffer the chunked
  // caller supplied gets written by the underlying packed bin.
  return materializeChunkedFloat64(this).bin(bins, reducer, options);
};

// ─── ChunkedBooleanColumn runtime implementations ────────────────

ChunkedBooleanColumn.prototype.at = function (i: number): boolean | undefined {
  return this.read(i);
};
ChunkedBooleanColumn.prototype.slice = function (start: number, end: number) {
  return this.sliceByRange(start, end);
};
ChunkedBooleanColumn.prototype.all = function (): boolean {
  return materializeChunkedBoolean(this).all();
};
ChunkedBooleanColumn.prototype.any = function (): boolean {
  return materializeChunkedBoolean(this).any();
};
ChunkedBooleanColumn.prototype.none = function (): boolean {
  return materializeChunkedBoolean(this).none();
};
ChunkedBooleanColumn.prototype.count = function (): number {
  if (!this.validity) return this.length;
  return this.validity.definedCount;
};
ChunkedBooleanColumn.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};
ChunkedBooleanColumn.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};
ChunkedBooleanColumn.prototype.first = function (): boolean | undefined {
  return this.read(0);
};
ChunkedBooleanColumn.prototype.last = function (): boolean | undefined {
  return this.read(this.length - 1);
};
ChunkedBooleanColumn.prototype.firstDefined = function (): boolean | undefined {
  return materializeChunkedBoolean(this).firstDefined();
};
ChunkedBooleanColumn.prototype.lastDefined = function (): boolean | undefined {
  return materializeChunkedBoolean(this).lastDefined();
};

// ─── ChunkedStringColumn runtime implementations ─────────────────

ChunkedStringColumn.prototype.at = function (i: number): string | undefined {
  return this.read(i);
};
ChunkedStringColumn.prototype.slice = function (start: number, end: number) {
  return this.sliceByRange(start, end);
};
ChunkedStringColumn.prototype.uniqueCount = function (): number {
  return materializeChunkedString(this).uniqueCount();
};
ChunkedStringColumn.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};
ChunkedStringColumn.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};
ChunkedStringColumn.prototype.first = function (): string | undefined {
  return this.read(0);
};
ChunkedStringColumn.prototype.last = function (): string | undefined {
  return this.read(this.length - 1);
};
ChunkedStringColumn.prototype.firstDefined = function (): string | undefined {
  return materializeChunkedString(this).firstDefined();
};
ChunkedStringColumn.prototype.lastDefined = function (): string | undefined {
  return materializeChunkedString(this).lastDefined();
};

// ─── ChunkedArrayColumn runtime implementations ──────────────────

ChunkedArrayColumn.prototype.at = function (
  i: number,
): ReadonlyArray<ScalarValue> | undefined {
  return this.read(i);
};
ChunkedArrayColumn.prototype.slice = function (start: number, end: number) {
  return this.sliceByRange(start, end);
};
ChunkedArrayColumn.prototype.hasMissing = function (): boolean {
  if (!this.validity) return false;
  return this.validity.definedCount < this.length;
};
ChunkedArrayColumn.prototype.nullCount = function (): number {
  if (!this.validity) return 0;
  return this.length - this.validity.definedCount;
};
ChunkedArrayColumn.prototype.first = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  return this.read(0);
};
ChunkedArrayColumn.prototype.last = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  return this.read(this.length - 1);
};
ChunkedArrayColumn.prototype.firstDefined = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  return materializeChunkedArray(this).firstDefined();
};
ChunkedArrayColumn.prototype.lastDefined = function ():
  | ReadonlyArray<ScalarValue>
  | undefined {
  return materializeChunkedArray(this).lastDefined();
};

// ─── KeyColumn runtime implementations (step 8d) ─────────────────
//
// Mirrors `Column.at(i)` / `Column.slice(s, e)` on the key axis.
// Substrate has `beginAt(i)` / `endAt(i)` / `labelAt(i)` already —
// `at(i)` is the column-API alias that returns the row-shape POJO
// per RFC §7.5. `slice(s, e)` delegates to the substrate's
// `sliceByRange`.

TimeKeyColumn.prototype.at = function (i: number): number | undefined {
  // Bounds-check rather than throwing — matches `Column.at(i)`'s
  // `T | undefined` contract; consumers that want the throw
  // semantics can still call `beginAt(i)` directly. The
  // `Number.isInteger` gate rejects `NaN` / `±Infinity` /
  // fractional indexes so callers don't silently get bogus rows
  // from typed-array property-key fallbacks. Closes Codex finding
  // on PR #159.
  if (!Number.isInteger(i) || i < 0 || i >= this.length) return undefined;
  return this.begin[i];
};

TimeKeyColumn.prototype.slice = function (
  start: number,
  end: number,
): TimeKeyColumn {
  return this.sliceByRange(start, end);
};

TimeRangeKeyColumn.prototype.at = function (
  i: number,
): TimeRangeKeyAt | undefined {
  if (!Number.isInteger(i) || i < 0 || i >= this.length) return undefined;
  return { begin: this.begin[i]!, end: this.end[i]! };
};

TimeRangeKeyColumn.prototype.slice = function (
  start: number,
  end: number,
): TimeRangeKeyColumn {
  return this.sliceByRange(start, end);
};

IntervalKeyColumn.prototype.at = function (
  i: number,
): IntervalKeyAt | undefined {
  if (!Number.isInteger(i) || i < 0 || i >= this.length) return undefined;
  // The IntervalKeyColumn constructor invariant guarantees every
  // row has a defined label, so for a valid `i` `labels.read(i)`
  // is never undefined. The defensive `undefined` branch is
  // unreachable in practice but keeps the type honest —
  // `labels.read(i)` is typed `string | number | undefined`.
  const label = this.labels.read(i);
  if (label === undefined) return undefined;
  return { begin: this.begin[i]!, end: this.end[i]!, label };
};

IntervalKeyColumn.prototype.slice = function (
  start: number,
  end: number,
): IntervalKeyColumn {
  return this.sliceByRange(start, end);
};
