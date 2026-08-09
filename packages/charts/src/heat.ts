import { barSpanPx } from './range.js';
import type { StackedBarSeries } from './data.js';
import type { Scale } from './line.js';
import type { Orientation, StackMark } from './bars.js';
import type { SpanSelection } from './context.js';
import type { HeatStates } from './theme.js';
import { NO_SPANS, spanContainsPoint } from './span.js';
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
/**
 * How value maps onto the ramp's bands.
 *
 * `'linear'` splits the domain into equal-width bands. `'log'` splits it into
 * equal-*ratio* bands, which is what a quantity spanning orders of magnitude
 * needs: US measles incidence runs from ~2,900 per 100k before the vaccine to
 * under 1 after it, and linear banding over eight colours puts everything below
 * ~360 in one band — the whole post-1965 record, which is the half the chart
 * exists to show.
 */
export type HeatScale = 'linear' | 'log';

/** How a cell with no value is drawn. */
export type HeatNoData = 'blank' | 'hatch';

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
  /** Stroke for the `'hatch'` no-data fill — the theme's grid colour, so it
   *  reads as chart furniture rather than as a value. */
  readonly gridColor: string;
  /**
   * The **interaction states** ({@link HeatStates}), from `theme.heat`. Unset
   * ⇒ the pre-states treatment exactly: a live cell gets one outline of its
   * own in {@link highlight}, `outlineWidth` for hover and twice that for
   * selection, and nothing recedes.
   */
  readonly states?: HeatStates;
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
  scale: HeatScale = 'linear',
): string | undefined {
  if (!Number.isFinite(value) || colors.length === 0) return undefined;
  if (!(hi > lo)) return colors[colors.length - 1]; // degenerate domain: one band
  // `log` bands on `log1p` of the offset from `lo`, not on `log`, so that a
  // value **at** `lo` is a real band rather than `-Infinity`. Zero is the common
  // case that needs it — an incidence grid is mostly zeros once a disease is
  // eliminated, and those cells are the point of the chart, not an edge case.
  const clamped = Math.min(hi, Math.max(lo, value));
  const t =
    scale === 'log'
      ? Math.log1p(clamped - lo) / Math.log1p(hi - lo)
      : (value - lo) / (hi - lo);
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

/** Stable identity for "no marks" — the resting case, so a caller narrowing an
 *  empty set never hands `drawHeat` a fresh array, and the default argument is
 *  one allocation for the module rather than one per call. */
const NO_MARKS: readonly StackMark[] = [];

/**
 * Collect into `out` the **row labels** of every member of `set` naming bin `b`
 * of this series ([PND-MULTISEL] / RFC A4.3).
 *
 * **The identity rule is unchanged** from when this layer matched one mark: a
 * member identifies the cell at (`b`, `g`) when its layer `id` matches, its bin
 * half matches (the stable per-bin `mark` where the series carries one, else the
 * bin `key`), and its `label` is the row's group. Keeping that rule is what
 * keeps one selection vocabulary across bars and cells. This function applies
 * the first two, and leaves the row loop the `label` compare.
 *
 * **Why it splits there.** The bin half depends only on `b`, so scanning the
 * whole set per *cell* would be O(V·G·|set|); scanning it per *bin* and leaving
 * the row loop a label compare against the handful that survive is
 * O(V·|set| + V·G·k), where k is 0 for almost every bin. On a 365×45 grid with
 * eight marks live that is ~3k member compares instead of ~130k, and it is why
 * a heat-map repaint under a plural pin costs what it did under a single one
 * (`scripts/perf-heat.mjs`).
 *
 * Linear over the set rather than indexed, the reasoning `barMatchesAny`
 * records: a selection is a handful of cells a person clicked, not a data
 * structure. `out` is the caller's reused scratch array, so this allocates
 * nothing.
 */
function binLabelsInto(
  out: string[],
  set: readonly StackMark[],
  seriesId: string | undefined,
  ss: StackedBarSeries,
  b: number,
): void {
  out.length = 0;
  const stable = ss.marks?.[b];
  const begin = ss.begin[b];
  for (let i = 0; i < set.length; i += 1) {
    const m = set[i]!;
    if (m.id !== seriesId) continue;
    if (stable !== undefined ? m.mark === stable : m.key === begin)
      out.push(m.label);
  }
}

/** Is `label` one of the (usually zero or one) labels {@link binLabelsInto}
 *  gathered for this bin? Indexed rather than `includes` — this is the draw's
 *  inner loop. */
function hasLabel(labels: readonly string[], label: string): boolean {
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === label) return true;
  }
  return false;
}

