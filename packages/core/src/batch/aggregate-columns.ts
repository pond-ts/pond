import { resolveReducer } from '../reducers/index.js';
import type { Column, Float64Column } from '../columnar/index.js';
import type {
  AggregateMap,
  AggregateOutputMap,
  AggregateOutputSpec,
  AggregateReducer,
  ColumnValue,
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
 * Returns `null` — caller takes the unchanged row path — when any column
 * doesn't qualify: a custom-function reducer, a reducer with no
 * `reduceColumn` (`first` / `last` / `unique` / `top` / `samples`), or a
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
export function tryAggregateColumnarTimeKeyed<
  B extends { begin(): number; end(): number },
>(
  begins: Float64Array,
  getColumn: (name: string) => Column | undefined,
  buckets: ReadonlyArray<B>,
  columns: ReadonlyArray<AggregateColumnSpec>,
): Array<ReadonlyArray<unknown>> | null {
  const plans: Array<{
    column: Float64Column;
    reduce: (col: Float64Column) => ColumnValue | undefined;
  }> = [];
  for (const spec of columns) {
    if (typeof spec.reducer !== 'string') return null; // custom function
    const def = resolveReducer(spec.reducer);
    if (def.reduceColumn === undefined) return null; // first/last/unique/...
    const source = getColumn(spec.source);
    if (
      source === undefined ||
      source.kind !== 'number' ||
      source.storage !== 'packed'
    ) {
      return null; // non-numeric / chunked / missing source
    }
    plans.push({ column: source, reduce: def.reduceColumn });
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
      reduced[p] = plan.reduce(plan.column.sliceByRange(start, scan));
    }
    rows[b] = Object.freeze([bucket, ...reduced]);
  }
  return rows;
}
