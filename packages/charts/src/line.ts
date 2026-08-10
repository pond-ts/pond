import { line as d3line, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import type { LineStyle } from './theme.js';
import type { LayerDrawStats } from './context.js';
import { cullChartSeries } from './culling.js';
import { decimateM4Cached, type DecimateOption } from './decimate.js';
import { affineOf, type Affine } from './affine.js';
import {
  bridgeGaps,
  collectGapEdges,
  drawGapBridges,
  drawGapFades,
  drawGapSteps,
  gapUnscalable,
  DEFAULT_GAP_MODE,
  DEFAULT_GAP_CONNECTOR_OPACITY,
  type GapEdge,
  type GapMode,
} from './gaps.js';

/** Shared empty boundary list — passed to `sessionRuns` when a decimated series
 *  already carries its session breaks as baked-in `NaN` points. */
const EMPTY_BOUNDARIES: readonly number[] = [];

/** Maps a data value to a pixel coordinate (a d3 scale is assignable to this). */
export type Scale = (value: number) => number;

/**
 * Stroke one run of `ys` (aligned index-for-index with `xs`) through the affine
 * pixel maps `ax` / `ay` — the [PND-AFFINE] fast path. Replicates d3-shape's
 * `curveLinear` + `.defined(Number.isFinite)` behaviour exactly: a non-finite
 * value lifts the pen (the next finite point `moveTo`s a fresh subpath), a
 * finite value `lineTo`s (or `moveTo`s when the pen is up), so a gap breaks and
 * a lone point draws nothing — the same op sequence the generator emits, minus
 * the per-point `scale()` + d3-shape closures. The caller brackets
 * `beginPath`/`stroke`; `xs`/`ys` are the run (a `subarray` view, so index 0 is
 * the run start). Used for lines and for the area outline.
 */
export function strokeAffinePolyline(
  ctx: CanvasRenderingContext2D,
  xs: Float64Array,
  ys: Float64Array,
  ax: Affine,
  ay: Affine,
): void {
  const n = ys.length;
  let penDown = false;
  for (let j = 0; j < n; j += 1) {
    const v = ys[j]!;
    if (!Number.isFinite(v)) {
      penDown = false;
      continue;
    }
    const px = (xs[j]! - ax.v0) * ax.k + ax.p0;
    const py = (v - ay.v0) * ay.k + ay.p0;
    if (penDown) ctx.lineTo(px, py);
    else {
      ctx.moveTo(px, py);
      penDown = true;
    }
  }
}

/**
 * The y-scale's domain lower bound (the axis floor) in pixels — where the
 * `step` / `fade` gap bridges drop to. The runtime `yScale` is a d3
 * `ScaleLinear` (it carries `.domain()`); read the bound through a localized,
 * documented shape rather than widening the draw contract to d3-scale. Falls
 * back to `0` if the scale exposes no domain.
 */
export function baselinePxFromScale(yScale: Scale): number {
  const d = (yScale as unknown as { domain?: () => number[] }).domain?.();
  return yScale(d && d.length > 0 ? d[0]! : 0);
}

/**
 * The `[min, max]` of the **finite** values in `cs.y`, or `null` if none are
 * finite. NaN (the gap signal) is ignored, so a coast doesn't drag the domain.
 */
export function yExtent(cs: ChartSeries): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < cs.length; i += 1) {
    const v = cs.y[i]!;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min === Infinity ? null : [min, max];
}

