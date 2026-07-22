import { line as d3line, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import type { LineStyle } from './theme.js';
import type { LayerDrawStats } from './context.js';
import { cullChartSeries } from './culling.js';
import { decimateM4, type DecimateOption } from './decimate.js';
import { affineOf, type Affine } from './affine.js';
import {
  bridgeGaps,
  collectGapEdges,
  drawGapBridges,
  drawGapFades,
  drawGapSteps,
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
    const px = ax.k * xs[j]! + ax.b;
    const py = ay.k * v + ay.b;
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
  // Viewport culling (Phase 2): clip to the visible slice (+1 entry/exit point)
  // before any path work, so a pan repaint strokes O(visible), not O(N). A no-op
  // — the same `cs` object back — when the whole series is in view or `xScale`
  // exposes no domain (a bare test stub), keeping the fully-visible hot path
  // byte-identical. Everything below indexes `cs` relatively, so the zero-copy
  // subarray view drops in transparently; `boundaries` are absolute instants that
  // `sessionRuns` bisects by value, so they still cut the slice correctly.
  cs = cullChartSeries(cs, xScale);
  // M4 decimation (Phase 3): once the culled slice is still denser than ~2
  // samples per device pixel, replace it with the pixel-dense M4 polyline
  // ({@link decimateM4}) — O(devicePlotWidth) points that rasterize identically.
  // The edge union makes the decimated series break at exactly the real gaps
  // (gap-mode connectors compose unchanged) **and** aligns a bucket edge to each
  // session break in `boundaries`, so `sessionRuns` below still splits the
  // decimated series into clean per-session subpaths. Only a non-linear **curve**
  // stays gated (a smoothing curve would distort the 4-points-per-column
  // polyline) — that draws full-resolution. Off (`decimate === false`) or a curve
  // set ⇒ the full culled slice draws. `decimateM4` itself no-ops on a sparse
  // slice or a domainless test scale, so this stays byte-identical there.
  let decimated = false;
  if (decimate !== false && curve === curveLinear) {
    const k = typeof decimate === 'object' ? decimate.threshold : undefined;
    const before = cs;
    cs = decimateM4(cs, xScale, ctx, k, boundaries);
    decimated = cs !== before;
  }
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
