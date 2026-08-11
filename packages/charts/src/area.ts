import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import {
  baselinePxFromScale,
  plotExtentOf,
  strokeAffinePolyline,
  TRACE_HIT_PX,
  type Scale,
  type TraceState,
} from './line.js';
import type { BandLadder } from './bars.js';
import type { AreaStyle } from './theme.js';
import type { LayerDrawStats } from './context.js';
import {
  bridgeGaps,
  collectGapEdges,
  drawGapBridges,
  drawGapFades,
  drawGapSteps,
  gapUnscalable,
  withAlpha,
  DEFAULT_GAP_MODE,
  DEFAULT_GAP_CONNECTOR_OPACITY,
  type GapMode,
} from './gaps.js';
import { cullChartSeries } from './culling.js';
import { decimateM4Cached, type DecimateOption } from './decimate.js';
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
      const px = (xs[j]! - ax.v0) * ax.k + ax.p0;
      const py = (ys[j]! - ay.v0) * ay.k + ay.p0;
      if (runStart < 0) {
        runStart = j;
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    } else if (runStart >= 0) {
      // Close the run: drop to the baseline under the last point, run flat back
      // to the first point's x, close. (j-1 is the run's last finite index.)
      ctx.lineTo((xs[j - 1]! - ax.v0) * ax.k + ax.p0, baselinePx);
      ctx.lineTo((xs[runStart]! - ax.v0) * ax.k + ax.p0, baselinePx);
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
  banding?: BandLadder,
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
  //
  // **Banded** ([PND-BANDAREA]): one hard-stop pixel-space gradient carries the
  // whole ladder for the fill AND the outline — see {@link buildBandGradient}
  // for why a gradient rather than one clipped redraw per band.
  const fill =
    banding !== undefined
      ? buildBandGradient(
          ctx,
          yScale,
          plotExtentOf(ctx, xScale, yScale).height,
          banding,
        )
      : buildGradient(
          ctx,
          columnFiniteExtent(cs.y, cs.length),
          yScale,
          baselinePx,
          style,
        );

  // Clip `cs` to what draws. **Decimated** (linear curve, `decimate !== false`):
  // cull to the visible slice, then the same {@link decimateM4} pre-pass shrinks
  // the fill + outline + gap-bridge work to O(plot width) once dense (the §2.2
  // gap-edge union so every gap mode composes; the FULL-series gradient above
  // paints identical pixels under the decimated fill). Cull + decimate are
  // **memoized per source** ({@link decimateM4Cached}) so a y-zoom / y-autorange
  // frame reuses the prior polyline instead of re-binning O(N) — the decimation
  // output never reads the y-scale (finding 3). **Full-resolution** (a smoothing
  // curve, or `decimate === false`): just cull the visible slice (+1 entry/exit
  // point); a no-op — the same `cs` back — when fully in view or `xScale` has no
  // domain (a test stub), keeping that hot path byte-identical.
  const source = cs; // pre-cull source — the decimation cache key ([PND-DECKEY])
  let decimated = false;
  if (decimate !== false && curve === curveLinear) {
    const k = typeof decimate === 'object' ? decimate.threshold : undefined;
    const r = decimateM4Cached(source, xScale, ctx, k);
    cs = r.series;
    decimated = r.decimated;
  } else {
    cs = cullChartSeries(source, xScale);
  }
  // Values with no position on the y scale (zero / negative on a log axis)
  // become ordinary NaN gaps, so the fill and outline break at them rather than
  // bridging over a dropped `lineTo(x, NaN)`. Deliberately **after** the
  // gradient above: that reads the pre-cull buffer, whose finite extent is
  // memoized per `Float64Array` ([PND-GRADX]), and a fresh array here would miss
  // that cache on every frame. A no-op on an affine (linear) y scale.
  const scaledY = gapUnscalable(cs.y, cs.length, yScale);
  if (scaledY !== cs.y) cs = { ...cs, y: scaledY };
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
  // as the fill), at full opacity over the graded fill. Banded, it strokes with
  // the same hard-stop gradient the fill used, so the line switches hue exactly
  // where it crosses a threshold — the whole point of the ladder is that the
  // reader sees *where* the value sits, and the edge is the value.
  ctx.save();
  ctx.beginPath();
  if (outline !== null) outline(ys);
  else strokeAffinePolyline(ctx, cs.x, ys, ax!, ay!);
  ctx.strokeStyle = banding !== undefined ? fill : style.color;
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
  // Stacked areas opt out of the grade entirely: a band that fades to
  // transparent at the baseline shows every band beneath it (see AreaStyle).
  if (style.flatFill === true) return style.fill;
  // The pixel extent is the two value extremes mapped through the (monotonic)
  // y scale; min/max them so the result is flip-agnostic, exactly as the former
  // per-point pixel scan produced. [PND-GRADX] moved the O(N) walk into the
  // memoized {@link columnFiniteExtent}.
  //
  // **An extreme with no position on the scale is dropped**, not min/maxed in.
  // `valueExtent` is the data's own `[min, max]`, and on a **log** axis a
  // non-positive extreme — a series that touches zero, which is the ordinary
  // shape of traffic or storage data — maps to `NaN`. `Math.min(NaN, pb)` is
  // `NaN`, `NaN` propagates to the height, and `NaN < 1e-6` is **false**, so the
  // degenerate guard below waved it through to `createLinearGradient(0, NaN, 0,
  // NaN)` — which throws `IndexSizeError` on a real canvas and takes the whole
  // chart down. The region is seeded from the baseline pixel (always in-domain,
  // via `resolveAreaBaseline`) and widened only by extremes that have a
  // position, so the grade still spans the part of the series that draws.
  let regionTop = baselinePx;
  let regionBottom = baselinePx;
  const widen = (px: number): void => {
    if (!Number.isFinite(px)) return;
    if (px < regionTop) regionTop = px;
    if (px > regionBottom) regionBottom = px;
  };
  widen(yScale(valueExtent[0]));
  widen(yScale(valueExtent[1]));
  // `!(… >= 1e-6)` rather than `< 1e-6`, so a non-finite height — a baseline
  // that somehow has no position either, leaving nothing finite to anchor on —
  // falls back to the flat fill instead of reaching the gradient calls.
  if (!(regionBottom - regionTop >= 1e-6)) return style.fill; // degenerate

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

/**
 * The banded fill + stroke for `<AreaChart thresholds>` ([PND-BANDAREA]): one
 * vertical **hard-stop gradient in pixel space**, a colour switch at every
 * threshold crossing — `colors[0]` between `-t0` and `+t0`, `colors[k]` over
 * magnitudes `[t(k-1), tk)` on both sides of zero. `thresholds`/`colors` arrive
 * as a resolved {@link BandLadder} (ascending, positive, `n + 1` colours), the
 * same currency `drawBars` takes.
 *
 * A gradient rather than one clipped redraw per band, and that is the
 * load-bearing choice: K + 1 clipped passes walk the path K + 1 times and meet
 * themselves at every boundary with an antialiased seam, where a gradient
 * draws the identical single path once and costs O(K) colour stops. It also
 * bands the **outline for free** — `strokeStyle` takes the same gradient, so
 * the value line switches hue exactly at a crossing, which no per-band clip
 * can do without shearing the stroke.
 *
 * The ladder is walked on the **magnitude** and mirrored below zero, exactly
 * as `bandSpan` does for a bar: the boundary at `±tk` separates band `k` (the
 * zero side) from band `k + 1` (the away side). Whether "away from zero" is up
 * or down the canvas is probed from the scale itself (`t0` vs `t0 + 1`, both
 * positive and finite by construction), so a flipped axis bands correctly. A
 * boundary with **no position** on the scale contributes no crossing — on a
 * log axis the negative mirrors (and zero) simply don't exist, which is the
 * right reading. A crossing **off the plot** clamps to the gradient's ends
 * (a real canvas throws on stops outside `[0, 1]`), which is also what makes a
 * zoomed-in view honest: with every visible pixel inside one band, the clamp
 * degenerates the other stops and the whole plot paints that band's colour.
 *
 * Falls back to the top band's flat colour when there is nothing to anchor on
 * (no plot height, or no boundary with a position at all) — reachable only
 * with a degenerate scale stub, since every real axis positions a positive
 * finite value; any flat colour is equally (in)correct there, and the top
 * band's is at least stable.
 *
 * Like the bar ladder, breakpoints are **absolute data values**, so the
 * baseline plays no part here: an area resting on a non-zero floor still bands
 * at the same heights as its neighbours — measuring from the resolved baseline
 * instead would silently shift every breakpoint by the floor, the quiet
 * wrongness [PND-BANDBAR2] exists to remove.
 */
export function buildBandGradient(
  ctx: CanvasRenderingContext2D,
  yScale: Scale,
  plotHeight: number,
  banding: BandLadder,
): CanvasGradient | string {
  const { thresholds, colors } = banding;
  const fallback = colors[colors.length - 1]!;
  // Guards NaN too — `!(x > 0)`, not `x <= 0`.
  if (!(plotHeight > 0)) return fallback;
  // Axis direction: does value increase toward smaller pixels (the canvas
  // norm)? Probed on the ladder's own first breakpoint — positive and finite
  // by construction, so it has a position on every axis kind (linear, log,
  // symlog). Non-finite or equal probes default to the norm.
  const pA = yScale(thresholds[0]!);
  const pB = yScale(thresholds[0]! + 1);
  const higherValueAtSmallerPx = !(
    Number.isFinite(pA) &&
    Number.isFinite(pB) &&
    pB > pA
  );
  // Every scalable crossing, as (pixel, colour above it, colour below it) —
  // "above/below" in *pixel* terms. |v| grows upward through +tk and downward
  // through -tk, so which side carries the away-from-zero colour flips with
  // the boundary's sign (and with the axis direction).
  interface Crossing {
    readonly px: number;
    readonly above: string;
    readonly below: string;
  }
  const crossings: Crossing[] = [];
  for (let k = 0; k < thresholds.length; k += 1) {
    const zeroSide = colors[k]!;
    const awaySide = colors[k + 1]!;
    for (const v of [thresholds[k]!, -thresholds[k]!]) {
      const px = yScale(v);
      if (!Number.isFinite(px)) continue; // no position — no crossing
      const awayAbove = v > 0 === higherValueAtSmallerPx;
      crossings.push(
        awayAbove
          ? { px, above: awaySide, below: zeroSide }
          : { px, above: zeroSide, below: awaySide },
      );
    }
  }
  if (crossings.length === 0) return fallback;
  crossings.sort((a, b) => a.px - b.px);
  const grad = ctx.createLinearGradient(0, 0, 0, plotHeight);
  const offsetOf = (px: number): number => {
    const o = px / plotHeight;
    return o < 0 ? 0 : o > 1 ? 1 : o;
  };
  // Each crossing is a hard stop: two stops at one offset, old colour then
  // new. The region above the first crossing seeds the walk; clamped
  // off-plot crossings collapse to zero-height regions at the ends, leaving
  // the visible span in the band it actually occupies.
  grad.addColorStop(0, crossings[0]!.above);
  for (const c of crossings) {
    const off = offsetOf(c.px);
    grad.addColorStop(off, c.above);
    grad.addColorStop(off, c.below);
  }
  grad.addColorStop(1, crossings[crossings.length - 1]!.below);
  return grad;
}

/**
 * **Is the pointer inside this area?** The filled-region counterpart of
 * `traceHitIndex` ([PND-TRACESEL]) — returns the nearest sample's index as
 * click provenance, or `null` when the pointer is outside the fill.
 *
 * An area is not a stroke, so the test is not distance-to-path: the pointer is
 * on the area when it lies **between the trace and the baseline** at that x.
 * That is the honest reading of "you clicked the area", and it makes the whole
 * filled shape the target rather than a 1.5px edge — which is the same reason
 * the list family made the row the target rather than the bar.
 *
 * The x cut bisects `xScale(cs.x[i])` for `traceHitIndex`'s reasons (a layer's
 * `hitTest` gets the forward scale only, and a trading-time scale has no honest
 * inverse), and the trace's y is **interpolated** between the bracketing
 * samples so the boundary follows the drawn edge rather than a step. A tolerance
 * is still added, so the top edge is grabbable from just outside.
 *
 * A gap is a hole, not a bridge: either bracketing sample non-finite ⇒ no hit,
 * matching what `drawArea` actually fills.
 */
export function areaHitIndex(
  cs: ChartSeries,
  baseline: number | undefined,
  px: number,
  py: number,
  xScale: Scale,
  yScale: Scale,
  tolerance = TRACE_HIT_PX,
): number | null {
  const n = cs.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xScale(cs.x[mid]!) < px) lo = mid + 1;
    else hi = mid;
  }
  // The bracketing pair around the pointer. At either end of the series the
  // pair degenerates to one sample, which is correct — the fill stops there.
  const i = Math.max(0, Math.min(n - 1, lo));
  const j = Math.max(0, Math.min(n - 1, lo === 0 ? 0 : lo - 1));
  const yi = cs.y[i]!;
  const yj = cs.y[j]!;
  if (!Number.isFinite(yi) || !Number.isFinite(yj)) return null;
  const xi = xScale(cs.x[i]!);
  const xj = xScale(cs.x[j]!);
  // Interpolate the edge at the pointer's x, so the boundary is the drawn
  // slope and not a staircase. Guard the degenerate same-pixel pair.
  const t = xi === xj ? 0 : (px - xj) / (xi - xj);
  const edgePx = yScale(yj + (yi - yj) * Math.max(0, Math.min(1, t)));
  const basePx =
    baseline === undefined ? baselinePxFromScale(yScale) : yScale(baseline);
  const top = Math.min(edgePx, basePx) - tolerance;
  const bottom = Math.max(edgePx, basePx) + tolerance;
  if (py < top || py > bottom) return null;
  // Outside the series' own x span there is no fill to be inside of.
  if (px < xScale(cs.x[0]!) - tolerance) return null;
  if (px > xScale(cs.x[n - 1]!) + tolerance) return null;
  return Math.abs(px - xi) <= Math.abs(px - xj) ? i : j;
}

/**
 * The style an area fills with in a given interaction state
 * ([PND-TRACESEL]) — the {@link AreaStyle} counterpart of `traceStateStyle`.
 *
 * The channels differ from a line's because what carries the mark differs: an
 * area's mark is its **fill**, so state is the fill's strength plus the edge's
 * weight. A line has only a stroke, so there weight is all there is.
 *
 * Alpha comes back separately, as it does for a line, so a muted area keeps its
 * hue rather than having the fade baked into a colour.
 */
export function areaStateStyle(
  style: AreaStyle,
  state: TraceState,
): readonly [AreaStyle, number] {
  const emphasised: AreaStyle = {
    ...style,
    width: style.selectedWidth ?? style.width * 2,
    fillOpacity:
      style.selectedFillOpacity ?? Math.min(style.fillOpacity * 2, 1),
  };
  switch (state) {
    case 'selected':
      return [emphasised, 1];
    case 'hover':
      return [emphasised, 1];
    case 'dimmed':
      return [style, style.dimmedOpacity ?? 0.32];
    case 'rest':
      return [style, 1];
  }
}
