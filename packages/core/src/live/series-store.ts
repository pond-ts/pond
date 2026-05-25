/**
 * `SeriesStore<S>` — row-API adapter for the columnar framework.
 *
 * Wraps a `ColumnarStore<S>` (the pure substrate at
 * `src/columnar/`) and adds the row-API surface that backs
 * `TimeSeries`:
 *
 * - **`EventKey` materialization** (`Time` / `TimeRange` /
 *   `Interval` instances from the columnar key buffers), with a
 *   lazy per-row `Map<number, EventKey>` cache.
 * - **`Event` materialization** (`eventAt(i)`), with a lazy
 *   per-row `Map<number, Event>` cache.
 * - **Full materialization** (`toEvents()`), reusing the per-row
 *   cache. `toEvents() === toEvents()` and
 *   `eventAt(i) === toEvents()[i]`.
 * - **Event-shaped iteration** (`Symbol.iterator`).
 * - **Native exports** (`toRows()` / `toObjects()`) emitting the
 *   full `EventKey` instance under the key column's name.
 * - **`eventCache` option** for identity preservation across
 *   derivations (the `TimeSeries.concat` mechanism). Structurally
 *   validates every cached entry: key equality via
 *   `EventKey.equals`, per-column data agreement, exact-schema
 *   data field set (no extras), kind-aware value comparison.
 *
 * The five public-API invariants from the RFC are pinned by the
 * tests in `test/series-store.test.ts`. The columnar framework
 * itself (under `src/columnar/`) is pure indexed columnar data
 * with no knowledge of `Event` / `EventKey` / `Time` / `TimeRange`
 * / `Interval` — those concerns all live here.
 *
 * Step-1d scope: the read-only adapter shape and event
 * materialization. Full intake paths (`fromValidatedRows`,
 * `fromTrustedEvents`, `fromBuilders`) land in subsequent
 * sub-steps. This file exposes a minimal `fromTrustedStore`
 * factory accepting a pre-built `ColumnarStore` + optional cache.
 */

import { Event } from '../core/event.js';
import { Interval } from '../core/interval.js';
import { Time } from '../core/time.js';
import { TimeRange } from '../core/time-range.js';
import {
  type Column,
  type ColumnBuilder,
  type KeyColumn,
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  StringColumnBuilder,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  columnBuilderForKind,
  stringColumnFromArray,
} from '../columnar/index.js';
import type { EventKey } from '../core/temporal.js';
import type { RowForSchema, SeriesSchema } from '../schema/index.js';
import { validateAndNormalize } from '../batch/validate.js';

/**
 * Row-data shape — a record keyed by column name. Tightens to
 * `EventDataForSchema<S>` at the `TimeSeries` integration boundary
 * (step 2). For step 1d the substrate stays loosely typed.
 */
export type SeriesRowData = Readonly<Record<string, unknown>>;

/** Event type produced by `SeriesStore`. */
export type SeriesEvent = Event<Time | TimeRange | Interval, SeriesRowData>;

/** Options accepted by `SeriesStore.fromTrustedStore`. */
export interface SeriesStoreOptions {
  /**
   * Pre-populated event cache. When supplied, the store inherits
   * its entries — preserving event-identity contracts across
   * derivations like `TimeSeries.concat` (step-2 use case).
   *
   * Every entry is structurally validated at adoption:
   * - `cachedEvent.key().equals(columnKey)` (kind, bounds, and
   *   for intervals the label).
   * - Every value field in `cachedEvent.data()` matches the
   *   corresponding column read at that row.
   * - The data field set exactly matches the schema's value
   *   column names (no extras, no missing fields).
   *
   * The store owns its cache copy; mutation of the caller's map
   * post-construction cannot affect the store.
   */
  eventCache?: Map<number, SeriesEvent>;
}

/**
 * The row-API store. Composes a `ColumnarStore<S>` (the framework)
 * with row-shaped materialization, caching, and the five public-API
 * invariants. This is what `TimeSeries` and downstream consumers
 * use.
 */
