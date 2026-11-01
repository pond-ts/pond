import { Expr } from '../core/expression.js';
import { livePredicate } from './expression-predicate.js';
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
  makeMapView,
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
import {
  TimeSeries,
  assertSelectKeys,
  toKey,
  type KeyLike,
} from '../batch/time-series.js';
import { ValidationError } from '../core/errors.js';
import { parseJsonRows } from '../batch/json.js';
import type { TimeZoneOptions } from '../core/calendar.js';
import type { IntervalInput, TimeRangeInput } from '../core/temporal.js';
import type { Sequence } from '../sequence/sequence.js';
import {
  EMITS_EVICT,
  type AggregateMap,
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
  materializeEventsFromStoreAt,
} from './live-chunked-storage.js';
import { validateAndNormalizeColumnar } from '../batch/validate.js';
import { ColumnarStore } from '../columnar/store.js';
import { Float64Column, type Column } from '../columnar/column.js';
import { TimeKeyColumn, type KeyColumn } from '../columnar/key-column.js';
import type { SampleStrategy } from '../sequence/sample.js';
import type {
  FusedMapping,
  FusedMappingValid,
  FusedRollingSchema,
  ValidatedAggregateMap,
} from '../schema/index.js';

import type { DurationInput } from '../core/duration.js';
import { parseDuration } from '../core/duration.js';
import { ListenerSet } from './listener-set.js';

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
   * column-native chunked backing for top-level `strict` time-keyed
   * series, else the `Event[]` backing. `'array'` forces the `Event[]`
   * backing — used by `LivePartitionedSeries` for the per-event routing
   * path (a non-chunked source) and the `collect` / `apply` unified
   * buffers. Partition sub-series of a chunked source instead route
   * column-native and adopt the chunked backing (see `_stageRowsOpen`). Not
   * part of the public API.
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

/**
 * @internal A compact copy of a `pushSeries` batch's time key and value
 * columns (`columns` is updated in place; the key is returned). Number
 * columns and the key copy their buffer with one `slice`, which measured
 * several times faster than a per-row gather; other kinds gather.
 * Exported for tests only (not from the package index).
 */
export function copyBatch(
  key: TimeKeyColumn,
  columns: Map<string, Column>,
  n: number,
): TimeKeyColumn {
  let rows: Int32Array | undefined;
  for (const [name, col] of columns) {
    if (col instanceof Float64Column) {
      columns.set(
        name,
        new Float64Column(col._values.slice(0, n), n, col.allFinite),
      );
      continue;
    }
    if (rows === undefined) {
      rows = new Int32Array(n);
      for (let i = 0; i < n; i += 1) rows[i] = i;
    }
    columns.set(name, col.sliceByIndices(rows));
  }
  return TimeKeyColumn.fromValidatedSubarray(key.begin.slice(0, n), n);
}

// ── LiveSeries ──────────────────────────────────────────────────

/**
 * A mutable, append-optimized event buffer for live ingestion — the entry
 * point to the live layer. `push` validates rows against the same schema
 * as `TimeSeries`, retention (`maxEvents` / `maxAge`) bounds the buffer,
 * and subscribers react on the `'event'`, `'batch'`, and `'evict'`
 * channels; snapshot to the batch layer at any time with `toTimeSeries()`.
 * Example: `new LiveSeries({ name, schema, retention: { maxEvents: 10_000 } })`.
 */
/** [PND-LIVFIX] Surface the first listener error once the push has completed. */
function rethrowFirst(errors: ReadonlyArray<unknown>): void {
  if (errors.length > 0) throw errors[0];
}

export class LiveSeries<S extends SeriesSchema> {
  /** @internal */
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

  readonly #onEvent: ListenerSet<EventListener<S>>;
  readonly #onBatch: ListenerSet<BatchListener<S>>;
  readonly #onEvict: ListenerSet<EvictListener<S>>;
  /** [PND-REDUCETICK] End-of-push listeners; see `settle.ts`. */
  readonly #onSettle: ListenerSet<() => void> = new ListenerSet();
  /**
   * [PND-LIVFIX] Re-entrancy guard. `> 0` while a push is fanning out to
   * listeners. A push that arrives from inside a listener (`#dispatchDepth
   * > 0`) is queued on `#pendingPushes` and run after the outer push has
   * fully completed (retention, `'batch'`, `'evict'`), so emission order
   * stays monotonic and the nested rows are order-checked against the
   * buffer at their turn rather than mid-fan-out.
   */
  #dispatchDepth = 0;
  #pendingPushes: Array<() => void> = [];
  /** `true` while the outermost guard is draining `#pendingPushes`. */
  #draining = false;
  /**
   * Column-native delta subscribers (chunked backing only). Fires with
   * the appended `ColumnarStore` per `pushMany` — the internal hook the
   * partition router uses to route column-native (no `Event`
   * materialization). Empty unless a `_onChunk` consumer attached.
   */
  readonly #onChunk: Set<(store: ColumnarStore<S>) => void>;

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

