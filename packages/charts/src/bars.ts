import { barSpanPx } from './range.js';
import type { BarSeries } from './data.js';
import type { Scale } from './line.js';
import type { BarStyle } from './theme.js';

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
 * matching the current `selection` (same `begin` **and** the layer's own `label`)
 * draws in the style's `highlight` colour **and outlined**, so a click reads back
 * on the canvas; a bar matching `hovered` draws in `highlight` **without** the
 * outline (a lighter "this bar is live" on pointer-over); all others use the flat
 * `fill`. `globalAlpha` carries the fill opacity and is restored so it doesn't
 * leak into later layers.
 *
 * O(N) over the events, one fill (+ optional stroke) per bar, no per-bar
 * allocation beyond the rect tuple.
 */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  cs: BarSeries,
  xScale: Scale,
  yScale: Scale,
  style: BarStyle,
  baseline: number,
  gapPx: number,
  label: string,
  selection: { key: number; label: string } | null,
  hovered: { key: number; label: string } | null,
): void {
  ctx.save();
  ctx.globalAlpha = style.opacity;
  for (let i = 0; i < cs.length; i += 1) {
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
    // Match by key (begin) **and** label, so two series sharing a timestamp don't
    // both light up. Both the committed selection and the transient hover use the
    // `highlight` fill; only the selection adds the outline, so hover reads as a
    // lighter "this bar is live" and select as the committed pick.
    const selected =
      selection !== null &&
      selection.key === cs.begin[i] &&
      selection.label === label;
    const isHovered =
      hovered !== null &&
      hovered.key === cs.begin[i] &&
      hovered.label === label;
    ctx.fillStyle = selected || isHovered ? style.highlight : style.fill;
    ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
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
