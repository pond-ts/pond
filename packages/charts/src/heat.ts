import { barSpanPx } from './range.js';
import type { StackedBarSeries } from './data.js';
import type { Scale } from './line.js';
import type { Orientation, StackMark } from './bars.js';
import { visibleSpanRange } from './culling.js';
import {
  decimateHeat,
  decimateHeatRows,
  type DecimateOption,
} from './decimate.js';

/**
 * Heat-map geometry: a grid of cells, each filled by the colour its **value**
 * maps to. Bins run along x, the series' **columns** run down y, and colour
 * carries the aggregate.
 *
 * **Why this reuses {@link StackedBarSeries}.** That type is already exactly a
 * heat map's data: `[begin, end]` spans per bin, a named second dimension in
 * `groups`, and a row-major `length × groups.length` grid of `values`. So a heat
 * map needs **no reader of its own** — `stacksFromColumns(series, columns)`
 * produces all four shapes pond can express today:
 *
 * | source | columns | x axis |
 * | --- | --- | --- |
 * | `TimeSeries` | one | time intervals — a stripe |
 * | `TimeSeries` | many | time intervals — a grid |
 * | `ValueSeries` | one | value intervals — a bin stripe |
 * | `ValueSeries` | many | value intervals — a grid |
 *
 * The stripe is just `groups.length === 1`, so there is one draw path, not two.
 *
 * **What that buys on x.** Because the spans are the ordinary bin spans, the
 * whole of pond's binning machinery applies unchanged — `aggregate` over a
 * trading calendar with sessions, `Sequence.calendar` day/week/month buckets,
 * `byColumn` value bands. The heat map inherits all of it by not having an
 * opinion.
 *
 * **What it costs on y.** The y dimension **must be columns**. A month-of-year
 * grid means building a column per month; a per-city grid means a column per
 * city (`pivotByGroup`'s long→wide output, or `partitionBy` reshaped). That is
 * a real constraint, and a deliberate one: it keeps the second dimension in the
 * data model, where pond's own reshaping operators can produce it, instead of
 * inventing a chart-level pivot.
 */

/** Cell styling. Colour is data and comes from the caller's ramp, so this is
 *  only the geometry and the live-cell treatment. */
export interface HeatStyle {
  /** Alpha for a resting cell. A live cell pops to 1, as bars do. */
  readonly opacity: number;
  /** Outline colour for the selected cell. */
  readonly highlight: string;
  /** Selected-cell stroke width in px. */
  readonly outlineWidth: number;
  /** Px inset around each cell, in both axes. `0` tiles them flush. */
  readonly gap: number;
  /** Px floor on a cell's width, so a thin bin stays visible. */
  readonly minWidth: number;
}

/**
 * Map a value onto a **banded** ramp: `colors` split `[lo, hi]` into equal
 * steps and a value takes the colour of the band it falls in.
 *
 * Banded rather than interpolated on purpose. It is what the climate-stripes
 * card does today (its `anomalyStep` buckets into the ramp's length, which this
 * replaces), it is the conventional reading for stripes and calendar heat maps,
 * and a banded scale is honest about resolution in a way a smooth gradient is
 * not — you can count the steps and read a cell against a legend. With nine or
 * more stops it is visually indistinguishable from a gradient anyway.
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
  // than falling off (t === 1 would index one past the end), and so a value
  // outside a *pinned* domain reads at the extreme instead of vanishing.
  return colors[Math.min(colors.length - 1, Math.max(0, band))];
}

/**
 * The `[min, max]` of the finite values across **every** cell — the colour
 * domain when the caller does not pin one. `null` when nothing is finite.
 *
 * Deliberately **not** widened to include `0`, unlike `barExtent`: a bar's
 * height is measured from a baseline so zero must be in the domain, but a
 * cell's colour is measured against the data's own range. Widening would waste
 * half the ramp on an all-positive grid.
 *
 * Note this spans the **whole grid**, not each row — every row is read against
 * one scale, which is what makes rows comparable to each other.
 */
export function heatValueExtent(ss: StackedBarSeries): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < ss.values.length; i += 1) {
    const v = ss.values[i]!;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min === Infinity ? null : [min, max];
}

