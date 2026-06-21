import type { BoxSeries } from './data.js';
import type { Scale } from './line.js';
import type { BoxStyle } from './theme.js';
import { barSpanPx } from './range.js';

/** Fraction of the box width the whisker end-caps span (centred on the stem). */
const WHISKER_CAP_FRACTION = 0.5;

/**
 * The `[min, max]` vertical extent of the **drawn** boxes — the lowest `lower`
 * whisker and highest `upper` whisker over keys where **all five** quantiles are
 * finite — or `null` if none are. Gap keys (any quantile `NaN`) are excluded,
 * matching what {@link drawBox} draws, so they don't drag the y-domain.
 *
 * Only `lower`/`upper` bound the extent: they are the outermost reach of a key
 * (the whisker ends), so `q1`/`median`/`q3` lie within `[lower, upper]` for any
 * well-formed quantile set and never widen it. (A malformed set where, say,
 * `q3 > upper` would clip — that's an upstream data error, not the chart's to
 * paper over; document, don't defend.)
 */
export function boxExtent(box: BoxSeries): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < box.length; i += 1) {
    if (!isFiniteBox(box, i)) continue;
    const lo = box.lower[i]!;
    const hi = box.upper[i]!;
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  return min === Infinity ? null : [min, max];
}

/**
 * Draw a discrete box-and-whisker per key of `box`, mapping data→pixels through
 * `xScale`/`yScale`. The bar-chart analog of {@link drawBand}: each key gets its
 * own box (q1→q3 rect), a median line, and whiskers out to lower/upper — drawn
 * over its interval x-span (`barSpanPx`, inset by `gapPx` so adjacent boxes
 * breathe).
 *
 * Per key, in z-order back-to-front: the graded box fill, the box outline, the
 * two whisker stems with end-caps, then the median line on top. The box fill's
 * `globalAlpha` (carrying `fillOpacity`) is bracketed by `save`/`restore` so it
 * doesn't leak into the strokes or later layers.
 *
 * **Gap-aware**: a key with any quantile non-finite is skipped entirely (no
 * partial box) — the same contract as a band gap.
 *
 * O(N) over the keys, a fixed number of path ops each — no per-key allocation
 * beyond the `barSpanPx` tuple.
 */
export function drawBox(
  ctx: CanvasRenderingContext2D,
  box: BoxSeries,
  xScale: Scale,
  yScale: Scale,
  style: BoxStyle,
  gapPx = 0,
  minWidthPx = 1,
): void {
  for (let i = 0; i < box.length; i += 1) {
    if (!isFiniteBox(box, i)) continue;
    const [x0, x1] = barSpanPx(
      box.x[i]!,
      box.xEnd[i]!,
      xScale,
      gapPx,
      minWidthPx,
    );
    const mid = (x0 + x1) / 2;
    const yLower = yScale(box.lower[i]!);
    const yQ1 = yScale(box.q1[i]!);
    const yMedian = yScale(box.median[i]!);
    const yQ3 = yScale(box.q3[i]!);
    const yUpper = yScale(box.upper[i]!);

    // The box fill (q1→q3), graded by fillOpacity — bracketed so the alpha
    // doesn't bleed into the strokes below.
    ctx.save();
    ctx.fillStyle = style.fill;
    ctx.globalAlpha = style.fillOpacity;
    ctx.fillRect(x0, yQ3, x1 - x0, yQ1 - yQ3);
    ctx.restore();

    // The box outline (q1→q3), at full alpha.
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth;
    ctx.strokeRect(x0, yQ3, x1 - x0, yQ1 - yQ3);

    // Whiskers: a stem from each box edge to the whisker end, with a cap.
    const capHalf = ((x1 - x0) * WHISKER_CAP_FRACTION) / 2;
    ctx.strokeStyle = style.whisker;
    ctx.lineWidth = style.whiskerWidth;
    ctx.beginPath();
    // Upper: stem q3 → upper, cap at upper.
    ctx.moveTo(mid, yQ3);
    ctx.lineTo(mid, yUpper);
    ctx.moveTo(mid - capHalf, yUpper);
    ctx.lineTo(mid + capHalf, yUpper);
    // Lower: stem q1 → lower, cap at lower.
    ctx.moveTo(mid, yQ1);
    ctx.lineTo(mid, yLower);
    ctx.moveTo(mid - capHalf, yLower);
    ctx.lineTo(mid + capHalf, yLower);
    ctx.stroke();

    // The median line across the box, on top.
    ctx.strokeStyle = style.median;
    ctx.lineWidth = style.medianWidth;
    ctx.beginPath();
    ctx.moveTo(x0, yMedian);
    ctx.lineTo(x1, yMedian);
    ctx.stroke();
  }
}

/** All five quantiles finite at `i` — i.e. this key is drawn. */
function isFiniteBox(box: BoxSeries, i: number): boolean {
  return (
    Number.isFinite(box.lower[i]!) &&
    Number.isFinite(box.q1[i]!) &&
    Number.isFinite(box.median[i]!) &&
    Number.isFinite(box.q3[i]!) &&
    Number.isFinite(box.upper[i]!)
  );
}
