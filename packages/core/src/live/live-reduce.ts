import {
  normalizeAggregateColumns,
  type AggregateColumnSpec,
} from '../aggregate-columns.js';
import { Event } from '../core/event.js';
import { Time } from '../core/time.js';
import {
  rollingStateFor,
  type RollingReducerState,
} from '../reducers/index.js';
import {
  bucketIndexFor,
  boundaryTimestampFor,
  type Trigger,
  type ClockTrigger,
} from './triggers.js';
import {
  EMITS_EVICT,
  type AggregateMap,
  type AggregateOutputMap,
  type ColumnValue,
  type EventForSchema,
  type LiveSource,
  type SeriesSchema,
} from '../types.js';
import type { LiveRollingOptions } from './live-rolling-aggregation.js';

// `queueMicrotask` is a host-provided global available in browsers
// (DOM lib) and Node ≥ 11 (Node types). pond-ts targets both
// environments and intentionally does not pull either lib into
// core's tsconfig (avoids stray DOM/Node globals leaking into the
// rest of the codebase). The website's TypeDoc pass runs against
// the same tsconfig but from a different cwd (`website/`) which can
// fail to discover the root's `@types/node` walk; the ambient
// declaration here keeps the symbol resolvable in every build path.
// Pinned by docs.yml — broke the v0.15.2 docs deploy and stayed
// broken through v0.16.0 until this fix landed.
declare function queueMicrotask(callback: () => void): void;

type EventListener = (event: any) => void;

/**
 * "Reduce over the whole current buffer." `LiveReduce` is the
 * streaming counterpart to batch `series.reduce(mapping)` — same
 * mapping shape, but reactive: every push to the source updates
 * the reducer state via `add`, every retention eviction updates
 * via `remove`. The snapshot at any moment is the reduction over
 * "what's currently retained."
 *
 * **Why not sugar over `LiveFusedRolling`?** The fused-rolling
 * primitive requires a time-based window and maintains its own
 * deque. `LiveReduce`'s "window" is *whatever's in the source's
 * buffer right now* — driven by retention, not a duration. That
 * works for any retention shape (`maxAge`, `maxEvents`, both,
 * neither) without forcing a sentinel resolution.
 *
 * **Output stream-shape: a `LiveSource<Out>`.** One emitted event
 * per trigger fire, keyed at the latest source event's key. The
 * output schema is `[time, ...mappingColumns]` — same shape as
 * `LiveRollingAggregation` for consistency. Composes with the rest
 * of the live operator surface.
 *
 * **Trigger semantics match `LiveRollingAggregation`'s.** The
 * trigger fires on each source `'event'` ingest (default
 * `Trigger.event()`), per-N-events (`Trigger.count(n)`), or per
 * data-clock boundary crossing (`Trigger.every(...)`). Source
 * eviction is independent — it drives reducer-state removes but
 * does not itself fire the trigger.
 *
 * **Post-retention emission via deferred microtask.** A push
 * that triggers retention fires `'event'` per row, then runs
 * `applyRetention()`, then fires `'batch'` and `'evict'`. To
 * emit a snapshot reflecting the post-retention buffer state,
 * `LiveReduce` defers the trigger fire to a `queueMicrotask`
 * scheduled in the `'event'` handler. By the time the microtask
 * runs, all synchronous `'event'` / `'evict'` callbacks for the
 * push have completed and reducer state is consistent with the
 * source's current buffer.
 *
 * One implication: `Trigger.event()` semantics differ from
 * `LiveRollingAggregation`'s. A `pushMany(rows)` of K rows fires
 * ONE deferred emission, not K. (Each individual `push()` is one
 * row → one emission, identical.) For most users this is the
 * more useful semantic — the snapshot represents
 * "state-after-this-push," not "state-after-each-row-mid-push."
 * Users wanting per-row emissions should reach for
 * `LiveRollingAggregation` over a buffer-sized window instead.
 *
 * **Construction-time replay.** Sources with existing buffer
 * content at construction replay through `#ingest`. With
 * `Trigger.event()` this fires ONE deferred emission after
 * replay completes (not N events under the new microtask
 * defer). Test pin: `it('replay emits one deferred event ...')`.
 *
 * **Caveat — `ordering: 'reorder'` source mode.** `LiveReduce`
 * processes events in arrival order, not sorted-by-timestamp
 * order. For a source with `ordering: 'reorder'`, late events
 * are inserted into the source buffer at their sorted position
 * but reach `LiveReduce` as new arrivals. Order-sensitive
 * reducers (`first`, `last`, `samples`, `top${N}`, custom
 * functions) compute over arrival order, not buffer order.
 * Order-independent reducers (`avg`, `count`, `sum`, `min`,
 * `max`, `stdev`, `median`, `percentile`, `unique`) are
 * unaffected. If you need order-sensitive reductions on a
 * reorder-mode source, snapshot to a `TimeSeries` first via
 * `live.toTimeSeries().reduce(...)`.
 *
 * **Source contract — `EMITS_EVICT` is load-bearing.** This
 * class's reducer state stays in sync with the source's current
 * buffer because it removes events as the source evicts them.
 * The `'evict'` subscription is gated on the `EMITS_EVICT`
 * symbol marker. Sources that *evict internally* but do NOT emit
 * `'evict'` would cause `LiveReduce`'s state to grow without
 * bound (no removes ever fire). Today every pond LiveSource that
 * evicts also marks itself with `EMITS_EVICT` (`LiveSeries`,
 * `LiveView` with eviction); future LiveSource implementations
 * must preserve this contract.
 *
 * Public API: constructed via `live.reduce(mapping, opts?)` on
 * `LiveSeries` / `LiveView`. User code doesn't import this class
 * directly.
 */
