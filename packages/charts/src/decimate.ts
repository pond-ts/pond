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
 * with no samples) reduces to `NaN` on all four channels — the canvas
 * sub-path-break sentinel — so a gap becomes a break for free.
 *
 * **Gaps (§2.2 gap-edge union).** A `binBy` bucket straddling a gap *edge* is
 * validity-blind (min/max/first/last see only the finite samples), so it would
 * silently bridge a gap `'empty'` must break and rob the dashed/step/fade
 * connectors of exact edge values. {@link gapKeyEdges} folds every ≥1-column
 * interior gap's boundaries into the bucket-edge list, so each gap reduces to its
 * own empty (NaN) bucket and the bordering buckets carry the exact pre/post-gap
 * values — the decimated series then feeds the *unchanged* gap-mode machinery in
 * `drawLine` (`'none'` bridges the breaks, dashed/step/fade draw their inferred
 * connectors from `collectGapEdges`).
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
import type {
  ChartSeries,
  BandSeries,
  OhlcSeries,
  BoxSeries,
  BarSeries,
} from './data.js';
import type { Scale } from './line.js';
import { scaleDomain, cullChartSeries } from './culling.js';

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
 * Whether decimating a series of `length` samples would pay off at the current
 * frame width: `true` once `length` exceeds `k ×` the device-pixel column count
 * (default `k = 2` — below ~2 samples per pixel the min/max buckets barely shrink
 * the point set, so plain drawing is cheaper than the bin walk). Returns `false`
 * when the canvas has no measurable width (a test ctx) so those draws stay
 * full-resolution and byte-identical. Shared by the line ({@link shouldDecimate})
 * and band decimators.
 */
export function shouldDecimateCount(
  length: number,
  ctx: CanvasRenderingContext2D,
  k = 2,
): boolean {
  const W = deviceBucketCount(ctx);
  return W > 0 && length > k * W;
}

