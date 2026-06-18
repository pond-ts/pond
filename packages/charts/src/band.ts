import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { BandSeries } from './data.js';
import type { Scale } from './line.js';
import type { BandStyle } from './theme.js';

/**
 * The `[min, max]` vertical extent of the **drawn** band — the lowest `lower`
 * and highest `upper` over samples where both edges are finite — or `null` if
 * none are. Gap samples (either edge `NaN`) are excluded, matching what
 * {@link drawBand} fills, so they don't drag the y-domain.
 */
export function bandExtent(band: BandSeries): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < band.length; i += 1) {
    const lo = band.lower[i]!;
    const hi = band.upper[i]!;
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
  }
  return min === Infinity ? null : [min, max];
}

/**
 * Fill the variance envelope between `band.lower` and `band.upper`, connecting
 * edges with `curve` (d3-shape; default linear).
 *
 * Built on d3-shape's `area()` (`y0`=lower, `y1`=upper). **Gap-aware** via
 * `.defined` — a sample counts only where both edges are finite, so a gap ends
 * the current subpath and the next finite run starts a fresh one; a single fill
 * paints all subpaths, and the envelope never bridges the hole
 * (`docs/rfcs/charts.md` trap #2). `globalAlpha` carries the opacity and is
 * restored so it doesn't leak into later layers.
 *
 * `band.lower` (a `Float64Array`) is the datum iterable; every accessor reads
 * by index, so there's no per-point object allocation.
 */
export function drawBand(
  ctx: CanvasRenderingContext2D,
  band: BandSeries,
  xScale: Scale,
  yScale: Scale,
  style: BandStyle,
  curve: CurveFactory = curveLinear,
): void {
  const gen = d3area<number>()
    .defined((_, i) => isFinitePair(band, i))
    .x((_, i) => xScale(band.x[i]!))
    .y0((_, i) => yScale(band.lower[i]!))
    .y1((_, i) => yScale(band.upper[i]!))
    .curve(curve)
    .context(ctx);
  ctx.save();
  ctx.fillStyle = style.fill;
  ctx.globalAlpha = style.opacity;
  ctx.beginPath();
  gen(band.lower);
  ctx.fill();
  ctx.restore();
}

/** Both edges finite at `i` — i.e. this sample is part of the filled band. */
function isFinitePair(band: BandSeries, i: number): boolean {
  return Number.isFinite(band.lower[i]!) && Number.isFinite(band.upper[i]!);
}
