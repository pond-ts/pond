import { Event } from './Event.js';
import { ValidationError } from './errors.js';
import { LiveAggregation } from './LiveAggregation.js';
import {
  LiveRollingAggregation,
  type LiveRollingOptions,
  type RollingWindow,
} from './LiveRollingAggregation.js';
import { LiveFusedRolling } from './LiveFusedRolling.js';
import { LiveReduce } from './LiveReduce.js';
import type { SampleStrategy } from './sample.js';
import { TimeSeries, toKey, type KeyLike } from './TimeSeries.js';
import type { Sequence } from './Sequence.js';
import {
  EMITS_EVICT,
  type AggregateMap,
  type AggregateOutputMap,
  type AggregateSchema,
  type DiffSchema,
  type EventDataForSchema,
  type EventForSchema,
  type LiveSource,
  type NumericColumnNameForSchema,
  type RollingSchema,
  type RowForSchema,
  type ScalarValue,
  type SelectSchema,
  type SeriesSchema,
  type ValueColumnsForSchema,
} from './types.js';
import type {
  AggregateOutputMapResultSchema,
  RollingOutputMapSchema,
} from './types-aggregate.js';
import type {
  FusedMapping,
  FusedMappingValid,
  FusedRollingSchema,
} from './types-fused-rolling.js';

export type LiveFillStrategy = 'hold' | 'zero';

export type LiveFillMapping<S extends SeriesSchema> = {
  [K in ValueColumnsForSchema<S>[number]['name']]?:
    | LiveFillStrategy
    | ScalarValue;
};

import { parseDuration } from './utils/duration.js';
import type { DurationInput } from './utils/duration.js';

type EventListener<S extends SeriesSchema> = (event: EventForSchema<S>) => void;
type EvictListener<S extends SeriesSchema> = (
  evicted: readonly EventForSchema<S>[],
) => void;

type ViewOptions<S extends SeriesSchema> = {
  schema?: S;
  evict?: (events: readonly EventForSchema<S>[]) => number;
  /**
   * Duration of the time-based window this view represents, in
   * milliseconds. Set by `LiveSeries.window(duration)` and
   * `LiveView.window(duration)` so {@link LiveView.rate} has a
   * denominator. Unset for count-based windows or views that
   * weren't created by a `.window()` call — `rate()` throws in
   * those cases.
   */
  windowMs?: number;
};

export class LiveView<S extends SeriesSchema> implements LiveSource<S> {
  readonly [EMITS_EVICT] = true as const;
  readonly name: string;
  readonly schema: S;

  readonly #events: EventForSchema<S>[];
  readonly #process: (event: any) => EventForSchema<S> | undefined;
  readonly #evict:
    | ((events: readonly EventForSchema<S>[]) => number)
    | undefined;
  readonly #windowMs: number | undefined;
  readonly #onEvent: Set<EventListener<S>>;
  readonly #onEvict: Set<EvictListener<S>>;
  readonly #unsubscribe: () => void;

