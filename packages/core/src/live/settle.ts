/**
 * [PND-REDUCETICK] Internal end-of-push hook.
 *
 * A `LiveSeries` push runs in fixed phases: each row's `'event'`, then
 * retention, then `'batch'`, then `'evict'`. Some operators (today only
 * `LiveReduce`) must emit once per push and only after retention has
 * trimmed the buffer, i.e. after `'evict'`. The root series fires its
 * settle listeners exactly once at the end of every push, still inside
 * the push, so those operators can emit synchronously instead of on a
 * microtask (which made the number of outputs depend on where the
 * caller awaited).
 *
 * Derived live sources (views, aggregations, rolling) forward the hook
 * to their own source, so it always reaches the root series. A source
 * that does not offer it returns `undefined`; the caller then falls
 * back to a microtask.
 *
 * @internal
 */
export function onSourceSettle(
  source: unknown,
  fn: () => void,
): (() => void) | undefined {
  const s = source as {
    _onSettle?: (fn: () => void) => (() => void) | undefined;
  };
  return typeof s._onSettle === 'function' ? s._onSettle(fn) : undefined;
}
