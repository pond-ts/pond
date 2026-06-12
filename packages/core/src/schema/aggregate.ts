import type {
  AppendColumn,
  ArrayColumnNameForSchema,
  ColumnDef,
  ColumnValue,
  OptionalizeColumns,
  ReplaceColumnKind,
  ScalarKind,
  SeriesSchema,
  ValueColumn,
  ValueColumnsForSchema,
} from './series.js';

export type AggregateFunction =
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'first'
  | 'last'
  | 'median'
  | 'stdev'
  | 'difference'
  | 'keep'
  | 'unique'
  | 'samples'
  | `p${number}`
  | `top${number}`;

/**
 * Custom aggregate reducers receive every value in a bucket (including
 * `undefined`) and return a single result. The return type is widened to
 * `ColumnValue` so reducers may emit an array — the resulting column's
 * schema kind is inferred as `'array'` when the custom reducer output is
 * declared via `AggregateOutputSpec.kind`.
 */
export type CustomAggregateReducer = (
  values: ReadonlyArray<ColumnValue | undefined>,
) => ColumnValue | undefined;

export type AggregateReducer = AggregateFunction | CustomAggregateReducer;

type AggregateFunctionsForKind<Kind extends ScalarKind> = Kind extends 'number'
  ? AggregateReducer
  : Kind extends 'array'
    ?
        | 'count'
        | 'first'
        | 'last'
        | 'keep'
        | 'unique'
        | 'samples'
        | `top${number}`
        | CustomAggregateReducer
    :
        | 'count'
        | 'first'
        | 'last'
        | 'keep'
        | 'unique'
        | 'samples'
        | `top${number}`
        | CustomAggregateReducer;

type ValueColumnByName<
  S extends SeriesSchema,
  Name extends ValueColumnsForSchema<S>[number]['name'],
> = Extract<ValueColumnsForSchema<S>[number], ColumnDef<Name, ScalarKind>>;

type AggregateReducerForColumn<
  S extends SeriesSchema,
  Name extends ValueColumnsForSchema<S>[number]['name'],
> = AggregateFunctionsForKind<ValueColumnByName<S, Name>['kind']>;

export type AggregateOutputSpec<
  S extends SeriesSchema,
  Name extends ValueColumnsForSchema<S>[number]['name'] =
    ValueColumnsForSchema<S>[number]['name'],
> = Readonly<{
  from: Name;
  using: AggregateReducerForColumn<S, Name>;
  kind?: ScalarKind;
}>;

/**
 * Unified per-output-key value for an aggregate / rolling / reduce
 * mapping. One mapping may freely mix two forms per key:
 *
 * - **Shorthand** — `cpu: 'avg'`: the key names a source column and the
 *   value is a reducer (built-in name or {@link CustomAggregateReducer}).
 *   Output name == source name == key.
 * - **Spec** — `cpu_p95: { from: 'cpu', using: 'p95' }`: the key names
 *   an arbitrary output column, `from` names the source column, `using`
 *   names the reducer. This is the only form that can apply multiple
 *   reducers to one source column or rename the output.
 *
 * This shape is deliberately permissive (any reducer or spec on any
 * key) — it is the *assignment* surface, used by implementation
 * signatures, internal delegation, and pre-widened values. The public
 * `aggregate` / `rolling` / `reduce` signatures additionally constrain
 * inline literals through {@link ValidatedAggregateMap}, which restores
 * the per-key compile-time guards the pre-unification overloads had.
 * The result schema dispatches per output key (see
 * {@link AggregateColumns}), so mixing the two forms keeps every output
 * column.
 *
 * Before v0.23.0 the two forms lived on separate overloads
 * (`AggregateMap` for shorthand, `AggregateOutputMap` for specs); a
 * mixed literal silently resolved to the shorthand overload and dropped
 * every spec-keyed output column from the result type (audit v2 §5 F1).
 * Collapsing to one overload over this unified map fixes that.
 */
export type AggregateMap<S extends SeriesSchema> = Readonly<
  Record<string, AggregateReducer | AggregateOutputSpec<S>>
>;

