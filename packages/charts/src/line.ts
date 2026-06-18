import { line as d3line, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import type { LineStyle } from './theme.js';

/** Maps a data value to a pixel coordinate (a d3 scale is assignable to this). */
export type Scale = (value: number) => number;

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
 * Built on d3-shape's `line()`. Gaps are handled by `.defined(Number.isFinite)`
 * — a non-finite value ends the current subpath and the next finite point
 * starts a fresh one (`moveTo`, not `lineTo`), so a coast reads as a break, not
 * a `lineTo(NaN, …)` bridge (`docs/rfcs/charts.md` trap #2). The generator
 * writes path ops to `ctx`; we bracket with `beginPath`/`stroke`.
 *
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
): void {
  const gen = d3line<number>()
    .defined((v) => Number.isFinite(v))
    .x((_, i) => xScale(cs.x[i]!))
    .y((v) => yScale(v))
    .curve(curve)
    .context(ctx);
  ctx.beginPath();
  gen(cs.y);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.stroke();
}
