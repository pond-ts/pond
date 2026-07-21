import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import type { Scale } from './line.js';
import type { AreaStyle } from './theme.js';
import type { LayerDrawStats } from './context.js';
import {
  bridgeGaps,
  collectGapEdges,
  drawGapBridges,
  drawGapFades,
  drawGapSteps,
  withAlpha,
  DEFAULT_GAP_MODE,
  DEFAULT_GAP_CONNECTOR_OPACITY,
  type GapMode,
} from './gaps.js';
import { cullChartSeries } from './culling.js';
import { decimateM4, type DecimateOption } from './decimate.js';

/**
 * The `[min, max]` vertical extent an area occupies — the finite values of
 * `cs.y` widened to include `baseline`, since the fill spans from each value to
 * the baseline (so the baseline must be in-domain or the fill clips). `null` if
 * no value is finite. When `baseline` is `undefined` the area rests on the
 * axis's own lower bound (resolved later), so only the values constrain the
 * domain — matching {@link yExtent}.
 *
 * NaN values (the gap signal) are ignored, so a coast doesn't drag the domain.
 */
export function areaExtent(
  cs: ChartSeries,
  baseline: number | undefined,
): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < cs.length; i += 1) {
    const v = cs.y[i]!;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) return null;
  // The fill reaches the baseline, so it must be inside the domain (an
  // above/below-axis area with baseline 0 has to show the zero line).
  if (baseline !== undefined) {
    if (baseline < min) min = baseline;
    if (baseline > max) max = baseline;
  }
  return [min, max];
}

/**
 * Fill the area between `cs`'s value line and a horizontal `baseline`, with a
 * vertical gradient (most opaque at the line, fading to transparent at the
 * baseline) and an outline stroke on top.
 *
 * Two forms, selected by `baseline`:
 *
 * - **Elevation** (`baseline` = the axis lower bound, supplied as the resolved
 *   `baselineValue`): the line sits above the baseline, the shade grades down
 *   from it — the estela elevation look.
 * - **Above/below axis** (`baseline` = `0`): positive values fill up, negative
 *   fill down (d3's `area` handles the zero crossing in one path). The gradient
 *   is anchored at the baseline pixel so each side grades *away* from the axis —
 *   opaque at the line, transparent at the axis — in both directions. Compose
 *   two layers (e.g. an "in" column and an "out" column) for the esnet
 *   two-colour traffic look; each layer's colour is its own `as` token (the
 *   single styling channel).
 *
 * **Gap handling is driven by `gaps`** (a {@link GapMode}, default `'empty'`).
 * In every mode **the fill obeys the mode's break/bridge decision**: `'none'`
 * fills straight across the gap (interior gaps interpolated via
 * {@link bridgeGaps}, so the value edge bridges and the fill spans it); every
 * other mode breaks the fill (`.defined(Number.isFinite)` — a coast is a hole in
 * the shade, never a slab to the baseline, `docs/rfcs/charts.md` trap #2). For
 * `'dashed'` / `'step'` / `'fade'` the **outline** (the value line on top)
 * additionally gets an inferred bridge across each interior gap — a dashed line,
 * a flat dashed line at the average of the edge values, or estela's
 * fade-to-baseline — while the *fill* stays broken. `dashed` / `step` are drawn
 * faint (`gapConnectorOpacity`). So the shade is always honest about absence;
 * only the line offers the inferred connector.
 *
 * `cs.y` (a `Float64Array`) is the datum iterable; accessors read by index, so
 * there's no per-point object allocation. The gradient + `globalAlpha` are
 * bracketed by `save`/`restore` so they don't leak into later layers. Gap edges
 * are collected by one O(N) walk ({@link collectGapEdges}).
 */
