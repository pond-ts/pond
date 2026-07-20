import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { BandSeries } from './data.js';
import type { Scale } from './line.js';
import type { BandStyle } from './theme.js';
import { cullBandSeries } from './culling.js';
import { decimateBand, type DecimateOption } from './decimate.js';

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
 * Built on d3-shape's `area()` (`y0`=lower, `y1`=upper). A **gap** — a sample
 * with either edge non-finite — **breaks the fill**: a sample counts only where
 * *both* edges are finite (`.defined`), so a gap ends the current subpath and
 * the next finite run starts a fresh one, leaving an honest hole in the envelope
 * (`docs/rfcs/charts.md` trap #2).
 *
 * Unlike {@link LineChart} / {@link AreaChart}, a band has **no `gaps` mode** — a
 * filled envelope's break wants its own treatment (sharp edge vs. blurred),
 * still to be designed; for now a band always breaks honestly at a gap.
 *
 * `band.lower` (a `Float64Array`) is the datum iterable; every accessor reads by
 * index, so there's no per-point object allocation. `globalAlpha` carries the
 * opacity and is restored so it doesn't leak into later layers.
 */
export function drawBand(
  ctx: CanvasRenderingContext2D,
  band: BandSeries,
  xScale: Scale,
  yScale: Scale,
  style: BandStyle,
  curve: CurveFactory = curveLinear,
  decimate: DecimateOption = true,
): void {
  // Viewport culling (Phase 2): clip the envelope to the visible slice (+1 each
  // side) before filling, so a pan strokes O(visible). The solid fill has no
  // cross-point state, so a zero-copy subarray view is exact; a no-op (same
  // object) when fully in view or the scale has no domain (a test stub).
  band = cullBandSeries(band, xScale);
  // M4 band decimation (Phase 3): once the culled envelope is denser than ~2
  // samples per device pixel, replace it with the per-column min-lower / max-upper
  // envelope ({@link decimateBand}) — O(plot width) points that cover the same
  // pixels. Gated off a smoothing `curve` (which would distort the per-column
  // envelope) and `decimate === false`; `decimateBand` itself no-ops on a sparse
  // envelope or a domainless test scale, so this stays byte-identical there.
  if (decimate !== false && curve === curveLinear) {
    const k = typeof decimate === 'object' ? decimate.threshold : undefined;
    band = decimateBand(band, xScale, ctx, k);
  }
  const gen = d3area<number>()
    .defined(
      (_, i) =>
        Number.isFinite(band.lower[i]!) && Number.isFinite(band.upper[i]!),
    )
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
