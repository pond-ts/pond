/**
 * Shared `history` option handling for live rolling primitives.
 *
 * `LiveRollingAggregation`, `LiveFusedRolling`,
 * `LivePartitionedSyncRolling`, and `LivePartitionedFusedRolling`
 * all expose the same `history: boolean | RetentionPolicy` option
 * on their output buffers. The resolution + retention logic lives
 * here so it stays in lock-step across all four (the partitioned
 * variants used to ignore the option silently — Codex caught it on
 * PR #124's adversarial review).
 */
import type { RetentionPolicy } from './live-series.js';
import { parseDuration } from '../core/duration.js';

export type HistoryOption = boolean | RetentionPolicy;

export type HistoryConfig = {
  /**
   * False when the user passed `history: false`. The accumulator
   * skips the output buffer push entirely; `length` stays at 0
   * and `at(i)` returns undefined. Listeners and `value()` still
   * fire/work because reducer state is independent of retention.
   */
  enabled: boolean;
  /** Cap on the number of retained output events. `Infinity` = no cap. */
  maxEvents: number;
  /** Cap on age of retained output events in ms. `Infinity` = no cap. */
  maxAgeMs: number;
};

/**
 * Validate and resolve a `history` option into the runtime form
 * used by {@link applyHistoryRetention}. `history === undefined` is
 * treated identically to `history === true` — both preserve the
 * historical "retain everything" behavior.
 *
 * **Stricter than `LiveSeries.retention.maxEvents`**: this rejects
 * 0, negative, and non-integer values at construction. Pass
 * `Infinity` or omit the field for no cap.
 */
export function resolveHistoryConfig(
  history: HistoryOption | undefined,
): HistoryConfig {
  if (history === false) {
    return { enabled: false, maxEvents: 0, maxAgeMs: 0 };
  }
  if (history === true || history === undefined) {
    return { enabled: true, maxEvents: Infinity, maxAgeMs: Infinity };
  }
  // RetentionPolicy form.
  let maxEvents: number;
  const max = history.maxEvents;
  if (max === undefined || max === Infinity) {
    maxEvents = Infinity;
  } else if (Number.isInteger(max) && max >= 1) {
    maxEvents = max;
  } else {
    throw new TypeError(
      'history.maxEvents must be a positive integer or Infinity ' +
        '(got ' +
        String(max) +
        ')',
    );
  }
  // `!== undefined` (not truthy) so `maxAge: 0` and `'0ms'` round-
  // trip into parseDuration and surface its rejection — a truthy
  // check would silently turn `maxAge: 0` into "no cap," the
  // opposite of the user's intent.
  const maxAgeMs =
    history.maxAge !== undefined ? parseDuration(history.maxAge) : Infinity;
  return { enabled: true, maxEvents, maxAgeMs };
}

/**
 * Trim `events` against the configured caps. Mirrors
 * {@link LiveSeries.applyRetention}'s shape:
 *   1. Count cap (drops oldest first to bring length down to maxEvents)
 *   2. Age cap (drops events with begin() < latest.begin() - maxAgeMs)
 *   3. Single splice at the merged eviction count
 *
 * Cheap when both caps are `Infinity` (the default) — early-exit
 * on the combined check.
 *
 * Mutates `events` in place. Caller is responsible for only
 * invoking this when `enabled` is true (skipping it on
 * `history: false` is a faster path that avoids the function call
 * altogether).
 */
export function applyHistoryRetention(
  events: { begin(): number }[],
  maxEvents: number,
  maxAgeMs: number,
): void {
  if (maxEvents === Infinity && maxAgeMs === Infinity) {
    return;
  }
  let evictCount = 0;
  if (events.length > maxEvents) {
    evictCount = events.length - maxEvents;
  }
  if (maxAgeMs !== Infinity && events.length > 0) {
    const latest = events[events.length - 1]!;
    const cutoff = latest.begin() - maxAgeMs;
    let i = evictCount;
    while (i < events.length && events[i]!.begin() < cutoff) {
      i++;
    }
    if (i > evictCount) evictCount = i;
  }
  if (evictCount > 0) {
    events.splice(0, evictCount);
  }
}
