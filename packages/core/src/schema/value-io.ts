/**
 * Wire shapes for `ValueSeries` ingest / export — the value-axis counterparts
 * of `./json.ts` (rows) and of the `{ name, schema, columns }` envelope the
 * columnar doors trade in.
 *
 * These are **separate types, not a widening of the time-keyed ones**, for the
 * same reason `ValueSeriesSchema` is disjoint from `SeriesSchema`: the axis
 * cell is a plain `number`, not a timestamp/`Time`/range, so
 * `JsonValueForKind<'value'>` would resolve to `never` and every row type
 * built on it would collapse. Keeping the value-axis shapes in their own
 * module preserves the disjointness the value-axis RFC (§5) is built on —
 * a time row can't be handed to a value door by accident, and vice versa.
 */
import type {
  ArrayValue,
  ColumnDef,
  NormalizedValueForKind,
  ValueSeriesSchema,
} from './series.js';
import type { JsonValueForKind } from './json.js';

/**
 * The JSON cell type for one `ValueSeries` column kind. The axis (`'value'`)
 * is a plain number — no timestamp parsing, no `Time` object; every other kind
 * defers to the shared {@link JsonValueForKind}.
 */
export type ValueSeriesJsonCell<K extends string> = K extends 'value'
  ? number
  : JsonValueForKind<K>;

/**
 * One JSON **tuple** row: `[axis, ...values]`, aligned with the schema. The
 * axis cell is a required finite `number` (it becomes the index); a value cell
 * may be `null`, which reads as a gap.
 */
export type ValueSeriesJsonRow<VS extends ValueSeriesSchema> = {
  [I in keyof VS]: I extends '0'
    ? number
    : VS[I] extends ColumnDef<any, infer K>
      ? ValueSeriesJsonCell<K> | null
      : never;
};

/** One JSON **object** row, keyed by schema column name. */
export type ValueSeriesJsonObjectRow<VS extends ValueSeriesSchema> = {
  [C in VS[number] as C['name']]: C extends ColumnDef<any, infer K>
    ? K extends 'value'
      ? number
      : JsonValueForKind<K> | null
    : never;
};

/**
 * The JSON envelope `ValueSeries.fromJSON` accepts — rows in either shape.
 * `ValueSeries.toJSON` returns one of the two narrowed forms below.
 */
export type ValueSeriesJsonInput<VS extends ValueSeriesSchema> = {
  name: string;
  schema: VS;
  rows: ReadonlyArray<ValueSeriesJsonRow<VS> | ValueSeriesJsonObjectRow<VS>>;
};

/** `toJSON()` narrowed to tuple rows — the default (`rowFormat: 'array'`). */
export type ValueSeriesJsonOutputArray<VS extends ValueSeriesSchema> = {
  name: string;
  schema: VS;
  rows: ReadonlyArray<ValueSeriesJsonRow<VS>>;
};

/** `toJSON({ rowFormat: 'object' })` narrowed to schema-keyed object rows. */
export type ValueSeriesJsonOutputObject<VS extends ValueSeriesSchema> = {
  name: string;
  schema: VS;
  rows: ReadonlyArray<ValueSeriesJsonObjectRow<VS>>;
};

/**
 * One **normalized** tuple row (`toRows()`): the same positions as
 * {@link ValueSeriesJsonRow}, but a gap is `undefined` rather than `null` —
 * the JS-native reading shape, not the wire one.
 *
 * Every value cell is `| undefined` regardless of the column's `required`
 * flag, because the columnar doors (`fromColumns` / `fromArrow`) don't enforce
 * `required` — they pack whatever the buffers hold, and a non-finite cell is a
 * gap. Only the row door (`fromJSON`) checks `required`, so a type that
 * narrowed on it would be lying about series built the other way.
 */
export type ValueSeriesRow<VS extends ValueSeriesSchema> = {
  [I in keyof VS]: I extends '0'
    ? number
    : VS[I] extends ColumnDef<any, infer K>
      ? NormalizedValueForKind<K> | undefined
      : never;
};

/** One normalized **object** row (`toObjects()`), keyed by column name. */
export type ValueSeriesObjectRow<VS extends ValueSeriesSchema> = {
  [C in VS[number] as C['name']]: C extends ColumnDef<any, infer K>
    ? K extends 'value'
      ? number
      : NormalizedValueForKind<K> | undefined
    : never;
};

/**
 * The columnar-JSON payload: one plain array per column, keyed by schema
 * column name and aligned by index. The axis is `number[]` (always defined);
 * a value column carries `null` where the cell is a gap, so the whole envelope
 * survives `JSON.stringify` (`NaN` does not).
 *
 * `boolean` / `array` columns — which only reach a `ValueSeries` by projection
 * from a `TimeSeries`, since the direct doors take `number` and `string` —
 * export as themselves. They are valid JSON but **not** ingestable: the
 * columnar engine takes `number` and `string` value columns only.
 *
 * On **this** (columnar) leg that shows up at compile time — such a payload is
 * not assignable to {@link ValueSeriesColumnarInput}. The **row** leg
 * ({@link ValueSeriesJsonRow}) is honest about the `boolean` it really emits
 * and so stays assignable, and `fromJSON` throws at ingest instead, naming the
 * column and its kind. Making the row types `never` for those kinds would buy
 * symmetry at the price of an unreadable assignability error and an output
 * type that lies about what `toJSON` emits; the runtime message is the better
 * diagnostic. (The real fix, if a consumer ever needs it, is teaching the
 * shared ingest engine `boolean` — see `docs/plans/PND_COLUMNAR_PLAN.md`.)
 */
export type ValueSeriesJsonColumns<VS extends ValueSeriesSchema> = {
  [C in VS[number] as C['name']]: C extends ColumnDef<any, infer K>
    ? K extends 'value'
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
};

/**
 * The envelope `ValueSeries.fromColumns` accepts. Deliberately **loose** on
 * the column values — a `number[]` off `JSON.parse`, a `Float64Array` off a
 * binary decode (adopted zero-copy), or a `string[]` all reach the same door.
 * {@link ValueSeriesColumnarOutput} is the precise counterpart coming back.
 */
export type ValueSeriesColumnarInput<VS extends ValueSeriesSchema> = {
  name: string;
  schema: VS;
  columns: Record<
    string,
    | ReadonlyArray<number | null | undefined>
    | Float64Array
    | ReadonlyArray<string | null | undefined>
  >;
};

/**
 * What `ValueSeries.toColumns()` returns — the columnar-JSON envelope, typed
 * per column. Assignable to {@link ValueSeriesColumnarInput}, so
 * `ValueSeries.fromColumns(vs.toColumns())` round-trips without a cast.
 */
export type ValueSeriesColumnarOutput<VS extends ValueSeriesSchema> = {
  name: string;
  schema: VS;
  columns: ValueSeriesJsonColumns<VS>;
};
