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
 * rect. This is the **ink** — what {@link drawBars} paints. Hit-testing uses
 * {@link barSlotRect} instead (the bar's whole slot), so the drawn rect and the
 * hit region are deliberately *not* the same geometry: the `gapPx` inset
 * separates columns visually without carving a dead channel out of the target.
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
 * The value-space span `[lo, hi]` of **threshold band `k`** along a bar running
 * from `base` to `v`, or `null` when the bar doesn't reach that band.
 *
 * A threshold ladder colours one bar **along its length** — neutral up to the
 * first threshold, then warning, then alarm — so a long bar shows how far
 * through the ladder it travelled rather than only which band it ended in. With
 * `thresholds = [t0, t1]` there are three bands: `[0, t0)`, `[t0, t1)`,
 * `[t1, ∞)`. Band `k` spans magnitudes `[thresholds[k-1] ?? 0, thresholds[k] ??
 * ∞)`, each end clipped to the bar's own magnitude — so a bar that stops inside
 * band 1 yields a truncated band 1 and `null` for band 2.
 *
 * **Breakpoints are absolute data values, not offsets from the baseline** — a
 * `thresholds={[1, 2]}` ladder means "warning above 1, alarm above 2" in the
 * axis's own units, which is what a threshold means everywhere else. They are
 * matched on the **magnitude** and applied to whichever side of zero the bar
 * is on, so a bar hanging below the baseline walks the same ladder downward
 * and a ±3.5 diverging scale bands symmetrically without the caller supplying
 * negative breakpoints. (An asymmetric ladder would need signed breakpoints;
 * deferred until a consumer pulls — see [PND-BANDBAR2].)
 *
 * The painted span is then **clipped to what the bar actually draws**, which
 * is what makes a domain that excludes zero behave: with `<YAxis min={10}>` a
 * bar rests on 10, so a `[1, 2]` ladder leaves it entirely in the top band
 * rather than banding at 11 and 12. Measuring the ladder from the *resolved
 * baseline* instead would silently shift every breakpoint by the axis floor —
 * exactly the class of quiet wrongness this feature exists to remove.
 *
 * Note this is **draw-only geometry**. Hit-testing still treats the bar as one
 * target ({@link barSlotRect} / {@link barAt}), which is the whole reason this
 * is a mark rather than the N-layer overpaint recipe it replaces: one bar keeps
 * one hit region, one stable `mark`, and one legend row.
 *
 * `thresholds` is assumed ascending and finite — {@link normalizeThresholds}
 * enforces that once at the prop boundary rather than per bar per frame.
 */
export function bandSpan(
  base: number,
  v: number,
  thresholds: readonly number[],
  k: number,
): [lo: number, hi: number] | null {
  return bandSpanInto(base, v, thresholds, k) ? [bandLo, bandHi] : null;
}

/**
 * The band-`k` span, written to {@link bandLo} / {@link bandHi} instead of
 * returned — `true` when the bar reaches this band, `false` when it doesn't.
 *
 * This is {@link bandSpan}'s implementation, split out because the tuple
 * mattered: a K-band ladder allocates K tuples **per bar per frame**, and the
 * bench showed that turning a banded draw from ~44% *cheaper* than the N-layer
 * workaround it replaces into ~44% *dearer* than it. Same arithmetic, no
 * garbage. `bandSpan` stays as the allocating wrapper so the geometry is
 * testable as a value.
 *
 * Module-scope scratch is safe here: the draw path is single-threaded and reads
 * both fields immediately after a `true`, before any other call can run.
 */
let bandLo = 0;
let bandHi = 0;

function bandSpanInto(
  base: number,
  v: number,
  thresholds: readonly number[],
  k: number,
): boolean {
  const lo = k === 0 ? 0 : thresholds[k - 1]!;
  const hi = k < thresholds.length ? thresholds[k]! : Infinity;
  // The bar's drawn extent, ascending. `resolveBarBaseline` clamps 0 into the
  // domain, so this span never straddles zero: either it starts at 0, or the
  // whole domain sits to one side of it.
  const sLo = base < v ? base : v;
  const sHi = base < v ? v : base;
  // Band `k` covers the *absolute* values `[lo, hi)`, which is two intervals —
  // `[lo, hi]` and `[-hi, -lo]`. Pick the one on the bar's own side of zero.
  const positive = sHi > 0;
  let bLo = positive ? lo : -hi;
  // `-lo` when `lo === 0` is **negative zero**, which would escape through the
  // exported `bandSpan` and fail any consumer's `Object.is` / `toEqual` against
  // a plain `0`. Normalize at the source rather than letting each caller cope.
  let bHi = positive ? hi : lo === 0 ? 0 : -lo;
  // Clip to what the bar actually draws. An empty or inverted result means this
  // band lies outside the bar's span — either beyond its reach, or (on a domain
  // that excludes zero) entirely below its floor.
  if (bLo < sLo) bLo = sLo;
  if (bHi > sHi) bHi = sHi;
  if (bHi <= bLo) return false;
  bandLo = bLo;
  bandHi = bHi;
  return true;
}

/**
 * A resolved threshold ladder: ascending `thresholds` (from
 * {@link normalizeThresholds}) paired with the `colors` each band draws in,
 * `colors[k]` for the band above `thresholds[k - 1]`. Assembled by `BarChart`
 * from `<BarChart bandColors>` → {@link BarStyle.bands}, so — like
 * {@link StackStyle} — the draw layer stays theme-free and unit-testable.
 *
 * `colors` is guaranteed `thresholds.length + 1` long by the time it reaches a
 * draw path; a short ladder is resolved (and warned about) at the boundary.
 */
export interface BandLadder {
  readonly thresholds: readonly number[];
  readonly colors: readonly string[];
}

/**
 * Validate + freeze a caller's threshold ladder once, at the prop boundary.
 * Returns the ascending, strictly-positive, finite breakpoints — or `null` when
 * there is no usable ladder left, so the caller keeps the flat path.
 *
 * Sorting rather than rejecting an out-of-order ladder is deliberate — the
 * bands are defined by their boundaries, so `[2, 1]` and `[1, 2]` describe the
 * same three bands and there is no second reading to guess at.
 *
 * Three kinds of entry are **dropped**:
 *
 * - **non-finite** — would swallow every band above it;
 * - **negative** — the ladder is walked on the *magnitude* and mirrored onto
 *   whichever side of zero the bar is on, so a negative breakpoint has no
 *   meaning. Left in, `[-2, -1]` silently clipped every lower band away and
 *   painted the whole bar in the final colour — a one-colour bar that looks
 *   deliberate (Codex adversarial review). Signed breakpoints are the
 *   asymmetric-ladder feature deferred in [PND-BANDBAR2], not this;
 * - **zero** — band 0 already starts at zero, so a `0` breakpoint describes an
 *   empty band and shifts every colour by one.
 *
 * Dropping rather than throwing matches how the rest of this prop behaves
 * (a short colour ladder degrades, it doesn't fail), and `BarChart` dev-warns
 * whenever normalization removed anything — a silently-ignored breakpoint is
 * the failure mode this whole feature exists to avoid.
 */
export function normalizeThresholds(
  thresholds: readonly number[] | undefined,
): readonly number[] | null {
  if (thresholds === undefined || thresholds.length === 0) return null;
  const clean = thresholds.filter((t) => Number.isFinite(t) && t > 0);
  if (clean.length === 0) return null;
  return clean.sort((a, b) => a - b);
}

/**
 * The narrowed selection / hover identity a **single-series** bar matches
 * against: the layer's series `id`, the sample's `key` (its `begin`), and — when
 * the series carries {@link BarSeries.marks} — the stable per-bar `mark`. The
 * single-series sibling of {@link StackMark}, which additionally carries the
 * stack's group `label` (a single-series bar has no group to disambiguate).
 */
export interface BarMark {
  readonly id: string;
  readonly key: number;
  readonly mark?: string;
}

/**
 * Does `m` identify the bar with stable identity `stable` and key `begin`?
 * The mark decides **only when both sides have one** — `m.mark` (the selection
 * names a bar) and `stable` (this series names its bars). Either missing falls
 * back to `m.key === begin`, so both of these keep working unchanged:
 *
 * - a selection with **no `mark`** — every controlled `selected={{ id, key }}`
 *   that predates this channel, against a series that now carries marks;
 * - a series with **no `marks`** — a hand-built {@link BarSeries} (tests, an
 *   outside caller assembling the view themselves).
 *
 * This is the `mark`-first rule {@link drawStacks} applies, with one deliberate
 * difference: it falls back on the **selection** carrying no mark, where
 * `drawStacks` falls back on the **series** carrying none. `drawStacks` can
 * switch on the series alone because only `categoryStack` produces marks and it
 * never had key-pinned consumers. Every reader-built bar series now carries
 * marks, so that unconditional switch would silently stop matching each shipped
 * key-pinned selection — key-pinning is the only selection bars ever had.
 */
function barMatches(
  m: BarMark | null,
  seriesId: string | undefined,
  stable: string | undefined,
  begin: number,
): boolean {
  if (m === null || m.id !== seriesId) return false;
  return m.mark !== undefined && stable !== undefined
    ? m.mark === stable
    : m.key === begin;
}

/**
 * Fill one rectangle per bar in `cs`, each spanning its key's `[begin, end]`
 * (inset by `gapPx`) from the resolved `baseline` to the value.
 *
 * A gap (non-finite value) is skipped — no bar, no zero-height sliver. A bar
 * matching the current `selection` (the layer's own series `id` — `seriesId`; a
 * no-id layer passes `undefined` and never matches — plus the bar's identity,
 * see {@link barMatches}) draws in the style's `highlight` colour **and
 * outlined**, so a click reads back on the canvas; a bar matching `hovered`
 * draws **without** the outline (a lighter "this bar is live" on pointer-over)
 * in the style's optional `hover` colour, or in `highlight` when the theme
 * doesn't set one; all others use the flat `fill`. Either live state fills at
 * **full opacity** — the resting `opacity` applies to resting bars only, and is
 * restored so it doesn't leak into later layers. A bar that is both selected
 * and hovered reads as **selected**.
 *
 * **Which identity.** A selection carrying a `mark` matches against the series'
 * stable per-bar name ({@link BarSeries.marks} — the sample's own axis key,
 * which the readers always supply); one without falls back to the sample `key`
 * (the bar's `begin`). The mark path is what lets a caller pin a bar on a
 * **point-keyed** series without re-deriving the neighbour-spaced span, since
 * there `begin` is not the sample's key but an edge computed from it.
 *
 * O(N) over the events, one fill (+ optional stroke) per bar, no per-bar
 * allocation beyond the rect tuple.
 *
 * **Per-bar fills (`binFills`):** an optional colour array aligned
 * index-for-index to the source bars — bar `i` fills with `binFills[i]`
 * (an `undefined` entry falls back to the flat `fill`). This is the
 * direction-coloured financial volume row (rising / falling) and the
 * value-band case on a time axis. Highlight follows {@link drawStacks}'s
 * binFills convention: the bar **keeps its own colour** under hover /
 * selection — the highlight pops `globalAlpha` to 1 (and outlines the
 * selection in the bar's own fill) — so a red / green bar stays red / green
 * while live, instead of swapping to the single `highlight` colour and losing
 * its meaning. (Both paths now pop to 1; what still differs is the *colour* —
 * the flat path swaps to `highlight`, this one keeps `binFills[i]`.)
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
 * always draw every bar. **`binFills` disables the envelope pass** — a single
 * envelope rect spans many differently-coloured bars, so decimating would
 * repaint them one flat colour; per-bar-coloured layers draw every visible bar.
 * Returns {@link LayerDrawStats} for `onDrawStats`.
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
  selection: BarMark | null,
  hovered: BarMark | null,
  decimate: DecimateOption = true,
  binFills?: readonly (string | undefined)[],
  banding?: BandLadder,
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
  // `{ threshold }` tunes the samples-per-pixel factor `k` (as line/area/band do);
  // `undefined` ⇒ decimateBars' default (2). Per-bar fills skip the envelope —
  // one flat rect can't carry many bars' colours (see the header) — but an
  // *empty* colour array is "no colours" (every bar would flat-fill anyway), so
  // it stays on the legacy path end-to-end (L2 review, PR #542).
  const fills =
    binFills !== undefined && binFills.length > 0 ? binFills : undefined;
  // A threshold ladder is per-*bar* colour too, so it takes the same exits as
  // `binFills`: no envelope pass (one rect can't carry a gradient), and it
  // yields to an explicit `binFills` when a caller sets both (warned about at
  // the prop boundary — the two are different answers to "what colour is this
  // bar", and per-bar is the more specific one).
  const ladder = fills === undefined ? banding : undefined;
  const k = typeof decimate === 'object' ? decimate.threshold : undefined;
  const envelope =
    decimate !== false && fills === undefined && ladder === undefined
      ? decimateBars(cs, xScale, ctx, baseline, k, vEnd - vStart)
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
  // The stable per-bar identity is consulted only when the live selection /
  // hover actually carries a `mark` — `cs.marks` builds its strings lazily, so
  // the *draw* never materializes them on its own. (The component's `hitTest`
  // may already have: an interactive layer echoes the hovered bar's mark on
  // every pointer move. See BarSeries.marks — this hoist keeps the draw path
  // clean, it doesn't make the channel free.)
  const marks =
    selection?.mark !== undefined || hovered?.mark !== undefined
      ? cs.marks
      : undefined;
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
    // Match by the series `id` **and** the bar's identity — its stable `mark`
    // when the selection carries one, else the sample `key` (begin) — so two
    // series sharing a timestamp don't both light up (a no-id, non-selectable
    // layer passes `seriesId === undefined` and never matches). The selection
    // takes `highlight` + the outline; the hover takes `hover` when the theme
    // sets one and `highlight` otherwise, always without the outline — so hover
    // reads as a lighter "this bar is live" and select as the committed pick.
    const stable = marks?.[i];
    const selected = barMatches(selection, seriesId, stable, cs.begin[i]!);
    const isHovered = barMatches(hovered, seriesId, stable, cs.begin[i]!);
    if (fills !== undefined) {
      // Per-bar fills: the bar keeps its own colour under hover / selection —
      // highlight pops the alpha to 1 and outlines the selection in the bar's
      // own fill (the drawStacks binFills convention; see the header).
      const fill = fills[i] ?? style.fill;
      ctx.globalAlpha =
        selected || isHovered ? (style.emphasisOpacity ?? 1) : style.opacity;
      ctx.fillStyle = fill;
      ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      drawn += 1;
      if (selected) {
        ctx.lineWidth = style.outlineWidth;
        ctx.strokeStyle = style.selectedOutline ?? fill;
        ctx.strokeRect(x0, yTop, x1 - x0, yBottom - yTop);
      }
      continue;
    }
    if (ladder !== undefined) {
      // Threshold banding: one rect per band the bar reaches, sharing the bar's
      // x-span and slicing its length at the ladder boundaries. Like `binFills`
      // the bar keeps its own colours when live (swapping to one `highlight`
      // would erase the very thing the bands encode) and pops the alpha
      // instead. The whole bar stays one hit target — see `bandSpan`.
      ctx.globalAlpha =
        selected || isHovered ? (style.emphasisOpacity ?? 1) : style.opacity;
      const v = cs.y[i]!;
      let topFill = ladder.colors[0]!;
      for (let bk = 0; bk < ladder.colors.length; bk += 1) {
        if (!bandSpanInto(baseline, v, ladder.thresholds, bk)) continue;
        const ySpanA = yScale(bandLo);
        const ySpanB = yScale(bandHi);
        const bandTop = ySpanA < ySpanB ? ySpanA : ySpanB;
        const bandBottom = ySpanA < ySpanB ? ySpanB : ySpanA;
        ctx.fillStyle = ladder.colors[bk]!;
        ctx.fillRect(x0, bandTop, x1 - x0, bandBottom - bandTop);
        topFill = ladder.colors[bk]!; // the band the value actually landed in
      }
      drawn += 1;
      if (selected) {
        // Outline the whole bar (not the last band) in the colour of the band
        // the value reached — the one colour that means something for a bar
        // painted in several.
        ctx.lineWidth = style.outlineWidth;
        ctx.strokeStyle = style.selectedOutline ?? topFill;
        ctx.strokeRect(x0, yTop, x1 - x0, yBottom - yTop);
      }
      continue;
    }
    // A hovered / selected bar pops to full opacity, as the binFills branch
    // above and `drawStacks` both do — without this the highlight *fill* drew
    // at the resting `style.opacity`, so on an alpha'd theme a hovered bar
    // (which has no outline) barely changed at all, and a selected one read
    // only by its outline (#576).
    ctx.globalAlpha =
      selected || isHovered ? (style.emphasisOpacity ?? 1) : style.opacity;
    // Three-step emphasis when the theme opts in with `hover`: rest → hover →
    // selected. Selection outranks hover on a bar that is both (as the outline
    // already did). With no `hover` colour this is the shipped two-step —
    // `highlight` for either state (see BarStyle.hover).
    ctx.fillStyle = selected
      ? style.highlight
      : isHovered
        ? (style.hover ?? style.highlight)
        : style.fill;
    ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
    drawn += 1;
    if (selected) {
      // The selected bar's outline. Already at alpha 1 from the fill above —
      // which also means it no longer separates select from hover the way it
      // used to: the stroke is `highlight` over a now-`highlight`, now-alpha-1
      // fill, so only the half-stroke falling outside the rect reads. A theme
      // that needs the two states clearly apart sets `BarStyle.hover` (#577);
      // the outline is the shape cue, not the whole signal.
      ctx.lineWidth = style.outlineWidth;
      ctx.strokeStyle = style.selectedOutline ?? style.highlight;
      ctx.strokeRect(x0, yTop, x1 - x0, yBottom - yTop);
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
 * The pixel rect of bar `i`'s **slot** — the region that *belongs* to the bar,
 * as opposed to the ink {@link barRect} puts on the canvas. It spans the key's
 * full `[begin, end]` in x (**no `gapPx` inset**) and the **whole plot height**
 * in y. `null` for a gap (non-finite value), which owns no slot to select.
 *
 * The distinction is the point: a bar *is* the full width of its interval, and
 * the drawing gap is a display affordance so adjacent columns read as discrete.
 * Hit-testing the drawn rect made that affordance interactive — the gap became
 * a dead channel you could point at and select nothing, and the empty plot
 * space above a short bar likewise. Slots tile the axis, so every x inside the
 * data range belongs to exactly one bar, which is what a column chart's hover
 * should feel like and what {@link barIndexAtTime} (the x-scrub cursor) has
 * always done.
 *
 * The plot's y extent is read from the `yScale`'s own domain, the same
 * localized shape {@link resolveBarBaseline} uses. When it isn't readable (a
 * bare test stub with no `.domain()`), this falls back to {@link barRect}'s
 * value→baseline span, so a scale-less caller keeps the old behaviour rather
 * than getting an unbounded hit region.
 *
 * `minWidthPx` still floors the span, so a lone point-keyed bar (zero-width
 * key) stays selectable.
 *
 * **Two consequences worth knowing before you compose with it.**
 *
 * 1. **It reaches across the whole plot height, so it can shadow layers below
 *    it.** `resolveSelection` returns the topmost hit, so a `<BarChart>`
 *    declared *after* a `<ScatterChart>` / `<BoxPlot>` / another `<BarChart>`
 *    in the same row now claims every hit inside its x-range, at any y — where
 *    the drawn-rect target only claimed the bar's own ink. Declare a bar layer
 *    **below** the marks you want to stay clickable (which is also the usual
 *    z-order for bars-as-context). No shipped story composes that way, so this
 *    is latent rather than a live regression.
 * 2. **Only the single-series vertical path uses it.** A stacked, `bins`,
 *    `categories` or horizontal `<BarChart>` hit-tests through
 *    {@link stackAt}, which still targets the drawn segment — a stack has to,
 *    since segments share a bin's x-range and only y tells them apart. So
 *    `<BarChart>` has two hit models; this is the one for a plain bar.
 */
export function barSlotRect(
  cs: BarSeries,
  i: number,
  xScale: Scale,
  yScale: Scale,
  baseline: number,
  minWidthPx: number,
): [x0: number, x1: number, yTop: number, yBottom: number] | null {
  const v = cs.y[i]!;
  if (!Number.isFinite(v)) return null;
  // Gap-free: the slot is the key's own span.
  const [x0, x1] = barSpanPx(cs.begin[i]!, cs.end[i]!, xScale, 0, minWidthPx);
  const d = (yScale as unknown as { domain?: () => number[] }).domain?.();
  // `< 2`, not `=== 0`: a one-element domain would make both endpoints the same
  // value, collapsing the slot to zero height and making the bar unhittable —
  // worse than the fallback it was meant to skip. (`resolveBarBaseline`'s
  // `=== 0` is fine because it clamps against min/max of the same endpoints.)
  if (!d || d.length < 2) {
    // No usable domain (a bare test stub): keep the drawn rect's y span.
    const yValue = yScale(v);
    const yBase = yScale(baseline);
    return [x0, x1, Math.min(yValue, yBase), Math.max(yValue, yBase)];
  }
  const yA = yScale(d[0]!);
  const yB = yScale(d[d.length - 1]!);
  return [x0, x1, Math.min(yA, yB), Math.max(yA, yB)];
}

/**
 * Hit-test plot-pixel `(px, py)` against `cs`'s bars — the **first** bar whose
 * **slot** contains the point, or `null`. The geometry is {@link barSlotRect}:
 * the bar's full interval width and the full plot height, *not* the drawn rect.
 * Pointing at the gap between two columns, or above a short one, selects the
 * bar whose slot you are in. The returned tuple is `[index, begin, value]` for
 * the chart to assemble a `SelectInfo` (it owns the colour + label); keeping
 * this layer free of the theme keeps it unit-testable without a `ChartTheme`.
 *
 * **Shared edges.** Contiguous bars meet exactly (`end[i] === begin[i+1]`) once
 * the gap is gone, and both ends are inclusive, so a point landing precisely on
 * the boundary matches **the left bar** — first match wins, the same rule
 * {@link barIndexAtTime} documents, so hover and the x-scrub cursor agree.
 *
 * A **gap** bar (non-finite value) owns no slot and is skipped, so hovering
 * where the data is missing selects nothing rather than a `NaN`.
 *
 * O(N) over the events (no spatial index — bar counts are view-scale, hundreds
 * not millions; click is a rare event).
 */
export function barAt(
  cs: BarSeries,
  px: number,
  py: number,
  xScale: Scale,
  yScale: Scale,
  baseline: number,
  minWidthPx: number,
): [index: number, begin: number, value: number] | null {
  for (let i = 0; i < cs.length; i += 1) {
    const rect = barSlotRect(cs, i, xScale, yScale, baseline, minWidthPx);
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
  /**
   * The **selected** segment's fill, and `hover` the pointer-over one — the
   * three-step `fill → hover → highlight` emphasis {@link BarStyle} has always
   * carried and this path used to ignore ([PND-CATEMPH]).
   *
   * **Only applied when there is no meaning-carrying colour to destroy**, i.e.
   * when {@link binFills} is unset. A per-bin-coloured bar keeps its own colour
   * and pops {@link emphasisOpacity} instead — swapping a zone-coloured or
   * direction-coloured bar to one highlight hue would erase what the colour
   * encodes, which is the one *design* exclusion rather than a path accident.
   *
   * The friction this closes wasn't the behaviour, which is defensible: it was
   * that `theme.bar.hover` / `.highlight` were typed, settable, documented as
   * the emphasis channel, and silently did nothing on the most common
   * categorical chart. A theme author set them, saw no change, and had no way
   * to tell whether they were wrong about the colour or about the mechanism.
   */
  readonly highlight?: string;
  /** See {@link highlight}. Falls back to `highlight` when unset. */
  readonly hover?: string;
  /**
   * Stroke for the selected segment's outline. Defaults to the segment's own
   * resolved fill (the shipped behaviour). Set it to give the category path a
   * themed selection cue that works even where the fill can't change — the
   * `binFills` case, where the alpha pop is otherwise the only signal.
   */
  readonly selectedOutline?: string;
  /**
   * The alpha a hovered / selected segment pops to. **Default `1`** (the
   * shipped behaviour). Lower it for a subtler emphasis on a dense stack —
   * previously the pop was hard-coded and the only tunable was the resting
   * {@link opacity}, so a theme could not adjust the *difference* between
   * resting and live, only the floor.
   */
  readonly emphasisOpacity?: number;
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
 * stack it is `[minNegTotal, maxPosTotal]` — each bin's positive segments summed
 * upward and its negative segments summed downward, tracked separately
 * ([PND-SIGNSTACK]). For a **single-group** series (`G === 1` — the plain /
 * categorical bar case) it spans the values' own `[min, max]`, so a **negative**
 * bar's floor is in the domain (segments below the baseline stay visible). `0` is
 * always pulled in so the bars rest on a visible baseline (the bar analog of
 * {@link barExtent}). An empty / all-gap series returns `[0, 1]` so the axis still
 * has a usable domain. Feeds the y auto-fit for a vertical histogram, the x
 * auto-fit for a horizontal one.
 *
 * The negative half is new: this used to sum only positives, matching a draw
 * path that dropped negative segments outright. Both halves changed together —
 * an extent that stopped at `0` below would clip the very segments the draw
 * path now emits.
 */
export function stackValueExtent(ss: StackedBarSeries): [number, number] {
  const G = ss.groups.length;
  let max = 0;
  let min = 0;
  for (let b = 0; b < ss.length; b += 1) {
    let cumPos = 0;
    let cumNeg = 0;
    for (let g = 0; g < G; g += 1) {
      const v = ss.values[b * G + g]!;
      if (!Number.isFinite(v)) continue;
      if (G === 1) {
        // Single-group: a bar honours its sign, so track both ends.
        if (v > max) max = v;
        if (v < min) min = v;
      } else if (v > 0) {
        cumPos += v; // True stack: positives stack up from the baseline…
      } else if (v < 0) {
        cumNeg += v; // …negatives stack down from it.
      }
    }
    if (cumPos > max) max = cumPos;
    if (cumNeg < min) min = cumNeg;
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
 * The value a stack's **first** segment rests on, in data units — the same
 * `0`-clamped-into-the-domain rule {@link resolveBarBaseline} applies to a plain
 * bar, read off whichever scale carries the stacked value (`yScale` when the
 * bars grow up, `xScale` when they grow right).
 *
 * Both stack walks used to start at a literal `0`, which is right only while the
 * domain contains zero — and a **log** domain never can. `yScale(0)` on a log
 * scale is `NaN`, `fillRect` with a `NaN` argument is a silent canvas no-op, and
 * the same rect feeds {@link stackAt} — so the bottom segment of every stack
 * both vanished *and* became unhittable, with nothing to see but a stack that
 * starts one segment up. The linear case is unaffected: the value extents pull
 * `0` into the domain, so this returns exactly `0` and the geometry is
 * unchanged.
 */
export function stackBase(
  orientation: Orientation,
  xScale: Scale,
  yScale: Scale,
): number {
  return resolveBarBaseline(orientation === 'vertical' ? yScale : xScale);
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
  // hit-tested). **Negative segments are kept, whatever `G` is** — the caller
  // passes the downward running total for them (see {@link drawStacks}), and
  // the `Math.min/Math.max` below normalizes the below-baseline rect.
  //
  // A multi-group stack used to drop them here (`v < 0 && G > 1`) on the
  // grounds that "stacking a negative segment is undefined". That is fair for a
  // conventional stack and wrong for the **signed stacked histogram** — several
  // series per bin whose values may be either sign, positives stacking up from
  // a zero line and negatives down from it (net flow by category,
  // inflow/outflow, buy/sell pressure by venue). That is a well-defined stack:
  // two running totals per bin instead of one. And the old behaviour failed
  // *silently* — the dropped segments didn't clamp, warn or throw, so every
  // remaining segment stacked up as though they had never been in the data and
  // a mixed-sign series rendered as a confident, wrong, all-positive chart
  // ([PND-SIGNSTACK]).
  if (!Number.isFinite(v) || v === 0) return null;
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
  banding?: BandLadder,
): void {
  const G = ss.groups.length;
  const base = stackBase(orientation, xScale, yScale);
  // Threshold banding applies to a **plain** bar only. `G === 1` is exactly the
  // categorical / horizontal single-value bar (`categoryStack` builds a
  // one-group series); a genuine multi-group stack has no defined banding —
  // each segment is already a slice of a total — so the ladder is dropped here
  // and warned about at the prop boundary rather than half-applied.
  const ladder = G === 1 && style.binFills === undefined ? banding : undefined;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  for (let b = 0; b < ss.length; b += 1) {
    // Two running totals per bin ([PND-SIGNSTACK]): positives stack upward from
    // the baseline, negatives downward from it. A conventional all-positive
    // stack never touches `cumNeg`, so its geometry is bit-identical to before.
    let cumPos = base;
    let cumNeg = base;
    for (let g = 0; g < G; g += 1) {
      const v = ss.values[b * G + g]!;
      const rect = segmentRect(
        ss,
        b,
        g,
        orientation,
        xScale,
        yScale,
        v < 0 ? cumNeg : cumPos,
        gapPx,
        minSpanPx,
      );
      if (Number.isFinite(v)) {
        if (v > 0) cumPos += v;
        else if (v < 0) cumNeg += v;
      }
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
      // A hovered / selected segment pops its alpha; a resting one draws at the
      // shared one. `emphasisOpacity` makes the *difference* themeable, where
      // before only the resting floor was.
      ctx.globalAlpha =
        selected || isHovered ? (style.emphasisOpacity ?? 1) : style.opacity;
      // A per-bin colour (the single-series band case) overrides the group fill.
      const fill = style.binFills?.[b] ?? style.fills[g]!;
      if (ladder !== undefined) {
        // Threshold banding on the plain / categorical / horizontal bar: slice
        // the bar's length at the ladder boundaries, transposing on
        // orientation — vertical bars band along y, horizontal along x, while
        // the bin span (the other axis) is shared by every band.
        let topFill = ladder.colors[0]!;
        for (let bk = 0; bk < ladder.colors.length; bk += 1) {
          if (!bandSpanInto(base, v, ladder.thresholds, bk)) continue;
          ctx.fillStyle = ladder.colors[bk]!;
          if (orientation === 'vertical') {
            const a = yScale(bandLo);
            const c = yScale(bandHi);
            const top = a < c ? a : c;
            ctx.fillRect(x0, top, x1 - x0, (a < c ? c : a) - top);
          } else {
            const a = xScale(bandLo);
            const c = xScale(bandHi);
            const left = a < c ? a : c;
            ctx.fillRect(left, yTop, (a < c ? c : a) - left, yBottom - yTop);
          }
          topFill = ladder.colors[bk]!;
        }
        if (selected) {
          ctx.lineWidth = style.outlineWidth;
          // A themed outline if the theme sets one, else the band the value
          // reached — the one colour that means anything on a banded bar.
          ctx.strokeStyle = style.selectedOutline ?? topFill;
          ctx.strokeRect(x0, yTop, x1 - x0, yBottom - yTop);
        }
        continue;
      }
      // [PND-CATEMPH] The themed three-step emphasis, applied where it can be:
      // with no `binFills` there is no meaning-carrying colour to destroy, so a
      // selected segment takes `highlight` and a hovered one `hover`, exactly
      // as the single-series path does. With `binFills` the bar keeps its own
      // colour (the design exclusion) and the alpha pop above is the signal.
      const emphasised =
        style.binFills === undefined
          ? selected
            ? (style.highlight ?? fill)
            : isHovered
              ? (style.hover ?? style.highlight ?? fill)
              : fill
          : fill;
      ctx.fillStyle = emphasised;
      ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      if (selected) {
        ctx.lineWidth = style.outlineWidth;
        ctx.strokeStyle = style.selectedOutline ?? emphasised;
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
  const base = stackBase(orientation, xScale, yScale);
  for (let b = 0; b < ss.length; b += 1) {
    // The same two accumulators `drawStacks` keeps — they must agree exactly or
    // the hit rect drifts from the drawn one.
    let cumPos = base;
    let cumNeg = base;
    for (let g = 0; g < G; g += 1) {
      const v = ss.values[b * G + g]!;
      const rect = segmentRect(
        ss,
        b,
        g,
        orientation,
        xScale,
        yScale,
        v < 0 ? cumNeg : cumPos,
        gapPx,
        minSpanPx,
      );
      if (Number.isFinite(v)) {
        if (v > 0) cumPos += v;
        else if (v < 0) cumNeg += v;
      }
      if (rect === null) continue;
      const [x0, x1, yTop, yBottom] = rect;
      if (px >= x0 && px <= x1 && py >= yTop && py <= yBottom) {
        return [b, g, ss.begin[b]!, ss.groups[g]!, v];
      }
    }
  }
  return null;
}
