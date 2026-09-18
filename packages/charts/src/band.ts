import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { BandSeries } from './data.js';
import { sessionRuns, type Scale } from './line.js';
import type { BandStyle } from './theme.js';
import type { LayerDrawStats } from './context.js';
import { cullBandSeries } from './culling.js';
import { decimateBand, type DecimateOption } from './decimate.js';
import { gapUnscalable } from './gaps.js';

/** Shared empty boundary list — passed to `sessionRuns` when a decimated band
 *  already carries its session breaks as baked-in `NaN` samples. */
const EMPTY_BOUNDARIES: readonly number[] = [];

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
 * `boundaries` are trading-axis **session-break** instants (`<BandChart
 * sessionBreaks>`): the envelope is split into per-session runs wherever one
 * falls between two consecutive samples (see {@link sessionRuns}), each run its
 * own closed subpath, so the fill ends at the last pre-close sample and re-starts
 * at the first post-open one — a **scale** break, orthogonal to the NaN **data**
 * gaps handled within each run. With no boundaries the output is identical to a
 * single-pass draw. Mirrors `drawLine`'s treatment exactly.
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
  boundaries: readonly number[] = [],
  decimate: DecimateOption = true,
): LayerDrawStats {
  const sourceCount = band.length; // pre-cull, pre-decimation (for draw stats)
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
  // The session-break instants ride along so a column never straddles a break
  // and the decimated envelope carries the breaks as baked-in NaN samples.
  let decimated = false;
  if (decimate !== false && curve === curveLinear) {
    const k = typeof decimate === 'object' ? decimate.threshold : undefined;
    const before = band;
    band = decimateBand(band, xScale, ctx, k, boundaries);
    decimated = band !== before;
  }
  // An edge with no position on the y scale becomes an ordinary NaN gap, so the
  // envelope breaks there rather than emitting dropped path ops that stitch the
  // neighbouring samples together. A `lower` of `0` is the common shape — a band
  // measured from nothing — and on a log axis zero has no position, so without
  // this the fill silently spanned the samples it could not draw. Gapping either
  // edge gaps the sample, which is already the band's contract: a sample counts
  // only where **both** edges do. A no-op on an affine (linear) y scale.
  const gapLower = gapUnscalable(band.lower, band.length, yScale);
  const gapUpper = gapUnscalable(band.upper, band.length, yScale);
  if (gapLower !== band.lower || gapUpper !== band.upper) {
    band = { ...band, lower: gapLower, upper: gapUpper };
  }
  // Split into independent index runs at each session break; no boundary inside
  // the data ⇒ one run over the whole envelope (the hot path — no slicing, so the
  // draw is byte-identical to the pre-boundary single pass). When the band was
  // decimated, `decimateBand` already baked the breaks in as NaN samples aligned
  // to the break instants, so re-cutting here would mis-attribute the boundary
  // samples — pass `[]` and let the baked-in breaks split the sessions.
  const runs = sessionRuns(
    band.x,
    band.length,
    decimated ? EMPTY_BOUNDARIES : boundaries,
  );
  const singleRun = runs.length === 1;
  ctx.save();
  ctx.fillStyle = style.fill;
  ctx.globalAlpha = style.opacity;
  // One path across every run. Each run's generator opens with its own moveTo
  // (and closes its own polygon), so a run boundary is a clean pen-up — the
  // session break — and a single fill covers them all.
  ctx.beginPath();
  for (const [s, e] of runs) {
    const gen = d3area<number>()
      .defined(
        (_, j) =>
          Number.isFinite(band.lower[s + j]!) &&
          Number.isFinite(band.upper[s + j]!),
      )
      .x((_, j) => xScale(band.x[s + j]!))
      .y0((_, j) => yScale(band.lower[s + j]!))
      .y1((_, j) => yScale(band.upper[s + j]!))
      .curve(curve)
      .context(ctx);
    gen(singleRun ? band.lower : band.lower.subarray(s, e));
  }
  ctx.fill();
  ctx.restore();
  return { sourceCount, drawnCount: band.length, decimated };
}
