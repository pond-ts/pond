import { Interval } from './interval.js';
import { Time } from './time.js';
import { TimeRange } from './time-range.js';
import { serializeJsonKey, serializeJsonValue } from '../batch/json.js';
import type { EventKey, IntervalValue, TemporalLike } from './temporal.js';
import type {
  FirstColKind,
  JsonObjectRowForSchema,
  JsonRowForSchema,
  JsonRowFormat,
  RowForSchema,
  SeriesSchema,
} from '../types.js';

type ScalarValue = number | string | boolean;
type CollapseData<
  D,
  Keys extends keyof D,
  Name extends string,
  R extends ScalarValue,
  Append extends boolean = false,
> = Append extends true
  ? Readonly<D & Record<Name, R>>
  : Readonly<Omit<D, Keys> & Record<Name, R>>;
type SelectData<D, Keys extends keyof D> = Readonly<Pick<D, Keys>>;
type RenameMap<D> = Partial<{
  [K in keyof D & string]: string;
}>;
type RenameData<D, Mapping extends RenameMap<D>> = Readonly<{
  [Name in keyof D & string as Name extends keyof Mapping
    ? Mapping[Name] extends string
      ? Mapping[Name]
      : Name
    : Name]: D[Name];
}>;

/**
 * An immutable event made of a temporal key and typed payload data.
 *
 * @example
 * ```ts
 * const event = new Event(
 *   new Time(new Date("2025-01-01T00:00:00.000Z")),
 *   { cpu: 0.42, host: "api-1" },
 * );
 *
 * event.get("cpu"); // 0.42
 * event.timeRange(); // TimeRange for the event extent
 * ```
 */
export class Event<K extends EventKey, D> {
  readonly #key: K;
  readonly #data: Readonly<D>;

  /** Example: `new Event(new Time(Date.now()), { value: 1 })`. Creates an immutable event from a key and typed payload object. */
  constructor(key: K, data: D) {
    this.#key = key;
    this.#data = Object.freeze({ ...data }) as Readonly<D>;
    Object.freeze(this);
  }

  /** Example: `event.key()`. Returns the event key. */
  key(): K {
    return this.#key;
  }

