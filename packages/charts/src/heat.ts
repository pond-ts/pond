import { barSpanPx } from './range.js';
import type { BarSeries } from './data.js';
import type { Scale } from './line.js';
import { visibleSpanRange } from './culling.js';

/**
 * Heat-map geometry: a row of cells tiling the x axis, each filled by the
 * colour its **value** maps to.
 *
 * **Why this reuses {@link BarSeries}.** A one-row heat map *is* a bar series
 * geometrically — the same `[begin, end]` spans, read by the same key-shape
 * rules (an interval key uses its own span; a point key tiles by neighbour
 * spacing). What differs is only the draw and the readout: every cell fills the
 * full plot height instead of rising to its value, and the value is carried by
 * colour rather than by height. So there is no new reader here, and
 * `BarSeries.y` is simply read as "the value colour encodes".
 *
 * That equivalence is the prototype's most useful finding: the climate-stripes
 * card already builds exactly this by hand, with a constant `stripe: 1` column
 * whose only job is to make every bar full height, and `binColors` carrying the
 * encoding. This layer deletes both workarounds.
 *
 * **A second dimension is not built yet.** `yExtent` is the degenerate `[0, 1]`
 * — one row filling the plot. Rows (calendar position, category, value bucket)
 * subdivide that span and are the open design question in [PND-HEATMAP]; the
 * geometry below takes the row band as an explicit `[y0, y1]` so adding them
 * does not change the call shape.
 */
export interface HeatStyle {
  /** Alpha for a resting cell. A live cell pops to 1, as bars do. */
  readonly opacity: number;
  /** Outline colour for the selected cell. */
  readonly highlight: string;
  /** Selected-cell stroke width in px. */
  readonly outlineWidth: number;
  /** Px inset between adjacent cells. `0` tiles them flush — the stripes look. */
  readonly gap: number;
  /** Px floor on a cell's width, so a thin bucket stays visible. */
  readonly minWidth: number;
}

/**
 * Map a value onto a **banded** ramp: `colors` split the `[lo, hi]` domain into
 * equal steps and a value takes the colour of the band it falls in.
 *
 * Banded rather than interpolated on purpose. It is what the climate-stripes
 * card does today (its `anomalyStep` buckets into the ramp's length, which this
 * replaces), it is the conventional reading for stripes and calendar heat maps,
 * and a banded scale is honest about resolution in a way a smooth gradient is
 * not — you can count the steps and read a cell against the legend. Continuous
 * interpolation is the obvious later option; it is not needed to answer the
 * questions this prototype exists to answer.
 *
 * A non-finite value, or an empty ramp, yields `undefined` — the caller decides
 * whether that is a skipped cell or a fallback fill.
 */
export function bandedColor(
  value: number,
  colors: readonly string[],
  lo: number,
  hi: number,
): string | undefined {
  if (!Number.isFinite(value) || colors.length === 0) return undefined;
  if (!(hi > lo)) return colors[colors.length - 1]; // degenerate domain: one band
  const t = (value - lo) / (hi - lo);
  const band = Math.floor(t * colors.length);
  // Clamp so the domain's own endpoints land in the first / last band rather
  // than falling off (t === 1 would index one past the end).
  return colors[Math.min(colors.length - 1, Math.max(0, band))];
}

/**
 * The `[min, max]` of the finite values in `cs.y` — the colour domain when the
 * caller does not pin one. `null` when nothing is finite.
 *
 * Deliberately **not** widened to include `0`, unlike `barExtent`: a bar's
 * height is measured from a baseline, so zero has to be in the domain, but a
 * cell's colour is measured against the data's own range. Widening would waste
 * half the ramp on an all-positive series.
 */
