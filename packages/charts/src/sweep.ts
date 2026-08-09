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

/**
 * A **2-D** sweep session — the rect gesture, for layers whose marks do not
 * reduce to a run of columns ([PND-INTERACT2D], RFC A7.6/A7.7).
 *
 * The x half is {@link sweep1D}'s exactly: two binary-search probes over the
 * sorted, non-overlapping key spans. A **point** layer passes `begin === end`
 * (a position has no span either side of it), which makes the same cut mean
 * "keys within the window". The y half is the layer's own business — it
 * arrives as a window and the layer's `materialize` applies it, because a
 * scatter filters a continuous value while a heat map picks whole row slots.
 *
 * **No spatial index, deliberately** (Q14): the x cut is `O(log N)` and the y
 * filter is a scan of that run, so nothing persists outside a drag. The
 * delta-gate below is what keeps that affordable — a pointer move that changes
 * neither the run nor the y window re-materialises nothing, which is the
 * lesson A8.1 cost 6.2 s/frame to learn on the 1-D preview.
 */
export function sweep2D(opts: {
  readonly id: string;
  /** Key-axis begins, ascending. Equal to `end` for a point layer. */
  readonly begin: ArrayLike<number>;
  /** Key-axis ends, ascending. Equal to `begin` for a point layer. */
  readonly end: ArrayLike<number>;
  readonly length: number;
  /**
   * Where the committed span's `x` interval comes from. (Not to be confused
   * with `RowLayer.xExtent`, which is the layer's whole key range.)
   *
   * - `'bins'` — the marks **tile** the key axis, so the span snaps outward to
   *   the covered bins' own edges, exactly as 1-D (a heat map).
   * - `'drag'` — the marks are isolated positions with no interval either side
   *   to snap to, so the drag's own half-open window is the span (a scatter).
   *   Deriving `[first.key, last.key]` from the hits looks tighter and is
   *   wrong: `SpanSelection`'s `x` test is half-open, so that span excludes
   *   the very last point the drag captured. The drag window is also what the
   *   `y` channel reports, so a point layer describes both of its dimensions
   *   the same way.
   */
  readonly spanFrom: 'bins' | 'drag';
  /** The marks in key-run `[lo, hi)` that also fall inside `[y0, y1]`. */
  materialize(
    lo: number,
    hi: number,
    y0: number,
    y1: number,
  ): readonly SelectInfo[];
  /** The captured set's second-dimension channels — see
   *  {@link SweepSession.extent2D}. */
  channels(
    hits: readonly SelectInfo[],
    y0: number,
    y1: number,
  ): {
    readonly y?: readonly [number, number];
    readonly rows?: readonly string[];
  } | null;
}): SweepSession {
  const { id, begin, end, length, spanFrom, materialize, channels } = opts;
  let curLo = 0;
  let curHi = 0;
  // The y window is part of the gate: moving the pointer vertically changes
  // the covered set without moving the x run at all.
  let curY0 = 0;
  let curY1 = 0;
  // The drag's raw x window, kept for `spanFrom: 'drag'`.
  let curX0 = 0;
  let curX1 = 0;
  let cache: readonly SelectInfo[] = NO_HITS;
  let dirty = false;
  return {
    id,
    twoD: true,
    update(x0: number, x1: number, y0 = 0, y1 = 0): boolean {
      let lo = firstAbove(end, length, x0);
      let hi = firstAtOrAbove(begin, length, x1);
      if (hi < lo) hi = lo;
      // A point layer's `end === begin`, so a mark sitting exactly on `x0` is
      // excluded by `firstAbove`. Pull it back in: the press pixel is inside
      // the rect the user is drawing, not outside it.
      while (lo > 0 && begin[lo - 1] === x0) lo -= 1;
      curX0 = x0;
      curX1 = x1;
      const [ylo, yhi] = y0 <= y1 ? [y0, y1] : [y1, y0];
      if (lo === curLo && hi === curHi && ylo === curY0 && yhi === curY1) {
        return false;
      }
      curLo = lo;
      curHi = hi;
      curY0 = ylo;
      curY1 = yhi;
      dirty = true;
      return true;
    },
    hits(): readonly SelectInfo[] {
      if (dirty) {
        cache =
          curHi > curLo ? materialize(curLo, curHi, curY0, curY1) : NO_HITS;
        dirty = false;
      }
      return cache;
    },
    extent(): readonly [number, number] | null {
      const hs = this.hits();
      if (hs.length === 0) return null;
      // A point layer reports the drag's own window — see `spanFrom`.
      // Snapping to the hits would give `[first.key, last.key]`, which the
      // half-open test then reads as excluding the last point captured.
      if (spanFrom === 'drag') return [curX0, curX1];
      // Snapped outward exactly as 1-D — but over the marks the **y filter
      // kept**, not the whole x run. A column whose cells all fell outside the
      // rect must not widen the span, or replaying that span would re-select
      // marks the drag never covered.
      //
      // Every mark's `key` IS its `begin` on both 2-D layers, and `materialize`
      // walks the run in index order, so the surviving edges are the first and
      // last hit keys — the right edge found with one `O(log N)` probe rather
      // than a scan.
      const lo = hs[0]!.key;
      const last = hs[hs.length - 1]!.key;
      const i = firstAtOrAbove(begin, length, last);
      return [lo, i < length && begin[i] === last ? end[i]! : last];
    },
    extent2D() {
      const hs = this.hits();
      return hs.length === 0 ? null : channels(hs, curY0, curY1);
    },
  };
}