/** {@link shouldDecimateCount} for a {@link ChartSeries} (the line / area case). */
export function shouldDecimate(
  cs: ChartSeries,
  ctx: CanvasRenderingContext2D,
  k = 2,
): boolean {
  return shouldDecimateCount(cs.length, ctx, k);
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
 * `plotWidthCss` is the scale's CSS-pixel range width (`xScale.range()` max);
 * `W` counts *device* columns (`plotWidthCss × DPR`), so the `W` inverted
 * positions land at device-pixel resolution across the CSS range.
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
 * Key-space bucket boundaries that isolate each **interior gap** — a `NaN` run in
 * `y` with a finite sample on both sides — that spans at least one pixel column
 * (`minSpan`). This is the §2.2 gap-edge union: without it a `binBy` bucket
 * straddling a gap edge is *validity-blind* (min/max/first/last see only the
 * finite samples), so it silently bridges a gap `'empty'` mode must break and the
 * `dashed`/`step`/`fade` connectors lose their exact edge values. For a gap
 * bounded by finite `x[a]` (last before) and `x[c]` (first after), with the first
 * `NaN` at `x[a+1]`, two edges are emitted:
 *
 * - `x[a+1]` — so `x[a]` stays the **last** finite sample of the prior bucket
 *   (its `last` channel = the exact pre-gap edge value); and
 * - `x[c]` — so `x[c]` **starts** the next bucket (its `first` = the exact
 *   post-gap edge value).
 *
 * The `[x[a+1], x[c])` bucket between them is then all-`NaN` → an empty bucket →
 * the `NaN` break. Only gaps at least one pixel column wide (`x[c] − x[a] ≥
 * minSpan`) are emitted — a sub-pixel dropout is invisible and left to the
 * plain empty-bucket convention, which also **bounds the edge count** (disjoint
 * gaps each ≥ `minSpan` ⇒ ≤ `W` of them ⇒ ≤ `3W` total edges). Emitted ascending
 * (`x` is). Leading / trailing `NaN` runs are skipped (no bridge to preserve —
 * the first/last live bucket handles the end).
 *
 * `minSpan` is the caller's mean per-column key width (`domainSpan / W`) — exact
 * on an affine scale, an **approximation** on a `TradingTimeScale` (where a
 * column's key width varies across compressed gaps). A misfire there is benign:
 * a real ≥1px gap it skips still breaks in its fully-empty interior columns; only
 * the ~1px gap *edges* bridge (and session-break charts gate decimation off
 * entirely). A per-gap pixel-width measure is the follow-up if a consumer hits it.
 */
export function gapKeyEdges(cs: ChartSeries, minSpan: number): number[] {
  const { x, y, length } = cs;
  const out: number[] = [];
  let prevFinite = -1;
  for (let i = 0; i < length; i += 1) {
    if (!Number.isFinite(y[i]!)) continue;
    if (
      prevFinite >= 0 &&
      i - prevFinite > 1 &&
      x[i]! - x[prevFinite]! >= minSpan
    ) {
      out.push(x[prevFinite + 1]!); // first NaN key
      out.push(x[i]!); // first finite key after the gap
    }
    prevFinite = i;
  }
  return out;
}

/**
 * Merge the pixel-column `edges` with the interior-gap boundaries `gaps` (both
 * ascending) into one ascending, duplicate-free edge list, keeping only gap
 * boundaries strictly inside the domain `(lo, hi)` so the pixel span isn't
 * extended. Returns the **same** `edges` array (identity — no allocation) when
 * `gaps` is empty, so the gapless hot path is untouched.
 */
export function mergeGapEdges(
  edges: Float64Array,
  gaps: number[],
  lo: number,
  hi: number,
): Float64Array {
  if (gaps.length === 0) return edges; // gapless hot path — identity, no alloc
  const inRange = gaps.filter((g) => g > lo && g < hi);
  if (inRange.length === 0) return edges;
  const all = [...edges, ...inRange].sort((a, b) => a - b);
  const out: number[] = [];
  for (const e of all)
    if (out.length === 0 || e > out[out.length - 1]!) out.push(e);
  return Float64Array.from(out);
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
 *
 * `boundaries` are trading-axis session-break instants: their keys are unioned
 * into the bucket edges so no bucket straddles a break (which would merge two
 * sessions' extremes). The caller's `sessionRuns` then splits the returned
 * series into per-session subpaths at exactly those instants.
 */
export function decimateM4(
  cs: ChartSeries,
  xScale: Scale,
  ctx: CanvasRenderingContext2D,
  k = 2,
  boundaries: readonly number[] = [],
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
  const pixels = pixelEdges(invert, plotWidthCss, W);
  // Edge union — fold two families of boundaries into the bucket edges so no
  // bucket ever straddles one:
  //  - §2.2 gap edges: every ≥1-column interior gap → its own empty (NaN) bucket
  //    with exact pre/post-gap values (so `'empty'` breaks precisely and the
  //    dashed/step/fade connectors land right).
  //  - session-break instants (`boundaries`, a trading-time close→open): a bucket
  //    that spanned a break would merge the two sessions' min/max across the
  //    discontinuity. Aligning a bucket edge to each break keeps the sessions
  //    separate, so `sessionRuns` in `drawLine` cuts the decimated series cleanly.
  // A gapless, boundary-free slice returns `pixels` unchanged (no allocation).
  const extra = gapKeyEdges(cs, (dom[1] - dom[0]) / W);
  // Session-break instants inside the visible domain — unioned into the edges AND
  // marked as explicit break points so the decimated series breaks (not connects)
  // there. `mergeGapEdges` keeps their exact values, so the set matches the edges.
  const breaks =
    boundaries.length > 0
      ? boundaries.filter((b) => b > dom[0] && b < dom[1])
      : [];
  const edges = mergeGapEdges(
    pixels,
    breaks.length > 0 ? [...extra, ...breaks] : extra,
    dom[0],
    dom[1],
  );
  const buckets = edges.length - 1;
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
  return m4Polyline(
    edges,
    mn,
    mx,
    first,
    last,
    buckets,
    breaks.length > 0 ? new Set(breaks) : undefined,
  );
}

/**
 * Stable empty boundary list for the (common) no-session-break decimation cache
 * key — so an area / no-break line draw compares equal frame-to-frame instead of
 * missing on a fresh default `[]`.
 */
const NO_BOUNDARIES: readonly number[] = [];

interface M4CacheEntry {
  readonly xScale: Scale;
  readonly W: number;
  readonly k: number | undefined;
  readonly boundaries: readonly number[];
  readonly series: ChartSeries;
  readonly decimated: boolean;
}

/**
 * One-entry-per-source cache of the cull+M4-decimate result ([PND-DECKEY]),
 * keyed on the source series (`WeakMap`) → the last `(xScale, W, k, boundaries)`
 * it was drawn for. Evicts with the series (no leak); one entry per source keeps
 * it bounded under pan (see {@link decimateM4Cached}).
 */
const m4Cache = new WeakMap<ChartSeries, M4CacheEntry>();

/**
 * Cull `source` to the visible window and M4-decimate it, **memoized per source
 * series** so a y-only repaint reuses the prior frame's polyline instead of
 * re-binning O(N) points. The decimation output is a pure function of the source
 * data, the x mapping, the device width, the threshold, and the session breaks —
 * it **never reads the y-scale** — so it is byte-identical across every y-zoom /
 * y-autorange frame (the ~19% mountain@1M recompute the 2026-07 bench profile
 * flagged, finding 3: an x-only computation re-run under y-only invalidation).
 *
 * The cache holds **one** entry per source: a y-only frame matches the stored
 * key → hit; a pan / x-zoom mints a fresh `xScale` (`ChartContainer` keys the
 * scale on the x-domain, not the y-domain — so the scale object is stable under
 * y-zoom and fresh under pan) → miss, and the single entry is overwritten. So it
 * **wins on y-only frames and is a no-op under pan** — bounded, never growing,
 * the same reasoning that made Path2D caching not help pan ([PND-DECIM]).
 *
 * Correctness rests on the {@link ChartSeries} immutability contract: a data
 * change mints a **new** source object (the layer re-materializes its column),
 * so a stale entry can't be read. `boundaries` is compared by **identity** — the
 * `<LineChart>` session-break instants are `useMemo`-stable across frames; a
 * caller passing a fresh array each frame simply misses (safe, no benefit). `W`
 * is `deviceBucketCount(ctx)` so a DPR / resize change re-keys. Keying on the
 * `xScale` object (not just its `[domain, W]`) is what keeps the hit correct on
 * a **non-affine** trading-time scale too — same scale object ⇒ identical
 * pixel-column edges.
 *
 * Returns `{ series, decimated }`: `series` is the M4 polyline, or the plain
 * culled slice when the window is too sparse to decimate ({@link decimateM4}
 * no-ops); `decimated` says which (for the caller's draw-stats + session-run
 * split). Callers pass the **pre-cull** source and skip their own cull — this
 * function does it, so a cache hit skips the cull too.
 */
export function decimateM4Cached(
  source: ChartSeries,
  xScale: Scale,
  ctx: CanvasRenderingContext2D,
  k?: number,
  boundaries: readonly number[] = NO_BOUNDARIES,
): { series: ChartSeries; decimated: boolean } {
  const W = deviceBucketCount(ctx);
  const cached = m4Cache.get(source);
  if (
    cached !== undefined &&
    cached.xScale === xScale &&
    cached.W === W &&
    cached.k === k &&
    cached.boundaries === boundaries
  ) {
    return cached;
  }
  const culled = cullChartSeries(source, xScale);
  const series = decimateM4(culled, xScale, ctx, k, boundaries);
  const entry: M4CacheEntry = {
    xScale,
    W,
    k,
    boundaries,
    series,
    decimated: series !== culled,
  };
  m4Cache.set(source, entry);
  return entry;
}

/** Shared empty break-set for the common (no session-break) case. */
const NO_BREAKS: ReadonlySet<number> = new Set();

/**
 * Assemble the M4 polyline {@link ChartSeries} from the four binned channels.
 * Split out (pure, no canvas / pond deps) so the point emission is unit-tested
 * directly. Per column `b`: an empty bucket (`first[b]` non-finite ⇒ all four
 * are) emits one `NaN` break; a live bucket emits
 * `(left, first) (mid, min) (mid, max) (right, last)`.
 *
 * `breakAt` holds bucket-edge keys (session-break instants, already unioned into
 * `edges`) at which the line must **break** rather than connect: a bucket whose
 * left edge is in `breakAt` emits a `NaN` **before** its points. This makes a
 * session split explicit in the geometry — clean regardless of whether the break
 * fell exactly on a pixel edge (where otherwise the closing bucket's `last` and
 * the opening bucket's `first` would sit at the same x and connect with a
 * spurious vertical stub).
 */
export function m4Polyline(
  edges: Float64Array,
  mn: Float64Array,
  mx: Float64Array,
  first: Float64Array,
  last: Float64Array,
  W: number,
  breakAt: ReadonlySet<number> = NO_BREAKS,
): ChartSeries {
  // Upper bound: 4 points/column + a break slot each (empty buckets and each
  // session break); trimmed to the real count.
  const cap = W * 4 + breakAt.size;
  const x = new Float64Array(cap);
  const y = new Float64Array(cap);
  let n = 0;
  let brokenLast = false; // avoid emitting consecutive NaN breaks
  for (let b = 0; b < W; b += 1) {
    // Explicit session break: this bucket opens a new session → pen up first.
    if (b > 0 && !brokenLast && n > 0 && breakAt.has(edges[b]!)) {
      x[n] = edges[b]!;
      y[n] = NaN;
      n += 1;
      brokenLast = true;
    }
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

/**
 * Decimate a {@link BandSeries} (a filled variance envelope) to one sample per
 * device-pixel column: per column the **min of `lower`** and the **max of
 * `upper`** — the *widest* envelope the dense samples span, so a decimated band
 * covers exactly the pixels the full band's silhouette would (decimator
 * assessment §2.5: paired min-lower / max-upper, so the envelope can never
 * invert — `max(upper) ≥ min(lower)` for any valid band). Returns the **same
 * object** when decimation doesn't apply (sparse band, domainless / non-invertible
 * scale, no canvas width).
 *
 * Uses the same pixel-aligned edges as the line decimator ({@link pixelEdges} —
 * correct on non-affine scales too), binning `lower` with `'min'` and `upper`
 * with `'max'`. An empty column (no samples) reduces to `NaN` on both edges — the
 * `drawBand` `.defined` break. Unlike the line path this needs **no gap-edge
 * union**: a band has no inferred-connector modes (`drawBand` always breaks the
 * fill at a gap, never bridges), so a sub-pixel gap edge folding into a boundary
 * bucket is invisible — there is no connector to misplace. Assumes `lower` /
 * `upper` are finite **together** per sample (the paired-percentile shape bands
 * are built from); a column where only one edge has finite samples would bin a
 * band segment that no single sample carried.
 */
export function decimateBand(
  band: BandSeries,
  xScale: Scale,
  ctx: CanvasRenderingContext2D,
  k = 2,
): BandSeries {
  if (!shouldDecimateCount(band.length, ctx, k)) return band;
  const dom = scaleDomain(xScale);
  if (dom === null || dom[1] <= dom[0]) return band;
  const invert = scaleInvert(xScale);
  const plotWidthCss = scaleRangeWidth(xScale);
  if (invert === null || plotWidthCss === null) return band;
  const W = deviceBucketCount(ctx);
  const edges = pixelEdges(invert, plotWidthCss, W);
  const lowerMin = new Float64Column(band.lower, band.length).binBy(
    band.x,
    edges,
    'min',
  );
  const upperMax = new Float64Column(band.upper, band.length).binBy(
    band.x,
    edges,
    'max',
  );
  const x = new Float64Array(W);
  const lower = new Float64Array(W);
  const upper = new Float64Array(W);
  for (let b = 0; b < W; b += 1) {
    x[b] = (edges[b]! + edges[b + 1]!) / 2; // column centre
    lower[b] = lowerMin[b]!; // NaN on an empty column → the fill break
    upper[b] = upperMax[b]!;
  }
  return { x, lower, upper, length: W };
}

/**
 * Decimate an {@link OhlcSeries} to one **aggregate candle per device-pixel
 * column** — `open = first`, `high = max`, `low = min`, `close = last` over the
 * candles that fall in the column. This is exactly a candle re-bucketed to a
 * **coarser timeframe** (the pixel-column's time range): it is never *wrong* —
 * it is the true OHLC of that span — so a dense chart that zooms out reads as
 * fewer, wider aggregate candles, the trading-UI convention (decimator
 * assessment §2.4). Auto-on with an opt-out; a consumer wanting fixed-timeframe
 * candles pre-aggregates upstream and passes `decimate={false}`.
 *
 * Returns the **same object** when decimation doesn't apply (sparse series,
 * domainless / non-invertible scale, no canvas width). The slot of each
 * aggregate candle is its pixel column `[edges[b], edges[b+1]]`; an empty column
 * (no candles) reduces to `NaN` on all channels — `drawCandles` skips it. No
 * session-break union is needed: candles are independent marks (they never
 * connect), and a trading-axis closed period is simply an empty column.
 */
export function decimateOhlc(
  ohlc: OhlcSeries,
  xScale: Scale,
  ctx: CanvasRenderingContext2D,
  k = 2,
  visibleCount = ohlc.length,
): OhlcSeries {
  // Gate on the number of candles *in view*, not the whole series: a candle's
  // width is its pixel-column slot, so re-slotting a handful of deep-zoomed
  // candles to one column each would render them as 1px slivers. Below the
  // visible-density threshold the loop-bound cull draws them at full width.
  if (!shouldDecimateCount(visibleCount, ctx, k)) return ohlc;
  const dom = scaleDomain(xScale);
  if (dom === null || dom[1] <= dom[0]) return ohlc;
  const invert = scaleInvert(xScale);
  const plotWidthCss = scaleRangeWidth(xScale);
  if (invert === null || plotWidthCss === null) return ohlc;
  const W = deviceBucketCount(ctx);
  const edges = pixelEdges(invert, plotWidthCss, W);
  // Bin each channel over the candles' (monotonic) left-edge key. open/close need
  // the first/last channels (only `'minMaxFirstLast'` carries them); high/low are
  // the scalar max/min. Four O(n) walks — candle counts are modest.
  const key = ohlc.x;
  const openCh = new Float64Column(ohlc.open, ohlc.length).binBy(
    key,
    edges,
    'minMaxFirstLast',
  ).first;
  const closeCh = new Float64Column(ohlc.close, ohlc.length).binBy(
    key,
    edges,
    'minMaxFirstLast',
  ).last;
  const highCh = new Float64Column(ohlc.high, ohlc.length).binBy(
    key,
    edges,
    'max',
  );
  const lowCh = new Float64Column(ohlc.low, ohlc.length).binBy(
    key,
    edges,
    'min',
  );
  const x = new Float64Array(W);
  const xEnd = new Float64Array(W);
  for (let b = 0; b < W; b += 1) {
    x[b] = edges[b]!; // the aggregate candle's slot IS its pixel column
    xEnd[b] = edges[b + 1]!;
  }
  return {
    x,
    xEnd,
    open: openCh,
    high: highCh,
    low: lowCh,
    close: closeCh,
    length: W,
  };
}

/**
 * Decimate a {@link BoxSeries} to one **aggregate box per device-pixel column** —
 * the interval-mark sibling of {@link decimateOhlc}. Each channel is binned over
 * the column: the whiskers widen to the column's full reach (`lower = min(lower)`,
 * `upper = max(upper)`, exactly {@link decimateBand}'s envelope), the body to the
 * column's **IQR envelope** (`q1 = min(q1)`, `q3 = max(q3)`), and the centre line
 * to the **first** box's `median` in the column (a real median value, not an
 * average — `binBy` carries no mean; it stays within the aggregate body since the
 * first box's `[q1, q3]` ⊆ the envelope). So a dense per-x distribution chart
 * that zooms out reads as fewer, wider boxes summarising each column's spread.
 *
 * Gates on the **visible** box count (a box's width is its slot — decimating a
 * handful of deep-zoomed boxes would render 1px slivers, the same trap the candle
 * path has). Returns the **same object** when decimation doesn't apply (below the
 * visible-density threshold, domainless / non-invertible scale, no canvas width).
 * The `hasBox` / `hasMedian` flags carry through, so a **range-only** box (all-NaN
 * `q1`/`q3`) stays range-only (its binned body is NaN throughout). An empty column
 * reduces to `NaN` on every channel — `drawBox` skips it via `isFiniteBox`.
 */
export function decimateBox(
  box: BoxSeries,
  xScale: Scale,
  ctx: CanvasRenderingContext2D,
  k = 2,
  visibleCount = box.length,
): BoxSeries {
  if (!shouldDecimateCount(visibleCount, ctx, k)) return box;
  const dom = scaleDomain(xScale);
  if (dom === null || dom[1] <= dom[0]) return box;
  const invert = scaleInvert(xScale);
  const plotWidthCss = scaleRangeWidth(xScale);
  if (invert === null || plotWidthCss === null) return box;
  const W = deviceBucketCount(ctx);
  const edges = pixelEdges(invert, plotWidthCss, W);
  const key = box.x;
  const n = box.length;
  // Envelope whiskers + IQR body (scalar min/max); centre line = the first box's
  // median (only `'minMaxFirstLast'` carries `first`). Five O(n) walks — box
  // counts are modest, like candles.
  const lowerCh = new Float64Column(box.lower, n).binBy(key, edges, 'min');
  const upperCh = new Float64Column(box.upper, n).binBy(key, edges, 'max');
  const q1Ch = new Float64Column(box.q1, n).binBy(key, edges, 'min');
  const q3Ch = new Float64Column(box.q3, n).binBy(key, edges, 'max');
  const medianCh = new Float64Column(box.median, n).binBy(
    key,
    edges,
    'minMaxFirstLast',
  ).first;
  const x = new Float64Array(W);
  const xEnd = new Float64Array(W);
  for (let b = 0; b < W; b += 1) {
    x[b] = edges[b]!; // the aggregate box's slot IS its pixel column
    xEnd[b] = edges[b + 1]!;
  }
  return {
    x,
    xEnd,
    lower: lowerCh,
    q1: q1Ch,
    median: medianCh,
    q3: q3Ch,
    upper: upperCh,
    length: W,
    // Carry the flags through so a range-only / no-median box stays that way;
    // omit (not `undefined`) when unset, per `exactOptionalPropertyTypes`.
    ...(box.hasBox !== undefined ? { hasBox: box.hasBox } : {}),
    ...(box.hasMedian !== undefined ? { hasMedian: box.hasMedian } : {}),
  };
}

/**
 * One filled **envelope rect per device-pixel column** — the decimated form of a
 * {@link BarSeries} ({@link decimateBars}). Each column `b` spans `[begin[b],
 * end[b]]` in key space and fills the value range `[lo[b], hi[b]]`, i.e. the union
 * of every bar in that column (their tops range over `[min, max]`, and each bar
 * also reaches the baseline — so the union is `[min(minValue, baseline),
 * max(maxValue, baseline)]`). An empty column carries `NaN` on `lo`/`hi` and draws
 * nothing.
 */
export interface BarColumnEnvelope {
  readonly begin: Float64Array;
  readonly end: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly length: number;
}

/**
 * Decimate a {@link BarSeries} to **one envelope rect per device-pixel column**
 * ([PND-MARKDEC]) — the interval-mark analog of {@link decimateBand}, for the
 * "column chart, dense in x" case (SciChart-suite finding 4: a bar column has no
 * decimation path, so it falls off where line/area/candle don't). Once each bar's
 * slot is narrower than ~1px (the visible bars exceed `k ×` the device-pixel
 * column count), the individual rects overplot into a solid silhouette; this
 * replaces them with the exact painted union: per column, `lo = min(minValue,
 * baseline)` and `hi = max(maxValue, baseline)` — the bars' value range widened
 * to include the baseline every bar reaches. Drawing one rect `[begin, end] ×
 * [lo, hi]` per column reproduces that silhouette from O(W) rects instead of
 * O(visible).
 *
 * Gates on the **visible** bar count (`visibleCount`, a bar's width is its slot —
 * decimating a handful of deep-zoomed bars would render 1px slivers, the same
 * trap the candle / box paths gate against). Returns `null` when decimation
 * doesn't apply (below the visible-density threshold, domainless / non-invertible
 * scale, no canvas width) — the caller then draws every visible bar. Bars are
 * binned by their **`begin`** key (at this density `begin`/`end` sit in the same
 * column); the envelope ignores per-bar `gapPx` and tiles the column (a few-px
 * gap is invisible at <1px bars anyway — the standard decimation tradeoff).
 * `baseline` is the resolved bar baseline in **value** units (from
 * `resolveBarBaseline`), so the union is honest about the zero line.
 */
export function decimateBars(
  cs: BarSeries,
  xScale: Scale,
  ctx: CanvasRenderingContext2D,
  baseline: number,
  k = 2,
  visibleCount = cs.length,
): BarColumnEnvelope | null {
  if (!shouldDecimateCount(visibleCount, ctx, k)) return null;
  const dom = scaleDomain(xScale);
  if (dom === null || dom[1] <= dom[0]) return null;
  const invert = scaleInvert(xScale);
  const plotWidthCss = scaleRangeWidth(xScale);
  if (invert === null || plotWidthCss === null) return null;
  const W = deviceBucketCount(ctx);
  const edges = pixelEdges(invert, plotWidthCss, W);
  // Per-column min/max of the bar values, binned by the bar's begin key — two O(n)
  // walks, like decimateBand. An empty column reduces to NaN on both.
  const col = new Float64Column(cs.y, cs.length);
  const vMin = col.binBy(cs.begin, edges, 'min');
  const vMax = col.binBy(cs.begin, edges, 'max');
  const begin = new Float64Array(W);
  const end = new Float64Array(W);
  const lo = new Float64Array(W);
  const hi = new Float64Array(W);
  for (let b = 0; b < W; b += 1) {
    begin[b] = edges[b]!;
    end[b] = edges[b + 1]!;
    const mn = vMin[b]!;
    if (Number.isFinite(mn)) {
      // Widen to the baseline so the rect spans exactly the painted union (each
      // bar reaches the baseline). One-signed data ⇒ one edge is the baseline ⇒
      // the rect is the tallest bar, unchanged.
      lo[b] = Math.min(mn, baseline);
      hi[b] = Math.max(vMax[b]!, baseline);
    } else {
      lo[b] = NaN; // empty column — drawBars skips it
      hi[b] = NaN;
    }
  }
  return { begin, end, lo, hi, length: W };
}
