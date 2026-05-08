import {
  EMITS_EVICT,
  type EventForSchema,
  type LiveSource,
  type SeriesSchema,
} from './types.js';

/**
 * Sampling strategy declaration. Stride is deterministic 1-in-N;
 * reservoir is K-of-N random with drift-on-eviction.
 *
 * See `LiveSample`'s class JSDoc for the per-strategy semantics and
 * the use-case mapping (sliding-window stats → stride; population
 * summary / visualization → reservoir).
 */
export type SampleStrategy =
  | { stride: number }
  | { reservoir: { size: number } };

/**
 * Sampling strategy for the pre-partition (global) call sites
 * (`LiveSeries.sample`, `LiveView.sample`). Requires the
 * `unsafeGlobal: true` token so the call site acknowledges the
 * bias-trap risk: a single global counter against a structured input
 * stream (e.g., round-robin host order) silently keeps the same
 * subset of partitions and drops the rest. Chaining
 * `partitionBy(c).sample(...)` instead is safe by construction and
 * doesn't require this token.
 *
 * The bias trap was first surfaced by the gRPC experiment's M3.5
 * prototype (pond-grpc-experiment#33): a stride-10 filter at the
 * gRPC ingest layer, fed a round-robin per-host event stream,
 * silently kept 8 of 80 hosts and dropped 72.
 */
export type GlobalSampleStrategy =
  | { stride: number; unsafeGlobal: true }
  | { reservoir: { size: number }; unsafeGlobal: true };

type EventListener<S extends SeriesSchema> = (event: EventForSchema<S>) => void;
type EvictListener<S extends SeriesSchema> = (
  evicted: readonly EventForSchema<S>[],
) => void;

/**
 * Streaming sampling operator that thins events going into downstream
 * consumers without affecting the parent series' length, listener
 * fan-out, or upstream counters. Decouples downstream baseline
 * window length from event rate — critical at firehose rates where
 * a 5m rolling baseline at 70k events/s would not fit in a Node
 * heap un-sampled but does at stride 10 or 50.
 *
 * **Two strategies:**
 *
 * - **Stride** (`{ stride: N }`): deterministic 1-in-N. Cheap (O(1),
 *   no RNG, no allocation). Uniform-over-time — every moment's
 *   window is a uniform sample of events. Default for sliding-
 *   window stats.
 *
 * - **Reservoir** (`{ reservoir: { size: K } }`): K-of-N random via
 *   Algorithm R, with drift-on-eviction. On source evict, evicted
 *   events leave the reservoir; the next ingested event refills the
 *   empty slot deterministically. Approximately uniform over the
 *   source's currently-retained buffer; under steady-state eviction,
 *   the reservoir drifts slightly toward newer events as refilled
 *   slots take recent arrivals. Default for population summaries
 *   and visualization (`series.sample({reservoir:{size:500}}).toRows()`).
 *
 * **When to use which:**
 *
 * | Use case | Stride | Reservoir |
 * | --- | --- | --- |
 * | Sliding-window stats (rolling avg / percentiles) | ✅ default | ⚠️ drift |
 * | Population summary over the retained buffer | ⚠️ rolling-only | ✅ |
 * | Visualization (scatter plot, sparkline samples) | ⚠️ regular-spacing | ✅ default |
 * | Top-K / unique reducers | ❌ misses singletons | ⚠️ also misses |
 * | `live.reduce()` over buffer-as-window | ✅ uniform-over-time | ⚠️ drift |
 *
 * **Sample-rate metadata:** reducer outputs (`'count'`, `'sum'`,
 * `'samples'`, `topN`) downstream of `sample` reflect the sampled
 * stream, not the source. Multiply by stride to estimate true counts:
 *
 * ```ts
 * const sampled = live.partitionBy('host').sample({ stride: 10 });
 * const counts = sampled.rolling('1m', { events: 'count' });
 * // counts.value().events × 10 ≈ true count over the 1m window
 * ```
 *
 * `live.stats().ingested` and `live.on('batch', cb)` are upstream of
 * any `.sample(...)` op — they continue counting true throughput.
 * Only consumers downstream of `sample` see the thinned stream.
 *
 * **Eviction-transparent.** When the source emits `'evict'`, this
 * view drops any sampled events that were evicted from the source
 * AND clears the corresponding reservoir slot (for the reservoir
 * strategy). Stride mode is stateless under eviction.
 *
 * **Public API:** constructed via the `sample(strategy)` chainable
 * method on `LiveSeries`, `LivePartitionedSeries`, `LiveView`, or
 * `LivePartitionedView`. User code doesn't import this class
 * directly. The pre-partition call sites (`LiveSeries.sample`,
 * `LiveView.sample`) require `GlobalSampleStrategy` (with
 * `unsafeGlobal: true`); the partitioned call sites accept
 * `SampleStrategy` directly.
 */
