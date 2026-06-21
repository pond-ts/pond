import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { BandSeries } from './data.js';
import { baselinePxFromScale, type Scale } from './line.js';
import type { BandStyle } from './theme.js';
import {
  bridgeGaps,
  collectGapEdges,
  drawGapBridges,
  drawGapFades,
  drawGapSteps,
  DEFAULT_GAP_MODE,
  type GapEdge,
  type GapMode,
} from './gaps.js';

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
 * Built on d3-shape's `area()` (`y0`=lower, `y1`=upper). **Gap handling is
 * driven by `gaps`** (a {@link GapMode}, default `'empty'`). In every mode the
 * *fill* obeys the mode's break/bridge decision: `'none'` fills straight across
 * the gap (both edges interpolated via {@link bridgeGaps}, so the envelope
 * spans it); every other mode breaks the fill (a sample counts only where
 * **both** edges are finite, so a gap ends the current subpath and the next
 * finite run starts a fresh one — `docs/rfcs/charts.md` trap #2).
 *
 * For `'dashed'` / `'step'` / `'fade'` the fill stays broken and a connector is
 * drawn across each interior gap on **both** edges (a band has two boundaries,
 * so the inferred connector honours both): a dashed line per edge, a dashed
 * down-across-up step to the axis floor per edge, or estela's fade-to-baseline
 * per edge. The band carries no explicit baseline, so `step` / `fade` drop to
 * the **axis floor** (the y-scale's domain lower bound). `globalAlpha` carries
 * the opacity and is restored so it doesn't leak into later layers.
 *
 * `band.lower` (a `Float64Array`) is the datum iterable; every accessor reads by
 * index, so there's no per-point object allocation. Gap edges are collected by
 * O(N) walks ({@link collectGapEdges}, once per edge for the connector).
 */
export function drawBand(
  ctx: CanvasRenderingContext2D,
  band: BandSeries,
  xScale: Scale,
  yScale: Scale,
  style: BandStyle,
  curve: CurveFactory = curveLinear,
  gaps: GapMode = DEFAULT_GAP_MODE,
): void {
  // `none` interpolates interior gaps on both edges so the envelope bridges
  // them; every other mode keeps NaN so d3 breaks the fill (the inferred edge
  // connectors, if any, are separate overlay passes below).
  const lower =
    gaps === 'none' ? bridgeGaps(band.lower, band.length) : band.lower;
  const upper =
    gaps === 'none' ? bridgeGaps(band.upper, band.length) : band.upper;
  const gen = d3area<number>()
    .defined((_, i) => Number.isFinite(lower[i]!) && Number.isFinite(upper[i]!))
    .x((_, i) => xScale(band.x[i]!))
    .y0((_, i) => yScale(lower[i]!))
    .y1((_, i) => yScale(upper[i]!))
    .curve(curve)
    .context(ctx);
  ctx.save();
  ctx.fillStyle = style.fill;
  ctx.globalAlpha = style.opacity;
  ctx.beginPath();
  gen(lower);
  ctx.fill();
  ctx.restore();

  // Inferred connectors for the two edges (fill stays broken). A gap edge is
  // collected per band-edge so the connector tracks each boundary; both use the
  // same finite-pair gap predicate. The band has no own width — connectors draw
  // at 1px in the fill colour (at full alpha, over the translucent fill).
  if (gaps === 'dashed' || gaps === 'step' || gaps === 'fade') {
    const lowerEdges = collectGapEdges(
      band.length,
      band.x,
      (i) => pairValue(band, i),
      xScale,
      (i) => yScale(band.lower[i]!),
    );
    const upperEdges = collectGapEdges(
      band.length,
      band.x,
      (i) => pairValue(band, i),
      xScale,
      (i) => yScale(band.upper[i]!),
    );
    const edges: GapEdge[] = [...lowerEdges, ...upperEdges];
    if (gaps === 'dashed') {
      drawGapBridges(ctx, edges, style.fill, BAND_CONNECTOR_WIDTH);
    } else {
      const baselinePx = baselinePxFromScale(yScale);
      if (gaps === 'step') {
        drawGapSteps(ctx, edges, baselinePx, style.fill, BAND_CONNECTOR_WIDTH);
      } else {
        drawGapFades(ctx, edges, baselinePx, style.fill, BAND_CONNECTOR_WIDTH);
      }
    }
  }
}

/** Stroke width for a band's inferred gap connectors (the band style has none). */
const BAND_CONNECTOR_WIDTH = 1;

/** Both edges finite at `i` — i.e. this sample is part of the filled band. */
function isFinitePair(band: BandSeries, i: number): boolean {
  return Number.isFinite(band.lower[i]!) && Number.isFinite(band.upper[i]!);
}

/**
 * The gap-deciding value for {@link collectGapEdges} on a band: finite only when
 * **both** edges are finite (so the connector breaks wherever the fill does).
 * Returns `NaN` for a gap sample, the actual `lower` otherwise (the value itself
 * is unused beyond its finiteness).
 */
function pairValue(band: BandSeries, i: number): number {
  return isFinitePair(band, i) ? band.lower[i]! : NaN;
}