/**
 * Stroke a line for `cs`, mapping data→pixels through `xScale`/`yScale` and
 * connecting points with `curve` (d3-shape; default linear).
 *
 * Built on d3-shape's `line()`. **Gap handling is driven by `gaps`** (a
 * {@link GapMode}, default `'empty'`):
 *
 * - `'empty'` (default) — `.defined(Number.isFinite)`: a non-finite value ends
 *   the current subpath and the next finite point starts a fresh one (`moveTo`,
 *   not `lineTo`), so a coast reads as a break, not a `lineTo(NaN, …)` bridge
 *   (`docs/rfcs/charts.md` trap #2).
 * - `'none'` — interior gaps are linearly interpolated ({@link bridgeGaps}) so
 *   the line bridges straight across (real `lineTo`s, robust to leading /
 *   trailing gaps, which stay a break). The one non-honest mode.
 * - `'dashed'` / `'step'` / `'fade'` — the **solid** segments break exactly as
 *   in `'empty'`, then a second pass draws the inferred bridge across each
 *   interior gap: a dashed straight line, a flat dashed line at the average of
 *   the edge values, or estela's fade-to-baseline (the axis floor). `dashed` /
 *   `step` are drawn faint (`gapConnectorOpacity`); the gap edges are collected
 *   by one O(N) walk ({@link collectGapEdges}).
 *
 * The generator writes path ops to `ctx`; we bracket with `beginPath`/`stroke`.
 * `cs.y` (a `Float64Array`) is the datum iterable — `y` reads the value, `x`
 * reads `cs.x[i]` by index, so there's no per-point object allocation.
 *
 * **`boundaries`** (default none) are discontinuity instants — a trading-axis
 * session/day/lunch close→open where the line should *break* even though a data
 * point sits on each side (see {@link sessionRuns}). Each run between boundaries
 * draws as its own subpath, so the line ends at the last pre-boundary point and
 * re-starts at the first post-boundary one — a **scale** break, orthogonal to
 * the NaN **data** gaps (`gaps`) handled within each run. With no boundaries the
 * output is identical to a single-pass draw.
 */