/**
 * Per-key validating constraint over a candidate mapping `M` — applied
 * by the public `aggregate` / `rolling` / `reduce` signatures on top of
 * the permissive {@link AggregateMap} shape, as a self-referential
 * constraint:
 *
 * ```ts
 * aggregate<const Mapping extends ValidatedAggregateMap<S, Mapping>>(
 *   sequence: SequenceLike,
 *   mapping: Mapping,
 * ): TimeSeries<AggregateSchema<S, Mapping>>;
 * ```
 *
 * Inference still comes from the argument (the `const` type parameter
 * keeps literal types); the constraint then checks each entry by key:
 *
 * - **Key names a source column** → a shorthand reducer must be valid
 *   for that column's kind ({@link AggregateFunctionsForKind} — so
 *   `host: 'avg'` on a `string` column is a compile error), or any
 *   spec.
 * - **Any other literal key** → spec form only. A bare reducer on an
 *   unknown key (`ghost: 'avg'`) is a typo the runtime rejects with
 *   "unknown source column"; this surfaces it at compile time instead.
 *
 * Spec values are intentionally NOT correlated between `from` and
 * `using` here — `AggregateOutputSpec<S>` checks `using` against the
 * union of all columns' reducers, not the specific `from` column's
 * (`{ from: 'host', using: 'avg' }` compiles; the runtime emits an
 * empty column). That looseness predates the unification; tightening it
 * requires a distributed spec union and is left as a follow-up so this
 * change stays guard-restoring only.
 *
 * Two deliberate escape hatches degrade to the permissive
 * {@link AggregateMap} shape:
 *
 * - **Broad schemas** (`TimeSeries<SeriesSchema>`) — there are no
 *   literal column names to validate against.
 * - **Pre-widened values** (a variable explicitly typed
 *   `AggregateMap<S>`, whose keys are an index signature) — validation
 *   applies to literal keys, which inline mapping literals always have.
 *
 * Internal generic call sites (live mirrors, partitioned delegation)
 * cannot prove a generic `M` satisfies its own validation and must not
 * call through the public overloads — they route through the loose
 * implementation paths instead (see the trust-boundary notes at those
 * sites).
 */
export type ValidatedAggregateMap<S extends SeriesSchema, M> = [
  ValueColumnsForSchema<S>,
] extends [never]
  ? AggregateMap<S> // schema too broad to extract value columns at all
  : string extends ValueColumnsForSchema<S>[number]['name']
    ? AggregateMap<S>
    : {
        readonly [K in keyof M]: K extends ValueColumnsForSchema<S>[number]['name']
          ?
              | AggregateFunctionsForKind<
                  ColumnKindByName<ValueColumnsForSchema<S>, K & string>
                >
              | AggregateOutputSpec<S>
          : string extends K
            ? AggregateReducer | AggregateOutputSpec<S>
            : AggregateOutputSpec<S>;
      };

/**
 * Back-compat alias for {@link AggregateMap}. Before v0.23.0 the
 * `{ from, using }` (renamed-output / multi-reducer) form lived on a
 * separate `AggregateOutputMap` type and a separate overload. The two
 * are now unified into {@link AggregateMap}, which accepts both the
 * shorthand and spec forms (and mixtures). Retained as an exported alias
 * so existing imports keep resolving.
 */
export type AggregateOutputMap<S extends SeriesSchema> = AggregateMap<S>;

/**
 * Look up a value column's kind by name within a value-column array.
 * Resolves to `never` when `Name` is not a column in `Columns`.
 */
type ColumnKindByName<
  Columns extends readonly ValueColumn[],
  Name extends string,
> = Extract<Columns[number], { name: Name }>['kind'];