/**
 * The pixel rect of the cell at bin `b`, row `g` — `[x0, x1, yTop, yBottom]`,
 * ascending on both axes — or `null` for a gap (non-finite value), which draws
 * nothing and owns no hit region so a hole in the record reads as a hole.
 *
 * x comes from the bin's own span via {@link barSpanPx}, shared with bars so
 * cells and bars tile identically. y is the row's **unit slot** `[g, g+1]`
 * through the y scale, which is why the layer reports `yExtent` as `[0, G]` and
 * labels rows via `binCategories` at each slot centre.
 *
 * **Row order follows the y scale**, so with the usual inverted pixel range row
 * `0` sits at the *bottom*. That matches the existing band-axis convention
 * (a horizontal histogram's first bin is its lowest), and a caller who wants
 * the first column at the top reverses the column list.
 */
export function cellRect(
  ss: StackedBarSeries,
  b: number,
  g: number,
  xScale: Scale,
  yScale: Scale,
  gapPx: number,
  minWidthPx: number,
  orientation: Orientation = 'vertical',
): [x0: number, x1: number, yTop: number, yBottom: number] | null {
  const G = ss.groups.length;
  if (!Number.isFinite(ss.values[b * G + g]!)) return null;
  const vertical = orientation === 'vertical';
  // Two position axes, neither of them a value axis — which is what makes a heat
  // map's transpose simpler than a bar's. `'horizontal'` swaps which scale
  // carries the bins and which carries the group slots; nothing else moves.
  const binScale = vertical ? xScale : yScale;
  const groupScale = vertical ? yScale : xScale;
  const [spanLo, spanHi] = barSpanPx(
    ss.begin[b]!,
    ss.end[b]!,
    binScale,
    gapPx,
    minWidthPx,
  );
  const [bandLo, bandHi] = slotBandPx(groupScale, g, g + 1, gapPx);
  return vertical
    ? [spanLo, spanHi, bandLo, bandHi]
    : [bandLo, bandHi, spanLo, spanHi];
}

/** The pixel band of unit slots `[a, b)` on the group axis, ascending, inset by
 *  the gap but never past collapsing. Shared by the draw loop and `cellRect`. */
function slotBandPx(
  groupScale: Scale,
  a: number,
  b: number,
  gapPx: number,
): [lo: number, hi: number] {
  const p0 = groupScale(a);
  const p1 = groupScale(b);
  const lo = Math.min(p0, p1);
  const hi = Math.max(p0, p1);
  const inset = Math.min(gapPx / 2, Math.max(0, (hi - lo) / 2 - 0.5));
  return [lo + inset, hi - inset];
}

/** Does `m` identify the cell at (`b`, `g`)? The stacked rule, unchanged: the
 *  layer `id` plus either the stable per-bin `mark` or the bin `key` + row
 *  `label`. Sharing it keeps one selection vocabulary across bars and cells. */
function matchesCell(
  m: StackMark | null,
  seriesId: string | undefined,
  ss: StackedBarSeries,
  b: number,
  g: number,
): boolean {
  if (m === null || m.id !== seriesId) return false;
  const stable = ss.marks?.[b];
  return stable !== undefined
    ? m.mark === stable && m.label === ss.groups[g]
    : m.key === ss.begin[b] && m.label === ss.groups[g];
}

/** The canvas' backing-buffer width over the x scale's CSS pixel width — the
 *  device pixel ratio, recovered rather than read from `window` so a headless
 *  context (no canvas, no range) degrades to `1` instead of throwing. */
function devicePixelRatioOf(
  ctx: CanvasRenderingContext2D,
  xScale: Scale,
): number {
  const w = (ctx as unknown as { canvas?: { width?: number } }).canvas?.width;
  const r = (xScale as unknown as { range?: () => number[] }).range?.();
  if (typeof w !== 'number' || w <= 0 || r === undefined || r.length < 2)
    return 1;
  const css = Math.abs(+r[r.length - 1]! - +r[0]!);
  return css > 0 ? w / css : 1;
}