export class LiveReduce<
  S extends SeriesSchema,
  Out extends SeriesSchema = SeriesSchema,
> implements LiveSource<Out> {
  readonly name: string;
  readonly schema: Out;

  readonly #columns: AggregateColumnSpec[];
  readonly #states: RollingReducerState[];

  /**
   * Map from source `Event` reference → absolute index used in the
   * reducer state. Set on `'event'` (add), looked up on `'evict'`
   * (remove). WeakMap so the source's eviction releases the
   * reference.
   */
  readonly #eventToAbsIdx: WeakMap<EventForSchema<S>, number>;
  #nextAbsIdx: number;

  readonly #trigger: Trigger;
  #lastClockBucketIdx: number | undefined;
  #countSinceLastEmit: number;
  /**
   * Deferred emission state. Trigger fires are deferred to a
   * microtask so retention has finished running and `'evict'`
   * callbacks have processed. `#pendingEmitKey` is set on each
   * `#ingest` and cleared by the microtask flush; the most-recent
   * key wins (we emit one snapshot per pushMany).
   */
  #pendingEmitKey: any | undefined;
  #pendingEmitTs: number;
  #microtaskScheduled: boolean;

  readonly #outputEvents: EventForSchema<Out>[];
  readonly #onEvent: Set<EventListener>;
  readonly #unsubscribeEvent: () => void;
  readonly #unsubscribeEvict: (() => void) | undefined;
  #disposed: boolean;

  // Pipeline counters for {@link LiveReduce.stats}.
  // Cumulative since construction; never reset.
  #statsEventsObserved = 0;
  #statsEvictions = 0;
  #statsEmissions = 0;

  constructor(
    source: LiveSource<S>,
    mapping: AggregateMap<S> | AggregateOutputMap<S>,
    options: LiveRollingOptions = {},
  ) {
    this.name = source.name;
    this.#trigger = options.trigger ?? { kind: 'event' };
    this.#lastClockBucketIdx = undefined;
    this.#countSinceLastEmit = 0;
    this.#nextAbsIdx = 0;
    this.#eventToAbsIdx = new WeakMap();
    this.#outputEvents = [];
    this.#onEvent = new Set();
    this.#pendingEmitKey = undefined;
    this.#pendingEmitTs = 0;
    this.#microtaskScheduled = false;
    this.#disposed = false;

    // Reuse the same column-normalization helper as the rest of
    // the live aggregation surface; keeps `LiveReduce`'s reducer
    // semantics identical to `aggregate` / `rolling`.
    this.#columns = normalizeAggregateColumns(
      source.schema,
      mapping as AggregateMap<SeriesSchema> | AggregateOutputMap<SeriesSchema>,
    );
    this.#states = this.#columns.map((c) => rollingStateFor(c.reducer));

    // Output schema: source's first (time/keyed) column + each
    // reducer's output column. Matches LiveRollingAggregation's
    // schema shape for consistency.
    this.schema = Object.freeze([
      source.schema[0],
      ...this.#columns.map((c) => ({
        name: c.output,
        kind: c.kind,
        required: false,
      })),
    ]) as unknown as Out;

    // Replay existing buffer events through the same ingest path
    // so `LiveReduce` over a non-empty source matches the
    // streaming-from-construction shape.
    for (let i = 0; i < source.length; i++) {
      this.#ingest(source.at(i)!);
    }

    // Subscribe to source for forward events. The 'event' callback
    // fires per source event (post-insert, pre-retention); 'evict'
    // fires after retention has run, with the dropped events. Both
    // are wired so reducer state stays in sync with the source's
    // current buffer.
    this.#unsubscribeEvent = source.on('event', (event) => {
      this.#ingest(event);
    });
    // Same duck-typing pattern as LiveView's evict subscription:
    // `LiveSource.on()` only declares `'event'`, but sources marked
    // with `EMITS_EVICT` also support `'evict'`. Other LiveSource
    // impls (LiveAggregation, LiveRollingAggregation) silently route
    // unknown event types to other listener sets, so we must guard.
    if (EMITS_EVICT in source) {
      this.#unsubscribeEvict = (source as any).on(
        'evict',
        (evicted: ReadonlyArray<EventForSchema<S>>) => {
          for (const ev of evicted) this.#evictOne(ev);
        },
      );
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

  /**
   * Read the current reducer snapshot — every output column's
   * current value, computed over the source's current buffer. Cheap
   * O(reducers) — each reducer's `snapshot()` is O(1) for built-ins.
   */
  value(): Record<string, ColumnValue | undefined> {
    const result: Record<string, ColumnValue | undefined> = {};
    for (let i = 0; i < this.#columns.length; i++) {
      result[this.#columns[i]!.output] = this.#states[i]!.snapshot();
    }
    return result;
  }

  on(type: 'event', fn: EventListener): () => void {
    if (type !== 'event') {
      throw new TypeError(
        `LiveReduce.on: unsupported event type '${String(type)}'`,
      );
    }
    this.#onEvent.add(fn);
    return () => {
      this.#onEvent.delete(fn);
    };
  }

  /**
   * Pipeline stats snapshot — cumulative counters since
   * construction plus current reducer-state size. Cheap O(1).
   *
   * - `eventsObserved`: total source events ingested into reducer
   *   state. Includes events replayed at construction from a
   *   non-empty source — phrased uniformly with sibling classes'
   *   stats() docs. Never decreases.
   * - `evictions`: total events removed from reducer state via
   *   the source's `'evict'` channel. Events that predated this
   *   `LiveReduce` (so weren't in `#eventToAbsIdx`) don't count.
   *   Never decreases.
   * - `emissions`: total output events fired. Never decreases.
   *   For `Trigger.event`, a single `pushMany(K)` fires ONE
   *   deferred emission (see class JSDoc) — `emissions` may be
   *   strictly less than `eventsObserved`.
   * - `bufferSize`: current count of events in reducer state
   *   (= `eventsObserved - evictions`). Tracks the source's
   *   current retained buffer that this reduce sees.
   *
   * **`bufferSize` is only meaningful when the source emits
   * `'evict'`.** This class subscribes to `'evict'` only when
   * the source is marked with `EMITS_EVICT` (see class JSDoc).
   * If a future `LiveSource` impl evicts internally without
   * emitting `'evict'`, `evictions` stays at 0 and `bufferSize`
   * grows monotonically — silently wrong. Today every pond
   * source that evicts also marks `EMITS_EVICT`, so this is
   * theoretical, but the contract is load-bearing.
   */
  stats(): {
    eventsObserved: number;
    evictions: number;
    emissions: number;
    bufferSize: number;
  } {
    return {
      eventsObserved: this.#statsEventsObserved,
      evictions: this.#statsEvictions,
      emissions: this.#statsEmissions,
      bufferSize: this.#statsEventsObserved - this.#statsEvictions,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeEvent();
    this.#unsubscribeEvict?.();
  }

  // ── Private ─────────────────────────────────────────────────

  #ingest(event: EventForSchema<S>): void {
    if (this.#disposed) return;
    this.#statsEventsObserved++;
    const absIdx = this.#nextAbsIdx++;
    this.#eventToAbsIdx.set(event, absIdx);
    const data = event.data() as Record<string, ColumnValue | undefined>;
    for (let i = 0; i < this.#columns.length; i++) {
      this.#states[i]!.add(absIdx, data[this.#columns[i]!.source]);
    }

    // For Trigger.count, increment per-event so we don't lose
    // count progress across deferred microtasks (a pushMany of K
    // rows must increment K times, not 1). Other triggers settle
    // their state in the deferred flush.
    if (this.#trigger.kind === 'count') {
      this.#countSinceLastEmit++;
    }

    // Schedule a deferred emission via microtask. By the time it
    // runs, retention has applied AND `'evict'` callbacks have
    // processed → reducer state is consistent with source's
    // current buffer. Per-pushMany this fires once regardless of
    // K rows; the most-recent key wins. See class JSDoc.
    this.#pendingEmitKey = event.key();
    this.#pendingEmitTs = event.begin();
    if (!this.#microtaskScheduled) {
      this.#microtaskScheduled = true;
      queueMicrotask(() => this.#flushPendingEmit());
    }
  }

  /**
   * Microtask flush: runs after the current synchronous push
   * completes, including any retention-driven `'evict'` callbacks.
   * Reducer state is post-retention by this point.
   */
  #flushPendingEmit(): void {
    this.#microtaskScheduled = false;
    const key = this.#pendingEmitKey;
    const ts = this.#pendingEmitTs;
    this.#pendingEmitKey = undefined;
    if (this.#disposed || key === undefined) return;

    switch (this.#trigger.kind) {
      case 'event':
        this.#emitEvent(key);
        return;
      case 'clock':
        this.#emitClock(ts, this.#trigger);
        return;
      case 'count': {
        // Drain count emissions: a single pushMany of K rows can
        // exceed multiple thresholds. Emit floor(count / n) times,
        // each with the same merged key (the latest seen).
        const n = this.#trigger.n;
        while (this.#countSinceLastEmit >= n) {
          this.#countSinceLastEmit -= n;
          this.#emitEvent(key);
        }
        return;
      }
    }
  }

  #evictOne(event: EventForSchema<S>): void {
    if (this.#disposed) return;
    const absIdx = this.#eventToAbsIdx.get(event);
    if (absIdx === undefined) return; // event predated this LiveReduce
    this.#eventToAbsIdx.delete(event);
    this.#statsEvictions++;
    const data = event.data() as Record<string, ColumnValue | undefined>;
    for (let i = 0; i < this.#columns.length; i++) {
      this.#states[i]!.remove(absIdx, data[this.#columns[i]!.source]);
    }
    // Eviction does NOT fire the trigger — only ingest does. This
    // matches `LiveRollingAggregation`'s pattern, where evictions
    // are silent state updates.
  }

  #emitEvent(key: any): void {
    const record: Record<string, ColumnValue | undefined> = {};
    for (let i = 0; i < this.#columns.length; i++) {
      record[this.#columns[i]!.output] = this.#states[i]!.snapshot();
    }
    const outputEvent = new Event(
      key,
      record,
    ) as unknown as EventForSchema<Out>;
    this.#outputEvents.push(outputEvent);
    this.#statsEmissions++;
    for (const fn of this.#onEvent) fn(outputEvent);
  }

  #emitClock(eventTs: number, trigger: ClockTrigger): void {
    const bucketIdx = bucketIndexFor(trigger, eventTs);
    if (this.#lastClockBucketIdx === undefined) {
      this.#lastClockBucketIdx = bucketIdx;
      return;
    }
    if (bucketIdx > this.#lastClockBucketIdx) {
      const boundaryMs = boundaryTimestampFor(trigger, bucketIdx);
      this.#emitEvent(new Time(boundaryMs));
      this.#lastClockBucketIdx = bucketIdx;
    }
  }
}