export class SeriesStore<S extends SeriesSchema = SeriesSchema> {
  readonly store: ColumnarStore<S>;
  readonly #keyCache = new Map<number, EventKey>();
  readonly #eventCache: Map<number, SeriesEvent>;
  // Lazy full-materialization snapshot.
  #eventsArray?: ReadonlyArray<SeriesEvent>;

  private constructor(
    store: ColumnarStore<S>,
    eventCache: Map<number, SeriesEvent>,
  ) {
    this.store = store;
    this.#eventCache = eventCache;
  }

  /** Schema declared at construction. */
  get schema(): S {
    return this.store.schema;
  }

  /** Row count. */
  get length(): number {
    return this.store.length;
  }

  /**
   * Row-intake factory. Accepts a schema + row-shaped data,
   * validates every row via the existing `validate.ts` rules,
   * builds the underlying `ColumnarStore`, and wraps it as a
   * `SeriesStore`. Event identity is preserved: the validated
   * events are pre-populated into the cache, so subsequent
   * `eventAt(i)` calls return the validation-time references.
   *
   * Sub-step 1e scope; complements `fromTrustedStore` for the
   * primary row-API intake path.
   */
  static fromValidatedRows<S extends SeriesSchema>(
    schema: S,
    rows: ReadonlyArray<RowForSchema<S>>,
  ): SeriesStore<S> {
    // Reuse the existing row validator. Returns sorted, normalized
    // events with each row's key + frozen data already built.
    const events = validateAndNormalize<S>({
      name: 'columnar-intake',
      schema,
      rows,
    });
    // EventForSchema<S> is structurally compatible with SeriesEvent
    // (both are Event<Time|TimeRange|Interval, ...>) but TS narrows
    // the key generic to S[0]'s specific kind. The cast widens it
    // back to the union the SeriesStore layer uses.
    return buildSeriesStoreFromEvents(
      schema,
      events as unknown as ReadonlyArray<SeriesEvent>,
    );
  }

  /**
   * Trusted-events factory. Accepts a pre-sorted, pre-validated
   * event array and builds the underlying `ColumnarStore` + lazy
   * caches. **Skips row-level validation** — callers must ensure
   * the events are sorted by key, that every event's key kind
   * matches `schema[0].kind`, and that every event's data
   * conforms to the value columns' kinds. The events themselves
   * are pre-populated into the cache so subsequent `eventAt(i)`
   * calls return the supplied references (preserving identity).
   *
   * Use this when events are already produced by a transform that
   * preserves the sort + validation invariants — e.g.
   * `TimeSeries.fromEvents` / per-group transforms that emit
   * events from an upstream validated series.
   */
  static fromTrustedEvents<S extends SeriesSchema>(
    schema: S,
    events: ReadonlyArray<SeriesEvent>,
  ): SeriesStore<S> {
    return buildSeriesStoreFromEvents(schema, events);
  }

  /**
   * Trusted-construction factory. Accepts a pre-built
   * `ColumnarStore` and an optional `eventCache`. Every cache
   * entry is structurally validated before adoption (see
   * `SeriesStoreOptions.eventCache` for the contract).
   */
  static fromTrustedStore<S extends SeriesSchema>(
    store: ColumnarStore<S>,
    options?: SeriesStoreOptions,
  ): SeriesStore<S> {
    const ownedEventCache = new Map<number, SeriesEvent>();
    const supplied = options?.eventCache;
    if (supplied !== undefined) {
      const schemaValueNames = new Set<string>();
      for (let i = 1; i < store.schema.length; i += 1) {
        schemaValueNames.add(store.schema[i]!.name);
      }
      for (const [rowIndex, cachedEvent] of supplied) {
        validateCachedEvent(rowIndex, cachedEvent, store, schemaValueNames);
        ownedEventCache.set(rowIndex, cachedEvent);
      }
    }
    return new SeriesStore<S>(store, ownedEventCache);
  }

