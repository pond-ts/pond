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
  StringColumn,
  materializeChunkedArray,
  materializeChunkedBoolean,
  materializeChunkedFloat64,
  materializeChunkedString,
} from './columnar/index.js';
import type { ScalarValue } from './columnar/index.js';
import { resolveReducer } from './reducers/index.js';
import { percentileReducer } from './reducers/percentile.js';

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
