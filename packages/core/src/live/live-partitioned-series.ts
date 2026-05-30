import { LiveSeries, type LiveSeriesOptions } from './live-series.js';
import { LiveRollingAggregation } from './live-rolling-aggregation.js';
import { LivePartitionedSyncRolling } from './live-partitioned-sync-rolling.js';
import { LivePartitionedFusedRolling } from './live-partitioned-fused-rolling.js';
import type { SampleStrategy } from '../sequence/sample.js';
import {
  makeCumulativeView,
  makeDiffView,
  makeFillView,
  makeStrideSampleView,
  type LiveFillMapping,
  type LiveFillStrategy,
} from './live-view.js';
import type { Trigger } from './triggers.js';
import {
  type AggregateMap,
  type AggregateOutputMap,
  type DiffSchema,
  type EventDataForSchema,
  type EventForSchema,
  type LiveSource,
  type NumericColumnNameForSchema,
  type RollingSchema,
  type RowForSchema,
  type SeriesSchema,
} from '../schema/index.js';
import type { RollingOutputMapSchema } from '../schema/index.js';
import type {
  FusedMapping,
  FusedMappingValid,
  FusedPartitionedRollingSchema,
} from '../schema/index.js';
import type { DurationInput } from '../core/duration.js';
import type {
  LiveRollingOptions,
  RollingWindow,
} from './live-rolling-aggregation.js';

/**
 * Structural target for `#wireSyncRolling` — both
 * {@link LivePartitionedSyncRolling} and
 * {@link LivePartitionedFusedRolling} implement this shape, so the
 * wiring code (cross-partition replay + per-partition subscription
 * + spawn handling) is shared between them.
 */
type SyncRollingIngestTarget<R extends SeriesSchema, K extends string> = {
  ingest(key: K, event: EventForSchema<R>): void;
  _registerUnsubscribe(unsub: () => void): void;
};

type SpawnListener<S extends SeriesSchema, K extends string> = (
  key: K,
  partition: LiveSource<S>,
) => void;

/**
 * Per-partition retention and grace settings for a partitioned live
 * view. Each partition is its own bounded buffer with these limits;
 * the source `LiveSource`'s own retention does not propagate.
 */
export type LivePartitionedOptions<K extends string> = {
  /** Declared partition values (mirrors batch `partitionBy({ groups })`). */
  groups?: ReadonlyArray<K>;
  /**
   * Retention applied to each partition's sub-buffer independently.
   * Defaults to inheriting the source `LiveSeries`'s retention; pass
   * explicitly to override (e.g. shorter per-partition cap).
   */
  retention?: NonNullable<LiveSeriesOptions<SeriesSchema>['retention']>;
  /**
   * Grace window applied per partition for late events. Defaults to
   * inheriting the source's `graceWindow` when the effective
   * `ordering` is `'reorder'`; pass explicitly to override.
   */
  graceWindow?: DurationInput;
  /**
   * Ordering mode for each partition. Defaults to inheriting the
   * source's `ordering`; pass explicitly to override (e.g. force
   * strict partitions on a reorder source).
   *
   * Pre-0.17.1 this defaulted to `'strict'` regardless of source — a
   * footgun that crashed the partition router on late events the
   * source already accepted under reorder. Inheritance closes that
   * gap; see the v0.17.1 CHANGELOG entry.
   */
  ordering?: NonNullable<LiveSeriesOptions<SeriesSchema>['ordering']>;
};

/** Encoder for partition values → keys. Mirrors the batch single-column case. */
function partitionKey(
  event: { data(): Record<string, unknown> },
  col: string,
): string {
  const v = event.data()[col];
  return v === undefined ? ' undefined' : `${String(v)}`;
}

/**
 * Live counterpart to {@link PartitionedTimeSeries}. Routes events
 * from a source `LiveSource<S>` into per-partition `LiveSeries<S>`
 * sub-buffers, each with its own retention, grace window, and
 * stateful operator pipeline.
 *
 * **Per-partition semantics** (settled in the v0.11 design pass):
 *
 * - **Retention** applies to each partition independently. A
 *   chatty host can't squeeze a quiet one out of the buffer.
 * - **Grace windows** apply per partition. A late event for
 *   `host-A` does not perturb `host-B`'s emission. **Caveat:**
 *   per-partition grace is bounded by the source's grace
 *   window. If the source rejects an event (because it's older
 *   than the source's grace), it never reaches the partitioned
 *   view. Setting `partitionBy('host', { graceWindow: '10m' })`
 *   on a source with `graceWindow: '1m'` silently uses the
 *   smaller window.
 * - **Aggregation timing** is per-partition. `host-A`'s rolling
 *   avg fires when `host-A` has enough data, regardless of
 *   `host-B`.
 * - **Auto-spawn** on new partition values: the first time a
 *   value not seen before arrives, allocate a sub-buffer.
 *   Optional `{ groups }` upfront declares the expected set
 *   (mirrors the batch typed-groups pattern); when set, unknown
 *   partition values throw on ingest.
 *
 * **v0.11 PR 1 scope** — foundation only. Compose operators per
 * partition via `apply((sub) => sub.fill(...).rolling(...))`.
 * Typed chainable sugar methods (`fill(...).rolling(...).collect()`)
 * arrive in v0.11 PR 2.
 *
 * @example
 * ```ts
 * const live = new LiveSeries({ ... });
 *
 * // Per-host event lookup — direct subscription per partition.
 * const byHost = live.partitionBy('host').toMap();
 * byHost.get('api-1')?.on('event', (e) => { ... });
 *
 * // Apply a chain of live operators per partition; collect into a
 * // unified LiveSeries.
 * const cpuSmoothed = live.partitionBy('host').apply((sub) =>
 *   sub.fill({ cpu: 'hold' }).rolling('1m', { cpu: 'avg' }),
 * );
 * ```
 */
export class LivePartitionedSeries<
  S extends SeriesSchema,
  K extends string = string,
  ByCol extends keyof EventDataForSchema<S> & string =
    keyof EventDataForSchema<S> & string,