  /**
   * Module-internal trusted-cache factory. Accepts a `ColumnarStore`
   * AND a pre-aligned `eventCache` whose entries are **by-construction
   * guaranteed** to match the store's columns at every row. Skips
   * the per-entry structural validation that the public
   * `fromTrustedStore` runs.
   *
   * The only legitimate caller is `buildSeriesStoreFromEvents`,
   * which constructs the columnar store from the same events that
   * populate the cache — by construction the two are aligned, so
   * the O(N × M) per-entry validation pass in `fromTrustedStore`
   * is pure redundant work. On a 100k-row series with two value
   * columns the redundant validation contributed ~20 ms to intake
   * time (the substrate build itself is ~10 ms). Bypassing it
   * recovers most of the construction-time regression vs the
   * pre-2a row-array baseline.
   *
   * **Not part of the public API.** The leading underscore + the
   * module-private name signal "internal use only". Adopting an
   * externally-supplied cache must always go through
   * `fromTrustedStore` so the strict validation contract holds —
   * a poisoned external cache would silently corrupt downstream
   * `eventAt` reads.
   */
  static _fromValidatedStoreAndCacheModulePrivate<S extends SeriesSchema>(
    store: ColumnarStore<S>,
    cache: Map<number, SeriesEvent>,
  ): SeriesStore<S> {
    return new SeriesStore<S>(store, cache);
  }

  /**
   * Materializes the `EventKey` for row `i`. Returns the concrete
   * `Time` / `TimeRange` / `Interval` instance depending on the
   * underlying key column kind. Lazily cached — `keyAt(i) ===
   * keyAt(i)` holds for the store's lifetime.
   */
  keyAt(i: number): EventKey {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `SeriesStore.keyAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    let cached = this.#keyCache.get(i);
    if (cached === undefined) {
      cached = materializeKey(this.store.keys, i);
      this.#keyCache.set(i, cached);
    }
    return cached;
  }

  /**
   * Materializes the row at index `i` as an `Event` instance.
   * Lazily built and cached — `eventAt(i) === eventAt(i)` holds
   * for the store's lifetime.
   */
  eventAt(i: number): SeriesEvent {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `SeriesStore.eventAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    let cached = this.#eventCache.get(i);
    if (cached === undefined) {
      const key = this.keyAt(i) as Time | TimeRange | Interval;
      const data = buildRowData(this.store, i);
      cached = new Event(key, data) as SeriesEvent;
      this.#eventCache.set(i, cached);
    }
    return cached;
  }

