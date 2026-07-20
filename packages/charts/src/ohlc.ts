import type { OhlcSeries } from './data.js';
import type { Scale } from './line.js';
import type { CandleStyle } from './theme.js';
import { barSpanPx } from './range.js';
import { visibleSpanRange } from './culling.js';

/**
 * How an OHLC mark renders (pjm17971's fork 2 — bundled as one component, like
 * {@link BoxShape}, not split into a separate `<OHLCBar>`):
 *
 * - **`candle`** (default) — a filled `open→close` body with a `high–low` wick.
 * - **`bar`** — an OHLC tick bar: a `high–low` stem with a left tick at `open`
 *   and a right tick at `close`, no body.
 * - **`hollow`** — like `candle`, but a **rising** candle (close > open) draws a
 *   *hollow* (outlined) body and a **falling / doji** one a filled body.
 */
export type CandleVariant = 'candle' | 'bar' | 'hollow';

/**
 * What drives a candle's colour:
 *
 * - **`direction`** (default, market convention) — `rising` when close > open,
 *   `falling` when close < open, `neutral` when equal (a doji).
 * - **`series`** — one colour off the `as` role (the style's `rising` pair),
 *   *no* green/red. Keeps "colour = series" when a candle sits beside coloured
 *   lines and the up/down split would read as a second, conflicting encoding.
 */
export type ColorBy = 'direction' | 'series';

/** Default body width as a fraction of the candle slot when the style omits one. */
const DEFAULT_BODY_WIDTH = 0.8;

/** Minimum body height in px so a doji (open === close) still shows a mark. */
const MIN_BODY_HEIGHT_PX = 1;

/**
 * The `[min, max]` vertical extent of the **drawn** candles — the lowest `low`
 * and highest `high` over keys where **all four** prices are finite — or `null`
 * if none are. Gap keys (any price `NaN`) are excluded, matching what
 * {@link drawCandles} draws, so they don't drag the y-domain.
 *
 * Only `low`/`high` bound the extent: they are the outermost reach of a candle,
 * so `open`/`close` lie within `[low, high]` for any well-formed OHLC row and
 * never widen it. (A malformed row where, say, `close > high` would clip — an
 * upstream data error, not the chart's to paper over.)
 */
export function ohlcExtent(ohlc: OhlcSeries): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < ohlc.length; i += 1) {
    if (!isFiniteOhlc(ohlc, i)) continue;
    const lo = ohlc.low[i]!;
    const hi = ohlc.high[i]!;
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  return min === Infinity ? null : [min, max];
}

/**
 * The index of the candle whose slot `[x, xEnd]` contains `time` — the candle
 * **under the cursor** — or `-1` if `time` is in no slot. Containment (the box
 * analog {@link boxIndexAtTime}), not nearest-by-`begin` (which flips to the next
 * candle past a wide one's midpoint). Candles are sorted by `x`; at a shared edge
 * the left candle wins. A gap candle (some price non-finite) still owns its span
 * here; the caller drops it on the finiteness check. O(N) over the candles
 * (view-scale).
 */
export function ohlcIndexAtTime(ohlc: OhlcSeries, time: number): number {
  for (let i = 0; i < ohlc.length; i += 1) {
    if (time >= ohlc.x[i]! && time <= ohlc.xEnd[i]!) return i;
  }
  return -1;
}

/** All four prices finite at `i` — i.e. this candle is drawn. */
export function isFiniteOhlc(ohlc: OhlcSeries, i: number): boolean {
  return (
    Number.isFinite(ohlc.open[i]!) &&
    Number.isFinite(ohlc.high[i]!) &&
    Number.isFinite(ohlc.low[i]!) &&
    Number.isFinite(ohlc.close[i]!)
  );
}

/**
 * Resolve the `{ body, wick }` colours for one candle from its `open`/`close`
 * and the {@link ColorBy} mode. `direction` picks `rising` (close > open) /
 * `falling` (close < open) / `neutral` (equal — a doji, falling back to `rising`
 * when the style omits it); `series` always returns `rising` (one colour, no
 * up/down split). The single source of the colour decision, shared by
 * {@link drawCandles} and `<Candlestick>`'s tracker readouts so the pill colour
 * matches the mark.
 */
export function resolveCandleStyle(
  style: CandleStyle,
  open: number,
  close: number,
  colorBy: ColorBy,
): { body: string; wick: string } {
  if (colorBy === 'series') return style.rising;
  if (close > open) return style.rising;
  if (close < open) return style.falling;
  return style.neutral ?? style.rising;
}

