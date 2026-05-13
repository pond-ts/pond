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

import { Event } from './Event.js';
import { Interval } from './Interval.js';
import { Time } from './Time.js';
import { TimeRange } from './TimeRange.js';
import {
  type ColumnarStore,
  type IntervalKeyColumn,
  ColumnarStore as ColumnarStoreClass,
} from './columnar/index.js';
import type { Column } from './columnar/index.js';
import type { KeyColumn } from './columnar/index.js';
import type { EventKey } from './temporal.js';
import type { SeriesSchema } from './types.js';

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
   */
  toEvents(): ReadonlyArray<SeriesEvent> {
    if (this.#eventsArray !== undefined) return this.#eventsArray;
    const events = new Array<SeriesEvent>(this.length);
    for (let i = 0; i < this.length; i += 1) {
      events[i] = this.eventAt(i);
    }
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
  // (a) the field must be an OWN property of `cachedData` — a
  //     missing field that happens to read as `undefined` looks
  //     identical to a present `undefined` via plain
  //     `cachedData[name]`, and would silently slip through
  //     against a column where `column.read(i)` is `undefined`
  //     for that row (invalid cell). Use `hasOwnProperty` to
  //     distinguish.
  // (b) the value (when present) must match `column.read(rowIndex)`
  //     under kind-aware equality.
  for (let c = 1; c < store.schema.length; c += 1) {
    const def = store.schema[c]!;
    const name = def.name;
    if (!Object.prototype.hasOwnProperty.call(cachedData, name)) {
      throw new RangeError(
        `SeriesStore: eventCache entry at row ${rowIndex} is missing required schema data field '${name}'`,
      );
    }
    const columnValue = store.columns.get(name)!.read(rowIndex);
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

// Re-exports so consumers can write `import { ColumnarStore, SeriesStore }
// from '../series-store.js'` and not need to know about the framework's
// internal barrel. Framework-internal consumers should still import
// from `./columnar/index.js`.
export { ColumnarStoreClass as ColumnarStore };
export type { Column, KeyColumn };
