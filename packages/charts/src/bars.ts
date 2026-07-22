import { barSpanPx } from './range.js';
import type { BarSeries, StackedBarSeries } from './data.js';
import type { Scale } from './line.js';
import type { BarStyle } from './theme.js';
import type { LayerDrawStats } from './context.js';
import { visibleSpanRange } from './culling.js';
import { decimateBars, type DecimateOption } from './decimate.js';

/**
 * Bar growth direction — the histogram orientation. `'vertical'` bars grow **up**
 * from a value baseline, bins on the x axis (the column / time-bucket look);
 * `'horizontal'` bars grow **right**, bins on the y axis (the band look, e.g.
 * heart-rate zones). The stacked geometry below transposes on this alone — the
 * {@link StackedBarSeries} data is identical for both.
 */
export type Orientation = 'vertical' | 'horizontal';

/**
 * The `[min, max]` vertical extent the bars occupy — the finite values of `cs.y`
 * **widened to include `0`**, since a bar spans from its value to the baseline
 * and the baseline must be in-domain or the bar clips. `null` if no value is
 * finite.
 *
 * Including `0` is the bar analog of {@link areaExtent} pulling a fixed baseline
 * into the domain: an all-positive series auto-fits to `[0, max]` so the bars
 * rest on a visible floor (the zero line), and a series that straddles zero
 * shows the zero line both above and below it. An explicit `<YAxis min>` still
 * wins — `resolveBarBaseline` rests the bars on that floor instead. NaN values
 * (the gap signal) are ignored, so a sparse bucket doesn't drag the domain.
 */
export function barExtent(cs: BarSeries): [number, number] | null {
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
  // The bar reaches the baseline (0), so it must be inside the domain.
  if (0 < min) min = 0;
  if (0 > max) max = 0;
  return [min, max];
}

/**
 * The value a bar rests on, in **data** units — the baseline edge opposite its
 * value. Resolved late from the axis's own domain (so it tracks the auto-fit):
 *
 * - When the domain spans `0` (floor ≤ 0 ≤ top — the common all-positive
 *   auto-fit case, since {@link barExtent} pulls `0` in): the bars rest on the
 *   **zero line**.
 * - When the domain sits entirely above `0` (an explicit `<YAxis min={…}>` above
 *   zero): the bars rest on the **axis floor**, so a thin bar still reads from
 *   the bottom of the plot rather than hanging off a zero line below it.
 * - When the domain sits entirely below `0`: the bars hang from the **axis top**
 *   (`0` clamped down into the domain) — the symmetric case.
 *
 * I.e. `0` clamped into `[floor, top]`. The domain bounds come from the plain
 * `(value) => pixel` scale the row hands `draw`/`hitTest`; the runtime object is
 * a d3 `ScaleLinear` carrying `.domain()`, read through a localized shape rather
 * than widening the contract to d3-scale (same approach as `AreaChart`).
 */
export function resolveBarBaseline(yScale: Scale): number {
  const d = (yScale as unknown as { domain?: () => number[] }).domain?.();
  if (!d || d.length === 0) return 0;
  const floor = Math.min(d[0]!, d[d.length - 1]!);
  const top = Math.max(d[0]!, d[d.length - 1]!);
  return Math.min(Math.max(0, floor), top);
}

/**
 * The pixel rect of bar `i` — `[x0, x1, yTop, yBottom]`, with `x0 <= x1` and
 * `yTop <= yBottom` — or `null` for a gap (non-finite value). The x-span comes
 * from {@link barSpanPx} (the key's `[begin, end]`, inset by `gapPx`, floored at
 * `minWidthPx`); the y-span runs between the value and the `baseline` pixel,
 * normalized so a value above *or* below the baseline both yield an ascending
 * rect. Shared by {@link drawBars} and {@link barAt} so the drawn rect and the
 * hit rect are the same geometry.
 */
