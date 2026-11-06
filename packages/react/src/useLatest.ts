import { useEffect, useRef, useState } from 'react';
import type { EventForSchema, LiveSource, SeriesSchema } from 'pond-ts';
import type { SnapshotSource, UseSnapshotOptions } from './useSnapshot.js';
import { onSourceChange } from './changeSignal.js';

/**
 * Subscribe to a live source and return only the latest event.
 *
 * Many dashboard stats only need the most recent value — current CPU, latest
 * count, last price. Building a full `TimeSeries` snapshot for a single event
 * is wasteful. `useLatest` returns just the last event, throttled like
 * `useSnapshot`:
 *
 * ```ts
 * const latest = useLatest(live);
 * // latest?.get('cpu')  → number
 * ```
 *
 * Returns `null` when the source is empty or `null`.
 */
export function useLatest<S extends SeriesSchema>(
  source: SnapshotSource<S> | LiveSource<S> | null,
  options?: UseSnapshotOptions,
): EventForSchema<S> | null {
  const throttleMs = options?.throttle ?? 100;

  const [latest, setLatest] = useState<EventForSchema<S> | null>(() => {
    if (!source || source.length === 0) return null;
    return source.at(source.length - 1) as EventForSchema<S>;
  });

  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!source) {
      setLatest(null);
      return;
    }

    // Re-read on source change
    if (source.length > 0) {
      setLatest(source.at(source.length - 1) as EventForSchema<S>);
    } else {
      setLatest(null);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;

    const flush = () => {
      timer = null;
      pending = false;
      const s = sourceRef.current;
      if (s && s.length > 0) {
        setLatest(s.at(s.length - 1) as EventForSchema<S>);
      }
    };

    const unsub = onSourceChange(source, 'event', () => {
      if (throttleMs === 0) {
        const s = sourceRef.current;
        if (s && s.length > 0) {
          setLatest(s.at(s.length - 1) as EventForSchema<S>);
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

  return latest;
}
