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
 * Fill the variance envelope between `band.lower` and `band.upper`, mapping
 * data→pixels through `xScale`/`yScale`.
 *
 * **Gap-aware** (`docs/rfcs/charts.md` trap #2): a sample counts only where both
 * edges are finite. Each contiguous finite run is filled as its own closed
 * polygon — `upper` left→right, then `lower` right→left — so a gap breaks the
 * fill rather than bridging it (one `NaN` edge would otherwise pull the polygon
 * across the hole). `globalAlpha` carries the fill opacity and is restored so it
 * doesn't leak into later layers.
 */
export function drawBand(
  ctx: CanvasRenderingContext2D,
  band: BandSeries,
  xScale: Scale,
  yScale: Scale,
  style: BandStyle,
): void {
  ctx.save();
  ctx.fillStyle = style.fill;
  ctx.globalAlpha = style.opacity;
  let i = 0;
  while (i < band.length) {
    if (!isFinitePair(band, i)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < band.length && isFinitePair(band, i)) i += 1;
    const end = i; // run is [start, end)
    ctx.beginPath();
    ctx.moveTo(xScale(band.x[start]!), yScale(band.upper[start]!));
    for (let j = start + 1; j < end; j += 1) {
      ctx.lineTo(xScale(band.x[j]!), yScale(band.upper[j]!));
    }
    for (let j = end - 1; j >= start; j -= 1) {
      ctx.lineTo(xScale(band.x[j]!), yScale(band.lower[j]!));
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Both edges finite at `i` — i.e. this sample is part of the filled band. */
function isFinitePair(band: BandSeries, i: number): boolean {
  return Number.isFinite(band.lower[i]!) && Number.isFinite(band.upper[i]!);
}