export class LiveSample<S extends SeriesSchema> implements LiveSource<S> {
  readonly [EMITS_EVICT] = true as const;
  readonly name: string;
  readonly schema: S;

  readonly #strategy: SampleStrategy;
  readonly #events: EventForSchema<S>[];

  /** Total source events seen since construction (Algorithm R `seen`, also stride counter). */
  #seen: number = 0;

  /**
   * Reservoir slots — fixed-length array with `undefined` for empty
   * slots. Empty slots arise from source eviction of an event that
   * was in the reservoir; the next ingest refills the first empty
   * slot deterministically. Only used for reservoir strategy.
   */
  readonly #reservoirSlots: (EventForSchema<S> | undefined)[] = [];

  /**
   * Set membership for fast O(1) check on source eviction. Only used
   * for reservoir strategy — stride doesn't track membership (every
   * passed event is appended to `#events` chronologically and dropped
   * via the standard cutoff-based eviction).
   */
  readonly #reservoirSet: Set<EventForSchema<S>> = new Set();

  readonly #onEvent: Set<EventListener<S>> = new Set();
  readonly #onEvict: Set<EvictListener<S>> = new Set();
  readonly #unsubscribe: () => void;

  /** @internal — constructed via the `sample` method on the chainable surfaces. */
  constructor(source: LiveSource<S>, strategy: SampleStrategy) {
    this.name = source.name;
    this.schema = source.schema;
    this.#strategy = strategy;
    this.#events = [];

    if ('stride' in strategy) {
      if (!Number.isInteger(strategy.stride) || strategy.stride < 1) {
        throw new TypeError(
          `sample({ stride }): stride must be a positive integer (got ${String(strategy.stride)})`,
        );
      }
    } else {
      const size = strategy.reservoir.size;
      if (!Number.isInteger(size) || size < 1) {
        throw new TypeError(
          `sample({ reservoir }): size must be a positive integer (got ${String(size)})`,
        );
      }
      this.#reservoirSlots = new Array(size).fill(undefined);
    }

    // Replay existing source events so a sample created on a non-empty
    // source matches the streaming-from-construction shape.
    for (let i = 0; i < source.length; i++) {
      this.#ingest(source.at(i)!);
    }

    const eventUnsub = source.on('event', (event) => {
      this.#ingest(event);
    });

    // Subscribe to source eviction so reservoir slots clear and the
    // sampled #events buffer shrinks. Same EMITS_EVICT duck-typing
    // pattern LiveView uses.
    let evictUnsub: (() => void) | undefined;
    if (EMITS_EVICT in source) {
      // `LiveSource.on()` only declares `'event'`; sources marked with
      // `EMITS_EVICT` also support `'evict'`. Same duck-typing pattern
      // LiveView and LiveReduce use for the eviction subscription.
      evictUnsub = (
        source as unknown as {
          on(
            type: 'evict',
            fn: (evicted: readonly EventForSchema<S>[]) => void,
          ): () => void;
        }
      ).on('evict', (evicted) => {
        this.#handleSourceEvict(evicted);
      });
    }

    this.#unsubscribe = () => {
      eventUnsub();
      evictUnsub?.();
    };
  }

  // ── LiveSource<S> contract ────────────────────────────────

  get length(): number {
    return this.#events.length;
  }

  at(index: number): EventForSchema<S> | undefined {
    if (index < 0) index = this.#events.length + index;
    return this.#events[index];
  }

  on(type: 'event', fn: EventListener<S>): () => void;
  on(type: 'evict', fn: EvictListener<S>): () => void;
  on(
    type: 'event' | 'evict',
    fn: EventListener<S> | EvictListener<S>,
  ): () => void {
    const set =
      type === 'event'
        ? (this.#onEvent as Set<unknown>)
        : (this.#onEvict as Set<unknown>);
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  dispose(): void {
    this.#unsubscribe();
  }

  // ── Private ────────────────────────────────────────────

  #ingest(event: EventForSchema<S>): void {
    this.#seen++;

    if ('stride' in this.#strategy) {
      // Stride: keep events whose 1-indexed position is a multiple of
      // stride. Equivalent to keeping at indices stride-1, 2*stride-1,
      // … so the FIRST event passes when stride === 1.
      if (this.#seen % this.#strategy.stride === 0) {
        this.#events.push(event);
        for (const fn of this.#onEvent) fn(event);
      }
      return;
    }

    // Reservoir (Algorithm R + Option A drift-on-eviction).
    const k = this.#reservoirSlots.length;
    if (this.#reservoirSet.size < k) {
      // Refill mode: initial fill OR refilling a slot freed by source
      // eviction. Walk slots to find the first empty one.
      let slot = -1;
      for (let i = 0; i < k; i++) {
        if (this.#reservoirSlots[i] === undefined) {
          slot = i;
          break;
        }
      }
      // size < k guarantees an empty slot exists; the loop must find one.
      this.#reservoirSlots[slot] = event;
      this.#reservoirSet.add(event);
      this.#events.push(event);
      for (const fn of this.#onEvent) fn(event);
      return;
    }

    // Reservoir is full — Algorithm R replacement.
    const j = Math.floor(Math.random() * this.#seen);
    if (j >= k) return; // Discard — most events at steady state.

    const evicted = this.#reservoirSlots[j]!;
    this.#reservoirSlots[j] = event;
    this.#reservoirSet.delete(evicted);
    this.#reservoirSet.add(event);

    // #events stays chronologically sorted: remove the evicted event
    // (somewhere in the middle), append the new one (newest, so end).
    const idx = this.#events.indexOf(evicted);
    // idx is always >= 0 because the evicted event was in the
    // reservoir which means it was previously added to #events.
    this.#events.splice(idx, 1);
    this.#events.push(event);

    // Reservoir replacement is a paired evict+append — fire both so
    // downstream consumers (LiveView eviction-mirroring, listeners)
    // see the same chronological mutation the source-side eviction
    // path produces.
    if (this.#onEvict.size > 0) {
      for (const fn of this.#onEvict) fn([evicted]);
    }
    for (const fn of this.#onEvent) fn(event);
  }

  /**
   * Handle source-side eviction: drop any events that were sampled
   * (in `#events`) AND, for reservoir strategy, clear the reservoir
   * slot so the next ingest can refill it. Stride-mode just shrinks
   * the buffer.
   */
  #handleSourceEvict(evicted: readonly EventForSchema<S>[]): void {
    if (evicted.length === 0 || this.#events.length === 0) return;

    const removed: EventForSchema<S>[] = [];

    if ('reservoir' in this.#strategy) {
      // Reservoir: per-event Set check; clear matching slot.
      for (const ev of evicted) {
        if (this.#reservoirSet.has(ev)) {
          const slot = this.#reservoirSlots.indexOf(ev);
          // slot is always >= 0 because the Set is in lock-step with
          // the slots array.
          this.#reservoirSlots[slot] = undefined;
          this.#reservoirSet.delete(ev);
          const idx = this.#events.indexOf(ev);
          if (idx !== -1) {
            this.#events.splice(idx, 1);
            removed.push(ev);
          }
        }
      }
    } else {
      // Stride: cutoff-based eviction. Source's evict batch is
      // chronologically ordered; the latest evicted timestamp marks
      // the cutoff. Drop sampled events at or before that cutoff.
      const cutoff = evicted[evicted.length - 1]!.begin();
      let i = 0;
      while (i < this.#events.length && this.#events[i]!.begin() <= cutoff) {
        i++;
      }
      if (i > 0) {
        const dropped = this.#events.splice(0, i);
        removed.push(...dropped);
      }
    }

    if (removed.length > 0 && this.#onEvict.size > 0) {
      for (const fn of this.#onEvict) fn(removed);
    }
  }
}
