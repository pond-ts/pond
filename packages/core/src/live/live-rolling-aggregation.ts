import {
  normalizeAggregateColumns,
  type AggregateColumnSpec,
} from '../batch/aggregate-columns.js';
import { Event } from '../core/event.js';
import { Time } from '../core/time.js';
import { LiveAggregation } from './live-aggregation.js';
import {
  LiveView,
  makeDiffView,
  makeFillView,
  makeCumulativeView,
  type LiveFillMapping,
  type LiveFillStrategy,
} from './live-view.js';
import {
  rollingStateFor,
  type RollingReducerState,
} from '../reducers/index.js';
import type { Sequence } from '../sequence/sequence.js';
import {
  bucketIndexFor,
  boundaryTimestampFor,
  type Trigger,
  type ClockTrigger,
} from './triggers.js';
import type {
  AggregateMap,
  AggregateOutputMap,
  AggregateSchema,
  DiffSchema,
  EventDataForSchema,
  EventForSchema,
  LiveSource,
  NumericColumnNameForSchema,
  SelectSchema,
  SeriesSchema,
  ColumnValue,
} from '../types.js';
import type { AggregateOutputMapResultSchema } from '../types-aggregate.js';

import type { DurationInput } from '../core/duration.js';
import { parseDuration } from '../core/duration.js';
import type { RetentionPolicy } from './live-series.js';
import { applyHistoryRetention, resolveHistoryConfig } from './live-history.js';

type WindowEntry = {
  index: number;
  timestamp: number;
  values: (ColumnValue | undefined)[];
};

type UpdateListener = (value: Record<string, ColumnValue | undefined>) => void;
type EventListener = (event: any) => void;

// Compaction policy: see {@link LiveFusedRolling}'s analogous
// comment for the full rationale. Proportional guard only —
// `frontIdx > entries.length / 2`. A fixed-entry threshold reads
// like a safety bound but actually breaks O(1) amortization at
// large live-window sizes (Codex flagged this on PR #119).

export type RollingWindow = DurationInput | number;

export type LiveRollingOptions = {
  /**
   * Suppress output until the window contains at least this many
   * source events; below the threshold every reducer column emits
   * `undefined`. Defaults to `0` (no gate). For count-based windows
   * (`window: number`), `minSamples > window` means the gate never
   * opens — output is `undefined` forever.
   */
  minSamples?: number;

  /**
   * Emission cadence. Defaults to `Trigger.event()` — emits one
   * snapshot per source event push (the historical behavior).
   *
   * Pass `Trigger.every('30s')` (or the equivalent
   * `Trigger.clock(Sequence.every('30s'))`) to switch to
   * sequence-triggered emission: one snapshot fires when a source
   * event crosses an epoch-aligned boundary of the sequence; output
   * timestamps are the boundary instants. If no events arrive during
   * an interval, no event is emitted (data-driven, not wall-clock-
   * driven).
   *
   * Pass `Trigger.count(n)` to emit one snapshot every `n` source
   * events, useful when event-time boundaries lag during burst load
   * but per-event emission is too noisy. Counter resets on each fire,
   * so this measures "events since the last emission."
   *
   * For partitioned rollings (`live.partitionBy(col).rolling(...)`),
   * a clock trigger emits **synchronised across partitions**: when
   * any partition's event crosses the boundary, every partition's
   * rolling-window snapshot fires at the same instant. See
   * {@link Trigger} for the full trigger taxonomy.
   *
   * @experimental Trigger types beyond `event`, `clock`, and `count`
   *   are reserved for future expansion (`idle`, `any`, custom
   *   triggers). See the trigger taxonomy RFC sketch in PLAN.md.
   */
  trigger?: Trigger;

  /**
   * Output retention — controls how much of the rolling's emitted
   * history the accumulator keeps in its own buffer (the one read by
   * `length` / `at(i)` / iteration).
   *
   * - `true` (default): keep every emitted event for the lifetime of
   *   the accumulator. `length` grows by one per trigger fire. This
   *   is the historical behaviour preserved for backward compat.
   * - `false`: don't push to the output buffer at all. `'event'`
   *   listeners still fire and `value()` still snapshots reducer
   *   state, but `length` stays at `0` and `at(i)` always returns
   *   `undefined`. Use this for high-rate live-display pipelines
   *   that consume the rolling via subscription only — the
   *   per-emit allocation cost goes away.
   * - `RetentionPolicy` (`{ maxEvents?, maxAge? }`): cap the output
   *   buffer at `maxEvents` entries (newest kept) or `maxAge` ms
   *   relative to the latest emit. Field shape mirrors
   *   {@link LiveSeriesOptions.retention}; combine both for a
   *   "last N _and_ no older than M" cap. **Stricter than
   *   LiveSeries:** `history.maxEvents` rejects 0, negative, or
   *   non-integer values at construction (LiveSeries currently
   *   accepts them silently and produces surprising eviction
   *   patterns). Pass `Infinity` or omit the field for no cap.
   *
   * Note: `history: false` is the strictest opt-out — once chosen,
   * the accumulator never retains emits and they cannot be
   * recovered. To consume them, attach an `'event'` listener
   * before the first push.
   */
  history?: boolean | RetentionPolicy;
};

