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
import { rollingIndexedEntries, rollingSortedExtreme } from './rolling.js';
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
import { difference, rollingDifferenceSorted } from './difference.js';
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
  // `'mean'` is an accepted alias for `'avg'` in aggregate/rolling mappings,
  // matching the column API (`Float64Column.mean()` → the `'avg'` kernel). Keeps
  // the registry free of a duplicate entry. (estela F-reducer-naming.)
  if (operation === 'mean') return avg;
  const q = parsePercentile(operation);
  if (q !== undefined) return percentileReducer(q);
  const n = parseTopN(operation);
  if (n !== undefined) return topReducer(n);
  throw new TypeError(`unsupported aggregate reducer: ${operation}`);
}

/**
 * Non-finite numerics (`NaN` / `±Infinity`) are treated as **missing** by
 * every built-in reducer — the reducer non-finite policy
 * (docs/notes/reducer-nan-policy.md). A number column cannot hold one
 * ([PND-NANREP]), so on input this is now belt-and-braces for a column built
 * through the trusted constructor. Mapping to `undefined` here lets the
 * existing skip-missing logic in each incremental state do the work — so the
 * policy holds for both the batch and live incremental paths without touching
 * any reducer body. Custom-function reducers' *inputs* are intentionally NOT
 * wrapped: they receive values as-is (the escape hatch decides its own
 * semantics).
 *
 * **Results** go through the same mapping, for every reducer — built-in or
 * custom, on every path: a reducer whose answer is non-finite (a `sum` /
 * `avg` that overflows, a `stdev` over values whose squares overflow, a
 * custom function returning `NaN` / `Infinity`) answers **missing**. A
 * reducer result is written into a number column (`aggregate`, `rolling`,
 * the live accumulators), and a non-finite number in a number column means
 * missing.
 */
export function finiteOrMissing(
  value: ColumnValue | undefined,
): ColumnValue | undefined {
  return typeof value === 'number' && !Number.isFinite(value)
    ? undefined
    : value;
}

/** Wrap a bucket state so non-finite numerics are skipped, in and out. {@link finiteOrMissing} */
function skipNonFiniteBucket(
  state: AggregateBucketState,
): AggregateBucketState {
  return {
    add: (value) => state.add(finiteOrMissing(value)),
    snapshot: () => finiteOrMissing(state.snapshot()),
  };
}

/** Wrap a rolling state so non-finite numerics are skipped, in and out. {@link finiteOrMissing} */
function skipNonFiniteRolling(state: RollingReducerState): RollingReducerState {
  return {
    add: (index, value) => state.add(index, finiteOrMissing(value)),
    remove: (index, value) => state.remove(index, finiteOrMissing(value)),
    snapshot: () => finiteOrMissing(state.snapshot()),
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
      return finiteOrMissing(reducer(items));
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
/**
 * Which order a source removes events from its buffer, relative to the
 * order it delivered them. `'arrival'` (append-only sources — the chunked
 * backing, `strict` / `drop`): oldest-arrived first, so a forward-sliding
 * window state is exact. `'sorted'` (`reorder` + retention): the sorted
 * prefix, which may be a later arrival — the windowed states must accept
 * removal of any index ([PND-LIVFIX]).
 */
export type EvictionOrder = 'arrival' | 'sorted';

export function rollingStateFor(
  reducer: AggregateReducer,
  evictionOrder: EvictionOrder = 'arrival',
): RollingReducerState {
  if (typeof reducer === 'string') {
    if (evictionOrder === 'sorted') {
      // [PND-LIVFIX] The forward-sliding-window states assume
      // oldest-arrived-first eviction; swap in the any-order structures
      // for a source that evicts its sorted prefix. Every other built-in
      // already removes by index or by value.
      switch (reducer) {
        case 'min':
          return skipNonFiniteRolling(rollingSortedExtreme('min'));
        case 'max':
          return skipNonFiniteRolling(rollingSortedExtreme('max'));
        case 'first':
          return skipNonFiniteRolling(rollingIndexedEntries('first'));
        case 'last':
          return skipNonFiniteRolling(rollingIndexedEntries('last'));
        case 'difference':
          return skipNonFiniteRolling(rollingDifferenceSorted());
      }
    }
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
      return finiteOrMissing(reducer(Array.from(items.values())));
    },
  };
}
