import { useMemo, useSyncExternalStore } from 'react';
import type { LiveSource, SeriesSchema } from 'pond-ts';

// The capability marker pond-ts stamps on evict-emitting sources
// (`LiveSeries`, `LiveView`). It's a registered symbol
// (`Symbol.for('pond-ts:emitsEvict')` in pond-ts), so reconstructing it
// here yields the identical symbol — no import needed. The
// `clear-evicts-without-event` test guards against key drift.
const EMITS_EVICT = Symbol.for('pond-ts:emitsEvict');

export interface UseLiveVersionOptions {
  /**
   * Minimum interval between React notifications, in ms. The version
   * counter bumps *immediately* on every source change (no buffering);
   * `throttle` only bounds how often React is told to re-render.
   * `0` notifies synchronously per change. Default 100.
   */
  throttle?: number;
}

/**
 * The React change signal for reading columns off a live source without
 * manufacturing a `TimeSeries` snapshot (§A pull/read, experimental).
 *
 * `LiveSeries` / `LiveView` mutate in place, so a `useMemo([liveView])`
 * keyed on the view never re-runs. This hook gives React a
 * monotonically-increasing version that changes (at most once per
 * `throttle`) whenever the source mutates — the missing invalidation
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
 * Tracks **both** append (`'event'`) and eviction (`'evict'`, on sources
 * that emit it — e.g. `clear()` / retention prune), and advances the
 * revision on subscribe so a change between render and the subscribe
 * effect is still picked up (the `useSyncExternalStore` post-subscribe
 * re-read). Experimental (0.19.0) — surface may change in 0.19.x.
 */
export function useLiveVersion<S extends SeriesSchema>(
  source: LiveSource<S>,
  options?: UseLiveVersionOptions,
): number {
  const throttleMs = options?.throttle ?? 100;

  const store = useMemo(() => {
    let version = 0; // bumped on every observed source mutation
    let committed = 0; // last version React has been notified about
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubSource: (() => void) | null = null;
    const listeners = new Set<() => void>();

    const flush = (): void => {
      timer = null;
      committed = version;
      for (const l of listeners) l();
    };
    const onChange = (): void => {
      version += 1;
      if (throttleMs <= 0) {
        flush();
      } else if (timer === null) {
        timer = setTimeout(flush, throttleMs);
      }
    };

    return {
      subscribe(cb: () => void): () => void {
        listeners.add(cb);
        if (unsubSource === null) {
          const unsubEvent = source.on('event', onChange);
          // Also track eviction (clear / retention prune) on sources that
          // emit it — otherwise a `clear()` with no following append leaves
          // a column reader stale.
          let unsubEvict: (() => void) | undefined;
          if (EMITS_EVICT in source) {
            unsubEvict = (
              source as unknown as {
                on(type: 'evict', fn: () => void): () => void;
              }
            ).on('evict', onChange);
          }
          unsubSource = () => {
            unsubEvent();
            unsubEvict?.();
          };
        }
        // Close the render-before-subscribe gap: a mutation between render
        // and this effect fires no observed callback, so advance the
        // revision now. useSyncExternalStore re-reads getSnapshot after
        // subscribe; the bumped value forces one re-render that re-reads
        // the (now-current) view.
        version += 1;
        committed = version;
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
      // Stable between notifications — only advances at flush / subscribe,
      // exactly when React is told. (Returning the live `version` would
      // violate the getSnapshot contract.)
      getSnapshot: (): number => committed,
    };
  }, [source, throttleMs]);

  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