export function barRect(
  cs: BarSeries,
  i: number,
  xScale: Scale,
  yScale: Scale,
  baseline: number,
  gapPx: number,
  minWidthPx: number,
): [x0: number, x1: number, yTop: number, yBottom: number] | null {
  const v = cs.y[i]!;
  if (!Number.isFinite(v)) return null;
  const [x0, x1] = barSpanPx(
    cs.begin[i]!,
    cs.end[i]!,
    xScale,
    gapPx,
    minWidthPx,
  );
  const yValue = yScale(v);
  const yBase = yScale(baseline);
  return [x0, x1, Math.min(yValue, yBase), Math.max(yValue, yBase)];
}

/**
 * Fill one rectangle per bar in `cs`, each spanning its key's `[begin, end]`
 * (inset by `gapPx`) from the resolved `baseline` to the value.
 *
 * A gap (non-finite value) is skipped — no bar, no zero-height sliver. A bar
 * matching the current `selection` (same sample `key` **and** the layer's own
 * series `id` — `seriesId`; a no-id layer passes `undefined` and never matches)
 * draws in the style's `highlight` colour **and outlined**, so a click reads back
 * on the canvas; a bar matching `hovered` draws in `highlight` **without** the
 * outline (a lighter "this bar is live" on pointer-over); all others use the flat
 * `fill`. `globalAlpha` carries the fill opacity and is restored so it doesn't
 * leak into later layers.
 *
 * O(N) over the events, one fill (+ optional stroke) per bar, no per-bar
 * allocation beyond the rect tuple.
 *
 * **M4 column decimation ([PND-MARKDEC]):** once the *visible* bars are denser
 * than ~2 per device pixel, they overplot into a solid silhouette, so
 * `decimate !== false` replaces them with one **envelope rect per pixel column**
 * ({@link decimateBars} — `[min(value, baseline), max(value, baseline)]`), from
 * O(W) rects instead of O(visible). Gated on the *visible* count (a bar's width
 * is its slot). The decimated pass draws the flat `fill` only — the aggregate
 * columns aren't individually selectable, so per-bar selection/hover highlight is
 * suppressed (a <1px bar's ring wouldn't be visible anyway); interaction still
 * reads the **source** bars via {@link barAt} (§2.3). Pass `decimate={false}` to
 * always draw every bar. Returns {@link LayerDrawStats} for `onDrawStats`.
 */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  cs: BarSeries,
  xScale: Scale,
  yScale: Scale,
  style: BarStyle,
  baseline: number,
  gapPx: number,
  seriesId: string | undefined,
  selection: { key: number; id: string } | null,
  hovered: { key: number; id: string } | null,
  decimate: DecimateOption = true,
): LayerDrawStats {
  ctx.save();
  ctx.globalAlpha = style.opacity;
  const sourceCount = cs.length; // pre-cull, pre-decimation (for draw stats)
  // Viewport culling (Phase 2): draw only the bars whose span overlaps the
  // visible x-window (+1 each side). The loop keeps the original index `i`, so
  // the `begin[i]` selection/hover match stays correct; full range when `xScale`
  // has no domain (a test stub). A selected/hovered bar off-screen isn't drawn
  // (its highlight would be off-screen anyway).
  const [vStart, vEnd] = visibleSpanRange(cs.begin, cs.end, cs.length, xScale);
  // Decimate the visible bars to per-column envelope rects once dense (see the
  // header). `null` below the visible-density threshold ⇒ the full per-bar loop.
  const envelope =
    decimate !== false
      ? decimateBars(cs, xScale, ctx, baseline, 2, vEnd - vStart)
      : null;
  if (envelope !== null) {
    ctx.fillStyle = style.fill;
    let drawn = 0;
    for (let b = 0; b < envelope.length; b += 1) {
      const lo = envelope.lo[b]!;
      if (!Number.isFinite(lo)) continue; // empty column
      const [x0, x1] = barSpanPx(
        envelope.begin[b]!,
        envelope.end[b]!,
        xScale,
        0, // tile the column — a per-bar gapPx is invisible at <1px bars
        style.minWidth,
      );
      const yTop = yScale(envelope.hi[b]!);
      const yBottom = yScale(lo);
      ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      drawn += 1;
    }
    ctx.restore();
    return { sourceCount, drawnCount: drawn, decimated: true };
  }
  let drawn = 0;
  for (let i = vStart; i < vEnd; i += 1) {
    const rect = barRect(
      cs,
      i,
      xScale,
      yScale,
      baseline,
      gapPx,
      style.minWidth,
    );
    if (rect === null) continue;
    const [x0, x1, yTop, yBottom] = rect;
    // Match by the series `id` **and** the sample `key` (begin), so two series
    // sharing a timestamp don't both light up (a no-id, non-selectable layer
    // passes `seriesId === undefined` and never matches). Both the committed
    // selection and the transient hover use the `highlight` fill; only the
    // selection adds the outline, so hover reads as a lighter "this bar is live"
    // and select as the committed pick.
    const selected =
      selection !== null &&
      selection.id === seriesId &&
      selection.key === cs.begin[i];
    const isHovered =
      hovered !== null &&
      hovered.id === seriesId &&
      hovered.key === cs.begin[i];
    ctx.fillStyle = selected || isHovered ? style.highlight : style.fill;
    ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
    drawn += 1;
    if (selected) {
      // The selected bar gets an outline so it reads at full strength over the
      // (alpha'd) fills. Stroke at full opacity (reset within the save bracket).
      ctx.globalAlpha = 1;
      ctx.lineWidth = style.outlineWidth;
      ctx.strokeStyle = style.highlight;
      ctx.strokeRect(x0, yTop, x1 - x0, yBottom - yTop);
      ctx.globalAlpha = style.opacity;
    }
  }
  ctx.restore();
  return { sourceCount, drawnCount: drawn, decimated: false };
}

