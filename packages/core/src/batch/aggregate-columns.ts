import {
  bucketStateFor,
  finiteOrMissing,
  resolveReducer,
  rollingStateFor,
} from '../reducers/index.js';
import { plainRollingSum } from '../reducers/sum.js';
import { STDEV_SPLIT } from '../reducers/overflow-lanes.js';
import { WindowStdev, WindowSum } from '../reducers/window-accumulators.js';
import type { ArrayValue, Column, ColumnSchema } from '../columnar/index.js';
import {
  BooleanColumn,
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  arrayColumnFromOwnedCells,
  bitmapByteCount,
  stringColumnFromArray,
  validityFromBits,
} from '../columnar/index.js';
import type { Interval } from '../core/interval.js';
import { assertCellKind } from './validate.js';
import type {
  AggregateMap,
  AggregateOutputSpec,
  AggregateReducer,
  ColumnValue,
  RollingAlignment,
  ScalarKind,
  SeriesSchema,
} from '../schema/index.js';

/**
 * Normalised column spec used by both batch and live aggregation paths.
 *
 * `output` is the name the column appears under in the produced schema.
 * For shorthand entries (`{ existingCol: reducer }`) the output
 * name equals the source column name. For spec entries
 * (`{ alias: { from, using } }`) the two can differ — multiple specs
 * can read from the same source column with different aliases.
 *
 * Used by `TimeSeries.aggregate` / `rolling`, `LiveAggregation`,
 * `LiveRollingAggregation`, and `LivePartitionedSyncRolling`.
 */
export type AggregateColumnSpec = {
  output: string;
  source: string;
  reducer: AggregateReducer;
  kind: ScalarKind;
};

/**
 * @internal — discriminator between an `AggregateOutputSpec` (`{ from,
 * using, kind? }`) and a bare reducer string/function passed in an
 * `AggregateMap` slot.
 */
export function isAggregateOutputSpec<S extends SeriesSchema>(
  value: unknown,
): value is AggregateOutputSpec<S> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'from' in value &&
    'using' in value
  );
}

/**
 * Resolve a user-supplied `mapping` (an `AggregateMap<S>`,
 * shorthand and/or spec entries) against the source `schema` into a flat
 * list of `AggregateColumnSpec`. Walks the mapping once; throws on
 * unknown source columns, non-value source columns, or invalid
 * reducers. The resulting specs drive both the output schema
 * construction and the per-event reducer routing.
 *
 * Shared between the batch operators (`TimeSeries.rolling`,
 * `TimeSeries.aggregate`, `arrayAggregate`) and the live accumulators
 * (`LiveRollingAggregation`, `LiveAggregation`,
 * `LivePartitionedSyncRolling`). Keeping the normalisation in one
 * place ensures the live and batch surfaces stay symmetric — the
 * same `mapping` shape produces the same schema.
 */