/**
 * Does any member of `set` name this series at all? A cheap once-per-draw gate
 * so a grid whose selection belongs to some *other* layer — the common case on a
 * multi-layer row — never pays the per-cell scan, and a resting draw pays
 * nothing beyond the two `length === 0` checks it always did.
 */
function namesSeries(
  set: readonly StackMark[],
  seriesId: string | undefined,
): boolean {
  if (seriesId === undefined) return false; // a no-id layer is never selectable
  for (let i = 0; i < set.length; i += 1) {
    if (set[i]!.id === seriesId) return true;
  }
  return false;
}

/**
 * Fill one cell with diagonal hatching — the no-data mark.
 *
 * Drawn as clipped strokes per cell rather than a `createPattern` fill, because
 * a pattern needs a second canvas to build and this runs in headless contexts
 * (tests, SSR) that have no `document`. The cost is a few strokes per hole, and
 * holes are by definition the cells with nothing else to draw; a decimated grid
 * skips them entirely, since an aggregated cell is not a hole.
 */
function hatchCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  if (!(w > 0) || !(h > 0)) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // 45° lines every 4px. Sweeping from `-h` covers the corners the diagonal
  // would otherwise leave bare.
  for (let d = -h; d < w; d += 4) {
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
  }
  ctx.stroke();
  ctx.restore();
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
 * Both `selection` and `hovered` are **sets**: `ContainerFrame.selected` has
 * been one since [PND-MULTISEL] and `hovered` since RFC A4.3, so **every** cell
 * a member names lights — a pinned group of cells, or a drag-sweep hovering
 * several at once, all read back rather than only the set's first member. A cell
 * in **both** sets reads as selected (selected outranks hovered, the precedence
 * `drawBars` / `drawStacks` / `drawBox` share) and takes one outline, never two.
 *
 * O(visible × G) after viewport culling on the bin axis, plus O(|set|) per
 * visible **bin** (not per cell — see {@link binLabelsInto}) and only when a set
 * names this layer at all, so a resting draw costs exactly what it did.
 */
