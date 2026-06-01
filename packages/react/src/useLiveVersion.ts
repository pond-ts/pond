import { useMemo, useSyncExternalStore } from 'react';
import type { LiveSource, SeriesSchema } from 'pond-ts';

export interface UseLiveVersionOptions {
  /**
   * Minimum interval between React notifications, in ms. The version
   * counter bumps *immediately* on every source event (no buffering);
   * `throttle` only bounds how often React is told to re-render.
   * `0` notifies synchronously per event. Default 100.
   */
  throttle?: number;
}

/**
 * §A prong-2 spike — the React change signal for reading columns off a
 * live source without manufacturing a `TimeSeries` snapshot.
 *
 * `LiveSeries` / `LiveView` mutate in place, so a `useMemo([liveView])`
 * keyed on the view never re-runs. This hook gives React a
 * monotonically-increasing version that changes (at most once per
 * `throttle`) whenever the source appends — the missing invalidation
 * trigger. Read columns straight off the live view, keyed on the
 * returned version:
 *
 * ```tsx
 * const view = useMemo(() => live.window('5m'), [live]);
 * const v = useLiveVersion(view, { throttle: 200 });
 * const series = useMemo(
 *   () => view.partitionBy('host').toMap((g) => ({
 *     ts: g.keyColumn().begin,
 *     cpu: g.column('cpu').toFloat64Array(),
 *   })),
 *   [view, v],
 * );
 * ```
 *
 * Built on `useSyncExternalStore` (tearing-safe). Shape not stable;
 * gated on API sign-off before any merge.
 */
export function useLiveVersion<S extends SeriesSchema>(
  source: LiveSource<S>,
  options?: UseLiveVersionOptions,
): number {
  const throttleMs = options?.throttle ?? 100;

  const store = useMemo(() => {
    let version = 0; // bumped immediately on every source event
    let committed = 0; // last version React has been notified about
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubSource: (() => void) | null = null;
    const listeners = new Set<() => void>();

    const flush = (): void => {
      timer = null;
      committed = version;
      for (const l of listeners) l();
    };

    return {
      subscribe(cb: () => void): () => void {
        listeners.add(cb);
        // Subscribe to the source lazily on the first listener.
        if (unsubSource === null) {
          unsubSource = source.on('event', () => {
            version += 1;
            if (throttleMs <= 0) {
              flush();
            } else if (timer === null) {
              timer = setTimeout(flush, throttleMs);
            }
          });
        }
        return () => {
          listeners.delete(cb);
          if (listeners.size === 0) {
            unsubSource?.();
            unsubSource = null;
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
          }
        };
      },
      // Stable between notifications — only advances at flush, exactly
      // when listeners are told. (Returning the live `version` would
      // violate useSyncExternalStore's getSnapshot contract.)
      getSnapshot: (): number => committed,
    };
  }, [source, throttleMs]);

  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