export function normalizeAggregateColumns<S extends SeriesSchema>(
  schema: S,
  mapping: AggregateMap<S>,
): AggregateColumnSpec[] {
  const columnsByName = new Map(
    schema.slice(1).map((column) => [column.name, column] as const),
  );
  const normalized: AggregateColumnSpec[] = [];

  for (const [outputName, raw] of Object.entries(mapping)) {
    const sourceName = isAggregateOutputSpec<S>(raw) ? raw.from : outputName;
    const sourceColumn = columnsByName.get(sourceName);
    if (!sourceColumn) {
      throw new TypeError(
        `aggregate mapping references unknown source column '${sourceName}'`,
      );
    }
    if (
      sourceColumn.kind !== 'number' &&
      sourceColumn.kind !== 'string' &&
      sourceColumn.kind !== 'boolean' &&
      sourceColumn.kind !== 'array'
    ) {
      throw new TypeError(
        `aggregate source column '${sourceName}' must be a value column`,
      );
    }
    const reducer = isAggregateOutputSpec<S>(raw) ? raw.using : raw;
    if (typeof reducer !== 'string' && typeof reducer !== 'function') {
      throw new TypeError(
        `aggregate reducer for '${outputName}' must be a built-in name or function`,
      );
    }
    const explicitKind = isAggregateOutputSpec<S>(raw) ? raw.kind : undefined;
    let resolvedKind: ScalarKind;
    if (explicitKind !== undefined) {
      resolvedKind = explicitKind;
    } else if (typeof reducer === 'string') {
      const builtIn = resolveReducer(reducer);
      if (builtIn.outputKind === 'number') {
        resolvedKind = 'number';
      } else if (builtIn.outputKind === 'array') {
        resolvedKind = 'array';
      } else {
        resolvedKind = sourceColumn.kind;
      }
    } else {
      resolvedKind = sourceColumn.kind;
    }
    normalized.push({
      output: outputName,
      source: sourceName,
      reducer,
      kind: resolvedKind,
    });
  }

  return normalized;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* Columnar fast path for time-keyed `aggregate()` (Phase 4.7 step 3B).   */
/*                                                                        */
/* On sorted time-keyed data each bucket is a contiguous index range, so   */
/* when every mapped column is a built-in numeric reducer with a           */
/* `reduceColumn` fast path over a packed `Float64Column` source, each     */
/* bucket reduces straight off the typed-array slice — skipping the        */
/* `series.events` materialization and the per-cell `state.add` walk the   */
/* row path pays. Reuses the shipped step-3A `reduceColumn` kernels        */
/* (sum/min/max/avg 59–73×, stdev 35×, median/p95 3.4×) per bucket.        */
/*                                                                        */
/* Three pieces: `planColumnarAggregate` (the gate), `reduceBucket` (one   */
/* bucket's work), and `tryAggregateColumnarStore` (the walk + the         */
/* result store).                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

/** How one mapped column gets its per-bucket value. */
type ColumnarAggregatePlan =
  | {
      kind: 'reduce';
      column: Float64Column;
      /**
       * The reducer's **range-scoped** kernel — [PND-AGGALLOC]. Reducing
       * a bucket used to mean `reduce(column.sliceByRange(start, scan))`,
       * which allocated a `Float64Column` per bucket per column. Two
       * integers do the same job for nothing.
       */
      reduce: (
        col: Float64Column,
        start: number,
        end: number,
      ) => ColumnValue | undefined;
    }
  | { kind: 'boundary'; column: Column; which: 'first' | 'last' }
  | {
      /**
       * `keep` / `difference` / `unique` / `top${N}` / `samples`: the
       * reducer's range kernel over any column (`reduceCellRange`) — the
       * answer its bucket state would give, read off the column.
       */
      kind: 'cells';
      column: Column;
      reduce: (
        col: Column,
        start: number,
        end: number,
      ) => ColumnValue | undefined;
    }
  | {
      /**
       * Everything else — a built-in reducer with no range kernel for this
       * column (e.g. `sum` over a chunked or non-number column), or a
       * custom function: the reducer's own bucket state, fed this
       * column's cells in order. The same values in the same order the
       * row path feeds it, so the answer is what this column alone gets.
       */
      kind: 'state';
      column: Column;
      reducer: AggregateReducer;
    };

/**
 * Resolves each mapped column to a per-bucket execution plan.
 *
 * Each column is planned **on its own**, so a column's answer never
 * depends on which other columns share the call ([PND-AGGSIBLING]):
 *
 * - a built-in numeric reducer with a range kernel over a packed number
 *   column reduces the bucket's index range off the typed array;
 * - `first` / `last` take a boundary scan, on **any** column kind /
 *   storage (the first/last *defined* cell in the bucket — see
 *   `ReducerDef.definedBoundary`). That is what lets a partitioned
 *   `aggregate`, whose auto-injected partition-column reducer is
 *   `'first'`, take this path;
 * - `keep` / `difference` / `unique` / `top${N}` / `samples` take their
 *   range kernel (`reduceCellRange`) over any column kind;
 * - every other column (a reducer with no range kernel for it, such as
 *   `sum` over a chunked or non-number column, or a custom function)
 *   feeds its reducer's bucket state, as the row path does.
 *
 * This used to be all-or-nothing: one column of the third kind sent the
 * whole call to the row path, where `sum` / `avg` lose the blocked
 * summation (last-ulp differences on buckets of 32+ values) and `median`
 * can pick the other sign of zero. So adding `host: 'count'` to a call
 * could change `v: 'sum'`.
 *
 * Returns `null` — caller takes the row path — only when a source column
 * is missing.
 */
function planColumnarAggregate(
  getColumn: (name: string) => Column | undefined,
  columns: ReadonlyArray<AggregateColumnSpec>,
): ColumnarAggregatePlan[] | null {
  const plans: ColumnarAggregatePlan[] = [];
  for (const spec of columns) {
    const source = getColumn(spec.source);
    if (source === undefined) return null; // missing source
    const def =
      typeof spec.reducer === 'string' ? resolveReducer(spec.reducer) : null;

    if (def?.definedBoundary !== undefined) {
      plans.push({
        kind: 'boundary',
        column: source,
        which: def.definedBoundary,
      });
      continue;
    }

    if (
      def?.reduceColumnRange !== undefined &&
      source.kind === 'number' &&
      source.storage === 'packed'
    ) {
      plans.push({
        kind: 'reduce',
        column: source,
        reduce: def.reduceColumnRange,
      });
      continue;
    }

    if (def?.reduceCellRange !== undefined) {
      plans.push({
        kind: 'cells',
        column: source,
        reduce: def.reduceCellRange,
      });
      continue;
    }

    plans.push({ kind: 'state', column: source, reducer: spec.reducer });
  }
  return plans;
}

/**
 * Runs one bucket's plans, writing each column's reduced value into
 * `out[p]` in plan order. `[start, scan)` is the bucket's index range;
 * `out` is caller-owned and reused across buckets so the walk doesn't
 * allocate a result array per bucket.
 *
 * An empty bucket reduces an empty slice — the reducer's empty-input
 * result, which the step-3A parity contract guarantees matches a
 * zero-`add` bucket snapshot on the row path.
 */
function reduceBucket(
  plans: ReadonlyArray<ColumnarAggregatePlan>,
  start: number,
  scan: number,
  out: Array<ColumnValue | undefined>,
): void {
  for (let p = 0; p < plans.length; p += 1) {
    const plan = plans[p]!;
    if (plan.kind === 'reduce') {
      // A non-finite result (an overflow) is missing — same as every
      // reducer result path (`finiteOrMissing`, [PND-NANREP]).
      out[p] = finiteOrMissing(plan.reduce(plan.column, start, scan));
    } else if (plan.kind === 'cells') {
      out[p] = finiteOrMissing(plan.reduce(plan.column, start, scan));
    } else if (plan.kind === 'state') {
      // `bucketStateFor` applies the non-finite policy in and out.
      const state = bucketStateFor(plan.reducer);
      for (let i = start; i < scan; i += 1) state.add(plan.column.read(i));
      out[p] = state.snapshot();
    } else if (plan.which === 'first') {
      // First defined cell in [start, scan); scans past missing cells and
      // past non-finite numeric cells (reducer non-finite policy,
      // docs/notes/reducer-nan-policy.md — a NaN/±Inf numeric is "not a
      // contributor", matching the row path's `defined` filter).
      let value: ColumnValue | undefined;
      for (let i = start; i < scan; i += 1) {
        const cell = plan.column.read(i);
        if (cell === undefined) continue;
        if (typeof cell === 'number' && !Number.isFinite(cell)) continue;
        value = cell;
        break;
      }
      out[p] = value;
    } else {
      // Last defined cell in [start, scan); scans backward past missing and
      // past non-finite numeric cells (see the 'first' branch above).
      let value: ColumnValue | undefined;
      for (let i = scan - 1; i >= start; i -= 1) {
        const cell = plan.column.read(i);
        if (cell === undefined) continue;
        if (typeof cell === 'number' && !Number.isFinite(cell)) continue;
        value = cell;
        break;
      }
      out[p] = value;
    }
  }
}

/**
 * Builds the interval key column for a bucket list — the begin / end
 * axes plus the label column, discriminated on the label's runtime type.
 *
 * Mirrors `validateAndNormalizeColumnar`'s key-construction tail exactly,
 * including the `RangeError` (not `ValidationError`) on a mixed-label
 * sequence and its wording: some callers may catch by class, and this
 * path must not change which class they see. The empty case falls to the
 * string branch, matching the row path's behaviour for a zero-bucket
 * result.
 */
export function intervalKeysForBuckets(
  buckets: ReadonlyArray<Interval>,
): IntervalKeyColumn {
  const length = buckets.length;
  const begin = new Float64Array(length);
  const end = new Float64Array(length);
  const labels = new Array<string | number>(length);
  let labelKind: 'string' | 'number' | undefined;

  for (let i = 0; i < length; i += 1) {
    const bucket = buckets[i]!;
    begin[i] = bucket.begin();
    end[i] = bucket.end();
    const label = bucket.value;
    if (labelKind === undefined) {
      labelKind = typeof label === 'string' ? 'string' : 'number';
    } else if (typeof label !== labelKind) {
      throw new RangeError(
        `row ${i} has interval label of type ${typeof label} but earlier rows had ${labelKind} labels — interval-keyed series must use one label type throughout`,
      );
    }
    labels[i] = label;
  }

  if (labelKind === 'number') {
    const buf = new Float64Array(length);
    for (let i = 0; i < length; i += 1) buf[i] = labels[i] as number;
    return new IntervalKeyColumn(
      begin,
      end,
      new Float64Column(buf, length),
      length,
    );
  }
  return new IntervalKeyColumn(
    begin,
    end,
    stringColumnFromArray(labels as ReadonlyArray<string>, { forceDict: true }),
    length,
  );
}

/**
 * **Columnar output for time-keyed `aggregate()` — [PND-IVLCOL].**
 *
 * Same gate and same bucket walk as the reduction fast path above, but
 * the result is assembled as a `ColumnarStore` instead of a row array.
 *
 * **Why this exists.** `aggregate`'s output is interval-keyed, and the
 * only construction door for an interval-keyed series used to be row
 * intake — so the columnar fast path computed each bucket's answer in
 * typed arrays, boxed it into a frozen `[Interval, …]` row, and then
 * `new TimeSeries({ rows })` walked those rows straight back into
 * columns. Measured on a 1M-row series at 16,667 buckets × 4 columns,
 * that round trip cost **2.52 ms of a 5.01 ms call** — more than the
 * reduction it was packaging. Writing the columns directly costs
 * **0.09 ms** (spike: `spikes/columnar-wasm/bench/interval-columnar.mjs`).
 *
 * **Behaviour is identical, deliberately.** Trusted construction skips
 * row intake, so every check row intake performed is performed here:
 *
 * - Cell kinds go through the *same* `assertCellKind` (shared, not
 *   copied). A reducer that overflows to `Infinity` never reaches it:
 *   `reduceBucket` maps a non-finite result to missing, exactly as the
 *   row path's `applyAggregateReducer` does ([PND-NANREP]).
 * - Numeric columns are stamped `allFinite: true` when no bucket went
 *   missing — every surviving cell is finite. Dropping that flag would be
 *   safe but would quietly deoptimise every downstream reduction of an
 *   aggregate result.
 * - Missing cells (an empty bucket, or an all-missing one) are written as
 *   `NaN`, which a number column reads back as `undefined` ([PND-NANREP]).
 *
 * The one row-intake check deliberately skipped is the non-decreasing
 * key scan: `BoundedSequence` already validates its intervals as sorted,
 * non-overlapping, and positive-duration at construction, so re-deriving
 * it per bucket would be checking the same fact twice.
 *
 * Returns `null` only when a source column is missing; the caller then
 * takes the row path.
 */
export function tryAggregateColumnarStore(
  begins: Float64Array,
  getColumn: (name: string) => Column | undefined,
  buckets: ReadonlyArray<Interval>,
  columns: ReadonlyArray<AggregateColumnSpec>,
  resultSchema: ColumnSchema,
): ColumnarStore | null {
  const plans = planColumnarAggregate(getColumn, columns);
  if (plans === null) return null;

  const bucketCount = buckets.length;
  const colCount = columns.length;

  // Per-kind output buffers, pre-sized to the bucket count — the same
  // shape `validateAndNormalizeColumnar` uses, for the same reason: a
  // generic `ColumnBuilder` would grow-and-copy its way to the same
  // place. Validity bitmaps stay `null` until the first missing cell
  // (the "all defined ⇒ no bitmap" convention).
  const kinds = new Array<ScalarKind>(colCount);
  const numberBufs = new Array<Float64Array | null>(colCount);
  const booleanBufs = new Array<Uint8Array | null>(colCount);
  const stringBufs = new Array<Array<string | undefined> | null>(colCount);
  const arrayBufs = new Array<Array<ArrayValue | undefined> | null>(colCount);
  const validityBits = new Array<Uint8Array | null>(colCount);
  for (let c = 0; c < colCount; c += 1) {
    const kind = columns[c]!.kind;
    kinds[c] = kind;
    numberBufs[c] = kind === 'number' ? new Float64Array(bucketCount) : null;
    booleanBufs[c] =
      kind === 'boolean' ? new Uint8Array(bitmapByteCount(bucketCount)) : null;
    stringBufs[c] =
      kind === 'string' ? new Array<string | undefined>(bucketCount) : null;
    arrayBufs[c] =
      kind === 'array' ? new Array<ArrayValue | undefined>(bucketCount) : null;
    validityBits[c] = null;
  }
  const numberHasMissing = new Uint8Array(colCount);

  /** Marks row `b` of column `c` missing, allocating + back-filling the
   *  bitmap on the first such cell. */
  const markMissing = (c: number, b: number): void => {
    if ((validityBits[c] ?? null) !== null) return;
    const bits = new Uint8Array(bitmapByteCount(bucketCount));
    for (let j = 0; j < b; j += 1) bits[j >> 3]! |= 1 << (j & 7);
    validityBits[c] = bits;
  };

  const reduced: Array<ColumnValue | undefined> = new Array(colCount);
  const n = begins.length;
  let cursor = 0;

  for (let b = 0; b < bucketCount; b += 1) {
    const bucket = buckets[b]!;
    const bucketBegin = bucket.begin();
    const bucketEnd = bucket.end();
    while (cursor < n && begins[cursor]! < bucketBegin) cursor += 1;
    const start = cursor;
    let scan = start;
    while (scan < n && begins[scan]! < bucketEnd) scan += 1;
    cursor = scan;

    reduceBucket(plans, start, scan, reduced);

    for (let c = 0; c < colCount; c += 1) {
      const value = reduced[c];
      // Column index is `c + 1` in the output schema (the key is 0), so
      // an error names the same coordinates the row path would have.
      assertCellKind(kinds[c]!, value, b, c + 1);
      switch (kinds[c]) {
        case 'number': {
          // A missing number is `NaN` in the buffer — number columns
          // carry no bitmap ([PND-NANREP]).
          if (typeof value === 'number') {
            numberBufs[c]![b] = value;
          } else {
            numberBufs[c]![b] = NaN;
            numberHasMissing[c] = 1;
          }
          break;
        }
        case 'boolean': {
          if (typeof value === 'boolean') {
            if (value) booleanBufs[c]![b >> 3]! |= 1 << (b & 7);
            const bits = validityBits[c];
            if (bits !== null && bits !== undefined)
              bits[b >> 3]! |= 1 << (b & 7);
          } else {
            markMissing(c, b);
          }
          break;
        }
        case 'string': {
          stringBufs[c]![b] = typeof value === 'string' ? value : undefined;
          break;
        }
        case 'array': {
          // Defensive shallow freeze, matching the row path — the
          // element contract was checked by `assertCellKind` above.
          arrayBufs[c]![b] = Array.isArray(value)
            ? (Object.freeze(value.slice()) as ArrayValue)
            : undefined;
          break;
        }
      }
    }
  }

  const outColumns = new Map<string, Column>();
  for (let c = 0; c < colCount; c += 1) {
    const bits = validityBits[c] ?? null;
    const validity =
      bits === null ? undefined : validityFromBits(bits, bucketCount);
    let column: Column;
    switch (kinds[c]) {
      case 'number':
        // A non-finite result was mapped to missing in `reduceBucket`,
        // and `assertCellKind` rejects any other non-finite cell, so the
        // column is all-finite exactly when no cell went missing.
        column = new Float64Column(
          numberBufs[c]!,
          bucketCount,
          numberHasMissing[c] === 0,
        );
        break;
      case 'boolean':
        column = new BooleanColumn(booleanBufs[c]!, bucketCount, validity);
        break;
      case 'string':
        column = stringColumnFromArray(stringBufs[c]!);
        break;
      default:
        // Each cell is this function's own frozen copy, already checked by
        // `assertCellKind` — no second validation or copy.
        column = arrayColumnFromOwnedCells(
          arrayBufs[c]! as Array<ArrayValue | undefined>,
        );
        break;
    }
    outColumns.set(columns[c]!.output, column);
  }

  return ColumnarStore.fromTrustedStore(
    resultSchema,
    intervalKeysForBuckets(buckets),
    outColumns,
  );
}

/**
 * **Columnar fast path for count-window `rolling()`** — the N-bar window
 * financial studies compose on (SMA / Bollinger / rolling stats). When every
 * mapped column is a built-in reducer producing a `'number'` output from a
 * **packed `Float64Column`** source, the window sweep feeds the shared
 * incremental rolling states (`rollingStateFor` — the same add / remove /
 * snapshot arithmetic and non-finite skip policy as the generic path) values
 * read straight off the typed buffers, and writes each snapshot into a typed
 * result column. That removes the generic sweep's per-row costs: the
 * `snapshotWindow` result-array allocation, the boxed accumulator rows, the
 * polymorphic `col.read(i)` per add/remove, and the post-pass
 * `assertColumnValuesMatchKind` + re-pack over boxed values (a non-finite
 * result is written as a missing cell inline instead).
 *
 * Returns `null` — caller takes the generic sweep — when any column doesn't
 * qualify: a custom-function reducer, a non-`'number'` output kind
 * (`unique` / `samples` / `keep` over a non-number source / an explicit
 * `kind` override), or a non-numeric / chunked / missing source column.
 * All-or-nothing per call. Unlike `aggregate` ([PND-AGGSIBLING]) that
 * cannot change a column's answer: this sweep drives the same rolling
 * states as the generic one, so both give the same bits.
 *
 * Window shape replicates the generic count sweep exactly: rows are the unit
 * (`count` is a bar count — no equal-key grouping), `lo` / `hi` are monotonic
 * in the row index for every alignment (each row enters and leaves the window
 * once, amortized O(1)), a centered even `count` biases one row toward the
 * leading side, and a row whose window holds fewer than `minSamples` rows
 * emits missing cells without consulting the reducer states.
 */
export function tryRollingCountColumnarNumeric(
  getColumn: (name: string) => Column | undefined,
  rowCount: number,
  columns: ReadonlyArray<AggregateColumnSpec>,
  count: number,
  alignment: RollingAlignment,
  minSamples: number,
): Float64Column[] | null {
  const specCount = columns.length;
  const sources: Float64Column[] = [];
  for (const spec of columns) {
    if (typeof spec.reducer !== 'string') return null; // custom function
    if (spec.kind !== 'number') return null; // non-numeric output kind
    const source = getColumn(spec.source);
    if (source === undefined) return null; // missing source
    if (source.kind !== 'number' || source.storage !== 'packed') {
      return null; // non-numeric / chunked numeric source
    }
    sources.push(source);
  }

  // **One sweep per column, not one sweep feeding every column's state.**
  //
  // The window bounds depend only on the row index, `count` and the
  // alignment — never on the column — so each column can sweep
  // independently. The shared sweep called `states[c].add(...)` from a
  // single site that saw every reducer's state shape in turn, so the call
  // was megamorphic and V8 could not inline it: three virtual calls per
  // row per column (`add`, `remove`, `snapshot`) for what is usually O(1)
  // arithmetic. Measured 29 ns/row for a 20-bar `avg` over 500k rows,
  // which is 66% of every `@pond-ts/financial` study.
  //
  // Per-column sweeps make each call site monomorphic, and walk one
  // contiguous column at a time rather than striding across all of them.
  // The arithmetic is untouched — the same reducer states, fed the same
  // values in the same order — so results are bit-identical.
  const results: Float64Column[] = [];
  for (let c = 0; c < specCount; c += 1) {
    results.push(
      sweepRollingColumn(
        columns[c]!,
        sources[c]!,
        rowCount,
        count,
        alignment,
        minSamples,
        false,
      ),
    );
  }
  return results;
}

/**
 * Each row's window as row indices, `lo`…`hi` inclusive (`hi < lo` when
 * the window holds no row). @internal
 */
export interface RollingWindowBounds {
  lo: Int32Array;
  hi: Int32Array;
  /** 1 for a row whose key equals the row before's: it shares that row's
   *  window, and its answer is read once for the group. */
  sameKey: Uint8Array;
}

/**
 * The rows in each row's duration window, from the key's begin times.
 * Exactly the windows the event-driven `rolling` sweep in `TimeSeries`
 * builds: rows sharing a begin time share a window; trailing is
 * `(t - window, t]`, leading `[t, t + window)`, centered
 * `[t - window/2, t + window/2)`; and a leading or centered window left
 * empty steps past the rows before its lower bound ([PND-ROLLEMPTY]).
 * Both ends only move forward, so this is O(n). @internal
 */
export function rollingWindowBoundsByTime(
  begin: Float64Array,
  rowCount: number,
  windowMs: number,
  alignment: RollingAlignment,
): RollingWindowBounds {
  const lo = new Int32Array(rowCount);
  const hi = new Int32Array(rowCount);
  const sameKey = new Uint8Array(rowCount);
  let windowStart = 0;
  let windowEnd = 0;
  // One loop per alignment, so the hot loop carries no alignment test.
  if (alignment === 'trailing') {
    for (let i = 0; i < rowCount; i++) {
      const anchor = begin[i]!;
      if (i > 0 && begin[i - 1] === anchor) {
        lo[i] = lo[i - 1]!;
        hi[i] = hi[i - 1]!;
        sameKey[i] = 1;
        continue;
      }
      while (windowEnd < rowCount && begin[windowEnd]! <= anchor) windowEnd++;
      const lowerBound = anchor - windowMs;
      while (windowStart < windowEnd && begin[windowStart]! <= lowerBound)
        windowStart++;
      lo[i] = windowStart;
      hi[i] = windowEnd - 1;
    }
    return { lo, hi, sameKey };
  }
  const below = alignment === 'leading' ? 0 : windowMs / 2;
  const above = alignment === 'leading' ? windowMs : windowMs / 2;
  for (let i = 0; i < rowCount; i++) {
    const anchor = begin[i]!;
    if (i > 0 && begin[i - 1] === anchor) {
      lo[i] = lo[i - 1]!;
      hi[i] = hi[i - 1]!;
      sameKey[i] = 1;
      continue;
    }
    const lowerBound = anchor - below;
    while (windowStart < windowEnd && begin[windowStart]! < lowerBound)
      windowStart++;
    if (windowStart === windowEnd) {
      while (windowEnd < rowCount && begin[windowEnd]! < lowerBound)
        windowEnd++;
      windowStart = windowEnd;
    }
    const upperBound = anchor + above;
    while (windowEnd < rowCount && begin[windowEnd]! < upperBound) windowEnd++;
    lo[i] = windowStart;
    hi[i] = windowEnd - 1;
  }
  return { lo, hi, sameKey };
}

/**
 * The duration-window sibling of {@link tryRollingCountColumnarNumeric}: the
 * same per-column sweep over windows found from the keys. `null` when the
 * mapping can't take the fast path (a custom reducer, a non-number output,
 * a chunked or non-numeric source). @internal
 */
export function tryRollingTimeColumnarNumeric(
  getColumn: (name: string) => Column | undefined,
  rowCount: number,
  columns: ReadonlyArray<AggregateColumnSpec>,
  findBounds: () => RollingWindowBounds,
  alignment: RollingAlignment,
  minSamples: number,
): Float64Column[] | null {
  const sources: Float64Column[] = [];
  for (const spec of columns) {
    if (typeof spec.reducer !== 'string') return null;
    if (spec.kind !== 'number') return null;
    const source = getColumn(spec.source);
    if (source === undefined) return null;
    if (source.kind !== 'number' || source.storage !== 'packed') return null;
    sources.push(source);
  }
  // Only now, with the fast path known to apply, find the windows.
  const bounds = findBounds();
  // A column with values big enough for the reducers' overflow lanes runs
  // the laned states from the start, as the generic sweep does: the plain
  // accumulators would round such a window differently. Checked once per
  // source column, however many outputs read it.
  const laned = new Map<Float64Column, boolean>();
  return columns.map((spec, c) => {
    const source = sources[c]!;
    let isLaned = laned.get(source);
    if (isLaned === undefined) {
      isLaned = hasLaneSizedValue(source, rowCount);
      laned.set(source, isLaned);
    }
    return sweepRollingColumn(
      spec,
      source,
      rowCount,
      0,
      alignment,
      minSamples,
      isLaned,
      bounds,
    );
  });
}

/** Whether a column holds a finite value at or past the smallest
 *  overflow-lane split (`STDEV_SPLIT`, 2^480; `sum`'s is 2^960). Ordinary
 *  data never does, and this one pass is cheap next to the sweep. ±Infinity
 *  is a missing cell, so it does not count. */
function hasLaneSizedValue(source: Float64Column, rowCount: number): boolean {
  const values = source._values;
  for (let i = 0; i < rowCount; i++) {
    const v = values[i]!;
    if ((v >= STDEV_SPLIT || v <= -STDEV_SPLIT) && Number.isFinite(v))
      return true;
  }
  return false;
}

/**
 * One column's trailing / leading / centred rolling sweep. With `bounds`
 * unset it is a count window of `count` rows; with `bounds` set (a duration
 * window, from `rollingWindowBoundsByTime`) the windows come from there and
 * `count` is unused.
 *
 * `avg` and `stdev` drive their accumulators directly; everything else
 * drives its reducer state, which is now monomorphic at this call site.
 * `laned` is the overflow re-run — every reducer through its (laned) state;
 * see the note below. `avg` and `stdev` earn the special case because they
 * are what `sma` and the centre line / band width of `bollinger` / `zScore`
 * reduce to.
 */
function sweepRollingColumn(
  spec: AggregateColumnSpec,
  source: Float64Column,
  rowCount: number,
  count: number,
  alignment: RollingAlignment,
  minSamples: number,
  laned: boolean,
  bounds: RollingWindowBounds | null = null,
): Float64Column {
  // `max` / `min` have their own sweep: see `sweepRollingExtreme`. (Laned
  // only matters to the sums; an extreme has no overflow to re-run.)
  if (!laned && (spec.reducer === 'max' || spec.reducer === 'min')) {
    return sweepRollingExtreme(
      spec.reducer === 'max',
      source,
      rowCount,
      count,
      alignment,
      minSamples,
      bounds,
    );
  }
  const values = source._values;
  const allFinite = source.allFinite;

  // A missing output cell is `NaN`; start all-missing and write the
  // defined ones ([PND-NANREP] — no output bitmap).
  const outValues = new Float64Array(rowCount).fill(NaN);
  let outDefined = 0;

  // A cell contributes iff it is finite — a missing cell is `NaN` in the
  // buffer, so the finite test is also the defined test, and it is
  // skipped entirely when the source proves every cell finite. This reproduces both state variants the
  // shared sweep chose between: the bare built-in state (safe only when
  // the source is provably all-finite and fully defined) and the
  // `rollingStateFor` wrapper that applies the non-finite policy.
  // The contributor test is written inline at each site rather than through
  // a helper. It is evaluated twice per row (once entering the window, once
  // leaving), so a call there is a call per row per column — the exact cost
  // this kernel was restructured to remove, reintroduced by a tidier-looking
  // closure.
  //
  // `allFinite` is loop-invariant. On a dense, provably-finite column — an
  // OHLCV bar series, the common case here — the whole predicate folds to
  // `true` and the test disappears.

  // `avg` and `stdev` skip the reducer state's closure and its per-cell
  // `typeof` / lane checks by calling the plain accumulators directly;
  // everything else keeps its reducer state, which is monomorphic here now.
  //
  // **Overflow** ([PND-NANREP]). The reducer states split their running
  // sums by magnitude (`reducers/overflow-lanes.ts`) so
  // an overflow can't stick after the huge values leave the window — at the
  // price of a compare per cell. This sweep doesn't pay it: it runs the plain
  // single-lane accumulators (`WindowSum` / `WindowStdev`, `plainRollingSum`
  // for `sum`), and on the first non-finite answer from one of them — which
  // ordinary data never produces — abandons the pass and re-runs the column
  // with `laned` set, driving the laned reducer states instead. The re-run's
  // answers are then the state path's, bit for bit.
  const kind: 'avg' | 'stdev' | 'state' = laned
    ? 'state'
    : spec.reducer === 'avg' || spec.reducer === 'mean'
      ? 'avg'
      : spec.reducer === 'stdev'
        ? 'stdev'
        : 'state';
  const plainSum = !laned && spec.reducer === 'sum';
  const state =
    kind !== 'state'
      ? null
      : plainSum
        ? plainRollingSum()
        : allFinite
          ? resolveReducer(spec.reducer as string).rollingState()
          : rollingStateFor(spec.reducer);

  // `avg` / `stdev` — the same drift-free accumulators the reducer states
  // use below their overflow split (`reducers/window-accumulators.ts`,
  // [PND-ROLLSTD]). Calling their methods from here is a monomorphic call
  // V8 inlines, so the arithmetic is shared rather than transcribed, and the
  // answers match the state path bit for bit (the tests assert `Object.is`).
  const wSum = new WindowSum();
  const wStdev = new WindowStdev();

  const leftSpan = Math.floor((count - 1) / 2);
  const rightSpan = count - 1 - leftSpan;
  let windowStart = 0;
  let windowEnd = 0;

  for (let index = 0; index < rowCount; index += 1) {
    let lo: number;
    let hi: number;
    if (bounds !== null) {
      // A duration window: its rows were found up front from the keys.
      if (bounds.sameKey[index] === 1) {
        // Same key, same window: reuse the group's answer rather than read
        // the state again (a stdev read can move its shift, so a second read
        // may differ in the last bits; the generic sweep reads once too).
        const prev = outValues[index - 1]!;
        if (prev - prev === 0) {
          outValues[index] = prev;
          outDefined += 1;
        }
        continue;
      }
      lo = bounds.lo[index]!;
      hi = bounds.hi[index]!;
      if (alignment !== 'trailing') {
        // Leading and centered windows drop rows before adding, as the
        // generic sweep does (the same order keeps sums bit-identical) …
        const stop = lo < windowEnd ? lo : windowEnd;
        if (kind === 'avg') {
          while (windowStart < stop) {
            if (allFinite || values[windowStart]! - values[windowStart]! === 0)
              wSum.remove(values[windowStart]!);
            windowStart += 1;
          }
        } else if (kind === 'stdev') {
          while (windowStart < stop) {
            if (allFinite || values[windowStart]! - values[windowStart]! === 0)
              wStdev.remove(values[windowStart]!);
            windowStart += 1;
          }
        } else {
          while (windowStart < stop) {
            state!.remove(
              windowStart,
              allFinite || values[windowStart]! - values[windowStart]! === 0
                ? values[windowStart]!
                : undefined,
            );
            windowStart += 1;
          }
        }
        // … and an emptied window steps past rows that never entered it
        // ([PND-ROLLEMPTY], see `rollingWindowBoundsByTime`).
        if (windowStart === windowEnd && lo > windowEnd) {
          windowStart = lo;
          windowEnd = lo;
        }
      }
    } else if (alignment === 'trailing') {
      lo = index - count + 1 < 0 ? 0 : index - count + 1;
      hi = index;
    } else if (alignment === 'leading') {
      lo = index;
      hi = index + count - 1 < rowCount ? index + count - 1 : rowCount - 1;
    } else {
      lo = index - leftSpan < 0 ? 0 : index - leftSpan;
      hi = index + rightSpan < rowCount ? index + rightSpan : rowCount - 1;
    }

    if (kind === 'avg') {
      while (windowEnd <= hi) {
        if (allFinite || values[windowEnd]! - values[windowEnd]! === 0) {
          wSum.add(values[windowEnd]!);
        }
        windowEnd += 1;
      }
      while (windowStart < lo) {
        if (allFinite || values[windowStart]! - values[windowStart]! === 0) {
          wSum.remove(values[windowStart]!);
        }
        windowStart += 1;
      }
    } else if (kind === 'stdev') {
      while (windowEnd <= hi) {
        if (allFinite || values[windowEnd]! - values[windowEnd]! === 0) {
          wStdev.add(values[windowEnd]!);
        }
        windowEnd += 1;
      }
      while (windowStart < lo) {
        if (allFinite || values[windowStart]! - values[windowStart]! === 0) {
          wStdev.remove(values[windowStart]!);
        }
        windowStart += 1;
      }
    } else {
      while (windowEnd <= hi) {
        state!.add(
          windowEnd,
          allFinite || values[windowEnd]! - values[windowEnd]! === 0
            ? values[windowEnd]!
            : undefined,
        );
        windowEnd += 1;
      }
      while (windowStart < lo) {
        state!.remove(
          windowStart,
          allFinite || values[windowStart]! - values[windowStart]! === 0
            ? values[windowStart]!
            : undefined,
        );
        windowStart += 1;
      }
    }

    if (windowEnd - windowStart < minSamples) continue; // missing row

    const v =
      kind === 'avg'
        ? wSum.n === 0
          ? undefined
          : wSum.total() / wSum.n
        : kind === 'stdev'
          ? wStdev.stdev()
          : state!.snapshot();
    if (v === undefined) continue; // missing cell (e.g. all-missing window)
    // A non-finite result (e.g. a `sum` overflow to Infinity) is a missing
    // cell — a non-finite number in a number column means missing
    // ([PND-NANREP]), matching the generic sweep, whose states'
    // snapshots map it via `finiteOrMissing`. (`v - v !== 0` is true
    // exactly for NaN and ±Infinity.)
    if (typeof v !== 'number' || v - v !== 0) {
      // A plain running accumulator overflowed: re-run laned (see above).
      if (kind !== 'state' || plainSum) {
        return sweepRollingColumn(
          spec,
          source,
          rowCount,
          count,
          alignment,
          minSamples,
          true,
          bounds,
        );
      }
      continue;
    }
    outValues[index] = v;
    outDefined += 1;
  }

  // Every written cell passed the finite test above, so the column is
  // all-finite exactly when every row was written.
  return new Float64Column(outValues, rowCount, outDefined === rowCount);
}

/**
 * `max` / `min` over one column: {@link sweepRollingColumn}'s window walk,
 * with the reducer state's monotonic deque (`rollingMonotoneDeque`) written
 * out over the source buffer.
 *
 * The state keeps `{ index, value }` objects in an array it re-slices as
 * the head moves, behind a comparator closure — an allocation and an
 * indirect call per row, ~70 ms a column at 1M rows. Here the deque is row
 * indices in one `Int32Array`. Every row enters at most once, so `tail`
 * never passes `rowCount` and the queue never wraps.
 *
 * Same rule as the state, so the same answers bit for bit (pinned with
 * `Object.is` by `rolling-extremes-fast.test.ts`): a defined cell pops
 * every candidate it beats strictly (`max`: `<`, `min`: `>`), so of two
 * equal values — `0` and `-0` included — the older stays; removing a row
 * drops the head only when the head is that row; and the window walk
 * (alignments, shared-key rows, drop-before-add for leading and centred
 * duration windows, [PND-ROLLEMPTY]'s step past an emptied window) is
 * `sweepRollingColumn`'s, line for line.
 *
 * A separate function rather than two more cases in `sweepRollingColumn`:
 * it measured faster (Donchian at 1M rows 101 ms as cases there, 78 ms
 * here; `scripts/perf-rolling-extremes.mjs`), and it leaves the loop every
 * `avg` / `stdev` study runs exactly as it was.
 */
function sweepRollingExtreme(
  isMax: boolean,
  source: Float64Column,
  rowCount: number,
  count: number,
  alignment: RollingAlignment,
  minSamples: number,
  bounds: RollingWindowBounds | null,
): Float64Column {
  const values = source._values;
  const allFinite = source.allFinite;
  const outValues = new Float64Array(rowCount).fill(NaN);
  let outDefined = 0;
  const deque = new Int32Array(rowCount);
  let head = 0;
  let tail = 0;

  const leftSpan = Math.floor((count - 1) / 2);
  const rightSpan = count - 1 - leftSpan;
  let windowStart = 0;
  let windowEnd = 0;

  for (let index = 0; index < rowCount; index += 1) {
    let lo: number;
    let hi: number;
    if (bounds !== null) {
      if (bounds.sameKey[index] === 1) {
        const prev = outValues[index - 1]!;
        if (prev - prev === 0) {
          outValues[index] = prev;
          outDefined += 1;
        }
        continue;
      }
      lo = bounds.lo[index]!;
      hi = bounds.hi[index]!;
      if (alignment !== 'trailing') {
        const stop = lo < windowEnd ? lo : windowEnd;
        while (windowStart < stop) {
          if (head < tail && deque[head] === windowStart) head += 1;
          windowStart += 1;
        }
        if (windowStart === windowEnd && lo > windowEnd) {
          windowStart = lo;
          windowEnd = lo;
        }
      }
    } else if (alignment === 'trailing') {
      lo = index - count + 1 < 0 ? 0 : index - count + 1;
      hi = index;
    } else if (alignment === 'leading') {
      lo = index;
      hi = index + count - 1 < rowCount ? index + count - 1 : rowCount - 1;
    } else {
      lo = index - leftSpan < 0 ? 0 : index - leftSpan;
      hi = index + rightSpan < rowCount ? index + rightSpan : rowCount - 1;
    }

    // `isMax` is loop-invariant, so each pop test is one predictable
    // branch, not a call.
    while (windowEnd <= hi) {
      const v = values[windowEnd]!;
      if (allFinite || v - v === 0) {
        if (isMax) {
          while (tail > head && values[deque[tail - 1]!]! < v) tail -= 1;
        } else {
          while (tail > head && values[deque[tail - 1]!]! > v) tail -= 1;
        }
        deque[tail++] = windowEnd;
      }
      windowEnd += 1;
    }
    while (windowStart < lo) {
      if (head < tail && deque[head] === windowStart) head += 1;
      windowStart += 1;
    }

    if (windowEnd - windowStart < minSamples) continue; // missing row
    if (head === tail) continue; // no defined cell in the window
    outValues[index] = values[deque[head]!]!;
    outDefined += 1;
  }
  return new Float64Column(outValues, rowCount, outDefined === rowCount);
}
