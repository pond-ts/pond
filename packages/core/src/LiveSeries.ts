import { Event } from './Event.js';
import { Interval } from './Interval.js';
import { LiveAggregation } from './LiveAggregation.js';
import {
  LivePartitionedSeries,
  type LivePartitionedOptions,
} from './LivePartitionedSeries.js';
import {
  LiveView,
  makeDiffView,
  makeFillView,
  makeCumulativeView,
  type LiveFillMapping,
  type LiveFillStrategy,
} from './LiveView.js';
import { Time } from './Time.js';
import { TimeRange } from './TimeRange.js';
import {
  LiveRollingAggregation,
  type LiveRollingOptions,
  type RollingWindow,
} from './LiveRollingAggregation.js';
import { TimeSeries } from './TimeSeries.js';
import { ValidationError } from './errors.js';
import { parseJsonRows } from './json.js';
import type { TimeZoneOptions } from './calendar.js';
import type { EventKey, IntervalInput, TimeRangeInput } from './temporal.js';
import type { Sequence } from './Sequence.js';
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
} from './types.js';
import type {
  AggregateOutputMapResultSchema,
  RollingOutputMapSchema,
} from './types-aggregate.js';
import { LiveFusedRolling } from './LiveFusedRolling.js';
import { LiveReduce } from './LiveReduce.js';
import type {
  FusedMapping,
  FusedMappingValid,
  FusedRollingSchema,
} from './types-fused-rolling.js';

import type { DurationInput } from './utils/duration.js';
import { parseDuration } from './utils/duration.js';

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

function compareKeys(a: EventKey, b: EventKey): number {
  return a.begin() !== b.begin() ? a.begin() - b.begin() : a.end() - b.end();
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

  #events: EventForSchema<S>[];

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

    this.#events = [];
    this.#onEvent = new Set();
    this.#onBatch = new Set();
    this.#onEvict = new Set();

    validateSchema(this.schema);
  }

  get length(): number {
    return this.#events.length;
  }

  get graceWindowMs(): number {
    return this.#graceWindowMs;
  }

  at(index: number): EventForSchema<S> | undefined {
    if (index < 0) index = this.#events.length + index;
    return this.#events[index];
  }

  first(): EventForSchema<S> | undefined {
    return this.#events[0];
  }

  last(): EventForSchema<S> | undefined {
    return this.#events[this.#events.length - 1];
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

    const added: EventForSchema<S>[] = [];

    for (const row of rows) {
      const event = this.#validateRow(row);
      if (this.#insert(event)) {
        // Increment the counter immediately after a successful
        // insert and BEFORE listener fan-out. If a listener throws
        // partway through the loop, the event is committed in
        // `#events` and reflected in `length` — `ingested` must
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

    const evicted = this.#applyRetention();
    if (evicted.length > 0) this.#statsEvicted += evicted.length;

    for (const fn of this.#onBatch) fn(added);
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

    const added: EventForSchema<S>[] = [];

    for (const event of events) {
      if (this.#insert(event)) {
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
    if (evicted.length > 0) this.#statsEvicted += evicted.length;

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
    const evicted = this.#events;
    this.#events = [];
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
    const rows = this.#events.map((event) => {
      const row: unknown[] = [event.key()];
      for (let col = 1; col < this.schema.length; col++) {
        row.push(event.get((this.schema[col] as any).name));
      }
      return row;
    });
    return new TimeSeries({
      name: name ?? this.name,
      schema: this.schema,
      rows: rows as RowForSchema<S>[],
    });
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
    if (this.#events.length < 2) return 0;
    return (
      this.#events[this.#events.length - 1]!.begin() - this.#events[0]!.begin()
    );
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
    return (this.#events.length / span) * 1000;
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
    const length = this.#events.length;
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
      result.earliestTs = this.#events[0]!.begin();
      result.latestTs = this.#events[length - 1]!.begin();
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
    return new LivePartitionedSeries<S, K, ByCol>(this, by, options);
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

  #insert(event: EventForSchema<S>): boolean {
    const last = this.#events[this.#events.length - 1];

    if (!last || compareKeys(last.key(), event.key()) <= 0) {
      this.#events.push(event);
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
        let lo = 0;
        let hi = this.#events.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compareKeys(this.#events[mid]!.key(), event.key()) <= 0) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        this.#events.splice(lo, 0, event);
        return true;
      }
    }
  }

  #applyRetention(): EventForSchema<S>[] {
    let evictCount = 0;

    if (this.#events.length > this.#maxEvents) {
      evictCount = this.#events.length - this.#maxEvents;
    }

    if (this.#maxAgeMs !== Infinity && this.#events.length > 0) {
      const latest = this.#events[this.#events.length - 1]!;
      const cutoff = latest.begin() - this.#maxAgeMs;
      let i = evictCount;
      while (i < this.#events.length && this.#events[i]!.begin() < cutoff) {
        i++;
      }
      evictCount = Math.max(evictCount, i);
    }

    if (evictCount === 0) return [];

    return this.#events.splice(0, evictCount);
  }
}
