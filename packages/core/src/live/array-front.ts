/**
 * Arrays up to this many items stay out of V8's large-object space (128 KB
 * of 8-byte slots), where `shift()` can move the array's start in place.
 * Past it, `shift()` copies the whole array, like `splice`.
 */
const IN_PLACE_SHIFT_MAX = 16_000;

/**
 * Whether to drop the first `n` of `length` items with `shift()` calls
 * rather than one `splice(0, n)`.
 *
 * V8's `splice(0, n)` copies every item that stays, so evicting one event
 * from a 10k-event buffer per push cost ~20 µs a push (a `maxEvents: 10_000`
 * series with three views took ~115 s for 1M pushes). `shift()` on an array
 * small enough for V8 to move its start in place is O(1) per item. On a
 * larger array each `shift()` copies the array too, so a loop of them
 * costs `n` copies against `splice`'s one: there only a single item is
 * shifted (measured no worse than `splice`).
 */
function shiftBeatsSplice(n: number, length: number): boolean {
  return length <= IN_PLACE_SHIFT_MAX ? n * 4 < length : n === 1;
}

/** Remove the first `n` items of `items` in place and return them. */
export function removeFront<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  if (!shiftBeatsSplice(n, items.length)) return items.splice(0, n);
  const removed = new Array<T>(n);
  for (let i = 0; i < n; i += 1) removed[i] = items.shift()!;
  return removed;
}

/** {@link removeFront} without collecting what was removed. */
export function dropFront<T>(items: T[], n: number): void {
  if (n <= 0) return;
  if (!shiftBeatsSplice(n, items.length)) {
    items.splice(0, n);
    return;
  }
  for (let i = 0; i < n; i += 1) items.shift();
}
