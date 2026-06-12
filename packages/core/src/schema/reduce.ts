import type {
  ColumnValue,
  SeriesSchema,
  ValueColumnsForSchema,
} from './series.js';

/**
 * Lookup the declared column definition for a given column name in a
 * schema. Narrows to the matching `ColumnDef`, or `never` if `Name`
 * isn't a value-column name in `S`.
 */
type ColumnByName<S extends SeriesSchema, Name extends string> = Extract<
  ValueColumnsForSchema<S>[number],
  { name: Name }
>;

/**
 * Per-entry narrowed output type for `TimeSeries.reduce(mapping)`. For
 * an `AggregateMap` with literal reducer names, each field narrows to
 * the specific value kind the reducer produces:
 *
 * ```ts
 * series.reduce({ cpu: 'avg', host: 'unique' });
 * //    ^ { cpu: number | undefined;
 * //        host: ReadonlyArray<ScalarValue> | undefined }
 * ```
 *
 * The branches are enumerated inline (rather than delegated to
 * `AggregateKindForColumn` + `NormalizedValueForKind`) because the
 * inlined form is the only shape TypeScript accepts in the same
 * compilation unit as the `arrayAggregate` / `arrayExplode` overloads —
 * more-delegated variants trip TS2394 on those overloads' compatibility
 * with their implementation signature. The narrow logic is intentionally
 * duplicated here; keep it in sync with `AggregateKindForColumn` in
 * `./aggregate.ts` if the set of numeric / array-producing reducers
 * changes.
 *
 * Branches:
 *
 * - Numeric-output reducers (`'sum'`, `'avg'`, `'count'`, `'median'`,
 *   `'stdev'`, `'difference'`, any `p${number}`) → `number | undefined`.
 * - Array-output reducers (`'unique'`, `'samples'`, any `top${number}`) →
 *   `ReadonlyArray<T> | undefined`, where `T` is the source column's
 *   element type — `ReadonlyArray<string>` for a `kind: 'string'`
 *   column, `ReadonlyArray<number>` for `kind: 'number'`, etc.
 *   Array-kind source columns fall back to the wide
 *   `ReadonlyArray<ScalarValue> | undefined`.
 * - Source-preserving reducers (`'first'`, `'last'`, `'keep'`) → the
 *   source column's value type (`number`, `string`, or `boolean` —
 *   `undefined` included). Array-kind source columns fall back to
 *   `ColumnValue | undefined` because tracking element kind is out of
 *   scope for the schema.
 * - **Spec entries** (`{ from, using }`, `{ from, using, kind }`) narrow
 *   the same way, sourcing the column kind from `from` rather than the
 *   key. An explicit `kind` on the spec widens to that kind's value
 *   type. Before v0.23.0 a spec entry in `reduce` fell back to the wide
 *   `ColumnValue | undefined` (audit v2 §5 F1) — it now narrows per
 *   reducer.
 * - Custom reducer functions fall back to `ColumnValue | undefined` —
 *   their output kind is set at runtime and the type system can't see
 *   through it.
 *
 * The spec and shorthand branches share `ReduceValueForReducer`, which
 * stays inline (nested conditionals, no delegation to schema-layer kind
 * types) to keep the type compatible with the `arrayAggregate` /
 * `arrayExplode` overloads' implementation signature — see the note
 * above on TS2394.
 */
export type ReduceResult<S extends SeriesSchema, Mapping> = {
  [K in keyof Mapping & string]: Mapping[K] extends {
    kind: infer ExplicitKind;
  }
    ? ValueForScalarKind<ExplicitKind>
    : Mapping[K] extends { from: infer From extends string; using: infer Using }
      ? ReduceValueForReducer<S, From, Using>
      : ReduceValueForReducer<S, K, Mapping[K]>;
};

/**
 * Value type one reducer produces over a source column named `From`.
 * Inline (no schema-layer delegation) — shared by `ReduceResult`'s spec
 * and shorthand branches. `From` is the spec's `from` or the shorthand
 * key; `Using` is the reducer.
 */
type ReduceValueForReducer<
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
  ? number | undefined
  : Using extends 'unique' | 'samples' | `top${number}`
    ? From extends ValueColumnsForSchema<S>[number]['name']
      ? ColumnByName<S, From>['kind'] extends 'number'
        ? ReadonlyArray<number> | undefined
        : ColumnByName<S, From>['kind'] extends 'string'
          ? ReadonlyArray<string> | undefined
          : ColumnByName<S, From>['kind'] extends 'boolean'
            ? ReadonlyArray<boolean> | undefined
            : ReadonlyArray<string | number | boolean> | undefined
      : ReadonlyArray<string | number | boolean> | undefined
    : Using extends 'first' | 'last' | 'keep'
      ? From extends ValueColumnsForSchema<S>[number]['name']
        ? ColumnByName<S, From>['kind'] extends 'number'
          ? number | undefined
          : ColumnByName<S, From>['kind'] extends 'string'
            ? string | undefined
            : ColumnByName<S, From>['kind'] extends 'boolean'
              ? boolean | undefined
              : ColumnValue | undefined
        : ColumnValue | undefined
      : ColumnValue | undefined;

/**
 * Value type for an explicit `kind` on a reduce spec. Mirrors
 * `NormalizedValueForKind` but stays inline here for the same TS2394
 * reason as {@link ReduceValueForReducer}.
 */
type ValueForScalarKind<K> = K extends 'number'
  ? number | undefined
  : K extends 'string'
    ? string | undefined
    : K extends 'boolean'
      ? boolean | undefined
      : K extends 'array'
        ? ReadonlyArray<string | number | boolean> | undefined
        : ColumnValue | undefined;
