import {
  type Column as ColumnarColumn,
  type ColumnarStore,
  type ColumnSchema,
  ValueKeyColumn,
  withRowRange,
} from '../columnar/index.js';
import { ValidationError } from '../core/errors.js';
import {
  arrowToValueColumns,
  type ArrowTableLike,
  type FromArrowValueOptions,
} from './operators/from-arrow.js';
import { ingestColumnsToStore } from './operators/ingest-columns.js';
import { storeToColumns } from './operators/to-columns.js';
import {
  storeToArrow,
  type ArrowExport,
  type ToArrowOptions,
} from './operators/to-arrow.js';
import {
  valueRowsToColumns,
  valueStoreToObjects,
  valueStoreToRows,
} from './operators/value-rows.js';
import type {
  JsonRowFormat,
  ValueSeriesColumnarInput,
  ValueSeriesColumnarOutput,
  ValueSeriesColumnName,
  ValueSeriesJsonColumns,
  ValueSeriesJsonInput,
  ValueSeriesJsonObjectRow,
  ValueSeriesJsonOutputArray,
  ValueSeriesJsonOutputObject,
  ValueSeriesJsonRow,
  ValueSeriesObjectRow,
  ValueSeriesRow,
  ValueSeriesSchema,
} from '../schema/index.js';

/**
 * A **value-keyed series** — the closed value-axis counterpart of
 * `TimeSeries`. Its key is a monotonic non-time axis (distance, cumulative
 * work, …).
 *
 * **In.** One door **projects** — `TimeSeries.byValue(axis)`, a track re-keyed
 * by the cumulative-distance column it already carries. The other three
 * **construct directly**, for data that is natively value-keyed and never had
 * a meaningful time key per row (an options chain keyed by strike, a spectrum
 * keyed by frequency), one per shape the data arrives in:
 * {@link ValueSeries.fromJSON} (row tuples / objects),
 * {@link ValueSeries.fromColumns} (struct-of-arrays), and
 * {@link ValueSeries.fromArrow} (a decoded Apache Arrow `Table`). All three
 * share one ingest engine, so the axis contract, `sort`, and the packing rules
 * are identical whichever you use.
 *
 * **Out.** The mirror image, so a `ValueSeries` is never a dead end:
 * {@link ValueSeries.toJSON} / {@link ValueSeries.toRows} /
 * {@link ValueSeries.toObjects} (rows), {@link ValueSeries.toColumns}
 * (columnar JSON), {@link ValueSeries.toArrow} (Arrow's memory layout, no
 * copy). Each export pairs with the matching ingress: `fromX(series.toX())`
 * reconstructs the series — for the `number` / `string` columns the ingest
 * engine carries, which is every series built through a direct door. The one
 * exception is a `boolean` / array column arriving by `byValue` projection: it
 * exports on every door but no door takes it back (`fromColumns` refuses at
 * compile time, `fromJSON` throws at ingest, naming the column).
 *
 * `ValueSeries` carries the **ordering-based** operators (read the axis, read
 * value columns, nearest-by-value, slice-by-value) — the part of the series
 * algebra that was never really about time (RFC `value-axis.md` §5). The
 * calendar/clock operators (`Sequence.every`, tz formatting) are deliberately
 * absent: a value axis has no wall-clock semantics, and the disjoint
 * `ValueSeriesSchema` makes them type-impossible here.
 *
 * Minimal by design (RFC §7: adopt the type early, grow the algebra as a second
 * value-axis consumer earns it). Wraps the columnar store directly — a value
 * row is an `(axis, …values)` tuple, not a `Time`-keyed `Event`, so it does not
 * go through the time-only `SeriesStore` / EventKey layer.
 */
export class ValueSeries<VS extends ValueSeriesSchema> {
  readonly name: string;
  readonly schema: VS;
  readonly #store: ColumnarStore<ColumnSchema>;

  /**
   * @internal Trusted construction — `store` must be value-keyed and structurally
   * match `schema` (the invariant `TimeSeries.byValue` / `byValueOp` establish).
   * Not for general use; construct a `ValueSeries` via `TimeSeries.byValue` or
   * one of the ingest doors ({@link ValueSeries.fromJSON} /
   * {@link ValueSeries.fromColumns} / {@link ValueSeries.fromArrow}).
   */
  static fromTrustedStore<VS extends ValueSeriesSchema>(
    name: string,
    schema: VS,
    store: ColumnarStore<ColumnSchema>,
  ): ValueSeries<VS> {
    return new ValueSeries(name, schema, store);
  }

