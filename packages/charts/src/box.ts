import type { BoxSeries } from './data.js';
import type { Scale } from './line.js';
import type { BoxStyle } from './theme.js';
import { barSpanPx } from './range.js';
import { visibleSpanRange } from './culling.js';

/** Fraction of the box width the whisker end-caps span (centred on the stem). */
const WHISKER_CAP_FRACTION = 0.5;

/**
 * The `[min, max]` vertical extent of the **drawn** boxes — the lowest `lower`
 * whisker and highest `upper` whisker over the keys {@link isFiniteBox} draws
 * (a full box needs all five quantiles; a range-only box just `lower`/`upper`) —
 * or `null` if none are. Gap keys are excluded, matching what {@link drawBox}
 * draws, so they don't drag the y-domain.
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
 * `lower→upper` range with a more-prominent inner `q1→q3` box, no stems), or
 * **`none`** (the `q1→q3` box only, no spread marks). The median line is drawn
 * separately and is always optional (`showMedian`).
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
 * - **`solid`** — a light outer bar over `lower→upper` (the spread) with a
 *   more-prominent inner `q1→q3` box (the same fill at rising opacity — so it
 *   reads darker on a light ground, brighter on a dark one), no stems/outline.
 * - **`none`** — the `q1→q3` box fill + outline only, no spread marks.
 *
 * **Range-only** (`box.hasBox === false` — no `q1`/`q3`): there's no body, so
 * `whisker` draws **one** full `lower→upper` stem with caps, `solid` draws just
 * the outer bar, and `none` draws **nothing** (no body + no spread ⇒ empty — pick
 * `whisker`/`solid` for a range-only box). `showMedian` is a no-op when the box
 * carries no `median` (`hasMedian === false`).
 *
 * Then, if `showMedian` (and a median is present), the median line on top. Fills
 * are bracketed by `save`/`restore` so their `globalAlpha` doesn't leak.
 * `offsetPx` shifts every mark in pixel space (for pairing same-key marks);
 * `capWidthPx` sets a fixed whisker-cap width (else half the box width — a small
 * fixed cap keeps paired offset marks' T-bars from overlapping), clamped to the
 * box width.
 *
 * **Gap-aware**: a key whose present quantiles aren't all finite is skipped
 * entirely (no partial box) — the same contract as a band gap.
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
  offsetPx = 0,
  capWidthPx?: number,
): void {
  // A range-only box (bid→ask segment) has no body / median; the whisker (or the
  // solid bar) runs the full lower→upper. Flags default true (a full box).
  const hasBox = box.hasBox !== false;
  const drawMedian = showMedian && box.hasMedian !== false;
  // Viewport culling (Phase 2): draw only the boxes whose span overlaps the
  // visible x-window (+1 each side); the loop keeps the original index `i`. Full
  // range when `xScale` has no domain (a test stub). `offsetPx` is a small pixel
  // nudge the ±1 margin absorbs.
  const [vStart, vEnd] = visibleSpanRange(box.x, box.xEnd, box.length, xScale);
  for (let i = vStart; i < vEnd; i += 1) {
    if (!isFiniteBox(box, i)) continue;
    const [span0, span1] = barSpanPx(
      box.x[i]!,
      box.xEnd[i]!,
      xScale,
      gapPx,
      minWidthPx,
    );
    // `offsetPx` nudges the whole mark in pixel space (zoom-stable) — for pairing
    // same-key marks (call/put at one strike) side by side without overlap.
    const x0 = span0 + offsetPx;
    const x1 = span1 + offsetPx;
    const mid = (x0 + x1) / 2;
    const yLower = yScale(box.lower[i]!);
    const yUpper = yScale(box.upper[i]!);
    // q1/q3 are NaN on a range-only box — read them only when there's a body.
    const yQ1 = hasBox ? yScale(box.q1[i]!) : 0;
    const yQ3 = hasBox ? yScale(box.q3[i]!) : 0;

    if (shape === 'solid') {
      // Candlestick: a light outer bar over the full lower→upper spread, then —
      // when there's a body — a more-prominent inner q1→q3 box on top (same fill
      // at rising opacity). No stems, no outline.
      ctx.save();
      ctx.fillStyle = style.fill;
      ctx.globalAlpha = style.fillOpacity;
      ctx.fillRect(x0, yUpper, x1 - x0, yLower - yUpper);
      if (hasBox) {
        ctx.globalAlpha = Math.min(1, style.fillOpacity * 2);
        ctx.fillRect(x0, yQ3, x1 - x0, yQ1 - yQ3);
      }
      ctx.restore();
    } else {
      // `whisker` / `none`: the graded q1→q3 box fill + outline (body only).
      if (hasBox) {
        ctx.save();
        ctx.fillStyle = style.fill;
        ctx.globalAlpha = style.fillOpacity;
        ctx.fillRect(x0, yQ3, x1 - x0, yQ1 - yQ3);
        ctx.restore();
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.strokeWidth;
        ctx.strokeRect(x0, yQ3, x1 - x0, yQ1 - yQ3);
      }

      if (shape === 'whisker') {
        // Whiskers with end-caps. With a body: two stems (q3→upper, q1→lower).
        // Range-only (no body): one stem spanning the full lower→upper.
        // Cap half-width: an explicit `capWidthPx` (a fixed pixel cap — for
        // pairing offset marks without their T-bars overlapping) else a fraction
        // of the box width (responsive default). Never wider than the box.
        const capHalf =
          capWidthPx !== undefined
            ? Math.min(capWidthPx, x1 - x0) / 2
            : ((x1 - x0) * WHISKER_CAP_FRACTION) / 2;
        ctx.strokeStyle = style.whisker;
        ctx.lineWidth = style.whiskerWidth;
        ctx.beginPath();
        // Upper stem: from the box top (q3) or, range-only, from lower.
        ctx.moveTo(mid, hasBox ? yQ3 : yLower);
        ctx.lineTo(mid, yUpper);
        ctx.moveTo(mid - capHalf, yUpper);
        ctx.lineTo(mid + capHalf, yUpper);
        // Lower cap (and, with a body, the lower stem q1→lower).
        if (hasBox) {
          ctx.moveTo(mid, yQ1);
          ctx.lineTo(mid, yLower);
        }
        ctx.moveTo(mid - capHalf, yLower);
        ctx.lineTo(mid + capHalf, yLower);
        ctx.stroke();
      }
    }

    // The median line across the box, on top — drawn only when the box carries a
    // median column and `showMedian` is on.
    if (drawMedian) {
      const yMedian = yScale(box.median[i]!);
      ctx.strokeStyle = style.median;
      ctx.lineWidth = style.medianWidth;
      ctx.beginPath();
      ctx.moveTo(x0, yMedian);
      ctx.lineTo(x1, yMedian);
      ctx.stroke();
    }
  }
}

/**
 * This key is drawable — the quantiles it actually carries are all finite at `i`.
 * `lower`/`upper` (the whisker reach) are always required; `q1`/`q3` only when the
 * box has a body (`hasBox !== false`), `median` only when it has a centre line
 * (`hasMedian !== false`). So a **range-only** box (bid→ask, no body/median) draws
 * wherever `lower`/`upper` are finite, and a full box still needs all five.
 */
export function isFiniteBox(box: BoxSeries, i: number): boolean {
  if (!Number.isFinite(box.lower[i]!) || !Number.isFinite(box.upper[i]!)) {
    return false;
  }
  if (
    box.hasBox !== false &&
    (!Number.isFinite(box.q1[i]!) || !Number.isFinite(box.q3[i]!))
  ) {
    return false;
  }
  if (box.hasMedian !== false && !Number.isFinite(box.median[i]!)) {
    return false;
  }
  return true;
}