  constructor(
    source: LiveSource<any>,
    process: (event: any) => EventForSchema<S> | undefined,
    options?: ViewOptions<S>,
  ) {
    this.name = source.name;
    this.schema = options?.schema ?? (source.schema as unknown as S);
    this.#events = [];
    this.#process = process;
    this.#evict = options?.evict;
    this.#windowMs = options?.windowMs;
    this.#onEvent = new Set();
    this.#onEvict = new Set();

    for (let i = 0; i < source.length; i++) {
      const result = this.#process(source.at(i)!);
      if (result !== undefined) this.#appendChecked(result);
    }
    this.#applyEviction();

    const eventUnsub = source.on('event', (event) => {
      const result = this.#process(event);
      if (result !== undefined) {
        this.#appendChecked(result);
        this.#applyEviction();
        for (const fn of this.#onEvent) fn(result);
      }
    });

    // Mirror source eviction: when the source removes old events, remove
    // view events that are at or before the latest evicted timestamp.
    // This prevents unbounded growth on filtered/mapped views of a
    // retention-capped LiveSeries.
    //
    // Only subscribe if the source actually emits 'evict' events (marked
    // by the EMITS_EVICT symbol).  Duck-typing `source.on('evict', fn)`
    // is unsafe because LiveAggregation's `on()` silently routes unknown
    // event types to its update listener set.
    let evictUnsub: (() => void) | undefined;
    if (EMITS_EVICT in source) {
      evictUnsub = (source as any).on('evict', (evicted: readonly any[]) => {
        if (evicted.length === 0 || this.#events.length === 0) return;
        const cutoff = evicted[evicted.length - 1]!.begin();
        let i = 0;
        while (i < this.#events.length && this.#events[i]!.begin() <= cutoff)
          i++;
        if (i > 0) {
          const removed = this.#events.splice(0, i);
          for (const fn of this.#onEvict) fn(removed as any);
        }
      });
    }

    this.#unsubscribe = () => {
      eventUnsub();
      evictUnsub?.();
    };
  }

  get length(): number {
    return this.#events.length;
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

  // ── Query primitives ─────────────────────────────────────────
  //
  // Mirror `TimeSeries` / `LiveSeries` query parity. Live views
  // are sorted by key (events flow through in source-order; views
  // never re-sort). Same binary-search shape as `TimeSeries.bisect`.
  //
  // Sort-order assumption: the four binary-search methods below
  // assume the underlying buffer is sorted by key. This holds for
  // every built-in view operation (`filter` / `select` / `window` /
  // `diff` / `rate` / `pctChange` / `cumulative` / `fill`) because
  // they preserve the source's keys. The exception is
  // {@link LiveView.map} when the user-supplied function rewrites
  // the key — see that method's JSDoc.

  /** Example: `view.find(e => e.get('value') > 0)`. */
  find(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): EventForSchema<S> | undefined {
    return this.#events.find((event, index) => predicate(event, index));
  }

  /** Example: `view.some(e => e.get('healthy'))`. */
  some(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): boolean {
    return this.#events.some((event, index) => predicate(event, index));
  }

  /** Example: `view.every(e => e.get('healthy'))`. */
  every(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): boolean {
    return this.#events.every((event, index) => predicate(event, index));
  }

  /** Example: `view.includesKey(new Time(t))`. */
  includesKey(key: KeyLike): boolean {
    const normalizedKey = toKey(key);
    const index = this.bisect(normalizedKey);
    return (
      index < this.#events.length &&
      this.#events[index]!.key().equals(normalizedKey)
    );
  }

  /** Example: `view.bisect(new Time(t))`. Insertion index for `key` in the sorted view buffer (binary search). */
  bisect(key: KeyLike): number {
    const normalizedKey = toKey(key);
    let low = 0;
    let high = this.#events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#events[mid]!.key().compare(normalizedKey) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Example: `view.atOrBefore(new Time(t))`. */
  atOrBefore(key: KeyLike): EventForSchema<S> | undefined {
    const normalizedKey = toKey(key);
    const index = this.bisect(normalizedKey);
    if (
      index < this.#events.length &&
      this.#events[index]!.key().equals(normalizedKey)
    ) {
      return this.#events[index];
    }
    return index === 0 ? undefined : this.#events[index - 1];
  }

  /** Example: `view.atOrAfter(new Time(t))`. */
  atOrAfter(key: KeyLike): EventForSchema<S> | undefined {
    return this.#events[this.bisect(key)];
  }

  filter(predicate: (event: EventForSchema<S>) => boolean): LiveView<S> {
    return new LiveView(
      this,
      (event: EventForSchema<S>) => (predicate(event) ? event : undefined),
      this.#windowMs !== undefined ? { windowMs: this.#windowMs } : undefined,
    );
  }

  /**
   * Per-event transform. Each source event is run through `fn` and
   * the result is appended to the view's buffer. The view does NOT
   * re-sort by key — events flow through in source order, which
   * preserves the upstream's sort invariant only if `fn` returns
   * events with the same key.
   *
   * **If `fn` rewrites the event's key** (e.g. shifting timestamps,
   * changing the interval), the view's buffer is no longer
   * key-sorted. The Tier 2 query primitives ({@link LiveView.bisect},
   * {@link LiveView.includesKey}, {@link LiveView.atOrBefore},
   * {@link LiveView.atOrAfter}) all assume sorted-by-key and will
   * return wrong answers on a re-keying map. Use `map` only for
   * data transforms; use a separate live primitive for time-axis
   * transforms.
   */
  map(fn: (event: EventForSchema<S>) => EventForSchema<S>): LiveView<S> {
    return new LiveView(
      this,
      fn,
      this.#windowMs !== undefined ? { windowMs: this.#windowMs } : undefined,
    );
  }

  /**
   * Bounded-memory stream sampling on a `LiveView`. Same semantics as
   * `LiveSeries.sample` — stride only on the live side in v0.17.0.
   *
   * **Multi-entity bias trap** applies here too: a `LiveView` derived
   * from a multi-entity source carries the same bias risk. Chain after
   * `partitionBy(...)` for the safe-by-construction shape; see
   * `LiveSeries.sample` for the full discussion.
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
      ...(this.#windowMs !== undefined ? { windowMs: this.#windowMs } : {}),
    });
  }

  window(size: RollingWindow): LiveView<S> {
    if (typeof size === 'number' && Number.isInteger(size) && size > 0) {
      const count = size;
      return new LiveView(this, (event: EventForSchema<S>) => event, {
        evict: (events) => Math.max(0, events.length - count),
      });
    }
    if (typeof size === 'string') {
      const ms = parseDuration(size as DurationInput);
      return new LiveView(this, (event: EventForSchema<S>) => event, {
        evict: (events) => {
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

  /**
   * Example: `live.window('1m').count()`. Returns the number of
   * events currently in the view's buffer. For windows created via
   * `window(duration)`, this is "events in the last N seconds";
   * for `window(count)`, it's "events in the last N retained."
   *
   * Cheap O(1) accessor that reads `this.length` directly — same
   * value as `view.length`. Provided as a method so it composes
   * naturally with {@link LiveView.rate}.
   */
  count(): number {
    return this.#events.length;
  }

  /**
   * Example: `live.window('1m').eventRate()`. Returns events per
   * second over the view's window — `count() / windowSeconds`.
   *
   * Only defined on time-based windows. Throws on count-based
   * windows (`window(100)`) and on views that weren't created by
   * a `.window(duration)` call (filter / map / select on a
   * non-windowed source — there's no denominator to use).
   *
   * Convenient for metrics-endpoint gauges and React displays
   * ("EVENT RATE 8.0/s"). Pairs with {@link LiveView.count} for
   * cases where both numbers are needed.
   *
   * Distinct from {@link LiveView.rate}, which is the per-column
   * derivative operator (rate-of-change of *values*).
   * `eventRate` is per-window-events-per-second; `rate(columns)`
   * is per-event derivative of the named columns.
   */
  eventRate(): number {
    if (this.#windowMs === undefined) {
      throw new TypeError(
        'eventRate() requires a time-based window — call ' +
          '.window(duration) first (count-based windows have no ' +
          'denominator).',
      );
    }
    return this.#events.length / (this.#windowMs / 1000);
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
   * Keyed-form fused multi-window rolling on a `LiveView`. See
   * {@link LiveSeries.rolling} for the full surface — chained-from-
   * a-view behavior is identical to the same call on a top-level
   * `LiveSeries`.
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
   * Streaming reduce over the view's current buffer. See
   * {@link LiveSeries.reduce} for the full surface.
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

  on(type: 'event', fn: EventListener<S>): () => void;
  on(type: 'evict', fn: EvictListener<S>): () => void;
  on(
    type: 'event' | 'evict',
    fn: EventListener<S> | EvictListener<S>,
  ): () => void {
    const set: Set<any> = type === 'event' ? this.#onEvent : this.#onEvict;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #applyEviction(): void {
    if (!this.#evict) return;
    const count = this.#evict(this.#events);
    if (count > 0) this.#events.splice(0, count);
  }

  /**
   * Append a processed event to the view's buffer, asserting that
   * the buffer remains key-sorted. Re-keying maps that produce
   * non-monotonic outputs would silently break the four binary-
   * search query primitives ({@link LiveView.bisect},
   * {@link LiveView.includesKey}, {@link LiveView.atOrBefore},
   * {@link LiveView.atOrAfter}) — Codex caught this on PR #125
   * review. Throwing at append time turns silent wrong answers
   * into a clear, debuggable error.
   *
   * Sane transforms (`map(e => e.set('x', f(x)))`,
   * `filter(...)`, `select(...)`, etc.) preserve keys and never
   * trip the check. Time-axis transforms (e.g. shifting all
   * timestamps by N ms) are also fine — they preserve relative
   * order. The only failure mode is a re-keying map that produces
   * out-of-order events.
   */
  #appendChecked(event: EventForSchema<S>): void {
    const last = this.#events[this.#events.length - 1];
    if (last && event.key().compare(last.key()) < 0) {
      throw new ValidationError(
        `LiveView: processed event has key ${String(event.key())} ` +
          `older than the previous tail ${String(last.key())}. ` +
          `Re-keying maps that produce non-monotonic output break the ` +
          `view's sorted-buffer invariant. Use a transform that ` +
          `preserves keys, or perform time-axis rewrites on a snapshot ` +
          `(\`live.toTimeSeries()\`) instead.`,
      );
    }
    this.#events.push(event);
  }
}

// ── Factory functions for stateful live views ────────────────────

/**
 * Stride-mode sampling view factory. Builds a `LiveView` whose
 * `process` closure captures a per-instance counter and emits every
 * Nth event. Used by `LiveSeries.sample`, `LiveView.sample`,
 * `LivePartitionedSeries.sample`, and `LivePartitionedView.sample`
 * (each call site owns one counter, so partitioned sites get
 * per-partition state for free via the factory pattern).
 *
 * Stride-only by design — see `sample.ts` JSDoc for why live-side
 * reservoir is deferred (non-prefix eviction violates the live
 * eviction protocol).
 *
 * Validates `stride` at the call site so the error surfaces inline
 * with the user's `.sample({...})` call, not later at first push.
 */
export function makeStrideSampleView<S extends SeriesSchema>(
  source: LiveSource<S>,
  stride: number,
): LiveView<S> {
  if (!Number.isInteger(stride) || stride < 1) {
    throw new TypeError(
      `sample({ stride }): stride must be a positive integer (got ${String(stride)})`,
    );
  }
  let counter = 0;
  return new LiveView<S>(source, (event: EventForSchema<S>) => {
    counter++;
    return counter % stride === 0 ? event : undefined;
  });
}

export function makeDiffView<
  S extends SeriesSchema,
  Target extends NumericColumnNameForSchema<S>,
>(
  source: LiveSource<S>,
  mode: 'diff' | 'rate' | 'pctChange',
  columns: Target | readonly Target[],
  options?: { drop?: boolean },
): LiveView<DiffSchema<S, Target>> {
  type OutSchema = DiffSchema<S, Target>;
  const cols = (
    typeof columns === 'string' ? [columns] : [...columns]
  ) as string[];
  const drop = options?.drop === true;

  if (cols.length === 0) {
    throw new Error(`${mode}() requires at least one column name`);
  }

  const targetSet = new Set<string>(cols);
  const outSchema = Object.freeze(
    source.schema.map((col, i) => {
      if (i === 0) return col;
      if (targetSet.has(col.name)) {
        return { ...col, kind: 'number' as const, required: false as const };
      }
      return col;
    }),
  ) as unknown as OutSchema;

  let prevData: Record<string, unknown> | undefined;
  let prevTime: number | undefined;

  const process = (event: any): any => {
    const data = event.data() as Record<string, unknown>;

    if (prevData === undefined) {
      prevData = data;
      prevTime = event.begin();
      if (drop) return undefined;
      const firstData = { ...data };
      for (const col of cols) {
        firstData[col] = undefined;
      }
      return new Event(event.key(), firstData);
    }

    const outData = { ...data };
    const dt = mode === 'rate' ? (event.begin() - prevTime!) / 1000 : undefined;

    for (const col of cols) {
      const prevVal = prevData[col];
      const currVal = outData[col];

      if (typeof currVal === 'number' && typeof prevVal === 'number') {
        const delta = currVal - prevVal;
        if (mode === 'pctChange') {
          outData[col] = prevVal !== 0 ? delta / prevVal : undefined;
        } else if (mode === 'rate') {
          outData[col] = dt !== 0 ? delta / dt! : undefined;
        } else {
          outData[col] = delta;
        }
      } else {
        outData[col] = undefined;
      }
    }

    prevData = data;
    prevTime = event.begin();

    return new Event(event.key(), outData);
  };

  return new LiveView(source as any, process, {
    schema: outSchema as any,
  }) as unknown as LiveView<OutSchema>;
}

export function makeFillView<S extends SeriesSchema>(
  source: LiveSource<S>,
  strategy: LiveFillStrategy | LiveFillMapping<S>,
  options?: { limit?: number },
): LiveView<S> {
  type Spec =
    | { mode: 'hold' }
    | { mode: 'zero' }
    | { mode: 'literal'; value: ScalarValue };

  const colNames = source.schema.slice(1).map((c) => c.name);
  const specs = new Map<string, Spec>();

  if (typeof strategy === 'string') {
    if (strategy !== 'hold' && strategy !== 'zero') {
      throw new Error(
        `live fill strategy '${strategy}' is not supported (bfill and linear require future values)`,
      );
    }
    for (const name of colNames) {
      specs.set(name, { mode: strategy });
    }
  } else {
    for (const [name, spec] of Object.entries(strategy)) {
      if (spec === 'hold' || spec === 'zero') {
        specs.set(name, { mode: spec });
      } else if (spec === 'bfill' || spec === 'linear') {
        throw new Error(
          `live fill strategy '${spec}' is not supported (bfill and linear require future values)`,
        );
      } else {
        specs.set(name, { mode: 'literal', value: spec as ScalarValue });
      }
    }
  }

  const limit = options?.limit;
  const state = new Map<
    string,
    { lastKnown: ScalarValue | undefined; consecutive: number }
  >();
  for (const [name] of specs) {
    state.set(name, { lastKnown: undefined, consecutive: 0 });
  }

  const process = (event: any): any => {
    const data = event.data() as Record<string, unknown>;
    let outData: Record<string, unknown> | undefined;

    for (const [name, spec] of specs) {
      const s = state.get(name)!;
      const value = data[name];

      if (value !== undefined) {
        s.lastKnown = value as ScalarValue;
        s.consecutive = 0;
      } else {
        s.consecutive++;
        if (limit !== undefined && s.consecutive > limit) continue;

        let fillValue: ScalarValue | undefined;
        switch (spec.mode) {
          case 'hold':
            fillValue = s.lastKnown;
            break;
          case 'zero':
            fillValue = 0;
            break;
          case 'literal':
            fillValue = spec.value;
            break;
        }

        if (fillValue !== undefined) {
          if (!outData) outData = { ...data };
          outData[name] = fillValue;
        }
      }
    }

    return outData ? new Event(event.key(), outData) : event;
  };

  return new LiveView(source as any, process) as unknown as LiveView<S>;
}

export function makeCumulativeView<
  S extends SeriesSchema,
  Targets extends NumericColumnNameForSchema<S>,
>(
  source: LiveSource<S>,
  spec: {
    [K in Targets]:
      | 'sum'
      | 'max'
      | 'min'
      | 'count'
      | ((acc: number, value: number) => number);
  },
): LiveView<DiffSchema<S, Targets>> {
  type OutSchema = DiffSchema<S, Targets>;

  const entries = Object.entries(spec) as [
    string,
    'sum' | 'max' | 'min' | 'count' | ((acc: number, value: number) => number),
  ][];

  if (entries.length === 0) {
    throw new Error('cumulative() requires at least one column');
  }

  const targetSet = new Set<string>(entries.map(([name]) => name));
  const outSchema = Object.freeze(
    source.schema.map((col, i) => {
      if (i === 0) return col;
      if (targetSet.has(col.name)) {
        return { ...col, kind: 'number' as const, required: false as const };
      }
      return col;
    }),
  ) as unknown as OutSchema;

  const accState = new Map<
    string,
    {
      acc: number | undefined;
      apply: (acc: number | undefined, value: number) => number;
    }
  >();

  for (const [name, reducer] of entries) {
    if (typeof reducer === 'function') {
      const fn = reducer;
      accState.set(name, {
        acc: undefined,
        apply: (acc, v) => (acc === undefined ? v : fn(acc, v)),
      });
    } else {
      switch (reducer) {
        case 'sum':
          accState.set(name, {
            acc: undefined,
            apply: (acc, v) => (acc ?? 0) + v,
          });
          break;
        case 'count':
          accState.set(name, {
            acc: undefined,
            apply: (acc) => (acc ?? 0) + 1,
          });
          break;
        case 'max':
          accState.set(name, {
            acc: undefined,
            apply: (acc, v) => (acc === undefined || v > acc ? v : acc),
          });
          break;
        case 'min':
          accState.set(name, {
            acc: undefined,
            apply: (acc, v) => (acc === undefined || v < acc ? v : acc),
          });
          break;
      }
    }
  }

  const process = (event: any): any => {
    const data = { ...(event.data() as Record<string, unknown>) };
    for (const [name, s] of accState) {
      const raw = data[name];
      if (typeof raw === 'number') {
        s.acc = s.apply(s.acc, raw);
        data[name] = s.acc;
      } else {
        data[name] = s.acc;
      }
    }
    return new Event(event.key(), data);
  };

  return new LiveView(source as any, process, {
    schema: outSchema as any,
  }) as unknown as LiveView<OutSchema>;
}