export function heatValueExtent(cs: BarSeries): [number, number] | null {
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
 * The pixel rect of cell `i` — `[x0, x1, yTop, yBottom]`, ascending on both
 * axes. The x span is the key's own, inset by `gapPx` and floored at
 * `minWidthPx` ({@link barSpanPx}, shared with bars so cells and bars tile
 * identically); the y span is the row band, which for a single row is the whole
 * plot. `null` for a gap (non-finite value) — a cell with no value is not drawn
 * and owns no hit region, so a hole in the record reads as a hole.
 */
export function cellRect(
  cs: BarSeries,
  i: number,
  xScale: Scale,
  y0: number,
  y1: number,
  gapPx: number,
  minWidthPx: number,
): [x0: number, x1: number, yTop: number, yBottom: number] | null {
  if (!Number.isFinite(cs.y[i]!)) return null;
  const [x0, x1] = barSpanPx(
    cs.begin[i]!,
    cs.end[i]!,
    xScale,
    gapPx,
    minWidthPx,
  );
  return [x0, x1, Math.min(y0, y1), Math.max(y0, y1)];
}

/** The row band in pixels — the full plot, read off the y scale's own domain.
 *  One row for now; rows will subdivide this. */
function rowBand(yScale: Scale): [number, number] {
  const d = (yScale as unknown as { domain?: () => number[] }).domain?.();
  if (!d || d.length < 2) return [yScale(0), yScale(1)];
  return [yScale(d[0]!), yScale(d[d.length - 1]!)];
}

/**
 * Fill one rectangle per cell, coloured by `colorAt`. A gap (non-finite value)
 * is skipped. The cell matching `selection` draws outlined in the style's
 * `highlight`; either live state pops to full opacity, matching the bar
 * convention — the cell keeps its *own* colour, because that colour is the
 * datum and swapping it would erase the reading.
 *
 * O(visible) over the cells after viewport culling.
 */
export function drawHeat(
  ctx: CanvasRenderingContext2D,
  cs: BarSeries,
  xScale: Scale,
  yScale: Scale,
  style: HeatStyle,
  colorAt: (i: number) => string | undefined,
  seriesId: string | undefined,
  selection: { id: string; key: number; mark?: string } | null,
  hovered: { id: string; key: number; mark?: string } | null,
): void {
  ctx.save();
  ctx.globalAlpha = style.opacity;
  const [y0, y1] = rowBand(yScale);
  const [vStart, vEnd] = visibleSpanRange(cs.begin, cs.end, cs.length, xScale);
  const marks =
    selection?.mark !== undefined || hovered?.mark !== undefined
      ? cs.marks
      : undefined;

  for (let i = vStart; i < vEnd; i += 1) {
    const rect = cellRect(cs, i, xScale, y0, y1, style.gap, style.minWidth);
    if (rect === null) continue;
    const fill = colorAt(i);
    if (fill === undefined) continue;
    const [x0, x1, yTop, yBottom] = rect;

    const stable = marks?.[i];
    const matches = (m: typeof selection): boolean =>
      m !== null &&
      m.id === seriesId &&
      (m.mark !== undefined && stable !== undefined
        ? m.mark === stable
        : m.key === cs.begin[i]);
    const selected = matches(selection);
    const live = selected || matches(hovered);

    ctx.globalAlpha = live ? 1 : style.opacity;
    ctx.fillStyle = fill;
    ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
    if (selected) {
      ctx.lineWidth = style.outlineWidth;
      ctx.strokeStyle = style.highlight;
      ctx.strokeRect(x0, yTop, x1 - x0, yBottom - yTop);
    }
  }
  ctx.restore();
}

/**
 * Hit-test plot-pixel `(px, py)` against the cells — the first whose rect
 * contains the point, or `null`. Returns `[index, begin, value]`.
 *
 * The **value** in that tuple is the whole point of the layer. The stripes
 * workaround cannot answer "what number is this colour" from the chart at all
 * — the card looks it up out-of-band, keyed by the year the tracker reports,
 * because a constant-height bar carries no value. A cell does.
 *
 * O(N) over the cells, as `barAt` is: counts are view-scale and clicks are rare.
 */
export function heatAt(
  cs: BarSeries,
  px: number,
  py: number,
  xScale: Scale,
  yScale: Scale,
  gapPx: number,
  minWidthPx: number,
): [index: number, begin: number, value: number] | null {
  const [y0, y1] = rowBand(yScale);
  for (let i = 0; i < cs.length; i += 1) {
    const rect = cellRect(cs, i, xScale, y0, y1, gapPx, minWidthPx);
    if (rect === null) continue;
    const [x0, x1, yTop, yBottom] = rect;
    if (px >= x0 && px <= x1 && py >= yTop && py <= yBottom) {
      return [i, cs.begin[i]!, cs.y[i]!];
    }
  }
  return null;
}
