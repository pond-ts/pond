import type {
  IntervalInput,
  TimeRangeInput,
  TimestampInput,
} from '../core/temporal.js';
import type { Interval } from '../core/interval.js';
import type { Time } from '../core/time.js';
import type { TimeRange } from '../core/time-range.js';

/** Marker symbol for sources that emit `'evict'` events. @internal */
export const EMITS_EVICT: unique symbol = Symbol.for('pond-ts:emitsEvict');

export type ScalarKind = 'number' | 'string' | 'boolean' | 'array';
export type ScalarValue = number | string | boolean;

/**
 * A read-only array of scalars. Array-kind columns carry values of this type.
 * Currently populated by reducers that collapse a bucket into a list
 * (e.g. `unique`). Inert with respect to numerical operators (`diff`, `rate`,
 * `cumulative`, `rolling`) — those filter to `kind: 'number'` columns.
 */
export type ArrayValue = ReadonlyArray<ScalarValue>;

/**
 * Anything a value column cell may hold at runtime. Widens `ScalarValue`
 * with `ArrayValue` for columns declared `kind: 'array'`.
 */
export type ColumnValue = ScalarValue | ArrayValue;
export type FirstColKind = 'time' | 'interval' | 'timeRange';

export type ColumnDef<Name extends string, Kind extends string> = {
  name: Name;
  kind: Kind;
  required?: boolean;
};

/**
 * The key (first) column of a schema. Its **name must equal its kind** —
 * `time` / `timeRange` / `interval`. So `{ name: 'time', kind: 'time' }` is the
 * only valid time key; `{ name: 'at', kind: 'time' }` does **not** typecheck
 * (the error surfaces as a name/literal-type mismatch, e.g. `'"at"' is not
 * assignable to '"time"'` — read it as "the key column must be named for its
 * kind", not as a value error). Value columns, by contrast, take any name.
 */
export type FirstColumn =
  | ColumnDef<'time', 'time'>
  | ColumnDef<'interval', 'interval'>
  | ColumnDef<'timeRange', 'timeRange'>;

export type ValueColumn<Name extends string = string> = ColumnDef<
  Name,
  ScalarKind
>;

export type SeriesSchema = readonly [FirstColumn, ...ValueColumn[]];

export type ValueColumnsForSchema<S extends SeriesSchema> = S extends readonly [
  FirstColumn,
  ...infer Rest,
]
  ? Rest extends readonly ValueColumn[]
    ? Rest
    : never
  : never;

export type ValueForKind<K extends string> = K extends 'time'
  ? TimestampInput | Time
  : K extends 'interval'
    ? IntervalInput | Interval
    : K extends 'timeRange'
      ? TimeRangeInput | TimeRange
      : K extends 'number'
        ? number
        : K extends 'string'
          ? string
          : K extends 'boolean'
            ? boolean
            : K extends 'array'
              ? ArrayValue
              : never;

export type NormalizedValueForKind<K extends string> = K extends 'time'
  ? Time
  : K extends 'timeRange'
    ? TimeRange
    : K extends 'interval'
      ? Interval
      : K extends 'number'
        ? number
        : K extends 'string'
          ? string
          : K extends 'boolean'
            ? boolean
            : K extends 'array'
              ? ArrayValue
              : never;

export type KindForValue<V extends ScalarValue> = V extends number
  ? 'number'
  : V extends string
    ? 'string'
    : 'boolean';

/**
 * Tuple-row input type for a schema. A column declared `required: false`
 * accepts `undefined` in its cell (a missing value — the constructor records
 * it in the validity bitmap), matching the runtime's intake. `null` is **not**
 * admitted: the tuple-row constructor rejects it (only the JSON object-row path
 * accepts `null`), so the type stays honest to what intake actually takes —
 * pass `undefined` for a missing tuple cell. (estela F-geo-row-optional.)
 */
export type RowForSchema<S extends readonly ColumnDef<string, string>[]> = {
  [I in keyof S]: S[I] extends ColumnDef<any, infer K>
    ? I extends '0'
      ? ValueForKind<K> // the key (first) column is always required at runtime
      : S[I] extends { required: false }
        ? ValueForKind<K> | undefined
        : ValueForKind<K>
    : never;
};

export type NumericColumnNameForSchema<S extends SeriesSchema> = Extract<
  ValueColumnsForSchema<S>[number],
  ColumnDef<string, 'number'>
>['name'];

/**
 * Names of value columns whose declared kind is `'array'`. Used as the
 * parameter constraint on array-column operators (`includes`, `count`,
 * `contains`, `explode`).
 */
export type ArrayColumnNameForSchema<S extends SeriesSchema> = Extract<
  ValueColumnsForSchema<S>[number],
  ColumnDef<string, 'array'>
>['name'];

/**
 * Resolves the `kind` of the value column named `V` on schema `S`. Used by
 * the typed `pivotByGroup` overload to propagate the source value column's
 * kind to every output column in the wide schema.
 */
export type ValueColumnKindForName<
  S extends SeriesSchema,
  V extends string,
> = Extract<ValueColumnsForSchema<S>[number], { name: V }>['kind'];