/**
 * The index of the bar whose key span `[begin, end]` contains `time` — the bar
 * **under the cursor** — or `-1` if `time` falls in no bar's span. This is the
 * cursor analog of {@link barAt}'s rect-containment: unlike nearest-by-`begin`,
 * it doesn't flip to the next bar once the cursor passes a wide bar's midpoint
 * (the readout-on-the-wrong-bar bug). At a shared edge (`end[i] === begin[i+1]`,
 * contiguous bars) the left bar wins (first match). A gap bar (non-finite value)
 * still owns its span here; the caller drops it on the finiteness check, so
 * hovering a gap reads no value — as the line/area tracker breaks at a gap.
 *
 * O(N) over the bars (view-scale counts; the cursor moves often but the scan is
 * cheap and allocation-free).
 */
export function barIndexAtTime(cs: BarSeries, time: number): number {
  for (let i = 0; i < cs.length; i += 1) {
    if (time >= cs.begin[i]! && time <= cs.end[i]!) return i;
  }
  return -1;
}

/**
 * Hit-test plot-pixel `(px, py)` against `cs`'s bars — the **first** bar whose
 * rect contains the point, or `null`. The geometry is {@link barRect}, so the
 * hit rect is exactly the drawn rect (same `baseline`/`gapPx`/`minWidth`). The
 * returned tuple is `[index, begin, value]` for the chart to assemble a
 * `SelectInfo` (it owns the colour + label); keeping this layer free of the
 * theme keeps it unit-testable without a `ChartTheme`.
 *
 * O(N) over the events (no spatial index — bar counts are view-scale, hundreds
 * not millions; click is a rare event). Bars don't overlap in x for a sorted
 * series, so "first match" is unambiguous in practice.
 */
