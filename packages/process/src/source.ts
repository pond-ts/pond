/**
 * Entry points into a graph: nodes with no inputs whose value comes from
 * outside.
 */

import type { LiveSource, SeriesSchema, TimeSeries } from 'pond-ts';
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
 * A pond live source that can also snapshot to the batch layer —
 * `LiveSeries`, `LiveView`, and friends all match structurally.
 */
export interface SnapshotSource<S extends SeriesSchema> extends LiveSource<S> {
  toTimeSeries(name?: string): TimeSeries<S>;
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

  constructor(live: SnapshotSource<S>, options: { readonly kind?: string }) {
    super({
      kind: options.kind ?? 'liveSource',
      inputs: {} as NoInputs,
      outputs: { value: {} },
      compute: () => ({ value: live.toTimeSeries() }),
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
 */
export function fromLive<S extends SeriesSchema>(
  live: SnapshotSource<S>,
  options: { readonly kind?: string } = {},
): LiveSourceNode<S> {
  return new LiveSourceNode<S>(live, options);
}
