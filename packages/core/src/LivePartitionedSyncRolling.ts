import {
  normalizeAggregateColumns,
  type AggregateColumnSpec,
} from './aggregate-columns.js';
import { Event } from './Event.js';
import { Time } from './Time.js';
import { rollingStateFor, type RollingReducerState } from './reducers/index.js';
import {
  bucketIndexFor,
  boundaryTimestampFor,
  type ClockTrigger,
} from './triggers.js';
import type { RollingWindow } from './LiveRollingAggregation.js';
import { parseDuration } from './utils/duration.js';
import type {
  AggregateMap,
  AggregateOutputMap,
  ColumnValue,
  EventForSchema,
  LiveSource,
  SeriesSchema,
} from './types.js';

type WindowEntry = {
  index: number;
  timestamp: number;
  values: (ColumnValue | undefined)[];
};

type PartitionState = {
  states: RollingReducerState[];
  /**
   * Sliding-window deque. Live front is `entries[frontIdx]`; live
   * count is `entries.length - frontIdx`. See
   * {@link LiveRollingAggregation}'s analogous `#entries` doc for
   * the head-index-pointer rationale.
   */
  entries: WindowEntry[];
  frontIdx: number;
  nextIndex: number;
};

type EventListener = (event: any) => void;

// Compaction policy: see {@link LiveFusedRolling}'s analogous
// comment. Proportional guard only — `frontIdx > entries.length / 2`.

/**
 * A `LiveSource<Out>` produced by `LivePartitionedSeries.rolling(window, mapping, { trigger: Trigger.clock(...) })`.
 * Maintains a rolling-window aggregation per partition and emits a
 * **synchronised burst of events on every clock-trigger boundary
 * crossing**: when any partition's event crosses the boundary, every
 * known partition's rolling-window snapshot fires at the same instant.
 *
 * Output schema is `[time, <partitionColumn>, ...mappingColumns]` —
 * the partition column is added automatically so each emitted row
 * carries the partition tag for downstream consumers to rebucket on.
 *
 * **Internal** — no public class name. The public API surface is
 * `LiveSource<Out>`. Constructed via `LivePartitionedSeries.rolling`'s
 * trigger-bearing overload; user code never imports this class.
 */
export class LivePartitionedSyncRolling<
  S extends SeriesSchema,
  K extends string,
  Out extends SeriesSchema,
