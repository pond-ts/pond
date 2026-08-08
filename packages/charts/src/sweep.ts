import type { SelectInfo, SweepSession } from './context.js';

/**
 * The 1-D **sweep session** — `<MultiSelector>`'s per-drag range query over a
 * layer's interval marks (interaction RFC A7.6/A7.7).
 *
 * A layer's marks are sorted and non-overlapping on the key axis by
 * construction (bars/bins are bucketed series), so the marks covered by a swept
 * window are one **contiguous index run `[lo, hi)`** — the 1-D analog of the
 * heat map's "four integers" session state. Each {@link SweepSession.update} is
 * two binary searches (O(log N)); the covered run is compared against the last
 * one, so an unchanged frame costs nothing further and the materialised
 * preview refreshes **only when the covered set changed** (A1.4's
 * frame-coalesced, delta-gated preview). {@link SweepSession.hits} caches that
 * materialisation, which is what makes A5.2's "the hits are free at commit
 * time" true here: release reads the same array the preview lit, it never runs
 * a fresh range query.
 *
 * **Capture is by intersection, the span is snapped outward** (the A7.6 edge
 * rule): a mark `[begin, end)` is covered when it intersects the half-open
 * window `[x0, x1)` — `begin < x1 && end > x0` — and
 * {@link SweepSession.extent} reports `[begin(first), end(last))` of the
 * covered run, so `selectionContains`' half-open key test reproduces exactly
 * the captured set (contiguous neighbours fall out on the open side).
 *
 * **Nothing persists** (A7.7): a session is allocated on the pointer-down that
 * survives `DRAG_SLOP` under a mounted `<MultiSelector>` and dropped at
 * release. It snapshots the layer's arrays at press — a mid-drag data update
 * lands on the next gesture, not this one. Consumers who never sweep pay
 * literally zero: no index, no memory, no draw-path branch.
 *
 * Pure and DOM-free, so it unit-tests like `select.ts` does.
 */

/** First index in sorted `xs[0..length)` with `xs[i] > v` (upper bound). */
export function firstAbove(
  xs: ArrayLike<number>,
  length: number,
  v: number,
): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! > v) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** First index in sorted `xs[0..length)` with `xs[i] >= v` (lower bound). */
export function firstAtOrAbove(
  xs: ArrayLike<number>,
  length: number,
  v: number,
): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! >= v) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Stable "nothing covered" identity, so an empty preview never mints arrays. */
const NO_HITS: readonly SelectInfo[] = [];

/**
 * Build a {@link SweepSession} over one layer's sorted, non-overlapping
 * interval marks. The layer supplies its identity and two closures:
 *
 * - `selectable(i)` — whether mark `i` can own membership at all (a gap bar, an
 *   all-gap bin). The covered run's **edges** are trimmed to selectable marks so
 *   the committed span never claims territory whose end marks hold nothing;
 *   interior gaps stay inside the extent and simply own no membership (A7.6's
 *   "holes own no membership").
 * - `materialize(lo, hi)` — the covered marks as the same {@link SelectInfo}s
 *   the layer's `hitTest` would report (skipping unselectable marks itself), so
 *   a swept mark and a clicked mark are indistinguishable downstream.
 */
export function sweep1D(opts: {
  readonly id: string;
  /** Mark key-axis begins, ascending. */
  readonly begin: ArrayLike<number>;
  /** Mark key-axis ends, ascending (marks are non-overlapping). */
  readonly end: ArrayLike<number>;
  readonly length: number;
  selectable(i: number): boolean;
  materialize(lo: number, hi: number): readonly SelectInfo[];
}): SweepSession {
  const { id, begin, end, length, selectable, materialize } = opts;
  // The covered run [curLo, curHi) — empty to start (a press is not a sweep).
  let curLo = 0;
  let curHi = 0;
  let cache: readonly SelectInfo[] = NO_HITS;
  let dirty = false;
  return {
    id,
    update(x0: number, x1: number): boolean {
      // Intersection cut: first mark ending past x0, first mark beginning at or
      // past x1. Two O(log N) probes; empty/reversed windows yield an empty run.
      let lo = firstAbove(end, length, x0);
      let hi = firstAtOrAbove(begin, length, x1);
      if (hi < lo) hi = lo;
      // Trim the run's edges to selectable marks (the span must snap outward
      // to marks that own membership, not to gaps).
      while (lo < hi && !selectable(lo)) lo += 1;
      while (hi > lo && !selectable(hi - 1)) hi -= 1;
      if (lo === curLo && hi === curHi) return false;
      curLo = lo;
      curHi = hi;
      dirty = true;
      return true;
    },
    hits(): readonly SelectInfo[] {
      if (dirty) {
        cache = curHi > curLo ? materialize(curLo, curHi) : NO_HITS;
        dirty = false;
      }
      return cache;
    },
    extent(): readonly [number, number] | null {
      return curHi > curLo ? [begin[curLo]!, end[curHi - 1]!] : null;
    },
  };
}
