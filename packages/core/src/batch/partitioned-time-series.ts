import { TimeSeries } from './time-series.js';
import { BoundedSequence } from '../sequence/bounded-sequence.js';
import { Sequence } from '../sequence/sequence.js';
import type { DurationInput } from '../core/duration.js';
import type { TemporalLike } from '../core/temporal.js';
import type { BatchSampleStrategy } from '../sequence/sample.js';
import type {
  AggregateMap,
  AggregateOutputMap,
  AggregateSchema,
  AlignSchema,
  BaselineSchema,
  DedupeKeep,
  DiffSchema,
  EventDataForSchema,
  EventForSchema,
  FillMapping,
  FillStrategy,
  MaterializeSchema,
  NumericColumnNameForSchema,
  RollingAlignment,
  RollingSchema,
  SeriesSchema,
  SmoothAppendSchema,
  SmoothMethod,
  SmoothSchema,
} from '../types.js';
import type {
  AggregateOutputMapResultSchema,
  RollingOutputMapSchema,
} from '../types-aggregate.js';

type SequenceLike = Sequence | BoundedSequence;
type AlignMethod = 'hold' | 'linear';
type AlignSample = 'begin' | 'center' | 'end';

/**
 * View over a `TimeSeries` that scopes stateful transforms to within
 * each partition. Created by `TimeSeries.partitionBy(by)`.
 *
 * Most pond-ts stateful operators read from neighboring events when
 * computing each output. On a multi-entity series (events for many
 * hosts interleaved by time), those neighbors silently cross entity
 * boundaries: a `fill('linear')` for `host-A` would interpolate using
 * `host-B`'s value as a "neighbor"; a `rolling('5m', { cpu: 'avg' })`
 * would average across all hosts in the window.
 *
 * `partitionBy` runs the transform independently on each partition's
 * events. The view is **persistent across chains** — each sugar method
 * returns another `PartitionedTimeSeries` carrying the same partition
 * columns, so multi-step per-partition workflows compose cleanly:
 *
 * ```ts
 * const cleaned = ts
 *   .partitionBy('host')
 *   .dedupe({ keep: 'last' })   // per-host
 *   .fill({ cpu: 'linear' })    // per-host
 *   .rolling('5m', { cpu: 'avg' })  // per-host
 *   .collect();                 // back to TimeSeries<S>
 * ```
 *
 * Call `.collect()` (or `.apply(fn)` for arbitrary transforms) to
 * materialize back to a regular `TimeSeries`. Without `.collect()`,
 * the chain stays in partition view.
 *
 * @example
 * ```ts
 * // Per-host fill
 * const filled = series.partitionBy('host').fill({ cpu: 'linear' }).collect();
 *
 * // Composite partitioning by host + region
 * const filled = series.partitionBy(['host', 'region']).fill({ cpu: 'linear' }).collect();
 *
 * // Arbitrary transform via apply (terminal — returns TimeSeries directly)
 * const custom = series.partitionBy('host').apply(g =>
 *   g.fill({ cpu: 'linear' }).rolling('5m', { cpu: 'avg' }),
 * );
 * ```
 */
export class PartitionedTimeSeries<
  S extends SeriesSchema,
  K extends string = string,