export function drawLine(
  ctx: CanvasRenderingContext2D,
  cs: ChartSeries,
  xScale: Scale,
  yScale: Scale,
  style: LineStyle,
  curve: CurveFactory = curveLinear,
  gaps: GapMode = DEFAULT_GAP_MODE,
  gapConnectorOpacity: number = DEFAULT_GAP_CONNECTOR_OPACITY,
  boundaries: readonly number[] = [],
  decimate: DecimateOption = true,
): LayerDrawStats {
  const sourceCount = cs.length; // pre-cull, pre-decimation (for draw stats)
  const source = cs; // pre-cull source — the decimation cache key ([PND-DECKEY])
  // Two paths clip `cs` to what actually draws:
  //  - **Decimated** (linear curve, `decimate !== false`): cull to the visible
  //    slice, then replace it with the pixel-dense M4 polyline ({@link decimateM4})
  //    — O(devicePlotWidth) points that rasterize identically. The edge union
  //    breaks the decimated series at exactly the real gaps (gap-mode connectors
  //    compose unchanged) **and** aligns a bucket edge to each session break in
  //    `boundaries`, so `sessionRuns` below still splits it into clean per-session
  //    subpaths. Cull + decimate are **memoized per source** ({@link
  //    decimateM4Cached}) so a y-zoom / y-autorange frame reuses the prior
  //    polyline instead of re-binning O(N) — the decimation output never depends
  //    on the y-scale (finding 3). `decimateM4` no-ops on a sparse slice or a
  //    domainless test scale, so this stays byte-identical there.
  //  - **Full-resolution** (a smoothing curve would distort the 4-points-per-
  //    column polyline, or `decimate === false`): just cull to the visible slice
  //    (+1 entry/exit point) so a pan repaint strokes O(visible), not O(N). A
  //    no-op — the same `cs` back — when the whole series is in view or `xScale`
  //    exposes no domain (a bare test stub), keeping that hot path byte-identical.
  // Everything below indexes `cs` relatively, so the zero-copy subarray view drops
  // in transparently; `boundaries` are absolute instants that `sessionRuns`
  // bisects by value, so they still cut the slice correctly.
  let decimated = false;
  if (decimate !== false && curve === curveLinear) {
    const k = typeof decimate === 'object' ? decimate.threshold : undefined;
    const r = decimateM4Cached(source, xScale, ctx, k, boundaries);
    cs = r.series;
    decimated = r.decimated;
  } else {
    cs = cullChartSeries(source, xScale);
  }
  // Normalize any value with **no position on the y scale** (a zero or negative
  // sample on a log axis) into the ordinary NaN gap signal, so every consumer
  // below — the `.defined` break, `bridgeGaps`, `collectGapEdges` — treats it as
  // the absence it is instead of emitting a dropped `lineTo(x, NaN)` that
  // silently bridges its neighbours. A no-op on an affine (linear) y scale; see
  // {@link gapUnscalable}.
  const scaledY = gapUnscalable(cs.y, cs.length, yScale);
  if (scaledY !== cs.y) cs = { ...cs, y: scaledY };
  // Split into independent index runs at each boundary; no boundary inside the
  // data ⇒ one run over the whole series (the hot path — no slicing, so the draw
  // is byte-identical to the pre-boundary single pass). When the series was
  // decimated, `decimateM4` already baked the session breaks in as `NaN` points
  // (aligned to the break instants), so re-cutting here with `boundaries` would
  // mis-attribute the boundary points — pass `[]` and let the baked-in breaks split
  // the sessions.
  const runs = sessionRuns(
    cs.x,
    cs.length,
    decimated ? EMPTY_BOUNDARIES : boundaries,
  );
  const singleRun = runs.length === 1;

  // [PND-AFFINE] fast path: when the curve is linear and **both** scales are
  // affine (every y axis is `scaleLinear`; x is `scaleLinear` / `scaleTime` /
  // the gap-free default trading axis — a real-gap trading scale probes
  // non-affine and is rejected), stroke each run with an inline multiply-add over
  // the typed arrays, skipping the per-point d3-scale + d3-shape closures. Any
  // other case (smoothing curve, non-affine x) keeps the exact d3-shape path.
  const ax = curve === curveLinear ? affineOf(xScale) : null;
  const ay = ax !== null ? affineOf(yScale) : null;

  // Solid pass: one path across every run. Each run's generator opens with its
  // own moveTo, so a run boundary is a clean pen-up — the session break.
  ctx.beginPath();
  for (const [s, e] of runs) {
    // `none` interpolates interior gaps so the line bridges them — but only
    // *within* a run (a session break is not a dropout to interpolate over);
    // every other mode keeps NaN so d3 breaks the solid path (the inferred
    // bridge, if any, is a separate overlay pass below).
    const seg = singleRun ? cs.y : cs.y.subarray(s, e);
    const ys = gaps === 'none' ? bridgeGaps(seg, e - s) : seg;
    if (ax !== null && ay !== null) {
      const xs = singleRun ? cs.x : cs.x.subarray(s, e);
      strokeAffinePolyline(ctx, xs, ys, ax, ay);
    } else {
      const gen = d3line<number>()
        .defined((v) => Number.isFinite(v))
        .x((_, j) => xScale(cs.x[s + j]!))
        .y((v) => yScale(v))
        .curve(curve)
        .context(ctx);
      gen(ys);
    }
  }
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  // Per-series dash (a modeled/forecast line reads dashed). Applied only when
  // set — a solid line never touches `setLineDash` — then reset to solid right
  // after the stroke so it can't leak into the gap-bridge overlay below (which
  // sets its own dash) or the next layer drawn on this context.
  const dash = style.dash;
  if (dash && dash.length > 0) {
    ctx.setLineDash(dash.slice());
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.stroke();
  }

  // Overlay bridges for the inferred-gap modes. `dashed` / `step` are faint
  // dashed connectors (gapConnectorOpacity); only `fade` drops to the axis floor.
  // Collect edges **per run** so an inferred bridge never spans a session break
  // (the break wins — no dashed/step/fade connector across a collapsed gap).
  if (gaps === 'dashed' || gaps === 'step' || gaps === 'fade') {
    const edges: GapEdge[] = [];
    for (const [s, e] of runs) {
      const runEdges = collectGapEdges(
        e - s,
        singleRun ? cs.x : cs.x.subarray(s, e),
        (i) => cs.y[s + i]!,
        xScale,
        (i) => yScale(cs.y[s + i]!),
      );
      for (const ed of runEdges) edges.push(ed);
    }
    if (gaps === 'dashed') {
      drawGapBridges(ctx, edges, style.color, style.width, gapConnectorOpacity);
    } else if (gaps === 'step') {
      drawGapSteps(ctx, edges, style.color, style.width, gapConnectorOpacity);
    } else {
      drawGapFades(
        ctx,
        edges,
        baselinePxFromScale(yScale),
        style.color,
        style.width,
      );
    }
  }
  // `drawnCount` = points actually stroked (culled slice, or the M4 polyline when
  // decimation engaged); `sourceCount` = the full series it started from.
  return { sourceCount, drawnCount: cs.length, decimated };
}

/**
 * Split a sorted columnar x-axis into contiguous index runs `[start, endEx)`,
 * cutting wherever a `boundaries` instant falls in `(x[i-1], x[i]]` — i.e. a
 * discontinuity (a trading session / day / lunch close→open) sits between two
 * consecutive points. A point that lands exactly on a boundary starts the new
 * run (the open). No boundary inside the data (or an empty list) ⇒ a single run
 * over the whole series. This is what turns `<LineChart sessionBreaks>` into a
 * per-session polyline. Pure + O(N).
 *
 * The sweep relies on **ascending** boundaries; the `DiscontinuityProvider`
 * contract doesn't guarantee order, so an unsorted list is sorted defensively
 * (a copy, so the caller's array isn't mutated) rather than silently dropping a
 * break. The list is tiny — one entry per session boundary — so the sort is
 * negligible next to the row sweep.
 */