export function drawArea(
  ctx: CanvasRenderingContext2D,
  cs: ChartSeries,
  xScale: Scale,
  yScale: Scale,
  style: AreaStyle,
  baselineValue: number,
  curve: CurveFactory = curveLinear,
  gaps: GapMode = DEFAULT_GAP_MODE,
  gapConnectorOpacity: number = DEFAULT_GAP_CONNECTOR_OPACITY,
  decimate: DecimateOption = true,
): LayerDrawStats {
  const sourceCount = cs.length; // pre-cull, pre-decimation (for draw stats)
  const baselinePx = yScale(baselineValue);
  // The fill gradient's vertical extent is computed from the **full** series (a
  // vertical, position-anchored gradient spanning the data's whole pixel extent)
  // so viewport culling stays behavior-neutral: the culled path below paints the
  // exact same visible pixels under the same gradient. This is a cheap O(N)
  // min/max scan; the expensive per-point path work (fill + outline) culls. (Cull
  // the region too and the shade would drift under pan as off-screen extrema
  // enter/leave — a visible change culling must not make.)
  const fullYs = gaps === 'none' ? bridgeGaps(cs.y, cs.length) : cs.y;
  const fill = buildGradient(ctx, fullYs, cs.length, yScale, baselinePx, style);

  // Viewport culling (Phase 2): the path, outline, and gap bridges walk the
  // visible slice (+1 entry/exit point) only. A no-op — the same `cs` back — when
  // fully in view or `xScale` has no domain (a test stub), keeping that hot path
  // byte-identical.
  cs = cullChartSeries(cs, xScale);
  // M4 decimation (Phase 3): the outline is a line, so the same {@link decimateM4}
  // pre-pass shrinks the fill + outline + gap-bridge work to O(plot width) once
  // dense — with the §2.2 gap-edge union so every gap mode composes. The gradient
  // above is over the FULL series, so the decimated fill paints identical pixels
  // under it. Gated off a smoothing `curve`; a no-op on a sparse slice / test scale.
  let decimated = false;
  if (decimate !== false && curve === curveLinear) {
    const k = typeof decimate === 'object' ? decimate.threshold : undefined;
    const before = cs;
    cs = decimateM4(cs, xScale, ctx, k);
    decimated = cs !== before;
  }
  // `none` interpolates interior gaps so the fill + outline bridge them; every
  // other mode keeps NaN so d3 breaks both (the inferred line bridge, if any, is
  // a separate overlay pass below).
  const ys = gaps === 'none' ? bridgeGaps(cs.y, cs.length) : cs.y;
  const gen = d3area<number>()
    .defined((v) => Number.isFinite(v))
    .x((_, i) => xScale(cs.x[i]!))
    .y0(() => baselinePx)
    .y1((v) => yScale(v))
    .curve(curve)
    .context(ctx);

  ctx.save();
  // The fill: a vertical gradient anchored at the baseline pixel, opaque at the
  // line and transparent at the baseline (see buildGradient — handles both the
  // one-sided elevation form and the two-sided above/below form). Spans the full
  // data region (above), so the culled `ys` paints identical pixels under it.
  ctx.fillStyle = fill;
  ctx.globalAlpha = style.fillOpacity;
  ctx.beginPath();
  gen(ys);
  ctx.fill();
  ctx.restore();

  // The outline on top: the area's top edge as a line (`lineY1` inherits the
  // area's `defined`, `curve`, and `context`, so it breaks at the same gaps),
  // at full opacity over the graded fill.
  const outline = gen.lineY1();
  ctx.save();
  ctx.beginPath();
  outline(ys);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.stroke();
  ctx.restore();

  // Inferred bridges for the line edge (fill stays broken). `dashed` / `step`
  // are faint dashed connectors (gapConnectorOpacity); only `fade` drops to the
  // area's own baseline pixel (the fill floor).
  if (gaps === 'dashed' || gaps === 'step' || gaps === 'fade') {
    const edges = collectGapEdges(
      cs.length,
      cs.x,
      (i) => cs.y[i]!,
      xScale,
      (i) => yScale(cs.y[i]!),
    );
    if (gaps === 'dashed') {
      drawGapBridges(ctx, edges, style.color, style.width, gapConnectorOpacity);
    } else if (gaps === 'step') {
      drawGapSteps(ctx, edges, style.color, style.width, gapConnectorOpacity);
    } else {
      drawGapFades(ctx, edges, baselinePx, style.color, style.width);
    }
  }
  return { sourceCount, drawnCount: cs.length, decimated };
}

/**
 * A vertical `CanvasGradient` for the fill, spanning the drawn region's pixel
 * extent (the finite values plus the baseline) and anchored so the shade is
 * most opaque at the line and fully transparent at the baseline.
 *
 * - **One-sided** (all values on one side of the baseline — the elevation form,
 *   and any single-signed traffic channel): a plain two-stop grade, opaque at
 *   the line edge → transparent at the baseline edge.
 * - **Two-sided** (values straddle the baseline — a signed above/below series):
 *   a three-stop grade, opaque at the top, transparent at the baseline pixel,
 *   opaque again at the bottom — so each side fades toward the axis.
 *
 * The gradient colour is `style.fill` at full alpha (the layer's `globalAlpha`
 * carries `fillOpacity`); the transparent stop is the same colour at alpha 0.
 * Falls back to a solid `style.fill` when the region is degenerate (a single
 * finite point, or values exactly on the baseline) — a zero-height gradient
 * would paint nothing.
 */
function buildGradient(
  ctx: CanvasRenderingContext2D,
  ys: Float64Array,
  length: number,
  yScale: Scale,
  baselinePx: number,
  style: AreaStyle,
): CanvasGradient | string {
  let topPx = Infinity; // smallest pixel y (highest on screen)
  let bottomPx = -Infinity; // largest pixel y (lowest on screen)
  for (let i = 0; i < length; i += 1) {
    const v = ys[i]!;
    if (!Number.isFinite(v)) continue;
    const py = yScale(v);
    if (py < topPx) topPx = py;
    if (py > bottomPx) bottomPx = py;
  }
  if (topPx === Infinity) return style.fill; // no finite values (caller no-ops)
  // The drawn region runs from the topmost of {values, baseline} to the
  // bottommost — the fill reaches the baseline, so include it.
  const regionTop = Math.min(topPx, baselinePx);
  const regionBottom = Math.max(bottomPx, baselinePx);
  if (regionBottom - regionTop < 1e-6) return style.fill; // degenerate height

  const opaque = style.fill;
  const transparent = withAlpha(style.fill, 0);
  const grad = ctx.createLinearGradient(0, regionTop, 0, regionBottom);
  // Baseline position within the region, as a 0..1 offset.
  const baseOffset = (baselinePx - regionTop) / (regionBottom - regionTop);
  if (baseOffset <= 1e-6 || baseOffset >= 1 - 1e-6) {
    // One-sided: the baseline is at an edge of the region (elevation form, or a
    // single-signed traffic channel), so a plain two-stop grade runs opaque at
    // the line edge → transparent at the baseline edge. Both edges map to the
    // same stop shape (0 opaque, 1 transparent) — the opaque end is always the
    // line because the region's other extreme is the baseline.
    grad.addColorStop(0, baseOffset <= 1e-6 ? transparent : opaque);
    grad.addColorStop(1, baseOffset <= 1e-6 ? opaque : transparent);
  } else {
    // Two-sided: values straddle the baseline — opaque at both extremes,
    // transparent at the baseline pixel, so each side fades toward the axis.
    grad.addColorStop(0, opaque);
    grad.addColorStop(baseOffset, transparent);
    grad.addColorStop(1, opaque);
  }
  return grad;
}