  /**
   * Example: `ValueSeries.fromColumns({ name, schema, columns })`.
   *
   * The **direct columnar door** into value-land — for data that is *natively*
   * value-keyed and never had a meaningful per-row time key: an options chain
   * keyed by strike, a spectrum keyed by frequency, a profile keyed by depth.
   * (Data that starts life time-keyed projects in via `TimeSeries.byValue`
   * instead; before this door existed, cross-sectional callers had to launder
   * their axis through a fake `time` column just to reach
   * `TimeSeries.fromColumns` + `byValue`.)
   *
   * The exact `TimeSeries.fromColumns` contract, with the axis in place of
   * time — the two doors share one ingest engine. `schema[0]` is the
   * `'value'`-kind **axis** column; each `columns` entry is one column's
   * values, keyed by schema column name and aligned by index. Values may be a
   * plain `number[]` **or** a `Float64Array`; a value cell is a gap (missing)
   * iff it's `null`/`undefined` or non-finite — identical rule for both input
   * types.
   *
   * **`Float64Array` inputs are adopted, not copied** (zero-copy): the
   * resulting series' columns alias the caller's buffers; pass a fresh buffer
   * if that matters. (**`sort` disables the adoption** — a reorder needs its
   * own buffers.)
   *
   * **Ordering.** The axis must be **defined, finite, and non-decreasing** —
   * it becomes the index (the same contract `byValue` enforces with
   * `assertMonotonicAxis`), so an out-of-order axis throws by default. Pass
   * **`sort: true`** to sort the rows by axis value before construction — the
   * stable sort every unordered snapshot wants (e.g. a keyed live feed that
   * delivers rows in update order, not axis order).
   *
   * **Value columns:** `number` and `string`, matching `TimeSeries.fromColumns`.
   *
   * @throws ValidationError on a non-`'value'` axis kind, a missing column, a
   *   length mismatch, an unsupported value-column kind, or an out-of-order axis
   *   when `sort` is not set. Throws RangeError on a non-finite
   *   (`null`/`NaN`/`±Infinity`) axis cell — sorting can't make it valid — or
   *   a duplicate column name (the axis name repeated among the value columns).
   */
  static fromColumns<VS extends ValueSeriesSchema>(
    input: ValueSeriesColumnarInput<VS> & {
      /**
       * Sort the rows by axis value before construction (off by default), for a
       * payload whose rows aren't guaranteed ordered. Stable; disables the
       * `Float64Array` zero-copy adoption (columns are reordered into fresh
       * buffers).
       */
      sort?: boolean;
    },
  ): ValueSeries<VS> {
    const { name, schema, columns, sort = false } = input;
    assertAxisSchema('ValueSeries.fromColumns', schema);

    const store = ingestColumnsToStore({
      op: 'ValueSeries.fromColumns',
      keyNoun: 'axis values',
      schema: schema as unknown as ColumnSchema,
      columns,
      sort,
    });
    return new ValueSeries(name, schema, store);
  }

  /**
   * Example: `ValueSeries.fromJSON({ name, schema, rows })`.
   *
   * The **row door** — the shape data arrives in from an ordinary JSON API,
   * a CSV parse, or anything that hands you one record per row. Rows may be
   * **tuples** (`[axis, ...values]`, aligned with the schema) or **objects**
   * keyed by column name — each row is read on its own terms, so a payload
   * that mixes the two still ingests.
   *
   * The value-axis counterpart of `TimeSeries.fromJSON`, minus the one thing a
   * value axis has no use for: **there is no timestamp parsing and no
   * `parse.timeZone`.** The axis cell must be a finite `number` — a value axis
   * has no calendar to interpret `'2026-01-01'` against — so a string axis is
   * an error naming the row rather than a silent `NaN`.
   *
   * **Strictness (this is the strict door).** Every defined value cell is
   * checked against its declared kind, so a `NaN`/`Infinity` in a `'number'`
   * column or a number in a `'string'` column is **rejected**, and a column
   * declared `required` (the default) rejects a missing cell. `null` and
   * `undefined` both mean *missing* and are accepted for a
   * `required: false` column. The columnar doors are deliberately looser —
   * they treat a non-finite number as a gap and ignore `required`, because a
   * decoded buffer has no way to distinguish "absent" from "not a number".
   *
   * **Ordering.** As every door: the axis must be non-decreasing, or pass
   * `sort: true` to stable-sort the rows by axis value first.
   *
   * @throws ValidationError on a non-`'value'` axis kind, a row whose length
   *   disagrees with the schema, a non-finite/non-numeric axis cell, a cell
   *   that doesn't match its column's kind, a missing required cell, or an
   *   out-of-order axis when `sort` is not set.
   */
  static fromJSON<VS extends ValueSeriesSchema>(
    input: ValueSeriesJsonInput<VS> & {
      /**
       * Sort the rows by axis value before construction (off by default) — for
       * reviving a wire payload whose rows aren't guaranteed ordered, without
       * a manual pre-sort. Stable.
       */
      sort?: boolean;
    },
  ): ValueSeries<VS> {
    const { name, schema, rows, sort = false } = input;
    assertAxisSchema('ValueSeries.fromJSON', schema);

    const columns = valueRowsToColumns(
      'ValueSeries.fromJSON',
      schema,
      rows as ReadonlyArray<
        ReadonlyArray<unknown> | Readonly<Record<string, unknown>>
      >,
    );
    const store = ingestColumnsToStore({
      op: 'ValueSeries.fromJSON',
      keyNoun: 'axis values',
      schema: schema as unknown as ColumnSchema,
      columns,
      sort,
    });
    return new ValueSeries(name, schema, store);
  }