export function sessionRuns(
  x: Float64Array,
  length: number,
  boundaries: readonly number[],
): Array<[number, number]> {
  if (boundaries.length === 0 || length === 0) return [[0, length]];
  const bounds =
    boundaries.length > 1 ? [...boundaries].sort((a, b) => a - b) : boundaries;
  const runs: Array<[number, number]> = [];
  let start = 0;
  let bi = 0;
  for (let i = 1; i < length; i += 1) {
    const prev = x[i - 1]!;
    const cur = x[i]!;
    // Skip boundaries at or before the previous point (already behind the pen).
    while (bi < bounds.length && bounds[bi]! <= prev) bi += 1;
    if (bi < bounds.length && bounds[bi]! <= cur) {
      // A boundary sits in (prev, cur] → break the run before point i.
      runs.push([start, i]);
      start = i;
      while (bi < bounds.length && bounds[bi]! <= cur) bi += 1;
    }
  }
  runs.push([start, length]);
  return runs;
}

/** How near the pointer must come to a trace's path to count as a hit, in px.
 *  Generous on purpose: a 1.5px stroke is not a target anyone can hit, and a
 *  trace has no fat mark to aim at the way a bar does. */
export const TRACE_HIT_PX = 6;

/**
 * **Is the pointer on this trace?** Distance from `(px, py)` to the drawn
 * polyline, in pixels, or `null` past the tolerance.
 *
 * Returns the **nearest sample's index** on a hit, purely as click provenance —
 * the selection a trace commits is series-scoped ([PND-TRACESEL]), because a
 * sample is not a mark. The index is what the readout can name, not what the
 * selection is keyed on.
 *
 * The x cut is a binary search over `xScale(cs.x[i])` rather than an inverse:
 * a layer's `hitTest` is handed the forward scale only, and a trading-time or
 * band scale has no honest inverse anyway. Monotonic either way, so bisection
 * holds. Then only the two segments either side of that index are measured —
 * the pointer cannot be nearest to any other, so this is `O(log N)` and not a
 * scan, which matters on a decimated million-point trace.
 *
 * Gaps are skipped: a segment with a non-finite end is not drawn, so it cannot
 * be hit. That is the same rule `drawLine` paints by, and it is why clicking a
 * dropout selects nothing rather than the bridge across it.
 */
export function traceHitIndex(
  cs: ChartSeries,
  px: number,
  py: number,
  xScale: Scale,
  yScale: Scale,
  tolerance = TRACE_HIT_PX,
): number | null {
  const n = cs.length;
  if (n === 0) return null;
  // Bisect to the first sample at or past the pointer's x.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xScale(cs.x[mid]!) < px) lo = mid + 1;
    else hi = mid;
  }
  let best = Infinity;
  let bestIdx: number | null = null;
  // The pointer's nearest point on the path lies on one of the two segments
  // touching `lo`, so `lo - 1 … lo + 1` bounds everything worth measuring.
  for (let i = Math.max(0, lo - 1); i < Math.min(n - 1, lo + 1); i += 1) {
    const ay = cs.y[i]!;
    const by = cs.y[i + 1]!;
    if (!Number.isFinite(ay) || !Number.isFinite(by)) continue;
    const ax = xScale(cs.x[i]!);
    const bx = xScale(cs.x[i + 1]!);
    const d = pointSegmentDistance(px, py, ax, yScale(ay), bx, yScale(by));
    if (d < best) {
      best = d;
      // Attribute to whichever END the pointer is nearer, so the provenance
      // index is the sample a reader would say they clicked.
      const da = Math.hypot(px - ax, py - yScale(ay));
      const db = Math.hypot(px - bx, py - yScale(by));
      bestIdx = da <= db ? i : i + 1;
    }
  }
  // A single-sample trace draws no segment, so measure the point itself —
  // otherwise a one-point series would be unhittable.
  if (bestIdx === null && n === 1 && Number.isFinite(cs.y[0]!)) {
    const d = Math.hypot(px - xScale(cs.x[0]!), py - yScale(cs.y[0]!));
    if (d <= tolerance) return 0;
    return null;
  }
  return best <= tolerance ? bestIdx : null;
}