  /**
   * Returns the full row-shaped event array. Built on first call
   * and cached — `toEvents() === toEvents()` holds across calls.
   * The array reuses the per-row `eventAt` cache, so
   * `eventAt(i) === toEvents()[i]` for every valid `i`.
   *
   * **Runtime-frozen.** The returned array is `Object.freeze`d so
   * the memoized cache can't be corrupted by a caller that bypasses
   * the `ReadonlyArray` type (e.g. `(series.events as Event[]).push(...)`).
   * Without the freeze, mutation would poison every subsequent
   * `toEvents()` / `series.events` read with the same array
   * reference, defeating the identity contract. Closed PR #150's
   * Layer-2 high-priority finding on TimeSeries integration.
   */
  toEvents(): ReadonlyArray<SeriesEvent> {
    if (this.#eventsArray !== undefined) return this.#eventsArray;
    const events = new Array<SeriesEvent>(this.length);
    for (let i = 0; i < this.length; i += 1) {
      events[i] = this.eventAt(i);
    }
    Object.freeze(events);
    this.#eventsArray = events;
    return events;
  }

  /**
   * Event-shaped iteration. Yields `Event` instances from the
   * per-row cache — same identity as `eventAt(i)`. Pins the
   * `for (const ev of seriesStore) { ... }` pattern as a public
   * API invariant.
   */
  *[Symbol.iterator](): IterableIterator<SeriesEvent> {
    for (let i = 0; i < this.length; i += 1) {
      yield this.eventAt(i);
    }
  }

  /**
   * Returns row-shaped tuples `[key, ...values]` where `key` is
   * the full `EventKey` instance (`Time` / `TimeRange` /
   * `Interval`) — preserving the complete key identity including
   * interval labels. Matches `RowForSchema<S>` from `types.ts`.
   *
   * Each call rebuilds — `toRows() !== toRows()` — by design.
   * The row format is a transient boundary representation.
   */
  toRows(): ReadonlyArray<ReadonlyArray<unknown>> {
    const rows = new Array<ReadonlyArray<unknown>>(this.length);
    const colNames: string[] = [];
    for (let i = 1; i < this.schema.length; i += 1) {
      colNames.push(this.schema[i]!.name);
    }
    for (let i = 0; i < this.length; i += 1) {
      const row: unknown[] = new Array(colNames.length + 1);
      row[0] = this.keyAt(i);
      for (let c = 0; c < colNames.length; c += 1) {
        row[c + 1] = this.store.columns.get(colNames[c]!)!.read(i);
      }
      rows[i] = row;
    }
    return rows;
  }

  /**
   * Returns row-shaped objects keyed by column name. The key
   * column's field holds the full `EventKey` instance. No
   * synthetic `end` field — a value column named `'end'` cohabits
   * with the key without conflict.
   */
  toObjects(): ReadonlyArray<Readonly<Record<string, unknown>>> {
    const rows = new Array<Readonly<Record<string, unknown>>>(this.length);
    const colNames: string[] = [];
    for (let i = 1; i < this.schema.length; i += 1) {
      colNames.push(this.schema[i]!.name);
    }
    const keyField = this.schema[0]!.name;
    for (let i = 0; i < this.length; i += 1) {
      const row: Record<string, unknown> = {};
      row[keyField] = this.keyAt(i);
      for (let c = 0; c < colNames.length; c += 1) {
        const name = colNames[c]!;
        row[name] = this.store.columns.get(name)!.read(i);
      }
      rows[i] = Object.freeze(row);
    }
    return rows;
  }
}

/* -------------------------------------------------------------------------- */
/* Internal helpers — key + row materialization, cache validation.            */
/* -------------------------------------------------------------------------- */

function materializeKey(keys: KeyColumn, i: number): EventKey {
  if (keys.kind === 'time') {
    return new Time(keys.beginAt(i));
  }
  if (keys.kind === 'timeRange') {
    return new TimeRange({ start: keys.beginAt(i), end: keys.endAt(i) });
  }
  // interval
  const ikeys = keys as IntervalKeyColumn;
  const label = ikeys.labelAt(i);
  if (label === undefined) {
    throw new Error(
      `SeriesStore.keyAt: row ${i} has no interval label (this should have been caught at IntervalKeyColumn construction)`,
    );
  }
  return new Interval({
    value: label,
    start: keys.beginAt(i),
    end: keys.endAt(i),
  });
}

function buildRowData(store: ColumnarStore, i: number): SeriesRowData {
  const data: Record<string, unknown> = {};
  for (let c = 1; c < store.schema.length; c += 1) {
    const name = store.schema[c]!.name;
    data[name] = store.columns.get(name)!.read(i);
  }
  return data as SeriesRowData;
}

/**
 * Structural validation of a single cached `Event` entry against
 * the store's column data. Throws on:
 * - Out-of-range row index.
 * - Key mismatch (kind / bounds / interval label).
 * - Data value mismatch on any schema value column.
 * - Extra fields in `cachedEvent.data()` not declared in the schema.
 */
function validateCachedEvent(
  rowIndex: number,
  cachedEvent: SeriesEvent,
  store: ColumnarStore,
  schemaValueNames: ReadonlySet<string>,
): void {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= store.length) {
    throw new RangeError(
      `SeriesStore: eventCache entry has out-of-range row index ${rowIndex} (column length ${store.length})`,
    );
  }
  // Structural key equality. Catches mismatched key kind,
  // begin/end disagreement, and (for interval keys) divergent
  // label — the full identity contract.
  const columnKey = materializeKey(store.keys, rowIndex);
  const cachedKey = cachedEvent.key();
  if (!cachedKey.equals(columnKey)) {
    throw new RangeError(
      `SeriesStore: eventCache entry at row ${rowIndex} has key (kind '${cachedKey.kind}', begin ${cachedKey.begin()}, end ${cachedKey.end()}) that does not structurally equal the column key (kind '${columnKey.kind}', begin ${columnKey.begin()}, end ${columnKey.end()})`,
    );
  }
  const cachedData = cachedEvent.data() as Readonly<Record<string, unknown>>;
  // Reject extra fields not declared in the schema.
  for (const field of Object.keys(cachedData)) {
    if (!schemaValueNames.has(field)) {
      throw new RangeError(
        `SeriesStore: eventCache entry at row ${rowIndex} has unexpected data field '${field}' not declared in the schema`,
      );
    }
  }
  // Per-column data consistency. Two checks per schema column:
  // (a) when the field is an own property of `cachedData`, its
  //     value must agree with `column.read(rowIndex)` under
  //     kind-aware equality.
  // (b) when the field is **absent** from `cachedData`, the
  //     column at that row must read as `undefined` — i.e. the
  //     event genuinely doesn't carry that column. This is the
  //     outer-join shape: `series.join(other, { type: 'outer' })`
  //     produces events whose data omits the other side's columns
  //     for rows that had no match. Pre-2a TimeSeries treated this
  //     as a row-API concern (the strict missing-field check
  //     pre-dated outer-join via the columnar substrate); the
  //     relaxation here keeps the original misalignment-detection
  //     property — a cached event whose data is missing a field
  //     for which the column DOES read a defined value still
  //     throws.
  for (let c = 1; c < store.schema.length; c += 1) {
    const def = store.schema[c]!;
    const name = def.name;
    const hasField = Object.prototype.hasOwnProperty.call(cachedData, name);
    const columnValue = store.columns.get(name)!.read(rowIndex);
    if (!hasField) {
      if (columnValue !== undefined) {
        throw new RangeError(
          `SeriesStore: eventCache entry at row ${rowIndex} is missing data field '${name}' but the column reads as ${stringifyForError(columnValue)}; missing fields are only valid when the column is also undefined at that row`,
        );
      }
      continue;
    }
    const cachedValue = cachedData[name];
    if (!valuesEqual(columnValue, cachedValue, def.kind)) {
      throw new RangeError(
        `SeriesStore: eventCache entry at row ${rowIndex} has data['${name}'] = ${stringifyForError(cachedValue)} but column read returns ${stringifyForError(columnValue)}`,
      );
    }
  }
}