  /** Example: `event.withKey(new Time(Date.now()))`. Returns a new event with the same payload and a different key. */
  withKey<NextKey extends EventKey>(key: NextKey): Event<NextKey, D> {
    return new Event(key, this.#data as D);
  }

  /** Example: `event.type()`. Returns the underlying key kind. */
  type(): K['kind'] {
    return this.#key.kind;
  }

  /** Example: `event.data()`. Returns the immutable event payload. */
  data(): Readonly<D> {
    return this.#data;
  }

  /** Example: `event.get("value")`. Returns a single payload field by name. */
  get<Field extends keyof D>(field: Field): Readonly<D>[Field] {
    return this.#data[field];
  }

  /** Example: `event.set("value", 2)`. Returns a new event with one payload field replaced. */
  set<Field extends keyof D>(field: Field, value: D[Field]): Event<K, D> {
    return new Event(this.#key, {
      ...(this.#data as D),
      [field]: value,
    });
  }

  /** Example: `event.merge({ host: "api-1" })`. Returns a new event with a shallow payload merge applied. */
  merge<U extends object>(patch: U): Event<K, Readonly<D & U>> {
    return new Event(this.#key, {
      ...(this.#data as D),
      ...patch,
    }) as Event<K, Readonly<D & U>>;
  }

  /** Example: `event.select("cpu", "healthy")`. Returns a new event containing only the selected payload fields. */
  select<const Keys extends readonly (keyof D)[]>(
    ...keys: Keys
  ): Event<K, SelectData<D, Keys[number]>> {
    const selected = {} as Pick<D, Keys[number]>;
    for (const key of keys) {
      selected[key] = this.#data[key];
    }
    return new Event(this.#key, selected);
  }

  /** Example: `event.rename({ cpu: "usage" })`. Returns a new event with payload fields renamed according to the supplied mapping. */
  rename<const Mapping extends RenameMap<D>>(
    mapping: Mapping,
  ): Event<K, RenameData<D, Mapping>> {
    const renamed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.#data)) {
      const nextKey = (mapping as Partial<Record<string, string>>)[key] ?? key;
      renamed[nextKey] = value;
    }
    return new Event(this.#key, renamed) as Event<K, RenameData<D, Mapping>>;
  }

  /** Example: `event.collapse(["in", "out"], "avg", fn)`. Collapses selected payload fields into a single derived field using the supplied reducer. */
  collapse<
    const Keys extends readonly (keyof D)[],
    Name extends string,
    R extends ScalarValue,
  >(
    keys: Keys,
    output: Name,
    reducer: (values: Pick<D, Keys[number]>) => R,
  ): Event<K, CollapseData<D, Keys[number], Name, R>>;

  collapse<
    const Keys extends readonly (keyof D)[],
    Name extends string,
    R extends ScalarValue,
  >(
    keys: Keys,
    output: Name,
    reducer: (values: Pick<D, Keys[number]>) => R,
    options: { append: true },
  ): Event<K, CollapseData<D, Keys[number], Name, R, true>>;

  collapse<
    const Keys extends readonly (keyof D)[],
    Name extends string,
    R extends ScalarValue,
  >(
    keys: Keys,
    output: Name,
    reducer: (values: Pick<D, Keys[number]>) => R,
    options?: { append?: boolean },
  ): Event<K, CollapseData<D, Keys[number], Name, R, boolean>> {
    const selected = {} as Pick<D, Keys[number]>;
    for (const key of keys) {
      selected[key] = this.#data[key];
    }

    const collapsedValue = reducer(selected);
    const append = options?.append === true;

    if (append) {
      return new Event(this.#key, {
        ...(this.#data as D),
        [output]: collapsedValue,
      }) as Event<K, CollapseData<D, Keys[number], Name, R, boolean>>;
    }

    const nextData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.#data)) {
      if (!(keys as readonly PropertyKey[]).includes(key)) {
        nextData[key] = value;
      }
    }
    nextData[output] = collapsedValue;

    return new Event(this.#key, nextData) as Event<
      K,
      CollapseData<D, Keys[number], Name, R, boolean>
    >;
  }

  /** Example: `event.timeRange()`. Returns the event extent as a `TimeRange`. */
  timeRange(): TimeRange {
    const key = this.key();
    return key instanceof TimeRange
      ? key
      : new TimeRange({ start: key.begin(), end: key.end() });
  }

  /** Example: `event.begin()`. Returns the inclusive event start in milliseconds since epoch. */
  begin(): number {
    return this.#key.begin();
  }

  /** Example: `event.end()`. Returns the inclusive event end in milliseconds since epoch. */
  end(): number {
    return this.#key.end();
  }

  /** Example: `event.overlaps(range)`. Returns `true` when the event extent overlaps the supplied temporal value. */
  overlaps(other: TemporalLike): boolean {
    return this.#key.overlaps(other);
  }

  /** Example: `event.contains(time)`. Returns `true` when the event extent fully contains the supplied temporal value. */
  contains(other: TemporalLike): boolean {
    return this.#key.contains(other);
  }

  /** Example: `event.isBefore(range)`. Returns `true` when the event ends strictly before the supplied temporal value begins. */
  isBefore(other: TemporalLike): boolean {
    return this.#key.isBefore(other);
  }

  /** Example: `event.isAfter(range)`. Returns `true` when the event begins strictly after the supplied temporal value ends. */
  isAfter(other: TemporalLike): boolean {
    return this.#key.isAfter(other);
  }

  /** Example: `event.intersection(range)`. Returns the temporal intersection of the event extent and the supplied value, if any. */
  intersection(other: TemporalLike): TimeRange | undefined {
    return this.#key.intersection(other);
  }

  /** Example: `event.trim(range)`. Returns a new event clipped to the supplied temporal value, if the event overlaps it. */
  trim(other: TemporalLike): Event<K, D> | undefined {
    const trimmedKey = this.#key.trim(other);
    if (!trimmedKey) {
      return undefined;
    }
    return new Event(trimmedKey as K, this.#data as D);
  }

  /** Example: `event.asTime({ at: "center" })`. Converts the event key to a point-in-time key using the supplied anchor within the current extent. */
  asTime(options: { at?: 'begin' | 'center' | 'end' } = {}): Event<Time, D> {
    const at = options.at ?? 'begin';
    const timestamp =
      at === 'center'
        ? this.begin() + (this.end() - this.begin()) / 2
        : at === 'end'
          ? this.end()
          : this.begin();
    return this.withKey(new Time(timestamp));
  }

  /** Example: `event.asTimeRange()`. Converts the event key to an unlabeled `TimeRange` covering the same extent. */
  asTimeRange(): Event<TimeRange, D> {
    return this.withKey(
      new TimeRange({ start: this.begin(), end: this.end() }),
    );
  }

  /**
   * Example: `event.toRow(schema)`. Returns the typed-row tuple for
   * this event in the column order declared by `schema` — `[key,
   * ...values]`.
   *
   * Use this in batch-listener fanout to convert a stream of `Event`
   * objects into the same shape `LiveSeries.toRows()` /
   * `pushMany(rows)` consume, without walking columns by hand:
   *
   * ```ts
   * live.on('batch', (events) => {
   *   const rows = events.map((e) => e.toRow(schema));
   *   sendOverWire(rows); // codec of your choice
   * });
   * ```
   *
   * **Trust contract:** no validation against `schema`. If the
   * caller passes a schema whose value-column names don't match the
   * event's payload keys, `data[col.name]` is `undefined` for every
   * mismatched column and the row is silently corrupt — downstream
   * `pushMany(rows)` accepts it (column count matches), but reads
   * via `event.get('col')` from the resulting events return
   * `undefined`. Pass the same `as const` schema the event was
   * originally produced under.
   */
  toRow<S extends SeriesSchema>(schema: S): RowForSchema<S> {
    const data = this.#data as Record<string, unknown>;
    return Object.freeze([
      this.#key,
      ...schema.slice(1).map((col) => data[col.name]),
    ]) as unknown as RowForSchema<S>;
  }

  /**
   * Example: `event.toJsonRow(schema)`. Returns the JSON-shape row
   * for this event — like {@link Event.toRow} but with the key
   * serialized to its JSON form (numeric ms / `[start, end]` /
   * `[value, start, end]`) and `undefined` cells emitted as `null`.
   *
   * Pass `{ rowFormat: 'object' }` to get the schema-keyed object
   * shape instead of the array tuple.
   *
   * Mirrors `TimeSeries.toJSON`'s row-level serialization, so
   * `event.toJsonRow(schema)` plugs straight into a wire envelope
   * that the receiver feeds into `LiveSeries.pushJson(...)` or
   * `LiveSeries.fromJSON(...)`.
   *
   * **Trust contract:** same as {@link Event.toRow} — no validation
   * against `schema`. Mismatched column names produce `null`
   * cells in the JSON output (`serializeJsonValue(undefined)`),
   * which round-trip through `pushJson` as `undefined`. Pass the
   * same `as const` schema the event was originally produced under.
   */
  toJsonRow<S extends SeriesSchema>(
    schema: S,
    options?: { rowFormat?: 'array' },
  ): JsonRowForSchema<S>;
  toJsonRow<S extends SeriesSchema>(
    schema: S,
    options: { rowFormat: 'object' },
  ): JsonObjectRowForSchema<S>;
  toJsonRow<S extends SeriesSchema>(
    schema: S,
    options: { rowFormat?: JsonRowFormat } = {},
  ): JsonRowForSchema<S> | JsonObjectRowForSchema<S> {
    const rowFormat = options.rowFormat ?? 'array';
    const dataColumns = schema.slice(1);
    const data = this.#data as Record<string, unknown>;
    const keyColumn = schema[0]!;
    const jsonKey = serializeJsonKey(
      keyColumn.kind as FirstColKind,
      this.#key,
      rowFormat,
    );

    if (rowFormat === 'object') {
      const row: Record<string, unknown> = {
        [keyColumn.name]: jsonKey,
      };
      for (const column of dataColumns) {
        row[column.name] = serializeJsonValue(data[column.name]);
      }
      return Object.freeze(row) as JsonObjectRowForSchema<S>;
    }

    return Object.freeze([
      jsonKey,
      ...dataColumns.map((column) => serializeJsonValue(data[column.name])),
    ]) as unknown as JsonRowForSchema<S>;
  }

  /** Example: `event.asInterval("bucket-a")`. Converts the event key to a labeled `Interval` covering the same extent. */
  asInterval(value: IntervalValue): Event<Interval, D>;
  asInterval(
    getValue: (event: Event<K, D>) => IntervalValue,
  ): Event<Interval, D>;
  asInterval(
    value: IntervalValue | ((event: Event<K, D>) => IntervalValue),
  ): Event<Interval, D> {
    const nextValue = typeof value === 'function' ? value(this) : value;
    return this.withKey(
      new Interval({ value: nextValue, start: this.begin(), end: this.end() }),
    );
  }
}
