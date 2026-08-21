import { useContext, useEffect, useMemo, useRef } from 'react';
import {
  ContainerContext,
  RowContext,
  type AxisSpec,
  type YScale,
} from './context.js';
import { resolveAxisFormat, type AxisFormat } from './format.js';
import { unpadDomain } from './domain.js';
import { useSlotKey } from './use-slot-key.js';
import { tickValues } from './yticks.js';
import {
  axisMouseProps,
  axisPointerPx,
  type AxisMouseHandler,
} from './axis-events.js';
import { useAxisGestures } from './use-axis-gestures.js';
import { zoomRange } from './viewport.js';

/**
 * Clamp on a gutter drag's own zoom factor. Unlike the container's uniform
 * transform (floored at `k ≥ 1` so a plot gesture can't zoom every axis out into
 * blank canvas) an axis you deliberately grabbed may squash as well as stretch —
 * `k < 1` widens the domain, which costs nothing. The bounds exist only so a
 * flick of the wheel can't strand the axis at a factor no further gesture can
 * recover from.
 */
const MIN_AXIS_K = 0.02;
const MAX_AXIS_K = 50;
/** The un-grabbed transform — also what clears an axis's entry (see `ChartRow`). */
const IDENTITY_TRANSFORM = { k: 1, ty: 0 } as const;

