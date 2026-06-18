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
 * Stroke a line for `cs`, mapping data→pixels through `xScale`/`yScale`, and
 * **breaking the path at every non-finite value** — a gap lifts the pen
 * (`moveTo` on the next finite point) rather than drawing a segment across it.
 * This is the gap-handling contract (`Number.isFinite`, never `!= null`; see
 * `docs/rfcs/charts.md` trap #2): `lineTo(NaN, …)` would otherwise visually
 * bridge the hole.
 */
export function drawLine(
  ctx: CanvasRenderingContext2D,
  cs: ChartSeries,
  xScale: Scale,
  yScale: Scale,
  style: LineStyle,
): void {
  ctx.beginPath();
  let penDown = false;
  for (let i = 0; i < cs.length; i += 1) {
    const v = cs.y[i]!;
    if (!Number.isFinite(v)) {
      penDown = false; // gap — lift the pen
      continue;
    }
    const px = xScale(cs.x[i]!);
    const py = yScale(v);
    if (penDown) {
      ctx.lineTo(px, py);
    } else {
      ctx.moveTo(px, py);
      penDown = true;
    }
  }
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.stroke();
}
