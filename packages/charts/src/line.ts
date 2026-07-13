import { line as d3line, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import type { LineStyle } from './theme.js';
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

/** Maps a data value to a pixel coordinate (a d3 scale is assignable to this). */
export type Scale = (value: number) => number;

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
): void {
  // Split into independent index runs at each boundary; no boundary inside the
  // data ⇒ one run over the whole series (the hot path — no slicing, so the draw
  // is byte-identical to the pre-boundary single pass).
  const runs = sessionRuns(cs.x, cs.length, boundaries);
  const singleRun = runs.length === 1;

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
    const gen = d3line<number>()
      .defined((v) => Number.isFinite(v))
      .x((_, j) => xScale(cs.x[s + j]!))
      .y((v) => yScale(v))
      .curve(curve)
      .context(ctx);
    gen(ys);
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