export function drawHeat(
  ctx: CanvasRenderingContext2D,
  ss: StackedBarSeries,
  xScale: Scale,
  yScale: Scale,
  style: HeatStyle,
  colorOf: (value: number) => string | undefined,
  seriesId: string | undefined,
  selection: readonly StackMark[] = NO_MARKS,
  hovered: readonly StackMark[] = NO_MARKS,
  decimate: DecimateOption = true,
  orientation: Orientation = 'vertical',
  noData: HeatNoData = 'blank',
  // Span descriptors covering this layer (interaction RFC A5.2), already
  // narrowed to its `id` by the component (`spansForLayer`). A cell is
  // selected when a mark entry names it OR a span contains it — the bin
  // `begin` in the half-open `x` interval, its **row name** in `rows` when
  // present (the ordinal second dimension, RFC A5.3 — never a numeric row
  // interval, which a reorder would invalidate), and the cell value in `y`
  // when present. The x half is narrowed once per *bin* (the same shape as
  // `binLabelsInto`'s hoist), so the row loop tests only the spans that cover
  // the column at all. Suppressed while decimated, like the mark match — an
  // aggregated cell has no per-cell identity.
  spans: readonly SpanSelection[] = NO_SPANS,
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
  const sel = reduced ? NO_MARKS : selection;
  const hov = reduced ? NO_MARKS : hovered;
  const spanSet = reduced ? NO_SPANS : spans;
  // Whether either set names *this* layer, settled once so the cell loop skips
  // the per-cell scan entirely when neither does — which is every draw on a row
  // whose selection belongs to a different layer, and every resting draw.
  const anySelected = namesSeries(sel, seriesId);
  const anyHovered = namesSeries(hov, seriesId);
  // Scratch for the per-bin narrowing below: one array each, allocated **only**
  // when a set actually names this layer and then reused across every bin — so
  // the resting frame allocates nothing per draw, which is the property this
  // path had when it matched a lone mark. `null` ⇒ that set is not in play.
  const selLabels: string[] | null = anySelected ? [] : null;
  const hovLabels: string[] | null = anyHovered ? [] : null;
  // Scratch for the per-bin span narrowing — the spans whose `x` contains the
  // current bin, reused across bins so the resting frame (and any spanless
  // frame) allocates nothing. `null` ⇒ spans are not in play at all.
  const binSpans: SpanSelection[] | null = spanSet.length > 0 ? [] : null;

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

  // ── The selected-cell grid, for the union perimeter ────────────────────
  // `states` draws ONE outline around the union of selected cells, which is
  // done by suppressing each cell edge whose neighbour is also selected. That
  // needs a membership answer for a cell's four neighbours — including the
  // ones in the columns either side, which the streaming per-bin narrowing
  // below cannot give while it is standing on a different column.
  //
  // So it is precomputed here for `[vStart - 1, vEnd]` — the window plus one
  // column each side, so a selection running off-screen does NOT grow a false
  // edge at the viewport boundary. O(W·G), the same order as the draw itself,
  // and skipped entirely when nothing is selected (the resting frame, and any
  // decimated one).
  const st = style.states;
  const perimeter = st !== undefined && (anySelected || spanSet.length > 0);
  const pStart = Math.max(0, vStart - 1);
  const pEnd = Math.min(grid.length, vEnd + 1);
  const selGrid = perimeter ? new Uint8Array((pEnd - pStart) * G) : null;
  if (selGrid !== null) {
    const labels: string[] = [];
    const covering: SpanSelection[] = [];
    for (let b = pStart; b < pEnd; b += 1) {
      if (anySelected) binLabelsInto(labels, sel, seriesId, ss, b);
      covering.length = 0;
      const begin = ss.begin[b]!;
      for (let s = 0; s < spanSet.length; s += 1) {
        const sp = spanSet[s]!;
        if (begin >= sp.x[0] && begin < sp.x[1]) covering.push(sp);
      }
      if (labels.length === 0 && covering.length === 0) continue;
      const base = b * G;
      const out = (b - pStart) * G;
      for (let g = 0; g < G; g += 1) {
        const value = values[base + g]!;
        if (!Number.isFinite(value)) continue;
        const group = ss.groups[g]!;
        let hit = hasLabel(labels, group);
        for (let s = 0; !hit && s < covering.length; s += 1) {
          hit = spanContainsPoint(covering[s]!, begin, value, group);
        }
        if (hit) selGrid[out + g] = 1;
      }
    }
  }
  /** Is cell `(b, g)` selected? Off-grid answers `false`; outside the
   *  precomputed window it is unknowable, so it also answers `false` — which
   *  cannot happen, because the window is padded by exactly the one column a
   *  neighbour test can reach. */
  const isSel = (b: number, g: number): boolean =>
    selGrid !== null &&
    b >= pStart &&
    b < pEnd &&
    g >= 0 &&
    g < G &&
    selGrid[(b - pStart) * G + g] === 1;

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
    // The selection / hover match narrowed to this bin, once per column rather
    // than once per cell: what is left for the row loop is a label compare
    // against the handful (usually none) that name this bin at all. `sel`/`hov`
    // are empty whenever the grid is reduced, so `grid === ss` here.
    if (selLabels !== null) binLabelsInto(selLabels, sel, seriesId, ss, b);
    if (hovLabels !== null) binLabelsInto(hovLabels, hov, seriesId, ss, b);
    // The span x half, once per bin: keep only the spans whose half-open `x`
    // contains this bin's `begin` — the row loop then tests just their `rows` /
    // `y` channels against the handful that survive. `spanSet` is empty
    // whenever the grid is reduced, so `grid === ss` here.
    if (binSpans !== null) {
      binSpans.length = 0;
      const begin = ss.begin[b]!;
      for (let s = 0; s < spanSet.length; s += 1) {
        const sp = spanSet[s]!;
        if (begin >= sp.x[0] && begin < sp.x[1]) binSpans.push(sp);
      }
    }
    const binIsLive =
      (selLabels !== null && selLabels.length > 0) ||
      (hovLabels !== null && hovLabels.length > 0) ||
      (binSpans !== null && binSpans.length > 0);
    const base = b * G;
    for (let g = 0; g < G; g += 1) {
      // Gaps are skipped before any per-cell work, exactly as `cellRect` does
      // by returning null: a hole in the record draws nothing and owns no hit
      // region.
      const value = values[base + g]!;
      if (!Number.isFinite(value)) {
        // A hole is not a low value, and on a pale ramp "draw nothing" reads as
        // exactly that — the background shows through at the bottom of the
        // scale. Where the distinction carries meaning (a state with no
        // surveillance yet, against a record whose late years are real zeros)
        // the cell must say so, and hatching is the convention because no ramp
        // colour can be mistaken for it.
        if (noData === 'hatch' && !reduced) {
          hatchCell(
            ctx,
            vertical ? spanLo : bandLo[g]!,
            vertical ? bandLo[g]! : spanLo,
            vertical ? spanHi - spanLo : bandHi[g]! - bandLo[g]!,
            vertical ? bandHi[g]! - bandLo[g]! : spanHi - spanLo,
            style.gridColor,
          );
        }
        continue;
      }
      const fill = colorOf(value);
      if (fill === undefined) continue;
      // The transpose, and the only place orientation reaches the geometry:
      // which of the two spans is horizontal on the canvas.
      const x0 = vertical ? spanLo : bandLo[g]!;
      const x1 = vertical ? spanHi : bandHi[g]!;
      const yTop = vertical ? bandLo[g]! : spanLo;
      const yBottom = vertical ? bandHi[g]! : spanHi;

      // **Every** named cell lights, not only the first of each set. Selection
      // is tested first and wins outright, so a cell in both draws the selected
      // weight once rather than stacking two strokes. `binIsLive` short-circuits
      // the whole test for the columns nothing names, which is nearly all of
      // them.
      let selected = false;
      let live = false;
      if (binIsLive) {
        const group = ss.groups[g]!;
        selected = selLabels !== null && hasLabel(selLabels, group);
        // The spans that cover this bin, against the cell's remaining channels
        // — the row name (`rows`) and the value (`y`). `spanContainsPoint` is
        // the single containment rule (its x re-test is two compares on an
        // already-passing bin), so this cannot drift from `selectionContains`.
        if (!selected && binSpans !== null && binSpans.length > 0) {
          const begin = ss.begin[b]!;
          for (let s = 0; s < binSpans.length; s += 1) {
            if (spanContainsPoint(binSpans[s]!, begin, value, group)) {
              selected = true;
              break;
            }
          }
        }
        live = selected || (hovLabels !== null && hasLabel(hovLabels, group));
      }

      // Under `states` there is no alpha pop: a live cell is marked by chrome,
      // so `opacity` stays what it is — the LAYER's base alpha — instead of
      // quietly becoming a state and being overridden to 1.
      ctx.globalAlpha = live && st === undefined ? 1 : style.opacity;
      // Assigning `fillStyle` is not free — a real canvas parses the CSS colour
      // on every set — and a banded ramp hands out long runs of the same string,
      // so set it only when it actually changes.
      if (fill !== lastFill) {
        lastFill = fill;
        ctx.fillStyle = fill;
      }
      ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      if (st === undefined) {
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
        continue;
      }
      // ── The states path ────────────────────────────────────────────────
      // Recede: a flat overlay composited over the cell, NOT an alpha — see
      // `HeatStates.veil`. Only a committed selection recedes the field; a
      // hovered cell keeps its value even while the rest is veiled.
      if (perimeter && !live) {
        lastFill = st.veil;
        ctx.fillStyle = st.veil;
        ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      }
      if (live && !selected) {
        // The double ring, both inside the cell so both sit on its colour.
        const w = st.ringWidth;
        ctx.lineWidth = w;
        for (let ring = 0; ring < 2; ring += 1) {
          const i = w / 2 + ring * w;
          ctx.strokeStyle = st.hoverRing[ring]!;
          ctx.strokeRect(
            x0 + i,
            yTop + i,
            x1 - x0 - 2 * i,
            yBottom - yTop - 2 * i,
          );
        }
      }
      if (selected) {
        // **One outline around the union**, drawn as the edges this cell does
        // not share with another selected cell. Summed over the region that
        // is exactly its perimeter — and it costs no connectivity pass, so
        // several disconnected pieces get one outline each and a hole in the
        // middle of a piece gets its own.
        //
        // Safe to draw in the cell loop rather than deferring: every edge is
        // inset INSIDE its own cell, so no neighbour's fill (or veil) drawn
        // later can paint over it.
        const w = st.perimeterWidth;
        const i = w / 2;
        ctx.lineWidth = w;
        ctx.strokeStyle = st.perimeter;
        ctx.beginPath();
        // Which cell sits on each side of this one **on screen**. The two
        // orientations disagree about all four: transposing swaps the axes,
        // and the y scale descends — so a higher ROW index is further up on a
        // vertical grid, while a later BIN is further up on a horizontal one.
        if (!(vertical ? isSel(b - 1, g) : isSel(b, g - 1))) {
          ctx.moveTo(x0 + i, yTop);
          ctx.lineTo(x0 + i, yBottom);
        }
        if (!(vertical ? isSel(b + 1, g) : isSel(b, g + 1))) {
          ctx.moveTo(x1 - i, yTop);
          ctx.lineTo(x1 - i, yBottom);
        }
        if (!(vertical ? isSel(b, g + 1) : isSel(b + 1, g))) {
          ctx.moveTo(x0, yTop + i);
          ctx.lineTo(x1, yTop + i);
        }
        if (!(vertical ? isSel(b, g - 1) : isSel(b - 1, g))) {
          ctx.moveTo(x0, yBottom - i);
          ctx.lineTo(x1, yBottom - i);
        }
        ctx.stroke();
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