  /**
   * Example: `ValueSeries.fromArrow(tableFromIPC(bytes), { axis: 'strike' })`.
   *
   * Build a value-keyed series from a decoded Apache Arrow `Table` — the
   * counterpart of `TimeSeries.fromArrow`, and the door a cross-sectional
   * payload most often arrives at, since an options chain or a spectrum
   * reaching you over Arrow has no time column to key on in the first place.
   *
   * pond does **not** depend on `apache-arrow`: bring your own
   * (`tableFromIPC(...)` / `tableFromArrays(...)`) and hand the `Table` here;
   * the input is duck-typed against the small {@link ArrowTableLike} slice we
   * read. Ingest is the zero-copy path — a **single-chunk** `Float64` column's
   * backing `Float64Array` is adopted as-is, nulls and all (Arrow's validity
   * bitmap is bit-identical to pond's).
   *
   * Column handling:
   * - **Axis** — named by `axis`, which is **required**: unlike the time door
   *   there is no conventional field name to fall back on. Numeric columns
   *   only, taken at face value (no unit scaling — an axis has no `TimeUnit`);
   *   int64 recombines BigInt-free. A null in the axis throws.
   * - **Value columns** — every non-axis field by default, or the subset named
   *   by `columns` (in order). The readable Arrow types are exactly those
   *   `TimeSeries.fromArrow` lists — `Int`, `Float32`/`Float64`, `Date`,
   *   `Timestamp`, `Utf8`, `Dictionary<Utf8>` — checked against each field's
   *   **declared** type, so anything else (`Decimal`, `Float16`, `Bool`,
   *   list/struct/…) is refused by name rather than misread.
   *
   * The rows must be axis-ordered (as every door requires); pass
   * `{ sort: true }` for an unordered table (which disables the adoption).
   *
   * **Trust contract on the type parameter:** the runtime schema is derived
   * from the Arrow fields. Supplying `VS` (`fromArrow<MySchema>(...)`) is a
   * downstream-typing convenience taken on trust — pond does not verify the
   * Arrow fields match `VS`, exactly as `TimeSeries.fromArrow` does.
   */
  static fromArrow<VS extends ValueSeriesSchema = ValueSeriesSchema>(
    table: ArrowTableLike,
    options: FromArrowValueOptions,
  ): ValueSeries<VS> {
    const { name, schema, columns, adopted } = arrowToValueColumns(
      table,
      options,
    );
    // Straight to the shared ingest engine rather than through `fromColumns`,
    // which has no parameter for `adopted` — the null-bearing numeric columns
    // built directly from Arrow's buffers, which `RawColumns` cannot express
    // because it cannot carry a validity bitmap. Same engine either way; only
    // the `op` label differs, so a failure names the door the caller used.
    const store = ingestColumnsToStore({
      op: 'fromArrow',
      keyNoun: 'axis values',
      schema: schema as unknown as ColumnSchema,
      columns,
      sort: options.sort ?? false,
      adopted,
    });
    return new ValueSeries(name, schema as unknown as VS, store);
  }

  private constructor(
    name: string,
    schema: VS,
    store: ColumnarStore<ColumnSchema>,
  ) {
    this.name = name;
    this.schema = Object.freeze(schema.slice()) as unknown as VS;
    this.#store = store;
  }

