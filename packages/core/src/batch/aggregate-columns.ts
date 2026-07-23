import { resolveReducer, rollingStateFor } from '../reducers/index.js';
import type { Column } from '../columnar/index.js';
import {
  Float64Column,
  bitmapByteCount,
  validityFromBits,
} from '../columnar/index.js';
import { ValidationError } from '../core/errors.js';
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

/**
 * **Phase 4.7 step 3B — columnar fast path for time-keyed `aggregate()`.**
 * On sorted time-keyed data each bucket is a contiguous index range, so
 * when every mapped column is a built-in numeric reducer with a
 * `reduceColumn` fast path over a **packed `Float64Column`** source, each
 * bucket reduces straight off the typed-array slice — skipping the
 * `series.events` materialization and the per-cell `state.add` walk the
 * row path pays. Reuses the shipped step-3A `reduceColumn` kernels
 * (sum/min/max/avg 59–73×, stdev 35×, median/p95 3.4×) per bucket.
 *
 * `first` / `last` also qualify, on **any** column kind / storage, via a
 * boundary scan (the first/last *defined* cell in the bucket — see
 * `ReducerDef.definedBoundary`). This is what lets a partitioned
 * `aggregate` take the fast path: its auto-injected partition-column
 * reducer is `'first'`, which previously tripped the all-or-nothing gate
 * for every partitioned call.
 *
 * Returns `null` — caller takes the unchanged row path — when any column
 * doesn't qualify: a custom-function reducer; a reducer that is neither a
 * numeric `reduceColumn` kernel nor a `first`/`last` boundary selector
 * (`unique` / `top` / `samples` / `keep`); or a numeric reducer over a
 * non-numeric / chunked / missing source column. All-or-nothing per call
 * keeps the bucket walk single-pass; mixed mappings fall back wholesale.
 *
 * `begins` is the key column's begin axis (sorted, identical row order to
 * the value columns — both read straight off the store). Bucketing
 * replicates the row path exactly: `cursor` carries across buckets, and a
 * bucket owns `[start, scan)` where `begins[i] ∈ [bucket.begin,
 * bucket.end)`. Empty buckets reduce an empty slice — the reducer's
 * empty-input result (the step-3A parity contract guarantees this matches
 * a zero-`add` bucket snapshot).
 */
type ColumnarAggregatePlan =
  | {
      kind: 'reduce';
      column: Float64Column;
      reduce: (col: Float64Column) => ColumnValue | undefined;
    }
  | { kind: 'boundary'; column: Column; which: 'first' | 'last' };

export function tryAggregateColumnarTimeKeyed<
  B extends { begin(): number; end(): number },
>(
  begins: Float64Array,
  getColumn: (name: string) => Column | undefined,
  buckets: ReadonlyArray<B>,
  columns: ReadonlyArray<AggregateColumnSpec>,
): Array<ReadonlyArray<unknown>> | null {
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

    if (def.reduceColumn === undefined) return null; // unique / top / samples / keep
    if (source.kind !== 'number' || source.storage !== 'packed') {
      return null; // non-numeric / chunked numeric source
    }
    plans.push({ kind: 'reduce', column: source, reduce: def.reduceColumn });
  }

  const n = begins.length;
  let cursor = 0;
  const rows: Array<ReadonlyArray<unknown>> = new Array(buckets.length);
  for (let b = 0; b < buckets.length; b += 1) {
    const bucket = buckets[b]!;
    const bucketBegin = bucket.begin();
    const bucketEnd = bucket.end();
    while (cursor < n && begins[cursor]! < bucketBegin) cursor += 1;
    const start = cursor;
    let scan = start;
    while (scan < n && begins[scan]! < bucketEnd) scan += 1;
    cursor = scan;

    const reduced: Array<ColumnValue | undefined> = new Array(plans.length);
    for (let p = 0; p < plans.length; p += 1) {
      const plan = plans[p]!;
      if (plan.kind === 'reduce') {
        reduced[p] = plan.reduce(plan.column.sliceByRange(start, scan));
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
        reduced[p] = value;
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
        reduced[p] = value;
      }
    }
    rows[b] = Object.freeze([bucket, ...reduced]);
  }
  return rows;
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
 * All-or-nothing per call, matching {@link tryAggregateColumnarTimeKeyed}.
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

  // An all-finite fully-defined source feeds its reducer state the raw
  // buffer values, so the `rollingStateFor` non-finite skip wrapper is
  // provably an identity there — resolve the bare built-in state instead
  // and drop one call layer from every add / remove / snapshot. Any other
  // source keeps the wrapped state (same values, same skip policy).
  const states = columns.map((spec, c) => {
    const source = sources[c]!;
    return source.allFinite && source.validity === undefined
      ? resolveReducer(spec.reducer as string).rollingState()
      : rollingStateFor(spec.reducer);
  });
  const srcValues = sources.map((col) => col._values);
  const srcValidity = sources.map((col) => col.validity);
  const outValues = columns.map(() => new Float64Array(rowCount));
  const outBits = columns.map(() => new Uint8Array(bitmapByteCount(rowCount)));
  const outDefined = new Array<number>(specCount).fill(0);

  // Feed the states exactly what the generic sweep's `col.read(index)`
  // yields: `undefined` for a missing cell, the raw (possibly non-finite)
  // number otherwise — the non-finite skip stays inside the shared state
  // wrapper so the contributor set can't drift between the two paths.
  const addAt = (index: number): void => {
    for (let c = 0; c < specCount; c += 1) {
      const validity = srcValidity[c];
      const value =
        validity === undefined || validity.isDefined(index)
          ? srcValues[c]![index]!
          : undefined;
      states[c]!.add(index, value);
    }
  };
  const removeAt = (index: number): void => {
    for (let c = 0; c < specCount; c += 1) {
      const validity = srcValidity[c];
      const value =
        validity === undefined || validity.isDefined(index)
          ? srcValues[c]![index]!
          : undefined;
      states[c]!.remove(index, value);
    }
  };

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
    while (windowEnd <= hi) {
      addAt(windowEnd);
      windowEnd += 1;
    }
    while (windowStart < lo) {
      removeAt(windowStart);
      windowStart += 1;
    }
    if (windowEnd - windowStart < minSamples) continue; // missing row
    for (let c = 0; c < specCount; c += 1) {
      const v = states[c]!.snapshot();
      if (v === undefined) continue; // missing cell (e.g. all-missing window)
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        // Same rejection class + message as the generic path's post-pass
        // `assertColumnValuesMatchKind` (e.g. a `sum` overflow to Infinity)
        // — checked at write time since there is no post-pass here.
        throw new ValidationError(
          `rolling column '${columns[c]!.output}': result ${String(v)} is not a valid 'number' value`,
        );
      }
      outValues[c]![index] = v;
      outBits[c]![index >> 3]! |= 1 << (index & 7);
      outDefined[c] = outDefined[c]! + 1;
    }
  }

  return columns.map((_, c) => {
    const validity =
      outDefined[c] === rowCount
        ? undefined
        : validityFromBits(outBits[c]!, rowCount);
    // Every written cell was finite-asserted above → `allFinite`.
    return new Float64Column(outValues[c]!, rowCount, validity, true);
  });
}
