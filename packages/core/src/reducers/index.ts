export type {
  ReducerDef,
  AggregateBucketState,
  RollingReducerState,
} from './types.js';

import type {
  AggregateBucketState,
  ReducerDef,
  RollingReducerState,
} from './types.js';
import type { AggregateReducer, ColumnValue } from '../schema/index.js';
import { parsePercentile, percentileReducer } from './percentile.js';
import { parseTopN, topReducer } from './top.js';

import { count } from './count.js';
import { sum } from './sum.js';
import { avg } from './avg.js';
import { min } from './min.js';
import { max } from './max.js';
import { first } from './first.js';
import { last } from './last.js';
import { median } from './median.js';
import { stdev } from './stdev.js';
import { difference } from './difference.js';
import { keep } from './keep.js';
import { samples } from './samples.js';
import { unique } from './unique.js';

export { top } from './top.js';

const registry: Record<string, ReducerDef> = {
  count,
  sum,
  avg,
  min,
  max,
  first,
  last,
  median,
  stdev,
  difference,
  keep,
  samples,
  unique,
};

export function resolveReducer(operation: string): ReducerDef {
  const r = registry[operation];
  if (r) return r;
  const q = parsePercentile(operation);
  if (q !== undefined) return percentileReducer(q);
  const n = parseTopN(operation);
  if (n !== undefined) return topReducer(n);
  throw new TypeError(`unsupported aggregate reducer: ${operation}`);
}

/**
 * Non-finite numerics (`NaN` / `±Infinity`) are treated as **missing** by
 * every built-in reducer — the reducer non-finite policy
 * (docs/notes/reducer-nan-policy.md). Row intake keeps user data finite; these
 * values only arise inside computed columns (e.g. `cumulative` overflow) or
 * trusted construction, and skipping them keeps every reducer consistent
 * across all four execution paths. Mapping to `undefined` here lets the
 * existing skip-missing logic in each incremental state do the work — so the
 * policy holds for both the batch and live incremental paths without touching
 * any reducer body. Custom-function reducers are intentionally NOT wrapped:
 * they receive values as-is (the escape hatch decides its own semantics).
 */
function finiteOrMissing(
  value: ColumnValue | undefined,
): ColumnValue | undefined {
  return typeof value === 'number' && !Number.isFinite(value)
    ? undefined
    : value;
}

/** Wrap a bucket state so non-finite numerics are skipped. {@link finiteOrMissing} */
function skipNonFiniteBucket(
  state: AggregateBucketState,
): AggregateBucketState {
  return {
    add: (value) => state.add(finiteOrMissing(value)),
    snapshot: () => state.snapshot(),
  };
}

/** Wrap a rolling state so non-finite numerics are skipped. {@link finiteOrMissing} */
function skipNonFiniteRolling(state: RollingReducerState): RollingReducerState {
  return {
    add: (index, value) => state.add(index, finiteOrMissing(value)),
    remove: (index, value) => state.remove(index, finiteOrMissing(value)),
    snapshot: () => state.snapshot(),
  };
}

/**
 * Build an `AggregateBucketState` for a reducer that may be either a
 * built-in name (string) or a custom function. Built-ins use their
 * dedicated incremental machinery (O(1) `add`, O(1) `snapshot`).
 * Custom functions use a generic adapter that buffers values and
 * runs the function once per `snapshot()` call (O(N) per snapshot).
 *
 * Used by `LiveAggregation` and the batch aggregation path.
 */
export function bucketStateFor(
  reducer: AggregateReducer,
): AggregateBucketState {
  if (typeof reducer === 'string') {
    return skipNonFiniteBucket(resolveReducer(reducer).bucketState());
  }
  // Custom-function adapter: buffer values, call fn at snapshot time.
  const items: Array<ColumnValue | undefined> = [];
  return {
    add(v) {
      items.push(v);
    },
    snapshot() {
      return reducer(items);
    },
  };
}

/**
 * Build a `RollingReducerState` for a reducer that may be either a
 * built-in name (string) or a custom function. Built-ins use their
 * dedicated incremental machinery (O(1) `add`/`remove`/`snapshot`).
 *
 * Custom functions use a generic adapter:
 * - `add(idx, v)` stores into a Map keyed by event index.
 * - `remove(idx, v)` deletes by index.
 * - `snapshot()` calls the function with the current window's values
 *   in arrival order — O(N) per snapshot.
 *
 * **Performance characteristic.** Per-event cost is O(1) for state
 * maintenance but `snapshot` is O(window size) — the function re-
 * runs over every value in the current window each time the
 * accumulator emits. Compare to built-in reducers which maintain a
 * running result incrementally and snapshot in O(1).
 *
 * For high-throughput live use, prefer built-ins or `'samples'`
 * (which lets you compute the custom logic once at the consumer,
 * after the rolling has already collapsed events to the value list).
 * Custom-function reducers shine on low-rate streams where
 * convenience matters more than per-snapshot cost.
 */
export function rollingStateFor(
  reducer: AggregateReducer,
): RollingReducerState {
  if (typeof reducer === 'string') {
    return skipNonFiniteRolling(resolveReducer(reducer).rollingState());
  }
  // Custom-function adapter: Map keyed by event index for O(1) remove.
  const items = new Map<number, ColumnValue | undefined>();
  return {
    add(index, v) {
      items.set(index, v);
    },
    remove(index, _v) {
      items.delete(index);
    },
    snapshot() {
      return reducer(Array.from(items.values()));
    },
  };
}