  /** Number of rows. */
  get length(): number {
    return this.#store.length;
  }

  /** The axis (key) column's name — e.g. `'cumDist'`. */
  get axisName(): VS[0]['name'] {
    return this.schema[0]!.name as VS[0]['name'];
  }

  /**
   * The axis values (the x of every row), in axis order. **Zero-copy** — the
   * returned `Float64Array` is the live key buffer; treat it as read-only.
   */
  axisValues(): Float64Array {
    return (this.#store.keys as ValueKeyColumn).begin;
  }

  /** The axis value at row `i`. Throws if out of range. */
  axisAt(i: number): number {
    return (this.#store.keys as ValueKeyColumn).beginAt(i);
  }

  /** A value column by name, for direct columnar reads (`.read(i)`, `.values()`). */
  column(name: ValueSeriesColumnName<VS>): ColumnarColumn | undefined {
    return this.#store.columns.get(name as string);
  }

  /**
   * Index of the row whose axis value is **closest** to `value` — the
   * value-axis cursor primitive. The axis is non-decreasing, so this is a
   * binary search. Returns `-1` for an empty series; clamps to the first / last
   * row when `value` is outside the axis extent.
   */
  nearestIndex(value: number): number {
    const n = this.length;
    if (n === 0) return -1;
    const ax = this.axisValues();
    const lo = lowerBound(ax, n, value);
    if (lo === 0) return 0;
    if (lo === n) return n - 1;
    return value - ax[lo - 1]! <= ax[lo]! - value ? lo - 1 : lo;
  }

  /**
   * The contiguous sub-series whose axis value lies in `[lo, hi)` — the
   * value-axis cull (pan / zoom on a value x). Binary-searches the bounds and
   * zero-copy slices the store. `lo >= hi` (or a range outside the extent)
   * yields an empty series.
   */
  sliceByValue(lo: number, hi: number): ValueSeries<VS> {
    const ax = this.axisValues();
    const n = this.length;
    const loIdx = lowerBound(ax, n, lo);
    const hiIdx = lowerBound(ax, n, hi);
    const sliced = withRowRange(this.#store, loIdx, hiIdx);
    return ValueSeries.fromTrustedStore(this.name, this.schema, sliced);
  }

  /* ---------------------------------------------------------------------- */
  /* Export doors — one per ingest door, so nothing that comes in is stuck.  */
  /* ---------------------------------------------------------------------- */

  /**
   * Example: `chain.toRows()`.
   *
   * The rows as **tuples** — `[axis, ...values]`, aligned with the schema, in
   * axis order. A gap reads as `undefined` (the JS spelling); use
   * {@link ValueSeries.toJSON} for the wire spelling (`null`).
   *
   * Unlike `TimeSeries.toRows` there is no key object to normalize: the axis
   * is already a plain number, so a value row is a tuple of scalars end to end.
   */
  toRows(): ReadonlyArray<ValueSeriesRow<VS>> {
    return valueStoreToRows(
      this.schema,
      this.#store,
      false,
    ) as unknown as ReadonlyArray<ValueSeriesRow<VS>>;
  }

  /**
   * Example: `chain.toObjects()`.
   *
   * The rows as **objects** keyed by schema column name, in axis order — for
   * reading by name rather than tuple position (a table renderer, a CSV
   * writer, `d3`). A gap reads as `undefined`.
   */
  toObjects(): ReadonlyArray<ValueSeriesObjectRow<VS>> {
    return valueStoreToObjects(
      this.schema,
      this.#store,
      false,
    ) as unknown as ReadonlyArray<ValueSeriesObjectRow<VS>>;
  }

  /**
   * Example: `chain.toJSON()` / `chain.toJSON({ rowFormat: 'object' })`.
   *
   * The **row-shaped wire envelope**: `{ name, schema, rows }`, exactly what
   * {@link ValueSeries.fromJSON} takes back, and `JSON.stringify`-safe
   * throughout (gaps emit as `null`, not `NaN`).
   *
   * Defaults to tuple rows; pass `{ rowFormat: 'object' }` for schema-keyed
   * object rows (larger on the wire, readable in a log). The return type
   * narrows on the option, so `result.rows` needs no cast — the overload
   * cascade that keeps `TimeSeries.toJSON` broad doesn't reach here (this
   * class has no other overload sets to disturb).
   */
  toJSON(options?: { rowFormat?: 'array' }): ValueSeriesJsonOutputArray<VS>;
  toJSON(options: { rowFormat: 'object' }): ValueSeriesJsonOutputObject<VS>;
  toJSON(
    options: { rowFormat?: JsonRowFormat } = {},
  ): ValueSeriesJsonOutputArray<VS> | ValueSeriesJsonOutputObject<VS> {
    const rows =
      (options.rowFormat ?? 'array') === 'object'
        ? (valueStoreToObjects(
            this.schema,
            this.#store,
            true,
          ) as unknown as ReadonlyArray<ValueSeriesJsonObjectRow<VS>>)
        : (valueStoreToRows(
            this.schema,
            this.#store,
            true,
          ) as unknown as ReadonlyArray<ValueSeriesJsonRow<VS>>);
    return { name: this.name, schema: this.schema, rows } as
      | ValueSeriesJsonOutputArray<VS>
      | ValueSeriesJsonOutputObject<VS>;
  }

  /**
   * Example: `chain.toColumns()`.
   *
   * The **columnar wire envelope**: `{ name, schema, columns }` with one plain
   * array per column (the axis included, under its own name) — what
   * {@link ValueSeries.fromColumns} takes back, so
   * `ValueSeries.fromColumns(chain.toColumns())` round-trips without a cast.
   *
   * The columnar counterpart of {@link ValueSeries.toJSON}: same data, one
   * array per column instead of one array per row. Prefer it when the consumer
   * is itself column-oriented, or when the payload is dense enough that C
   * arrays beat N×C-element rows on size and parse time. Gaps emit as `null`
   * — `NaN` is not JSON, and `Float64Array` does not stringify as an array,
   * so a JSON-bound columnar payload has to pay this conversion somewhere.
   *
   * For a **zero-copy** columnar handoff in-process (no JSON, no per-cell
   * walk), use {@link ValueSeries.toArrow} instead.
   *
   * A `boolean` or array-kind column (which only a `byValue` projection can
   * introduce — the direct doors take `number` and `string`) exports fine here
   * but cannot be ingested back; the return type reflects that, so **this**
   * round trip fails to compile rather than at runtime. The row leg is the
   * other way round: `toJSON` types its `boolean` cells honestly, so
   * `fromJSON` accepts the payload's shape and throws at ingest instead,
   * naming the column and its kind.
   */
  toColumns(): ValueSeriesColumnarOutput<VS> {
    return {
      name: this.name,
      schema: this.schema,
      columns: storeToColumns(this.#store) as ValueSeriesJsonColumns<VS>,
    };
  }

  /**
   * Example: `chain.toArrow()`.
   *
   * Hands this series' columns over **in Apache Arrow's memory layout, with no
   * copy** — the export counterpart of {@link ValueSeries.fromArrow}, and the
   * same `{ length, fields }` shape `TimeSeries.toArrow` returns (the exporter
   * is shared; a `'value'` axis simply exports as a plain `float64` field
   * rather than a `timestamp` one).
   *
   * pond takes no dependency on `apache-arrow`, so the caller assembles the
   * `Table` from the handed-over buffers with `makeData` / `makeVector` — see
   * `TimeSeries.toArrow`'s doc for the adapter snippet. From there another
   * columnar engine (polars, DuckDB, arrow-js) is reachable without a
   * re-ingest.
   *
   * **The returned buffers are pond's live storage, not copies** — the same
   * read-only contract `column(name)` and `axisValues()` already carry. Copy
   * first if the consumer mutates in place.
   */
  toArrow(options: ToArrowOptions = {}): ArrowExport {
    return storeToArrow(this.#store, options);
  }
}

/**
 * The one thing every direct `ValueSeries` door checks before handing off to
 * the shared ingest engine: `schema[0]` must be the `'value'`-kind axis
 * column. `op` names the door so the message tells the caller which one they
 * went through.
 */
function assertAxisSchema(op: string, schema: ValueSeriesSchema): void {
  const keyDef = schema[0];
  if (keyDef === undefined) {
    throw new ValidationError(
      `${op}: schema must have at least an axis column`,
    );
  }
  if (keyDef.kind !== 'value') {
    throw new ValidationError(
      `${op}: schema[0] '${keyDef.name}' must be the 'value'-kind axis column; got '${keyDef.kind}'`,
    );
  }
}

/** First index `i` in `ax[0..n)` with `ax[i] >= target` (lower bound). */
function lowerBound(ax: Float64Array, n: number, target: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ax[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