    this.#onEvent = new ListenerSet();
    this.#onBatch = new ListenerSet();
    this.#onChunk = new Set();
    this.#onEvict = new ListenerSet();
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

  /**
   * @internal [PND-REDUCETICK] Subscribe to the end of every push: fires
   * once per `push` / `pushMany` / `pushJson` / `pushSeries` (and each
   * internal push), after `'evict'`, still inside the push. See
   * `settle.ts`.
   */
  _onSettle(fn: () => void): () => void {
    this.#onSettle.add(fn);
    return () => this.#onSettle.delete(fn);
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
   * (nulls, raw timestamps) and parses through `parseJsonRow`. For data
   * that already comes in columns (typed arrays off a socket or a
   * worker), build a batch with `TimeSeries.fromColumns` and push it with
   * {@link LiveSeries.pushSeries}: no row tuples, and on a default series
   * no per-row check.
   *
   * **Commit granularity differs by backing.** On the `Event[]`
   * backing each row is appended then its `'event'` fires, so a
   * handler observes `length` grow row-by-row (`1, 2, …`) within one
   * `pushMany`. On the chunked columnar backing (top-level `strict`
   * time-keyed series) the whole batch is appended as one chunk
   * *before* any `'event'` fires, so a handler sees the full post-batch
   * `length` for every event of the batch. This is intrinsic to
   * all-or-nothing columnar append — per-row commit would reintroduce
   * the per-row `Event` cost the chunked backing exists to avoid. The
   * cross-backing contract callers can rely on: every
   * successfully-ingested row fires exactly one `'event'`, in order,
   * before `'batch'`/`'evict'`.
   *
   * **Listener errors are isolated** ([PND-LIVFIX]). A listener that
   * throws does not stop the push: every row is still committed, the
   * remaining listeners still run, retention still runs, and `'batch'` /
   * `'evict'` still fire. The first error is rethrown to the caller once
   * the push has completed, so `length`, `ingested` and every subscriber
   * (a derived `filter()` view included) agree afterwards. A push made
   * from inside a listener is queued and runs after the current push,
   * in arrival order, so emission stays monotonic.
   */
  pushMany(rows: ReadonlyArray<RowForSchema<S>>): void {
    if (rows.length === 0) return;
    if (this.#dispatchDepth > 0) {
      // Re-entrant push from inside a listener: defer until the outer
      // push has completed. See `#dispatchDepth`.
      this.#pendingPushes.push(() => this.pushMany(rows));
      return;
    }
    this.#guarded(() => {
      // Chunked (column-native) path: validate the whole batch into
      // columns, no per-row Event. Only top-level strict time-keyed
      // series select this backing.
      if (this.#chunked) {
        this.#pushManyColumnar(rows);
        return;
      }

      // Per-row (Event[]) path. [PND-BATCHATOM] Validate every row and
      // check the whole batch's ordering BEFORE committing any of it, so a
      // bad row refuses the batch whole (as the chunked path does) instead
      // of leaving earlier rows committed with retention, 'batch' and
      // 'evict' skipped.
      this.#commitPerRow(rows.map((row) => this.#validateRow(row)));
    });
  }

  /**
   * Example: `live.pushSeries(TimeSeries.fromColumns({ name: 'ticks', schema: live.schema, columns: { time, price, size } }))`.
   * Pushes a batch `TimeSeries` as one batch: the same checks, ordering,
   * retention and `'event'` / `'batch'` / `'evict'` listeners as
   * {@link LiveSeries.pushMany} of its rows, and the same all-or-nothing
   * rule (a refused batch stores nothing; the one exception, shared with
   * `pushMany`, is a `partitionBy` router error on a default series,
   * which comes after the batch is stored). It is how column-shaped data
   * gets into a live series: build the batch with
   * `TimeSeries.fromColumns` (typed arrays in) and push it. "Its rows"
   * assumes the batch's rows and columns agree, which every validating
   * constructor guarantees (`TimeSeries.fromEvents` doesn't check).
   *
   * **Where it is faster.** On a default series (`ordering: 'strict'`,
   * `time` key) the batch's columns are stored as they are, with no
   * per-row check and no `Event` per row, so a large batch costs about
   * what `fromColumns` costs: 100k rows in batches of 1,600 took 1.6 ms
   * against `pushMany`'s 18.7 ms (`scripts/perf-live-push-series.mjs`).
   * Two things bring back an `Event` per row and most of `pushMany`'s
   * cost: a listener on `'event'` or `'batch'` (a `window()`, `filter()`
   * or other view built on the series is one; ~1.3-1.4x), and the other
   * storage mode (`ordering: 'drop'` / `'reorder'`, or a `timeRange` /
   * `interval` key), where the batch's rows go through `pushMany`'s row
   * path (~1x). Results are the same either way. For one row at a time
   * use `push`: a `TimeSeries` per row costs more than it saves.
   *
   * **Matching.** The batch's key kind must be the live series' (the
   * key column's name may differ). Value columns are matched by name, in
   * any order, and must have the live column's kind; a missing or extra
   * column is refused. (The parameter's type asks for this series'
   * schema, so in TypeScript the by-name matching matters for a batch
   * whose schema is only known at run time, passed with a cast.) A gap
   * in a column the live schema marks required is refused, naming the
   * first such row, whatever the batch's own schema says. Rows inside the
   * batch are already in order (a `TimeSeries` is sorted); against the
   * rows held, `ordering` applies as in `pushMany`.
   *
   * **The batch's buffers are shared, not copied.** On a default series
   * the live series keeps the batch's key and number columns, and
   * `fromColumns` keeps the `Float64Array`s it was given, so the live
   * series ends up holding your arrays. Don't write to, reuse or pool a
   * pushed `Float64Array` while its rows are still in the series: rows are
   * not checked again, so a write changes rows already stored and can
   * leave their keys out of order (lookups such as `atOrBefore` then go
   * wrong, and a later `toTimeSeries()` throws), while a row already read
   * with `at()` keeps its old value. If you reuse buffers, push
   * `buf.slice(0, n)` (or a `number[]`, which `fromColumns` copies). A
   * push made from inside a listener is queued and reads the batch when it
   * runs, whatever the storage mode, so leave its arrays alone until then.
   * One case is copied: a batch whose key sits in a buffer more than twice
   * the size of all its columns (a `slice()` of a bigger series, which
   * shares its parent's buffers), so a small batch never keeps a big
   * parent alive. Views into a buffer about the batch's size
   * (one worker message holding every column) are kept as they are.
   *
   * **NaN and other non-finite numbers** in a batch from `fromColumns`
   * are gaps, because that is how `fromColumns` reads them (`pushMany`
   * refuses one instead): in an optional column they are stored as
   * missing, in a required one they are refused.
   *
   * An empty batch is checked for shape and otherwise ignored. A push
   * made from inside a listener is queued and runs after the current
   * push, like `pushMany`'s.
   *
   * @throws TypeError when `series` is not a `TimeSeries`.
   * @throws ValidationError on a key-kind mismatch, a missing, extra or
   *   wrong-kind column, a gap in a required column, or a row that the
   *   series' `ordering` refuses (e.g. a first row older than the newest
   *   row held, under `'strict'`).
   */
  pushSeries(series: TimeSeries<S>): void {
    if (!(series instanceof TimeSeries)) {
      throw new TypeError('pushSeries: expected a TimeSeries');
    }
    // Checked even when empty, as pond-rs `push_series` does: a batch of
    // the wrong shape is an error whatever its length.
    if (series.length === 0) {
      this.#checkSeries(series);
      return;
    }
    if (this.#dispatchDepth > 0) {
      this.#pendingPushes.push(() => this.pushSeries(series));
      return;
    }
    this.#guarded(() => {
      const columns = this.#checkSeries(series);
      let key = series.keyColumn() as KeyColumn;
      // The chunked backing keeps the batch's buffers. A `slice()` shares
      // its parent's, so keeping it would keep the whole parent alive:
      // copy a batch whose key sits in a buffer over twice the size of
      // all its columns.
      if (
        this.#chunked &&
        key.begin.buffer.byteLength > 16 * series.length * this.schema.length
      ) {
        key = copyBatch(key as TimeKeyColumn, columns, series.length);
      }
      // Re-wrap the key and value columns against this series' schema:
      // O(columns), no row is read or copied.
      const store = ColumnarStore.fromTrustedStore(this.schema, key, columns);
      if (this.#chunked) {
        this.#commitChunk(store);
        return;
      }
      this.#commitPerRow(materializeEventsFromStore(store, this.schema));
    });
  }

  /**
   * `pushSeries`' shape check: key kind, every live value column present
   * by name with its kind, no extra column, and no gap in a column this
   * series requires. Returns the batch's columns keyed by name.
   */
  #checkSeries(series: TimeSeries<S>): Map<string, Column> {
    const live = this.schema as SeriesSchema;
    const theirs = series.schema as SeriesSchema;
    const theirKey = theirs[0]!.kind;
    if (theirKey !== live[0]!.kind) {
      throw new ValidationError(
        `pushSeries: series '${series.name}' is keyed by '${theirKey}', ` +
          `but live series '${this.name}' is keyed by '${live[0]!.kind}'`,
      );
    }
    const column = (name: string) =>
      (series as unknown as { column(n: string): Column | undefined }).column(
        name,
      );
    const columns = new Map<string, Column>();
    for (let j = 1; j < live.length; j += 1) {
      const def = live[j]!;
      const col = column(def.name);
      if (col === undefined) {
        const has = theirs
          .slice(1)
          .map((c) => c.name)
          .join(', ');
        throw new ValidationError(
          `pushSeries: series '${series.name}' has no column '${def.name}' ` +
            `(it has: ${has || 'none'})`,
        );
      }
      if (col.kind !== def.kind) {
        throw new ValidationError(
          `pushSeries: column '${def.name}' is '${col.kind}' in series ` +
            `'${series.name}' but '${def.kind}' in live series '${this.name}'`,
        );
      }
      columns.set(def.name, col);
    }
    for (let j = 1; j < theirs.length; j += 1) {
      const name = theirs[j]!.name;
      if (!columns.has(name)) {
        throw new ValidationError(
          `pushSeries: series '${series.name}' has column '${name}', which ` +
            `live series '${this.name}' does not declare`,
        );
      }
    }
    // Required is judged by this series' schema, not the batch's:
    // `fromColumns` doesn't enforce `required`, so the batch's flag
    // proves nothing. No validity bitmap means every cell is defined.
    // Name the first bad cell in row order, as `pushMany` does.
    let badRow = Infinity;
    let badCol = 0;
    for (let j = 1; j < live.length; j += 1) {
      const def = live[j]!;
      if (def.required === false) continue;
      const col = columns.get(def.name)!;
      const validity = col.validity;
      if (validity === undefined || validity.definedCount >= col.length) {
        continue;
      }
      let i = 0;
      while (i < badRow && validity.isDefined(i)) i += 1;
      if (i < badRow) {
        badRow = i;
        badCol = j;
      }
    }
    if (badCol > 0) {
      throw new ValidationError(
        `pushSeries: row ${badRow} col ${badCol} (${live[badCol]!.name}) is required`,
      );
    }
    return columns;
  }

  /**
   * The per-row (`Event[]`) backing's commit, shared by `pushMany` and
   * `pushSeries`: order and label checks for the whole batch first
   * ([PND-BATCHATOM]), then insert, `'event'`, retention, `'batch'`,
   * `'evict'`.
   */
  #commitPerRow(events: ReadonlyArray<EventForSchema<S>>): void {
    this.#checkOrder(events);
    this.#checkLabels(events);
    const added: EventForSchema<S>[] = [];
    const errors: unknown[] = [];

    for (const event of events) {
      if (this.#insertPerRow(event)) {
        // Increment the counter immediately after a successful
        // insert and BEFORE listener fan-out. If a listener throws
        // partway through the loop, the event is committed in the
        // buffer and reflected in `length` — `ingested` must
        // reflect that too, so callers can recover from listener
        // exceptions without observability counters lying.
        this.#statsIngested++;
        added.push(event);
        this.#dispatch(this.#onEvent, event, errors);
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

    this.#dispatch(this.#onBatch, added, errors);
    if (evicted.length > 0) {
      this.#dispatch(this.#onEvict, evicted, errors);
    }
    rethrowFirst(errors);
  }

  /**
   * [PND-LIVFIX] Run one push under the re-entrancy guard: bump
   * `#dispatchDepth` for its duration, then — from the OUTERMOST guard
   * only — drain the pushes that listeners queued, strictly FIFO. A
   * queued push runs as its own guarded push, so its listeners can queue
   * more; those land at the tail of the same queue and run after every
   * push queued before them. (Draining from every level, as the first
   * cut did, let a grandchild jump a queued sibling — a review repro:
   * listener on 1 queues 10 then 20, listener on 10 queues 30, and 30
   * ran before 20, which strict ordering then rejected.) An error from
   * the outer push is rethrown AFTER the queue has drained — queued rows
   * were accepted by `push()` and must not be lost to a listener's
   * exception elsewhere.
   */
  #guarded(run: () => void): void {
    this.#dispatchDepth += 1;
    let failure: { error: unknown } | undefined;
    try {
      run();
    } catch (error) {
      failure = { error };
    }
    this.#closeGuard(failure);
  }

  /**
   * Close a guard opened by `#guarded` or `_stageRowsOpen`: settle (from
   * the outermost guard only, while still guarded), drop the depth, then
   * drain queued pushes from depth 0. Throws `failure` (or the first
   * settle / drained-push error) at the very end.
   */
  #closeGuard(failure: { error: unknown } | undefined): void {
    // [PND-REDUCETICK] Settle once per push, after every phase, from the
    // outermost guard only and while still guarded, so a push made by a
    // settle listener is queued like any other re-entrant push.
    if (this.#dispatchDepth === 1 && this.#onSettle.size > 0) {
      const errors: unknown[] = [];
      this.#dispatch(this.#onSettle, undefined, errors);
      if (errors.length > 0) failure ??= { error: errors[0] };
    }
    this.#dispatchDepth -= 1;
    if (this.#dispatchDepth === 0 && !this.#draining) {
      this.#draining = true;
      try {
        while (this.#pendingPushes.length > 0) {
          const push = this.#pendingPushes.shift()!;
          try {
            push();
          } catch (error) {
            failure ??= { error };
          }
        }
      } finally {
        this.#draining = false;
      }
    }
    if (failure) throw failure.error;
  }

  /**
   * [PND-LIVFIX] Fan out to a listener set with error isolation. Iterates
   * a snapshot, so a listener that adds or removes listeners during
   * dispatch neither disturbs the others nor fires for the event it was
   * added during. A throwing listener is recorded and the remaining
   * listeners still run; the caller rethrows the first error once the
   * whole push (retention, `'batch'`, `'evict'`) has completed. Before
   * this, a throw skipped retention entirely and left every later
   * subscriber — a derived `filter()` view included — permanently out of
   * sync with the buffer (audit 2026-06 §4.1).
   */
  #dispatch<T>(
    set: ListenerSet<(arg: T) => void>,
    arg: T,
    errors: unknown[],
  ): void {
    if (set.size === 0) return;
    for (const fn of set.snapshot()) {
      try {
        fn(arg);
      } catch (error) {
        errors.push(error);
      }
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
    const { keys, columns } = validateAndNormalizeColumnar<S>({
      name: this.name,
      schema: this.schema,
      rows,
    });

    // INTRA-batch order is enforced by `validateAndNormalizeColumnar`
    // above (it throws a `ValidationError` naming the out-of-order row). The
    // cross-batch boundary check + commit/fan-out live in `#commitChunk`.
    const store = ColumnarStore.fromTrustedStore(this.schema, keys, columns);
    this.#commitChunk(store);
  }

  /**
   * @internal — the column-native partition-routing path, step 1 of 3.
   * `LivePartitionedSeries.#routeChunk` calls it ONCE per partition per
   * source chunk with that partition's slice of the chunk (`indices`, in
   * source order). It order-checks the slice, stages it into the chunked
   * backing's coalescing tier (gathered tuples flush as ONE packed chunk
   * at the storage threshold — the gRPC-V7 fix for thin scatter), and
   * opens this series' re-entrancy guard. Returns the slice's transient
   * events when an `'event'` / `'batch'` listener will consume them,
   * else `null` (no `Event` created — the heap/GC win).
   *
   * The router then fires `'event'` for every routed row in SOURCE order
   * across partitions (`_emitStagedEvent`), and finally closes each
   * partition (`_stageRowsClose`: retention → `'batch'` → `'evict'` →
   * settle). Splitting it this way keeps the cross-partition source-order
   * `'event'` fan-out a strict `collect()` / clock-triggered rolling
   * needs, while storage, retention, `'batch'` and settle run once per
   * partition per chunk instead of once per row ([PND-PARTBATCH]).
   *
   * The caller MUST call `_stageRowsClose` for every successful open,
   * even if an earlier step threw — else the guard stays open and pushes
   * queue forever. Trust contract: the rows are `>=` each other in the
   * order given (strict source + order-preserving scatter).
   */
  _stageRowsOpen(
    source: ColumnarStore<S>,
    indices: ArrayLike<number>,
  ): EventForSchema<S>[] | null {
    const chunked = this.#chunked;
    if (chunked === null) {
      throw new Error(
        'LiveSeries._stageRowsOpen: series is not chunked-backed (internal misuse)',
      );
    }
    const k = indices.length;
    // Cross-batch boundary: the slice's first key must be `>=` the
    // buffer's current last (which includes any pending-tier rows).
    if (k > 0 && chunked.length > 0) {
      const firstBegin = source.beginAt(indices[0]!);
      const lastBegin = chunked.beginAt(chunked.length - 1)!;
      if (firstBegin < lastBegin) {
        throw new ValidationError(
          `out-of-order event: timestamp ${firstBegin} is before latest ${lastBegin}`,
        );
      }
    }

    chunked.stageRows(source, indices);
    this.#statsIngested += k;
    const added =
      k > 0 && (this.#onEvent.size > 0 || this.#onBatch.size > 0)
        ? materializeEventsFromStoreAt(source, indices, this.schema)
        : null;
    // Open the guard last, so nothing above can throw with it open.
    this.#dispatchDepth += 1;
    return added;
  }

  /**
   * @internal — routing step 2: fire `'event'` for one staged row. Must
   * sit between `_stageRowsOpen` and `_stageRowsClose`. Listener errors
   * land in `errors` (the same array passed to `_stageRowsClose`).
   */
  _emitStagedEvent(event: EventForSchema<S>, errors: unknown[]): void {
    this.#dispatch(this.#onEvent, event, errors);
  }

  /**
   * @internal — routing step 3: retention → `'batch'` (the whole staged
   * slice) → `'evict'`, then close the guard opened by `_stageRowsOpen`
   * (settle once, drain queued pushes). Throws the first listener error.
   */
  _stageRowsClose(added: EventForSchema<S>[] | null, errors: unknown[]): void {
    let failure: { error: unknown } | undefined;
    try {
      const evicted = this.#applyRetention();
      if (added) this.#dispatch(this.#onBatch, added, errors);
      if (evicted.length > 0) this.#dispatch(this.#onEvict, evicted, errors);
      if (errors.length > 0) failure = { error: errors[0] };
    } catch (error) {
      failure = { error };
    }
    this.#closeGuard(failure);
  }

  /**
   * Append one already-built `ColumnarStore` chunk, then run the
   * `chunk → event → retention → batch → evict` fan-out. The source's
   * `pushMany` path (rows → validated store → here). The cross-batch
   * strict-order boundary check lives here. (The partition-routing path
   * uses `_stageRowsOpen`/`_stageRowsClose` instead, which coalesce and
   * have their own fan-out.)
   */
  #commitChunk(store: ColumnarStore<S>): void {
    const chunked = this.#chunked!;
    const n = store.length;

    // CROSS-batch boundary: the chunk's first key must be `>=` the
    // buffer's current last. (Intra-chunk order is guaranteed upstream.)
    // Same `ValidationError` shape as the per-row `#insertPerRow` path.
    if (n > 0 && chunked.length > 0) {
      const firstBegin = store.beginAt(0);
      const lastBegin = chunked.beginAt(chunked.length - 1)!;
      if (firstBegin < lastBegin) {
        throw new ValidationError(
          `out-of-order event: timestamp ${firstBegin} is before latest ${lastBegin}`,
        );
      }
    }

    // All-or-nothing commit: the whole chunk lands BEFORE any fan-out
    // (the documented divergence from the per-row path — see `pushMany`).
    chunked.appendStore(store);
    this.#statsIngested += n;

    // Column-native delta hook: fires with the appended store, no
    // materialization. The partition router consumes this; its presence
    // does NOT force `Event` synthesis (that's the point — column-native
    // routing never materializes the source's events).
    if (this.#onChunk.size > 0) {
      for (const fn of this.#onChunk) fn(store);
    }

    // Materialize the chunk's events as transient objects ONLY if an
    // `'event'` / `'batch'` listener will consume them — with no row
    // listeners (column-native consumers use `#onChunk`), no `Event` is
    // ever created (the heap/GC win).
    const added =
      this.#onEvent.size > 0 || this.#onBatch.size > 0
        ? materializeEventsFromStore(store, this.schema)
        : null;

    // `'event'` fan-out fires before retention (the ordering contract).
    const errors: unknown[] = [];
    if (added) {
      for (const ev of added) this.#dispatch(this.#onEvent, ev, errors);
    }

    // Retention always runs. It updates `#statsEvicted` internally and
    // returns the materialized evicted events only when an `'evict'`
    // listener exists (else `dropPrefix`, returning `[]`).
    const evicted = this.#applyRetention();

    if (added) this.#dispatch(this.#onBatch, added, errors);
    if (evicted.length > 0) this.#dispatch(this.#onEvict, evicted, errors);
    rethrowFirst(errors);
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
    if (this.#dispatchDepth > 0) {
      this.#pendingPushes.push(() => this._pushTrustedEvents(events));
      return;
    }
    this.#guarded(() => {
      if (this.#chunked) {
        const rows: RowForSchema<S>[] = new Array(events.length);
        for (let i = 0; i < events.length; i += 1) {
          rows[i] = this.#eventToRow(events[i]!);
        }
        this.#pushManyColumnar(rows);
        return;
      }

      this.#checkOrder(events);
      const added: EventForSchema<S>[] = [];
      const errors: unknown[] = [];

      for (const event of events) {
        if (this.#insertPerRow(event)) {
          // See pushMany — counter advances before listener fan-out
          // so partial-failure on any listener still leaves
          // `ingested` consistent with `length`.
          this.#statsIngested++;
          added.push(event);
          this.#dispatch(this.#onEvent, event, errors);
        } else {
          this.#statsRejected++;
        }
      }

      if (added.length === 0) return;

      const evicted = this.#applyRetention();

      this.#dispatch(this.#onBatch, added, errors);
      if (evicted.length > 0) this.#dispatch(this.#onEvict, evicted, errors);
      rethrowFirst(errors);
    });
  }

  /**
   * @internal — number of row-materialising listeners (`'event'` +
   * `'batch'`). Zero means a push on the chunked backing builds no
   * `Event` objects at all. Exposed for the [PND-LIVFIX] chained-dispose
   * pin, which asserts a disposed chain leaves nothing subscribed.
   */
  get _rowListenerCount(): number {
    return this.#onEvent.size + this.#onBatch.size;
  }

  /**
   * @internal — [PND-LIVFIX] the order this series evicts relative to
   * arrival. `'sorted'` for `ordering: 'reorder'`, whose retention drops
   * the sorted prefix (possibly a late, i.e. recent, arrival);
   * `'arrival'` otherwise. `LiveReduce` selects its windowed reducer
   * state on this.
   */
  get _evictionOrder(): 'arrival' | 'sorted' {
    return this.#ordering === 'reorder' ? 'sorted' : 'arrival';
  }

  /**
   * @internal — [PND-LIVFIX] age-based retention against an EXTERNAL
   * clock. `#applyRetention` measures `maxAge` from this buffer's own
   * newest event, which is right for a standalone series but leaves a
   * partition sub-series that has gone quiet holding its events forever:
   * nothing ever pushes into it, so its clock never advances (audit
   * 2026-06 §4.3 — a 10 s `maxAge` partition still held its event 9,999 s
   * later). `LivePartitionedSeries` calls this on every partition as the
   * source's watermark advances, so a quiet partition ages out against
   * the time the source has actually reached. Emits `'evict'` exactly as
   * push-driven retention does, so `LiveReduce` and views stay in sync.
   * No-op without `maxAge` or on an empty buffer. Called while this
   * series is mid-dispatch (a listener on it pushed re-entrantly), it is
   * queued behind that push like any other re-entrant operation, so it
   * cannot be starved.
   */
  _sweepAge(latestMs: number): void {
    if (this.#maxAgeMs === Infinity) return;
    if (this.#dispatchDepth > 0) {
      this.#pendingPushes.push(() => this._sweepAge(latestMs));
      return;
    }
    const len = this.#storage.length;
    if (len === 0) return;
    const cutoff = latestMs - this.#maxAgeMs;
    let i = 0;
    while (i < len && this.#storage.beginAt(i)! < cutoff) i += 1;
    if (i === 0) return;
    this.#statsEvicted += i;
    if (this.#onEvict.size === 0) {
      this.#storage.dropPrefix(i);
      return;
    }
    const evicted = this.#storage.evictPrefix(i);
    this.#guarded(() => {
      const errors: unknown[] = [];
      this.#dispatch(this.#onEvict, evicted, errors);
      rethrowFirst(errors);
    });
  }

  /**
   * @internal — whether this series uses the chunked columnar backing
   * (top-level `strict` time-keyed). Lets `LivePartitionedSeries` choose
   * column-native chunk routing (`_onChunk` + `_stageRowsOpen`) over the
   * per-event `Event[]` path. Not part of the public surface.
   */
  get _isChunked(): boolean {
    return this.#chunked !== null;
  }

  /**
   * @internal — committed (compacted) chunk count on the chunked backing,
   * or 0 on the array backing. Test/bench observability for the
   * coalescing win: under thin partition routing this stays bounded
   * (≈ rows / flushThreshold) rather than one chunk per source batch.
   */
  get _chunkCount(): number {
    return this.#chunked === null ? 0 : this.#chunked.committedChunkCount;
  }

  /**
   * @internal — subscribe to the column-native delta stream: `fn` fires
   * with the just-appended `ColumnarStore` on every `pushMany` (chunked
   * backing only). Returns an unsubscribe.
   * Unlike `'event'` / `'batch'`, attaching a chunk listener does NOT
   * cause the series to materialize transient `Event`s — it's the hook
   * `LivePartitionedSeries` routes through to keep partitioning
   * column-native. No-op stream on the `Event[]` backing (never fires).
   */
  _onChunk(fn: (store: ColumnarStore<S>) => void): () => void {
    this.#onChunk.add(fn);
    return () => {
      this.#onChunk.delete(fn);
    };
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
      const errors: unknown[] = [];
      this.#dispatch(this.#onEvict, evicted, errors);
      rethrowFirst(errors);
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
  toJSON(options?: {
    rowFormat?: JsonRowFormat;
  }): TimeSeriesJsonOutputArray<S> | TimeSeriesJsonOutputObject<S>;
  toJSON(
    options: { rowFormat?: JsonRowFormat } = {},
  ): TimeSeriesJsonOutputArray<S> | TimeSeriesJsonOutputObject<S> {
    return this.toTimeSeries().toJSON(options);
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

  /** Keeps events that pass `test`: a function, or an expression such as `col('value').gt(0)`. */
  filter(
    test: ((event: EventForSchema<S>) => boolean) | Expr<'boolean' | 'any'>,
  ): LiveView<S> {
    const predicate = livePredicate(test, this.schema);
    return new LiveView(this, (event: EventForSchema<S>) =>
      predicate(event) ? event : undefined,
    );
  }

  map(fn: (event: EventForSchema<S>) => EventForSchema<S>): LiveView<S> {
    return makeMapView(this, fn);
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
    assertSelectKeys('select', this.schema as SeriesSchema, keys);
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

  aggregate<const M extends ValidatedAggregateMap<S, M>>(
    sequence: Sequence,
    mapping: M,
  ): LiveAggregation<S, AggregateSchema<S, M>>;
  aggregate(sequence: Sequence, mapping: AggregateMap<S>): LiveAggregation<S> {
    return new LiveAggregation(this, sequence, mapping);
  }

  rolling<const M extends ValidatedAggregateMap<S, M>>(
    window: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveRollingAggregation<S, RollingSchema<S, M>>;
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
    mappingOrOptions?: AggregateMap<S> | LiveRollingOptions,
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
      mappingOrOptions as AggregateMap<S>,
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
  reduce<const M extends ValidatedAggregateMap<S, M>>(
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveReduce<S, RollingSchema<S, M>>;
  reduce(
    mapping: AggregateMap<S>,
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
   * [PND-BATCHATOM] Dry run of {@link #insertPerRow}'s ordering policy over
   * a whole batch: throws the error the per-row insert would throw on the
   * first row it would refuse, before any row is committed. Tracks the
   * running latest key exactly as the inserts would move it (an accepted
   * in-order row raises it; a dropped row or a sorted reorder insert
   * leaves it).
   */
  #checkOrder(events: ReadonlyArray<EventForSchema<S>>): void {
    const lastEvent = this.#perRow!.last();
    let last = lastEvent?.key();
    for (const event of events) {
      const key = event.key();
      if (last === undefined || compareKeys(last, key) <= 0) {
        last = key;
        continue;
      }
      if (this.#ordering === 'strict') {
        throw new ValidationError(
          `out-of-order event: timestamp ${event.begin()} is before latest ${last.begin()}`,
        );
      }
      if (
        this.#ordering === 'reorder' &&
        this.#graceWindowMs !== Infinity &&
        last.begin() - event.begin() > this.#graceWindowMs
      ) {
        throw new ValidationError(
          `event at ${event.begin()} is outside grace window ` +
            `(latest: ${last.begin()}, grace: ${this.#graceWindowMs}ms)`,
        );
      }
    }
  }

  /**
   * [PND-LIVELABEL] An interval-keyed series holds one label type (all
   * numbers or all text), like a batch series. Check the whole batch, and
   * against the events held, before committing any of it: a mixed batch
   * used to be stored and only fail later, in `toTimeSeries()`.
   */
  #checkLabels(events: ReadonlyArray<EventForSchema<S>>): void {
    if (this.schema[0]!.kind !== 'interval') return;
    const held = this.#perRow!.keyAt(0);
    let kind: string | undefined =
      held instanceof Interval ? typeof held.value : undefined;
    for (let i = 0; i < events.length; i++) {
      const key = events[i]!.key();
      if (!(key instanceof Interval)) continue;
      const t = typeof key.value;
      if (kind === undefined) kind = t;
      else if (t !== kind) {
        throw new ValidationError(
          `row ${i} has interval label of type ${t} but earlier rows had ${kind} labels — interval-keyed series must use one label type throughout`,
        );
      }
    }
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
