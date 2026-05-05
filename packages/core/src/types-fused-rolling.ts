import type {
  AggregateMap,
  AggregateOutputMap,
  ColumnDef,
  ScalarKind,
  SeriesSchema,
} from './types.js';

/**
 * Types for the fused multi-window rolling primitive
 * (`live.rolling({ '1m': m1, '200ms': m2 }, opts)`). See PLAN.md
 * "Fused multi-window rolling + buffer-as-window unification" for
 * the design rationale; gRPC RFC pond-grpc-experiment#20 for the
 * detailed surface and acceptance criteria.
 *
 * The keyed-record form is the only fused-rolling API. Per-window
 * options use an elaborated value form (`{ mapping, minSamples }`);
 * per-window cadence is explicitly NOT supported (single trigger
 * across all windows is by design — that's what fusion saves).
 */

/**
 * Duration-string keys for {@link FusedMapping}. Constrains record
 * keys to `${number}${'ms'|'s'|'m'|'h'|'d'}` plus the `'buffer'`
 * sentinel (which resolves to the source's retention at construct
 * time). Catches typos like `'1min'` at compile time.
 *
 * Also accepts plain `number` for the rare case where a key is
 * computed at runtime; runtime parsing handles ms-as-string and
 * number alike via the existing `RollingWindow` shape.
 */
export type DurationString =
  | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
  | 'buffer';

/**
 * Elaborated per-window value form. Carries options that apply to
 * just this window (currently `minSamples`); top-level options
 * (`{ trigger, minSamples }`) apply as defaults across all windows
 * and per-window elaborated `minSamples` overrides for that window.
 */
export type FusedMappingElaborated<S extends SeriesSchema> = Readonly<{
  mapping: AggregateMap<S> | AggregateOutputMap<S>;
  minSamples?: number;
}>;

/**
 * Value form for one window in a {@link FusedMapping}. Either:
 * - A bare {@link AggregateMap} (key = source column, value = reducer)
 * - A bare {@link AggregateOutputMap} (key = output alias, value = `{ from, using }`)
 * - An {@link FusedMappingElaborated} wrapper for per-window options
 *
 * The two bare forms match the existing `live.rolling(window, mapping, ...)`
 * value shapes — fused rolling accepts either uniformly.
 */
export type FusedMappingValue<S extends SeriesSchema> =
  | AggregateMap<S>
  | AggregateOutputMap<S>
  | FusedMappingElaborated<S>;

/**
 * Keyed-record fused-rolling mapping. Each entry declares a window
 * (the key) and what to reduce over that window (the value).
 *
 * **Constraint: time-based windows only.** Object keys are duration
 * strings or the `'buffer'` sentinel. Count-based windows
 * (`live.rolling(100, ...)`) stay on the existing single-window
 * overload and are not mixable with time-windows in the fused form.
 *
 * @example
 * const mapping = {
 *   '1m':    { cpu_avg: 'avg', cpu_sd: 'stdev', cpu_n: 'count' },
 *   '200ms': { cpu_samples: 'samples' },
 * } as const;
 */
export type FusedMapping<S extends SeriesSchema> = Readonly<
  Record<string, FusedMappingValue<S>>
>;

/**
 * Peel off the {@link FusedMappingElaborated} wrapper if present,
 * returning the inner mapping. Used by {@link FusedRollingColumns}
 * to compute output columns uniformly across both bare and
 * elaborated value forms.
 */
type InnerMapping<V> =
  V extends FusedMappingElaborated<SeriesSchema> ? V['mapping'] : V;

/**
 * Compute the output column kind for one mapping entry. Handles
 * both `AggregateOutputMap` form (`{ from, using, kind? }`) and
 * `AggregateMap` form (key is a source column name, value is a
 * reducer string or `CustomAggregateReducer`).
 *
 * Aligned with `OutputSpecKind` in `./types-aggregate.ts` —
 * keep the two in sync if the reducer registry grows.
 */
type FusedColumnKind<
  S extends SeriesSchema,
  Key extends string,
  Value,
> = Value extends { kind: infer K extends ScalarKind }
  ? K
  : Value extends { from: infer From extends string; using: infer Using }
    ? FusedReducerKind<S, From, Using>
    : // AggregateMap form: synthesize { from: Key, using: Value }
      FusedReducerKind<S, Key, Value>;

/**
 * Reducer-string-to-output-kind dispatch, shared by both AggregateMap
 * and AggregateOutputMap entry shapes.
 */
type FusedReducerKind<
  S extends SeriesSchema,
  From extends string,
  Using,
> = Using extends
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'median'
  | 'stdev'
  | 'difference'
  | `p${number}`
  ? 'number'
  : Using extends 'unique' | 'samples' | `top${number}`
    ? 'array'
    : Using extends 'first' | 'last' | 'keep'
      ? FromColumnKind<S, From>
      : ScalarKind;

/**
 * Look up the kind of a value column by name. Used by source-
 * preserving reducers (`first` / `last` / `keep`) where the output
 * kind matches the source column's kind.
 */
type FromColumnKind<S extends SeriesSchema, From extends string> = Extract<
  S[number],
  ColumnDef<From, any>
>['kind'];

/**
 * Compute the union of `ColumnDef`s produced by one window's mapping.
 * Iterates over every key in the mapping (each becomes an output
 * column) and resolves its kind via {@link FusedColumnKind}.
 */
type WindowColumns<S extends SeriesSchema, M> = {
  [K in keyof M & string]: ColumnDef<K, FusedColumnKind<S, K, M[K]>> & {
    readonly required: false;
  };
}[keyof M & string];

/**
 * Compute the union of all output columns across all windows in a
 * {@link FusedMapping}. Each window contributes its own columns;
 * the result is a flat union (not a nested record), suitable for
 * use as the `...rest` of a schema tuple.
 *
 * Duplicate output column names across different windows are not
 * caught at this layer — runtime detects them at construction with
 * a clear error. Compile-time uniqueness check is parked as a
 * follow-up (see PLAN.md "TypeScript surface" — point 2).
 */
type FusedRollingColumns<S extends SeriesSchema, FM> = {
  [W in keyof FM]: WindowColumns<S, InnerMapping<FM[W]>>;
}[keyof FM];

/**
 * Output schema for `live.rolling(fusedMapping, opts)` on a non-
 * partitioned source. Preserves the source's first-column kind
 * (matches today's `RollingSchema<S, M>` for the single-window
 * case) and unions every window's output columns into the rest.
 */
export type FusedRollingSchema<S extends SeriesSchema, FM> = readonly [
  S[0],
  ...Array<FusedRollingColumns<S, FM>>,
];

/**
 * Output schema for the partitioned variant —
 * `partitionBy('host').rolling(fusedMapping, { trigger })`.
 * Auto-injects the partition column once at the front of the merged
 * output, never per-window. Matches the existing
 * `LivePartitionedSyncRolling` schema shape.
 */
export type FusedPartitionedRollingSchema<
  S extends SeriesSchema,
  ByCol extends string,
  FM,
> = readonly [
  ColumnDef<'time', 'time'>,
  ColumnDef<ByCol, FromColumnKind<S, ByCol> & string> & {
    readonly required: false;
  },
  ...Array<FusedRollingColumns<S, FM>>,
];
