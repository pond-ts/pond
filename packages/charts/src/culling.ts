/**
 * Viewport culling (charts decimator wave, Phase 2). Before a layer strokes its
 * data it clips to the **visible** slice of its key column, so a pan/zoom repaint
 * costs O(visible), not O(N): a 1M-point line panned to show 800px of data draws
 * the ~1k points under the plot, not a million.
 *
 * This is the "slice plumbing" the RFC pipeline (store → viewport/decimator →
 * renderer) puts *before* the M4 decimator (Phase 3): culling narrows the input
 * to the visible window; the decimator later collapses that window to
 * ~plot-width buckets. Culling alone is the win that hits the failing pan metric
 * (#256: 100k line pan 120 → 8 fps), and it lands independently of any
 * decimation semantics — it never changes *which* pixels are drawn, only how
 * many points are walked to draw them.
 *
 * **The §2.3 invariant holds by construction:** culling lives on the *draw* path
 * only. `sampleAt` / `hitTest` / `yExtent` read the full source series (they
 * capture `cs` directly), so a hover readout or selection never shifts when the
 * window resizes — nothing user-facing depends on the visible slice.
 */

import type { ChartSeries, BandSeries } from './data.js';
import type { Scale } from './line.js';

/**
 * The visible x-domain of a chart scale as an ascending `[lo, hi]` pair (epoch
 * ms on a time / trading axis, the axis value on a value axis), or `null` when
 * the scale exposes no numeric domain.
 *
 * The draw contract types `xScale` as a bare `(value) => px` function, but the
 * runtime object is always a real d3 `scaleTime` / `scaleLinear` or a
 * `TradingTimeScale` — all three carry `.domain()`, and the domain **is** the
 * visible range (the container sets it to the current view). Read it through a
 * localized, documented cast rather than widening the draw signature — the same
 * trick {@link baselinePxFromScale} uses for the y-axis floor.
 *
 * Returns `null` (⇒ callers skip culling, drawing the whole series) when:
 * - the scale has no `.domain()` — a bare `(v) => v` test stub; or
 * - the domain isn't a numeric pair — a category {@link ScaleBand}, whose domain
 *   is ordinal category strings (`+string` is `NaN`).
 *
 * A `scaleTime` domain is `[Date, Date]`; `+date` coerces to ms. The pair is
 * returned ascending (sorted defensively) so the bisect bounds are well-ordered
 * even under an unusual reversed domain.
 */