/**
 * Output column kind for one mapping entry, dispatching on the entry's
 * shape. Resolves the four cases F1 unified:
 *
 * 1. **Explicit `kind`** on a spec wins — `{ from, using, kind }` emits
 *    `kind` regardless of reducer.
 * 2. **Spec** `{ from, using }` — kind inferred from `using`, with
 *    source-preserving reducers (`first`/`last`/`keep`) looking up the
 *    `from` column's kind.
 * 3. **Bare reducer** (shorthand) — output name == source name == the
 *    key `K`; kind inferred from the reducer, with source-preserving
 *    reducers looking up `K`'s column kind. A **custom reducer fn** in
 *    shorthand position falls back to the *source column's* kind (the
 *    pre-unification shorthand behavior — `cpu: (vals) => …` keeps
 *    `cpu`'s `number` kind), not the wide `ScalarKind`.
 * 4. **Custom reducer fn in a spec** (`{ from, using: fn }`) → `ScalarKind`
 *    fallback (runtime-determined output kind — the pre-unification spec
 *    behavior). This shorthand/spec asymmetry is preserved deliberately
 *    to keep the change types-only.
 *
 * Numeric-output and array-output reducer sets are enumerated inline and
 * must stay in sync with `ReduceResult` in `./reduce.ts`, the reducer
 * registry's `outputKind`, and `FusedReducerKind` in `./rolling.ts`.
 */
type UnifiedOutputKind<
  Columns extends readonly ValueColumn[],
  K extends string,
  V,
> = V extends { kind: infer ExplicitKind extends ScalarKind }
  ? ExplicitKind
  : V extends { from: infer From extends string; using: infer Using }
    ? // spec: custom-fn fallback is the wide ScalarKind
      ReducerOutputKind<Columns, From, Using, ScalarKind>
    : // bare reducer (shorthand): output name == source name == key.
      // custom-fn fallback is the source column's own kind.
      ReducerOutputKind<
        Columns,
        K,
        V,
        K extends Columns[number]['name']
          ? ColumnKindByName<Columns, K>
          : ScalarKind
      >;

/**
 * Reducer-string-to-output-kind dispatch shared by the spec and
 * shorthand branches of {@link UnifiedOutputKind}. `From` is the source
 * column name (the spec's `from`, or the shorthand key); `Using` is the
 * reducer; `Fallback` is the kind to use when `Using` is a custom
 * reducer function (or otherwise unrecognized) — the spec branch passes
 * `ScalarKind`, the shorthand branch passes the source column's kind.
 */
type ReducerOutputKind<
  Columns extends readonly ValueColumn[],
  From extends string,
  Using,
  Fallback extends ScalarKind,
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
      ? From extends Columns[number]['name']
        ? ColumnKindByName<Columns, From>
        : ScalarKind
      : Fallback;

/**
 * Union of typed `ColumnDef`s — one per **output key** in the mapping
 * (not per source column). Used as the `...Rest` of the schema tuple;
 * the result is a `readonly [FirstColumn, ...Array<ColumnDefUnion>]`.
 * `DataColumnsForSchema` + `EventDataForSchema` flatten that union into
 * the right combined record so `event.get(outputName)` narrows correctly
 * per output key — including spec-keyed outputs whose names are not
 * source-column names. Iterating output keys (rather than source
 * columns, as the pre-v0.23.0 implementation did) is what keeps mixed
 * shorthand+spec mappings from dropping their spec-keyed columns (F1).
 */
export type AggregateColumns<
  Columns extends readonly ValueColumn[],
  Mapping,
> = {
  [K in keyof Mapping & string]: ColumnDef<
    K,
    UnifiedOutputKind<Columns, K, Mapping[K]>
  > & {
    readonly required: false;
  };
}[keyof Mapping & string];

export type AggregateSchema<S extends SeriesSchema, Mapping> = readonly [
  ColumnDef<'interval', 'interval'>,
  ...Array<AggregateColumns<ValueColumnsForSchema<S>, Mapping>>,
];

export type AlignSchema<S extends SeriesSchema> = readonly [
  ColumnDef<'interval', 'interval'>,
  ...OptionalizeColumns<ValueColumnsForSchema<S>>,
];

/**
 * Output schema of `TimeSeries.materialize(...)`. The first column is
 * always `time` (regardless of input key kind — materialize emits one
 * row per sequence bucket sample point, time-keyed by design). Value
 * columns are widened to optional because empty buckets emit
 * `undefined` cells.
 */
export type MaterializeSchema<S extends SeriesSchema> = readonly [
  ColumnDef<'time', 'time'>,
  ...OptionalizeColumns<ValueColumnsForSchema<S>>,
];