/** Euclidean distance from a point to a line segment, in the same units. */
function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // A degenerate segment (both ends on one pixel) is a point.
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  // Project onto the segment, clamped to its ends.
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The **interaction state** a trace draws in, resolved from the selection
 * ([PND-TRACESEL]).
 *
 * - `'rest'` — nothing selected anywhere, or this trace is what's selected and
 *   nothing needs emphasis beyond its own.
 * - `'selected'` — this series is the selected one: thicken it.
 * - `'hover'` — transient echo of `selected`.
 * - `'dimmed'` — something *else* is selected: recede, hue intact.
 */
export type TraceState = 'rest' | 'selected' | 'hover' | 'dimmed';

/**
 * The style a trace strokes with in a given state — weight and alpha only, so a
 * muted or emphasised line still reads as *which* series it is
 * (`LineStyle.selectedWidth`'s doc has the argument).
 *
 * Returned as a `[style, alpha]` pair rather than folded into the style,
 * because alpha belongs to the canvas' `globalAlpha` and not to a stroke
 * colour: baking it into the colour would lose the hue on a themed line that
 * already carries an alpha of its own.
 */
export function traceStateStyle(
  style: LineStyle,
  state: TraceState,
): readonly [LineStyle, number] {
  const selected = style.selectedWidth ?? style.width * 2;
  switch (state) {
    case 'selected':
      return [{ ...style, width: selected }, 1];
    case 'hover':
      return [{ ...style, width: style.hoverWidth ?? selected }, 1];
    case 'dimmed':
      return [style, style.dimmedOpacity ?? 0.32];
    case 'rest':
      return [style, 1];
  }
}

/**
 * Run `draw` twice to paint a trace **partitioned by a swept window**: the
 * whole trace in `outside`, then the same trace again in `inside`, **clipped to
 * the window's pixel band**.
 *
 * Clipping rather than slicing the series, and that is the load-bearing choice.
 * Slicing would have to re-cull, re-decimate and re-split each piece — three
 * cache misses and three chances for the seam to disagree with itself, and the
 * decimated polyline's bucket edges would not line up with the window's, so
 * the boundary would visibly jitter as the drag moved. Clipping strokes the
 * *identical* geometry twice and lets the rasteriser cut it, so the seam is
 * exact by construction and both passes hit the same decimation cache entry.
 *
 * The window arrives in **pixels** because that is what a clip rect wants and
 * the caller has already mapped it through the scale it drew with.
 */
export function drawPartitioned(
  ctx: CanvasRenderingContext2D,
  windowPx: readonly [number, number],
  height: number,
  outside: () => LayerDrawStats,
  inside: () => LayerDrawStats,
  /**
   * Clip the emphasised pass to the window. **`true` for a fill**, whose
   * boundary is a vertical wall by construction; **`false` for a stroke that
   * has sliced its own path** (see {@link sliceTrace}), because a clip would
   * shear the ribbon flat and defeat the round cap the slice exists to allow.
   */
  clipInside = true,
): LayerDrawStats {
  const [x0, x1] = windowPx;
  // A collapsed window has no inside to paint, so one plain pass is the whole
  // picture — and `clip()` on a zero-width rect would suppress the second pass
  // anyway.
  if (x1 <= x0) return outside();
  // **Both passes are clipped, and the outside one to the window's COMPLEMENT.**
  // Painting the muted trace full-width and the emphasised one over it works
  // for a line, whose stroke is opaque and covers itself. It is wrong for an
  // **area**: a semi-transparent fill composites with whatever is under it, so
  // the window would carry muted-plus-emphasised stacked and read darker than
  // either — the emphasis would depend on what it was drawn over. Clipping the
  // outside pass away from the window means each pixel is painted exactly once,
  // whatever its alpha.
  ctx.save();
  ctx.beginPath();
  // The complement as two rects in one path: everything left of the window,
  // everything right of it. A negative-width rect is legal but not portable
  // across every canvas impl, so clamp rather than rely on it.
  if (x0 > 0) ctx.rect(0, 0, x0, height);
  ctx.rect(x1, 0, Math.max(0, ctx.canvas.width - x1), height);
  ctx.clip();
  const stats = outside();
  ctx.restore();
  if (!clipInside) {
    // The caller's path already ends where the window does, so it needs no
    // clip — and its round caps may overhang the boundary by half a stroke,
    // which is exactly the look: a rounded end sitting on the muted trace.
    inside();
    return stats;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, x1 - x0, height);
  ctx.clip();
  inside();
  ctx.restore();
  // The stats describe the geometry walked, and the clipped pass walks the
  // same series — reporting it twice would double every count in the draw
  // budget for what is one trace.
  return stats;
}