export function scaleDomain(xScale: Scale): [number, number] | null {
  const d = (xScale as unknown as { domain?: () => unknown[] }).domain?.();
  if (d === undefined || d.length < 2) return null;
  const lo = +(d[0] as number);
  const hi = +(d[d.length - 1] as number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/** First index `i` in `x[0..n)` with `x[i] >= v` (`n` if none) — lower bound. */
function lowerBound(x: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index `i` in `x[0..n)` with `x[i] > v` (`n` if none) — upper bound. */
function upperBound(x: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The index window `[start, end)` of a **monotonically ascending** key column
 * `x` (logical length `length`) that covers the visible range `[lo, hi]` plus
 * `margin` points on **each** side. Pure, O(log length) — two binary searches,
 * no allocation.
 *
 * The margin points are the **entry / exit** samples: the last point left of the
 * viewport and the first point right of it, so the line segment that *crosses*
 * each plot edge is still drawn (drop them and the line would stop at the first
 * in-view point, leaving a visible notch at each edge under a pan). `margin = 1`
 * is exact for a straight (linear) segment — the crossing segment's two
 * endpoints are both present. A smoothing `curve` (monotone) computes an
 * interior point's tangent from a wider neighbourhood, so the *entry segment*
 * itself can differ by a sub-pixel from the un-culled render at the very edge;
 * the visible boundary point's own tangent stays exact (its neighbours are both
 * in the slice). Pixel-identity across the whole edge is an M4 (Phase 3)
 * concern, not culling's.
 *
 * Degenerate cases fall out of the two bounds:
 * - **Whole series visible** — `[0, length]` (the caller then skips the slice).
 * - **Series entirely left of the view** (`hi < x[0]`) — `[length-1, length]`,
 *   a one-point off-screen slice that strokes nothing.
 * - **Series entirely right of the view** (`lo > x[last]`) — `[0, 1]`, likewise.
 * - **Empty series** — `[0, 0]`.
 */
export function visibleWindow(
  x: Float64Array,
  length: number,
  lo: number,
  hi: number,
  margin = 1,
): [number, number] {
  if (length === 0) return [0, 0];
  const left = lowerBound(x, length, lo); // first index with x[i] >= lo
  const right = upperBound(x, length, hi); // first index with x[i] > hi
  const start = Math.max(0, left - margin);
  const end = Math.min(length, right + margin);
  return [start, end];
}

/**
 * A {@link ChartSeries} clipped to the visible window of `xScale` (+`margin`
 * points each side). Returns the **same object** untouched when the whole series
 * is in view or the scale exposes no domain (a test stub / category axis) — so
 * the common "everything fits" frame allocates nothing and the draw stays
 * byte-identical to the pre-culling pass. Otherwise the returned view is a
 * zero-copy `subarray` of the source buffers (the source is immutable by
 * contract, so aliasing is safe).
 *
 * **Gap-mode neutrality.** After the pixel bisect, each boundary is walked
 * outward past any non-finite (`NaN` gap) run until the slice's first and last
 * samples are **finite** (or the buffer end is hit). Without this, a gap wider
 * than `margin` straddling a plot edge would drop the finite anchor sitting
 * >`margin` points off-screen, turning an *interior* gap into a *leading /
 * trailing* one inside the slice — which `bridgeGaps` and `collectGapEdges` both
 * leave broken (they only bridge gaps with a finite sample on *both* sides). The
 * `none` / `dashed` / `step` / `fade` connector that crossed the edge would then
 * vanish (a notch under pan). Re-including the anchor keeps the boundary gap
 * *interior*, so every mode draws exactly as it does un-culled. Cost is one
 * `isFinite` check per side in the common (finite-boundary) case; the walk only
 * runs for an edge-straddling gap and is bounded by that gap's width. (The
 * default `empty` mode breaks at gaps regardless, so it is unaffected either
 * way — this makes the guarantee hold for *all* modes.)
 */
export function cullChartSeries(
  cs: ChartSeries,
  xScale: Scale,
  margin = 1,
): ChartSeries {
  if (cs.length === 0) return cs;
  const dom = scaleDomain(xScale);
  if (dom === null) return cs;
  let [start, end] = visibleWindow(cs.x, cs.length, dom[0], dom[1], margin);
  // Extend each boundary to the nearest finite y-anchor so a gap straddling the
  // edge stays interior (see "Gap-mode neutrality" above).
  while (start > 0 && !Number.isFinite(cs.y[start]!)) start -= 1;
  while (end < cs.length && !Number.isFinite(cs.y[end - 1]!)) end += 1;
  if (start === 0 && end === cs.length) return cs; // whole series in view
  return {
    x: cs.x.subarray(start, end),
    y: cs.y.subarray(start, end),
    length: end - start,
  };
}

/**
 * A {@link BandSeries} clipped to the visible window of `xScale` — the paired
 * `lower`/`upper` edges culled in lockstep with the shared `x` axis, so the
 * envelope stays aligned. Same identity-preserving fast path and zero-copy
 * `subarray` view as {@link cullChartSeries}.
 *
 * Unlike {@link cullChartSeries} this needs **no** finite-anchor boundary walk:
 * a band has no gap-bridge mode (`drawBand` always breaks the fill at a gap, it
 * never interpolates one), so a gap straddling a plot edge is a hole on both
 * sides of the cut — there is no crossing fill to lose. The `margin` entry/exit
 * sample is enough for a gap-free envelope that spans the edge.
 */
export function cullBandSeries(
  band: BandSeries,
  xScale: Scale,
  margin = 1,
): BandSeries {
  if (band.length === 0) return band;
  const dom = scaleDomain(xScale);
  if (dom === null) return band;
  const [start, end] = visibleWindow(
    band.x,
    band.length,
    dom[0],
    dom[1],
    margin,
  );
  if (start === 0 && end === band.length) return band; // whole band in view
  return {
    x: band.x.subarray(start, end),
    lower: band.lower.subarray(start, end),
    upper: band.upper.subarray(start, end),
    length: end - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Index-range culling for **per-mark** layers (scatter, bars, candles, boxes).
//
// Unlike the line/area/band draws — which stroke one continuous path and take a
// zero-copy `subarray` view — these layers loop over *independent* marks with
// **index-keyed accessors** (a scatter's `colorAt(i)` / `keyAt(i)`, a bar's
// `begin[i]` selection match). A subarray would renumber `i` and break those, so
// the fit is instead a visible `[start, end)` **index range** the draw loop runs
// over (`for (i = start; i < end; …)`), leaving every accessor's `i` intact and
// the source arrays untouched (the §2.3 interaction-reads-source invariant holds
// the same way — hit-tests still scan the full arrays).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The index range `[start, end)` of **interval marks** — each spanning
 * `[begin[i], end[i]]` on a **monotonically ascending** `begin` axis — whose span
 * overlaps the visible `[lo, hi]`, plus `margin` marks on each side. A mark is
 * visible iff `end[i] >= lo && begin[i] <= hi`.
 *
 * - **Right:** `begin[i] <= hi` ⇒ everything below `upperBound(begin, hi)`; a
 *   mark starting past the right edge is off-screen. Exact — no bisect on `end`
 *   needed.
 * - **Left:** a mark with `begin[i] < lo` is still visible if its span reaches
 *   `lo` (`end[i] >= lo`) — a wide bar crossing the left edge. `begin` bisects
 *   the first in-range mark; from there the scan walks back while the previous
 *   mark's `end` still reaches `lo`. For sorted non-overlapping marks (the bar /
 *   candle / box contract) `end` is ascending, so the walk stops at the first
 *   mark clear of the edge — typically one step.
 *
 * Pure, O(log length + crossing marks). `margin` (default 1) pads each side for
 * a mark whose drawn rect is nudged by `gapPx` / `minWidth` / a pixel `offsetPx`
 * the data-space window can't see.
 */
export function visibleSpanWindow(
  begin: Float64Array,
  end: Float64Array,
  length: number,
  lo: number,
  hi: number,
  margin = 1,
): [number, number] {
  if (length === 0) return [0, 0];
  const right = upperBound(begin, length, hi); // first begin > hi
  let start = lowerBound(begin, length, lo); // first begin >= lo
  // Walk back to include earlier marks whose span still crosses into [lo, …].
  while (start > 0 && end[start - 1]! >= lo) start -= 1;
  return [Math.max(0, start - margin), Math.min(length, right + margin)];
}

/**
 * The visible `[start, end)` index range of a **point** layer (scatter) against
 * `xScale` — a thin wrapper over {@link visibleWindow} that reads the scale's
 * domain. Returns the **full** range `[0, length]` when the scale exposes no
 * numeric domain (a bare test stub / category axis) or the series is empty, so a
 * caller loops over everything and the draw is unchanged there.
 */
export function visiblePointRange(
  x: Float64Array,
  length: number,
  xScale: Scale,
  margin = 1,
): [number, number] {
  if (length === 0) return [0, 0];
  const dom = scaleDomain(xScale);
  if (dom === null) return [0, length];
  return visibleWindow(x, length, dom[0], dom[1], margin);
}

/**
 * The visible `[start, end)` index range of an **interval** layer (bars,
 * candles, boxes) against `xScale` — a thin wrapper over
 * {@link visibleSpanWindow} that reads the scale's domain. Returns the **full**
 * range `[0, length]` when the scale exposes no numeric domain or the series is
 * empty (the draw is unchanged there — a bare stub / category axis draws all).
 */
export function visibleSpanRange(
  begin: Float64Array,
  end: Float64Array,
  length: number,
  xScale: Scale,
  margin = 1,
): [number, number] {
  if (length === 0) return [0, 0];
  const dom = scaleDomain(xScale);
  if (dom === null) return [0, length];
  return visibleSpanWindow(begin, end, length, dom[0], dom[1], margin);
}
