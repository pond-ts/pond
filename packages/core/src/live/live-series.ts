import { Event } from '../core/event.js';
import { Interval } from '../core/interval.js';
import { LiveAggregation } from './live-aggregation.js';
import {
  LivePartitionedSeries,
  type LivePartitionedOptions,
} from './live-partitioned-series.js';
import {
  LiveView,
  makeDiffView,
  makeFillView,
  makeCumulativeView,
  makeStrideSampleView,
  type LiveFillMapping,
  type LiveFillStrategy,
} from './live-view.js';
import { Time } from '../core/time.js';
import { TimeRange } from '../core/time-range.js';
import {
  LiveRollingAggregation,
  type LiveRollingOptions,
  type RollingWindow,
} from './live-rolling-aggregation.js';
import { TimeSeries, toKey, type KeyLike } from '../batch/time-series.js';
import { ValidationError } from '../core/errors.js';
import { parseJsonRows } from '../batch/json.js';
import type { TimeZoneOptions } from '../core/calendar.js';
import type { IntervalInput, TimeRangeInput } from '../core/temporal.js';
import type { Sequence } from '../sequence/sequence.js';
import {
  EMITS_EVICT,
  type AggregateMap,
  type AggregateOutputMap,
  type AggregateSchema,
  type DiffSchema,
  type EventDataForSchema,
  type EventForSchema,
  type FirstColKind,
  type JsonObjectRowForSchema,
  type JsonRowForSchema,
  type JsonRowFormat,
  type NormalizedObjectRow,
  type NormalizedRowForSchema,
  type NumericColumnNameForSchema,
  type RollingSchema,
  type RowForSchema,
  type SelectSchema,
  type SeriesSchema,
  type TimeSeriesJsonInput,
  type TimeSeriesJsonOutputArray,
  type TimeSeriesJsonOutputObject,
} from '../schema/index.js';
import type {
  AggregateOutputMapResultSchema,
  RollingOutputMapSchema,
} from '../schema/index.js';
import { LiveFusedRolling } from './live-fused-rolling.js';
import { LiveReduce } from './live-reduce.js';
import {
  EventArrayLiveStorage,
  compareKeys,
  type LiveStorage,
  type ReadableLiveStorage,
} from './live-storage.js';
import {
  ChunkedColumnarLiveStorage,
  materializeEventsFromStore,
} from './live-chunked-storage.js';
import { validateAndNormalizeColumnar } from '../batch/validate.js';
import { ColumnarStore } from '../columnar/store.js';
import type { SampleStrategy } from '../sequence/sample.js';
import type {
  FusedMapping,
  FusedMappingValid,
  FusedRollingSchema,
} from '../schema/index.js';

import type { DurationInput } from '../core/duration.js';
import { parseDuration } from '../core/duration.js';

// ── Single-row validation ───────────────────────────────────────

const FIRST_COL_KINDS: ReadonlySet<string> = new Set([
  'time',
  'interval',
  'timeRange',
]);

function validateSchema(schema: SeriesSchema): void {
  if (!schema.length) {
    throw new ValidationError('schema must have at least one column');
  }
  if (!FIRST_COL_KINDS.has(schema[0]!.kind)) {
    throw new ValidationError(
      'first column must be one of: time, interval, timeRange',
    );
  }
  for (let col = 1; col < schema.length; col++) {
    const kind = schema[col]!.kind;
    if (
      kind !== 'number' &&
      kind !== 'string' &&
      kind !== 'boolean' &&
      kind !== 'array'
    ) {
      throw new ValidationError(
        `column ${col} has unsupported value kind '${kind}'`,
      );
    }
  }
}

function normalizeKey(
  kind: FirstColKind,
  value: unknown,
): Time | TimeRange | Interval {
  switch (kind) {
    case 'time':
      return value instanceof Time ? value : new Time(value as number | Date);
    case 'timeRange':
      return value instanceof TimeRange
        ? value
        : new TimeRange(value as TimeRangeInput);
    case 'interval':
      return value instanceof Interval
        ? value
        : new Interval(value as IntervalInput);
  }
}

