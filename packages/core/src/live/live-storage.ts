/**
 * `LiveStorage<S>` — the private storage-strategy layer behind
 * `LiveSeries`.
 *
 * `LiveSeries` owns every public-facing semantic: ordering policy
 * (`strict` / `drop` / `reorder`), grace-window checks, `stats()`
 * counters, the `event → retention → batch → evict` listener
 * ordering, and the rejected-counter. A `LiveStorage` implementation
 * owns only the **mechanics** of holding the buffer: how rows are
 * stored, how a point is read back, how the oldest N rows are
 * evicted, and how a snapshot is produced.
 *
 * Two implementations:
 *
 * - {@link EventArrayLiveStorage} — the row-oriented `Event[]`
 *   backing. Supports `insertSortedTrusted` (the `reorder` mode's
 *   sorted mid-stream insertion). This is the only backing used in
 *   the first storage-strategy PR (behavior-preserving extraction).
 *
 * - `RingLiveStorage` (added in the follow-up) — `ColumnarRingBuffer`
 *   backing for the append-only `strict` / `drop` modes. Skips the
 *   long-lived `Event` retention that drives GC pressure at high
 *   ingest rates. Does NOT support `insertSortedTrusted` (an
 *   append-only ring cannot splice mid-stream); `LiveSeries` only
 *   routes `reorder` mode to the array backing, so the ring backing
 *   never sees that call.
 *
 * The interface is intentionally small. Anything that can be
 * expressed in terms of `length` + `at(i)` + `keyAt(i)` lives in
 * `LiveSeries` (e.g. `find` / `some` / `every` / `bisect`), so the
 * storage surface stays minimal and each implementation stays
 * coherent.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import type { EventKey } from '../core/temporal.js';
import type {
  EventForSchema,
  RowForSchema,
  SeriesSchema,
} from '../schema/index.js';
import { TimeSeries } from '../batch/time-series.js';

/**
 * Comparator used to order the live buffer. Delegates to
 * `EventKey.compare`, which orders:
 *   - Time / TimeRange: by begin / end / type
 *   - Interval: by begin / end / value (so two intervals with the
 *     same span but different values get a stable order)
 *
 * Must match the comparator the Tier 2 query primitives (`bisect`,
 * `includesKey`, `atOrBefore`, `atOrAfter`) use to search the
 * buffer — otherwise interval-keyed series can hold same-span
 * intervals in arrival order while bisect expects value-ascending
 * order, producing false-negative `includesKey` results. Codex
 * caught this on PR #125 review; the comparator now lives here so
 * both `LiveSeries` and the storage backings share one definition.
 */
export function compareKeys(a: EventKey, b: EventKey): number {
  return a.compare(b);
}

/**
 * Private storage strategy behind `LiveSeries`. See the module
 * docstring for the layering contract.
 */
export interface LiveStorage<S extends SeriesSchema> {
  /** Current row count. */
  readonly length: number;

  /**
   * Event at logical index `i` (0-based, oldest first). Returns
   * `undefined` for any out-of-range index (negative or `>= length`).
   * The caller (`LiveSeries`) normalizes negative indices before
   * calling.
   */
  at(index: number): EventForSchema<S> | undefined;

  /**
   * Key at logical index `i`, for binary search. Returns `undefined`
   * for out-of-range indices.
   */
  keyAt(index: number): EventKey | undefined;

  /**
   * Begin timestamp (ms) at logical index `i`. Cheaper than `keyAt`
   * for the `maxAge` retention walk and the ordering comparison —
   * reads a primitive without materializing an `EventKey`. Returns
   * `undefined` for out-of-range indices.
   */
  beginAt(index: number): number | undefined;

  /** Last event (logical index `length - 1`), or `undefined` when empty. */
  last(): EventForSchema<S> | undefined;

  /**
   * Append an event at the tail. The caller guarantees the event's
   * key is `>=` the current last key (ordering policy is enforced by
   * `LiveSeries` before this is called).
   */
  appendTrusted(event: EventForSchema<S>): void;

  /**
   * Insert an event at its sorted position (the `reorder` mode's
   * mid-stream insertion). Only the array backing supports this; the
   * ring backing throws, since `LiveSeries` never routes `reorder`
   * mode to it.
   */
  insertSortedTrusted(event: EventForSchema<S>): void;

  /**
   * Drop the oldest `n` rows and return them as materialized events
   * (for the `evict` listener). `n` is computed by `LiveSeries`'s
   * retention policy and is always `<= length`.
   */
  evictPrefix(n: number): ReadonlyArray<EventForSchema<S>>;

  /**
   * Empty the buffer and return all events that were in it (for the
   * `evict` listener fired by `LiveSeries.clear()`).
   */
  clear(): ReadonlyArray<EventForSchema<S>>;

  /** Immutable snapshot of the current buffer as a `TimeSeries<S>`. */
  snapshot(name: string): TimeSeries<S>;
}

/**
 * `Event[]`-backed storage — the row-oriented backing that
 * `LiveSeries` used before the storage-strategy extraction. Supports
 * sorted mid-stream insertion (`reorder` mode).
 *
 * This is a behavior-preserving extraction: the array, the
 * binary-search-splice insertion, and the prefix-eviction all match
 * the pre-extraction `LiveSeries` internals exactly.
 */
export class EventArrayLiveStorage<
  S extends SeriesSchema,
> implements LiveStorage<S> {
  readonly #schema: S;
  #events: EventForSchema<S>[] = [];

  constructor(schema: S) {
    this.#schema = schema;
  }

  get length(): number {
    return this.#events.length;
  }

  at(index: number): EventForSchema<S> | undefined {
    return this.#events[index];
  }

  keyAt(index: number): EventKey | undefined {
    const event = this.#events[index];
    return event ? event.key() : undefined;
  }

  beginAt(index: number): number | undefined {
    const event = this.#events[index];
    return event ? event.begin() : undefined;
  }

  last(): EventForSchema<S> | undefined {
    return this.#events[this.#events.length - 1];
  }

  appendTrusted(event: EventForSchema<S>): void {
    this.#events.push(event);
  }

  insertSortedTrusted(event: EventForSchema<S>): void {
    // Binary search for the sorted insertion point (rightmost
    // position keeping the buffer non-decreasing by key). Matches
    // the pre-extraction `#insert` reorder branch.
    let lo = 0;
    let hi = this.#events.length;
    const key = event.key();
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareKeys(this.#events[mid]!.key(), key) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.#events.splice(lo, 0, event);
  }

  evictPrefix(n: number): ReadonlyArray<EventForSchema<S>> {
    if (n <= 0) return [];
    return this.#events.splice(0, n);
  }

  clear(): ReadonlyArray<EventForSchema<S>> {
    const evicted = this.#events;
    this.#events = [];
    return evicted;
  }

  snapshot(name: string): TimeSeries<S> {
    const schema = this.#schema;
    const rows = this.#events.map((event) => {
      const row: unknown[] = [event.key()];
      for (let col = 1; col < schema.length; col += 1) {
        row.push(event.get((schema[col] as { name: string }).name));
      }
      return row;
    });
    return new TimeSeries({
      name,
      schema,
      rows: rows as RowForSchema<S>[],
    });
  }
}
