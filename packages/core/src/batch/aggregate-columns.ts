import { resolveReducer, rollingStateFor } from '../reducers/index.js';
import type { ArrayValue, Column, ColumnSchema } from '../columnar/index.js';
import {
  BooleanColumn,
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  arrayColumnFromArray,
  bitmapByteCount,
  stringColumnFromArray,
  validityFromBits,
} from '../columnar/index.js';
import { ValidationError } from '../core/errors.js';
import type { Interval } from '../core/interval.js';
import { assertCellKind } from './validate.js';
import type {
  AggregateMap,
  AggregateOutputMap,
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
 * For `AggregateMap` mappings (`{ existingCol: reducer }`) the output
 * name equals the source column name. For `AggregateOutputMap` mappings
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
 * Resolve a user-supplied `mapping` (either `AggregateMap<S>` or
 * `AggregateOutputMap<S>`) against the source `schema` into a flat
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
  mapping: AggregateMap<S> | AggregateOutputMap<S>,
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
       * which allocated a `Float64Column` per bucket per column and, on a
       * column with a validity bitmap, also copied the bucket's bits into
       * a fresh `Uint8Array` and popcounted them. Two integers do the same
       * job for nothing.
       */
      reduce: (
        col: Float64Column,
        start: number,
        end: number,
      ) => ColumnValue | undefined;
    }
  | { kind: 'boundary'; column: Column; which: 'first' | 'last' };

/**
 * Resolves each mapped column to a per-bucket execution plan.
 *
 * Returns `null` — caller takes the unchanged row path — when any column
 * doesn't qualify: a custom-function reducer; a reducer that is neither a
 * numeric `reduceColumn` kernel nor a `first`/`last` boundary selector
 * (`unique` / `top` / `samples` / `keep`); or a numeric reducer over a
 * non-numeric / chunked / missing source column. All-or-nothing per call
 * keeps the bucket walk single-pass; mixed mappings fall back wholesale.
 *
 * `first` / `last` qualify on **any** column kind / storage, via a
 * boundary scan (the first/last *defined* cell in the bucket — see
 * `ReducerDef.definedBoundary`). That is what lets a partitioned
 * `aggregate` take the fast path: its auto-injected partition-column
 * reducer is `'first'`, which previously tripped the gate for every
 * partitioned call.
 */
