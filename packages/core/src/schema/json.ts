import type {
  ArrayValue,
  ColumnDef,
  FirstColumn,
  SeriesSchema,
} from './series.js';

export type JsonTimestampInput = number | string;
export type JsonTimeRangeInput =
  | readonly [start: JsonTimestampInput, end: JsonTimestampInput]
  | { start: JsonTimestampInput; end: JsonTimestampInput };
export type JsonIntervalInput =
  | readonly [
      value: string | number,
      start: JsonTimestampInput,
      end: JsonTimestampInput,
    ]
  | {
      value: string | number;
      start: JsonTimestampInput;
      end: JsonTimestampInput;
    };

export type JsonValueForKind<K extends string> = K extends 'time'
  ? JsonTimestampInput
  : K extends 'timeRange'
    ? JsonTimeRangeInput
    : K extends 'interval'
      ? JsonIntervalInput
      : K extends 'number'
        ? number
        : K extends 'string'
          ? string
          : K extends 'boolean'
            ? boolean
            : K extends 'array'
              ? ArrayValue
              : never;

export type JsonRowForSchema<S extends readonly ColumnDef<string, string>[]> = {
  [I in keyof S]: S[I] extends ColumnDef<any, infer K>
    ? JsonValueForKind<K> | null
    : never;
};

export type JsonObjectRowForSchema<S extends SeriesSchema> = {
  [C in S[number] as C['name']]: C extends ColumnDef<any, infer K>
    ? JsonValueForKind<K> | null
    : never;
};

export type TimeSeriesJsonInput<S extends SeriesSchema> = {
  name: string;
  schema: S;
  rows: ReadonlyArray<JsonRowForSchema<S> | JsonObjectRowForSchema<S>>;
};

/**
 * `toJSON()` output narrowed to the array (tuple) row form.
 * Returned when `rowFormat` is omitted or set to `'array'`.
 */
export type TimeSeriesJsonOutputArray<S extends SeriesSchema> = {
  name: string;
  schema: S;
  rows: ReadonlyArray<JsonRowForSchema<S>>;
};

/**
 * `toJSON()` output narrowed to the object (schema-keyed) row form.
 * Returned when `rowFormat` is set to `'object'`.
 */
export type TimeSeriesJsonOutputObject<S extends SeriesSchema> = {
  name: string;
  schema: S;
  rows: ReadonlyArray<JsonObjectRowForSchema<S>>;
};

export type JsonRowFormat = 'array' | 'object';

// ---------------------------------------------------------------------------
// Columnar wire format — the struct-of-arrays transpose of the row envelope
// above. `TimeSeries.fromColumns` takes it, `TimeSeries.toColumns` returns it.
// The value-axis counterparts live in `./value-io.ts`.
// ---------------------------------------------------------------------------

/**
 * The columnar-JSON payload: one plain array per column, keyed by schema
 * column name and aligned by index. Key edges are `number[]` (epoch ms, always
 * defined); a value column carries `null` where the cell is a gap, so the
 * whole envelope survives `JSON.stringify` (`NaN` does not).
 *
 * A two-edged key contributes **more columns than the schema lists** — see
 * {@link FlatKeyColumns}. The schema keeps declaring the logical key
 * (`{ name: 'timeRange', kind: 'timeRange' }`); the edges are derived from it.
 *
 * `boolean` / `array` columns export as themselves — valid JSON, but the
 * columnar ingest engine takes `number` and `string` value columns only, so a
 * payload carrying one is **not** assignable to {@link TimeSeriesColumnarInput}
 * and that round trip fails to compile. Drop such a column first
 * (`series.select(…).toColumns()`) or use the row doors, which do carry every
 * kind.
 */
export type TimeSeriesJsonColumns<S extends SeriesSchema> = {
  [C in S[number] as C['name']]: C extends ColumnDef<any, infer K>
    ? K extends 'time' | 'timeRange' | 'interval'
      ? number[]
      : K extends 'string'
        ? Array<string | null>
        : K extends 'number'
          ? Array<number | null>
          : K extends 'boolean'
            ? Array<boolean | null>
            : K extends 'array'
              ? Array<ArrayValue | null>
              : never
    : never;
} & FlatKeyColumns<S[0]>;

/**
 * The extra columns a two-edged key flattens into. A `timeRange` key adds its
 * second edge; an `interval` key adds that plus its label column. A point
 * (`time`) key adds nothing.
 *
 * The names are literals rather than template types because `FirstColumn`
 * forces a key column's name to equal its kind — a `timeRange` key is always
 * spelled `timeRange` + `timeRangeEnd`, never anything else. See
 * `batch/operators/flat-keys.ts` for the convention and the collision rule.
 *
 * `intervalLabel` is `string[] | number[]`, **not** `Array<string | number>`:
 * the runtime rule is one label type throughout (the engine rejects a mixed
 * column), and only the homogeneous form is assignable back into
 * {@link TimeSeriesColumnarInput} — so the honest type is also the one that
 * keeps the round trip compiling.
 */
export type FlatKeyColumns<K extends FirstColumn> =
  K['kind'] extends 'timeRange'
    ? { timeRangeEnd: number[] }
    : K['kind'] extends 'interval'
      ? { intervalEnd: number[]; intervalLabel: string[] | number[] }
      : // eslint-disable-next-line @typescript-eslint/ban-types
        {};

/**
 * The envelope `TimeSeries.fromColumns` accepts. Deliberately **loose** on the
 * column values — a `number[]` off `JSON.parse`, a `Float64Array` off a binary
 * decode (adopted zero-copy), or a `string[]` all reach the same door.
 * {@link TimeSeriesColumnarOutput} is the precise counterpart coming back.
 */
export type TimeSeriesColumnarInput<S extends SeriesSchema> = {
  name: string;
  schema: S;
  columns: Record<
    string,
    | ReadonlyArray<number | null | undefined>
    | Float64Array
    | ReadonlyArray<string | null | undefined>
  >;
};

/**
 * What `TimeSeries.toColumns()` returns — the columnar-JSON envelope, typed
 * per column. Assignable to {@link TimeSeriesColumnarInput} for a schema of
 * `number` / `string` columns, so `TimeSeries.fromColumns(s.toColumns())`
 * round-trips without a cast.
 */
export type TimeSeriesColumnarOutput<S extends SeriesSchema> = {
  name: string;
  schema: S;
  columns: TimeSeriesJsonColumns<S>;
};
