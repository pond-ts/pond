/**
 * M4 line decimation (charts decimator wave, Phase 3). Reduces an
 * already-viewport-culled visible slice to a **pixel-dense** polyline that
 * rasterizes identically to the full line at the current plot width + DPR, from
 * O(devicePlotWidth) points instead of O(visible) — the win that lifts the
 * *fully-visible* draw ceiling Phase 2 culling deliberately left in place (a
 * dense series that fills the plot still strokes every point).
 *
 * **Algorithm — M4** (Jugel et al., VLDB 2014). Split the visible key range into
 * one bucket per device pixel column; per column keep the **min**, **max**,
 * **first**, and **last** value (the four channels of `Float64Column.binBy(…,
 * 'minMaxFirstLast')` — the pond-side reducer math from PR #362/#363). Drawing
 * first → min → max → last per column reproduces, pixel-for-pixel, what the full
 * line would rasterize there: the vertical extent (min→max) is exactly the band
 * of pixels the dense samples cover, and first/last carry the slope to the
 * neighbouring columns. An empty column (a gap with no samples) reduces to `NaN`
 * on all four channels — the canvas sub-path-break sentinel — so `'empty'`-mode
 * gaps fall out for free (the gap-edge union for the *inferred* gap modes is the
 * §2.2 follow-up).
 *
 * **Reads the frame geometry off the canvas**, not the layer signature: the
 * bucket count `W` is the backing buffer width `ctx.canvas.width` (already
 * `plotWidth × DPR` — see `Canvas`), and the DPR is the transform's horizontal
 * scale `ctx.getTransform().a` (Canvas applies `setTransform(dpr, …)`), so the
 * grid is at **device-pixel** resolution — at 2× DPR that is twice the columns,
 * which is what keeps extremes from flat-topping (decimator assessment §2.6).
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

/** The device-pixel ratio baked into the canvas transform (Canvas sets
 *  `setTransform(dpr, …)`), or 1 when unavailable (a test / detached ctx). */
export function contextDpr(ctx: CanvasRenderingContext2D): number {
  const t = (
    ctx as unknown as { getTransform?: () => { a: number } }
  ).getTransform?.();
  return t !== undefined && t.a > 0 ? t.a : 1;
}

/** The device-pixel bucket count for `ctx` — the backing buffer width, i.e.
 *  `plotWidth × DPR`. Falls back to `0` when there is no sized canvas (a
 *  headless test ctx), which the caller reads as "can't decimate". */
export function deviceBucketCount(ctx: CanvasRenderingContext2D): number {
  const w = (ctx as unknown as { canvas?: { width?: number } }).canvas?.width;
  return typeof w === 'number' && w > 0 ? Math.floor(w) : 0;
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
 * The `W + 1` pixel-column **edges** in key space spanning the visible domain
 * `[lo, hi]` — `edges[b] = lo + (hi − lo) · b / W`, with the last edge pinned to
 * `hi` so a sample exactly at the max lands in the final bucket (`binBy`'s upper
 * edge is inclusive). Ascending by construction.
 */
export function pixelEdges(lo: number, hi: number, W: number): Float64Array {
  const edges = new Float64Array(W + 1);
  const span = hi - lo;
  for (let b = 0; b < W; b += 1) edges[b] = lo + (span * b) / W;
  edges[W] = hi;
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
  const [lo, hi] = dom;
  if (hi <= lo) return cs;
  const W = deviceBucketCount(ctx);
  const edges = pixelEdges(lo, hi, W);
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