function planColumnarAggregate(
  getColumn: (name: string) => Column | undefined,
  columns: ReadonlyArray<AggregateColumnSpec>,
): ColumnarAggregatePlan[] | null {
  const plans: ColumnarAggregatePlan[] = [];
  for (const spec of columns) {
    if (typeof spec.reducer !== 'string') return null; // custom function
    const def = resolveReducer(spec.reducer);
    const source = getColumn(spec.source);
    if (source === undefined) return null; // missing source

    if (def.definedBoundary !== undefined) {
      // `first` / `last`: pick the first/last *defined* cell in the bucket
      // via a boundary scan over any column kind / storage (`col.read(i)`).
      // This is what lets a partitioned `aggregate` — whose auto-injected
      // partition-column reducer is `'first'` — take the fast path instead
      // of bailing the whole call for lack of a numeric `reduceColumn`.
      plans.push({
        kind: 'boundary',
        column: source,
        which: def.definedBoundary,
      });
      continue;
    }

    // Gate on the **range-scoped** kernel, not `reduceColumn`. Every
    // built-in that has one has the other (they are declared together),
    // so this excludes exactly the same reducers as before: `unique` /
    // `top` / `samples` / `keep`. Gating here rather than falling back to
    // `reduceColumn(sliceByRange(...))` avoids carrying a second bucket
    // path that nothing exercises — a reducer that somehow had only the
    // whole-column form would take the row path, which is correct, just
    // slower.
    if (def.reduceColumnRange === undefined) return null;
    if (source.kind !== 'number' || source.storage !== 'packed') {
      return null; // non-numeric / chunked numeric source
    }
    plans.push({
      kind: 'reduce',
      column: source,
      reduce: def.reduceColumnRange,
    });
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
      out[p] = plan.reduce(plan.column, start, scan);
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
function intervalKeysForBuckets(
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
 *   copied), so a reducer that overflows to `Infinity` still raises the
 *   same `ValidationError` with the same message rather than silently
 *   landing a non-finite cell in a column flagged `allFinite`.
 * - Numeric columns are stamped `allFinite: true` on the same
 *   justification the row path uses — every surviving cell was
 *   finite-checked above. Dropping that flag would be safe but would
 *   quietly deoptimise every downstream reduction of an aggregate
 *   result.
 * - Missing cells (an empty bucket, or an all-missing one) set no
 *   validity bit, so they read back as `undefined` — **not** `NaN`. That
 *   is the sentinel decision this change forces, resolved in favour of
 *   preserving current behaviour exactly.
 *
 * The one row-intake check deliberately skipped is the non-decreasing
 * key scan: `BoundedSequence` already validates its intervals as sorted,
 * non-overlapping, and positive-duration at construction, so re-deriving
 * it per bucket would be checking the same fact twice.
 *
 * Returns `null` for the same disqualifying mappings as before; the
 * caller falls back to the unchanged row path.
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
          if (typeof value === 'number') {
            numberBufs[c]![b] = value;
            const bits = validityBits[c];
            // Bitmap exists ⇒ it covers every defined cell, so this
            // row's bit needs setting. No bitmap yet ⇒ every prior row
            // was defined and none is needed.
            if (bits !== null && bits !== undefined)
              bits[b >> 3]! |= 1 << (b & 7);
          } else {
            markMissing(c, b);
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
        // `allFinite: true` on the same grounds the row path claims it:
        // `assertCellKind` rejected every non-finite cell above, so a
        // surviving column is provably finite.
        column = new Float64Column(numberBufs[c]!, bucketCount, validity, true);
        break;
      case 'boolean':
        column = new BooleanColumn(booleanBufs[c]!, bucketCount, validity);
        break;
      case 'string':
        column = stringColumnFromArray(stringBufs[c]!);
        break;
      default:
        column = arrayColumnFromArray(
          arrayBufs[c]! as Parameters<typeof arrayColumnFromArray>[0],
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
 * `assertColumnValuesMatchKind` + re-pack over boxed values (each written
 * value is finite-asserted inline instead, same rejection class + message).
 *
 * Returns `null` — caller takes the generic sweep — when any column doesn't
 * qualify: a custom-function reducer, a non-`'number'` output kind
 * (`unique` / `samples` / `keep` over a non-number source / an explicit
 * `kind` override), or a non-numeric / chunked / missing source column.
 * All-or-nothing per call, matching {@link tryAggregateColumnarStore}.
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
      ),
    );
  }
  return results;
}

/**
 * One column's trailing / leading / centred count-window sweep.
 *
 * `avg` is specialised inline; everything else drives its reducer state,
 * which is now monomorphic at this call site. `avg` earns the special
 * case because it is what `sma` and the centre line of `bollinger` /
 * `zScore` reduce to, and its recurrence is a running sum — no accuracy
 * argument to preserve, unlike `stdev`, whose order-independent Welford
 * delete has exact `n <= 1` cases that are not worth duplicating.
 */