/**
 * Kind-aware value equality for cache validation.
 *
 * - `'number'` uses `Object.is` so `NaN === NaN` works (the row API
 *   admits `NaN` in some pre-validation paths; reference equality
 *   `===` would reject those).
 * - `'boolean'` / `'string'` use strict equality.
 * - `'array'` uses **shallow element-wise** equality (the
 *   `ArrayColumn` defensive freeze produces different array
 *   instances for semantically identical cells; reference equality
 *   would reject re-built stores with copied-but-equal array
 *   payloads — exactly the cross-derivation cache-sharing path we
 *   need to support).
 * - `undefined` matches `undefined` (invalid cell in both).
 */
function valuesEqual(a: unknown, b: unknown, kind: string): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (kind === 'number') {
    return Object.is(a, b);
  }
  if (kind === 'boolean' || kind === 'string') {
    return a === b;
  }
  if (kind === 'array') {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      // Array elements are `ScalarValue` (number | string | boolean) —
      // reference equality with `Object.is` is correct.
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  // Unknown kind — fall back to strict equality. Defensive default.
  return a === b;
}

function stringifyForError(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(String).join(', ')}]`;
  try {
    return String(v);
  } catch {
    return '<unstringifiable>';
  }
}

/* -------------------------------------------------------------------------- */
/* Event-driven intake — builds a SeriesStore from a validated event array.   */
/* -------------------------------------------------------------------------- */

/**
 * Builds a `SeriesStore<S>` from an already-validated event array.
 * Walks the events once, dispatching key fields into the
 * appropriate key column shape and value fields into per-column
 * builders, then composes the resulting `ColumnarStore` and
 * wraps it with the events as the pre-populated cache.
 *
 * Internal helper for `fromValidatedRows`. The `fromTrustedEvents`
 * public factory (sub-step 1e follow-up) skips the validation step
 * but reuses this same builder.
 */
function buildSeriesStoreFromEvents<S extends SeriesSchema>(
  schema: S,
  events: ReadonlyArray<SeriesEvent>,
): SeriesStore<S> {
  const length = events.length;

  // 1. Key column.
  const keyKind = schema[0]!.kind as 'time' | 'timeRange' | 'interval';
  const begin = new Float64Array(length);
  const end = new Float64Array(length);
  // Pre-walk: capture interval labels for later StringColumn /
  // Float64Column construction.
  let intervalLabels: Array<string | number> | undefined;
  let intervalLabelKind: 'string' | 'number' | undefined;
  if (keyKind === 'interval') {
    intervalLabels = new Array<string | number>(length);
  }
  for (let i = 0; i < length; i += 1) {
    const key = events[i]!.key();
    begin[i] = key.begin();
    end[i] = key.end();
    if (intervalLabels !== undefined) {
      const label = (key as Interval).value;
      intervalLabels[i] = label;
      if (intervalLabelKind === undefined) {
        intervalLabelKind = typeof label === 'string' ? 'string' : 'number';
      } else if (typeof label !== intervalLabelKind) {
        throw new RangeError(
          `SeriesStore.fromValidatedRows: row ${i} has interval label of type ${typeof label} but earlier rows had ${intervalLabelKind} labels — interval-keyed series must use one label type throughout`,
        );
      }
    }
  }

  let keys: KeyColumn;
  if (keyKind === 'time') {
    keys = new TimeKeyColumn(begin, length);
  } else if (keyKind === 'timeRange') {
    keys = new TimeRangeKeyColumn(begin, end, length);
  } else {
    // interval
    if (intervalLabelKind === 'number') {
      const labelBuffer = new Float64Array(length);
      for (let i = 0; i < length; i += 1) {
        labelBuffer[i] = intervalLabels![i] as number;
      }
      const labels = new Float64Column(labelBuffer, length);
      keys = new IntervalKeyColumn(begin, end, labels, length);
    } else {
      // string labels (default; works for empty event arrays too)
      const labels = stringColumnFromArray(
        intervalLabels === undefined
          ? []
          : (intervalLabels as ReadonlyArray<string>),
        { forceDict: true },
      );
      keys = new IntervalKeyColumn(begin, end, labels, length);
    }
  }

  // 2. Value columns.
  const columns = new Map<string, Column>();
  const builders: Array<ColumnBuilder<unknown>> = [];
  const colNames: string[] = [];
  for (let c = 1; c < schema.length; c += 1) {
    const def = schema[c]!;
    builders.push(
      columnBuilderForKind(
        def.kind as 'number' | 'boolean' | 'string' | 'array',
        length,
      ) as ColumnBuilder<unknown>,
    );
    colNames.push(def.name);
  }
  for (let i = 0; i < length; i += 1) {
    const data = events[i]!.data() as Readonly<Record<string, unknown>>;
    for (let c = 0; c < colNames.length; c += 1) {
      builders[c]!.append(data[colNames[c]!] as never);
    }
  }
  for (let c = 0; c < colNames.length; c += 1) {
    columns.set(colNames[c]!, builders[c]!.finalize());
  }

  // 3. Compose store + wrap with eventCache pre-populated.
  const store = ColumnarStore.fromTrustedStore(schema, keys, columns);
  const cache = new Map<number, SeriesEvent>();
  for (let i = 0; i < length; i += 1) {
    cache.set(i, events[i]!);
  }
  // Fast path: skip the per-entry cache validation that
  // `fromTrustedStore` runs. The cache was just built from the
  // same events that populated the store's columns; by
  // construction the two are aligned. Bypassing validation
  // recovers the O(N × M) cost that otherwise dominates intake
  // on large series — for 100k rows × 2 value columns the
  // redundant pass was ~20 ms (the substrate-build itself is
  // ~10 ms).
  return SeriesStore._fromValidatedStoreAndCacheModulePrivate(store, cache);
}

// Re-exports so consumers can write `import { ColumnarStore, SeriesStore }
// from '../series-store.js'` and not need to know about the framework's
// internal barrel. Framework-internal consumers should still import
// from `./columnar/index.js`.
export { ColumnarStore };
export type { Column, KeyColumn };
