import { Sequence } from '../sequence/sequence.js';
import type { DurationInput } from '../core/duration.js';
import type { TimestampInput } from '../core/temporal.js';

/**
 * A `Trigger` describes when an accumulator should emit. Pond's live
 * layer factors emission cadence as a first-class concept — orthogonal
 * to the accumulator's aggregation choice — so the same primitive can
 * fire on every event, on sequence boundaries, or (in future) on count
 * thresholds.
 *
 * Triggers are constructed via the `Trigger` factory:
 *
 * ```ts
 * import { Trigger, Sequence } from 'pond-ts';
 *
 * const event = Trigger.event();                              // per-event (default)
 * const tick  = Trigger.every('30s');                         // sugar: fixed cadence
 * const clock = Trigger.clock(Sequence.every('30s'));         // explicit Sequence form
 * ```
 *
 * Pass to an accumulator's `trigger` option to switch its emission
 * cadence:
 *
 * ```ts
 * live.rolling('1m', { latency: 'p95' }, {
 *   trigger: Trigger.every('30s'),
 * });
 * ```
 *
 * For partitioned accumulators, a clock trigger synchronises emission
 * across all partitions: when any partition's event crosses a boundary,
 * every partition emits its current rolling-window snapshot at the
 * same boundary timestamp.
 */
export type Trigger = ClockTrigger | CountTrigger | EventTrigger;

/**
 * Sequence-triggered emission. The accumulator emits one snapshot each
 * time a source event crosses an epoch-aligned boundary of `sequence`.
 *
 * - **Output timestamps** are the boundary instants (`Sequence.every('30s')`
 *   → 0, 30 000, 60 000 … ms).
 * - **Data-driven**, not wall-clock-driven. If no source events arrive
 *   during an interval, no event is emitted for that interval.
 * - **One emission per crossing.** A single event jumping multiple
 *   boundaries fires exactly one event at the new bucket's start.
 * - **Synchronised across partitions.** When applied via a partitioned
 *   accumulator's `trigger` option, all partitions share the same
 *   bucket index — any partition's event crossing a boundary fires
 *   emission for every partition at the same instant.
 *
 * Calendar sequences (`Sequence.calendar('day')`) are rejected — boundary
 * indexing requires a constant millisecond step.
 */
export type ClockTrigger = Readonly<{ kind: 'clock'; sequence: Sequence }>;

/**
 * Count-triggered emission. The accumulator emits one snapshot every
 * `n` source events. The first emission fires on the `n`th event, not
 * the first.
 *
 * - **Output timestamps** are the source event's timestamp at the
 *   moment of firing (same as `Trigger.event()`).
 * - **Data-driven** — the counter only advances on event ingestion.
 *   No timer; quiet periods don't fire snapshots.
 * - **Per-partition counting.** When applied via a per-partition
 *   `partitionBy(...).rolling(...)`, each partition counts
 *   independently — a count trigger does not synchronise emission
 *   across partitions. Use `Trigger.clock` for cross-partition
 *   synchronisation.
 *
 * Useful for very hot metrics where event-time boundaries lag during
 * bursts but per-event emission is too noisy (e.g. row stale times,
 * payload sizes). For "every 30s OR every 1000 events," compose with
 * `Trigger.any` (post-v0.13.2 — see PLAN).
 */
export type CountTrigger = Readonly<{ kind: 'count'; n: number }>;

/**
 * Per-event emission. The accumulator emits one snapshot per source
 * event push. This is the default for accumulators that don't specify
 * a trigger; calling `Trigger.event()` explicitly is useful for
 * documentation but produces the same behavior as omitting the option.
 */
export type EventTrigger = Readonly<{ kind: 'event' }>;

/** Sentinel default trigger — frozen, shared. */
const EVENT_TRIGGER: EventTrigger = Object.freeze({ kind: 'event' });