/**
 * Fill one rectangle per cell, coloured by `colorAt(b, g)`. A gap is skipped.
 *
 * A live cell keeps its **own** colour. The colour is never swapped for a
 * highlight, because that colour *is* the datum — replacing it would erase the
 * reading the chart exists to give.
 *
 * That rules out the bar layers' usual affordance too. A bar says "live" by
 * popping from `opacity` to 1, which on a heat map is both invisible (a ramp is
 * normally drawn at full opacity already) and, where it isn't, actively
 * misleading — dimming a cell shifts where the reader places it on the colour
 * scale. So a live cell is marked by an **outline** instead: `outlineWidth` for
 * hover, twice that for selection, both in `style.highlight`. The alpha pop is
 * kept as well, so a theme that does draw cells translucent still behaves like
 * its bars.
 *
 * Hover and selection share one colour deliberately — whether they should
 * diverge is the open question in #577, and this layer should not pre-empt it.
 *
 * O(visible × G) after viewport culling on the bin axis.
 */
export function drawHeat(
  ctx: CanvasRenderingContext2D,
  ss: StackedBarSeries,
  xScale: Scale,
  yScale: Scale,
  style: HeatStyle,
  colorOf: (value: number) => string | undefined,
  seriesId: string | undefined,
  selection: StackMark | null,
  hovered: StackMark | null,
  decimate: DecimateOption = true,
  orientation: Orientation = 'vertical',
): void {
  const vertical = orientation === 'vertical';
  const binScale = vertical ? xScale : yScale;
  const groupScale = vertical ? yScale : xScale;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  const [srcStart, srcEnd] = visibleSpanRange(
    ss.begin,
    ss.end,
    ss.length,
    binScale,
  );

  // Both decimators work along whichever axis they reduce, so each needs that
  // axis' extent in DEVICE pixels. The ratio is isotropic, so it is recovered
  // once from x and applied to both.
  const dpr = devicePixelRatioOf(ctx, xScale);
  const spanCss = (s: Scale, a: number, b: number) => Math.abs(s(b) - s(a));

  // Once the visible cells are denser than ~2 per device pixel they overlap and
  // overpaint each other, so the picture is already a reduction — just a bad
  // one, picked by loop order. Replace it with the mean per pixel column, which
  // is what the overdrawn version resolves to at this size and costs O(W·G)
  // rects instead of O(V·G). See `decimateHeat` for why a heat map can do this
  // where a per-bar-coloured `<BarChart>` cannot.
  const thinned =
    decimate === false
      ? null
      : decimateHeat(
          ss,
          binScale,
          ctx,
          typeof decimate === 'object' ? (decimate.threshold ?? 2) : 2,
          srcStart,
          srcEnd,
          vertical
            ? undefined
            : (() => {
                const dom = [ss.begin[0] ?? 0, ss.end[ss.length - 1] ?? 0];
                const css = spanCss(binScale, dom[0]!, dom[1]!);
                return {
                  deviceCount: Math.max(1, Math.round(css * dpr)),
                  spanCss: css,
                };
              })(),
        );
  const grid = thinned ?? ss;
  const srcRows = grid.groups.length;
  const [vStart, vEnd] = thinned
    ? [0, thinned.length]
    : ([srcStart, srcEnd] as const);

  // The y half. Whichever axis is oversampled the argument is identical, and a
  // gene matrix (10,000 rows x 8 samples) is oversampled on the axis the column
  // decimator above cannot touch. `deviceRows` is the plot height in *device*
  // pixels: the DPR is recovered from the x scale, since a canvas' backing width
  // over its CSS width is the same ratio in both directions.
  const k = typeof decimate === 'object' ? (decimate.threshold ?? 2) : 2;
  const rowsThinned =
    decimate === false
      ? null
      : decimateHeatRows(
          thinned ? grid.values : ss.values,
          thinned ? grid.length : ss.length,
          srcRows,
          Math.max(1, Math.floor(spanCss(groupScale, 0, srcRows) * dpr)),
          k,
        );

  const values = rowsThinned ? rowsThinned.values : grid.values;
  const G = rowsThinned ? rowsThinned.rows : srcRows;
  // Row `r` of a thinned grid covers source rows `[r·stride, (r+1)·stride]`, so
  // its band is read off the UNCHANGED y scale — the coordinate space, and every
  // axis tick in it, is untouched by the reduction.
  const stride = rowsThinned ? rowsThinned.stride : 1;

  // An aggregated column or row has no per-cell identity to match against, and a
  // sub-pixel outline would not be visible anyway. Interaction still reads the
  // source grid via `heatAt`.
  const reduced = thinned !== null || rowsThinned !== null;
  const sel = reduced ? null : selection;
  const hov = reduced ? null : hovered;

  // The row bands, once. Each depends only on `g`, so computing them inside the
  // cell loop re-derived the same G boundaries for every visible bin — O(V·G)
  // scale calls where O(G) does. Kept as two flat arrays rather than tuples so
  // the loop allocates nothing per cell. (`cellRect` still does it per call: it
  // is the hit-test's entry point, where there is exactly one cell and nothing
  // to amortize over. The two paths diverge on purpose — see perf-heat.mjs.)
  const bandLo = new Float64Array(G);
  const bandHi = new Float64Array(G);
  for (let g = 0; g < G; g += 1) {
    const [lo, hi] = slotBandPx(
      groupScale,
      g * stride,
      Math.min((g + 1) * stride, srcRows),
      style.gap,
    );
    bandLo[g] = lo;
    bandHi[g] = hi;
  }

  let lastFill: string | undefined;

  for (let b = vStart; b < vEnd; b += 1) {
    // The x span depends only on the BIN, so it is hoisted out of the row loop:
    // a 45-row grid was paying two scale calls per cell for one answer per
    // column.
    const [spanLo, spanHi] = barSpanPx(
      grid.begin[b]!,
      grid.end[b]!,
      binScale,
      style.gap,
      style.minWidth,
    );
    const base = b * G;
    for (let g = 0; g < G; g += 1) {
      // Gaps are skipped before any per-cell work, exactly as `cellRect` does
      // by returning null: a hole in the record draws nothing and owns no hit
      // region.
      const value = values[base + g]!;
      if (!Number.isFinite(value)) continue;
      const fill = colorOf(value);
      if (fill === undefined) continue;
      // The transpose, and the only place orientation reaches the geometry:
      // which of the two spans is horizontal on the canvas.
      const x0 = vertical ? spanLo : bandLo[g]!;
      const x1 = vertical ? spanHi : bandHi[g]!;
      const yTop = vertical ? bandLo[g]! : spanLo;
      const yBottom = vertical ? bandHi[g]! : spanHi;

      const selected = matchesCell(sel, seriesId, ss, b, g);
      const live = selected || matchesCell(hov, seriesId, ss, b, g);

      ctx.globalAlpha = live ? 1 : style.opacity;
      // Assigning `fillStyle` is not free — a real canvas parses the CSS colour
      // on every set — and a banded ramp hands out long runs of the same string,
      // so set it only when it actually changes.
      if (fill !== lastFill) {
        lastFill = fill;
        ctx.fillStyle = fill;
      }
      ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      if (live) {
        // Inset by half the stroke so the outline sits inside the cell rather
        // than straddling its edge and bleeding over the neighbour — which on a
        // flush grid (`gap: 0`) would misreport the neighbour's colour.
        const w = selected ? style.outlineWidth * 2 : style.outlineWidth;
        const i = w / 2;
        ctx.lineWidth = w;
        ctx.strokeStyle = style.highlight;
        ctx.strokeRect(x0 + i, yTop + i, x1 - x0 - w, yBottom - yTop - w);
      }
    }
  }
  ctx.restore();
}

