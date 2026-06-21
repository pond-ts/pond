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
 *   interior gap: a dashed straight line, a dashed down-across-up step to the
 *   axis floor, or estela's fade-to-baseline. The gap edges are collected by one
 *   O(N) walk ({@link collectGapEdges}).
 *
 * The generator writes path ops to `ctx`; we bracket with `beginPath`/`stroke`.
 * `cs.y` (a `Float64Array`) is the datum iterable — `y` reads the value, `x`
 * reads `cs.x[i]` by index, so there's no per-point object allocation.
 */
export function drawLine(
  ctx: CanvasRenderingContext2D,
  cs: ChartSeries,
  xScale: Scale,
  yScale: Scale,
  style: LineStyle,
  curve: CurveFactory = curveLinear,
  gaps: GapMode = DEFAULT_GAP_MODE,
): void {
  // `none` interpolates interior gaps so the line bridges them; every other mode
  // keeps NaN so d3 breaks the solid path (the inferred bridge, if any, is a
  // separate overlay pass below).
  const ys = gaps === 'none' ? bridgeGaps(cs.y, cs.length) : cs.y;
  const gen = d3line<number>()
    .defined((v) => Number.isFinite(v))
    .x((_, i) => xScale(cs.x[i]!))
    .y((v) => yScale(v))
    .curve(curve)
    .context(ctx);
  ctx.beginPath();
  gen(ys);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.stroke();

  // Overlay bridges for the inferred-gap modes. The line y at index i is the
  // value's pixel; the step/fade baseline is the axis floor.
  if (gaps === 'dashed' || gaps === 'step' || gaps === 'fade') {
    const edges = collectGapEdges(
      cs.length,
      cs.x,
      (i) => cs.y[i]!,
      xScale,
      (i) => yScale(cs.y[i]!),
    );
    if (gaps === 'dashed') {
      drawGapBridges(ctx, edges, style.color, style.width);
    } else {
      const baselinePx = baselinePxFromScale(yScale);
      if (gaps === 'step') {
        drawGapSteps(ctx, edges, baselinePx, style.color, style.width);
      } else {
        drawGapFades(ctx, edges, baselinePx, style.color, style.width);
      }
    }
  }
}
