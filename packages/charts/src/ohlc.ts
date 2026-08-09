import type { OhlcSeries } from './data.js';
import type { Scale } from './line.js';
import type { CandleStyle } from './theme.js';
import type { LayerDrawStats } from './context.js';
import { barSpanPx } from './range.js';
import { visibleSpanRange } from './culling.js';
import { decimateOhlc, type DecimateOption } from './decimate.js';
import { spanMatchesAny } from './span.js';
import type { SpanSelection } from './context.js';

const NO_KEYS: readonly number[] = [];
const NO_SPANS: readonly SpanSelection[] = [];

/** Linear scan — a selected/hovered set is a handful, not a collection. */
function includesKey(keys: readonly number[], key: number): boolean {
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] === key) return true;
  }
  return false;
}

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
/**
 * The candle whose **slot** contains `(px, py)` — the same rect-containment
 * `boxAt` does, over the candle's full `[x0, x1] × [high, low]` extent.
 *
 * Deliberately the slot and not the ink. A candle's body can be a doji a
 * pixel tall and its wick is a hairline; requiring the pointer to land on
 * drawn pixels would make most candles unclickable. (That the box layer makes
 * the same choice *without* saying so is [PND-BOXHIT].)
 */
export function ohlcAt(
  ohlc: OhlcSeries,
  px: number,
  py: number,
  xScale: Scale,
  yScale: Scale,
  gapPx: number,
  minWidthPx: number,
): [index: number, begin: number, close: number] | null {
  for (let i = 0; i < ohlc.length; i += 1) {
    if (!isFiniteOhlc(ohlc, i)) continue;
    const [x0, x1] = barSpanPx(
      ohlc.x[i]!,
      ohlc.xEnd[i]!,
      xScale,
      gapPx,
      minWidthPx,
    );
    if (px < x0 || px > x1) continue;
    const yHigh = yScale(ohlc.high[i]!);
    const yLow = yScale(ohlc.low[i]!);
    const top = Math.min(yHigh, yLow);
    const bottom = Math.max(yHigh, yLow);
    if (py < top || py > bottom) continue;
    return [i, ohlc.x[i]!, ohlc.close[i]!];
  }
  return null;
}

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
  decimate: DecimateOption = true,
  /** Candle keys (each candle's `x`) currently selected / hovered, and the
   *  selection's span entries — the same three channels the bar and box draws
   *  take. Empty ⇒ a display-only candle, byte-identical to before. */
  selectedKeys: readonly number[] = NO_KEYS,
  hoveredKeys: readonly number[] = NO_KEYS,
  spans: readonly SpanSelection[] = NO_SPANS,
): LayerDrawStats {
  const bodyFraction = style.bodyWidth ?? DEFAULT_BODY_WIDTH;
  const sourceCount = ohlc.length; // pre-cull, pre-decimation (for draw stats)
  // Viewport cull first (Phase 2): the [vStart, vEnd) candles whose span overlaps
  // the window (+1 each side). Full range when `xScale` has no domain (a stub).
  let [vStart, vEnd] = visibleSpanRange(ohlc.x, ohlc.xEnd, ohlc.length, xScale);
  // M4 candle decimation (Phase 5): once the *visible* candles are denser than ~2
  // per device pixel, replace them with per-column **aggregate candles**
  // (open=first, high=max, low=min, close=last — a coarser-timeframe candle;
  // {@link decimateOhlc}). Gate on the visible count, NOT `ohlc.length`: a candle's
  // width is its slot, so decimating when only a handful are on screen (deep zoom
  // into a large series) would re-slot each to a 1px sliver. `decimateOhlc` no-ops
  // (returns the same object) below the visible-density threshold or on a
  // domainless scale, leaving the loop-bound cull above.
  const decimatedOhlc =
    decimate !== false
      ? decimateOhlc(ohlc, xScale, ctx, 2, vEnd - vStart)
      : ohlc;
  const decimated = decimatedOhlc !== ohlc;
  if (decimated) {
    ohlc = decimatedOhlc; // aggregate candles are already the visible set
    vStart = 0;
    vEnd = ohlc.length;
  }
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

    // **State without hue.** A candle's colour *is* its direction, so a
    // selected candle keeps its own body/wick and takes an outline around the
    // slot instead; the field recedes by opacity, and the wick — the mark's
    // hairline — gains weight. A decimated aggregate candle carries synthetic
    // keys no mark entry can name, so per-candle state is gated off there (as
    // the box draw does) rather than lighting a column the selection never
    // held.
    const key = ohlc.x[i]!;
    const isSelected =
      !decimated &&
      (includesKey(selectedKeys, key) ||
        (spans.length > 0 && spanMatchesAny(spans, key, close)));
    const isHovered =
      !decimated && !isSelected && includesKey(hoveredKeys, key);
    const dimming =
      style.dimmedOpacity !== undefined &&
      !decimated &&
      (selectedKeys.length > 0 || spans.length > 0);
    const recede = dimming && !isSelected && !isHovered;
    // Live = hovered or selected. Both look the same on the mark itself; what
    // separates them is that a *selection* recedes everything else.
    const live = isSelected || isHovered;
    const wickW =
      live && style.liveWickWidth !== undefined
        ? style.liveWickWidth
        : style.wickWidth;
    // A live candle **grows** rather than gaining anything new: its body is
    // stroked in its own colour, so the mark thickens by the stroke and
    // nothing else changes. An outline around the *slot* was the first attempt
    // and it redraws the mark's whole footprint — far too loud for a hover,
    // and it invents a rectangle the chart otherwise never shows.
    const grow = live && style.liveWickWidth !== undefined;
    // Bracket only when the field recedes, so a chart with no selection emits
    // exactly the op stream it always did.
    const bracketed = recede;
    if (bracketed) {
      ctx.save();
      if (recede) ctx.globalAlpha = style.dimmedOpacity!;
    }

    if (variant === 'bar') {
      // OHLC bar: a high–low stem, a left tick at open, a right tick at close —
      // all one colour (the `body` role), no filled body.
      ctx.strokeStyle = body;
      ctx.lineWidth = wickW;
      ctx.beginPath();
      ctx.moveTo(mid, yHigh); // stem
      ctx.lineTo(mid, yLow);
      ctx.moveTo(bx0, yOpen); // open tick (points left)
      ctx.lineTo(mid, yOpen);
      ctx.moveTo(mid, yClose); // close tick (points right)
      ctx.lineTo(mid + bodyHalf, yClose);
      ctx.stroke();
      // The `bar` variant has no body to grow; its lines already thickened
      // above, which is the whole cue there.
      if (bracketed) ctx.restore();
      continue;
    }

    // candle / hollow: the high–low wick first (so the body overlaps it), then
    // the open→close body.
    ctx.strokeStyle = wick;
    ctx.lineWidth = wickW;
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
      // Already an outline — `wickW` is the growth.
      ctx.strokeStyle = body;
      ctx.lineWidth = wickW;
      ctx.strokeRect(bx0, top, bodyW, h);
    } else {
      ctx.fillStyle = body;
      ctx.fillRect(bx0, top, bodyW, h);
      if (grow) {
        ctx.strokeStyle = body;
        ctx.lineWidth = wickW;
        ctx.strokeRect(bx0, top, bodyW, h);
      }
    }
    if (bracketed) ctx.restore();
  }
  // `drawnCount` = candle slots iterated (visible span, or the aggregate set when
  // decimation engaged); `sourceCount` = the raw candle count it started from.
  return { sourceCount, drawnCount: vEnd - vStart, decimated };
}
