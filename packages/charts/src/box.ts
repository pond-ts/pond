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
 * The index of the box whose interval `[x, xEnd]` contains `time` — the box
 * **under the cursor** — or `-1` if `time` is in no box. The box analog of
 * `barIndexAtTime`: containment, not nearest-by-`begin` (which flips to the next
 * box past a wide box's midpoint). Boxes are sorted by `x`; at a shared edge the
 * left box wins. A gap box (some quantile non-finite) still owns its span here;
 * the caller drops it on the finiteness check. O(N) over the boxes (view-scale).
 */
export function boxIndexAtTime(box: BoxSeries, time: number): number {
  for (let i = 0; i < box.length; i += 1) {
    if (time >= box.x[i]! && time <= box.xEnd[i]!) return i;
  }
  return -1;
}

/**
 * How a box renders its spread (pjm17971): **`whisker`** (today's thin stems +
 * end-caps), **`solid`** (the candlestick look — a light outer bar over the full
 * `lower→upper` range with a darker inner `q1→q3` box, no stems), or **`none`**
 * (the `q1→q3` box only, no spread marks). The median line is drawn separately
 * and is always optional (`showMedian`).
 */
export type BoxShape = 'whisker' | 'solid' | 'none';

/**
 * Draw a discrete box per key of `box`, mapping data→pixels through
 * `xScale`/`yScale`. The bar-chart analog of {@link drawBand}: each key gets its
 * own mark over its interval x-span (`barSpanPx`, inset by `gapPx` so adjacent
 * boxes breathe), in the chosen {@link BoxShape}:
 *
 * - **`whisker`** (default) — the graded `q1→q3` box fill + outline, two whisker
 *   stems with end-caps out to `lower`/`upper`.
 * - **`solid`** — a light outer bar over `lower→upper` (the spread) with a darker
 *   inner `q1→q3` box (the two fills are the same hue at rising opacity), no
 *   stems/outline.
 * - **`none`** — the `q1→q3` box fill + outline only, no spread marks.
 *
 * Then, if `showMedian`, the median line across the box on top. Fills are
 * bracketed by `save`/`restore` so their `globalAlpha` doesn't leak.
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
  shape: BoxShape = 'whisker',
  showMedian = true,
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

    if (shape === 'solid') {
      // Candlestick: a light outer bar over the full lower→upper spread, then a
      // darker inner q1→q3 box on top (same hue, rising opacity — the inner reads
      // darker where the two overlap). No stems, no outline.
      ctx.save();
      ctx.fillStyle = style.fill;
      ctx.globalAlpha = style.fillOpacity;
      ctx.fillRect(x0, yUpper, x1 - x0, yLower - yUpper);
      ctx.globalAlpha = Math.min(1, style.fillOpacity * 2);
      ctx.fillRect(x0, yQ3, x1 - x0, yQ1 - yQ3);
      ctx.restore();
    } else {
      // `whisker` / `none`: the graded q1→q3 box fill + outline.
      ctx.save();
      ctx.fillStyle = style.fill;
      ctx.globalAlpha = style.fillOpacity;
      ctx.fillRect(x0, yQ3, x1 - x0, yQ1 - yQ3);
      ctx.restore();
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeRect(x0, yQ3, x1 - x0, yQ1 - yQ3);

      if (shape === 'whisker') {
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
      }
    }

    // The median line across the box, on top — always optional.
    if (showMedian) {
      ctx.strokeStyle = style.median;
      ctx.lineWidth = style.medianWidth;
      ctx.beginPath();
      ctx.moveTo(x0, yMedian);
      ctx.lineTo(x1, yMedian);
      ctx.stroke();
    }
  }
}

/** All five quantiles finite at `i` — i.e. this key is drawn. */
export function isFiniteBox(box: BoxSeries, i: number): boolean {
  return (
    Number.isFinite(box.lower[i]!) &&
    Number.isFinite(box.q1[i]!) &&
    Number.isFinite(box.median[i]!) &&
    Number.isFinite(box.q3[i]!) &&
    Number.isFinite(box.upper[i]!)
  );
}