function sweepRollingColumn(
  spec: AggregateColumnSpec,
  source: Float64Column,
  rowCount: number,
  count: number,
  alignment: RollingAlignment,
  minSamples: number,
): Float64Column {
  const values = source._values;
  const validity = source.validity;
  const bits = validity?.bits ?? null;
  const allFinite = source.allFinite;

  const outValues = new Float64Array(rowCount);
  const outBits = new Uint8Array(bitmapByteCount(rowCount));
  let outDefined = 0;

  // A cell contributes iff it is defined and — when the source cannot
  // prove finiteness — finite. This reproduces both state variants the
  // shared sweep chose between: the bare built-in state (safe only when
  // the source is provably all-finite and fully defined) and the
  // `rollingStateFor` wrapper that applies the non-finite policy.
  const contributes = (i: number): boolean => {
    if (bits !== null && (bits[i >> 3]! & (1 << (i & 7))) === 0) return false;
    return allFinite || Number.isFinite(values[i]!);
  };

  // `avg` is a running sum; `stdev` is Welford. Both are inlined to remove
  // the per-row `add` / `remove` / `snapshot` calls; everything else keeps
  // its reducer state, which is monomorphic here now.
  const kind: 'avg' | 'stdev' | 'state' =
    spec.reducer === 'avg' || spec.reducer === 'mean'
      ? 'avg'
      : spec.reducer === 'stdev'
        ? 'stdev'
        : 'state';
  const state =
    kind !== 'state'
      ? null
      : allFinite && validity === undefined
        ? resolveReducer(spec.reducer as string).rollingState()
        : rollingStateFor(spec.reducer);

  // `avg`
  let runningSum = 0;
  let runningCount = 0;
  // `stdev` — Welford with an order-independent delete. Transcribed from
  // `reducers/stdev.ts`'s `rollingState` **verbatim**, including the two
  // exact-reset cases, because the value of that recurrence is entirely in
  // its numerical behaviour: the deviation-space mean update avoids the
  // `n·mean − v` product that loses precision at large magnitudes, and the
  // `n → 1` case is set directly because the reverse step alone leaves
  // rounding residue (~0.016 on 1e10 offsets). A "simplification" here would
  // be a silent accuracy regression, so the test asserts bit-equality against
  // the state object rather than closeness.
  let wN = 0;
  let wMean = 0;
  let wM2 = 0;

  const leftSpan = Math.floor((count - 1) / 2);
  const rightSpan = count - 1 - leftSpan;
  let windowStart = 0;
  let windowEnd = 0;

  for (let index = 0; index < rowCount; index += 1) {
    let lo: number;
    let hi: number;
    if (alignment === 'trailing') {
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
        if (contributes(windowEnd)) {
          runningSum += values[windowEnd]!;
          runningCount += 1;
        }
        windowEnd += 1;
      }
      while (windowStart < lo) {
        if (contributes(windowStart)) {
          runningSum -= values[windowStart]!;
          runningCount -= 1;
        }
        windowStart += 1;
      }
    } else if (kind === 'stdev') {
      while (windowEnd <= hi) {
        if (contributes(windowEnd)) {
          const v = values[windowEnd]!;
          wN += 1;
          const delta = v - wMean;
          wMean += delta / wN;
          wM2 += delta * (v - wMean);
        }
        windowEnd += 1;
      }
      while (windowStart < lo) {
        if (contributes(windowStart)) {
          const v = values[windowStart]!;
          if (wN <= 1) {
            // Removing the final contributor — reset exactly (no 0/0, no drift).
            wN = 0;
            wMean = 0;
            wM2 = 0;
          } else {
            const meanWith = wMean;
            wN -= 1;
            if (wN === 1) {
              // A single remaining element has population variance exactly 0.
              wMean = meanWith * 2 - v; // the survivor: 2·mean₂ − removed
              wM2 = 0;
            } else {
              // Deviation-space mean update, then reverse Welford.
              wMean = meanWith - (v - meanWith) / wN;
              wM2 -= (v - wMean) * (v - meanWith);
              if (wM2 < 0) wM2 = 0;
            }
          }
        }
        windowStart += 1;
      }
    } else {
      while (windowEnd <= hi) {
        state!.add(
          windowEnd,
          contributes(windowEnd) ? values[windowEnd]! : undefined,
        );
        windowEnd += 1;
      }
      while (windowStart < lo) {
        state!.remove(
          windowStart,
          contributes(windowStart) ? values[windowStart]! : undefined,
        );
        windowStart += 1;
      }
    }

    if (windowEnd - windowStart < minSamples) continue; // missing row

    const v =
      kind === 'avg'
        ? runningCount === 0
          ? undefined
          : runningSum / runningCount
        : kind === 'stdev'
          ? wN === 0
            ? undefined
            : Math.sqrt(Math.max(0, wM2 / wN))
          : state!.snapshot();
    if (v === undefined) continue; // missing cell (e.g. all-missing window)
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      // Same rejection class + message as the generic path's post-pass
      // `assertColumnValuesMatchKind` (e.g. a `sum` overflow to Infinity)
      // — checked at write time since there is no post-pass here.
      throw new ValidationError(
        `rolling column '${spec.output}': result ${String(v)} is not a valid 'number' value`,
      );
    }
    outValues[index] = v;
    outBits[index >> 3]! |= 1 << (index & 7);
    outDefined += 1;
  }

  const outValidity =
    outDefined === rowCount ? undefined : validityFromBits(outBits, rowCount);
  // Every written cell was finite-asserted above → `allFinite`.
  return new Float64Column(outValues, rowCount, outValidity, true);
}