/**
 * A trace sliced to the key window `[lo, hi]`, with its **endpoints
 * interpolated** onto the path — or `null` when nothing of it falls inside.
 *
 * This exists so the emphasised pass of a partitioned draw can be a real path
 * whose own ends are the window's ends, which is what lets a **round cap**
 * show. A clipped stroke cannot have one: the clip shears the ribbon on a
 * vertical line wherever the rect cuts it, so the cap is drawn off in the
 * hidden part of the path and the visible end is always a hard vertical edge,
 * whatever `lineCap` says.
 *
 * The endpoints are interpolated rather than snapped to the nearest sample
 * because at low density snapping would visibly overshoot or undershoot the
 * window the reader just swept — the emphasis would not line up with the band
 * that produced it.
 *
 * A boundary landing on a **gap** contributes no interpolated point: there is
 * no drawn segment there to sit on, and inventing one would bridge a hole the
 * trace deliberately shows.
 */
export function sliceTrace(
  cs: ChartSeries,
  lo: number,
  hi: number,
): ChartSeries | null {
  const n = cs.length;
  if (n === 0 || hi <= lo) return null;
  // First index at or past `lo`, first past `hi` — the interior run.
  let a = 0;
  let b = n;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (cs.x[mid]! < lo) a = mid + 1;
    else b = mid;
  }
  let e = a;
  while (e < n && cs.x[e]! <= hi) e += 1;
  const xs: number[] = [];
  const ys: number[] = [];
  /** Value on the segment `[i-1, i]` at key `k`, or null across a gap/edge. */
  const at = (i: number, k: number): number | null => {
    if (i <= 0 || i >= n) return null;
    const y0 = cs.y[i - 1]!;
    const y1 = cs.y[i]!;
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
    const x0 = cs.x[i - 1]!;
    const x1 = cs.x[i]!;
    if (x1 === x0) return y1;
    const t = (k - x0) / (x1 - x0);
    return y0 + (y1 - y0) * t;
  };
  const head = at(a, lo);
  if (head !== null) {
    xs.push(lo);
    ys.push(head);
  }
  for (let i = a; i < e; i += 1) {
    xs.push(cs.x[i]!);
    ys.push(cs.y[i]!);
  }
  const tail = at(e, hi);
  if (tail !== null) {
    xs.push(hi);
    ys.push(tail);
  }
  if (xs.length === 0) return null;
  return {
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    length: xs.length,
  };
}

/**
 * **EXPERIMENT ([PND-ANNSNAP]).** Vertical rules at a swept window's edges, in
 * the annotation register — a preview of what "promote this sweep to an
 * annotation" would look like, drawn *underneath* the trace.
 *
 * Two caveats, and the second decides whether this survives:
 *
 * - **Opaque on purpose.** Every spanned layer in the row draws its own edges
 *   at the same x, so a translucent stroke would composite once per trace and
 *   darken with the number of series. Opaque makes the overdraw idempotent.
 * - **A real annotation could not sit here.** Annotations render in the SVG
 *   overlay *above* the canvas, so a promoted span's rules would land on top of
 *   the traces, not under them. This is canvas-side precisely because "under"
 *   was asked for — if the look is kept, the honest options are to accept rules
 *   above the ink, or to give the annotation register a canvas-underlay pass.
 */
export function strokeSpanEdges(
  ctx: CanvasRenderingContext2D,
  windowPx: readonly [number, number],
  height: number,
  color: string,
  width = 1,
): void {
  const prior = ctx.strokeStyle;
  const priorWidth = ctx.lineWidth;
  const priorAlpha = ctx.globalAlpha;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const x of windowPx) {
    // Half-pixel offset so a 1px rule lands on one device column instead of
    // straddling two and rendering as a 2px smear.
    const px = Math.round(x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  }
  ctx.strokeStyle = prior;
  ctx.lineWidth = priorWidth;
  ctx.globalAlpha = priorAlpha;
}
