/**
 * Entry points into a graph: nodes with no inputs whose value comes from
 * outside.
 */

import { TimeSeries } from 'pond-ts';
import type { EventForSchema, SeriesSchema } from 'pond-ts';
import { ProcessError } from './errors.js';
import { Node } from './node.js';
import type { PortSpec, PortSpecMap } from './types.js';

/**
 * Spec map for a node that declares no inputs.
 *
 * `never` rather than `PortSpec<never>`: `PortSpec` is invariant in its
 * value type, so `PortSpec<never>` does not satisfy the `PortSpec<any>`
 * element constraint, while bare `never` is assignable to anything.
 */
export type NoInputs = Readonly<Record<string, never>>;

/** Thrown when a source is pulled before a value has been set. */
export class UnsetSourceError extends ProcessError {}

/** Mutable cell holding a source's current value. */
interface SourceState<T> {
  value: T | undefined;
  hasValue: boolean;
}

/**
 * A graph input whose value is pushed in from outside via {@link set}.
 *
 * Setting an equal value (per the port's `equals`) does not bump the
 * output version, so downstream nodes revalidate and then skip their own
 * work — no cascade.
 */
export class SourceNode<T> extends Node<
  NoInputs,
  { readonly value: PortSpec<T> }
> {
  readonly #state: SourceState<T>;

  constructor(options: {
    readonly kind?: string;
    readonly initial?: T;
    readonly equals?: (a: T, b: T) => boolean;
  }) {
    // The state cell is created before `super()` so `compute` can close
    // over it — a derived constructor cannot touch `this` until the
    // base constructor returns.
    const state: SourceState<T> = {
      value: options.initial,
      hasValue: options.initial !== undefined,
    };
    const valuePort: PortSpec<T> = options.equals
      ? { equals: options.equals }
      : {};
    super({
      kind: options.kind ?? 'source',
      inputs: {} as NoInputs,
      outputs: { value: valuePort },
      compute: () => {
        if (!state.hasValue) {
          throw new UnsetSourceError(
            'Source has no value — call set() before pulling from it',
          );
        }
        return { value: state.value as T };
      },
    });
    this.#state = state;
  }

  /** The current value, or `undefined` if none has been set. */
  get value(): T | undefined {
    return this.#state.value;
  }

  /** Replaces the value and invalidates everything downstream. */
  set(value: T): this {
    this.#state.value = value;
    this.#state.hasValue = true;
    this.invalidate();
    return this;
  }
}

/**
 * Creates a settable graph input.
 *
 * ```ts
 * const raw = source<TimeSeries<Schema>>();
 * raw.set(series);
 * ```
 */
export function source<T>(
  options: {
    readonly kind?: string;
    readonly initial?: T;
    readonly equals?: (a: T, b: T) => boolean;
  } = {},
): SourceNode<T> {
  return new SourceNode<T>(options);
}

/**
 * What {@link fromLive} needs from a pond live source: enough to
 * materialize a snapshot, and a way to hear that one is due.
 *
 * Looser than core's `LiveSource<S>` in exactly one place — the
 * `'event'` listener's parameter is `any`. That is not laziness: this
 * package never reads the event, it only needs the notification, and
 * core's incremental operators type that listener differently.
 * `LiveAggregation.on('event', …)` hands back a widened `ClosedEvent`
 * rather than a schema-narrowed `EventForSchema<Out>`, so it does not
 * satisfy `LiveSource<Out>` structurally. Requiring the exact interface
 * would reject precisely the sources worth binding (see {@link fromLive}).
 *
 * `LiveSeries`, `LiveView`, `LiveAggregation`, `LiveRollingAggregation`,
 * and `LiveFusedRolling` all match this.
 */
export interface GraphSource<S extends SeriesSchema> {
  readonly name: string;
  readonly schema: S;
  readonly length: number;
  at(index: number): EventForSchema<S> | undefined;
  on(type: 'event', fn: (event: any) => void): () => void;
}

/**
 * A live source that can snapshot itself to the batch layer in one call.
 * `LiveSeries` and `LiveView` match; the incremental operators do not.
 */
export interface SnapshotSource<S extends SeriesSchema> extends GraphSource<S> {
  toTimeSeries(name?: string): TimeSeries<S>;
}

/** Whether a live source can snapshot itself. */
function canSnapshot<S extends SeriesSchema>(
  live: GraphSource<S>,
): live is SnapshotSource<S> {
  return typeof (live as SnapshotSource<S>).toTimeSeries === 'function';
}