> {
  readonly source: TimeSeries<S>;
  readonly by: ReadonlyArray<keyof EventDataForSchema<S> & string>;
  /**
   * Declared partition values when `partitionBy(col, { groups })` was
   * used. When set, `toMap` iterates in declared order (not insertion
   * order), empty declared groups still appear as empty `TimeSeries`
   * entries, and unknown partition values throw at construction time.
   */
  readonly groups?: ReadonlyArray<K>;

  constructor(
    source: TimeSeries<S>,
    by:
      | (keyof EventDataForSchema<S> & string)
      | ReadonlyArray<keyof EventDataForSchema<S> & string>,
    options?: { groups?: ReadonlyArray<K> },
  ) {
    this.source = source;
    this.by = (Array.isArray(by) ? by : [by]) as ReadonlyArray<
      keyof EventDataForSchema<S> & string
    >;
    if (this.by.length === 0) {
      throw new TypeError(
        'PartitionedTimeSeries requires at least one partition column.',
      );
    }
    for (const col of this.by) {
      if (!source.schema.some((c) => c.name === col)) {
        throw new TypeError(
          `PartitionedTimeSeries: column "${String(col)}" not in schema`,
        );
      }
    }
    if (options?.groups !== undefined) {
      if (this.by.length > 1) {
        throw new TypeError(
          'PartitionedTimeSeries: typed `groups` option requires a single ' +
            'partition column. Drop `groups` for composite partitions, or ' +
            'narrow to a single column.',
        );
      }
      if (options.groups.length === 0) {
        throw new TypeError(
          'PartitionedTimeSeries: `groups` cannot be empty. Drop the ' +
            'option to allow any partition value, or list at least one ' +
            'declared group.',
        );
      }
      const seen = new Set<string>();
      for (const g of options.groups) {
        if (seen.has(g)) {
          throw new TypeError(
            `PartitionedTimeSeries: duplicate value ${JSON.stringify(g)} ` +
              `in \`groups\`. Each declared group must be unique.`,
          );
        }
        seen.add(g);
      }
      this.groups = options.groups;
      this.validateGroupMembership();
    }
  }

  // Validate that every event's partition value appears in the
  // declared groups. Mirrors the partition encoder so the comparison
  // accepts the same string forms toMap will produce as keys.
  private validateGroupMembership(): void {
    if (!this.groups) return;
    const col = this.by[0]!;
    const declared = new Set<string>(this.groups);
    const keyOf = PartitionedTimeSeries.partitionKeyOf<S>(this.by);
    for (const event of this.source.events) {
      const key = keyOf(event);
      if (!declared.has(key)) {
        // Decode the encoder's leading-space sentinel so the message
        // shows the user-facing concept, not the internal encoding.
        const display =
          key === ' undefined' ? 'undefined' : JSON.stringify(key);
        throw new TypeError(
          `PartitionedTimeSeries: encountered partition value ${display} ` +
            `for column "${String(col)}" which is not in declared groups ` +
            `[${this.groups.map((g) => JSON.stringify(g)).join(', ')}].`,
        );
      }
    }
  }

  /**
   * Augment a per-partition aggregate / rolling mapping with `'first'`
   * reducers for any partition column not already present as a key.
   * Required because the rewrap step at the end of partitioned
   * `aggregate(...)` / `rolling(...)` re-validates that every column
   * in `this.by` exists in the per-partition output schema. Without
   * the partition column carried through, rewrap throws
   * `column "<col>" not in schema` at runtime — surfaced by gRPC
   * experiment M3.5 friction note "Per-partition aggregate must
   * re-declare the partition column".
   *
   * `'first'` is by-construction-correct: every row in a single
   * partition has the same value for the partition column (that's
   * the partitioning invariant), so any reducer that picks one of
   * those values is right. `'first'` is the cheapest choice.
   *
   * No-op when every partition column is already a key in the user's
   * mapping — they've explicitly opted in to mapping the column,
   * possibly under an alias, and we leave their choice intact.
   * (Aliasing the column away — `{ host_id: { from: 'host', using:
   * 'first' } }` — still triggers auto-inject for `host` since the
   * alias key is `host_id`, not `host`. The output then carries both
   * `host` and `host_id`.)
   */
  private augmentMappingWithPartitionCols<M>(mapping: M): M {
    const userKeys = new Set(Object.keys(mapping as object));
    const missing = this.by.filter((col) => !userKeys.has(col));
    if (missing.length === 0) return mapping;
    const augmented = { ...(mapping as object) } as Record<string, unknown>;
    for (const col of missing) {
      // `{ from, using }` (AggregateOutputMap form) is accepted in
      // any mapping shape — `normalizeAggregateColumns` handles
      // entries per-key, so mixing AggregateMap and AggregateOutputMap
      // entries within one mapping object works at runtime.
      augmented[col] = { from: col, using: 'first' };
    }
    return augmented as M;
  }

  // Class-private factory used by `rewrap` to construct a
  // partitioned view from a per-partition transform output. Skips
  // groups validation because the events came from this view's
  // pre-validated source — partition values cannot change inside a
  // per-partition transform. JS-private (`static #fromValidated`) so
  // the trusted path is unreachable from outside the class.
  static #fromValidated<SX extends SeriesSchema, KX extends string>(
    source: TimeSeries<SX>,
    by: ReadonlyArray<keyof EventDataForSchema<SX> & string>,
    groups: ReadonlyArray<KX> | undefined,
  ): PartitionedTimeSeries<SX, KX> {
    const p = new PartitionedTimeSeries<SX, KX>(source, by);
    if (groups !== undefined) {
      // groups was already validated when the user constructed the
      // upstream view; partition values are preserved through any
      // per-partition transform.
      (p as { groups?: ReadonlyArray<KX> }).groups = groups;
    }
    return p;
  }

  /**
   * Materialize the partitioned view back into a regular `TimeSeries`.
   * Terminal operation — call this at the end of a chain to "collect"
   * the per-partition results. Equivalent to `.apply(g => g)` but
   * cheaper (no fn dispatch, just returns the source as-is).
   *
   * @example
   * ```ts
   * const cleaned = ts
   *   .partitionBy('host')
   *   .fill({ cpu: 'linear' })
   *   .rolling('5m', { cpu: 'avg' })
   *   .collect();  // <- TimeSeries<S>
   * ```
   */
  collect(): TimeSeries<S> {
    return this.source;
  }

  /**
   * Run a transform `fn` independently on each partition and return a
   * `TimeSeries<R>` directly (terminal — does not stay in the
   * partitioned view). The escape hatch for compositions or operators
   * not exposed as sugar.
   *
   * To keep the partition after a custom transform, use the sugar
   * methods (which preserve partition state) or call `.partitionBy(...)`
   * again on the result.
   *
   * @example
   * ```ts
   * // chain two stateful ops within each partition (one shot)
   * const out = series.partitionBy('host').apply(g =>
   *   g.fill({ cpu: 'linear' }).rolling('5m', { cpu: 'avg' }),
   * );
   * ```
   */
  apply<R extends SeriesSchema>(
    fn: (group: TimeSeries<S>) => TimeSeries<R>,
  ): TimeSeries<R> {
    return PartitionedTimeSeries.applyToSource(this.source, this.by, fn);
  }

  /**
   * Materialize the partitioned view as a `Map<key, TimeSeries<S>>`,
   * one entry per partition. Terminal — exits the partition view.
   *
   * Use this when downstream code needs to iterate or look up per
   * partition (typical in dashboards: one chart line per host, one
   * tooltip per region). Without this, the equivalent dance was
   * `.collect().groupBy(col, fn)` — two operators where one would do.
   *
   * The map key is the stringified partition value for single-column
   * partitions, or a `JSON.stringify`'d array of values for composite
   * partitions. The single-column form preserves the value's natural
   * string representation (a `host` column with values `'api-1'`
   * yields keys `'api-1'`); composite keys produce JSON like
   * `'["api-1","eu"]'`. Map iteration order matches the order each
   * partition was first encountered in the source events.
   *
   * `undefined` partition values become the literal `' undefined'`
   * with a **leading space** — this avoids colliding with a string
   * column whose value happens to be the literal text `'undefined'`.
   * The two are distinct buckets:
   *
   * ```ts
   * series // events with host=undefined and host='undefined'
   *   .partitionBy('host')
   *   .toMap();
   * // → 2 entries: ' undefined' (missing) vs 'undefined' (string literal)
   * ```
   *
   * **Divergence from `series.groupBy(col)`:** `groupBy` uses bare
   * `'undefined'` (no leading space) for missing values, so it
   * collapses these two cases. `toMap`'s leading-space sentinel is
   * an intentional improvement — the older `groupBy` shape silently
   * loses the distinction between "missing" and "the string
   * 'undefined'". Migrating from `groupBy` to `toMap` will produce
   * different keys for partitions with `undefined` values; lookup
   * code that previously did `.get('undefined')` should change to
   * `.get(' undefined')` (note the leading space) to find the
   * missing-value bucket.
   *
   * **Composite encoder.** For composite partitions, `JSON.stringify`
   * with a `?? null` fallback emits both `null` and `undefined` as
   * JSON `null`. In practice this only matters if event data
   * contains explicit `null` values, which the standard
   * validation/ingest paths convert to `undefined` upfront — so the
   * single-column-vs-composite asymmetry is unreachable through the
   * normal API.
   *
   * @example
   * ```ts
   * // Per-host event lookup
   * const byHost = events.partitionBy('host').toMap();
   * const apiEvents = byHost.get('api-1');
   *
   * // With a transform — one-shot per-partition shape change
   * const points = events.partitionBy('host').toMap((g) => g.toPoints());
   * for (const [host, rows] of points) {
   *   chart.addSeries(host, rows);
   * }
   *
   * // Composite partition
   * const byHostRegion = events
   *   .partitionBy(['host', 'region'])
   *   .toMap();
   * const apiEu = byHostRegion.get('["api-1","eu"]');
   * ```
   */
  toMap(): Map<K, TimeSeries<S>>;
  toMap<R extends SeriesSchema>(
    transform: (group: TimeSeries<S>) => TimeSeries<R>,
  ): Map<K, TimeSeries<R>>;
  toMap<R>(transform: (group: TimeSeries<S>) => R): Map<K, R>;
  toMap(transform?: (group: TimeSeries<S>) => unknown): Map<K, unknown> {
    const result = new Map<K, unknown>();
    const buckets =
      this.source.events.length === 0
        ? new Map<string, EventForSchema<S>[]>()
        : PartitionedTimeSeries.bucketByPartition(this.source, this.by);

    if (this.groups) {
      // Declared-order iteration. Empty groups produce empty
      // TimeSeries entries (consistent with pivotByGroup's typed
      // groups behavior, which emits a column for every declared
      // value even when no events match).
      for (const g of this.groups) {
        const events = buckets.get(g) ?? [];
        const sub = TimeSeries.fromEvents(events, {
          schema: this.source.schema,
          name: this.source.name,
        });
        result.set(g, transform ? transform(sub) : sub);
      }
      return result;
    }

    // Insertion-order iteration (matches the order each partition was
    // first encountered in the source events).
    for (const [key, events] of buckets) {
      const sub = TimeSeries.fromEvents(events, {
        schema: this.source.schema,
        name: this.source.name,
      });
      result.set(key as K, transform ? transform(sub) : sub);
    }
    return result;
  }

  // Build the encoder that produces a string key for an event given
  // the partition columns. Single-column case avoids the JSON encoding
  // overhead. Multi-column uses JSON.stringify to guarantee no key
  // collisions on values containing separators (e.g. region names with
  // spaces) — a naive `parts.join('|')` would collide. `undefined` in a
  // single-column key becomes the literal `' undefined'` (with the
  // leading space ensuring it can never collide with a string column
  // whose value is the literal `'undefined'`).
  private static partitionKeyOf<SX extends SeriesSchema>(
    by: ReadonlyArray<keyof EventDataForSchema<SX> & string>,
  ): (event: EventForSchema<SX>) => string {
    if (by.length === 1) {
      const col = by[0]!;
      return (event) => {
        const v = (event.data() as Record<string, unknown>)[col];
        return v === undefined ? ' undefined' : `${String(v)}`;
      };
    }
    return (event) => {
      const data = event.data() as Record<string, unknown>;
      const parts: unknown[] = new Array(by.length);
      for (let i = 0; i < by.length; i += 1) {
        parts[i] = data[by[i]!] ?? null;
      }
      return JSON.stringify(parts);
    };
  }

  // Group source events into buckets keyed by partition value. Returned
  // Map iteration order = insertion order, which matches the order
  // partitions were first seen in the source events array.
  private static bucketByPartition<SX extends SeriesSchema>(
    source: TimeSeries<SX>,
    by: ReadonlyArray<keyof EventDataForSchema<SX> & string>,
  ): Map<string, EventForSchema<SX>[]> {
    const keyOf = PartitionedTimeSeries.partitionKeyOf<SX>(by);
    const buckets = new Map<string, EventForSchema<SX>[]>();
    for (const event of source.events) {
      const key = keyOf(event);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(event);
    }
    return buckets;
  }

  // Internal helper used by both `apply` (terminal) and the sugar
  // methods (which re-wrap the result back into a partitioned view).
  private static applyToSource<SX extends SeriesSchema, R extends SeriesSchema>(
    source: TimeSeries<SX>,
    by: ReadonlyArray<keyof EventDataForSchema<SX> & string>,
    fn: (group: TimeSeries<SX>) => TimeSeries<R>,
  ): TimeSeries<R> {
    // Empty source: apply fn to an empty group so the output schema
    // and name come from fn, not from inferring R structurally.
    if (source.events.length === 0) {
      const empty = TimeSeries.fromEvents(
        [] as ReadonlyArray<EventForSchema<SX>>,
        {
          schema: source.schema,
          name: source.name,
        },
      );
      return fn(empty);
    }

    const buckets = PartitionedTimeSeries.bucketByPartition(source, by);
    const transformed: TimeSeries<R>[] = [];
    for (const events of buckets.values()) {
      const sub = TimeSeries.fromEvents(events, {
        schema: source.schema,
        name: source.name,
      });
      transformed.push(fn(sub));
    }

    return TimeSeries.concat(transformed);
  }

  // Wrap a transform result back into a PartitionedTimeSeries with the
  // same partition columns and groups (if declared). Used by the sugar
  // methods to keep the chain in partition view. Cast at the boundary
  // because R may not preserve the partition columns type-narrowly
  // (e.g. RollingSchema<S, M> may drop columns); runtime constructor
  // validates that the partition columns are still present in the
  // result schema.
  //
  // Routes through the class-private `#fromValidated` factory so the
  // per-event groups validation is skipped on chain steps — the events
  // came from this view's pre-validated source, and stateful
  // per-partition transforms preserve the partition columns by
  // construction. The trusted path is class-private (JS `#`) so it
  // can't be called from outside the class.
  private rewrap<R extends SeriesSchema>(
    out: TimeSeries<R>,
  ): PartitionedTimeSeries<R, K> {
    return PartitionedTimeSeries.#fromValidated<R, K>(
      out,
      this.by as unknown as ReadonlyArray<keyof EventDataForSchema<R> & string>,
      this.groups,
    );
  }

  // ─── Sugar: stateful ops, applied per partition ─────────────────────
  //
  // Each method's overload signatures mirror the corresponding
  // `TimeSeries` method but return `PartitionedTimeSeries<NewSchema>`
  // instead of `TimeSeries<NewSchema>`, so the chain stays in partition
  // view. Call `.collect()` to materialize back. Each impl runs the
  // underlying op per-partition via `applyToSource` and re-wraps.

  /**
   * Per-partition `sample`. Each partition gets its own independent
   * sample state — separate stride counter or its own K-event
   * reservoir. Safe by construction; no `unsafeGlobal: true` token.
   * See {@link TimeSeries.sample}.
   */
  sample(strategy: BatchSampleStrategy): PartitionedTimeSeries<S, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.sample(strategy),
      ),
    );
  }

  /** Per-partition `fill`. See {@link TimeSeries.fill}. */
  fill(
    strategy: FillStrategy | FillMapping<S>,
    options?: { limit?: number; maxGap?: DurationInput },
  ): PartitionedTimeSeries<S, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.fill(strategy, options),
      ),
    );
  }

  /**
   * Per-partition `dedupe`. The duplicate key becomes "same partition
   * columns AND same timestamp" — `partitionBy` provides the partition
   * segregation, `dedupe` handles the within-partition timestamp
   * collapse. The most common dedupe shape for multi-entity ingest.
   *
   * See {@link TimeSeries.dedupe}.
   */
  dedupe(options?: { keep?: DedupeKeep<S> }): PartitionedTimeSeries<S, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.dedupe(options),
      ),
    );
  }

  /** Per-partition `align`. See {@link TimeSeries.align}. */
  align(
    sequence: SequenceLike,
    options?: {
      method?: AlignMethod;
      sample?: AlignSample;
      range?: TemporalLike;
    },
  ): PartitionedTimeSeries<AlignSchema<S>, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.align(sequence, options),
      ),
    );
  }

  /**
   * Per-partition `materialize`. See {@link TimeSeries.materialize}.
   *
   * **Bonus over the bare `TimeSeries.materialize` call:** every
   * output row, including empty-bucket rows, gets the partition
   * columns auto-populated from the partition's known key values.
   * Without this, empty buckets would emit rows with `undefined`
   * partition columns — forcing a follow-up
   * `.fill({ host: 'hold' })` step that fails for partitions where
   * every event sits in a long-outage gap.
   */
  materialize(
    sequence: SequenceLike,
    options?: {
      sample?: AlignSample;
      select?: 'first' | 'last' | 'nearest';
      range?: TemporalLike;
    },
  ): PartitionedTimeSeries<MaterializeSchema<S>, K> {
    const partitionCols = this.by as ReadonlyArray<string>;
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) => {
        const out = g.materialize(sequence, options);
        if (g.events.length === 0) return out;

        // Detect whether any output row needs partition-column patching
        // (i.e., whether any bucket was empty). If the source covered
        // the grid, every row already carries the partition columns
        // from its source event — skip the map() pass entirely. This
        // avoids the per-event closure-call + new event allocation
        // cost when no patching is required.
        const events = out.events;
        let needsPatch = false;
        outer: for (let i = 0; i < events.length; i += 1) {
          const data = events[i]!.data() as Record<string, unknown>;
          for (let c = 0; c < partitionCols.length; c += 1) {
            if (data[partitionCols[c]!] === undefined) {
              needsPatch = true;
              break outer;
            }
          }
        }
        if (!needsPatch) return out;

        // Patch partition columns where undefined (empty-bucket rows).
        // All events in this partition share the partition columns —
        // capture them once from the first source event.
        const firstData = g.events[0]!.data() as Record<string, unknown>;
        const partValues: Record<string, unknown> = {};
        for (const col of partitionCols) {
          partValues[col] = firstData[col];
        }
        return out.map(out.schema, (event) => {
          const data = event.data() as Record<string, unknown>;
          let result = event;
          for (const col of partitionCols) {
            if (data[col] === undefined) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result = (result as any).set(col, partValues[col]);
            }
          }
          return result;
        });
      }),
    );
  }

  /** Per-partition `rolling`. See {@link TimeSeries.rolling}. */
  rolling<const Mapping extends AggregateMap<S>>(
    window: DurationInput,
    mapping: Mapping,
    options?: { alignment?: RollingAlignment; minSamples?: number },
  ): PartitionedTimeSeries<RollingSchema<S, Mapping>, K>;
  rolling<const Mapping extends AggregateOutputMap<S>>(
    window: DurationInput,
    mapping: Mapping,
    options?: { alignment?: RollingAlignment; minSamples?: number },
  ): PartitionedTimeSeries<RollingOutputMapSchema<S, Mapping>, K>;
  rolling<const Mapping extends AggregateMap<S>>(
    sequence: SequenceLike,
    window: DurationInput,
    mapping: Mapping,
    options?: {
      alignment?: RollingAlignment;
      sample?: AlignSample;
      range?: TemporalLike;
      minSamples?: number;
    },
  ): PartitionedTimeSeries<AggregateSchema<S, Mapping>, K>;
  rolling<const Mapping extends AggregateOutputMap<S>>(
    sequence: SequenceLike,
    window: DurationInput,
    mapping: Mapping,
    options?: {
      alignment?: RollingAlignment;
      sample?: AlignSample;
      range?: TemporalLike;
      minSamples?: number;
    },
  ): PartitionedTimeSeries<AggregateOutputMapResultSchema<S, Mapping>, K>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rolling(...args: any[]): any {
    // `rolling` arg shapes: `(window, mapping, opts?)` or
    // `(sequence, window, mapping, opts?)`. The mapping is the
    // last user-supplied mapping object — find it by checking
    // each arg in reverse order for an object that's NOT a
    // valid `opts` shape (opts has only known keys: `alignment`,
    // `output`, `minSamples`). Simpler: for argv length 2, mapping
    // is at index 1; length 3, mapping is at index 1 (window,
    // mapping, opts) or index 2 (sequence, window, mapping); etc.
    // Cleanest: detect by checking whether the slot at index N
    // is a plain object whose values aren't the AggregateMap shape.
    //
    // For the shapes documented on `TimeSeries.rolling`:
    //   rolling(window, mapping, opts?)
    //   rolling(sequence, window, mapping, opts?)
    // mapping is always the third-to-last or second-to-last arg
    // depending on whether opts is supplied. We can disambiguate
    // by checking whether the third arg looks like a mapping
    // (record of reducers) vs an opts object.
    const augmentedArgs = augmentRollingArgsWithPartitionCols(args, (mapping) =>
      this.augmentMappingWithPartitionCols(mapping),
    );
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (g.rolling as any)(...augmentedArgs),
      ),
    );
  }

  /** Per-partition `smooth`. See {@link TimeSeries.smooth}. */
  smooth<
    const Target extends NumericColumnNameForSchema<S>,
    const Output extends string | undefined = undefined,
  >(
    column: Target,
    method: SmoothMethod,
    options:
      | { alpha: number; warmup?: number; output?: Output }
      | { window: DurationInput; alignment?: RollingAlignment; output?: Output }
      | { span: number; output?: Output },
  ): PartitionedTimeSeries<
    Output extends string
      ? SmoothAppendSchema<S, Output>
      : SmoothSchema<S, Target>
  > {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.smooth(column, method, options),
      ),
    );
  }

  /** Per-partition `baseline`. See {@link TimeSeries.baseline}. */
  baseline<
    const Col extends NumericColumnNameForSchema<S>,
    const AvgName extends string = 'avg',
    const SdName extends string = 'sd',
    const UpperName extends string = 'upper',
    const LowerName extends string = 'lower',
  >(
    col: Col,
    options: {
      window: DurationInput;
      sigma: number;
      alignment?: RollingAlignment;
      minSamples?: number;
      names?: {
        avg?: AvgName;
        sd?: SdName;
        upper?: UpperName;
        lower?: LowerName;
      };
    },
  ): PartitionedTimeSeries<
    BaselineSchema<S, AvgName, SdName, UpperName, LowerName>
  > {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.baseline(col, options),
      ),
    );
  }

  /** Per-partition `outliers`. See {@link TimeSeries.outliers}. */
  outliers<const Col extends NumericColumnNameForSchema<S>>(
    col: Col,
    options: {
      window: DurationInput;
      sigma: number;
      alignment?: RollingAlignment;
      minSamples?: number;
    },
  ): PartitionedTimeSeries<S, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.outliers(col, options),
      ),
    );
  }

  /** Per-partition `diff`. See {@link TimeSeries.diff}. */
  diff<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): PartitionedTimeSeries<DiffSchema<S, Target>, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.diff(columns, options),
      ),
    );
  }

  /** Per-partition `rate`. See {@link TimeSeries.rate}. */
  rate<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): PartitionedTimeSeries<DiffSchema<S, Target>, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.rate(columns, options),
      ),
    );
  }

  /** Per-partition `pctChange`. See {@link TimeSeries.pctChange}. */
  pctChange<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): PartitionedTimeSeries<DiffSchema<S, Target>, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.pctChange(columns, options),
      ),
    );
  }

  /** Per-partition `cumulative`. See {@link TimeSeries.cumulative}. */
  cumulative<const Targets extends NumericColumnNameForSchema<S>>(spec: {
    [K in Targets]:
      | 'sum'
      | 'max'
      | 'min'
      | 'count'
      | ((acc: number, value: number) => number);
  }): PartitionedTimeSeries<DiffSchema<S, Targets>, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.cumulative(spec),
      ),
    );
  }

  /** Per-partition `shift`. See {@link TimeSeries.shift}. */
  shift<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    n: number,
  ): PartitionedTimeSeries<DiffSchema<S, Target>, K> {
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        g.shift(columns, n),
      ),
    );
  }

  /** Per-partition `aggregate`. See {@link TimeSeries.aggregate}. */
  aggregate<const Mapping extends AggregateMap<S>>(
    sequence: SequenceLike,
    mapping: Mapping,
    options?: { range?: TemporalLike },
  ): PartitionedTimeSeries<AggregateSchema<S, Mapping>, K>;
  aggregate<const Mapping extends AggregateOutputMap<S>>(
    sequence: SequenceLike,
    mapping: Mapping,
    options?: { range?: TemporalLike },
  ): PartitionedTimeSeries<AggregateOutputMapResultSchema<S, Mapping>, K>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aggregate(...args: any[]): any {
    // `aggregate(sequence, mapping, opts?)` — mapping is at index 1.
    const augmentedArgs = [...args];
    if (augmentedArgs.length >= 2) {
      augmentedArgs[1] = this.augmentMappingWithPartitionCols(augmentedArgs[1]);
    }
    return this.rewrap(
      PartitionedTimeSeries.applyToSource(this.source, this.by, (g) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (g.aggregate as any)(...augmentedArgs),
      ),
    );
  }
}