function assertCellKind(kind: string, value: unknown, name: string): void {
  if (value === undefined) return;
  switch (kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new ValidationError(`'${name}': expected finite number`);
      return;
    case 'string':
      if (typeof value !== 'string')
        throw new ValidationError(`'${name}': expected string`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean')
        throw new ValidationError(`'${name}': expected boolean`);
      return;
    case 'array':
      if (!Array.isArray(value))
        throw new ValidationError(`'${name}': expected array of scalars`);
      for (let i = 0; i < value.length; i += 1) {
        const el = value[i];
        const ok =
          (typeof el === 'number' && Number.isFinite(el)) ||
          typeof el === 'string' ||
          typeof el === 'boolean';
        if (!ok) {
          throw new ValidationError(
            `'${name}': array element ${i} must be a finite number, string, or boolean`,
          );
        }
      }
      return;
  }
}

// ── Types ───────────────────────────────────────────────────────

export type OrderingMode = 'strict' | 'drop' | 'reorder';

export type RetentionPolicy = {
  maxEvents?: number;
  maxAge?: DurationInput;
};

export type LiveSeriesOptions<S extends SeriesSchema> = {
  name: string;
  schema: S;
  ordering?: OrderingMode;
  /**
   * Maximum age (relative to the latest event) at which an out-of-order
   * event is still accepted when `ordering: 'reorder'`. Events older
   * than this are rejected at ingest.
   *
   * Scope: enforced at ingest and honored by `LiveAggregation` bucket
   * closure. `rolling()` / `window()` views over a live source do not
   * re-flow late events through historical windows — each reordered
   * arrival is a fresh event at its insertion point, nothing more. See
   * the Live section of the docs for the full late-event scope.
   *
   * When used together with `retention.maxAge`, `graceWindow` must be
   * ≤ `maxAge`. Otherwise a late event could be accepted within grace
   * and then immediately evicted by retention.
   */
  graceWindow?: DurationInput;
  retention?: RetentionPolicy;

  /**
   * @internal Storage-backing override. `'auto'` (default) selects the
   * column-native chunked backing for top-level `strict` time/timeRange
   * series, else the `Event[]` backing. `'array'` forces the `Event[]`
   * backing — used by `LivePartitionedSeries` for partition sub-series
   * and `collect`/`apply` unified buffers (they're fed per-event, and
   * are not the OOM driver — chunking them is deferred to the columnar
   * routing work). Not part of the public API.
   */
  __backing?: 'array' | 'auto';
};

type EventListener<S extends SeriesSchema> = (event: EventForSchema<S>) => void;
type BatchListener<S extends SeriesSchema> = (
  events: ReadonlyArray<EventForSchema<S>>,
) => void;
type EvictListener<S extends SeriesSchema> = (
  events: ReadonlyArray<EventForSchema<S>>,
) => void;

// ── LiveSeries ──────────────────────────────────────────────────

export class LiveSeries<S extends SeriesSchema> {
  readonly [EMITS_EVICT] = true as const;
  readonly name: string;
  readonly schema: S;

  readonly #ordering: OrderingMode;
  readonly #graceWindowMs: number;
  readonly #maxEvents: number;
  readonly #maxAgeMs: number;

  // Reads / retention / snapshot route through `#storage` (uniform).
  // Exactly one of `#perRow` / `#chunked` is non-null — the append
  // path branches on which. The chunked backing takes whole batches
  // (`appendStore`); the array backing takes per-row events.
  #storage: ReadableLiveStorage<S>;
  #perRow: LiveStorage<S> | null;
  #chunked: ChunkedColumnarLiveStorage<S> | null;

  readonly #onEvent: Set<EventListener<S>>;
  readonly #onBatch: Set<BatchListener<S>>;
  readonly #onEvict: Set<EvictListener<S>>;

  // Pipeline counters for {@link LiveSeries.stats}. Incremented in
  // the `pushMany` / `_pushTrustedEvents` paths and `#applyRetention`.
  // Cumulative since construction; never reset.
  #statsIngested = 0;
  #statsEvicted = 0;
  #statsRejected = 0;

  constructor(options: LiveSeriesOptions<S>) {
    this.name = options.name;
    this.schema = Object.freeze([...options.schema]) as unknown as S;

    this.#ordering = options.ordering ?? 'strict';
    this.#graceWindowMs = options.graceWindow
      ? parseDuration(options.graceWindow)
      : Infinity;

    if (this.#ordering !== 'reorder' && options.graceWindow !== undefined) {
      throw new ValidationError(
        'graceWindow is only valid with ordering: "reorder"',
      );
    }

    const ret = options.retention ?? {};
    this.#maxEvents = ret.maxEvents ?? Infinity;
    this.#maxAgeMs = ret.maxAge ? parseDuration(ret.maxAge) : Infinity;

    // A late event accepted within grace but older than maxAge would be
    // evicted the moment retention ran — the grace contract would be a
    // lie. Reject the inconsistent config at construction so the caller
    // fixes whichever half they actually meant. This leaves the common
    // grace ≤ maxAge case untouched.
    if (
      options.graceWindow !== undefined &&
      ret.maxAge !== undefined &&
      this.#graceWindowMs > this.#maxAgeMs
    ) {
      throw new ValidationError(
        `graceWindow (${this.#graceWindowMs}ms) cannot exceed retention.maxAge ` +
          `(${this.#maxAgeMs}ms) — a late event accepted within grace would be ` +
          `evicted immediately by retention`,
      );
    }

    validateSchema(this.schema);

    // Storage strategy. The column-native chunked backing is used for
    // **top-level `strict` time-keyed** series — the batched-source
    // case the OOM fix targets (each `pushMany` batch becomes a chunk,
    // retaining zero `Event` objects). Everything else uses the
    // `Event[]` backing: `reorder` (needs sorted mid-stream insert),
    // `drop` (needs per-row out-of-order filtering), `timeRange`
    // (strict order is (begin, end) — the batch begin-only check
    // wouldn't catch same-begin/different-end inversions; deferred),
    // interval keys, and any series forced to `__backing: 'array'`
    // (partition sub-series / `collect`/`apply` buffers — fed
    // per-event, not the OOM driver). Reads stay storage-agnostic via
    // `#storage`; only the append path branches on `#chunked` vs
    // `#perRow`.
    const keyKind = this.schema[0]!.kind;
    const chunkedEligible =
      (options.__backing ?? 'auto') !== 'array' &&
      this.#ordering === 'strict' &&
      keyKind === 'time';
    if (chunkedEligible) {
      const chunked = new ChunkedColumnarLiveStorage<S>(this.schema);
      this.#chunked = chunked;
      this.#perRow = null;
      this.#storage = chunked;
    } else {
      const array = new EventArrayLiveStorage<S>(this.schema);
      this.#chunked = null;
      this.#perRow = array;
      this.#storage = array;
    }

    this.#onEvent = new Set();
    this.#onBatch = new Set();
    this.#onEvict = new Set();
  }

  get length(): number {
    return this.#storage.length;
  }

  get graceWindowMs(): number {
    return this.#graceWindowMs;
  }

  at(index: number): EventForSchema<S> | undefined {
    if (index < 0) index = this.#storage.length + index;
    return this.#storage.at(index);
  }

  first(): EventForSchema<S> | undefined {
    return this.#storage.at(0);
  }

  last(): EventForSchema<S> | undefined {
    return this.#storage.last();
  }

  // ── Query primitives ─────────────────────────────────────────
  //
  // Mirror the equivalent methods on `TimeSeries`. Live buffers
  // are sorted by key (under all three `OrderingMode`s), so the
  // binary-search shape from batch transfers directly. Useful for
  // dashboard / monitoring consumers where the live buffer IS the
  // working set ("is there an event at key K already?", "what was
  // the last event before time T?").

  /** Example: `live.find(e => e.get('value') > 0)`. First event matching the predicate, or undefined. */
  find(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): EventForSchema<S> | undefined {
    const len = this.#storage.length;
    for (let i = 0; i < len; i += 1) {
      const event = this.#storage.at(i)!;
      if (predicate(event, i)) return event;
    }
    return undefined;
  }

  /** Example: `live.some(e => e.get('healthy'))`. True when at least one event matches. */
  some(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): boolean {
    const len = this.#storage.length;
    for (let i = 0; i < len; i += 1) {
      if (predicate(this.#storage.at(i)!, i)) return true;
    }
    return false;
  }

  /** Example: `live.every(e => e.get('healthy'))`. True when every event matches. */
  every(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): boolean {
    const len = this.#storage.length;
    for (let i = 0; i < len; i += 1) {
      if (!predicate(this.#storage.at(i)!, i)) return false;
    }
    return true;
  }

  /** Example: `live.includesKey(new Time(t))`. True when an event with an exactly matching key exists. */
  includesKey(key: KeyLike): boolean {
    const normalizedKey = toKey(key);
    const index = this.bisect(normalizedKey);
    const keyAt = this.#storage.keyAt(index);
    return keyAt !== undefined && keyAt.equals(normalizedKey);
  }

  /**
   * Example: `live.bisect(new Time(t))`. Insertion index for `key`
   * in the sorted live buffer (binary search; O(log N)). Same shape
   * as `Array.prototype` semantics: returns the lowest index where
   * an event with `key` could be inserted while preserving order.
   */
  bisect(key: KeyLike): number {
    const normalizedKey = toKey(key);
    let low = 0;
    let high = this.#storage.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#storage.keyAt(mid)!.compare(normalizedKey) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Example: `live.atOrBefore(new Time(t))`. Event with the exact key, or the nearest earlier one. */
  atOrBefore(key: KeyLike): EventForSchema<S> | undefined {
    const normalizedKey = toKey(key);
    const index = this.bisect(normalizedKey);
    const keyAt = this.#storage.keyAt(index);
    if (keyAt !== undefined && keyAt.equals(normalizedKey)) {
      return this.#storage.at(index);
    }
    return index === 0 ? undefined : this.#storage.at(index - 1);
  }

  /** Example: `live.atOrAfter(new Time(t))`. Event with the exact key, or the nearest later one. */
  atOrAfter(key: KeyLike): EventForSchema<S> | undefined {
    return this.#storage.at(this.bisect(key));
  }

  push(...rows: RowForSchema<S>[]): void {
    this.pushMany(rows);
  }

  /**
   * Example: `live.pushMany(rows)`. Array-form counterpart to
   * {@link LiveSeries.push}: takes a single `ReadonlyArray<RowForSchema<S>>`
   * instead of variadic args. Behavior is identical — same per-row
   * validation, same `'event'` / `'batch'` / `'evict'` listener
   * semantics, same retention pass at the end.
   *
   * Reach for `pushMany` over `push(...rows)` when ingesting a
   * snapshot or any large rows array — variadic spread allocates a
   * stack frame per element and can blow on multi-thousand-row
   * snapshots. `push(...rows)` itself is now a thin wrapper around
   * this method, so behavior between the two is intentionally
   * identical.
   *
   * For JSON-shape rows arriving over the wire, prefer
   * {@link LiveSeries.pushJson} — it accepts the JSON envelope
   * (nulls, raw timestamps) and parses through `parseJsonRow`.
   */
  pushMany(rows: ReadonlyArray<RowForSchema<S>>): void {
    if (rows.length === 0) return;

    // Chunked (column-native) path: validate the whole batch into
    // columns, no per-row Event. Only top-level strict time/timeRange
    // series select this backing.
    if (this.#chunked) {
      this.#pushManyColumnar(rows);
      return;
    }

    // Per-row (Event[]) path.
    const added: EventForSchema<S>[] = [];

    for (const row of rows) {
      const event = this.#validateRow(row);
      if (this.#insertPerRow(event)) {
        // Increment the counter immediately after a successful
        // insert and BEFORE listener fan-out. If a listener throws
        // partway through the loop, the event is committed in the
        // buffer and reflected in `length` — `ingested` must
        // reflect that too, so callers can recover from listener
        // exceptions without observability counters lying.
        this.#statsIngested++;
        added.push(event);
        for (const fn of this.#onEvent) fn(event);
      } else {
        // Drop-mode silent rejection: out-of-order event under
        // `ordering: 'drop'`. Strict / reorder modes throw; those
        // never reach this counter.
        this.#statsRejected++;
      }
    }

    if (added.length === 0) return;

    // `#applyRetention` updates `#statsEvicted` internally and returns
    // the materialized evicted events only when an `'evict'` listener
    // will consume them.
    const evicted = this.#applyRetention();

    for (const fn of this.#onBatch) fn(added);
    if (evicted.length > 0) {
      for (const fn of this.#onEvict) fn(evicted);
    }
  }

  /**
   * Column-native batch ingest for the chunked backing. Validates the
   * whole batch into typed columns (no per-row `Event`), enforces the
   * strict ordering policy on the batch, appends one chunk, then fans
   * out transient events to listeners only if any are subscribed
   * (no listeners ⇒ no `Event` created — the heap/GC win).
   *
   * Preserves the `event → retention → batch → evict` ordering: all
   * `'event'` fan-out happens before `#applyRetention`.
   */
  #pushManyColumnar(rows: ReadonlyArray<RowForSchema<S>>): void {
    const chunked = this.#chunked!;
    const { keys, columns } = validateAndNormalizeColumnar<S>({
      name: this.name,
      schema: this.schema,
      rows,
    });

    // Strict ordering check on the batch: begin non-decreasing AND the
    // first row `>=` the current last. Throws with the same shape as
    // the per-row `#insertPerRow` strict path. (All-or-nothing: an
    // out-of-order row rejects the whole batch — the chunk is not
    // appended. Strict callers send in-order batches.)
    const n = keys.length;
    let prev =
      chunked.length > 0 ? chunked.beginAt(chunked.length - 1)! : -Infinity;
    for (let i = 0; i < n; i += 1) {
      const b = keys.beginAt(i);
      if (b < prev) {
        throw new ValidationError(
          `out-of-order event: timestamp ${b} is before latest ${prev}`,
        );
      }
      prev = b;
    }

    const store = ColumnarStore.fromTrustedStore(this.schema, keys, columns);
    chunked.appendStore(store);
    this.#statsIngested += n;

    // Materialize the batch's events as transient objects ONLY if an
    // `'event'` / `'batch'` listener will consume them — with no row
    // listeners, no `Event` is ever created (the heap/GC win).
    const added =
      this.#onEvent.size > 0 || this.#onBatch.size > 0
        ? materializeEventsFromStore(store, this.schema)
        : null;

    // `'event'` fan-out fires before retention (the ordering contract).
    if (added) {
      for (const ev of added) {
        for (const fn of this.#onEvent) fn(ev);
      }
    }

    // Retention always runs. It updates `#statsEvicted` internally and
    // returns the materialized evicted events only when an `'evict'`
    // listener exists (else `dropPrefix`, returning `[]`).
    const evicted = this.#applyRetention();

    if (added) {
      for (const fn of this.#onBatch) fn(added);
    }
    if (evicted.length > 0) {
      for (const fn of this.#onEvict) fn(evicted);
    }
  }

  /**
   * @internal — fast-path ingest for events that have already been
   * validated by another trusted pond pipeline (e.g. a source
   * `LiveSeries` whose events are being routed into a partition
   * sub-series with the same schema). Skips `#validateRow` and the
   * `Event` reconstruction it implies — the caller passes the source
   * Event reference through directly.
   *
   * Behaviour is otherwise identical to {@link pushMany}: the same
   * `#insert` ordering rules apply (so out-of-order/late-event handling
   * still works), and `'event'` / `'batch'` / `'evict'` listeners fire
   * normally.
   *
   * **Trust contract.** The caller guarantees the events conform to
   * this series' schema. Currently used only by
   * `LivePartitionedSeries` — the partition router (`#routeEvent`),
   * the `collect()` replay-prefix and live subscriber, and `apply()`'s
   * historical replay, live forwarding, and auto-spawn factory wiring.
   * Each site has compile-time schema identity between source and
   * target. Not exported in the public type surface; reach for
   * `pushMany` from any other context.
   *
   * Surfaced by the gRPC experiment's V3 profiling pass (PR #14):
   * `Event` constructor + `#validateRow` together account for ~7% of
   * per-event self time at saturation, and the partition router was
   * round-tripping `Event → row → Event` for every routed event. This
   * fast path closes that loop.
   */
  _pushTrustedEvents(events: ReadonlyArray<EventForSchema<S>>): void {
    if (events.length === 0) return;

    // Chunked backing: route through the columnar batch path. The
    // partition router feeds array-backed sub-series, so this is only
    // reached by direct callers of `_pushTrustedEvents` on a top-level
    // chunked series. Reconstruct rows and reuse `#pushManyColumnar`
    // (re-validates — acceptable on this rare path; the strict
    // order-check still applies, matching the per-row trusted path).
    if (this.#chunked) {
      const rows: RowForSchema<S>[] = new Array(events.length);
      for (let i = 0; i < events.length; i += 1) {
        rows[i] = this.#eventToRow(events[i]!);
      }
      this.#pushManyColumnar(rows);
      return;
    }

    const added: EventForSchema<S>[] = [];

    for (const event of events) {
      if (this.#insertPerRow(event)) {
        // See pushMany — counter advances before listener fan-out
        // so partial-failure on any listener still leaves
        // `ingested` consistent with `length`.
        this.#statsIngested++;
        added.push(event);
        for (const fn of this.#onEvent) fn(event);
      } else {
        this.#statsRejected++;
      }
    }

    if (added.length === 0) return;

    const evicted = this.#applyRetention();

    for (const fn of this.#onBatch) fn(added);
    if (evicted.length > 0) {
      for (const fn of this.#onEvict) fn(evicted);
    }
  }

  /**
   * Example: `live.pushJson(rows)`. Bulk JSON-shape ingest: takes
   * an array of `JsonRowForSchema<S>` (or the object-form variant),
   * parses each row through {@link parseJsonRow} (translates `null`
   * cells to `undefined`, parses the key into the right
   * `Time`/`TimeRange`/`Interval` instance), then dispatches to
   * {@link LiveSeries.pushMany}.
   *
   * Closes the wire→push safety hole: a `JsonRowForSchema<S>` is
   * structurally typed against the schema (column count, value
   * shapes, null permissibility), so a column added or renamed in
   * the schema breaks the call site at compile time. The previous
   * `live.push(row as never)` workaround swallowed mismatches.
   *
   * Pass a `TimeZoneOptions` second argument to disambiguate
   * local-calendar timestamp strings — same semantics as
   * {@link TimeSeries.fromJSON}'s `parse` option, just inlined as
   * a sibling argument because `pushJson` has no input envelope
   * to attach a `parse:` key to.
   *
   * @example
   * ```ts
   * live.pushJson(rows);
   * live.pushJson(rows, { timeZone: 'Europe/Madrid' });
   * ```
   */
  pushJson(
    rows: ReadonlyArray<JsonRowForSchema<S> | JsonObjectRowForSchema<S>>,
    parse: TimeZoneOptions = {},
  ): void {
    if (rows.length === 0) return;
    this.pushMany(
      parseJsonRows(this.schema, rows, parse) as ReadonlyArray<RowForSchema<S>>,
    );
  }

  clear(): void {
    const evicted = this.#storage.clear();
    if (evicted.length > 0) {
      // `clear()` is observable via the same `'evict'` channel as
      // retention-driven removal, so it increments the same
      // `evicted` counter on `stats()` for consistency. JSDoc on
      // `stats().evicted` documents both paths.
      this.#statsEvicted += evicted.length;
      for (const fn of this.#onEvict) fn(evicted);
    }
  }

  toTimeSeries(name?: string): TimeSeries<S> {
    return this.#storage.snapshot(name ?? this.name);
  }

  /**
   * Example: `live.toRows()`. Returns the current buffer as an
   * array of normalized typed-row tuples — the same shape
   * `pushMany(rows)` accepts. Codec-agnostic: each cell carries its
   * native runtime value (`Time`/`TimeRange`/`Interval` keys,
   * `undefined` for missing data, raw scalars for everything else),
   * so `JSON.stringify` is one option but not the only one — the
   * tuple is also what protobuf / msgpack consumers want before
   * encoding. For a wire-ready snapshot use {@link LiveSeries.toJSON}.
   */
  toRows(): ReadonlyArray<NormalizedRowForSchema<S>> {
    return this.toTimeSeries().toRows();
  }

  /**
   * Example: `live.toObjects()`. Returns the current buffer as an
   * array of schema-keyed object rows — same shape as
   * {@link TimeSeries.toObjects}. Useful when callers want to read
   * by column name rather than tuple position; not the input form
   * to `pushMany` (which takes tuples).
   */
  toObjects(): ReadonlyArray<NormalizedObjectRow> {
    return this.toTimeSeries().toObjects();
  }

  /**
   * Example: `live.toJSON()`. JSON-shape snapshot of the current
   * buffer, suitable for sending over a WebSocket or any
   * `JSON.stringify`-friendly transport. Sugar over
   * `live.toTimeSeries().toJSON(...)`.
   *
   * Defaults to `rowFormat: 'array'` (tuple rows). Pass
   * `{ rowFormat: 'object' }` for schema-keyed object rows. The
   * return type narrows on the option so consumers don't need to
   * cast `result.rows`.
   *
   * Pairs with {@link LiveSeries.fromJSON} for snapshot
   * reconstruction; pairs with {@link LiveSeries.pushJson} for
   * incremental wire ingest.
   */
  toJSON(options?: { rowFormat?: 'array' }): TimeSeriesJsonOutputArray<S>;
  toJSON(options: { rowFormat: 'object' }): TimeSeriesJsonOutputObject<S>;
  toJSON(
    options: { rowFormat?: JsonRowFormat } = {},
  ): TimeSeriesJsonOutputArray<S> | TimeSeriesJsonOutputObject<S> {
    // `TimeSeries.toJSON` returns the broader `TimeSeriesJsonInput<SeriesSchema>`;
    // the values it produces are correct-shaped at runtime for the
    // narrowed types. The cast is the price of keeping the
    // `TimeSeries` signature broad — see the toJSON cascade
    // discussion in PLAN.md.
    return this.toTimeSeries().toJSON(options) as
      | TimeSeriesJsonOutputArray<S>
      | TimeSeriesJsonOutputObject<S>;
  }

  /**
   * Example: `LiveSeries.fromJSON({ name, schema, rows })`. Static
   * factory: builds a fresh `LiveSeries` from a JSON snapshot
   * envelope, parsing each row through {@link parseJsonRow}.
   *
   * The retention/grace/ordering options on the second argument
   * are passed through to the constructor; pass them when you want
   * the reconstructed series to behave like its original (e.g. on
   * a client reconnecting and rehydrating from a server snapshot).
   *
   * Use `parse: { timeZone }` when JSON timestamps are local-
   * calendar strings — same semantics as {@link TimeSeries.fromJSON}.
   */
  static fromJSON<S extends SeriesSchema>(
    input: TimeSeriesJsonInput<S> & { parse?: TimeZoneOptions },
    options: Omit<LiveSeriesOptions<S>, 'name' | 'schema'> = {},
  ): LiveSeries<S> {
    const live = new LiveSeries<S>({
      ...options,
      name: input.name,
      schema: input.schema,
    });
    if (input.rows.length > 0) {
      live.pushJson(
        input.rows as ReadonlyArray<
          JsonRowForSchema<S> | JsonObjectRowForSchema<S>
        >,
        input.parse,
      );
    }
    return live;
  }

  filter(predicate: (event: EventForSchema<S>) => boolean): LiveView<S> {
    return new LiveView(this, (event: EventForSchema<S>) =>
      predicate(event) ? event : undefined,
    );
  }

  map(fn: (event: EventForSchema<S>) => EventForSchema<S>): LiveView<S> {
    return new LiveView(this, fn);
  }

  /**
   * Bounded-memory stream sampling. Thins the event stream going to
   * downstream consumers without affecting this `LiveSeries`'s own
   * `length`, `at(i)`, listeners, or `stats()` counters.
   *
   * v0.17.0 ships **stride only** on the live side — `{ stride: N }`,
   * deterministic 1-in-N, uniform-over-time. Reservoir sampling is
   * snapshot-side only on this release (`TimeSeries.sample`); see
   * {@link SampleStrategy} for the rationale (live reservoir's
   * Algorithm R replacement produces non-prefix evictions; the
   * existing live-eviction protocol is cutoff-based, so bridging
   * needs an exact-removal eviction channel arriving with the
   * streaming RFC's `LiveChange` model).
   *
   * Returns a `LiveView<S>` so the chainable surface
   * (`filter`, `rolling`, `reduce`, `select`, …) is immediately
   * available downstream of the sample.
   *
   * **Multi-entity bias trap.** Pre-partition `live.sample({stride: N})`
   * applied to a structured input stream (e.g., events arriving in
   * round-robin host order) silently keeps the same subset of
   * partitions and drops the rest. The safe shape is to chain after
   * `partitionBy(...)`, which thins each partition's stream
   * independently:
   *
   * ```ts
   * // Safe by construction — per-partition counter is implicit
   * live.partitionBy('host').sample({ stride: 10 }).rolling('5m', m);
   * ```
   *
   * Same multi-entity consideration applies to `rolling` / `aggregate` /
   * `fill` / `diff` / `rate` / `cumulative` / `pctChange` / `reduce`:
   * every stateful live operator silently mixes data across entities
   * on a multi-entity stream unless scoped per-partition first.
   *
   * Reducer outputs downstream of `sample` reflect the sampled
   * stream; multiply by stride to estimate true counts.
   * `live.stats().ingested` continues to count true throughput
   * upstream of any sample.
   */
  sample(strategy: SampleStrategy): LiveView<S> {
    return makeStrideSampleView<S>(this, strategy.stride);
  }

  select<const Keys extends readonly (keyof EventDataForSchema<S>)[]>(
    ...keys: Keys
  ): LiveView<SelectSchema<S, Keys[number] & string>> {
    const newSchema = Object.freeze([
      this.schema[0]!,
      ...this.schema.slice(1).filter((c) => keys.includes(c.name as any)),
    ]) as unknown as SelectSchema<S, Keys[number] & string>;

    return new LiveView(this, (event: any) => event.select(...keys), {
      schema: newSchema,
    });
  }

  window(size: RollingWindow): LiveView<S> {
    if (typeof size === 'number' && Number.isInteger(size) && size > 0) {
      const count = size;
      return new LiveView(this, (event: EventForSchema<S>) => event, {
        evict: (events: readonly EventForSchema<S>[]) =>
          Math.max(0, events.length - count),
      });
    }
    if (typeof size === 'string') {
      const ms = parseDuration(size);
      return new LiveView(this, (event: EventForSchema<S>) => event, {
        evict: (events: readonly EventForSchema<S>[]) => {
          if (events.length === 0) return 0;
          const cutoff = events[events.length - 1]!.begin() - ms;
          let i = 0;
          while (i < events.length && events[i]!.begin() < cutoff) i++;
          return i;
        },
        windowMs: ms,
      });
    }
    throw new TypeError(
      'window must be a positive integer (event count) or duration string',
    );
  }

  aggregate<const M extends AggregateMap<S>>(
    sequence: Sequence,
    mapping: M,
  ): LiveAggregation<S, AggregateSchema<S, M>>;
  aggregate<const M extends AggregateOutputMap<S>>(
    sequence: Sequence,
    mapping: M,
  ): LiveAggregation<S, AggregateOutputMapResultSchema<S, M>>;
  aggregate(
    sequence: Sequence,
    mapping: AggregateMap<S> | AggregateOutputMap<S>,
  ): LiveAggregation<S> {
    return new LiveAggregation(this, sequence, mapping);
  }

  rolling<const M extends AggregateMap<S>>(
    window: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveRollingAggregation<S, RollingSchema<S, M>>;
  rolling<const M extends AggregateOutputMap<S>>(
    window: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveRollingAggregation<S, RollingOutputMapSchema<S, M>>;
  /**
   * Keyed-form fused multi-window rolling. Maintains N windows in
   * one ingest pass over a single shared deque; emits one merged
   * event per trigger boundary with all windows' columns
   * concatenated.
   *
   * **Use this form when** declaring multiple time-windows over the
   * same source — `{ '1m': statsMapping, '200ms': samplesMapping }`.
   * Single-window cases keep using the `(window, mapping, opts)`
   * shape — both are equivalent for one window, but the legacy
   * shape is clearer.
   *
   * **Constraints:** time-based windows only (object keys are
   * duration strings); per-window cadence is not supported (single
   * trigger applies to all windows; users wanting per-window
   * cadence fall back to two separate `rolling()` calls). See
   * PLAN.md "Fused multi-window rolling" for the full rationale.
   */
  rolling<const FM extends FusedMapping<S>>(
    fusedMapping: FM & FusedMappingValid<FM>,
    options?: LiveRollingOptions,
  ): LiveFusedRolling<S, FusedRollingSchema<S, FM>>;
  rolling(
    arg1: RollingWindow | FusedMapping<S>,
    mappingOrOptions?:
      | AggregateMap<S>
      | AggregateOutputMap<S>
      | LiveRollingOptions,
    options?: LiveRollingOptions,
  ): any {
    // Dispatch on first-arg shape: a RollingWindow is a string
    // (duration) or number (count); a FusedMapping is a plain object
    // (record). The single-window legacy path goes to
    // LiveRollingAggregation; the keyed form to LiveFusedRolling.
    if (typeof arg1 === 'object' && arg1 !== null && !Array.isArray(arg1)) {
      return new LiveFusedRolling(
        this,
        arg1 as FusedMapping<S>,
        mappingOrOptions as LiveRollingOptions | undefined,
      );
    }
    return new LiveRollingAggregation(
      this,
      arg1 as RollingWindow,
      mappingOrOptions as AggregateMap<S> | AggregateOutputMap<S>,
      options,
    );
  }

  /**
   * Streaming counterpart to batch `series.reduce(mapping)`.
   * Reduces over the source's *current buffer* — every push
   * adds to the reducer state, every retention eviction removes.
   * The snapshot at any moment is the reduction over what's
   * currently retained.
   *
   * Same mapping shape as `aggregate` / `rolling`; same trigger
   * options as `rolling`. The "window" here is implicit — it's
   * whatever the source retains. For an explicit time-bounded
   * window, use `rolling(duration, mapping, opts)` instead.
   *
   * Returns a `LiveSource<Out>` whose schema is
   * `[time, ...mappingColumns]`. Composes with the rest of the
   * live operator surface.
   */
  reduce<const M extends AggregateMap<S>>(
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveReduce<S, RollingSchema<S, M>>;
  reduce<const M extends AggregateOutputMap<S>>(
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveReduce<S, RollingOutputMapSchema<S, M>>;
  reduce(
    mapping: AggregateMap<S> | AggregateOutputMap<S>,
    options?: LiveRollingOptions,
  ): LiveReduce<S> {
    return new LiveReduce(this, mapping, options);
  }

  /**
   * Time span of the current buffer — `last.begin() - first.begin()`
   * in milliseconds. Returns `0` if the buffer is empty or holds a
   * single event. Useful for the "how much data am I holding right
   * now?" question that buffer-as-window users ask.
   *
   * `O(1)` — reads first/last directly.
   */
  timeRange(): number {
    const len = this.#storage.length;
    if (len < 2) return 0;
    return this.#storage.beginAt(len - 1)! - this.#storage.beginAt(0)!;
  }

  /**
   * Events per second over the current buffer. Computed as
   * `length / (timeRange / 1000)`. Returns `0` if the buffer is
   * empty or holds a single event (no time span to divide by).
   *
   * Mirrors {@link LiveView.eventRate}; available directly on
   * `LiveSeries` for the buffer-as-window pattern where the user
   * doesn't want a separate windowed view.
   */
  eventRate(): number {
    const span = this.timeRange();
    if (span === 0) return 0;
    return (this.#storage.length / span) * 1000;
  }

  /**
   * Pipeline stats snapshot — cumulative counters since
   * construction plus current buffer state. Cheap O(1).
   *
   * - `ingested`: total events accepted (after validation +
   *   `#insert`). Never decreases.
   * - `evicted`: total events removed from the buffer — by
   *   retention OR by an explicit {@link LiveSeries.clear} call.
   *   Both paths fire the `'evict'` listener; this counter
   *   matches that same fan-out. Never decreases.
   * - `rejected`: total events silently rejected (drop-mode
   *   out-of-order arrivals). Strict / reorder modes throw on
   *   rejection — those don't count here.
   * - `length`: current buffer size (= `this.length`).
   * - `earliestTs` / `latestTs`: timestamps of buffer ends, or
   *   undefined if the buffer is empty.
   *
   * Use case: long-running pipelines that want headline counters
   * without wiring `live.on('batch'/'evict')` listeners by hand.
   * The gRPC experiment's manual-counter pattern is exactly this
   * shape.
   */
  stats(): {
    ingested: number;
    evicted: number;
    rejected: number;
    length: number;
    earliestTs?: number;
    latestTs?: number;
  } {
    const length = this.#storage.length;
    const result: {
      ingested: number;
      evicted: number;
      rejected: number;
      length: number;
      earliestTs?: number;
      latestTs?: number;
    } = {
      ingested: this.#statsIngested,
      evicted: this.#statsEvicted,
      rejected: this.#statsRejected,
      length,
    };
    if (length > 0) {
      result.earliestTs = this.#storage.beginAt(0)!;
      result.latestTs = this.#storage.beginAt(length - 1)!;
    }
    return result;
  }

  diff<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LiveView<DiffSchema<S, Target>> {
    return makeDiffView(this, 'diff', columns, options);
  }

  rate<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LiveView<DiffSchema<S, Target>> {
    return makeDiffView(this, 'rate', columns, options);
  }

  pctChange<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LiveView<DiffSchema<S, Target>> {
    return makeDiffView(this, 'pctChange', columns, options);
  }

  fill(
    strategy: LiveFillStrategy | LiveFillMapping<S>,
    options?: { limit?: number },
  ): LiveView<S> {
    return makeFillView(this, strategy, options);
  }

  cumulative<const Targets extends NumericColumnNameForSchema<S>>(spec: {
    [K in Targets]:
      | 'sum'
      | 'max'
      | 'min'
      | 'count'
      | ((acc: number, value: number) => number);
  }): LiveView<DiffSchema<S, Targets>> {
    return makeCumulativeView(this, spec);
  }

  /**
   * Live counterpart to {@link TimeSeries.partitionBy}. Routes
   * events into per-partition `LiveSeries` sub-buffers, each with
   * its own retention, grace window, and stateful operator
   * pipeline. Use `apply((sub) => sub.fill(...).rolling(...))` to
   * compose live operators per partition; `collect()` to fan
   * partitioned outputs into a unified `LiveSeries`.
   *
   * **Default-inherit (v0.17.1+).** When no explicit options are
   * passed, partition sub-series inherit this source's `ordering`,
   * `graceWindow`, and `retention`. The fix is structural — pre-fix,
   * partitions defaulted to `'strict'` regardless of source, so late
   * events the source accepted under `'reorder'` crashed the
   * partition router on insert. Explicit options on
   * `partitionBy(by, { ordering, graceWindow, retention })` override
   * inheritance per-field.
   *
   * **Multi-entity series:** every stateful live operator
   * (`rolling`, `fill`, `diff`, `rate`, `cumulative`, `pctChange`)
   * silently mixes data across entities on a multi-host stream
   * unless scoped per-partition first.
   *
   * **Post-commit error semantics.** The partition view runs as a
   * `'event'` listener on this `LiveSeries`. By the time a
   * partitioning failure throws (a rogue value not in declared
   * `groups`, or a stricter partition ordering rejecting an event
   * the source accepted), the source has already committed the
   * event — `this.length` reflects it. The caller's `push()`
   * surfaces the listener's throw, but the source state has
   * already moved. Validate inputs upstream of `push()` if
   * source/partition atomicity matters.
   *
   * See {@link LivePartitionedSeries}.
   */
  /**
   * Type-parameter order is `<ByCol, K>` (column name first, then
   * partition value type) so the explicit-arg form
   * `partitionBy<'host'>('host')` binds the literal to `ByCol`.
   * That preserves backwards compatibility with the v0.15.0 V8
   * workaround pattern (which used the explicit-arg form to force
   * column-literal narrowing through the fused-rolling typing
   * chain) — and matches what callers usually want when they reach
   * for the explicit form: declare the partition column.
   *
   * `K` (the partition VALUE type) typically narrows from
   * `groups`; an explicit `<ByCol, K>` second arg is rare. If a
   * caller wants an explicit value union, the natural form is
   * `partitionBy('host', { groups: [...] as const })`.
   */
  partitionBy<
    ByCol extends keyof EventDataForSchema<S> & string =
      keyof EventDataForSchema<S> & string,
    K extends string = string,
  >(
    by: ByCol,
    options?: LivePartitionedOptions<K>,
  ): LivePartitionedSeries<S, K, ByCol> {
    // Default-inherit ordering / graceWindow / retention from this
    // source. Pre-fix, partition sub-series defaulted to `'strict'`
    // regardless of source ordering — a footgun first measured by
    // the gRPC experiment's M4 friction note: under source `'reorder'`
    // + bare `partitionBy`, late events the source accepts via the
    // reorder path are routed into a sub-series under `'strict'`,
    // where `#insert` throws, and the throw propagates back through
    // the source's listener fan-out into `live.push`. 99.5% of late
    // events crashed the partition router.
    //
    // Inheritance happens at the API layer here (rather than inside
    // `LivePartitionedSeries`) because `LivePartitionedSeries` accepts
    // a loose `LiveSource<S>` source, but `partitionBy` is only
    // exposed on `LiveSeries` — so this method always knows the
    // source is a `LiveSeries` and can read its config directly.
    // Explicit options on `partitionBy(...)` win over inheritance.
    const merged: LivePartitionedOptions<K> = {
      ...options,
    };
    if (merged.ordering === undefined) {
      merged.ordering = this.#ordering;
    }
    // graceWindow only inherits when effective ordering is 'reorder'.
    // LiveSeries' constructor rejects graceWindow with strict/drop
    // orderings; if the caller explicitly overrides ordering to
    // 'strict' on a reorder source, we'd hand the partition's
    // LiveSeries a forbidden combination. Gate explicitly.
    if (
      merged.graceWindow === undefined &&
      merged.ordering === 'reorder' &&
      this.#graceWindowMs !== Infinity
    ) {
      merged.graceWindow = this.#graceWindowMs;
    }
    if (merged.retention === undefined) {
      const retention: RetentionPolicy = {};
      if (this.#maxEvents !== Infinity) retention.maxEvents = this.#maxEvents;
      if (this.#maxAgeMs !== Infinity) retention.maxAge = this.#maxAgeMs;
      if (Object.keys(retention).length > 0) merged.retention = retention;
    }
    return new LivePartitionedSeries<S, K, ByCol>(this, by, merged);
  }

  on(type: 'event', fn: EventListener<S>): () => void;
  on(type: 'batch', fn: BatchListener<S>): () => void;
  on(type: 'evict', fn: EvictListener<S>): () => void;
  on(
    type: 'event' | 'batch' | 'evict',
    fn: EventListener<S> | BatchListener<S> | EvictListener<S>,
  ): () => void {
    const set =
      type === 'event'
        ? this.#onEvent
        : type === 'batch'
          ? this.#onBatch
          : this.#onEvict;
    set.add(fn as any);
    return () => {
      set.delete(fn as any);
    };
  }

  // ── Private ─────────────────────────────────────────────────

  #validateRow(row: RowForSchema<S>): EventForSchema<S> {
    const arr = row as unknown[];
    if (arr.length !== this.schema.length) {
      throw new ValidationError(
        `expected ${this.schema.length} values, got ${arr.length}`,
      );
    }

    const keyDef = this.schema[0]!;
    const key = normalizeKey(keyDef.kind as FirstColKind, arr[0]);
    const data: Record<string, unknown> = {};

    for (let col = 1; col < this.schema.length; col++) {
      const def = this.schema[col]!;
      const value = arr[col];
      if (value === undefined) {
        if (def.required !== false) {
          throw new ValidationError(`column '${def.name}' is required`);
        }
        data[def.name] = undefined;
        continue;
      }
      assertCellKind(def.kind, value, def.name);
      // Freeze a shallow copy of array cells so downstream consumers can
      // treat them as immutable (matches the batch `validate.ts` path).
      if (def.kind === 'array' && Array.isArray(value)) {
        data[def.name] = Object.freeze(value.slice());
      } else {
        data[def.name] = value;
      }
    }

    return new Event(key, data) as unknown as EventForSchema<S>;
  }

  /** Reconstruct a row tuple `[key, ...values]` from an event. */
  #eventToRow(event: EventForSchema<S>): RowForSchema<S> {
    const row: unknown[] = [event.key()];
    for (let col = 1; col < this.schema.length; col += 1) {
      row.push(event.get((this.schema[col] as { name: string }).name));
    }
    return row as RowForSchema<S>;
  }

  /**
   * Ordering-policy gate. Decides whether `event` is accepted into
   * the buffer, and via which storage mutation:
   *
   * - In-order (key `>=` last): appended at the tail.
   * - Out-of-order under `strict`: throws.
   * - Out-of-order under `drop`: returns `false` (rejected).
   * - Out-of-order under `reorder` (within grace): sorted-inserted.
   * - Out-of-order under `reorder` (past grace): throws.
   *
   * `LiveSeries` owns the policy; the array backing owns the
   * mutation (`appendTrusted` / `insertSortedTrusted`). Returns
   * `true` if the event was accepted, `false` if dropped. Only the
   * per-row (array) path uses this; the chunked path validates +
   * order-checks the whole batch in `#pushManyColumnar`.
   */
  #insertPerRow(event: EventForSchema<S>): boolean {
    const perRow = this.#perRow!;
    const last = perRow.last();

    if (!last || compareKeys(last.key(), event.key()) <= 0) {
      perRow.appendTrusted(event);
      return true;
    }

    switch (this.#ordering) {
      case 'strict':
        throw new ValidationError(
          `out-of-order event: timestamp ${event.begin()} is before latest ${last.begin()}`,
        );

      case 'drop':
        return false;

      case 'reorder': {
        if (
          this.#graceWindowMs !== Infinity &&
          last.begin() - event.begin() > this.#graceWindowMs
        ) {
          throw new ValidationError(
            `event at ${event.begin()} is outside grace window ` +
              `(latest: ${last.begin()}, grace: ${this.#graceWindowMs}ms)`,
          );
        }
        perRow.insertSortedTrusted(event);
        return true;
      }
    }
  }

  /**
   * Retention policy. Computes how many oldest rows to evict from
   * `maxEvents` (count cap) and `maxAge` (time cap), then asks the
   * storage backing to drop that prefix and return the evicted
   * events for the `'evict'` listener.
   *
   * `LiveSeries` owns the policy (reading `length` + `beginAt`);
   * the storage backing owns the eviction mechanics. Runs once per
   * push, AFTER the per-event listener fan-out — so a per-event
   * listener observes the pre-retention buffer state, preserving
   * the `event → retention → batch → evict` contract.
   *
   * Updates `#statsEvicted` by count internally (listener-independent)
   * and only materializes the evicted events when an `'evict'`
   * listener will consume them — otherwise `dropPrefix` skips the
   * per-row materialization (the dominant avoidable cost on the
   * chunked backing's retention hot path).
   */
  #applyRetention(): ReadonlyArray<EventForSchema<S>> {
    let evictCount = 0;
    const len = this.#storage.length;

    if (len > this.#maxEvents) {
      evictCount = len - this.#maxEvents;
    }

    if (this.#maxAgeMs !== Infinity && len > 0) {
      const latest = this.#storage.beginAt(len - 1)!;
      const cutoff = latest - this.#maxAgeMs;
      let i = evictCount;
      while (i < len && this.#storage.beginAt(i)! < cutoff) {
        i++;
      }
      evictCount = Math.max(evictCount, i);
    }

    if (evictCount === 0) return [];

    this.#statsEvicted += evictCount;
    if (this.#onEvict.size === 0) {
      this.#storage.dropPrefix(evictCount);
      return [];
    }
    return this.#storage.evictPrefix(evictCount);
  }
}
