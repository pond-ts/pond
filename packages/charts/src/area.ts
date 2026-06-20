import { area as d3area, curveLinear, type CurveFactory } from 'd3-shape';
import type { ChartSeries } from './data.js';
import type { Scale } from './line.js';
import type { AreaStyle } from './theme.js';

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
 * **Gap-aware** via `.defined(Number.isFinite)` — a non-finite value ends the
 * current subpath; the next finite run starts a fresh one, so a coast is a break
 * in both the fill and the outline, never a bridge to the baseline
 * (`docs/rfcs/charts.md` trap #2).
 *
 * `cs.y` (a `Float64Array`) is the datum iterable; accessors read by index, so
 * there's no per-point object allocation. The gradient + `globalAlpha` are
 * bracketed by `save`/`restore` so they don't leak into later layers.
 */
export function drawArea(
  ctx: CanvasRenderingContext2D,
  cs: ChartSeries,
  xScale: Scale,
  yScale: Scale,
  style: AreaStyle,
  baselineValue: number,
  curve: CurveFactory = curveLinear,
): void {
  const baselinePx = yScale(baselineValue);
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
  // one-sided elevation form and the two-sided above/below form).
  ctx.fillStyle = buildGradient(ctx, cs, yScale, baselinePx, style);
  ctx.globalAlpha = style.fillOpacity;
  ctx.beginPath();
  gen(cs.y);
  ctx.fill();
  ctx.restore();

  // The outline on top: the area's top edge as a line (`lineY1` inherits the
  // area's `defined`, `curve`, and `context`, so it breaks at the same gaps),
  // at full opacity over the graded fill.
  const outline = gen.lineY1();
  ctx.save();
  ctx.beginPath();
  outline(cs.y);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.stroke();
  ctx.restore();
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
  cs: ChartSeries,
  yScale: Scale,
  baselinePx: number,
  style: AreaStyle,
): CanvasGradient | string {
  let topPx = Infinity; // smallest pixel y (highest on screen)
  let bottomPx = -Infinity; // largest pixel y (lowest on screen)
  for (let i = 0; i < cs.length; i += 1) {
    const v = cs.y[i]!;
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

/**
 * Re-express a CSS hex colour (`#rgb` / `#rrggbb`) as `rgba(...)` with the given
 * alpha, for the transparent gradient stop. A non-hex string (named colour,
 * already-rgba) is returned unchanged at alpha 0 only when it's hex; otherwise
 * we fall back to `transparent` so the stop is still see-through.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (m === null) return alpha === 0 ? 'transparent' : color;
  let r: number;
  let g: number;
  let b: number;
  if (m[1]!.length === 3) {
    r = parseInt(m[1]![0]! + m[1]![0]!, 16);
    g = parseInt(m[1]![1]! + m[1]![1]!, 16);
    b = parseInt(m[1]![2]! + m[1]![2]!, 16);
  } else {
    r = parseInt(m[1]!.slice(0, 2), 16);
    g = parseInt(m[1]!.slice(2, 4), 16);
    b = parseInt(m[1]!.slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