/**
 * Names of all value columns in schema `S`, regardless of kind. Used by
 * the public `series.column(name)` accessor (RFC §7.2) to constrain
 * `name` to a schema-valid value column at compile time — typos and
 * key-column names fail to compile rather than returning `undefined`
 * at runtime.
 */
export type ValueColumnNameForSchema<S extends SeriesSchema> =
  ValueColumnsForSchema<S>[number]['name'];

// ---------------------------------------------------------------------------
// Column-tuple transforms — shared private helpers used across the schema
// layer (aggregate, diff, reshape, join). Kept here so each derivation file
// imports from a single foundation rather than duplicating.
// ---------------------------------------------------------------------------

export type OptionalizeColumn<Column extends ValueColumn> =
  Column extends ColumnDef<infer Name, infer Kind>
    ? ColumnDef<Name, Kind> & { readonly required: false }
    : never;

export type OptionalizeColumns<Columns extends readonly ValueColumn[]> =
  Columns extends readonly [infer Head, ...infer Tail]
    ? Head extends ValueColumn
      ? Tail extends readonly ValueColumn[]
        ? [OptionalizeColumn<Head>, ...OptionalizeColumns<Tail>]
        : []
      : []
    : [];

export type OptionalNumberColumn<Name extends string> = ColumnDef<
  Name,
  'number'
> & {
  readonly required: false;
};

export type AppendColumn<
  S extends SeriesSchema,
  Name extends string,
  Kind extends ScalarKind,
> = readonly [S[0], ...ValueColumnsForSchema<S>, ColumnDef<Name, Kind>];

export type ReplaceColumnKind<
  Columns extends readonly ValueColumn[],
  Target extends string,
  NewKind extends ScalarKind,
> = Columns extends readonly [infer Head, ...infer Tail]
  ? Head extends ValueColumn
    ? Tail extends readonly ValueColumn[]
      ? Head['name'] extends Target
        ? [
            ColumnDef<Head['name'], NewKind>,
            ...ReplaceColumnKind<Tail, Target, NewKind>,
          ]
        : [Head, ...ReplaceColumnKind<Tail, Target, NewKind>]
      : []
    : []
  : [];

// ---------------------------------------------------------------------------
// Rekey transforms
// ---------------------------------------------------------------------------

export type RekeySchema<
  S extends SeriesSchema,
  First extends FirstColumn,
> = readonly [First, ...ValueColumnsForSchema<S>];

export type TimeKeyedSchema<S extends SeriesSchema> = RekeySchema<
  S,
  ColumnDef<'time', 'time'>
>;
export type TimeRangeKeyedSchema<S extends SeriesSchema> = RekeySchema<
  S,
  ColumnDef<'timeRange', 'timeRange'>
>;
export type IntervalKeyedSchema<S extends SeriesSchema> = RekeySchema<
  S,
  ColumnDef<'interval', 'interval'>
>;

// ---------------------------------------------------------------------------
// Value-axis schemas (ValueSeries). Disjoint from SeriesSchema: the key is a
// `'value'`-kind column whose name is the *axis* (e.g. `cumDist`), not a
// time literal. The disjointness is what makes the calendar operators
// type-impossible on a ValueSeries.
// ---------------------------------------------------------------------------

/** The first column of a `ValueSeries` — a `'value'` key with an arbitrary axis name. */
export type ValueFirstColumn = ColumnDef<string, 'value'>;

/** A value-axis-keyed schema: a `'value'` key (arbitrary name) + value columns. */
export type ValueSeriesSchema = readonly [ValueFirstColumn, ...ValueColumn[]];

/** Drops the column named `Target` from a value-column tuple. Mirrors {@link ReplaceColumnKind}. */
export type ExcludeColumnByName<
  Columns extends readonly ValueColumn[],
  Target extends string,
> = Columns extends readonly [infer Head, ...infer Tail]
  ? Head extends ValueColumn
    ? Tail extends readonly ValueColumn[]
      ? Head['name'] extends Target
        ? ExcludeColumnByName<Tail, Target>
        : [Head, ...ExcludeColumnByName<Tail, Target>]
      : []
    : []
  : [];

/**
 * The schema produced by `TimeSeries.byValue(Axis)`: the named axis column
 * becomes the `'value'` key, and is removed from the value columns (the key
 * takes its name, so leaving it as a value column would duplicate the name).
 */
export type ValueKeyedSchema<
  S extends SeriesSchema,
  Axis extends string,
> = readonly [
  ColumnDef<Axis, 'value'>,
  ...ExcludeColumnByName<ValueColumnsForSchema<S>, Axis>,
];

/** The value columns of a `ValueSeriesSchema` (everything after the axis key). */
export type ValueSeriesValueColumns<VS extends ValueSeriesSchema> =
  VS extends readonly [ValueFirstColumn, ...infer Rest]
    ? Rest extends readonly ValueColumn[]
      ? Rest
      : never
    : never;

/** Union of value-column names on a `ValueSeriesSchema` (for `ValueSeries.column`). */
export type ValueSeriesColumnName<VS extends ValueSeriesSchema> =
  ValueSeriesValueColumns<VS>[number]['name'];
