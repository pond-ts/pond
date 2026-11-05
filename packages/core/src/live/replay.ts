import type { EventForSchema, SeriesSchema } from '../schema/index.js';

/**
 * @internal Feeds every row a live source already holds to `fn`, in order.
 * A `LiveSeries` hands them over without filling its per-row event cache
 * ([PND-LIVEREPLAY]); any other source is read with `at(i)`.
 */
export function replaySource<S extends SeriesSchema>(
  source: {
    readonly length: number;
    at(i: number): EventForSchema<S> | undefined;
  },
  fn: (event: EventForSchema<S>) => void,
): void {
  const fast = (
    source as {
      _forEachEventModulePrivate?: (f: (e: EventForSchema<S>) => void) => void;
    }
  )._forEachEventModulePrivate;
  if (typeof fast === 'function') {
    fast.call(source, fn);
    return;
  }
  for (let i = 0; i < source.length; i++) fn(source.at(i)!);
}
