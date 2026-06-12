import {
  normalizeAggregateColumns,
  type AggregateColumnSpec,
} from '../batch/aggregate-columns.js';
import { Event } from '../core/event.js';
import { Interval } from '../core/interval.js';
import {
  LiveView,
  makeDiffView,
  makeFillView,
  makeCumulativeView,
  type LiveFillMapping,
  type LiveFillStrategy,
} from './live-view.js';
import {
  LiveRollingAggregation,
  type LiveRollingOptions,
  type RollingWindow,
} from './live-rolling-aggregation.js';
import { TimeSeries } from '../batch/time-series.js';
import {
  bucketStateFor,
  type AggregateBucketState,
} from '../reducers/index.js';
import type { Sequence } from '../sequence/sequence.js';
import type {
  AggregateMap,
  AggregateOutputMap,
  AggregateSchema,
  DiffSchema,
  EventDataForSchema,
  EventForSchema,
  LiveSource,
  NumericColumnNameForSchema,
  ColumnValue,
  RollingSchema,
  SelectSchema,
  SeriesSchema,
  ValueColumnsForSchema,
  ValidatedAggregateMap,
} from '../schema/index.js';
import type { RollingOutputMapSchema } from '../schema/index.js';

import { parseDuration } from '../core/duration.js';
import type { DurationInput } from '../core/duration.js';

type PendingBucket = {
  start: number;
  end: number;
  states: AggregateBucketState[];
};

type ClosedEvent = Event<Interval, Record<string, ColumnValue | undefined>>;

type BucketListener = (event: ClosedEvent) => void;
type CloseListener = (event: ClosedEvent) => void;
type UpdateListener = () => void;

export type LiveAggregationOptions = {
  grace?: DurationInput;
};

export class LiveAggregation<
  S extends SeriesSchema,
  Out extends SeriesSchema = SeriesSchema,