> {
  // NOTE: `LivePartitionedSeries` is intentionally NOT a `LiveSource` —
  // it has no `on()` method and does not emit events directly.
  // Consumers obtain a `LiveSource` from `collect()` (unified buffer),
  // `apply()` (per-partition factory output), or `toMap()` (per-partition
  // sources). We deliberately do not declare `EMITS_EVICT` so that
  // `LiveView`'s duck-typed eviction subscription (`EMITS_EVICT in
  // source`) doesn't trip on this class.
  //
  // `ByCol` (added 2026-05-05) is the narrowed literal type of the
  // partition column's name (e.g. `'host'`). Captured from the `by`
  // argument at construction so the partitioned-rolling fused
  // overload's `FusedPartitionedRollingSchema<S, ByCol, FM>` resolves
  // without forcing callers to write `partitionBy<'host'>('host')`.
  // Default is the union of all valid column names — the natural
  // upper bound when the literal can't be inferred.
  readonly name: string;
  readonly schema: S;
  readonly by: ByCol;
  readonly groups?: ReadonlyArray<K>;

  readonly #partitions: Map<K, LiveSeries<S>>;
  readonly #partitionOptions: {
    retention: LiveSeriesOptions<S>['retention'];
    graceWindow: LiveSeriesOptions<S>['graceWindow'];
    ordering: LiveSeriesOptions<S>['ordering'];
  };
  readonly #onSpawn: Set<SpawnListener<S, K>>;
  readonly #disposers: Set<() => void>;
  readonly #unsubscribeSource: () => void;

  // Pipeline counters for {@link LivePartitionedSeries.stats}.
  // Cumulative since construction; never reset.
  #statsEventsRouted = 0;

  constructor(
    source: LiveSource<S>,
    by: ByCol,
    options: LivePartitionedOptions<K> = {},
  ) {
    this.name = source.name;
    this.schema = source.schema;
    this.by = by;

    if (!source.schema.some((c) => c.name === by)) {
      throw new TypeError(
        `LivePartitionedSeries: column "${String(by)}" not in schema`,
      );
    }

    if (options.groups !== undefined) {
      if (options.groups.length === 0) {
        throw new TypeError('LivePartitionedSeries: `groups` cannot be empty.');
      }
      const seen = new Set<string>();
      for (const g of options.groups) {
        if (seen.has(g)) {
          throw new TypeError(
            `LivePartitionedSeries: duplicate value ${JSON.stringify(g)} in \`groups\`.`,
          );
        }
        seen.add(g);
      }
      this.groups = options.groups;
    }

    this.#partitions = new Map();
    this.#partitionOptions = {
      retention: options.retention,
      graceWindow: options.graceWindow,
      ordering: options.ordering,
    };
    this.#onSpawn = new Set();
    this.#disposers = new Set();

    if (this.groups) {
      for (const g of this.groups) {
        this.#spawnPartition(g);
      }
    }

    // Replay source's existing events into the right partitions.
    for (let i = 0; i < source.length; i++) {
      this.#routeEvent(source.at(i)!);
    }

    // Subscribe to new events from the source.
    this.#unsubscribeSource = source.on('event', (event) => {
      this.#routeEvent(event);
    });
  }

  /**
   * Materialize the partitioned view as a `Map<key, LiveSource<S>>`,
   * one entry per spawned partition. Map iteration order matches
   * spawn order (declared order if `groups` was set, insertion
   * order otherwise).
   */
  toMap(): Map<K, LiveSource<S>> {
    return new Map(this.#partitions);
  }

  /**
   * Fan in events from every partition into a single unified
   * `LiveSeries<S>`. Subscribes to per-partition output `'event'`
   * streams and pushes each event into the unified buffer.
   *
   * **Append-only semantics.** This is a fan-in sink, not a
   * mirrored materialization. When per-partition retention or
   * grace evicts events from a sub-buffer, those evictions are
   * NOT propagated to the unified buffer. The unified buffer
   * keeps every event it ever received until evicted by its own
   * retention. To control its size, pass a `retention` option to
   * `collect`. To inspect the current per-partition state, use
   * `toMap()` and snapshot each partition independently.
   *
   * **Ordering (v0.17.1+).** The unified `LiveSeries` defaults to
   * inheriting `ordering` and `graceWindow` from this partitioned
   * series (which itself inherits from the source `LiveSeries` via
   * `partitionBy`). Pre-fix it defaulted to `'strict'` regardless of
   * source — under `'reorder'` sources, partition fan-in could
   * deliver events out of order to a strict unified buffer and
   * throw. Inheritance closes that gap. Explicit `ordering` and
   * `graceWindow` on `collect(...)` override inheritance.
   *
   * **Retention does NOT inherit** — the append-only fan-in
   * semantics above are deliberate. Pass `retention` explicitly to
   * cap the unified buffer.
   */
  collect(options?: Partial<LiveSeriesOptions<S>>): LiveSeries<S> {
    const unifiedOptions: LiveSeriesOptions<S> = {
      name: options?.name ?? this.name,
      schema: this.schema,
      // Fed per-event via `_pushTrustedEvents` (partition fan-in), so
      // it stays on the Event[] backing — chunked is for batched
      // top-level ingest only.
      __backing: 'array',
    };
    // Default-inherit ordering / graceWindow from this partitioned
    // series (which itself inherits from its source LiveSeries via
    // `partitionBy`). Without inheritance the unified buffer would
    // default to `'strict'` regardless of source mode — same trap as
    // the partition sub-series footgun, just at the fan-in hop.
    // Explicit caller options win.
    //
    // graceWindow is gated on the effective ordering being 'reorder'
    // — LiveSeries rejects graceWindow with strict/drop orderings.
    //
    // **Retention does NOT inherit** — the "append-only fan-in"
    // semantics documented in `collect()`'s JSDoc are deliberate:
    // partition retention bounds partition memory; the unified
    // buffer's retention is independent. Pass `{ retention: ... }`
    // explicitly to cap the unified buffer.
    const inherited = this.#partitionOptions;
    const ordering = options?.ordering ?? inherited.ordering;
    if (ordering !== undefined) unifiedOptions.ordering = ordering;
    const graceWindow = options?.graceWindow ?? inherited.graceWindow;
    if (graceWindow !== undefined && ordering === 'reorder') {
      unifiedOptions.graceWindow = graceWindow;
    }
    if (options?.retention !== undefined) {
      unifiedOptions.retention = options.retention;
    }

    const unified = new LiveSeries<S>(unifiedOptions);

    const subscribeToPartition = (partition: LiveSource<S>): (() => void) => {
      return partition.on('event', (event) => {
        // Trusted fast path — see LiveSeries._pushTrustedEvents.
        // Partition sub-series share the unified buffer's schema `S`,
        // so the source-side validation is sufficient.
        unified._pushTrustedEvents([event]);
      });
    };

    // Sort existing events from all partitions by time, then push
    // them into the unified buffer in order. Without this prefix
    // pass, collect() only catches new events going forward and
    // misses anything pre-existing in the partition sub-buffers.
    type Existing = { time: number; event: EventForSchema<S> };
    const existing: Existing[] = [];
    for (const partition of this.#partitions.values()) {
      for (let i = 0; i < partition.length; i++) {
        const e = partition.at(i)!;
        existing.push({ time: e.begin(), event: e });
      }
    }
    existing.sort((a, b) => a.time - b.time);
    if (existing.length > 0) {
      // Single batched push — one retention pass + one batch listener
      // call instead of one per existing event.
      unified._pushTrustedEvents(existing.map((x) => x.event));
    }

    for (const partition of this.#partitions.values()) {
      this.#disposers.add(subscribeToPartition(partition));
    }
    this.#onSpawn.add((_, partition) => {
      this.#disposers.add(subscribeToPartition(partition));
    });

    return unified;
  }

  /**
   * Apply `factory` per-partition and fan in the outputs into a
   * single unified `LiveSeries<R>`. The factory is called once per
   * partition (current and future); each call receives the
   * partition's `LiveSource<S>` and should return a `LiveSource<R>`
   * derived from it (typically by composing `LiveSeries`-style
   * operators like `sub.fill(...).rolling(...)`).
   *
   * The unified series subscribes to every factory output and
   * pushes events as they arrive. Auto-spawn propagates: a new
   * partition value triggers a fresh factory invocation and the
   * resulting `LiveSource` is subscribed to.
   *
   * **Append-only semantics.** Same as `collect()` — this is a
   * fan-in sink. Per-partition output evictions (e.g. from a
   * window operator inside the factory) are NOT propagated to
   * the unified buffer. Use the `options` argument to set the
   * unified buffer's own retention.
   *
   * **History replay.** When `apply()` is called on a partitioned
   * view that already has events distributed across multiple
   * partitions, existing factory-output events are gathered from
   * every output, sorted globally by time, and pushed into the
   * unified buffer in time order. This preserves strict ordering
   * for the unified buffer.
   *
   * **Factory contract.** The factory must be **pure and
   * re-runnable**: side-effect-free, no closure-captured state
   * that mutates across calls, no external subscriptions on the
   * input or output. The implementation invokes the factory once
   * upfront on a stub `LiveSeries<S>` (to capture the output
   * schema synchronously) and again once per partition (current
   * and future). Factories that don't satisfy the contract may
   * leak state across the stub call and the real per-partition
   * calls.
   *
   * **Ordering (v0.17.1+).** Same shape as `collect()` — the unified
   * `LiveSeries<R>` inherits `ordering` and `graceWindow` from this
   * partitioned series by default; explicit `options.ordering` /
   * `options.graceWindow` override. Retention stays caller-explicit
   * per the append-only fan-in semantics.
   */
  apply<R extends SeriesSchema>(
    factory: (sub: LiveSeries<S>) => LiveSource<R>,
    options?: Partial<LiveSeriesOptions<R>>,
  ): LiveSeries<R> {
    // Capture the output schema upfront by running the factory on
    // an empty stub LiveSeries. The stub is never connected to a
    // source — it only exists to let `factory` declare its output
    // schema synchronously, before any partitions exist.
    const stub = new LiveSeries<S>({
      name: `${this.name}/_stub`,
      schema: this.schema,
      __backing: 'array',
    });
    const stubOut = factory(stub);
    const outSchema: R = stubOut.schema;

    const opts: LiveSeriesOptions<R> = {
      name: options?.name ?? this.name,
      schema: outSchema,
      // Per-event fan-in buffer — Event[] backing (see collect()).
      __backing: 'array',
    };
    // Default-inherit ordering / graceWindow from the partitioned
    // series — same shape as collect() above. Without this the
    // apply()-unified buffer would default to `'strict'` and throw on
    // out-of-order arrivals from factory outputs feeding it on a
    // `'reorder'` source. Retention stays caller-explicit per the
    // append-only fan-in semantics; see collect()'s rationale above.
    //
    // graceWindow gated on effective ordering being 'reorder' — same
    // reason as collect().
    const inherited = this.#partitionOptions;
    const ordering = options?.ordering ?? inherited.ordering;
    if (ordering !== undefined) opts.ordering = ordering;
    const graceWindow = options?.graceWindow ?? inherited.graceWindow;
    if (graceWindow !== undefined && ordering === 'reorder') {
      opts.graceWindow = graceWindow;
    }
    if (options?.retention !== undefined) opts.retention = options.retention;
    const unified = new LiveSeries<R>(opts);

    // Build factory outputs for all existing partitions first, then
    // globally sort their existing events by time and push them in
    // order. Without this two-phase pass, the unified buffer would
    // receive partition-A's history fully before partition-B's,
    // producing out-of-order pushes and tripping unified's strict
    // ordering when histories interleave (e.g. a@0, b@60k, a@120k).
    const outputs: Array<{ key: K; out: LiveSource<R> }> = [];
    for (const [key, partition] of this.#partitions) {
      outputs.push({ key, out: factory(partition as LiveSeries<S>) });
    }

    type ExistingR = { time: number; event: EventForSchema<R>; outSchema: R };
    const existing: ExistingR[] = [];
    for (const { out } of outputs) {
      for (let i = 0; i < out.length; i++) {
        const e = out.at(i)!;
        existing.push({ time: e.begin(), event: e, outSchema: out.schema });
      }
    }
    existing.sort((a, b) => a.time - b.time);
    if (existing.length > 0) {
      // Single batched push for the historical prefix — same trust
      // contract as the live subscribers below: each factory output
      // shares the unified buffer's schema `R`.
      unified._pushTrustedEvents(existing.map((x) => x.event));
    }

    // Subscribe each factory output to the unified buffer for live
    // forwarding.
    for (const { out } of outputs) {
      const unsub = out.on('event', (event) => {
        unified._pushTrustedEvents([event]);
      });
      this.#disposers.add(unsub);
    }

    // Auto-spawn: when a new partition appears, run the factory
    // for it and subscribe its output. The new partition is empty
    // at spawn time (events are pushed AFTER spawn listeners fire),
    // so no historical replay is needed for the new partition's
    // factory output.
    this.#onSpawn.add((_, partition) => {
      const out = factory(partition as LiveSeries<S>);
      const unsub = out.on('event', (event) => {
        unified._pushTrustedEvents([event]);
      });
      this.#disposers.add(unsub);
    });

    return unified;
  }

  // ─── Chainable typed sugar (returns LivePartitionedView) ──────
  //
  // Each sugar method returns a `LivePartitionedView<NewSchema, K, ByCol>`
  // — a chained view that composes the operator factory with any
  // future chain steps. Use these when you want the full
  // operator chain at the type level:
  //
  //   live.partitionBy('host').fill(...).rolling(...).collect()
  //
  // For one-shot per-partition factories (no chain), use `apply()`
  // instead.

  /** Per-partition `fill`. See {@link LiveSeries.fill}. */
  fill(
    strategy: LiveFillStrategy | LiveFillMapping<S>,
    options?: { limit?: number },
  ): LivePartitionedView<S, S, K, ByCol> {
    return new LivePartitionedView<S, S, K, ByCol>(this, (sub) =>
      makeFillView(sub, strategy, options),
    );
  }

  /**
   * Per-partition stream sampling. Each partition gets its own
   * stride counter (closure-captured inside its `LiveView`). Safe
   * by construction: chaining after `partitionBy` thins each
   * partition's stream independently — no multi-entity bias.
   *
   * v0.17.0 ships **stride only** on the live side; see
   * {@link SampleStrategy} for why reservoir is deferred. The
   * buffer-as-window persona's typical shape:
   *
   * ```ts
   * live.partitionBy('host').sample({ stride: 10 }).rolling('5m', m);
   * ```
   *
   * Each host's stream is thinned 1-in-10 before flowing into a
   * per-host 5m rolling window — decoupling baseline length from
   * event rate.
   */
  sample(strategy: SampleStrategy): LivePartitionedView<S, S, K, ByCol> {
    return new LivePartitionedView<S, S, K, ByCol>(this, (sub) =>
      makeStrideSampleView<S>(sub, strategy.stride),
    );
  }

  /** Per-partition `diff`. See {@link LiveSeries.diff}. */
  diff<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LivePartitionedView<S, DiffSchema<S, Target>, K, ByCol> {
    return new LivePartitionedView<S, DiffSchema<S, Target>, K, ByCol>(
      this,
      (sub) =>
        makeDiffView(sub, 'diff', columns, options) as unknown as LiveSource<
          DiffSchema<S, Target>
        >,
    );
  }

  /** Per-partition `rate`. See {@link LiveSeries.rate}. */
  rate<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LivePartitionedView<S, DiffSchema<S, Target>, K, ByCol> {
    return new LivePartitionedView<S, DiffSchema<S, Target>, K, ByCol>(
      this,
      (sub) =>
        makeDiffView(sub, 'rate', columns, options) as unknown as LiveSource<
          DiffSchema<S, Target>
        >,
    );
  }

  /** Per-partition `pctChange`. See {@link LiveSeries.pctChange}. */
  pctChange<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LivePartitionedView<S, DiffSchema<S, Target>, K, ByCol> {
    return new LivePartitionedView<S, DiffSchema<S, Target>, K, ByCol>(
      this,
      (sub) =>
        makeDiffView(
          sub,
          'pctChange',
          columns,
          options,
        ) as unknown as LiveSource<DiffSchema<S, Target>>,
    );
  }

  /** Per-partition `cumulative`. See {@link LiveSeries.cumulative}. */
  cumulative<const Targets extends NumericColumnNameForSchema<S>>(spec: {
    [P in Targets]:
      | 'sum'
      | 'max'
      | 'min'
      | 'count'
      | ((acc: number, value: number) => number);
  }): LivePartitionedView<S, DiffSchema<S, Targets>, K, ByCol> {
    return new LivePartitionedView<S, DiffSchema<S, Targets>, K, ByCol>(
      this,
      (sub) =>
        makeCumulativeView(sub, spec) as unknown as LiveSource<
          DiffSchema<S, Targets>
        >,
    );
  }

  /**
   * Per-partition `rolling`. See {@link LiveSeries.rolling}.
   *
   * Two emission modes, chosen by the `trigger` option:
   *
   * **Default (no trigger / `Trigger.event()`):** per-partition
   * rolling — each partition has its own `LiveRollingAggregation`
   * emitting per source event. Returns a chainable
   * `LivePartitionedView`.
   *
   * In this mode the partition column **drops by default** —
   * `rolling`'s output schema only retains columns named in
   * `mapping`. Without including the partition column, the unified
   * output of the chain loses the partition tag (e.g. `host` becomes
   * `undefined`). To keep the partition column visible, include it
   * with a passthrough reducer:
   *
   * ```ts
   * partitioned.rolling('5m', { cpu: 'avg', host: 'last' })
   * //                                       ^^^^^^^^^^^^^^
   * ```
   *
   * **`Trigger.clock(seq)`:** synchronised partitioned rolling — all
   * partitions share one bucket index and emit together at each
   * boundary crossing. Returns a flat `LiveSource<RowSchema>` whose
   * schema is `[time, <partitionColumn>, ...mappingColumns]`.
   *
   * In this mode the partition column is **auto-injected** from the
   * routing key — do NOT include it in `mapping`. A collision
   * between the partition column name and any reducer-output column
   * is rejected at construction with a clear error.
   *
   * ```ts
   * partitioned.rolling(
   *   '5m',
   *   { cpu: 'avg' },                  // host is auto-injected
   *   { trigger: Trigger.every('200ms') },
   * );
   * ```
   */
  rolling<const M extends AggregateMap<S>>(
    window: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions & { trigger?: { kind: 'event' | 'count' } },
  ): LivePartitionedView<S, RollingSchema<S, M>, K, ByCol>;
  rolling<const M extends AggregateOutputMap<S>>(
    window: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions & { trigger?: { kind: 'event' | 'count' } },
  ): LivePartitionedView<S, RollingOutputMapSchema<S, M>, K, ByCol>;
  rolling<const M extends AggregateMap<S>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions & { trigger: { kind: 'clock' } & Trigger },
  ): LivePartitionedSyncRolling<S, K, SeriesSchema>;
  rolling<const M extends AggregateOutputMap<S>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions & { trigger: { kind: 'clock' } & Trigger },
  ): LivePartitionedSyncRolling<S, K, SeriesSchema>;
  // Catch-all overloads for callers that pass `options` as a variable
  // typed `LiveRollingOptions` (rather than an inline literal whose
  // `trigger` field TS can narrow). Without these the four narrowed
  // overloads above don't match — the trigger discriminator is unknown
  // at the call site, so the result is the union of both branches.
  rolling<const M extends AggregateMap<S>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions,
  ):
    | LivePartitionedView<S, RollingSchema<S, M>, K, ByCol>
    | LivePartitionedSyncRolling<S, K, SeriesSchema>;
  rolling<const M extends AggregateOutputMap<S>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions,
  ):
    | LivePartitionedView<S, RollingOutputMapSchema<S, M>, K, ByCol>
    | LivePartitionedSyncRolling<S, K, SeriesSchema>;
  /**
   * Keyed-form fused multi-window partitioned rolling. Maintains N
   * windows per partition in a single ingest pass over a single
   * shared deque per partition; emits one merged event per partition
   * per trigger boundary.
   *
   * **Clock trigger required.** The fused form on partitioned series
   * is synced-cross-partition by design — single trigger, single
   * boundary detection, single fan-out per boundary. Event/count
   * triggers don't make sense for cross-partition synced emission
   * and are not accepted.
   *
   * Output schema is `[time, <byColumn>, ...mergedColumns]` —
   * partition column auto-injected once at the front, never per-
   * window. Duplicate output column names across windows are
   * rejected at construction.
   *
   * See PLAN.md "Fused multi-window rolling" for the full design.
   */
  rolling<const FM extends FusedMapping<S>>(
    fusedMapping: FM & FusedMappingValid<FM>,
    options: LiveRollingOptions & { trigger: { kind: 'clock' } & Trigger },
  ): LivePartitionedFusedRolling<
    S,
    K,
    FusedPartitionedRollingSchema<S, ByCol, FM>
  >;
  rolling(
    arg1: RollingWindow | FusedMapping<S>,
    mappingOrOptions?:
      | AggregateMap<S>
      | AggregateOutputMap<S>
      | LiveRollingOptions,
    options?: LiveRollingOptions,
  ): any {
    // Detect the keyed-form fused-rolling shape: arg1 is a record
    // (not a string/number duration), mappingOrOptions is the
    // options. Single-trigger by design; clock trigger required.
    const isFused =
      typeof arg1 === 'object' && arg1 !== null && !Array.isArray(arg1);
    if (isFused) {
      const fusedMapping = arg1 as FusedMapping<S>;
      const fusedOptions = (mappingOrOptions ?? {}) as LiveRollingOptions;
      if (fusedOptions.trigger?.kind !== 'clock') {
        throw new TypeError(
          `LivePartitionedSeries.rolling: keyed-form fused rolling requires a ` +
            `clock trigger (e.g. \`{ trigger: Trigger.every('30s') }\`). ` +
            `Event/count triggers don't make sense for cross-partition synced ` +
            `emission.`,
        );
      }
      const syncOptions: {
        minSamples?: number;
        declaredGroups?: ReadonlyArray<K>;
        history?: LiveRollingOptions['history'] | undefined;
      } = {};
      if (fusedOptions.minSamples !== undefined)
        syncOptions.minSamples = fusedOptions.minSamples;
      if (this.groups !== undefined) syncOptions.declaredGroups = this.groups;
      // Forward `history` to the partitioned fused rolling — without
      // this, the option silently no-ops on partitioned sources
      // (Codex caught it on PR #124's adversarial review).
      if (fusedOptions.history !== undefined)
        syncOptions.history = fusedOptions.history;
      const byCol = this.schema.find((c) => c.name === this.by);
      if (!byCol) {
        throw new TypeError(
          `LivePartitionedSeries.rolling: column '${this.by}' not in source schema`,
        );
      }
      const fused = new LivePartitionedFusedRolling<S, K, SeriesSchema>(
        this.name,
        this.by,
        byCol.kind,
        this.schema,
        fusedMapping as FusedMapping<SeriesSchema>,
        fusedOptions.trigger,
        syncOptions,
      );
      this.#wireSyncRolling(
        fused,
        (partition) => partition,
        /* ownsFactoryOutput */ false,
      );
      return fused;
    }

    // Single-window legacy form: (window, mapping, options).
    const window = arg1 as RollingWindow;
    const mapping = mappingOrOptions as AggregateMap<S> | AggregateOutputMap<S>;

    // Clock trigger → synchronised partitioned emission. Returns a
    // LiveSource<RowSchema> directly (no LivePartitionedView wrap)
    // because the output is already a flat per-partition-row stream;
    // each tick fires N events (one per known partition) at the same
    // boundary timestamp.
    if (options?.trigger?.kind === 'clock') {
      const syncOptions: {
        minSamples?: number;
        declaredGroups?: ReadonlyArray<K>;
        history?: LiveRollingOptions['history'] | undefined;
      } = {};
      if (options.minSamples !== undefined)
        syncOptions.minSamples = options.minSamples;
      if (this.groups !== undefined) syncOptions.declaredGroups = this.groups;
      if (options.history !== undefined) syncOptions.history = options.history;
      // Look up the partition column's kind from the source schema —
      // it stays the same across both root and chained cases and is
      // used only for the output schema's byColumn entry.
      const byCol = this.schema.find((c) => c.name === this.by);
      if (!byCol) {
        throw new TypeError(
          `LivePartitionedSeries.rolling: column '${this.by}' not in source schema`,
        );
      }
      const sync = new LivePartitionedSyncRolling<S, K, SeriesSchema>(
        this.name,
        this.by,
        byCol.kind,
        this.schema,
        window,
        mapping as AggregateMap<SeriesSchema>,
        options.trigger,
        syncOptions,
      );
      // Wire the sync rolling: subscribe to each partition's raw
      // events. Root case — factory is identity (the partition IS the
      // event source). Pass ownsFactoryOutput: false because the
      // partition LiveSeries is owned by this series, not by the
      // sync rolling — disposing the sync must NOT tear down the
      // partition itself.
      this.#wireSyncRolling(
        sync,
        (partition) => partition,
        /* ownsFactoryOutput */ false,
      );
      return sync;
    }

    // Default: per-partition rolling with per-partition emission.
    return new LivePartitionedView<S, SeriesSchema, K, ByCol>(
      this,
      (sub) =>
        new LiveRollingAggregation(
          sub,
          window,
          mapping,
          options,
        ) as unknown as LiveSource<SeriesSchema>,
    );
  }

  /**
   * Dispose of the partitioned view: unsubscribe from the source,
   * disconnect every per-partition pipeline subscriber (created
   * by `collect()` and `apply()`), and drop spawn listeners. Safe
   * to call multiple times.
   *
   * **Note:** this does not clear the per-partition `LiveSeries`
   * sub-buffers themselves. Their event arrays linger until the
   * `LivePartitionedSeries` instance becomes unreferenced and is
   * garbage-collected. If you want to free the sub-buffer memory
   * eagerly, drop your reference to the `LivePartitionedSeries`
   * after `dispose()`.
   */
  dispose(): void {
    this.#unsubscribeSource();
    for (const dispose of this.#disposers) dispose();
    this.#disposers.clear();
    this.#onSpawn.clear();
  }

  /**
   * @internal — register a cleanup callback to be fired when this
   * root partitioned series is disposed. Used by
   * `LivePartitionedView.toMap()` to track factory-output
   * subscriptions that would otherwise leak across repeated calls.
   */
  _addDisposer(fn: () => void): void {
    this.#disposers.add(fn);
  }

  // ─── Internal ─────────────────────────────────────────────────

  /**
   * Wire a `LivePartitionedSyncRolling` into this partitioned series.
   *
   * Used by both the root case (`partitionBy(c).rolling(..., trigger)`,
   * factory is identity) and the chained-view case
   * (`partitionBy(c).fill(...).rolling(..., trigger)`, factory is the
   * chain's compose function), so the cross-partition replay,
   * subscription, and spawn-listener cleanup logic lives in one place.
   *
   * - Calls `factory(partition)` once per existing partition to
   *   produce a per-partition event source. For the root case, this
   *   is the partition's own `LiveSeries`; for the chained case, it's
   *   the post-chain `LiveSource<R>`.
   * - Replays each event source's existing events into `sync.ingest`
   *   in **global timestamp order across partitions** so the shared
   *   bucket index advances monotonically. (Per-partition order alone
   *   would let a later-iterated partition's earlier events silently
   *   no-op as `bucketIdx <= lastBucketIdx`.)
   * - Subscribes `sync.ingest` to each event source's `'event'`
   *   stream for future events.
   * - Adds a spawn listener to the parent so newly-spawned partitions
   *   get their factory invoked + sync subscribed automatically.
   * - All disposers are registered with BOTH `sync` (so
   *   `sync.dispose()` detaches them) and the parent's `#disposers`
   *   (so the parent's dispose path also detaches them). Idempotent
   *   in either order.
   *
   * **Factory-output ownership.** When `ownsFactoryOutput` is true
   * (chained-view case — factory creates a LiveView / Rolling /
   * Aggregation that itself subscribes upstream), we ALSO register
   * `out.dispose()` so the chain output's upstream subscription
   * tears down. Without this, disposing the sync rolling only
   * removes our listener; the chain view keeps processing
   * partition events into its own buffer indefinitely (real leak,
   * surfaces under repeated create/dispose cycles or high-cardinality
   * partitions). The root case (`ownsFactoryOutput: false`) skips
   * dispose because the partition LiveSeries is owned by the parent
   * series, not by the sync rolling.
   */
  #wireSyncRolling<R extends SeriesSchema>(
    sync: SyncRollingIngestTarget<R, K>,
    factory: (partition: LiveSeries<S>) => LiveSource<R>,
    ownsFactoryOutput: boolean,
  ): void {
    // Build per-partition factory outputs once. Reused for both
    // replay (existing events) and subscription (future events) so
    // we don't run the factory twice on the same partition.
    const factoryOutputs = new Map<K, LiveSource<R>>();
    for (const [key, partition] of this.#partitions) {
      factoryOutputs.set(key, factory(partition));
    }

    // Cross-partition timestamp-ordered replay of existing events.
    type Existing = { ts: number; key: K; event: EventForSchema<R> };
    const existing: Existing[] = [];
    for (const [key, out] of factoryOutputs) {
      for (let i = 0; i < out.length; i++) {
        const ev = out.at(i)!;
        existing.push({ ts: ev.begin(), key, event: ev });
      }
    }
    existing.sort((a, b) => a.ts - b.ts);
    for (const { key, event } of existing) {
      sync.ingest(key, event);
    }

    // Subscribe to each existing factory output's future events.
    // If we own the output, also register its dispose() so the
    // chain's upstream subscription tears down on cleanup.
    const wireOutput = (out: LiveSource<R>, key: K): void => {
      const unsub = out.on('event', (event) => sync.ingest(key, event));
      const cleanup = ownsFactoryOutput
        ? () => {
            unsub();
            // Duck-typed: chain outputs (LiveView, LiveRolling-
            // Aggregation, LiveAggregation) all expose `dispose()`;
            // a defensive `?.` covers any future LiveSource impl
            // that doesn't.
            (out as LiveSource<R> & { dispose?: () => void }).dispose?.();
          }
        : unsub;
      sync._registerUnsubscribe(cleanup);
      this.#disposers.add(cleanup);
    };
    for (const [key, out] of factoryOutputs) {
      wireOutput(out, key);
    }

    // Future spawns: invoke factory on each new partition and
    // subscribe sync to its output. Newly-spawned partitions have no
    // existing events, so no replay is needed for them.
    const onSpawnSet = this.#onSpawn;
    const spawnHandler: SpawnListener<S, K> = (key, partition) => {
      // The SpawnListener signature uses LiveSource<S> for back-
      // compatibility with collect/apply, but #spawnPartition always
      // creates a LiveSeries<S> — safe to narrow here.
      wireOutput(factory(partition as LiveSeries<S>), key);
    };
    onSpawnSet.add(spawnHandler);
    // Register the spawn-handler removal with sync.dispose() so the
    // parent doesn't retain the disposed sync via this closure
    // (would otherwise leak across create/dispose cycles).
    sync._registerUnsubscribe(() => onSpawnSet.delete(spawnHandler));
  }

  /**
   * @internal — used by `LivePartitionedView.rolling`'s clock-trigger
   * branch to wire a sync rolling whose reducer-input schema is the
   * chain output `R` rather than the source schema `S`. The view
   * passes its composed factory; this method delegates to
   * `#wireSyncRolling` with `ownsFactoryOutput: true` because the
   * chain output (a LiveView / LiveRollingAggregation / etc.) has
   * its own upstream subscription that must be torn down on dispose.
   */
  _wireSyncRollingFromView<R extends SeriesSchema>(
    sync: SyncRollingIngestTarget<R, K>,
    factory: (partition: LiveSeries<S>) => LiveSource<R>,
  ): void {
    this.#wireSyncRolling(sync, factory, /* ownsFactoryOutput */ true);
  }

  #spawnPartition(key: K): LiveSeries<S> {
    const opts: LiveSeriesOptions<S> = {
      name: `${this.name}/${String(key)}`,
      schema: this.schema,
      // Partition sub-series are fed per-event via `_pushTrustedEvents`
      // by `#routeEvent`, so they use the Event[] backing. They're not
      // the OOM driver; chunking them is deferred to columnar routing
      // (`scatterByPartition`) — see the column-native-live-pipeline brief.
      __backing: 'array',
    };
    if (this.#partitionOptions.ordering !== undefined)
      opts.ordering = this.#partitionOptions.ordering;
    if (this.#partitionOptions.graceWindow !== undefined)
      opts.graceWindow = this.#partitionOptions.graceWindow;
    if (this.#partitionOptions.retention !== undefined)
      opts.retention = this.#partitionOptions.retention;

    const part = new LiveSeries<S>(opts);
    this.#partitions.set(key, part);
    for (const fn of this.#onSpawn) fn(key, part);
    return part;
  }

  #routeEvent(event: EventForSchema<S>): void {
    const key = partitionKey(event, this.by) as K;
    let part = this.#partitions.get(key);
    if (!part) {
      if (this.groups && !this.groups.includes(key)) {
        throw new TypeError(
          `LivePartitionedSeries: encountered partition value ${JSON.stringify(
            key === ' undefined' ? undefined : key,
          )} for column "${String(this.by)}" which is not in declared groups ` +
            `[${this.groups.map((g) => JSON.stringify(g)).join(', ')}].`,
        );
      }
      part = this.#spawnPartition(key);
    }
    this.#statsEventsRouted++;
    // Trusted-pipeline fast path: the source LiveSeries already
    // constructed and validated this Event against `S`, and partition
    // sub-series share the same schema. Pass the reference through
    // instead of round-tripping `Event → row → Event` (which would
    // re-validate and re-allocate per event).
    part._pushTrustedEvents([event]);
  }

  /**
   * Pipeline stats snapshot — current partition count plus
   * cumulative routing counter. Cheap O(1).
   *
   * - `partitions`: current number of partitions (declared groups
   *   plus auto-spawned ones). With `{ groups }`, equal to
   *   `groups.length` once any of those values appear; without it,
   *   grows on each new partition value.
   * - `eventsRouted`: total source events successfully routed to
   *   a partition. Events that throw (unknown partition value
   *   under typed-groups) are counted only if they reach
   *   {@link LivePartitionedSeries.#routeEvent} successfully —
   *   they don't.
   *
   * Note: per-partition counters (per-partition `eventsRouted`,
   * per-partition retention state, etc.) are intentionally NOT
   * exposed by this method. Use `toMap()` and call
   * {@link LiveSeries.stats} on each partition's sub-buffer for
   * per-partition observability — that scales O(partitions) only
   * when you actually need it.
   */
  stats(): { partitions: number; eventsRouted: number } {
    return {
      partitions: this.#partitions.size,
      eventsRouted: this.#statsEventsRouted,
    };
  }
}

/**
 * Chained typed view over a {@link LivePartitionedSeries}. Returned
 * by every sugar method on the root partitioned series and on this
 * view, composing the operator factory at each step.
 *
 * The view is **lazy**: factories aren't run until a terminal
 * (`collect()`, `apply()`, `toMap()`) is called. Each terminal
 * delegates back to the root's per-partition state, applying the
 * composed factory chain to each partition's `LiveSeries`.
 *
 * **Lifecycle.** All real state lives on the root
 * `LivePartitionedSeries` — chained views are just deferred
 * factories that point back at the root. They don't register their
 * own subscriptions on the source. Disposing the root disposes
 * everything: terminals subscribed to factory outputs are tracked
 * on the root's internal disposers, including outputs created by
 * `view.toMap()`.
 *
 * @example
 * ```ts
 * const cpuSmoothed = live
 *   .partitionBy('host')
 *   .fill({ cpu: 'hold' })       // → LivePartitionedView<S, S, K, ByCol>
 *   .rolling('1m', { cpu: 'avg' }) // → LivePartitionedView<S, R, K, ByCol>
 *   .collect();                    // → LiveSeries<R>
 * ```
 *
 * @typeParam SBase - schema of the root partitioned series's
 *   per-partition `LiveSeries` (kept so the composed factory's
 *   input type is correct).
 * @typeParam R - schema of the current chained output.
 * @typeParam K - partition key type.
 * @typeParam ByCol - partition column name (literal). Threaded
 *   through from the root `LivePartitionedSeries` so chained-rolling
 *   typing chains (e.g. `partitionBy('host').fill(...).rolling({...})`)
 *   resolve `FusedPartitionedRollingSchema<R, ByCol, FM>` correctly.
 */
export class LivePartitionedView<
  SBase extends SeriesSchema,
  R extends SeriesSchema,
  K extends string = string,
  ByCol extends keyof EventDataForSchema<SBase> & string =
    keyof EventDataForSchema<SBase> & string,
> {
  readonly #root: LivePartitionedSeries<SBase, K, ByCol>;
  readonly #factory: (sub: LiveSeries<SBase>) => LiveSource<R>;

  /**
   * Schema of the chained output. Captured by running the factory
   * once on a stub `LiveSeries<SBase>` at construction.
   */
  readonly schema: R;

  /** @internal — used by sugar methods to chain. */
  constructor(
    root: LivePartitionedSeries<SBase, K, ByCol>,
    factory: (sub: LiveSeries<SBase>) => LiveSource<R>,
  ) {
    this.#root = root;
    this.#factory = factory;
    // Capture output schema upfront via a stub invocation. The stub
    // is never connected — same pattern as
    // {@link LivePartitionedSeries.apply}.
    const stub = new LiveSeries<SBase>({
      name: `${root.name}/_stub`,
      schema: root.schema,
      __backing: 'array',
    });
    const stubOut = factory(stub);
    this.schema = stubOut.schema;
  }

  /** Same as {@link LivePartitionedSeries.collect}, applied through the factory chain. */
  collect(options?: Partial<LiveSeriesOptions<R>>): LiveSeries<R> {
    return this.#root.apply(this.#factory, options);
  }

  /**
   * Apply a further per-partition transform on top of the existing
   * factory chain. Equivalent to chaining one more sugar method
   * via a custom function. Returns a unified `LiveSeries<R2>`.
   */
  apply<R2 extends SeriesSchema>(
    factory: (sub: LiveSource<R>) => LiveSource<R2>,
    options?: Partial<LiveSeriesOptions<R2>>,
  ): LiveSeries<R2> {
    const composed = this.#factory;
    return this.#root.apply(
      (sub) => factory(composed(sub)) as unknown as LiveSource<R2>,
      options,
    );
  }

  /**
   * Materialize the chained view per-partition as a
   * `Map<K, LiveSource<R>>`. Runs the composed factory once per
   * existing partition; auto-spawn from the root partitioned
   * series is *not* propagated into this map (the snapshot
   * reflects partitions at the time of the call).
   *
   * Each factory output (a `LiveView` / `LiveRollingAggregation` /
   * etc.) holds an internal subscription to its source. To avoid
   * accumulating listeners across repeated calls, every factory
   * output's `dispose()` is registered on the root's disposer set
   * — calling `partitioned.dispose()` on the root cleans up every
   * `toMap`-created subscription chain.
   *
   * For a live-updating per-partition view, subscribe to the root
   * `partitionBy` directly with `toMap()` and call the factory
   * yourself, or use `collect()` for a unified buffer.
   */
  toMap(): Map<K, LiveSource<R>> {
    const result = new Map<K, LiveSource<R>>();
    const partitions = this.#root.toMap();
    for (const [key, sub] of partitions) {
      const out = this.#factory(sub as LiveSeries<SBase>);
      result.set(key, out);
      // Register the factory output's dispose so root.dispose()
      // tears down the subscription chain. Without this, repeated
      // toMap() calls accumulate listeners on the partition
      // LiveSeries that nothing else references but never get
      // collected because the partition's listener Set holds them.
      const outWithDispose = out as { dispose?: () => void };
      if (typeof outWithDispose.dispose === 'function') {
        this.#root._addDisposer(() => outWithDispose.dispose!());
      }
    }
    return result;
  }

  // ─── Chainable sugar (composes the factory) ──────────────────

  fill(
    strategy: LiveFillStrategy | LiveFillMapping<R>,
    options?: { limit?: number },
  ): LivePartitionedView<SBase, R, K, ByCol> {
    const prev = this.#factory;
    return new LivePartitionedView<SBase, R, K, ByCol>(this.#root, (sub) =>
      makeFillView(prev(sub), strategy, options),
    );
  }

  /**
   * Per-partition stream sampling on a chained view. Same semantics
   * as {@link LivePartitionedSeries.sample} — stride only, safe by
   * construction (no multi-entity bias); each partition's chain
   * output is thinned independently with its own counter.
   */
  sample(strategy: SampleStrategy): LivePartitionedView<SBase, R, K, ByCol> {
    const prev = this.#factory;
    return new LivePartitionedView<SBase, R, K, ByCol>(this.#root, (sub) =>
      makeStrideSampleView<R>(prev(sub), strategy.stride),
    );
  }

  diff<const Target extends NumericColumnNameForSchema<R>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LivePartitionedView<SBase, DiffSchema<R, Target>, K, ByCol> {
    const prev = this.#factory;
    return new LivePartitionedView<SBase, DiffSchema<R, Target>, K, ByCol>(
      this.#root,
      (sub) =>
        makeDiffView(
          prev(sub),
          'diff',
          columns,
          options,
        ) as unknown as LiveSource<DiffSchema<R, Target>>,
    );
  }

  rate<const Target extends NumericColumnNameForSchema<R>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LivePartitionedView<SBase, DiffSchema<R, Target>, K, ByCol> {
    const prev = this.#factory;
    return new LivePartitionedView<SBase, DiffSchema<R, Target>, K, ByCol>(
      this.#root,
      (sub) =>
        makeDiffView(
          prev(sub),
          'rate',
          columns,
          options,
        ) as unknown as LiveSource<DiffSchema<R, Target>>,
    );
  }

  pctChange<const Target extends NumericColumnNameForSchema<R>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): LivePartitionedView<SBase, DiffSchema<R, Target>, K, ByCol> {
    const prev = this.#factory;
    return new LivePartitionedView<SBase, DiffSchema<R, Target>, K, ByCol>(
      this.#root,
      (sub) =>
        makeDiffView(
          prev(sub),
          'pctChange',
          columns,
          options,
        ) as unknown as LiveSource<DiffSchema<R, Target>>,
    );
  }

  cumulative<const Targets extends NumericColumnNameForSchema<R>>(spec: {
    [P in Targets]:
      | 'sum'
      | 'max'
      | 'min'
      | 'count'
      | ((acc: number, value: number) => number);
  }): LivePartitionedView<SBase, DiffSchema<R, Targets>, K, ByCol> {
    const prev = this.#factory;
    return new LivePartitionedView<SBase, DiffSchema<R, Targets>, K, ByCol>(
      this.#root,
      (sub) =>
        makeCumulativeView(prev(sub), spec) as unknown as LiveSource<
          DiffSchema<R, Targets>
        >,
    );
  }

  /**
   * **Partition column drops by default.** `rolling`'s output
   * schema only retains columns named in `mapping`. Include the
   * partition column with a passthrough reducer (e.g.
   * `host: 'last'`) to keep it visible in the unified output.
   */
  rolling<const M extends AggregateMap<R>>(
    window: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions & { trigger?: { kind: 'event' | 'count' } },
  ): LivePartitionedView<SBase, RollingSchema<R, M>, K, ByCol>;
  rolling<const M extends AggregateOutputMap<R>>(
    window: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions & { trigger?: { kind: 'event' | 'count' } },
  ): LivePartitionedView<SBase, RollingOutputMapSchema<R, M>, K, ByCol>;
  rolling<const M extends AggregateMap<R>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions & { trigger: { kind: 'clock' } & Trigger },
  ): LivePartitionedSyncRolling<R, K, SeriesSchema>;
  rolling<const M extends AggregateOutputMap<R>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions & { trigger: { kind: 'clock' } & Trigger },
  ): LivePartitionedSyncRolling<R, K, SeriesSchema>;
  // Catch-all overloads for callers that pass `options` as a variable
  // typed `LiveRollingOptions`. See the matching block on
  // `LivePartitionedSeries.rolling` for the full rationale.
  rolling<const M extends AggregateMap<R>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions,
  ):
    | LivePartitionedView<SBase, RollingSchema<R, M>, K, ByCol>
    | LivePartitionedSyncRolling<R, K, SeriesSchema>;
  rolling<const M extends AggregateOutputMap<R>>(
    window: RollingWindow,
    mapping: M,
    options: LiveRollingOptions,
  ):
    | LivePartitionedView<SBase, RollingOutputMapSchema<R, M>, K, ByCol>
    | LivePartitionedSyncRolling<R, K, SeriesSchema>;
  /**
   * Keyed-form fused multi-window rolling on a chained
   * `LivePartitionedView`. Same shape as the root variant — each
   * partition's chain output flows into one fused rolling that
   * maintains N windows in one ingest pass and emits one merged
   * event per partition per boundary.
   *
   * Clock trigger required (same constraint as the root partitioned
   * fused — synced cross-partition emission).
   */
  rolling<const FM extends FusedMapping<R>>(
    fusedMapping: FM & FusedMappingValid<FM>,
    options: LiveRollingOptions & { trigger: { kind: 'clock' } & Trigger },
  ): LivePartitionedFusedRolling<
    R,
    K,
    FusedPartitionedRollingSchema<R, ByCol, FM>
  >;
  rolling(
    arg1: RollingWindow | FusedMapping<R>,
    mappingOrOptions?:
      | AggregateMap<R>
      | AggregateOutputMap<R>
      | LiveRollingOptions,
    options?: LiveRollingOptions,
  ): any {
    // Detect the keyed-form fused-rolling shape: arg1 is a record,
    // mappingOrOptions is the options. Same dispatch as the root.
    const isFused =
      typeof arg1 === 'object' && arg1 !== null && !Array.isArray(arg1);
    if (isFused) {
      const root = this.#root;
      const fusedMapping = arg1 as FusedMapping<R>;
      const fusedOptions = (mappingOrOptions ?? {}) as LiveRollingOptions;
      if (fusedOptions.trigger?.kind !== 'clock') {
        throw new TypeError(
          `LivePartitionedView.rolling: keyed-form fused rolling requires a ` +
            `clock trigger (e.g. \`{ trigger: Trigger.every('30s') }\`). ` +
            `Event/count triggers don't make sense for cross-partition synced ` +
            `emission.`,
        );
      }
      const byCol = root.schema.find((c) => c.name === root.by);
      if (!byCol) {
        throw new TypeError(
          `LivePartitionedView.rolling: column '${root.by}' not in source schema`,
        );
      }
      const syncOptions: {
        minSamples?: number;
        declaredGroups?: ReadonlyArray<K>;
        history?: LiveRollingOptions['history'] | undefined;
      } = {};
      if (fusedOptions.minSamples !== undefined)
        syncOptions.minSamples = fusedOptions.minSamples;
      if (root.groups !== undefined) syncOptions.declaredGroups = root.groups;
      if (fusedOptions.history !== undefined)
        syncOptions.history = fusedOptions.history;

      const fused = new LivePartitionedFusedRolling<R, K, SeriesSchema>(
        root.name,
        root.by,
        byCol.kind,
        this.schema,
        fusedMapping as FusedMapping<SeriesSchema>,
        fusedOptions.trigger,
        syncOptions,
      );
      const chainFactory = this.#factory;
      root._wireSyncRollingFromView(fused, chainFactory);
      return fused;
    }

    // Single-window legacy form: (window, mapping, options).
    const window = arg1 as RollingWindow;
    const mapping = mappingOrOptions as AggregateMap<R> | AggregateOutputMap<R>;

    // Clock trigger → synchronised partitioned emission on the chain
    // output. The chain factory runs once per partition; the sync
    // rolling subscribes to each chain output's events (so reducers
    // operate on `R`, not the raw source `S`). Output rows still tag
    // each event with the partition key from the routing layer, so
    // even chains that drop the partition column (e.g. `.select()`
    // without retaining it) emit correctly.
    if (options?.trigger?.kind === 'clock') {
      const root = this.#root;
      const byCol = root.schema.find((c) => c.name === root.by);
      if (!byCol) {
        throw new TypeError(
          `LivePartitionedView.rolling: column '${root.by}' not in source schema`,
        );
      }

      const syncOptions: {
        minSamples?: number;
        declaredGroups?: ReadonlyArray<K>;
        history?: LiveRollingOptions['history'] | undefined;
      } = {};
      if (options.minSamples !== undefined)
        syncOptions.minSamples = options.minSamples;
      if (root.groups !== undefined) syncOptions.declaredGroups = root.groups;
      if (options.history !== undefined) syncOptions.history = options.history;

      // The reducer-input schema is the chain output schema `R`,
      // captured upfront on this view (via the factory-stub run in
      // the constructor).
      const sync = new LivePartitionedSyncRolling<R, K, SeriesSchema>(
        root.name,
        root.by,
        byCol.kind,
        this.schema,
        window,
        mapping as AggregateMap<SeriesSchema>,
        options.trigger,
        syncOptions,
      );

      // Wire via the root's helper, but pass the composed chain
      // factory (so each partition's events flow through the chain
      // before reaching the sync rolling).
      const chainFactory = this.#factory;
      root._wireSyncRollingFromView(sync, chainFactory);
      return sync;
    }

    const prev = this.#factory;
    return new LivePartitionedView<SBase, SeriesSchema, K, ByCol>(
      this.#root,
      (sub) =>
        new LiveRollingAggregation(
          prev(sub),
          window,
          mapping,
          options,
        ) as unknown as LiveSource<SeriesSchema>,
    );
  }
}