/**
 * Hit-test plot-pixel `(px, py)` against the grid — the first cell whose rect
 * contains the point, or `null`. Returns `[bin, row, begin, rowName, value]`.
 *
 * The **value** is the whole point of the layer. A constant-height bar carries
 * none, which is why the climate-stripes card looks its number up out-of-band;
 * a cell answers directly, and so can the cursor.
 *
 * O(N × G), as `stackAt` is: bin and row counts are view-scale, clicks are rare.
 */
export function heatAt(
  ss: StackedBarSeries,
  px: number,
  py: number,
  xScale: Scale,
  yScale: Scale,
  gapPx: number,
  minWidthPx: number,
  orientation: Orientation = 'vertical',
):
  | [bin: number, row: number, begin: number, name: string, value: number]
  | null {
  const G = ss.groups.length;
  for (let b = 0; b < ss.length; b += 1) {
    for (let g = 0; g < G; g += 1) {
      const rect = cellRect(
        ss,
        b,
        g,
        xScale,
        yScale,
        gapPx,
        minWidthPx,
        orientation,
      );
      if (rect === null) continue;
      const [x0, x1, yTop, yBottom] = rect;
      if (px >= x0 && px <= x1 && py >= yTop && py <= yBottom) {
        return [b, g, ss.begin[b]!, ss.groups[g]!, ss.values[b * G + g]!];
      }
    }
  }
  return null;
}