> {
  readonly name: string;
  readonly schema: Out;

  readonly #columns: AggregateColumnSpec[];
  readonly #stepMs: number;
  readonly #anchorMs: number;
  readonly #graceMs: number;

  readonly #pending: Map<number, PendingBucket>;
  #watermark: number;
  readonly #closedEvents: ClosedEvent[];

  readonly #onBucket: Set<BucketListener>;
  readonly #onClose: Set<CloseListener>;
  readonly #onUpdate: Set<UpdateListener>;
  readonly #unsubscribe: () => void;

  // Pipeline counters for {@link LiveAggregation.stats}.
  // Cumulative since construction; never reset.
  #statsEventsObserved = 0;
  #statsBucketsClosed = 0;

  constructor(
    source: LiveSource<S>,
    sequence: Sequence,
    mapping: AggregateMap<S> | AggregateOutputMap<S>,
    options?: LiveAggregationOptions,
  ) {
    this.name = source.name;
    this.#stepMs = sequence.stepMs();
    this.#anchorMs = sequence.anchor();
    const sourceGraceMs =
      'graceWindowMs' in source &&
      typeof (source as any).graceWindowMs === 'number' &&
      isFinite((source as any).graceWindowMs)
        ? (source as any).graceWindowMs
        : 0;
    this.#graceMs = options?.grace
      ? parseDuration(options.grace as any)
      : sourceGraceMs;

    // Normalise the mapping into the unified column-spec shape used
    // by both batch and live aggregation paths. Accepts either
    // `AggregateMap<S>` (one reducer per existing source column) or
    // `AggregateOutputMap<S>` (named alias outputs, multiple
    // reducers per source column).
    this.#columns = normalizeAggregateColumns(
      source.schema,
      mapping as AggregateMap<S> | AggregateOutputMap<S>,
    );

    this.schema = Object.freeze([
      { name: 'time', kind: 'interval' },
      ...this.#columns.map((c) => ({
        name: c.output,
        kind: c.kind,
        required: false,
      })),
    ]) as unknown as Out;

    this.#pending = new Map();
    this.#watermark = -Infinity;
    this.#closedEvents = [];
    this.#onBucket = new Set();
    this.#onClose = new Set();
    this.#onUpdate = new Set();

    for (let i = 0; i < source.length; i++) {
      this.#ingest(source.at(i)!);
    }

    this.#unsubscribe = source.on('event', (event) => {
      this.#ingest(event);
      for (const fn of this.#onUpdate) fn();
    });
  }

  get length(): number {
    return this.#closedEvents.length;
  }

  get closedCount(): number {
    return this.#closedEvents.length;
  }

  get hasOpenBucket(): boolean {
    return this.#pending.size > 0;
  }

  at(index: number): EventForSchema<Out> | undefined {
    if (index < 0) index = this.#closedEvents.length + index;
    return this.#closedEvents[index] as EventForSchema<Out> | undefined;
  }

  closed(): TimeSeries<Out> {
    return this.#buildSeries(false);
  }

  snapshot(): TimeSeries<Out> {
    return this.#buildSeries(true);
  }

  on(type: 'event', fn: CloseListener): () => void;
  on(type: 'bucket', fn: BucketListener): this;
  on(type: 'close', fn: CloseListener): this;
  on(type: 'update', fn: UpdateListener): this;
  on(
    type: 'event' | 'bucket' | 'close' | 'update',
    fn: BucketListener | CloseListener | UpdateListener,
  ): this | (() => void) {
    if (type === 'event' || type === 'close') {
      this.#onClose.add(fn as CloseListener);
      if (type === 'event')
        return () => {
          this.#onClose.delete(fn as CloseListener);
        };
      return this;
    }
    if (type === 'bucket') {
      this.#onBucket.add(fn as BucketListener);
      return this;
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

  rolling<const M extends ValidatedAggregateMap<Out, M>>(
    windowSize: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveRollingAggregation<Out, RollingSchema<Out, M>>;
  rolling<const M extends AggregateOutputMap<Out>>(
    windowSize: RollingWindow,
    mapping: M,
    options?: LiveRollingOptions,
  ): LiveRollingAggregation<Out, RollingOutputMapSchema<Out, M>>;
  rolling(
    windowSize: RollingWindow,
    mapping: AggregateMap<Out> | AggregateOutputMap<Out>,
    options?: LiveRollingOptions,
  ): LiveRollingAggregation<Out> {
    return new LiveRollingAggregation(
      this as any,
      windowSize,
      mapping,
      options,
    );
  }

  /**
   * Pipeline stats snapshot — cumulative counters since
   * construction plus current bucket-state. Cheap O(1).
   *
   * - `eventsObserved`: total source events that contributed to a
   *   bucket. Includes events replayed at construction from a
   *   non-empty source. Late events (those whose bucket was
   *   already closed under the watermark + grace window) are
   *   silently dropped and do NOT increment this counter — match
   *   the silent-drop shape in {@link LiveSeries.stats} for
   *   late-event handling. Never decreases.
   * - `bucketsClosed`: total buckets finalized (= length of the
   *   closed-event stream, also exposed via `length`). Never
   *   decreases.
   * - `openBuckets`: current count of pending (unclosed) buckets.
   *   Equal to `#pending.size`. Drops back as the watermark
   *   advances and buckets close.
   * - `openBucketStart`: earliest open bucket's start ms, or
   *   undefined if no buckets are pending.
   *
   * Note on field omission vs `LiveRollingAggregation.stats`: this
   * shape doesn't carry an `emissions` field because every closed
   * bucket pushes exactly one event to the output stream — the
   * count would be identical to `bucketsClosed`. `openBuckets` and
   * `openBucketStart` give the bucket-lifecycle observability
   * users actually reach for.
   */
  stats(): {
    eventsObserved: number;
    bucketsClosed: number;
    openBuckets: number;
    openBucketStart?: number;
  } {
    const result: {
      eventsObserved: number;
      bucketsClosed: number;
      openBuckets: number;
      openBucketStart?: number;
    } = {
      eventsObserved: this.#statsEventsObserved,
      bucketsClosed: this.#statsBucketsClosed,
      openBuckets: this.#pending.size,
    };
    if (this.#pending.size > 0) {
      let minStart = Infinity;
      for (const start of this.#pending.keys()) {
        if (start < minStart) minStart = start;
      }
      result.openBucketStart = minStart;
    }
    return result;
  }

  dispose(): void {
    this.#unsubscribe();
  }

  // ── Private ─────────────────────────────────────────────────

  #bucketFor(timestamp: number): { start: number; end: number } {
    const start =
      Math.floor((timestamp - this.#anchorMs) / this.#stepMs) * this.#stepMs +
      this.#anchorMs;
    return { start, end: start + this.#stepMs };
  }

  #ingest(event: EventForSchema<S>): void {
    const bucket = this.#bucketFor(event.begin());
    const ts = event.begin();

    if (ts > this.#watermark) this.#watermark = ts;

    const closeCutoff = this.#watermark - this.#graceMs;

    if (bucket.end <= closeCutoff) return;

    this.#statsEventsObserved++;

    let pending = this.#pending.get(bucket.start);
    if (!pending) {
      // Built-ins use their dedicated O(1) machinery; custom functions
      // use a generic adapter that buffers values and runs the
      // function at snapshot time (O(N) per snapshot).
      pending = {
        start: bucket.start,
        end: bucket.end,
        states: this.#columns.map((c) => bucketStateFor(c.reducer)),
      };
      this.#pending.set(bucket.start, pending);
    }

    const data = event.data() as Record<string, ColumnValue | undefined>;
    for (let i = 0; i < this.#columns.length; i++) {
      pending.states[i]!.add(data[this.#columns[i]!.source]);
    }

    if (this.#onBucket.size > 0) {
      const interval = new Interval({
        value: pending.start,
        start: pending.start,
        end: pending.end,
      });
      const record: Record<string, ColumnValue | undefined> = {};
      for (let i = 0; i < this.#columns.length; i++) {
        record[this.#columns[i]!.output] = pending.states[i]!.snapshot();
      }
      const evt = new Event(interval, record);
      for (const fn of this.#onBucket) fn(evt);
    }

    this.#closeEligible(closeCutoff);
  }

  #closeEligible(closeCutoff: number): void {
    const eligible: number[] = [];
    for (const [start, b] of this.#pending) {
      if (b.end <= closeCutoff) eligible.push(start);
    }
    if (eligible.length === 0) return;
    eligible.sort((a, b) => a - b);
    for (const start of eligible) {
      const b = this.#pending.get(start)!;
      this.#pending.delete(start);
      this.#finalizeBucket(b);
    }
  }

  #finalizeBucket(bucket: PendingBucket): void {
    const interval = new Interval({
      value: bucket.start,
      start: bucket.start,
      end: bucket.end,
    });
    const record: Record<string, ColumnValue | undefined> = {};
    for (let i = 0; i < this.#columns.length; i++) {
      record[this.#columns[i]!.output] = bucket.states[i]!.snapshot();
    }
    const evt = new Event(interval, record);
    this.#closedEvents.push(evt);
    this.#statsBucketsClosed++;
    for (const fn of this.#onClose) fn(evt);
  }

  #buildSeries(includeOpen: boolean): TimeSeries<Out> {
    const rows: unknown[][] = this.#closedEvents.map((event) => {
      const data = event.data() as Record<string, ColumnValue | undefined>;
      return [event.key(), ...this.#columns.map((c) => data[c.output])];
    });

    if (includeOpen) {
      const pendingBuckets = [...this.#pending.values()].sort(
        (a, b) => a.start - b.start,
      );
      for (const b of pendingBuckets) {
        rows.push([
          new Interval({
            value: b.start,
            start: b.start,
            end: b.end,
          }),
          ...b.states.map((s) => s.snapshot()),
        ]);
      }
    }

    return new TimeSeries({
      name: this.name,
      schema: this.schema,
      rows: rows as any,
    });
  }
}