> implements LiveSource<Out> {
  readonly name: string;
  readonly schema: Out;

  readonly #byColumn: string;
  readonly #columns: AggregateColumnSpec[];
  readonly #trigger: ClockTrigger;
  readonly #windowMs: number | undefined;
  readonly #windowCount: number | undefined;
  readonly #minSamples: number;

  readonly #partitionStates: Map<K, PartitionState>;
  /**
   * Partition keys in observation order — used as the stable iteration
   * order when emitting per-tick frames. If `groups` was provided
   * upstream, those keys are pre-seeded in declared order so emission
   * is deterministic across runs even before any events arrive.
   */
  readonly #partitionOrder: K[];
  #lastBucketIdx: number | undefined;

  readonly #outputEvents: EventForSchema<Out>[];
  readonly #onEvent: Set<EventListener>;
  /**
   * Disposer functions for upstream subscriptions (one per partition
   * `'event'` listener registered by the wiring in
   * `LivePartitionedSeries.rolling`). `dispose()` runs and clears them.
   */
  readonly #unsubscribes: Set<() => void>;
  #disposed: boolean;

  // Pipeline counters for {@link LivePartitionedSyncRolling.stats}.
  // Cumulative since construction; never reset.
  #statsEventsObserved = 0;
  #statsEmissions = 0;

  /**
   * Internal — constructed by `LivePartitionedSeries.rolling` (root case)
   * or `LivePartitionedView.rolling` (chained case) when a clock trigger
   * is supplied.
   *
   * The constructor takes the schemas separately so the two call sites
   * can share this implementation:
   *
   * - `byColumnKind` is the partition column's kind, looked up by the
   *   caller from the **original source schema**. The chain output may
   *   not include the partition column (e.g., after `.select(...)`),
   *   but the sync source's emitted rows still carry the partition tag
   *   set directly from the routing key — no schema lookup needed at
   *   emit time.
   * - `reducerInputSchema` is the schema the rolling reducers operate
   *   on. For the root case it is the source schema `S`; for the
   *   chained case it is the chain output schema `R`. Mapping column
   *   names are resolved against this schema, and reducer output kinds
   *   inherit from its column kinds.
   */
  constructor(
    upstreamName: string,
    byColumn: string,
    byColumnKind: string,
    reducerInputSchema: SeriesSchema,
    window: RollingWindow,
    mapping: AggregateMap<SeriesSchema> | AggregateOutputMap<SeriesSchema>,
    trigger: ClockTrigger,
    options: { minSamples?: number; declaredGroups?: ReadonlyArray<K> } = {},
  ) {
    this.name = upstreamName;
    this.#byColumn = byColumn;
    this.#trigger = trigger;
    this.#minSamples = options.minSamples ?? 0;
    if (!Number.isInteger(this.#minSamples) || this.#minSamples < 0) {
      throw new TypeError(
        'rolling minSamples must be a non-negative integer (default 0)',
      );
    }

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

    // Resolve the rolling output columns from `mapping` against the
    // reducer-input schema (source schema in the root case, chain
    // output schema in the chained case). Accepts either
    // `AggregateMap` or `AggregateOutputMap` shapes via the shared
    // helper.
    this.#columns = normalizeAggregateColumns(reducerInputSchema, mapping);

    // Reject column-name collisions between the partition column and
    // any reducer-OUTPUT column. The emit loop's record would
    // overwrite the partition tag with the reducer output (or vice
    // versa) silently — both share a name in the output schema, but
    // `record[name]` only holds one value. With AggregateOutputMap,
    // the alias is the user's choice — they can resolve a collision
    // by renaming.
    if (this.#columns.some((c) => c.output === byColumn)) {
      throw new TypeError(
        `LivePartitionedSyncRolling: partition column '${byColumn}' collides ` +
          `with a reducer-output column of the same name. Rename the alias ` +
          `(e.g. \`{ ${byColumn}_avg: { from: '${byColumn}', using: 'avg' } }\`) ` +
          `or partition by a different column.`,
      );
    }
    // Also reject collision with 'time' — though unlikely (partition
    // columns can't be the first column of the schema), defend against
    // future schema shapes that might break this assumption.
    if (byColumn === 'time') {
      throw new TypeError(
        "LivePartitionedSyncRolling: partition column cannot be named 'time' " +
          '(reserved for the time-keyed first column of the output schema).',
      );
    }

    // Output schema: [time, <byColumn>, ...mappingColumns].
    // The byColumn's kind comes from the caller (looked up against the
    // original source schema), not the reducer-input schema — the
    // partition column may have been dropped by chained sugar.
    this.schema = Object.freeze([
      { name: 'time', kind: 'time' },
      { name: byColumn, kind: byColumnKind, required: false },
      ...this.#columns.map((c) => ({
        // Output column NAME is `c.output` — same as `c.source` for
        // AggregateMap mappings, the user's alias for AggregateOutputMap.
        name: c.output,
        kind: c.kind,
        required: false,
      })),
    ]) as unknown as Out;

    this.#partitionStates = new Map();
    this.#partitionOrder = [];
    this.#lastBucketIdx = undefined;
    this.#outputEvents = [];
    this.#onEvent = new Set();
    this.#unsubscribes = new Set();
    this.#disposed = false;

    if (options.declaredGroups) {
      for (const k of options.declaredGroups) {
        this.#ensurePartition(k);
      }
    }
  }

  // ── LiveSource<Out> contract ────────────────────────────────

  get length(): number {
    return this.#outputEvents.length;
  }

  at(index: number): EventForSchema<Out> | undefined {
    if (index < 0) index = this.#outputEvents.length + index;
    return this.#outputEvents[index];
  }

  on(type: 'event', fn: EventListener): () => void {
    if (type !== 'event') {
      throw new TypeError(
        `LivePartitionedSyncRolling.on: unsupported event type '${String(type)}'`,
      );
    }
    this.#onEvent.add(fn);
    return () => {
      this.#onEvent.delete(fn);
    };
  }

  /**
   * Detach this sync source from every upstream partition it has
   * subscribed to. Idempotent — calling twice is a no-op. After
   * dispose, subsequent source events do not update internal state
   * and no further events are emitted.
   *
   * The sync source's lifetime is independent of the
   * `LivePartitionedSeries` that produced it: disposing the sync
   * does not detach the partitioned series's other consumers, and
   * disposing the partitioned series detaches this sync via the
   * parent-disposer wiring in `LivePartitionedSeries.rolling`.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsub of this.#unsubscribes) {
      unsub();
    }
    this.#unsubscribes.clear();
  }

  /**
   * @internal — used by `LivePartitionedSeries.rolling` to register
   * each per-partition `'event'` listener disposer so this sync
   * source can detach them on `dispose()`.
   */
  _registerUnsubscribe(unsub: () => void): void {
    this.#unsubscribes.add(unsub);
  }

  // ── Wiring entry point ──────────────────────────────────────

  /**
   * Called by `LivePartitionedSeries` for each event arriving on a
   * partition's `LiveSource`. Updates that partition's rolling window
   * state and, if the bucket index advances, emits a synchronised
   * burst of one event per known partition at the new boundary
   * timestamp.
   */
  ingest(partitionKey: K, event: EventForSchema<S>): void {
    if (this.#disposed) return;
    this.#statsEventsObserved++;
    const state = this.#ensurePartition(partitionKey);
    const data = event.data() as Record<string, ColumnValue | undefined>;
    const values = this.#columns.map((c) => data[c.source]);
    const index = state.nextIndex++;
    const ts = event.begin();
    const entry: WindowEntry = { index, timestamp: ts, values };

    for (let i = 0; i < this.#columns.length; i++) {
      state.states[i]!.add(index, values[i]);
    }
    state.entries.push(entry);
    this.#evictPartition(state, ts);

    const bucketIdx = bucketIndexFor(this.#trigger, ts);
    if (this.#lastBucketIdx === undefined) {
      // First event — establish the starting bucket; no emission yet.
      this.#lastBucketIdx = bucketIdx;
      return;
    }
    if (bucketIdx > this.#lastBucketIdx) {
      // Pass `ts` (the triggering event's timestamp) into emitTick so
      // every partition's window is evicted against "now" before we
      // snapshot. Without this, a quiet partition's stale entries from
      // before the window cutoff would still appear in the emitted
      // aggregate — corrupting synchronized rollups for sparse
      // partitions.
      this.#emitTick(bucketIdx, ts);
      this.#lastBucketIdx = bucketIdx;
    }
  }

  // ── Internal ────────────────────────────────────────────────

  #ensurePartition(key: K): PartitionState {
    let state = this.#partitionStates.get(key);
    if (state) return state;
    // Built-ins use their dedicated O(1) machinery; custom functions
    // use a generic adapter that re-runs the function over the current
    // window at each `snapshot()` (O(N) per snapshot — see
    // `rollingStateFor` for the perf characteristic).
    state = {
      states: this.#columns.map((c) => rollingStateFor(c.reducer)),
      entries: [],
      frontIdx: 0,
      nextIndex: 0,
    };
    this.#partitionStates.set(key, state);
    this.#partitionOrder.push(key);
    return state;
  }

  /**
   * Evict the front of this partition's deque against the time-
   * cutoff and/or count-cap. Uses a head-index pointer (`frontIdx`)
   * for O(1) per-event eviction; periodic batched compaction
   * (`splice(0, frontIdx)`) keeps the array bounded. See
   * {@link LiveRollingAggregation}'s analogous `#evict` for the
   * rationale.
   */
  #evictPartition(state: PartitionState, latestTs: number): void {
    if (this.#windowMs !== undefined) {
      const cutoff = latestTs - this.#windowMs;
      while (
        state.frontIdx < state.entries.length &&
        state.entries[state.frontIdx]!.timestamp < cutoff
      ) {
        const entry = state.entries[state.frontIdx]!;
        state.frontIdx++;
        for (let i = 0; i < this.#columns.length; i++) {
          state.states[i]!.remove(entry.index, entry.values[i]);
        }
      }
    }
    if (this.#windowCount !== undefined) {
      while (state.entries.length - state.frontIdx > this.#windowCount) {
        const entry = state.entries[state.frontIdx]!;
        state.frontIdx++;
        for (let i = 0; i < this.#columns.length; i++) {
          state.states[i]!.remove(entry.index, entry.values[i]);
        }
      }
    }
    // Periodic batched compaction.
    if (state.frontIdx > state.entries.length / 2) {
      state.entries.splice(0, state.frontIdx);
      state.frontIdx = 0;
    }
  }

  /**
   * Walk every known partition (in observation / declared-groups
   * order), evict each partition's rolling-window state against the
   * triggering event's timestamp `latestTs`, then emit one row per
   * partition keyed at the new bucket's boundary timestamp. All
   * emitted events share the same boundary `ts`.
   *
   * **Why eviction here?** The partition that received the
   * boundary-crossing event was already evicted in `ingest()`, but
   * other (quiet) partitions haven't been touched since their last
   * event. If a partition's last event landed before the window
   * cutoff (`latestTs - windowMs`), its entries are stale from the
   * data clock's perspective — they shouldn't contribute to a
   * snapshot taken at "now." Without this pass, a 30 s window can
   * still emit a 90-second-old value from a partition that went
   * silent at t=0.
   *
   * Hot path: hoists invariants (column count, listener iterable,
   * byColumn name) out of the per-partition loop, uses an indexed
   * for over `partitionOrder` (cheaper than for-of), and constructs
   * the record object via a plain assignment rather than a computed-
   * property literal (which V8 deopts at scale).
   */
  #emitTick(bucketIdx: number, latestTs: number): void {
    const boundaryMs = boundaryTimestampFor(this.#trigger, bucketIdx);
    const time = new Time(boundaryMs);
    const order = this.#partitionOrder;
    const states = this.#partitionStates;
    const cols = this.#columns;
    const colsLen = cols.length;
    const byCol = this.#byColumn;
    const minSamples = this.#minSamples;
    const out = this.#outputEvents;
    const listeners = this.#onEvent;
    const orderLen = order.length;

    for (let p = 0; p < orderLen; p++) {
      const key = order[p]!;
      const state = states.get(key)!;
      // Evict this partition's stale window entries against the
      // triggering event's timestamp before snapshotting.
      this.#evictPartition(state, latestTs);
      const warmup = state.entries.length - state.frontIdx < minSamples;
      const record: Record<string, ColumnValue | undefined> = {};
      record[byCol] = key;
      for (let i = 0; i < colsLen; i++) {
        record[cols[i]!.output] = warmup
          ? undefined
          : state.states[i]!.snapshot();
      }
      const evt = new Event(time, record) as unknown as EventForSchema<Out>;
      out.push(evt);
      this.#statsEmissions++;
      if (listeners.size > 0) {
        for (const fn of listeners) fn(evt);
      }
    }
  }

  /**
   * Pipeline stats snapshot — cumulative counters since
   * construction plus current per-partition state. O(partitions)
   * because `windowSize` walks every partition's live count to
   * report the max.
   *
   * - `partitions`: current partition count (= count of distinct
   *   keys ingested, plus any pre-declared groups).
   * - `eventsObserved`: total source events ingested across all
   *   partitions. Never decreases.
   * - `emissions`: total output events fired. Each clock-trigger
   *   tick fans out one event per partition, so `emissions` ≈
   *   `ticks × partitions` over time. Never decreases.
   * - `windowSize`: max across all partitions' live window counts
   *   right now. Useful for spotting partition skew (one
   *   partition's deque blowing up while others stay small).
   *   Returns 0 when no partitions exist. **Note:** the
   *   non-partitioned {@link LiveFusedRolling.stats} also has a
   *   `windowSize` field, but it means "max across windows"
   *   rather than "max across partitions." Different axis, same
   *   name.
   */
  stats(): {
    partitions: number;
    eventsObserved: number;
    emissions: number;
    windowSize: number;
  } {
    let maxLive = 0;
    for (const state of this.#partitionStates.values()) {
      const live = state.entries.length - state.frontIdx;
      if (live > maxLive) maxLive = live;
    }
    return {
      partitions: this.#partitionStates.size,
      eventsObserved: this.#statsEventsObserved,
      emissions: this.#statsEmissions,
      windowSize: maxLive,
    };
  }
}
