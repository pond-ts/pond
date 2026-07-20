/**
 * M4 line decimation (charts decimator wave, Phase 3). Reduces an
 * already-viewport-culled visible slice to a **pixel-dense** polyline that is
 * **visually lossless** vs the full line at the current plot width + DPR, from
 * O(devicePlotWidth) points instead of O(visible) — the win that lifts the
 * *fully-visible* draw ceiling Phase 2 culling deliberately left in place (a
 * dense series that fills the plot still strokes every point).
 *
 * **Algorithm — M4** (Jugel et al., VLDB 2014). Split the visible key range into
 * one bucket per device pixel column; per column keep the **min**, **max**,
 * **first**, and **last** value (the four channels of `Float64Column.binBy(…,
 * 'minMaxFirstLast')` — the pond-side reducer math from PR #362/#363). Drawing
 * first → min → max → last per column reproduces what the full line rasterizes
 * there: the vertical extent (min→max) is the exact band of pixels the dense
 * samples cover, and first/last carry the slope to the neighbouring columns. It
 * is lossless to within a **sub-pixel AA seam** along the envelope edges — the
 * min/max are placed at the column *centre* (their true sub-pixel x isn't carried
 * by the value-only reducer), so the edge antialiases a fraction of a pixel
 * differently than the full line (the e2e bounds the whole-plot difference at a
 * low single-digit %; a broken M4 diffs a large area). An empty column (a gap
 * with no samples) reduces to `NaN`
 * on all four channels — the canvas sub-path-break sentinel — so `'empty'`-mode
 * gaps fall out for free (the gap-edge union for the *inferred* gap modes is the
 * §2.2 follow-up).
 *
 * **Reads the frame geometry off the canvas + scale**, not the layer signature:
 * the bucket count `W` is the backing buffer width `ctx.canvas.width` (already
 * `plotWidthCss × DPR` — see `Canvas`), so the grid is at **device-pixel**
 * resolution — twice the columns at 2× DPR, which keeps extremes from
 * flat-topping (decimator assessment §2.6). The bucket **edges** are the scale's
 * CSS-pixel range (`xScale.range()`) inverted back to key space at those `W`
 * positions (see {@link pixelEdges}) — so each bucket is exactly one column on
 * **any** scale, including a non-affine `TradingTimeScale`.
 *
 * The output is a plain {@link ChartSeries} in **key space**, so it feeds
 * straight back into the existing `drawLine` path (which maps x through the same
 * `xScale` and breaks its subpath on `NaN`) — decimation is a pre-pass that
 * shrinks the point count, not a second renderer.
 */

import { Float64Column } from 'pond-ts';
import type { ChartSeries } from './data.js';
import type { Scale } from './line.js';
import { scaleDomain } from './culling.js';

/**
 * A line layer's M4-decimation control (`<LineChart decimate>`). **Default
 * `true`** — auto-decimate once the visible slice exceeds `2 ×` the device-pixel
 * column count. `false` disables it (always draw every visible point).
 * `{ threshold }` overrides the samples-per-pixel factor `k` (higher ⇒
 * decimate later). Only the honest default draw path decimates (see
 * `drawLine`); a decimated line is visually identical, so this is a perf knob,
 * not a rendering-style one.
 */
export type DecimateOption = boolean | { readonly threshold?: number };

/** The device-pixel bucket count for `ctx` — the backing buffer width, i.e.
 *  `plotWidthCss × DPR` (so buckets land at device-pixel resolution). Falls back
 *  to `0` when there is no sized canvas (a headless test ctx), which the caller
 *  reads as "can't decimate". */
export function deviceBucketCount(ctx: CanvasRenderingContext2D): number {
  const w = (ctx as unknown as { canvas?: { width?: number } }).canvas?.width;
  return typeof w === 'number' && w > 0 ? Math.floor(w) : 0;
}

/** The scale's CSS-pixel range span (`range()[last]`), or `null` when the scale
 *  exposes no numeric range. This is the pixel width the {@link pixelEdges}
 *  columns are inverted across — read through a localized cast, like
 *  {@link scaleDomain}. */
function scaleRangeWidth(xScale: Scale): number | null {
  const r = (xScale as unknown as { range?: () => number[] }).range?.();
  if (r === undefined || r.length < 2) return null;
  const w = +r[r.length - 1]!;
  return Number.isFinite(w) && w > 0 ? w : null;
}

/**
 * Whether an M4 decimation of `cs` would pay off at the current frame width:
 * `true` once the visible point count exceeds `k ×` the device-pixel column
 * count (default `k = 2` — below ~2 samples per pixel the min/max buckets barely
 * shrink the point set, so plain drawing is cheaper than the bin walk). Returns
 * `false` when the canvas has no measurable width (a test ctx) so those draws
 * stay full-resolution and byte-identical.
 */
export function shouldDecimate(
  cs: ChartSeries,
  ctx: CanvasRenderingContext2D,
  k = 2,
): boolean {
  const W = deviceBucketCount(ctx);
  return W > 0 && cs.length > k * W;
}

/**
 * The `key`-space (`(px) => value`) inverse of a chart scale, or `null` when the
 * scale exposes none. Every continuous chart x scale (`scaleLinear`, `scaleTime`,
 * `TradingTimeScale`) carries `.invert`; a category `ScaleBand` doesn't (and a
 * line never sits on one). Read through a localized cast, like {@link scaleDomain}.
 */
function scaleInvert(xScale: Scale): ((px: number) => number) | null {
  const inv = (xScale as unknown as { invert?: (px: number) => number }).invert;
  return typeof inv === 'function'
    ? (px: number) => +inv.call(xScale, px)
    : null;
}