/**
 * Locate the mapping argument in `TimeSeries.rolling` argv and run
 * `augment` over it. `rolling` has two shapes:
 *
 *   - `rolling(window, mapping, opts?)` — mapping at index 1
 *   - `rolling(sequence, window, mapping, opts?)` — mapping at index 2
 *
 * Disambiguation: the first arg is always either a `RollingWindow`
 * (number/string/DurationInput) or a `SequenceLike` (object with
 * `stepMs`). When it's a SequenceLike, the second arg is the window
 * and the third is the mapping. Otherwise the second is the mapping.
 */
function augmentRollingArgsWithPartitionCols(
  args: unknown[],
  augment: <M>(mapping: M) => M,
): unknown[] {
  if (args.length < 2) return args;
  // Use the same `instanceof` discriminator as `TimeSeries.rolling`'s
  // own dispatch — `BoundedSequence` is a valid sequence-first arg
  // but doesn't expose `stepMs`, so a duck-type check on `stepMs`
  // would fall back to the (window, mapping) shape and corrupt the
  // window arg as the mapping. Codex caught this on PR #128 review.
  const first = args[0];
  const isSequenceFirst =
    first instanceof Sequence || first instanceof BoundedSequence;
  const mappingIdx = isSequenceFirst ? 2 : 1;
  if (mappingIdx >= args.length) return args;
  const out = [...args];
  out[mappingIdx] = augment(out[mappingIdx]);
  return out;
}