export function barAt(
  cs: BarSeries,
  px: number,
  py: number,
  xScale: Scale,
  yScale: Scale,
  baseline: number,
  gapPx: number,
  minWidthPx: number,
): [index: number, begin: number, value: number] | null {
  for (let i = 0; i < cs.length; i += 1) {
    const rect = barRect(cs, i, xScale, yScale, baseline, gapPx, minWidthPx);
    if (rect === null) continue;
    const [x0, x1, yTop, yBottom] = rect;
    if (px >= x0 && px <= x1 && py >= yTop && py <= yBottom) {
      return [i, cs.begin[i]!, cs.y[i]!];
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stacked / oriented geometry (histograms). A single-series bar is the G === 1
// case; the same code draws both orientations, transposing which scale carries
// the bin span vs the stacked value. Stacks rest on value 0 (always in-domain —
// stackValueExtent pulls 0 in), so no late baseline resolution is needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A resolved per-group stack style: `fills` aligned index-for-index to
 * {@link StackedBarSeries.groups} (segment `g` uses `fills[g]`), plus the shared
 * `opacity` (applied to every resting segment) and `outlineWidth` (the selected
 * segment's stroke). Assembled by `BarChart` from the theme's `bar` style + the
 * `colors` override, so the draw layer stays theme-free (unit-testable).
 *
 * There is no separate highlight colour: a hovered / selected segment pops by
 * drawing its **own** `fill` at full opacity (and, when selected, an outline in
 * that same colour). Colour-agnostic, so it reads correctly whatever palette the
 * `colors` override supplies.
 */
export interface StackStyle {
  readonly fills: readonly string[];
  readonly opacity: number;
  readonly outlineWidth: number;
  /**
   * Optional **per-bin** fill override, aligned index-for-index to the bins
   * (bin `b` uses `binFills[b]`), taking precedence over the per-group
   * {@link fills} for that whole bin. This is the single-series band case —
   * colour each bar by its category (heart-rate / power zones, value bands) —
   * so it's normally paired with a `G === 1` stack. A `null`/`undefined` entry
   * falls back to the group fill.
   */
  readonly binFills?: readonly (string | undefined)[];
}

/** The narrowed selection / hover identity a stacked segment matches against:
 *  the series `id`, the bin's `begin` (its `key`), and the group (its `label`).
 *  When the series carries `marks` (the categorical axis), the match keys on the
 *  stable `mark` (the column name) instead of the `key` slot index. */
export interface StackMark {
  readonly id: string;
  readonly key: number;
  readonly label: string;
  readonly mark?: string;
}

/**
 * The `[min, max]` extent of the **value (stacked) axis**. For a true multi-group
 * stack it is `[0, maxTotal]`, where `maxTotal` is the tallest bin's summed finite
 * non-negative segments. For a **single-group** series (`G === 1` — the plain /
 * categorical bar case) it spans the values' own `[min, max]`, so a **negative**
 * bar's floor is in the domain (segments below the baseline stay visible). `0` is
 * always pulled in so the bars rest on a visible baseline (the bar analog of
 * {@link barExtent}). An empty / all-gap series returns `[0, 1]` so the axis still
 * has a usable domain. Feeds the y auto-fit for a vertical histogram, the x
 * auto-fit for a horizontal one.
 */
export function stackValueExtent(ss: StackedBarSeries): [number, number] {
  const G = ss.groups.length;
  let max = 0;
  let min = 0;
  for (let b = 0; b < ss.length; b += 1) {
    let cum = 0;
    for (let g = 0; g < G; g += 1) {
      const v = ss.values[b * G + g]!;
      if (!Number.isFinite(v)) continue;
      if (G === 1) {
        // Single-group: a bar honours its sign, so track both ends.
        if (v > max) max = v;
        if (v < min) min = v;
      } else if (v > 0) {
        cum += v; // True stack: sum the positive segments.
      }
    }
    if (cum > max) max = cum;
  }
  // Empty / all-gap / all-zero → a usable unit domain; otherwise the real extent
  // (with 0 pulled in via the `min`/`max` seeds above).
  if (min === 0 && max === 0) return [0, 1];
  return [min, max];
}

/**
 * The `[min, max]` extent of the **bin axis** — the first bin's `begin` to the
 * last bin's `end` (the slots are ascending). `null` for an empty series. Feeds
 * the x auto-fit for a vertical histogram, the y auto-fit for a horizontal one.
 */
export function stackBinExtent(ss: StackedBarSeries): [number, number] | null {
  if (ss.length === 0) return null;
  return [ss.begin[0]!, ss.end[ss.length - 1]!];
}

/**
 * The pixel rect `[x0, x1, yTop, yBottom]` (ascending on both axes) of bin `b`'s
 * segment `g`, stacked so it sits atop `cumBefore` (the summed value of the
 * segments below it, in value units). `null` for a gap (see below). Transposes on
 * `orientation`:
 *
 * - **vertical** — the bin span is horizontal (`barSpanPx` on `xScale`); the
 *   segment runs vertically from `yScale(cumBefore)` to `yScale(cumBefore + v)`.
 * - **horizontal** — the bin span is vertical (`barSpanPx` on `yScale`); the
 *   segment runs horizontally from `xScale(cumBefore)` to `xScale(cumBefore + v)`.
 *
 * `null` for a **gap** — a non-finite, negative, **or zero** value: none of them
 * draw (a zero segment has no extent), and each contributes nothing to the running
 * total. `minSpanPx` floors the **bin** span (bar thickness); the value direction
 * is unfloored. Shared by {@link drawStacks} and {@link stackAt} so the drawn rect
 * and the hit rect are identical.
 */
export function segmentRect(
  ss: StackedBarSeries,
  b: number,
  g: number,
  orientation: Orientation,
  xScale: Scale,
  yScale: Scale,
  cumBefore: number,
  gapPx: number,
  minSpanPx: number,
): [x0: number, x1: number, yTop: number, yBottom: number] | null {
  const G = ss.groups.length;
  const v = ss.values[b * G + g]!;
  // Skip non-finite (a gap) or zero (a zero-extent rect that can't draw or be
  // hit-tested). A **negative** value is a gap only in a true multi-group stack
  // (`G > 1`) — stacking a negative segment is undefined. A **single-group**
  // series (`G === 1`) is a plain bar: it honours its sign and draws from the
  // baseline *down* to a negative value (the categorical row-read's P&L / delta
  // case), so negatives are kept and the `Math.min/Math.max` below normalizes the
  // below-baseline rect.
  if (!Number.isFinite(v) || v === 0 || (v < 0 && G > 1)) return null;
  if (orientation === 'vertical') {
    const [x0, x1] = barSpanPx(
      ss.begin[b]!,
      ss.end[b]!,
      xScale,
      gapPx,
      minSpanPx,
    );
    const yA = yScale(cumBefore);
    const yB = yScale(cumBefore + v);
    return [x0, x1, Math.min(yA, yB), Math.max(yA, yB)];
  }
  const [y0, y1] = barSpanPx(
    ss.begin[b]!,
    ss.end[b]!,
    yScale,
    gapPx,
    minSpanPx,
  );
  const xA = xScale(cumBefore);
  const xB = xScale(cumBefore + v);
  return [Math.min(xA, xB), Math.max(xA, xB), y0, y1];
}

/**
 * Fill every segment of every bin in `ss`, stacking each bin's groups from the
 * value baseline outward (bottom → top vertical, left → right horizontal). A gap
 * (non-finite, or a negative segment of a true multi-group stack) is skipped and
 * adds nothing to the running total, so the segments above it close the space; a
 * single-group series draws its negative bars below the baseline (see
 * {@link segmentRect}). A segment matching the current
 * `selection` (same series `id`, bin `key` **and** group `label`) draws in its
 * group's `highlight` **and** outlined; one matching `hover` draws in `highlight`
 * without the outline; all others use the flat `fill`. `globalAlpha` carries the
 * shared opacity and is restored.
 *
 * O(N·G) over bins × groups, one fill (+ optional stroke) per drawn segment.
 */
export function drawStacks(
  ctx: CanvasRenderingContext2D,
  ss: StackedBarSeries,
  orientation: Orientation,
  xScale: Scale,
  yScale: Scale,
  style: StackStyle,
  gapPx: number,
  minSpanPx: number,
  seriesId: string | undefined,
  selection: StackMark | null,
  hover: StackMark | null,
): void {
  const G = ss.groups.length;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  for (let b = 0; b < ss.length; b += 1) {
    let cum = 0;
    for (let g = 0; g < G; g += 1) {
      const rect = segmentRect(
        ss,
        b,
        g,
        orientation,
        xScale,
        yScale,
        cum,
        gapPx,
        minSpanPx,
      );
      const v = ss.values[b * G + g]!;
      if (Number.isFinite(v) && v > 0) cum += v;
      if (rect === null) continue;
      const [x0, x1, yTop, yBottom] = rect;
      // With `marks` (the categorical axis), match on the stable per-bin name so a
      // pinned selection survives a column reorder; otherwise on the sample `key`
      // (begin) + group `label`, as a time / value stack does.
      const stableMark = ss.marks?.[b];
      const matches = (m: StackMark | null): boolean =>
        m !== null &&
        m.id === seriesId &&
        (stableMark !== undefined
          ? m.mark === stableMark
          : m.key === ss.begin[b] && m.label === ss.groups[g]);
      const selected = matches(selection);
      const isHovered = matches(hover);
      // A hovered / selected segment pops to full opacity in its own colour; a
      // resting one draws at the shared alpha.
      ctx.globalAlpha = selected || isHovered ? 1 : style.opacity;
      // A per-bin colour (the single-series band case) overrides the group fill.
      const fill = style.binFills?.[b] ?? style.fills[g]!;
      ctx.fillStyle = fill;
      ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      if (selected) {
        ctx.lineWidth = style.outlineWidth;
        ctx.strokeStyle = fill;
        ctx.strokeRect(x0, yTop, x1 - x0, yBottom - yTop);
      }
    }
  }
  ctx.restore();
}

/**
 * Hit-test plot-pixel `(px, py)` against `ss`'s stacked segments — the **first**
 * segment whose rect contains the point, or `null`. The geometry is
 * {@link segmentRect}, so the hit rect is exactly the drawn rect. The returned
 * tuple is `[bin, group, begin, groupName, value]` for the chart to assemble a
 * `SelectInfo` (it owns the colour). Orientation-agnostic — it reads `(px, py)`,
 * so a horizontal histogram hit-tests the same way a vertical one does.
 *
 * O(N·G) over bins × groups (no spatial index — histogram bin/group counts are
 * small; click / hover are cheap events).
 */
export function stackAt(
  ss: StackedBarSeries,
  px: number,
  py: number,
  orientation: Orientation,
  xScale: Scale,
  yScale: Scale,
  gapPx: number,
  minSpanPx: number,
):
  | [bin: number, group: number, begin: number, name: string, value: number]
  | null {
  const G = ss.groups.length;
  for (let b = 0; b < ss.length; b += 1) {
    let cum = 0;
    for (let g = 0; g < G; g += 1) {
      const rect = segmentRect(
        ss,
        b,
        g,
        orientation,
        xScale,
        yScale,
        cum,
        gapPx,
        minSpanPx,
      );
      const v = ss.values[b * G + g]!;
      if (Number.isFinite(v) && v > 0) cum += v;
      if (rect === null) continue;
      const [x0, x1, yTop, yBottom] = rect;
      if (px >= x0 && px <= x1 && py >= yTop && py <= yBottom) {
        return [b, g, ss.begin[b]!, ss.groups[g]!, v];
      }
    }
  }
  return null;
}