/**
 * The `W + 1` pixel-column **edges** in key space — built by **inverting uniform
 * pixel positions** through the scale (`edges[b] = invert(b/W · plotWidthCss)`),
 * NOT by partitioning the key domain uniformly. The distinction is load-bearing:
 * "one bucket per pixel column" means uniform in *pixel* space, which equals a
 * uniform *key* partition only when the scale is **affine** (`scaleLinear` /
 * `scaleTime`). A `TradingTimeScale` compresses closed-market gaps — its key→px
 * map is piecewise-linear — so inverting pixel positions is what keeps each
 * bucket exactly one column wide there too (else the min/max envelope would thin
 * within a session). `invert` is monotonic, so the edges ascend; the last is the
 * domain max (`invert(plotWidthCss)`), inclusive in `binBy`.
 *
 * `plotWidthCss` is the CSS-pixel plot width (`W / dpr` — `W` counts *device*
 * columns), so the inverted positions land on the scale's CSS-pixel range.
 */
export function pixelEdges(
  invert: (px: number) => number,
  plotWidthCss: number,
  W: number,
): Float64Array {
  const edges = new Float64Array(W + 1);
  for (let b = 0; b <= W; b += 1) edges[b] = invert((plotWidthCss * b) / W);
  return edges;
}

/**
 * Decimate `cs` (a viewport-culled visible slice, ascending `x`) to an M4
 * polyline for `ctx`'s current width + DPR. Returns the **same object** when
 * decimation doesn't apply — the scale has no domain (a test stub), the canvas
 * has no width, or the series is already sparse enough ({@link shouldDecimate})
 * — so those frames draw full-resolution unchanged.
 *
 * Otherwise returns a fresh {@link ChartSeries} of up to `4·W` points: per
 * non-empty column, four points at `[first, min, max, last]` placed at the
 * column's left / centre / centre / right key positions (sub-pixel within the
 * 1px column), and a single `NaN` break per empty column. The classic M4 render
 * — the min→max vertical is the exact pixel band the dense samples cover, and
 * first/last carry the inter-column slope.
 */
export function decimateM4(
  cs: ChartSeries,
  xScale: Scale,
  ctx: CanvasRenderingContext2D,
  k = 2,
): ChartSeries {
  if (!shouldDecimate(cs, ctx, k)) return cs;
  const dom = scaleDomain(xScale);
  if (dom === null) return cs;
  if (dom[1] <= dom[0]) return cs;
  const invert = scaleInvert(xScale);
  const plotWidthCss = scaleRangeWidth(xScale);
  // No inverse / range ⇒ can't align buckets to pixel columns; draw full-res.
  if (invert === null || plotWidthCss === null) return cs;
  const W = deviceBucketCount(ctx);
  // `W` device columns inverted across the scale's CSS-pixel range → key-space
  // edges, so each bucket is exactly one pixel column on **any** scale (affine
  // or trading-time — see {@link pixelEdges}).
  const edges = pixelEdges(invert, plotWidthCss, W);
  // Bin the value channel against the pixel-column edges over the key axis. A
  // fresh Float64Column wraps the already-materialized `cs.y` (zero-copy — it
  // reads, never mutates); `cs.x` is the monotonic key.
  const col = new Float64Column(cs.y, cs.length);
  const {
    lo: mn,
    hi: mx,
    first,
    last,
  } = col.binBy(cs.x, edges, 'minMaxFirstLast');
  return m4Polyline(edges, mn, mx, first, last, W);
}

/**
 * Assemble the M4 polyline {@link ChartSeries} from the four binned channels.
 * Split out (pure, no canvas / pond deps) so the point emission is unit-tested
 * directly. Per column `b`: an empty bucket (`first[b]` non-finite ⇒ all four
 * are) emits one `NaN` break; a live bucket emits
 * `(left, first) (mid, min) (mid, max) (right, last)`.
 */
export function m4Polyline(
  edges: Float64Array,
  mn: Float64Array,
  mx: Float64Array,
  first: Float64Array,
  last: Float64Array,
  W: number,
): ChartSeries {
  // Upper bound 4 points/column + a break slot each; trimmed to the real count.
  const x = new Float64Array(W * 4);
  const y = new Float64Array(W * 4);
  let n = 0;
  let brokenLast = false; // avoid emitting consecutive NaN breaks
  for (let b = 0; b < W; b += 1) {
    if (!Number.isFinite(first[b]!)) {
      if (!brokenLast && n > 0) {
        x[n] = edges[b]!;
        y[n] = NaN;
        n += 1;
        brokenLast = true;
      }
      continue;
    }
    brokenLast = false;
    const left = edges[b]!;
    const right = edges[b + 1]!;
    const mid = (left + right) / 2;
    // first (left) → min (mid) → max (mid) → last (right): the min→max vertical
    // plus the entry/exit stubs that connect to the neighbouring columns.
    x[n] = left;
    y[n] = first[b]!;
    x[n + 1] = mid;
    y[n + 1] = mn[b]!;
    x[n + 2] = mid;
    y[n + 2] = mx[b]!;
    x[n + 3] = right;
    y[n + 3] = last[b]!;
    n += 4;
  }
  // A trailing break (empty columns after the last live one) is a no-op for the
  // draw — drop it so the point count is exact.
  if (n > 0 && Number.isNaN(y[n - 1]!)) n -= 1;
  return { x: x.subarray(0, n), y: y.subarray(0, n), length: n };
}