// ---------------------------------------------------------------------------
// Back-compat aliases — the all-spec ("output-map") result schemas now
// resolve through the same unified path as the shorthand ones. Before
// v0.23.0 these were distinct types fed by separate overloads; the F1 fix
// (audit v2 §5) collapsed the overload pairs, so both shapes share
// `AggregateColumns` / `AggregateSchema`. Retained as exported aliases so
// existing imports (live mirrors, partitioned series) keep resolving.
// ---------------------------------------------------------------------------

/**
 * Schema for `rolling(window, mapping)`. Preserves the source's
 * first-column kind (`S[0]`) and narrows each output column per the
 * unified per-key dispatch in {@link AggregateColumns}. Now identical to
 * `RollingSchema` — kept as an alias for back-compat.
 */
export type RollingOutputMapSchema<S extends SeriesSchema, Mapping> = readonly [
  S[0],
  ...Array<AggregateColumns<ValueColumnsForSchema<S>, Mapping>>,
];

/**
 * Schema for sequence-driven `rolling(seq, window, mapping)` and for
 * `aggregate(seq, mapping)`. The first column is the `'interval'` key
 * produced by the sequence. Now identical to {@link AggregateSchema} —
 * kept as an alias for back-compat.
 */
export type AggregateOutputMapResultSchema<
  S extends SeriesSchema,
  Mapping,
> = AggregateSchema<S, Mapping>;

// ---------------------------------------------------------------------------
// Array-aggregate and array-explode output schemas
// ---------------------------------------------------------------------------

/**
 * Aggregate functions that always produce a numeric result regardless of
 * source column kind. Matches the reducer registry's `outputKind: 'number'`.
 */
type NumericAggregateFunction =
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'median'
  | 'stdev'
  | 'difference'
  | `p${number}`;

/**
 * Output column kind for `arrayAggregate(col, reducer, { kind? })`.
 * Numeric reducers → `'number'`, `'unique'` → `'array'`, `'first'`/`'last'`/
 * `'keep'` and custom functions → `'string'` unless the caller passes an
 * explicit `kind`.
 */
export type ArrayAggregateKind<
  Op extends AggregateReducer,
  ExplicitKind extends ScalarKind | undefined = undefined,
> = ExplicitKind extends ScalarKind
  ? ExplicitKind
  : Op extends NumericAggregateFunction
    ? 'number'
    : Op extends 'unique' | 'samples' | `top${number}`
      ? 'array'
      : 'string';

/**
 * Schema for `arrayAggregate(col, reducer)` replacing the array column
 * in place with the reducer's output kind.
 */
export type ArrayAggregateReplaceSchema<
  S extends SeriesSchema,
  Col extends ArrayColumnNameForSchema<S>,
  Op extends AggregateReducer,
  ExplicitKind extends ScalarKind | undefined = undefined,
> = readonly [
  S[0],
  ...ReplaceColumnKind<
    ValueColumnsForSchema<S>,
    Col,
    ArrayAggregateKind<Op, ExplicitKind>
  >,
];

/**
 * Schema for `arrayAggregate(col, reducer, { as })` — appends a new column
 * carrying the reducer's output and keeps the source array column intact.
 */
export type ArrayAggregateAppendSchema<
  S extends SeriesSchema,
  Name extends string,
  Op extends AggregateReducer,
  ExplicitKind extends ScalarKind | undefined = undefined,
> = AppendColumn<S, Name, ArrayAggregateKind<Op, ExplicitKind>>;

/**
 * Schema for `arrayExplode(col)` replacing the array column in place with
 * a scalar column (default kind `'string'`).
 */
export type ArrayExplodeReplaceSchema<
  S extends SeriesSchema,
  Col extends ArrayColumnNameForSchema<S>,
  OutputKind extends ScalarKind = 'string',
> = readonly [
  S[0],
  ...ReplaceColumnKind<ValueColumnsForSchema<S>, Col, OutputKind>,
];

/**
 * Schema for `arrayExplode(col, { as })` — appends a scalar column with the
 * per-element value and keeps the source array column intact; each output
 * event still carries the full array on that source column.
 */
export type ArrayExplodeAppendSchema<
  S extends SeriesSchema,
  Name extends string,
  OutputKind extends ScalarKind = 'string',
> = AppendColumn<S, Name, OutputKind>;