/**
 * Factory for constructing `Trigger` values. See {@link Trigger} for
 * the conceptual overview and {@link ClockTrigger} / {@link EventTrigger}
 * for the individual variants.
 */
export const Trigger = Object.freeze({
  /**
   * Construct a sequence-triggered emission rule. See
   * {@link ClockTrigger} for full semantics.
   *
   * @throws TypeError if `sequence` is calendar-based — boundary indexing
   *   requires a constant millisecond step. Use a fixed-step sequence
   *   (`Sequence.every('30s')`, `Sequence.hourly()`, etc.).
   */
  clock(sequence: Sequence): ClockTrigger {
    if (sequence.kind() !== 'fixed') {
      throw new TypeError(
        'Trigger.clock(sequence) requires a fixed-step Sequence; ' +
          'calendar sequences have no constant boundary spacing.',
      );
    }
    return Object.freeze({ kind: 'clock', sequence });
  },

  /**
   * Sugar for the common case `Trigger.clock(Sequence.every(duration, options))`.
   * Constructs a fixed-cadence sequence trigger without requiring callers
   * to import `Sequence` for trigger-only use sites.
   *
   * ```ts
   * live.rolling('1m', { latency: 'p95' }, {
   *   trigger: Trigger.every('30s'),
   * });
   *
   * // Anchored — same as Trigger.clock(Sequence.every('30s', { anchor: 5_000 })):
   * Trigger.every('30s', { anchor: 5_000 });
   * ```
   *
   * Reach for the explicit {@link Trigger.clock} form when you already
   * hold a `Sequence` object (e.g. one shared across batch
   * `series.aggregate(seq, ...)` and live triggers) — `Trigger.every`
   * always builds a fresh `Sequence`.
   *
   * @throws TypeError if `duration` is not a valid fixed-step duration
   *   string (rejected at `Sequence.every` construction).
   */
  every(
    duration: DurationInput,
    options: { anchor?: TimestampInput } = {},
  ): ClockTrigger {
    return Object.freeze({
      kind: 'clock',
      sequence: Sequence.every(duration, options),
    });
  },

  /**
   * Construct a count-triggered emission rule. See
   * {@link CountTrigger} for full semantics.
   *
   * Useful when event-time boundaries lag under burst load but
   * per-event emission is too noisy. The accumulator fires one
   * snapshot every `n` source events.
   *
   * ```ts
   * live.rolling('5m', mapping, {
   *   trigger: Trigger.count(1000),
   * });
   * ```
   *
   * @throws TypeError if `n` is not a positive integer (zero,
   *   negative, NaN, or non-integer values are rejected).
   */
  count(n: number): CountTrigger {
    if (!Number.isInteger(n) || n <= 0) {
      throw new TypeError(
        `Trigger.count(n) requires a positive integer; received ${n}.`,
      );
    }
    return Object.freeze({ kind: 'count', n });
  },

  /**
   * Construct a per-event trigger. This is the default behaviour of
   * accumulators (`live.rolling(...)` etc.) when no `trigger` option
   * is specified — passing `Trigger.event()` explicitly is documentary.
   */
  event(): EventTrigger {
    return EVENT_TRIGGER;
  },
});

/**
 * Internal helper: compute the bucket index for a timestamp under a
 * clock trigger. Used by accumulators implementing clock-triggered
 * emission.
 */
export function bucketIndexFor(trigger: ClockTrigger, ts: number): number {
  const stepMs = trigger.sequence.stepMs();
  const anchorMs = trigger.sequence.anchor();
  return Math.floor((ts - anchorMs) / stepMs);
}

/**
 * Internal helper: compute the boundary timestamp at the start of a
 * given bucket index for a clock trigger.
 */
export function boundaryTimestampFor(
  trigger: ClockTrigger,
  bucketIdx: number,
): number {
  const stepMs = trigger.sequence.stepMs();
  const anchorMs = trigger.sequence.anchor();
  return anchorMs + bucketIdx * stepMs;
}