export class LiveRollingAggregation<
  S extends SeriesSchema,
  Out extends SeriesSchema = SeriesSchema,
> {
  readonly name: string;
  readonly schema: Out;

  readonly #columns: AggregateColumnSpec[];
  readonly #states: RollingReducerState[];
  /**
   * Sliding-window deque. Eviction uses a head-index pointer
   * (`#frontIdx`) instead of `Array.shift()` — at high event rates
   * (10k+/s) the deque holds thousands of entries and `shift()` is
   * worst-case O(N), giving a quadratic per-second cost. Pointer-
   * based eviction is O(1) per ingest; periodic batched compaction
   * (`splice(0, frontIdx)`) keeps the underlying array bounded.
   *
   * Live front is `entries[frontIdx]`; live count is
   * `entries.length - frontIdx`. Once any compaction has run,
   * never read `entries[0]` directly — the entries before
   * `frontIdx` are logically evicted.
   */
  readonly #entries: WindowEntry[];
  #frontIdx: number;

  readonly #windowMs: number | undefined;
  readonly #windowCount: number | undefined;
  readonly #minSamples: number;
  #nextIndex: number;

  /**
   * The configured trigger. Stored as a strict union; emission paths
   * dispatch on `kind`.
   */
  readonly #trigger: Trigger;
  /**
   * For clock triggers: the bucket index of the most recently
   * crossed boundary. Undefined until the first event is ingested
   * (the first event establishes the starting bucket; emission begins
   * on the next crossing).
   */
  #lastClockBucketIdx: number | undefined;

  /**
   * For count triggers: the number of events ingested since the most
   * recent emission (or since construction, before the first
   * emission). The trigger fires when this reaches `n`, then resets
   * to zero. Resetting (rather than counting modulo) means a count(N)
   * trigger inside a future `Trigger.any(...)` always measures
   * "events since the last fire."
   */
  #countSinceLastEmit: number;

  readonly #outputEvents: any[];
  readonly #onUpdate: Set<UpdateListener>;
  readonly #onEvent: Set<EventListener>;
  readonly #unsubscribe: () => void;

  // Pipeline counters for {@link LiveRollingAggregation.stats}.
  // Cumulative since construction; never reset.
  #statsEventsObserved = 0;
  #statsEvictions = 0;
  #statsEmissions = 0;

  /**
   * Output retention configuration. See {@link LiveRollingOptions.history}.
   * `#historyEnabled` short-circuits the `#outputEvents.push` in
   * `#emitEvent` when the user opts out entirely; the limits are
   * applied via {@link #applyHistoryRetention} after each push.
   */
  readonly #historyEnabled: boolean;
  readonly #historyMaxEvents: number;
  readonly #historyMaxAgeMs: number;

  constructor(
    source: LiveSource<S>,
    window: RollingWindow,
    mapping: AggregateMap<S> | AggregateOutputMap<S>,
    options: LiveRollingOptions = {},
  ) {
    this.name = source.name;
    const minSamples = options.minSamples ?? 0;
    if (!Number.isInteger(minSamples) || minSamples < 0) {
      throw new TypeError(
        'rolling minSamples must be a non-negative integer (default 0)',
      );
    }
    this.#minSamples = minSamples;
    this.#trigger = options.trigger ?? { kind: 'event' };
    this.#lastClockBucketIdx = undefined;
    this.#countSinceLastEmit = 0;

    // Shared resolution + retention logic — same shape across all
    // four live rolling primitives (single-window, fused, partitioned
    // sync, partitioned fused).
    const histCfg = resolveHistoryConfig(options.history);
    this.#historyEnabled = histCfg.enabled;
    this.#historyMaxEvents = histCfg.maxEvents;
    this.#historyMaxAgeMs = histCfg.maxAgeMs;

    if (typeof window === 'number' && Number.isInteger(window) && window > 0) {
      this.#windowMs = undefined;
      this.#windowCount = window;
    } else {
      this.#windowMs =
        typeof window === 'string' ? parseDuration(window) : undefined;
      if (this.#windowMs === undefined && typeof window === 'number') {
        throw new TypeError(
          'window must be a positive integer (event count) or duration string',
        );
      }
      this.#windowCount = undefined;
    }

    // Normalise the mapping into the unified column-spec shape used
    // by both batch (`TimeSeries.rolling/aggregate`) and live
    // (`LiveRollingAggregation`, `LiveAggregation`,
    // `LivePartitionedSyncRolling`) paths. Accepts either
    // `AggregateMap<S>` (one reducer per existing source column) or
    // `AggregateOutputMap<S>` (named alias outputs, multiple
    // reducers per source column).
    this.#columns = normalizeAggregateColumns(
      source.schema,
      mapping as AggregateMap<S> | AggregateOutputMap<S>,
    );

    this.schema = Object.freeze([
      source.schema[0],
      ...this.#columns.map((c) => ({
        // Output column NAME is `c.output` — same as `c.source` for
        // AggregateMap mappings, can differ for AggregateOutputMap.
        name: c.output,
        kind: c.kind,
        required: false,
      })),
    ]) as unknown as Out;

    // Build per-column rolling state. Built-in reducers use their
    // dedicated O(1) `add`/`remove`/`snapshot` machinery; custom
    // functions use a generic adapter that re-runs the function over
    // the current window at each `snapshot()` (O(N) per snapshot —
    // see {@link rollingStateFor} for the perf characteristic).
    this.#states = this.#columns.map((c) => rollingStateFor(c.reducer));
    this.#entries = [];
    this.#frontIdx = 0;
    this.#nextIndex = 0;
    this.#outputEvents = [];
    this.#onUpdate = new Set();
    this.#onEvent = new Set();

    for (let i = 0; i < source.length; i++) {
      this.#ingest(source.at(i)!);
    }

    this.#unsubscribe = source.on('event', (event) => {
      this.#ingest(event);
      const val = this.value();
      for (const fn of this.#onUpdate) fn(val);
    });
  }

  get length(): number {
    return this.#outputEvents.length;
  }

  at(index: number): EventForSchema<Out> | undefined {
    if (index < 0) index = this.#outputEvents.length + index;
    return this.#outputEvents[index];
  }

  value(): Record<string, ColumnValue | undefined> {
    const result: Record<string, ColumnValue | undefined> = {};
    const warmup = this.#liveLength() < this.#minSamples;
    for (let i = 0; i < this.#columns.length; i++) {
      // Output keyed by `output` name (= source name for AggregateMap;
      // user-chosen alias for AggregateOutputMap).
      result[this.#columns[i]!.output] = warmup
        ? undefined
        : this.#states[i]!.snapshot();
    }
    return result;
  }

  get windowSize(): number {
    return this.#liveLength();
  }

  on(type: 'event', fn: EventListener): () => void;
  on(type: 'update', fn: UpdateListener): this;
  on(
    type: 'event' | 'update',
    fn: EventListener | UpdateListener,
  ): this | (() => void) {
    if (type === 'event') {
      this.#onEvent.add(fn as EventListener);
      return () => {
        this.#onEvent.delete(fn as EventListener);
      };
    }
    this.#onUpdate.add(fn as UpdateListener);
    return this;
  }

  // ── View transforms ─────────────────────────────────────────

  filter(predicate: (event: EventForSchema<Out>) => boolean): LiveView<Out> {
    return new LiveView(this as any, (event: any) =>
      predicate(event) ? event : undefined,
    );
  }

  map(fn: (event: EventForSchema<Out>) => EventForSchema<Out>): LiveView<Out> {
    return new LiveView(this as any, fn as any);
  }

  select<const Keys extends readonly (keyof EventDataForSchema<Out>)[]>(
    ...keys: Keys
  ): LiveView<SelectSchema<Out, Keys[number] & string>> {
    const newSchema = Object.freeze([
      this.schema[0]!,
      ...this.schema.slice(1).filter((c) => keys.includes(c.name as any)),
    ]) as unknown as SelectSchema<Out, Keys[number] & string>;

    return new LiveView(this as any, (event: any) => event.select(...keys), {
      schema: newSchema as any,
    }) as any;
  }

  window(size: RollingWindow): LiveView<Out> {
    return new LiveView(this as any, (event: any) => event).window(size) as any;
  }

  diff<const Target extends NumericColumnNameForSchema<Out>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LiveView<DiffSchema<Out, Target>> {
    return makeDiffView(this as any, 'diff', columns, options);
  }

  rate<const Target extends NumericColumnNameForSchema<Out>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LiveView<DiffSchema<Out, Target>> {
    return makeDiffView(this as any, 'rate', columns, options);
  }

  pctChange<const Target extends NumericColumnNameForSchema<Out>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LiveView<DiffSchema<Out, Target>> {
    return makeDiffView(this as any, 'pctChange', columns, options);
  }

  fill(
    strategy: LiveFillStrategy | LiveFillMapping<Out>,
    options?: { limit?: number },
  ): LiveView<Out> {
    return makeFillView(this as any, strategy, options);
  }

  cumulative<const Targets extends NumericColumnNameForSchema<Out>>(spec: {
    [K in Targets]:
      | 'sum'
      | 'max'
      | 'min'
      | 'count'
      | ((acc: number, value: number) => number);
  }): LiveView<DiffSchema<Out, Targets>> {
    return makeCumulativeView(this as any, spec);
  }

  aggregate<const M extends AggregateMap<Out>>(
    sequence: Sequence,
    mapping: M,
  ): LiveAggregation<Out, AggregateSchema<Out, M>>;
  aggregate<const M extends AggregateOutputMap<Out>>(
    sequence: Sequence,
    mapping: M,
  ): LiveAggregation<Out, AggregateOutputMapResultSchema<Out, M>>;
  aggregate(
    sequence: Sequence,
    mapping: AggregateMap<Out> | AggregateOutputMap<Out>,
  ): LiveAggregation<Out> {
    return new LiveAggregation(this as any, sequence, mapping as any);
  }

  /**
   * Pipeline stats snapshot — cumulative counters since
   * construction plus current window state. Cheap O(1).
   *
   * - `eventsObserved`: total source events ingested. Includes
   *   events replayed at construction from a non-empty source.
   *   Never decreases.
   * - `evictions`: total entries removed from the window by
   *   retention. Never decreases.
   * - `emissions`: total output events fired. Never decreases.
   *   Always `<= eventsObserved`; for `Trigger.event` it equals
   *   `eventsObserved`, for `Trigger.count(n)` and `Trigger.clock`
   *   it can be smaller.
   * - `windowSize`: current live window size (= `this.windowSize`).
   *
   * Use case: long-running pipelines that want headline counters
   * without wiring `rolling.on('event', ...)` listeners by hand.
   */
  stats(): {
    eventsObserved: number;
    evictions: number;
    emissions: number;
    windowSize: number;
  } {
    return {
      eventsObserved: this.#statsEventsObserved,
      evictions: this.#statsEvictions,
      emissions: this.#statsEmissions,
      windowSize: this.#liveLength(),
    };
  }

  dispose(): void {
    this.#unsubscribe();
  }

  // ── Private ─────────────────────────────────────────────────

  #ingest(event: EventForSchema<S>): void {
    this.#statsEventsObserved++;
    const data = event.data() as Record<string, ColumnValue | undefined>;
    const values = this.#columns.map((c) => data[c.source]);
    const index = this.#nextIndex++;
    const entry: WindowEntry = {
      index,
      timestamp: event.begin(),
      values,
    };

    for (let i = 0; i < this.#columns.length; i++) {
      this.#states[i]!.add(index, values[i]);
    }
    this.#entries.push(entry);

    this.#evict(event.begin());

    // Emission is gated by the configured trigger.
    switch (this.#trigger.kind) {
      case 'event':
        this.#emitEvent(event.key());
        return;
      case 'clock':
        this.#emitClock(event.begin(), this.#trigger);
        return;
      case 'count':
        this.#emitCount(event.key(), this.#trigger.n);
        return;
    }
  }

  /**
   * Count-triggered emission: fire one output event keyed at the
   * source event's key when the per-event counter reaches `n`, then
   * reset the counter. The first emission fires on the `n`th source
   * event, not the first.
   */
  #emitCount(key: any, n: number): void {
    this.#countSinceLastEmit++;
    if (this.#countSinceLastEmit < n) return;
    this.#countSinceLastEmit = 0;
    this.#emitEvent(key);
  }

  /**
   * Emit one output event keyed at `key`, carrying the current
   * rolling-window snapshot. Used by Trigger.event() (the default).
   */
  #emitEvent(key: any): void {
    const warmup = this.#liveLength() < this.#minSamples;
    const record: Record<string, ColumnValue | undefined> = {};
    for (let i = 0; i < this.#columns.length; i++) {
      record[this.#columns[i]!.output] = warmup
        ? undefined
        : this.#states[i]!.snapshot();
    }
    const outputEvent = new Event(key, record);
    this.#statsEmissions++;
    if (this.#historyEnabled) {
      this.#outputEvents.push(outputEvent);
      applyHistoryRetention(
        this.#outputEvents,
        this.#historyMaxEvents,
        this.#historyMaxAgeMs,
      );
    }
    for (const fn of this.#onEvent) fn(outputEvent);
  }

  /**
   * Clock-triggered emission: fire one output event at the new
   * bucket's start timestamp when an incoming event crosses an
   * epoch-aligned boundary. The first event ingested establishes
   * the starting bucket; emission begins on the next crossing.
   * A single event jumping multiple boundaries fires exactly one
   * event at the new bucket's start, not one per skipped boundary.
   */
  #emitClock(eventTs: number, trigger: ClockTrigger): void {
    const bucketIdx = bucketIndexFor(trigger, eventTs);

    if (this.#lastClockBucketIdx === undefined) {
      // First event — record the starting bucket; no emission yet.
      this.#lastClockBucketIdx = bucketIdx;
      return;
    }

    if (bucketIdx > this.#lastClockBucketIdx) {
      const boundaryMs = boundaryTimestampFor(trigger, bucketIdx);
      this.#emitEvent(new Time(boundaryMs));
      this.#lastClockBucketIdx = bucketIdx;
    }
  }

  /**
   * Number of live entries in the deque (`entries.length - frontIdx`).
   * Used by warmup checks and the public `windowSize` getter.
   */
  #liveLength(): number {
    return this.#entries.length - this.#frontIdx;
  }

  /**
   * Evict entries from the front of the deque whose timestamp is
   * older than the cutoff (time-based) or whose count exceeds the
   * configured window (count-based). Uses the head-index pointer
   * for O(1) per-event eviction; periodic batched compaction keeps
   * the underlying array bounded.
   *
   * Pre-v0.15.2 used `Array.shift()` which was worst-case O(N) on
   * the array length. At firehose rates (10k+/s, multi-second
   * windows) the deque holds tens of thousands of entries — the
   * `shift()` cost was quadratic per second and dominated the
   * pipeline. See PLAN.md "Live rolling tactical fixes" for the
   * full backstory; gRPC experiment PR #26 exposed the cliff.
   */
  #evict(latestTimestamp: number): void {
    if (this.#windowMs !== undefined) {
      const cutoff = latestTimestamp - this.#windowMs;
      while (
        this.#frontIdx < this.#entries.length &&
        this.#entries[this.#frontIdx]!.timestamp < cutoff
      ) {
        this.#removeFirst();
      }
    }

    if (this.#windowCount !== undefined) {
      while (this.#liveLength() > this.#windowCount) {
        this.#removeFirst();
      }
    }

    // Periodic batched compaction — see {@link LiveFusedRolling}'s
    // analogous comment for the rationale.
    if (this.#frontIdx > this.#entries.length / 2) {
      this.#entries.splice(0, this.#frontIdx);
      this.#frontIdx = 0;
    }
  }

  /**
   * Logically evict the front entry by advancing `#frontIdx`. The
   * actual array entry stays in place until periodic compaction
   * splices off the dead prefix. Per-call cost is O(1).
   */
  #removeFirst(): void {
    const entry = this.#entries[this.#frontIdx]!;
    this.#frontIdx++;
    this.#statsEvictions++;
    for (let i = 0; i < this.#columns.length; i++) {
      this.#states[i]!.remove(entry.index, entry.values[i]);
    }
  }
}
