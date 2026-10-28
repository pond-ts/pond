/**
 * Remove the first `n` items of `items` in place and return them.
 *
 * V8's `splice(0, n)` copies every item that stays, so evicting one event
 * from a 10k-event buffer per push cost ~20 µs a push (a `maxEvents: 10_000`
 * series with three views took ~115 s for 1M pushes). `shift()` instead
 * moves the array's start in place, O(1) per item. So: `shift` when few
 * items go, `splice` when a large share goes (then copying the rest is no
 * worse than shifting each one).
 */
export function removeFront<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  if (n * 4 >= items.length) return items.splice(0, n);
  const removed = new Array<T>(n);
  for (let i = 0; i < n; i += 1) removed[i] = items.shift()!;
  return removed;
}

/** {@link removeFront} without collecting what was removed. */
export function dropFront<T>(items: T[], n: number): void {
  if (n <= 0) return;
  if (n * 4 >= items.length) {
    items.splice(0, n);
    return;
  }
  for (let i = 0; i < n; i += 1) items.shift();
}