export interface YAxisProps {
  /** Identifier a chart links to via its `axis` prop (and the first declared is
   *  the row's default). */
  id: string;
  /**
   * Which side of the plot the gutter sits on. Author left axes *before*
   * `<Layers>` in JSX and right axes *after* — the row lays children out in
   * order. Default `left`.
   */
  side?: 'left' | 'right';
  /** Display label / unit (e.g. `bpm`); defaults to `id`. */
  label?: string;
  /**
   * How the axis title (`label`) is drawn:
   * - **`'rotated'` (default)** — a thin vertical strip down the outer edge
   *   (the standard y-axis convention; fits long labels in a narrow gutter).
   * - `'top'` — horizontal, at the top of the axis, aligned to its side. Reads
   *   better for short unit labels; keep it terse and pair it with a domain
   *   that has headroom (auto-fit / padded) so it doesn't crowd the top tick.
   */
  labelPlacement?: 'rotated' | 'top';
  /**
   * Which scale the axis maps its domain through. **Default `'linear'`.**
   *
   * `'log'` gives a base-10 logarithmic axis — for data spanning orders of
   * magnitude, where a linear axis flattens everything below the top decade
   * onto the baseline. Ticks land on the decades, and `format` still formats
   * the **value**, so a readout says `1.2 PB`, not its logarithm.
   *
   * A log domain cannot contain zero or negative numbers — d3 maps them to
   * `NaN`, which has no position on the plot. So:
   *
   * - **Auto-fit ignores non-positive extents** when picking the low end (a
   *   `BarChart`, whose extent always reaches zero so its bars can meet their
   *   baseline, can therefore share the axis), and rounds the domain out to
   *   whole powers of ten.
   * - **An explicit `min`/`max` that is not positive is refused**, and that
   *   side auto-fits instead. A positive bound is always honoured exactly; when
   *   only one side is given and the domain would invert, the *auto* side moves
   *   — the same policy a linear axis follows.
   * - **Layers that fill to a baseline** (`AreaChart`, `BarChart`, a stacked
   *   histogram) rest it on the bottom of the domain rather than on zero.
   * - **A value with no position gaps the line**, rather than its neighbours
   *   being joined straight across it.
   *
   * A dev-mode warning fires for the cases that are unambiguously a mistake: a
   * refused bound, negative data, or an axis with no positive data at all.
   *
   * `'symlog'` is **linear through zero, logarithmic beyond** — for data that
   * spans orders of magnitude *on both sides of zero*, which `'log'` cannot
   * express at all (it admits no zero and no negatives). The linear window is
   * {@link linearWindow}. Because it admits zero, it resolves its domain on the
   * ordinary **linear** path: no positive-only bound refusal, no rounding out to
   * decades, no gapping of non-positive samples.
   *
   * **The axis owns tick placement, and that is the substance of the feature.**
   * d3's symlog supplies the transform but ticks it *linearly*, which on a ±1M
   * domain with a 20k knee labels nothing below the knee — the exact region the
   * scale was chosen to reveal. pond grids it on zero, the knee (±`linearWindow ×
   * maxAbs`) and mirrored decades beyond, thinned by the same rule the log axis
   * uses. See `yticks.ts`.
   *
   * **The curve is `log1p`, not piecewise — read this before replacing a
   * hand-rolled one.** "Linear through zero, logarithmic beyond" describes how the
   * axis *reads*, not two joined segments: `scaleSymlog` is the single smooth
   * `sign(x) · log1p(|x / knee|)`, so there is no exact boundary at which one law
   * stops and the other starts. A common hand-rolled curve *is* piecewise —
   * exactly linear below the knee, `log10` above — and the two are the same family
   * with materially different shape. Swapping one for the other, a reporting
   * consumer measured small values landing at **roughly half** their former height
   * (a ±9M domain: 283k went from 0.44 to 0.24 of the half-plot above the zero
   * line), while order, the dominance of the tail, and a several-fold lift over a
   * linear axis all held — the chart still says the same thing, but it does not
   * say it identically.
   *
   * **No `linearWindow` recovers a piecewise shape.** The same consumer tried: a
   * smaller window fits the large values while overshooting the small ones about
   * 2×, because the difference is the curve, not the knee. If you need the
   * piecewise curve exactly, you need your own transform — which is the thing this
   * scale exists to let you delete, so weigh that before reaching for it.
   */
  scale?: 'linear' | 'log' | 'symlog';
  /**
   * `scale="symlog"`'s **linear window**, as a fraction of the domain's largest
   * magnitude. **Default `0.02`** — the knee sits at 2% of `maxAbs`, so a ±1M
   * domain is linear through ±20k and logarithmic beyond. Ignored on any other
   * scale.
   *
   * **Domain-relative, not absolute** (d3's own `constant` is absolute). A chart
   * that re-keys to the largest magnitude on every update would otherwise need
   * the constant recomputed each tick, and would drift silently the moment
   * someone forgot — the fraction survives a domain change with no call-site
   * arithmetic at all.
   *
   * Precisely: a fraction of the **resolved domain before any pan/zoom** — the
   * one the axis's `min`/`max`/`pad`/auto-fit produce. A 2-D gesture is carried
   * as a *pixel* transform and the knee is deliberately **not** recomputed from
   * the zoomed window, so zooming moves the plot without moving the boundary
   * between the two régimes underneath it. (Recomputing would make the same
   * datum linear at one zoom level and logarithmic at the next.)
   *
   * A value outside `(0, 1]` cannot be a knee; the axis draws with the default
   * instead and dev-warns which window is in force.
   */
  linearWindow?: number;
  /** Explicit domain bounds; omit to auto-fit the charts linked to this axis. */
  min?: number;
  max?: number;
  /**
   * Fractional headroom added to each side of the resolved domain — `0` (the
   * default) means none. Lifts a tight domain off the plot edges without
   * hand-computing bounds (e.g. `pad={0.05}` adds 5% of the span top & bottom).
   * Applies to an explicit `[min, max]` or an auto-fit domain.
   */
  pad?: number;
  /**
   * Value formatting for the tick labels (and the cursor readout, which matches):
   * a d3 format specifier string (e.g. `'.0%'`, `',.2f'`) or a `(value) => string`
   * function. Omit for the scale's d3 default — which is calibrated to the tick
   * step, so a between-ticks readout rounds to tick precision; pass a specifier
   * (e.g. `',.2f'`) when you want finer readout precision. See {@link AxisFormat}.
   *
   * **Live charts:** a string specifier is value-compared, so an inline
   * `format='.0%'` is safe every render. An inline `format={(v) => …}` **function**
   * is a fresh reference each render — the one axis prop a structural guard can't
   * value-compare — so on a frequently re-rendering (e.g. scrub-driven) chart,
   * hoist it or wrap it in `useCallback`, or it re-registers the axis each frame.
   */
  format?: AxisFormat;
  /**
   * Explicit ticks — `{ at, label }` in axis-value units — instead of the
   * scale's automatic ticks, driving BOTH the labels and the row's gridlines so
   * the two align. The y-axis counterpart of `<XAxis ticks>` (same shape): the
   * lever for a non-uniform axis like pace, where the caller chooses round-pace
   * positions and their own `m:ss` labels (`{ at: -300, label: '5:00' }`). `at`
   * values outside `[min, max]` extrapolate off-plot (the scale does not clamp).
   * Pass `[]` to draw none. The array is **value-compared on registration**, so an
   * inline `ticks={[…]}` (or `ticks={[]}`) with unchanged contents no longer
   * re-registers the axis — only genuinely changed tick positions do. (An inline
   * `format` *function* still needs hoisting; see `format`.)
   */
  ticks?: ReadonlyArray<{ readonly at: number; readonly label: string }>;
  /**
   * Target number of **auto** ticks — the `count` passed to `scale.ticks()`
   * (d3 returns nice 1-2-5 values near it, not exactly this many). **Omitted ⇒
   * derived from the row height** so a short strip isn't crushed with a tall
   * row's density (mirrors the width-derived x axis). Ignored when explicit
   * {@link ticks} are given (those set both labels and gridlines directly).
   */
  tickCount?: number;
  /**
   * Render the tick labels at the domain extremes (the top & bottom ticks)?
   * **Default `true`.** `false` drops just those two numbers — the gridlines
   * stay — for when the min/max labels crowd a stacked row's edges and you'd
   * rather omit them than keep them. (Extreme labels are otherwise clamped to
   * stay inside the row, never overflowing the edge.)
   */
  boundaryLabels?: boolean;
  /** Gutter width in CSS pixels (default 50). */
  width?: number;
  /**
   * **Keep the scale, draw no gutter.** The axis still registers its domain
   * (`min`/`max`/`scale`/`pad`) and layers still bind to it by `id`, but it
   * renders nothing and reserves **no width** — the plot gets the space.
   *
   * A `<YAxis>` does two jobs: it *holds the scale* and it *renders a gutter*.
   * Without this there was no way to ask for the first without the second, so a
   * chart with a **fixed** domain whose scale is already explained by its
   * chrome (threshold band lines, a legend, a panel header) had two reachable
   * options and needed a third:
   *
   * | | auto domain | explicit domain |
   * |---|---|---|
   * | **gutter** | `<YAxis />` | `<YAxis min max />` |
   * | **no gutter** | omit the axis | ← this prop |
   *
   * Omitting the axis is not the same thing: the row then supplies an implicit
   * auto-domain axis, and the fixed domain is exactly what must not be given
   * up. `width={0}` is not it either — the labels still draw, now over the
   * plot.
   *
   * **Gridlines are unaffected.** They belong to the plot, not the gutter, and
   * `<ChartContainer grid>` already controls them — so a hidden axis can still rule
   * its own gridlines, which is usually what a "the shape matters, the numbers
   * don't" chart wants. Turn them off there if you want neither.
   */
  hide?: boolean;
  /**
   * This axis instance's colour — tick labels and the axis title take it,
   * overriding the theme's `axis.label` / `axis.title.color`. The multi-axis
   * convention of colouring each y axis to match its series (`color`
   * matching the layer's) — busy, but standard. Omit for the theme's axis
   * colours.
   *
   * **Also worn by the axis-edge chrome that lands on this axis** — a
   * `<CrosshairCursor>`'s value pill takes it when the reticle reads a series
   * scaled here, so with several axes the pill says *which* scale the number is
   * on (the ChartIQ price-tag convention). That is why it rides on the
   * registered spec: the pill is drawn by the row's cursor overlay, not by this
   * component, so a colour it never registered could not reach it.
   */
  color?: string;
  /**
   * Mouse events on this axis's gutter, with the **axis value under the
   * pointer** ({@link AxisMouseHandler}, whose `AxisMouseEvent` payload carries it) — a click reports the value it landed
   * on, and this axis's `id`, so one handler can serve several axes. The lever
   * for axis-driven UI: set a threshold by clicking the gutter, open a scale
   * menu (`event.type === 'contextmenu'`), drill into a categorical row.
   *
   * **One handler takes every mouse event** — click, double-click, context
   * menu, down/up, move, enter, leave — so switch on `event.type`. Nothing is
   * attached when the prop is omitted, so the move events cost nothing unless
   * you ask for them. A `hide`den axis draws no gutter and so fires nothing.
   *
   * A gutter that also zooms (see the component docs) still reports every event
   * here, minus the trailing `click` a zoom drag would otherwise synthesize.
   */
  onMouseEvent?: AxisMouseHandler;
  /**
   * A gutter gesture scaled this axis — **the "auto vs manual" hand-off.**
   * Fires with the `[min, max]` **bounds** the gesture arrived at, and with
   * `null` when the axis is released back to auto-fit (double-click).
   *
   * Named for bounds rather than the domain because that is what it reports: with
   * a `pad` set, the visible domain is these bounds *plus* the padding, and it is
   * the bounds you hand back as `min`/`max`.
   *
   * The common shape this exists for: an auto-fitting y axis on a chart whose x
   * is panned and zoomed. The moment the user scrolls or drags the y gutter they
   * have overridden the fit, and a UI usually wants to *say* so — show the
   * resulting min/max, mark the scale "manual", and offer a toggle back to auto
   * (which is the same thing double-clicking the gutter does).
   *
   * ```tsx
   * const [scale, setScale] = useState<[number, number] | null>(null); // null = auto
   * <YAxis
   *   id="price"
   *   {...(scale ? { min: scale[0], max: scale[1] } : {})}
   *   onBoundsChange={setScale}
   * />
   * ```
   *
   * **Providing it makes the axis controlled**, exactly as `onTimeRangeChange`
   * does for the x view: the gesture then only *reports*, and what the axis draws
   * is whatever `min`/`max` you feed back. Omit it and the axis holds the zoom
   * itself (an internal per-axis transform) — which is the standalone behaviour,
   * and why a chart with no scale UI needs no wiring at all.
   *
   * The reported pair is in data units, ready to hand straight back as
   * `min`/`max`.
   *
   * **`scale="symlog"` is approximate on this path, by construction.**
   * {@link linearWindow} is a fraction of the *domain*, so bounds fed back
   * re-derive the knee and reshape the curve — the grabbed pixel cannot be held
   * on a curve that moves with the bounds. (It is the same fact that makes
   * `linearWindow` deliberately *not* recompute under a 2-D gesture.) The zoom is
   * still monotone and well-behaved; if you need the pixel held exactly on a
   * symlog axis, leave this callback off and let the axis hold the zoom itself,
   * where the knee stays anchored to the resolved domain. With an active plot-level y zoom (`panZoom="panZoomY"`/`"panZoomXY"`)
   * the two **compose**: the bounds are the axis's own, and the plot transform
   * still narrows what is drawn on top of them. On a `log` axis it stays positive (the zoom is done in log
   * space), so it is always a domain the axis can actually draw.
   */
  onBoundsChange?: (bounds: readonly [number, number] | null) => void;
  /**
   * @internal Declaration position among the row's children, injected by
   * `ChartRow` so the first-declared axis stays the default. Do not set.
   */
  index?: number;
}

