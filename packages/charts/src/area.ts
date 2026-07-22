import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import { strokeAffinePolyline, type Scale } from './line.js';
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
import { affineOf, type Affine } from './affine.js';

/**
 * Per-buffer cache of a column's finite `[min, max]` value extent ([PND-GRADX]).
 * The area fill gradient spans the **full** series' vertical pixel extent (so a
 * culled/zoomed view still shades identically — see {@link buildGradient}), which
 * previously meant an O(N) min/max walk on **every** repaint, including each
 * y-zoom / y-autorange frame where the data hasn't changed (the 2026-07 bench
 * profile's mountain@1M ceiling; see
 * `docs/notes/charts-bench-vs-scichart-suite-2026-07.md`, finding 2).
 *
 * The extent is a pure function of the value buffer, so it is memoized on the
 * `y` `Float64Array` (immutable by the {@link ChartSeries} contract): a y-zoom /
 * pan reuses the same buffer → cache hit (no walk); a live re-materialization
 * mints a new buffer → recompute once. The `WeakMap` evicts with the buffer, so
 * there is no leak. Callers pass the full-series `length` (the buffer's logical
 * length); a `subarray` view is never the cache key here (the gradient reads the
 * pre-cull full series).
 *
 * NaN (the gap signal) is ignored — matching {@link areaExtent} / `yExtent` — so
 * a coast doesn't drag the span. `null` when nothing is finite (the caller then
 * falls back to a flat fill).
 */
const columnExtentCache = new WeakMap<
  Float64Array,
  readonly [number, number] | null
>();

export function columnFiniteExtent(
  y: Float64Array,
  length: number,
): readonly [number, number] | null {
  const cached = columnExtentCache.get(y);
  if (cached !== undefined) return cached;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < length; i += 1) {
    const v = y[i]!;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const extent = min === Infinity ? null : ([min, max] as const);
  columnExtentCache.set(y, extent);
  return extent;
}

/**
 * Fill the area between an affine-mapped value polyline and a constant baseline
 * pixel — the [PND-AFFINE] fast path for {@link drawArea}'s fill, the counterpart
 * to {@link strokeAffinePolyline} for its outline. Emits one **independent closed
 * polygon per finite run** (matching `d3.area`'s `.defined(Number.isFinite)`
 * segmentation for a linear curve + constant `y0`): per run `[a, b)`,
 * `moveTo(top_a)` → `lineTo(top…)` along the value edge → `lineTo(x_{b-1}, base)`
 * → `lineTo(x_a, base)` → `closePath`. That is the same filled region `d3.area`
 * draws — its flat backward baseline edge only adds collinear interior vertices,
 * which don't change the fill — without the per-point `scale()` / d3-shape
 * closures. A signed value edge crossing the baseline stays one polygon (no NaN),
 * filled correctly on both sides. The caller brackets `beginPath`/`fill`;
 * `xs`/`ys` are aligned index-for-index.
 */
export function fillAffineArea(
  ctx: CanvasRenderingContext2D,
  xs: Float64Array,
  ys: Float64Array,
  baselinePx: number,
  ax: Affine,
  ay: Affine,
): void {
  const n = ys.length;
  let runStart = -1; // index of the current finite run's first point, or -1
  for (let j = 0; j <= n; j += 1) {
    const finite = j < n && Number.isFinite(ys[j]!);
    if (finite) {
      const px = ax.k * xs[j]! + ax.b;
      const py = ay.k * ys[j]! + ay.b;
      if (runStart < 0) {
        runStart = j;
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    } else if (runStart >= 0) {
      // Close the run: drop to the baseline under the last point, run flat back
      // to the first point's x, close. (j-1 is the run's last finite index.)
      ctx.lineTo(ax.k * xs[j - 1]! + ax.b, baselinePx);
      ctx.lineTo(ax.k * xs[runStart]! + ax.b, baselinePx);
      ctx.closePath();
      runStart = -1;
    }
  }
}

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
  // exact same visible pixels under the same gradient. (Cull the region too and
  // the shade would drift under pan as off-screen extrema enter/leave — a visible
  // change culling must not make.) [PND-GRADX]: the value extent is memoized per
  // column buffer ({@link columnFiniteExtent}), so a y-zoom / pan frame reuses it
  // instead of re-walking O(N) — the mountain@1M ceiling the bench profile
  // flagged. A `'none'` bridge only fills interior gaps with interpolated values
  // that stay within the finite extent, so the plain extent is exact for it too.
  const fill = buildGradient(
    ctx,
    columnFiniteExtent(cs.y, cs.length),
    yScale,
    baselinePx,
    style,
  );

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
  // [PND-AFFINE] fast path: with a linear curve and both scales affine, draw the
  // fill polygon + outline with inline multiply-add over the typed arrays, past
  // the per-point d3-scale + d3-shape closures (finding 1/2). A smoothing curve
  // or a non-affine (real-gap trading) x scale keeps the exact d3-area path.
  const ax = curve === curveLinear ? affineOf(xScale) : null;
  const ay = ax !== null ? affineOf(yScale) : null;

  ctx.save();
  // The fill: a vertical gradient anchored at the baseline pixel, opaque at the
  // line and transparent at the baseline (see buildGradient — handles both the
  // one-sided elevation form and the two-sided above/below form). Spans the full
  // data region (above), so the culled `ys` paints identical pixels under it.
  ctx.fillStyle = fill;
  ctx.globalAlpha = style.fillOpacity;
  ctx.beginPath();
  // The d3-area generator (slow path only) — also the source of the outline line.
  let outline: ((data: Iterable<number>) => void) | null = null;
  if (ax !== null && ay !== null) {
    fillAffineArea(ctx, cs.x, ys, baselinePx, ax, ay);
  } else {
    const gen = d3area<number>()
      .defined((v) => Number.isFinite(v))
      .x((_, i) => xScale(cs.x[i]!))
      .y0(() => baselinePx)
      .y1((v) => yScale(v))
      .curve(curve)
      .context(ctx);
    gen(ys);
    outline = gen.lineY1();
  }
  ctx.fill();
  ctx.restore();

  // The outline on top: the area's top edge as a line (breaks at the same gaps
  // as the fill), at full opacity over the graded fill.
  ctx.save();
  ctx.beginPath();
  if (outline !== null) outline(ys);
  else strokeAffinePolyline(ctx, cs.x, ys, ax!, ay!);
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
  valueExtent: readonly [number, number] | null,
  yScale: Scale,
  baselinePx: number,
  style: AreaStyle,
): CanvasGradient | string {
  if (valueExtent === null) return style.fill; // no finite values (caller no-ops)
  // The pixel extent is the two value extremes mapped through the (monotonic,
  // always-`scaleLinear`) y scale; min/max them so the result is flip-agnostic,
  // exactly as the former per-point pixel scan produced. [PND-GRADX] moved the
  // O(N) walk into the memoized {@link columnFiniteExtent}.
  const pa = yScale(valueExtent[0]);
  const pb = yScale(valueExtent[1]);
  const topPx = Math.min(pa, pb); // smallest pixel y (highest on screen)
  const bottomPx = Math.max(pa, pb); // largest pixel y (lowest on screen)
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
