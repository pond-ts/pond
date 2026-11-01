import { useEffect, useRef, useState } from 'react';
import type { LiveSource, SeriesSchema } from 'pond-ts';
import type { TimeSeries } from 'pond-ts';
import { takeSnapshot } from './takeSnapshot.js';
import { onSourceChange } from './changeSignal.js';

export interface UseSnapshotOptions {
  /** Minimum milliseconds between snapshot rebuilds. Default 100. Set to 0 for immediate. */
  throttle?: number;
}

/**
 * Structural type covering all pond-ts live objects (`LiveSeries`, `LiveView`,
 * `LiveAggregation`, `LiveRollingAggregation`).
 *
 * Using a structural type instead of the nominal `LiveSource<S>` avoids casts
 * when passing `LiveAggregation` (whose output schema differs from its input
 * type parameter).
 */
export type SnapshotSource<S extends SeriesSchema = SeriesSchema> = {
  readonly name: string;
  readonly schema: S;
  readonly length: number;
  at(index: number): unknown;
  on(type: 'event', fn: (...args: any[]) => void): () => void;
};

/**
 * Subscribe to any live source and return a throttled `TimeSeries` snapshot.
 *
 * The snapshot updates at most once per `throttle` interval (default 100 ms).
 * Returns `null` when the source is empty or `null`.
 *
 * Accepts `LiveSource`, `LiveAggregation`, `LiveRollingAggregation`, or any
 * object with a compatible shape — no casts needed.
 *
 * Accepts `null` as a source so hooks like `useWindow` can pass a
 * not-yet-created source without violating the Rules of Hooks.
 */
export function useSnapshot<S extends SeriesSchema>(
  source: SnapshotSource<S> | LiveSource<S> | null,
  options?: UseSnapshotOptions,
): TimeSeries<S> | null {
  const throttleMs = options?.throttle ?? 100;
  const [snapshot, setSnapshot] = useState<TimeSeries<S> | null>(() =>
    source ? (takeSnapshot(source as LiveSource<S>) as TimeSeries<S>) : null,
  );

  // Track the latest source so the flush callback always reads current state.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!source) {
      setSnapshot(null);
      return;
    }

    // Re-snapshot on source change
    setSnapshot(takeSnapshot(source as LiveSource<S>) as TimeSeries<S>);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;

    const flush = () => {
      timer = null;
      pending = false;
      if (sourceRef.current) {
        setSnapshot(
          takeSnapshot(sourceRef.current as LiveSource<S>) as TimeSeries<S>,
        );
      }
    };

    const unsub = onSourceChange(source, 'event', () => {
      if (throttleMs === 0) {
        if (sourceRef.current) {
          setSnapshot(
            takeSnapshot(sourceRef.current as LiveSource<S>) as TimeSeries<S>,
          );
        }
        return;
      }
      if (!pending) {
        pending = true;
        timer = setTimeout(flush, throttleMs);
      }
    });

    return () => {
      unsub();
      if (timer !== null) clearTimeout(timer);
    };
  }, [source, throttleMs]);

  return snapshot;
}