const DEFAULT_WIDTH = 50;
/** Fallback tick count before the row has published its resolved count (the
 *  first render, pre-registration). The row's height-derived value takes over
 *  immediately after. */
const DEFAULT_TICK_COUNT = 5;

/**
 * A y-axis for a {@link ChartRow}, rendered as DOM chrome (not canvas) so the
 * text is crisp, themeable, and accessible. Registers its id / side / width /
 * domain with the row, which reserves the gutter (shrinking `plotWidth`) and
 * computes this axis's scale from the charts linked to it; the gutter then draws
 * tick marks + labels from that scale. Charts attach via `<LineChart axis="id">`
 * (default: the first axis).
 *
 * **Gestures.** With `<ChartContainer axisPanZoom="y">` (or `"xy"`) the gutter is
 * grabbable: drag or wheel it to scale **this axis only**
 * — a sibling axis on the other side, and every other row, hold still — and
 * double-click to release it back to its fit. That per-axis scaling is what the
 * plot's vertical gesture deliberately cannot do; see
 * {@link RowFrame.axisTransforms}. Report it to a scale UI with
 * {@link YAxisProps.onBoundsChange}.
 */
export function YAxis({
  id,
  side = 'left',
  label,
  scale = 'linear',
  linearWindow,
  min,
  max,
  format,
  ticks,
  tickCount,
  pad = 0,
  boundaryLabels = true,
  width = DEFAULT_WIDTH,
  hide = false,
  labelPlacement = 'rotated',
  color,
  onMouseEvent,
  onBoundsChange,
  index = 0,
}: YAxisProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<YAxis> must be rendered inside a <ChartContainer>');
  }
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error('<YAxis> must be rendered inside a <ChartRow>');
  }

  const spec = useMemo<AxisSpec>(
    () => ({
      id,
      side,
      // A hidden axis reserves no gutter — the row's slot placement reads this
      // width, so zeroing it here is what gives the space back to the plot.
      // Everything else about the spec is unchanged: the domain still resolves
      // and layers still bind to it, which is the whole point of the prop.
      width: hide ? 0 : width,
      scale,
      linearWindow,
      min,
      max,
      pad,
      labelPlacement,
      format,
      tickValues: ticks?.map((t) => t.at),
      tickCount,
      color,
      index,
    }),
    [
      id,
      side,
      width,
      hide,
      scale,
      linearWindow,
      min,
      max,
      pad,
      labelPlacement,
      format,
      ticks,
      tickCount,
      color,
      index,
    ],
  );
  // A stable per-instance slot (see useSlotKey) keeps this axis in a fixed
  // registry position, so a min/max/side change updates in place rather than
  // re-appending (which would move the first axis behind a later one and
  // silently rebind the row's default-axis charts).
  const slot = useSlotKey();
  const { registerAxis, unregisterAxis, applyAxisTransform } = row;
  // Unregister on unmount only (deps are stable, so cleanup never runs early).
  useEffect(
    () => () => {
      unregisterAxis(slot);
      // Drop any gutter zoom with the axis. The row keys transforms by axis id
      // (as it keys scales), so an entry left behind would be inherited by a
      // later axis that happens to reuse the id.
      applyAxisTransform(id, IDENTITY_TRANSFORM);
    },
    [unregisterAxis, slot, applyAxisTransform, id],
  );
  // Register on mount + update in place on every spec change — no reorder.
  useEffect(() => {
    registerAxis(slot, spec);
  }, [registerAxis, slot, spec]);

  // The transform this axis held at the last press — an UNCONTROLLED pan is
  // anchored on it (see `onPan`), the same way the x strip anchors on
  // `container.timeRange`.
  const panStartRef = useRef<{ k: number; ty: number } | null>(null);
  // The base scale at the last press, for a CONTROLLED pan. Snapshotted for the
  // same reason: a controlled consumer writes `min`/`max` back after every
  // move, so `row.baseYScales` on the *next* move already reflects this drag's
  // own effect — reading it fresh would compose the total delta onto a base
  // that has already moved, doubling every step's shift.
  const panBaseRef = useRef<YScale | null>(null);
  // Drag pans, wheel zooms **this** axis, double-click releases it back to the
  // row's own fit — the same gesture vocabulary the x strip uses, so a gutter
  // and the canvas agree on what a drag does. Enabled by the container's
  // `panZoom` zoom-y degree of freedom. The gesture writes this axis's entry in
  // `row.axisTransforms`, so only the gutter you grabbed moves — the sibling
  // axis, and every other row, hold still (see `RowFrame.axisTransforms` for
  // why that needs its own transform).
  const gestures = useAxisGestures({
    axis: 'y',
    // Gated on `<ChartContainer axisPanZoom>` (its `'y'` / `'xy'` values) — the
    // axis opt-in, deliberately independent of the plot's `panZoom`. That is what
    // lets the canonical setup work — an auto-fitting y on a chart whose *x* is
    // panned and zoomed — without either inheriting gestures silently or opting
    // the plot into vertical drags (a different feature: the uniform 2-D
    // transform a scatter or heat map wants).
    drag: container.axisPanZoomY ? 'pan' : 'none',
    wheel: container.axisPanZoomY,
    // Snapshot the transform (uncontrolled) or the base scale (controlled) at
    // press: the pan is re-derived from one of these on every move (the x
    // strip's own approach), so a long drag can't accumulate rounding — and,
    // for the controlled path, can't compose the total delta onto a base that
    // this same drag's own previous move already shifted.
    onDragStart: () => {
      panStartRef.current = row.axisTransforms.get(id) ?? IDENTITY_TRANSFORM;
      panBaseRef.current = row.baseYScales.get(id) ?? null;
    },
    onPan: (totalDeltaPx) => {
      if (onBoundsChange !== undefined) {
        // **Controlled**: shift the pixel window by the drag, same pixel-space
        // inversion `onZoom` uses so the maths stays correct on `log` and
        // `symlog` — a pan is just a zoom with every pixel shifted by the same
        // amount rather than scaled about a pivot. Read from the *press-time*
        // base, not the live one: `min`/`max` come back through this axis's own
        // props after every move, so the live base already carries however far
        // this drag has gone so far, and re-deriving the total delta against it
        // would double-apply everything already reported.
        const base = panBaseRef.current;
        if (base === null) return;
        const [r0, r1] = base.range() as [number, number];
        const at = (px: number) => +base.invert(px - totalDeltaPx);
        const next: readonly [number, number] = [at(r0), at(r1)];
        if (!Number.isFinite(next[0]) || !Number.isFinite(next[1])) return;
        if (next[0] === next[1]) return;
        onBoundsChange(unpadDomain(next, pad, scale));
        return;
      }
      // **Uncontrolled**: shift this axis's own pixel transform. Anchored on
      // the press's `panStartRef`, not the live `row.axisTransforms` value —
      // reading that fresh on every move would double-apply everything moved
      // so far this drag.
      const start = panStartRef.current ?? IDENTITY_TRANSFORM;
      applyAxisTransform(id, { k: start.k, ty: start.ty + totalDeltaPx });
    },
    onZoom: (factor, pivotPx) => {
      // Read the scale at gesture time, not from the render that built this
      // closure — a wheel notch mid-stream must compose onto what is drawn now.
      if (onBoundsChange !== undefined) {
        // **Controlled**: report the bounds the gesture reached and draw nothing
        // ourselves — `min`/`max` coming back is what moves the axis.
        //
        // Computed by inverting through the scale in **pixel** space, not by
        // affine arithmetic on its domain. That is what makes it correct on every
        // scale kind: `log` and `symlog` are not affine in value space, so
        // zooming their domain numerically drifts the grabbed pixel (visibly, on
        // symlog, whose knee is re-derived from the domain each time) and can
        // overflow to `[0, Infinity]` on a hard log zoom-out.
        //
        // Read from `baseYScales` — the axis's *resolved* scale, before the
        // container's uniform `yTransform` and this axis's own transform. The
        // consumer's `min`/`max` live in that space, so reporting a value read
        // off the visible scale would have the transforms applied to it twice.
        const base = row.baseYScales.get(id);
        if (base === undefined) return;
        const [r0, r1] = base.range() as [number, number];
        const lo = Math.min(r0, r1);
        const hi = Math.max(r0, r1);
        // Clamp into the scale's own range, not the gutter box: a
        // `labelPlacement="top"` row reserves a header, so a press up there would
        // otherwise pivot about a value the axis never draws.
        const pivot = Math.max(lo, Math.min(hi, pivotPx));
        // `factor` scales the visible span, so the pixel window scales by its
        // reciprocal about the pivot.
        const at = (px: number) => +base.invert(pivot + (px - pivot) * factor);
        const next: readonly [number, number] = [at(r0), at(r1)];
        // Orientation is preserved rather than required: `resolveYDomain` keeps
        // an explicit `[max, min]` as a deliberate axis flip, and rejecting
        // descending results would have made adding this callback silently
        // disable the gesture on a flipped axis.
        if (!Number.isFinite(next[0]) || !Number.isFinite(next[1])) return;
        if (next[0] === next[1]) return;
        // `pad` is applied last and to explicit bounds too, so the resolved
        // domain already includes it; handing that back would re-pad it and
        // inflate the axis by `1 + 2·pad` per notch (see `unpadDomain`).
        onBoundsChange(unpadDomain(next, pad, scale));
        return;
      }
      // **Uncontrolled**: hold the zoom ourselves as this axis's own pixel
      // transform. Read at gesture time for the same reason the scale is: two
      // wheel notches inside one frame both see the render-scope value, so the
      // second would compose onto the first's *input* and the notch be lost.
      const own = row.axisTransforms.get(id) ?? IDENTITY_TRANSFORM;
      // Same range clamp as the controlled path: keep the pivot on the scale.
      const visible = row.yScales.get(id);
      const vr = (visible?.range() ?? [0, 0]) as [number, number];
      const pivot = Math.max(
        Math.min(vr[0], vr[1]),
        Math.min(Math.max(vr[0], vr[1]), pivotPx),
      );
      // `factor` scales the domain span, so its reciprocal is the pixel-space
      // zoom — the relationship the plot's wheel handler uses.
      const z = 1 / factor;
      const nk = Math.min(MAX_AXIS_K, Math.max(MIN_AXIS_K, own.k * z));
      // Re-derive the zoom the clamp actually allowed, so a gesture held at a
      // limit stops moving the pivot too (rather than sliding the axis).
      const zEff = own.k === 0 ? 1 : nk / own.k;
      applyAxisTransform(id, {
        k: nk,
        // Zoom about the grabbed pixel: p' = pivot + (p − pivot)·z, expanded
        // through the existing transform p = ty + k·base. No pan clamp here —
        // the plot's exists to stop zoomed content sliding off the canvas, and
        // this transform is applied by narrowing the domain, so there is no
        // canvas to leave.
        ty: pivot * (1 - zEff) + own.ty * zEff,
      });
    },
    // Back to auto: `null` tells a controlled consumer to drop its override (the
    // same thing their "manual → auto" toggle does), and an uncontrolled axis
    // drops its own transform.
    onReset: () => {
      if (onBoundsChange !== undefined) onBoundsChange(null);
      else applyAxisTransform(id, IDENTITY_TRANSFORM);
    },
  });

  // `hide`: everything above still runs — the axis is registered, so its scale
  // exists and layers bind to it — and everything below (the gutter chrome)
  // does not. Placed after the last hook so the early return can't change hook
  // order when `hide` is toggled at runtime.
  //
  // It renders an **empty box at the reserved slot width**, not nothing. The
  // container reserves each axis *column* at the widest across rows
  // (`maxSlotWidths`), so a hidden axis sharing a column with a visible one in
  // another row is still allotted that column's width — and drawing nothing
  // there slides this row's plot left, out of line with its siblings and with
  // the shared x-axis. When this axis is alone in its column the reservation is
  // its own `width: 0`, the box is zero-wide, and the plot reclaims the space,
  // which is the point of the prop. Both cases fall out of the same expression.
  if (hide) {
    const hiddenSlot = row.axisSlots.get(slot) ?? 0;
    return hiddenSlot > 0 ? (
      <div
        aria-hidden="true"
        style={{ flex: `0 0 ${hiddenSlot}px`, height: `${row.height}px` }}
      />
    ) : null;
  }

  const { theme } = container;
  const yScale = row.yScales.get(id);
  // The auto-tick count — the row resolves it (explicit `tickCount` else
  // height-derived) and both this axis's labels AND the row's gridlines read
  // the same value, so a label and its gridline can't drift apart.
  const count = row.tickCounts.get(id) ?? DEFAULT_TICK_COUNT;
  // Same formatter the readout uses (resolved per axis on the row), so a tick and
  // a cursor value read identically. `count` calibrates the default formatter's
  // precision to the tick density, exactly as the axis is.
  const fmt = yScale ? resolveAxisFormat(yScale, count, format) : String;
  // A **horizontal categorical** layer on this axis supplies its category
  // names ([PND-HCAT]); with no explicit `ticks`, label one per unit slot at
  // its centre (`i + 0.5`) instead of the scale's numeric ticks — a slot index
  // is not a number anyone wants to read. Explicit `ticks` still win, and a
  // non-categorical row is unaffected (no layer answers, so this is `null`).
  const layerCategories: readonly string[] | null =
    row.layers
      .filter((e) => (e.axisId ?? row.defaultAxisId) === id)
      .map((e) => e.layer.binCategories?.() ?? null)
      .find((c) => c !== null) ?? null;

  // Explicit `{ at, label }` ticks render verbatim (each label at its `at`),
  // overriding the auto-picked d3 ticks; otherwise label the scale's ticks via `fmt`.
  const tickList: readonly { value: number; label: string }[] = ticks
    ? ticks.map((t) => ({ value: t.at, label: t.label }))
    : layerCategories !== null
      ? layerCategories.map((label, i) => ({ value: i + 0.5, label }))
      : (yScale ? tickValues(yScale, count) : []).map((t) => ({
          value: t,
          label: fmt(t),
        }));

  // The row reserves a slot per axis column (the widest in that column across
  // rows). Size the box to the slot and align this axis's own (narrower)
  // content toward the plot — left axes flush right, right axes flush left — so
  // axes line up column-by-column. Keyed by this instance's slot key (not `id`,
  // which may repeat across a mirror). Falls back to own width until reserved.
  const slotWidth = row.axisSlots.get(slot) ?? width;

  // The axis value under the pointer, for `onMouseEvent` — read on the **slot**
  // box (below), so the whole reserved gutter answers, not just this axis's own
  // narrower content. The box is exactly the row's height and shares its top
  // edge with the plot, so a box-local pixel inverts straight through this
  // axis's scale. Before the row has published one there is no value to report
  // and the event is dropped. A categorical row labels by slot, matching its
  // ticks; every other row reads this axis's own tick format.
  const mouse = axisMouseProps(onMouseEvent, 'y', id, (event) => {
    // See the x strip's: a zoom drag's trailing click is not a click on a value.
    if (event.type === 'click' && gestures.consumeDrag()) return null;
    if (!yScale) return null;
    // Clamp on the **scale's** range, not the box: a row with a
    // `labelPlacement="top"` axis reserves a header, so the range is
    // `[height, topHeader]` while the box still starts at 0 (`ChartRow`).
    const [r0, r1] = yScale.range() as [number, number];
    const value = yScale.invert(axisPointerPx(event, 'y', [r0, r1]));
    return {
      value,
      label:
        layerCategories !== null
          ? // A slot index, clamped to a real category: the domain's top edge
            // inverts to exactly `n` (and rounding can nudge the bottom below
            // 0), which no category occupies — the nearest one is the honest
            // answer, matching the band scale's own `invert`.
            (layerCategories[
              Math.min(
                layerCategories.length - 1,
                Math.max(0, Math.floor(value)),
              )
            ] ?? '')
          : fmt(value),
    };
  });

  return (
    <div
      // A stable hook for the gutter (see the x strip's): the axis takes no
      // `className`, so `[data-axis-id='price']` is how a consumer styles one
      // — or an e2e test picks it out of a dual-axis row.
      data-axis="y"
      data-axis-id={id}
      ref={gestures.ref}
      {...gestures.props}
      {...mouse}
      // See the x strip's: two `onDoubleClick`s meet here (the reset and the
      // consumer's report) and a spread would silently drop one.
      onDoubleClick={(e) => {
        mouse.onDoubleClick?.(e);
        gestures.props.onDoubleClick?.();
      }}
      style={{
        ...gestures.style,
        flex: `0 0 ${slotWidth}px`,
        display: 'flex',
        justifyContent: side === 'left' ? 'flex-end' : 'flex-start',
        height: `${row.height}px`,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: `${width}px`,
          height: `${row.height}px`,
          fontFamily: theme.font.family,
          fontSize: `${theme.font.size}px`,
          color: color ?? theme.axis.label,
        }}
      >
        {yScale &&
          tickList.map(({ value, label }, i) => {
            // Drop just the top & bottom labels when boundary labels are off
            // (gridlines are drawn separately, so they stay).
            if (!boundaryLabels && (i === 0 || i === tickList.length - 1))
              return null;
            // Clamp the label's centre so a domain-extreme label stays inside
            // the row instead of half-overflowing the top/bottom edge (and
            // colliding across a splitter in a stacked layout) — F-charts-6.
            const half = theme.font.size / 2 + 1;
            const top = Math.max(
              half,
              Math.min(row.height - half, yScale(value)),
            );
            return (
              <div
                key={value}
                style={{
                  position: 'absolute',
                  top: `${top}px`,
                  [side === 'left' ? 'right' : 'left']: '4px',
                  transform: 'translateY(-50%)',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </div>
            );
          })}
        {/* The axis title. Typography is themeable + a touch larger than the
            ticks (see `theme.axis.title`). `'top'` draws it horizontally at the
            top of the axis, aligned to its side (terse unit labels); `'rotated'`
            (default) is the thin vertical strip down the outer edge — the
            standard y-axis convention, fits long labels in a narrow gutter.
            Left axes read bottom→top, right axes top→bottom. */}
        {labelPlacement === 'top' ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              // Align to the axis line (the plot-facing edge), matching the tick
              // labels' alignment, rather than floating at the outer gutter edge.
              [side === 'left' ? 'right' : 'left']: '4px',
              fontSize: `${theme.axis.title?.size ?? theme.font.size + 1}px`,
              color: color ?? theme.axis.title?.color ?? theme.axis.label,
              opacity: theme.axis.title?.opacity ?? 0.85,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {label ?? id}
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              [side === 'left' ? 'left' : 'right']: '1px',
              top: 0,
              bottom: 0,
              width: `${(theme.axis.title?.size ?? theme.font.size + 1) + 3}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: `${theme.axis.title?.size ?? theme.font.size + 1}px`,
              color: color ?? theme.axis.title?.color ?? theme.axis.label,
              opacity: theme.axis.title?.opacity ?? 0.85,
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                whiteSpace: 'nowrap',
                transform: `rotate(${side === 'left' ? -90 : 90}deg)`,
              }}
            >
              {label ?? id}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