/**
 * Snapshots any live source to the batch layer.
 *
 * Prefers the source's own `toTimeSeries()`, which reads columns. The
 * `at()` fallback walks events, which pond's design notes call a bug in
 * a bulk path — and it would be, against a raw buffer. It only runs for
 * sources that have no snapshot method, and those are the *aggregation*
 * outputs, whose length is bucket count rather than event count. Walking
 * 24 hourly buckets is not the same act as walking 200k events.
 */
function snapshot<S extends SeriesSchema>(live: GraphSource<S>): TimeSeries<S> {
  if (canSnapshot(live)) return live.toTimeSeries();
  const events: EventForSchema<S>[] = [];
  for (let index = 0; index < live.length; index += 1) {
    const event = live.at(index);
    if (event !== undefined) events.push(event);
  }
  return TimeSeries.fromEvents(events, {
    name: live.name,
    schema: live.schema,
  });
}

/**
 * A graph input backed by a pond live source. Snapshots lazily; call
 * {@link dispose} to unsubscribe.
 */
export class LiveSourceNode<S extends SeriesSchema> extends Node<
  NoInputs,
  { readonly value: PortSpec<TimeSeries<S>> }
> {
  #unsubscribe: (() => void) | undefined;

  constructor(live: GraphSource<S>, options: { readonly kind?: string }) {
    super({
      kind: options.kind ?? 'liveSource',
      inputs: {} as NoInputs,
      outputs: { value: {} },
      compute: () => ({ value: snapshot(live) }),
    });
    this.#unsubscribe = live.on('event', () => {
      this.invalidate();
    });
  }

  /** Stops listening. The node keeps its last snapshot. */
  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Whether this node is still subscribed. */
  get subscribed(): boolean {
    return this.#unsubscribe !== undefined;
  }
}

/**
 * Binds a pond live source into a graph.
 *
 * Incoming events **invalidate** the node; they do not snapshot. The
 * `toTimeSeries()` call happens when something pulls, so a burst of
 * events costs one dirty mark each (O(1) after the first, since dirty
 * propagation cuts off at already-dirty nodes) and exactly one snapshot
 * at the next pull — not one snapshot per event.
 *
 * That keeps the graph on the right side of pond's split: incremental
 * per-event computation stays in the live layer, and the graph composes
 * whole-value batch transforms over snapshots.
 *
 * ```ts
 * const feed = fromLive(liveSeries);
 * const hourly = derive({ s: feed.out.value }, ({ s }) =>
 *   s.aggregate(Sequence.every('1h'), { cpu: 'avg' }),
 * );
 * // ... events arrive ...
 * hourly.out.value.get(); // one snapshot, one aggregate
 * feed.dispose();
 * ```
 *
 * ## Bind the aggregation, not the buffer
 *
 * The graph has no partial invalidation: a dirty node recomputes from a
 * whole snapshot, so the pipeline above re-aggregates every retained
 * event on every pull even though only the tail moved. Push the windowed
 * work down into the live layer instead, and bind *its* output:
 *
 * ```ts
 * const feed = fromLive(liveSeries.aggregate(Sequence.every('1h'), { cpu: 'avg' }));
 * const peak = derive({ s: feed.out.value }, ({ s }) => s.column('cpu').max());
 * ```
 *
 * `LiveAggregation` keeps its buckets current per event, so a pull
 * materializes bucket count rather than event count. Measured at 200k
 * events through a 50k-event buffer, pulling every 1k events: **9.05 ms
 * per pull re-aggregating the buffer, 0.04 ms per pull off the live
 * aggregation — 235x.** The gap widens with buffer size, because the
 * first is O(retained events) and the second is O(buckets).
 *
 * **This is a semantic change, not just a faster path.** A live
 * aggregation exposes *closed* buckets. Data is the clock, so the
 * newest bucket stays invisible until an event crosses its end, while
 * re-aggregating the raw buffer includes that partial tail bucket
 * immediately. Two hours of minute data ending at 1h59m reads as one
 * row through the aggregation and two through the buffer. If the
 * current, still-filling bucket has to be on screen, keep
 * re-aggregating the buffer and pay for it — or drive emission with a
 * `Trigger` so buckets close on a schedule you control.
 *
 * This is why `fromLive` takes a {@link GraphSource} rather than a
 * {@link SnapshotSource}: the incremental operators are precisely the
 * ones without a `toTimeSeries()` method, and excluding them would rule
 * out the only answer to the cost above.
 */
export function fromLive<S extends SeriesSchema>(
  live: GraphSource<S>,
  options: { readonly kind?: string } = {},
): LiveSourceNode<S> {
  return new LiveSourceNode<S>(live, options);
}
