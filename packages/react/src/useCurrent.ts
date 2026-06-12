import { useMemo, useRef } from 'react';
import type {
  DurationInput,
  LiveSource,
  ReduceResult,
  SeriesSchema,
  ValidatedAggregateMap,
} from 'pond-ts';
import {
  useSnapshot,
  type SnapshotSource,
  type UseSnapshotOptions,
} from './useSnapshot.js';

export interface UseCurrentOptions extends UseSnapshotOptions {
  /**
   * Trailing window to evaluate the mapping over, expressed as a
   * `DurationInput` (e.g. `'30s'`, `'5m'`, or a number of milliseconds).
   * When omitted, the full snapshot is used.
   */
  tail?: DurationInput;
}

/**
 * Returns `true` if two array cells have identical length and
 * elementwise-equal contents. Element types are always scalars (the
 * reducer registry enforces this), so `===` per element is both
 * correct and cheap for the sizes a dashboard produces.
 */
function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Field-level structural stabilization for a `useCurrent` result.
 *
 * Walks the next result keys and, for any field whose value is
 * structurally equal to the previous render's value, reuses the
 * previous reference. If every field reuses the previous reference
 * AND the key set is unchanged, returns the previous top-level
 * object as-is. Otherwise, returns a fresh object whose stable fields
 * still carry their previous reference.
 *
 * Result: downstream `useMemo([current.host])` / `useEffect` keyed
 * off a specific field only re-fire when that field changes — not
 * when a sibling field changes, and not when a new event push leaves
 * the aggregate unchanged.
 */
function stabilizeFields<R extends Record<string, unknown>>(
  prev: R | null,
  next: R,
): R {
  if (prev === null) return next;

  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return next;

  const result: Record<string, unknown> = {};
  let anyFieldChanged = false;
  for (const key of nextKeys) {
    if (!Object.prototype.hasOwnProperty.call(prev, key)) return next;
    const prevValue = (prev as Record<string, unknown>)[key];
    const nextValue = next[key];
    if (prevValue === nextValue) {
      result[key] = prevValue;
      continue;
    }
    if (
      Array.isArray(prevValue) &&
      Array.isArray(nextValue) &&
      arraysEqual(prevValue, nextValue)
    ) {
      // Arrays with identical contents — reuse the previous reference
      // so field-level dependency arrays stay stable.
      result[key] = prevValue;
      continue;
    }
    result[key] = nextValue;
    anyFieldChanged = true;
  }

  // Every field reused the previous reference — return the original
  // top-level object so the whole-result consumer (`useEffect([current])`)
  // also stays stable.
  return anyFieldChanged ? (result as R) : prev;
}

/**
 * Subscribe to a live source and return the current value of a reducer
 * mapping, updated on a throttle. Equivalent to
 * `useSnapshot(src).tail(tail).reduce(mapping)` but with one subscription,
 * one memo, and narrow per-entry types inherited from
 * `TimeSeries.reduce`.
 *
 * ```ts
 * const current = useCurrent(live, { cpu: 'avg', host: 'unique' });
 * //   ^ { cpu: number | undefined;
 * //       host: ReadonlyArray<ScalarValue> | undefined }
 *
 * const recent = useCurrent(live, { cpu: 'p95' }, { tail: '30s' });
 * ```
 *
 * Returns a stable-shape object while the source has no events (every
 * mapped field is `undefined`), so destructuring on first render is
 * safe.
 *
 * **Reference stability**: when a new event push leaves the reduce
 * output structurally unchanged (same scalar values, same-length arrays
 * with same elements), the previous result reference is returned
 * unchanged. Downstream `useMemo([value])` and `useEffect([value])` only
 * re-run when the value actually changes — no need for a manual
 * `.slice()` or deep-compare equality helper at the call site.
 */
export function useCurrent<
  S extends SeriesSchema,
  // Same per-key validating constraint as the core mapping methods —
  // without it, the both-generic shape (S and Mapping both type
  // parameters here) defers constraint checking entirely and react
  // consumers lose the shorthand guards (caught in #211's L2 review).
  // The inner `reduce(mapping)` call satisfies core's identical
  // constraint by deferral, so no trust cast is needed.
  const Mapping extends ValidatedAggregateMap<S, Mapping>,
>(
  source: SnapshotSource<S> | LiveSource<S> | null,
  mapping: Mapping,
  options?: UseCurrentOptions,
): ReduceResult<S, Mapping> {
  const snap = useSnapshot(source, options);
  const tailOpt = options?.tail;
  const previousResultRef = useRef<ReduceResult<S, Mapping> | null>(null);

  const nextResult = useMemo(() => {
    if (!snap) {
      // Stable empty-shape result so destructuring never explodes on
      // first render.
      const empty: Record<string, unknown> = {};
      for (const key of Object.keys(mapping)) empty[key] = undefined;
      return empty as ReduceResult<S, Mapping>;
    }
    const scoped = tailOpt !== undefined ? snap.tail(tailOpt) : snap;
    return scoped.reduce(mapping) as ReduceResult<S, Mapping>;
  }, [snap, tailOpt, mapping]);

  // Field-level structural stabilization. Every field whose value is
  // unchanged reuses its previous reference; the top-level object
  // reuses its reference when *all* fields are stable. Downstream
  // `useMemo([current.host])` keyed off a specific field only re-runs
  // when that field actually changes, and `useEffect([current])` keyed
  // off the whole result only fires on true change.
  const stabilized = stabilizeFields(
    previousResultRef.current as unknown as Record<string, unknown> | null,
    nextResult as unknown as Record<string, unknown>,
  ) as ReduceResult<S, Mapping>;

  previousResultRef.current = stabilized;
  return stabilized;
}