/**
 * Draw one candle per key of `ohlc`, mapping data→pixels through
 * `xScale`/`yScale`. The OHLC sibling of {@link drawBox}: each key gets its own
 * mark over its slot x-span (`barSpanPx`, inset by `gapPx` so adjacent candles
 * breathe), in the chosen {@link CandleVariant}, coloured per {@link ColorBy}.
 *
 * The body extents are derived here (`min`/`max` of open/close) — the consumer
 * never precomputes them. A doji (open === close) draws a {@link MIN_BODY_HEIGHT_PX}
 * body so it stays visible. The body is a fraction (`style.bodyWidth`, default
 * {@link DEFAULT_BODY_WIDTH}) of the slot, centred; the wick / OHLC-bar stem sits
 * at the slot centre.
 *
 * **Gap-aware**: a key with any price non-finite is skipped entirely (no partial
 * candle) — the same contract as a box / band gap.
 *
 * O(N) over the keys, a fixed number of path ops each — no per-key allocation
 * beyond the `barSpanPx` tuple.
 */
export function drawCandles(
  ctx: CanvasRenderingContext2D,
  ohlc: OhlcSeries,
  xScale: Scale,
  yScale: Scale,
  style: CandleStyle,
  variant: CandleVariant = 'candle',
  colorBy: ColorBy = 'direction',
  gapPx = 0,
  minWidthPx = 1,
): void {
  const bodyFraction = style.bodyWidth ?? DEFAULT_BODY_WIDTH;
  // Viewport culling (Phase 2): draw only the candles whose span overlaps the
  // visible x-window (+1 each side); the loop keeps the original index `i`. Full
  // range when `xScale` has no domain (a test stub).
  const [vStart, vEnd] = visibleSpanRange(
    ohlc.x,
    ohlc.xEnd,
    ohlc.length,
    xScale,
  );
  for (let i = vStart; i < vEnd; i += 1) {
    if (!isFiniteOhlc(ohlc, i)) continue;
    const open = ohlc.open[i]!;
    const close = ohlc.close[i]!;
    const [x0, x1] = barSpanPx(
      ohlc.x[i]!,
      ohlc.xEnd[i]!,
      xScale,
      gapPx,
      minWidthPx,
    );
    const mid = (x0 + x1) / 2;
    const bodyHalf = ((x1 - x0) * bodyFraction) / 2;
    const bx0 = mid - bodyHalf;
    const bodyW = bodyHalf * 2;
    const yOpen = yScale(open);
    const yHigh = yScale(ohlc.high[i]!);
    const yLow = yScale(ohlc.low[i]!);
    const yClose = yScale(close);
    const { body, wick } = resolveCandleStyle(style, open, close, colorBy);

    if (variant === 'bar') {
      // OHLC bar: a high–low stem, a left tick at open, a right tick at close —
      // all one colour (the `body` role), no filled body.
      ctx.strokeStyle = body;
      ctx.lineWidth = style.wickWidth;
      ctx.beginPath();
      ctx.moveTo(mid, yHigh); // stem
      ctx.lineTo(mid, yLow);
      ctx.moveTo(bx0, yOpen); // open tick (points left)
      ctx.lineTo(mid, yOpen);
      ctx.moveTo(mid, yClose); // close tick (points right)
      ctx.lineTo(mid + bodyHalf, yClose);
      ctx.stroke();
      continue;
    }

    // candle / hollow: the high–low wick first (so the body overlaps it), then
    // the open→close body.
    ctx.strokeStyle = wick;
    ctx.lineWidth = style.wickWidth;
    ctx.beginPath();
    ctx.moveTo(mid, yHigh);
    ctx.lineTo(mid, yLow);
    ctx.stroke();

    // Body extents, with a doji floor so open === close still shows a mark.
    let top = Math.min(yOpen, yClose);
    let h = Math.abs(yClose - yOpen);
    if (h < MIN_BODY_HEIGHT_PX) {
      top -= (MIN_BODY_HEIGHT_PX - h) / 2;
      h = MIN_BODY_HEIGHT_PX;
    }
    // `hollow`: a rising candle is outlined (hollow), a falling / doji one filled
    // — the same strict-`>` boundary resolveCandleStyle uses (equality → neutral),
    // so a doji's fill and its colour agree.
    const hollow = variant === 'hollow' && close > open;
    if (hollow) {
      ctx.strokeStyle = body;
      ctx.lineWidth = style.wickWidth;
      ctx.strokeRect(bx0, top, bodyW, h);
    } else {
      ctx.fillStyle = body;
      ctx.fillRect(bx0, top, bodyW, h);
    }
  }
}
