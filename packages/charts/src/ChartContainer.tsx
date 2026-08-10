import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { scaleLinear } from 'd3-scale';
import {
  identityProvider,
  scaleTradingTime,
  type DiscontinuityProvider,
  type TradingCalendarLike,
  type TradingTimeScale,
} from './tradingTimeScale.js';
import { scaleBand } from './bandScale.js';
import { scaleElapsed } from './elapsed.js';
import { Sequence, BoundedSequence } from 'pond-ts';
import type { Interval, TimeRange } from 'pond-ts';
import {
  ContainerContext,
  CursorContext,
  type CursorFrame,
  type AnnotationKind,
  type AnnotationSpec,
  type ContainerFrame,
  type CreateSpec,
  type GutterReq,
  type CursorEntry,
  type CursorMode,
  type SelectInfo,
  type SelectionEntry,
  type SpanSelection,
  type SelectModifiers,
  type SelectorEntry,
  type TrackerInfo,
  type TrackerSource,
  type DrawStatsFrame,
} from './context.js';
import {
  LegacyCursor,
  legacyCursorWarning,
  presetNameFor,
  warnOnDuplicateGestureOwners,
} from './cursors.js';
import {
  LegacySelector,
  effectiveSelectorEntries,
  warnInertClick,
  warnLegacySelectionProps,
} from './selectors.js';
import { isDev } from './dev.js';
import type { LegendItemSpec } from './swatch.js';
import { maxSlotWidths, sum } from './slots.js';
import { computeLabelLanes } from './annotations.js';
import { resolveCursorX, DEFAULT_CURSOR_MODE } from './tracker.js';
import { clampToBounds } from './viewport.js';
import {
  resolveAxisFormat,
  resolveTimeFormat,
  type AxisFormat,
  type CursorFormat,
} from './format.js';
import { TimeAxis } from './TimeAxis.js';
import { defaultTheme, type ChartTheme } from './theme.js';
import { isSpanSelection, NO_SPANS } from './span.js';

/** Stable identity for "nothing selected" — see the normalization below. */
const EMPTY_SELECTION: readonly SelectInfo[] = [];
/** Stable "no sweep in flight" identity for the span preview channel. */
const EMPTY_PREVIEW_SPANS: readonly SpanSelection[] = [];

/** Tick count for a **continuous** (non-trading) x axis — the `ticks(count)`
 *  request `<TimeAxis>`, the x gridlines, and the cursor-time formatter share
 *  (as the frame's `xTickCount`). */
const TIME_TICK_COUNT = 5;

/** Target px of plot width per tick on a **trading-time** axis. That scale's
 *  `ticks(count)` treats `count` as a **cap on calendar buckets** (see
 *  `coarsenCalendar` — it picks the finest grain that fits), so the count must
 *  scale with the room the labels actually have: a fixed 5 coarsens any
 *  ≳6-month daily view to year grain — 2 ticks on a 900px plot. ~65px fits a
 *  `%b %d` anchor label at the default font plus breathing room, so a ~900px
 *  year-long daily view lands on month grain. */
const TRADING_TICK_PX = 65;

/**
 * Normalize the `range` prop — a `[begin, end]` tuple or a `TimeRange` — to a
 * plain `[number, number]`, or `undefined` when omitted (→ auto-fit). The
 * `'begin' in range` check distinguishes the `TimeRange` from the tuple (a
 * tuple has no `begin` key).
 */
function normalizeRange(
  range: readonly [number, number] | TimeRange | undefined,
): readonly [number, number] | undefined {
  if (range === undefined) return undefined;
  return 'begin' in range ? [range.begin(), range.end()] : [range[0], range[1]];
}

export interface ChartContainerProps {
  /**
   * The shared x **domain** `[begin, end]` — a tuple, or a `TimeRange`
   * (`series.timeRange()`). Units follow the data: epoch-ms for a time axis,
   * the value units (distance, …) for a value axis. **Omit to auto-fit** to the
   * rows' extents. The axis *kind* is never taken from here — it's inferred from
   * the data — so a tuple stays a time domain on a time chart.
   */
  range?: readonly [number, number] | TimeRange;
  /**
   * **Cap the slot pitch** on a **category** x axis, in CSS pixels
   * ([PND-BANDPACK]). A band scale otherwise spreads its categories across the
   * full plot width, so three categories in a 900px panel become three 300px
   * bars and thirty become thirty 30px ones — the same chart in the same panel
   * reading as two different charts depending on how many categories the data
   * happened to return.
   *
   * That is fine for a static chart with a known domain and wrong for a **live**
   * one: when the category count moves over a session, bar width becomes a
   * meaningless variable that moves on its own, and a reader can't compare the
   * chart to what it looked like a minute ago or to the same chart on another
   * screen. Capping the pitch keeps bar width constant and comparable, and the
   * empty space left over is itself information — it shows the set is small.
   *
   * Omitted ⇒ slots fill the plot (unchanged). When `n × maxBandWidth` exceeds
   * the plot, the cap can't bind and the slots fill as before, so this degrades
   * correctly as categories accumulate. Use {@link bandAlign} to say where the
   * capped block sits.
   *
   * **This caps the slot, not the bar.** `<BarChart gap>` still insets the bar
   * within its slot, and the two compose — one knob for pitch, one for ink,
   * neither doing the other's job. (Inverting `gap` against a measured plot
   * width was the workaround this replaces for the width half; the packing half
   * had no workaround at all.)
   *
   * **Vertical / x-axis categories only.** A `orientation="horizontal"`
   * categorical chart puts its categories on the **y** axis as unit slots,
   * which is a different mechanism and is not capped by this.
   */
  maxBandWidth?: number;
  /**
   * Where the capped category block sits in the plot when {@link maxBandWidth}
   * binds. **Default `'start'`** — pack from the left, leaving the far side
   * empty. `'center'` and `'end'` place it otherwise.
   *
   * A no-op without `maxBandWidth`, or when the cap doesn't bind: the block
   * fills the plot and there is no slack to place. (There is deliberately no
   * `'fill'` member — "fill" is what *omitting* `maxBandWidth` means, and a
   * `fill` value alongside a pitch cap would be a contradiction rather than a
   * choice.)
   */
  bandAlign?: 'start' | 'center' | 'end';
  /**
   * A **trading-calendar** discontinuity provider — closed-market time
   * (weekends, holidays, overnight, lunch breaks) collapsed. Supply it to turn
   * the shared x axis into a **trading-time** axis: gaps disappear and time
   * stays proportional within each session. A `@pond-ts/financial`
   * `TradingCalendar.discontinuities()` satisfies this structurally (charts
   * never imports that package). The **low-level** primitive: pass
   * `calendar.discontinuities()` (or a `{ spacing, period }` variant) directly.
   * Only affects a **time** axis (ignored on a value axis). Takes precedence
   * over {@link calendar} if both are given.
   *
   * **Pass a stable reference.** The scale (and container frame) rebuild when
   * this prop's identity changes, so memoize it — `const disc = useMemo(() =>
   * calendar.discontinuities(), [calendar])` — rather than calling
   * `.discontinuities()` inline in JSX, which would rebuild every render.
   *
   * Accepts an explicit `undefined` (a `cond ? provider : undefined` toggle
   * under `exactOptionalPropertyTypes`), same as omitting it.
   */
  discontinuities?: DiscontinuityProvider | undefined;
  /**
   * The **high-level** sugar for {@link discontinuities}: a trading calendar the
   * container derives the provider from itself (`calendar.discontinuities({
   * spacing })`), so you don't wire the low-level prop. A `@pond-ts/financial`
   * `TradingCalendar` satisfies the structural {@link TradingCalendarLike} shape
   * (charts never imports that package). Combine with {@link spacing}. For the
   * full option matrix (a bar `period`, a scoped `range`) use the low-level
   * `discontinuities` prop instead. Only affects a **time** axis.
   *
   * The provider is memoized on `(calendar, spacing)`, so pass a **stable**
   * calendar reference (build it once, not inline in JSX).
   */
  calendar?: TradingCalendarLike;
  /**
   * The trading axis **metric**, when a {@link calendar} is supplied
   * (trading-calendar RFC Q7). `'proportional'` (default) keeps time
   * proportional within and across sessions — a half-day is half as wide.
   * `'uniform'` gives every session equal width (the TradingView ordinal look).
   * Ignored without `calendar` (a low-level `discontinuities` provider already
   * carries its own metric).
   */
  spacing?: 'proportional' | 'uniform';
  /**
   * Draw the reference gridlines behind the data. On a calendar (time) axis
   * the verticals are the **full grain populations** — every day / month /
   * aligned clock instant in view, each grain fading by its calendar density
   * — not just the labelled ticks (the labels decorate the grid; they don't
   * define it). **Default `true`.** Set `false` for a clean backdrop —
   * session dividers (below) are independent and still draw when enabled.
   */
  grid?: boolean;
  /**
   * Where to draw **session dividers** — the solid verticals at a trading
   * calendar's collapse **seams**: boundaries that removed (closed-market)
   * time actually precedes, not every session roll (only with a
   * `discontinuities` / `calendar` provider). On a real exchange calendar
   * every session open follows an overnight gap, so seams = session opens; a
   * calendar of contiguous full-day sessions has seams only where days were
   * excised (the weekend). **Default `'none'`** — the hierarchical grid
   * already marks the calendar structure at every zoom, so dividers are
   * opt-in emphasis: `'all'` draws one at *every* seam in view (the
   * TradingView session-separator look, crowding lines fading out),
   * `'labeled'` only at seams the axis also labels. Dividers are independent
   * of {@link grid} — `'all'` + `grid={false}` is the
   * separators-on-a-clean-plot look.
   */
  sessionDividers?: 'labeled' | 'all' | 'none';
  /** Total width in CSS pixels (plot + axis gutters). */
  width: number;
  /** Vertical space between rows in CSS pixels (not under the axis). Default 0. */
  rowGap?: number;
  /**
   * Auto-render the shared x axis under the rows. **Default `true`.** Set
   * `false` for a bare plot (a sparkline), or when you place your own `<XAxis>`
   * child (e.g. with a label, custom ticks, or on `side="top"`). Named
   * `showAxis` (not `axis`) to avoid clashing with a layer's `axis` prop, which
   * picks *which* `<YAxis>` it scales against — a different axis entirely.
   */
  showAxis?: boolean;
  /**
   * Controlled tracker position (epoch ms) — where to show the synced crosshair
   * **when this chart isn't the one under the pointer**. A live local hover
   * always wins over it, so this is a *followed* position, not a hard pin:
   * supply it to drive the cursor from outside (a scrubber, a playback head, or
   * — the main use — **cross-chart sync**). Maps through this chart's own
   * `xScale`, so it lands at the right pixel even under a different zoom.
   *
   * **Multi-chart sync** falls out of this plus {@link onTrackerChanged}: give
   * every `<ChartContainer>` the same `trackerPosition={sharedTime}` and set
   * `sharedTime` from each one's `onTrackerChanged`. The hovered chart favors its
   * own pointer (and reports the time out); the others follow. Clear `sharedTime`
   * to `null` on the group's `onPointerLeave` so the crosshair lifts when the
   * pointer leaves every chart. (See the "Synced cursors across charts" story /
   * dashboard guide.)
   *
   * **Omit or pass `null`** (equivalent) for no controlled position — a hovered
   * chart still tracks its pointer, a non-hovered one shows nothing. To force a
   * chart to *never* show a cursor, use `cursor="none"`, not `trackerPosition`.
   * See {@link onTrackerChanged}.
   */
  trackerPosition?: number | null;
  /**
   * In-chart cursor presentation — the default for all rows (a row may override
   * via `<ChartRow cursor>`). **Default `'line'`** — the synced vertical line,
   * with values surfaced *outside* the chart via {@link onTrackerChanged}.
   * `'point'` / `'inline'` / `'flag'` add per-series marks; `'none'` hides it.
   * `'region'` shades the bucket under the pointer (needs {@link cursorSequence}).
   * See {@link CursorMode}.
   *
   * @deprecated Mount a **cursor component** instead — `<LineCursor>` /
   * `<PointCursor>` / `<InlineCursor>` / `<FlagCursor>` / `<CrosshairCursor>` /
   * `<RangeCursor>` as a child of the container (or inside a `<ChartRow>` for
   * the per-row override); mount nothing for `'none'`. This prop keeps working
   * for one more minor by synthesizing the equivalent preset internally; a
   * mounted cursor component overrides it. See `docs/rfcs/interaction.md` §9.
   */
  cursor?: CursorMode;
  /**
   * The bucketing for `cursor="region"` — the interval highlighted under the
   * pointer. A pond {@link Sequence} (duration or calendar-aware —
   * `Sequence.every('1d')`, `Sequence.calendar('month')`) is realized over the
   * current view; a {@link BoundedSequence} (e.g. a `TradingCalendar`'s
   * `sessionSequence()` / `barSequence()`) is used as-is, so the band can track
   * whole **sessions**. Either way the band maps through `xScale`, so on a
   * trading-time axis the closed part of the bucket collapses. Ignored unless
   * `cursor="region"`.
   *
   * **Time axis only.** A bucket is a *time* interval, so the region cursor is
   * gated to a **time** x-axis — on a **value** axis (a horizontal histogram, a
   * value-keyed chart) it's a no-op (highlighting a value *band* on a horizontal
   * histogram would be a different, y-oriented cursor).
   *
   * **Pass a stable reference.** The buckets are memoized on this value + the
   * view range; a `Sequence`/`BoundedSequence` rebuilt inline every render
   * re-realizes the buckets on each pointer move (harmless for a coarse
   * day/session sequence, wasteful for a fine one over a wide view) — hoist it or
   * `useMemo` it.
   *
   * @deprecated Use `<RangeCursor sequence={…}>` — the prop moved onto the
   * component that uses it, where it is no longer mode-conditional. Works for
   * one more minor; a mounted `<RangeCursor>`'s sequence wins over this.
   */
  cursorSequence?: Sequence | BoundedSequence;
  /**
   * Makes the `region` cursor **draggable**: drag across the plot and the band
   * extends **bucket by bucket** (snapping to `cursorSequence` points); on
   * release this fires **once** with the selected `[lo, hi]` span, and the cursor
   * reverts to the single-bucket highlight (it does not keep the range). Typical
   * use — zoom the view to the returned span (the container doesn't zoom itself;
   * that's the consumer's call), or map it onto a data subscription's range params.
   *
   * The span is a **neutral numeric pair in axis units** — epoch ms on a **time**
   * axis, the axis value (strike, distance, …) on a **value** axis — mirroring the
   * polymorphic `range` input. A time consumer that wants a `TimeRange` builds one
   * from the pair.
   *
   * With **no `cursorSequence`** the region cursor is the degenerate case — it
   * renders as a **line** on hover and the drag is **freeform** (raw `[lo, hi]`, no
   * bucket snapping); the same callback fires on release. Bucket snapping needs a
   * `cursorSequence`, which is **time-axis only** (a time interval over a value
   * domain is meaningless), so a **value** axis is always freeform. No-op unless
   * `cursor="region"` on a **time** or **value** x-axis (a **category** axis is
   * excluded — an ordinal-slot select is a different gesture).
   *
   * @deprecated Use `<RangeCursor onDragRelease>` — the drag moved onto the
   * component, and the payload becomes `{ x: [lo, hi] }` (a {@link RangeSpan},
   * forward-compatible with the 2-D drag's optional `y`) instead of the bare
   * pair. Works for one more minor; a mounted `<RangeCursor onDragRelease>`
   * takes over the gesture.
   */
  onRegionSelect?: (range: readonly [number, number]) => void;
  /**
   * Which modifier a region-drag needs — set `'shift'` when you also enable
   * **pan** (`panZoom="pan"` or `"panZoom"`) and want **plain drag to pan,
   * shift-drag to select**. It's only enforced while pan is enabled (with pan
   * off there's no gesture conflict, so shift is optional — either drag
   * selects). **Omitted** ⇒ a region-drag
   * **preempts** pan (drag always selects; document that precedence for users).
   * Wheel-zoom is unaffected in every case.
   *
   * @deprecated Use `<RangeCursor dragModifier>` — the prop moved onto the
   * component alongside `onDragRelease`. Works for one more minor.
   */
  regionSelectModifier?: 'shift';
  /**
   * Fires on pointer move with the hovered time + every series' value there (so
   * you can render a readout outside the chart), and `null` on leave.
   */
  onTrackerChanged?: (info: TrackerInfo | null) => void;
  /**
   * Draw-cost + decimation observability. Fires **once per row-canvas repaint**
   * with a {@link DrawStatsFrame} — one {@link LayerDrawInfo} per layer in that
   * row carrying its `as`, `drawMs`, and (for a decimating layer) `sourceCount`
   * / `drawnCount` / `decimated`. Compare `drawnCount` to `sourceCount` to see
   * whether M4 engaged; read `drawMs` for per-layer render cost. **Omitted ⇒ no
   * measurement** — the render loop skips per-layer timing entirely, so this is
   * zero-overhead when unused. Keep the callback cheap (it runs inside the draw
   * frame); route it to a ref/store rather than doing React state work per frame.
   */
  onDrawStats?: (frame: DrawStatsFrame) => void;
  /**
   * Controlled selection — the selected mark (echo the `onSelect` arg back), or
   * `null`. **Omitted ⇒ uncontrolled** (a click on a selectable layer manages it
   * internally; pass `null` to force nothing selected). A layer is **selectable
   * only when it carries an `id`** (the stable series identity) — `BarChart` /
   * `ScatterChart` highlight the mark matching the selection's `id` (the series)
   * and its `key` (the sample), so two series sharing a timestamp don't both
   * light up, and the selection survives a data update (it keys on the stable
   * `id`, not the sample `key`). A layer with no `id` renders + reads out but
   * can't be selected.
   *
   * **Accepts a set** ([PND-MULTISEL]): pass a `SelectInfo[]` to light several
   * marks at once — the shape a consumer whose filter is multi-valued actually
   * has. Insertion-ordered, `[]` means nothing selected. A single `SelectInfo`
   * still works and means exactly what it did, so this is a **union, not a
   * replacement**: no existing caller changes. (`docs/rfcs/selection.md` A1.4
   * proposed replacing the type outright and flagged it as a breaking widen
   * needing the human gate plus a one-release shim — accepting both costs one
   * `Array.isArray` and needs neither.)
   *
   * The library applies **no set arithmetic**: a chart click reports the hit it
   * found, and a consumer that wants ⌘-click-to-add reads
   * {@link SelectModifiers.additive} off `onSelect` and drives this prop.
   * `selectionMode` (RFC A1.1) would be sugar over exactly that, and stays
   * unbuilt until a consumer wants it — adding it later is additive.
   *
   * **Array entries may also be spans** (interaction RFC A5.2): a
   * {@link SpanSelection} names *every* mark of one layer inside a range —
   * `{ kind: 'span', id, x: [lo, hi) }`, plus `y` (scatter's continuous second
   * dimension) or `rows` (a heat map's ordinal row names) — so a swept session
   * of ten thousand bars is one entry, not ten thousand. Membership follows
   * the containment rule documented on {@link SpanSelection} (half-open
   * intervals, snapped-outward edges), and the exported `selectionContains`
   * runs the **same** predicate the layers do, so click policy over a mixed
   * selection never re-implements the interval test. The union widens once
   * more and stays **non-breaking**: a bare `SelectInfo` and a plain
   * `SelectInfo[]` mean exactly what they always did.
   */
  selected?: SelectInfo | readonly SelectionEntry[] | null;
  /**
   * Fires when a selectable layer's mark is clicked, with the hit mark, or `null`
   * when a click misses every mark (or hits a layer with no `id` — display-only,
   * so it reads as empty space). Notification only — works in both controlled and
   * uncontrolled mode. If this or `selected` is set but no layer has an `id`, a
   * dev-warning notes that nothing is selectable.
   *
   * The second argument carries the **keyboard modifiers** held during the click
   * ([PND-MULTISEL]). Without them a consumer cannot implement ⌘/Ctrl-click-adds
   * at all — the click has already been reduced to a hit — so every consumer was
   * forced to treat every click as a replace. `modifiers` is `undefined` for a
   * selection that didn't come from a pointer event (a `<Legend>` row, a
   * programmatic `select`).
   *
   * ```tsx
   * onSelect={(hit, mods) =>
   *   setSelected((cur) =>
   *     hit === null ? []
   *     : mods?.additive ? toggle(cur, hit)
   *     : [hit],
   *   )
   * }
   * ```
   *
   * @deprecated Move it onto a mounted `<Selector onSelect={…}>` — a child of
   * this container, or of a `<ChartRow>` to scope the gesture to that row.
   * Mounting the component is now what **enables** a plot click at all
   * (`docs/rfcs/interaction.md` §7.1); this prop keeps working for one more
   * minor by synthesizing an equivalent registration internally, and a mounted
   * `<Selector>` overrides it. The state props ({@link selected} /
   * {@link hovered}) deliberately **stay here** (A1.2).
   */
  onSelect?: (hit: SelectInfo | null, modifiers?: SelectModifiers) => void;
  /**
   * Controlled hover-highlight — the transiently lit mark(s) (echo the `onHover`
   * arg back), or `null`. **Omitted ⇒ uncontrolled** (the pointer over a
   * selectable layer manages it internally). The hover analog of
   * {@link selected}: pass it to **pin** lit marks from outside the chart (e.g.
   * hovering a legend / list row lights the matching {@link BarChart} bar). Only
   * layers with a hover-highlight (currently `BarChart`) render it; keyed by the
   * same {@link SelectInfo} identity as selection.
   *
   * **Accepts a single mark or a set** — the same union {@link selected} takes,
   * so passing one `SelectInfo` still works unchanged. Plural because a drag
   * sweep lights several marks at once ("would be selected if you released
   * now"); plain pointer-over carries 0 or 1. See RFC `selection.md` A4.2, which
   * supersedes A1.4's "hover is inherently one mark".
   */
  hovered?: SelectInfo | readonly SelectInfo[] | null;
  /**
   * Fires when the pointer enters a selectable layer's mark (the hit mark) or
   * leaves every mark (`null`) — the hover analog of {@link onSelect}. Notification
   * only (works controlled or uncontrolled), and **deduped**: it fires on a mark
   * transition, not on every pointer move. Wire it to mirror hover out-of-band
   * (e.g. a list row ↔ the bar), pairing with {@link hovered} to sync both ways.
   * (The annotation counterpart is {@link onHoverAnnotation}.)
   *
   * **Dedup key:** by the mark's `key` + `label` only (not `value`/`color`). So on
   * a live chart where a bar's value changes while the cursor stays on it, this
   * won't re-fire — read the current value from your series, not the last
   * `onHover` payload. (Matches the internal hover-highlight, which repaints on
   * key transitions.)
   *
   * @deprecated Move it onto a mounted `<Selector onHover={…}>`, alongside
   * {@link onSelect}. Works for one more minor via the shim; a mounted
   * `<Selector>` overrides it. {@link hovered} stays on the container (RFC
   * A1.2) — controlled highlighting needs no `<Selector>` at all.
   */
  onHover?: (hit: SelectInfo | null) => void;
  /**
   * Which pan/zoom gestures the plot captures:
   *
   * - `'none'` (or `false`, the **default**) — neither; the plot doesn't capture
   *   drag or scroll.
   * - `'pan'` — drag to pan the time range, **no** wheel-zoom (scroll still
   *   scrolls the page).
   * - `'panZoom'` (or `true`) — drag to pan **and** wheel to zoom around the
   *   cursor.
   *
   * The boolean form is the back-compat shorthand (`true` ⇒ `'panZoom'`,
   * `false` ⇒ `'none'`). Bound the reachable range with {@link bounds}
   * (zoom-out / pan extent) and {@link minDuration} (zoom-in floor).
   */
  panZoom?:
    | boolean
    | 'none'
    | 'pan'
    | 'panZoom'
    | 'panZoomX'
    | 'panZoomY'
    | 'panZoomXY';
  /**
   * **Outer pan/zoom extent** — `[min, max]` (same units as {@link range}) the
   * view can never move outside. Panning into an edge stops there (the window
   * keeps its span); zooming out is capped at this width, so `bounds` is the
   * zoom-**out** ceiling that pairs with the {@link minDuration} zoom-**in**
   * floor. **Omit for no limit** (pan/zoom is unbounded). Constrains gestures
   * (and any range routed through the container); seed {@link range} within it.
   * On a trading-time axis the clamp is in wall-clock ms (a sensible outer
   * limit; the per-session pan/zoom math already holds the trading span at each
   * calendar edge).
   */
  bounds?: readonly [number, number];
  /**
   * Controlled view range — fires on pan/zoom with the new `[start, end]`. Wire
   * it back to `range` for a controlled chart; omit for uncontrolled (the
   * container holds the view internally). **Uncontrolled + `panZoom` seeds the
   * internal view from `range` whenever it isn't actively holding one — so
   * toggling `panZoom` on, or a controlled→uncontrolled switch, starts from the
   * current range, not the mount-time one. Once uncontrolled, later `range`
   * changes are ignored so they can't fight the user's pan. To drive the range
   * externally — or to follow a live sliding window — use controlled mode (this
   * callback).**
   */
  onTimeRangeChange?: (range: [number, number]) => void;
  /** Zoom-in floor — the minimum visible duration in ms. Default `1`. */
  minDuration?: number;
  /**
   * Show the cursor's time atop the in-chart readout (when a row's `cursor` draws
   * one). **Default `false`.** Formatted by {@link timeFormat} to match the time
   * axis.
   *
   * @deprecated Use `showTime` on the mounted cursor component
   * (`<LineCursor showTime>` / `<FlagCursor showTime>` / …). Works for one
   * more minor via the shim.
   */
  cursorTime?: boolean;
  /**
   * `cursor="crosshair"` reticle **y** snapping. **Default `true`** — the
   * crosshair centres on the nearest **data point** (the horizontal line snaps to
   * that sample's value). `false` — the horizontal line + centre follow the
   * pointer **y** freely, the value read as `yScale.invert(pointerY)`. Either way
   * the vertical line snaps its **x** to the data grid (so the time readout is
   * clean), and both draw a full-height dashed vertical + full-width dashed
   * horizontal line.
   *
   * @deprecated Use `<CrosshairCursor snap={…}>` — the prop moved onto the
   * component, where it is no longer mode-conditional. Works for one more
   * minor via the shim.
   */
  crosshairSnap?: boolean;
  /**
   * Enter **annotation-edit mode**: suppresses the data cursor and makes editable
   * annotations (those given an `onChange`) interactive — hovering one reveals its
   * handles + highlights it, and dragging edits it. **Default `false`.** Pairs
   * with each annotation's `onChange` (where the edit goes); this is the mode that
   * turns the affordances on and gets the cursor out of the way.
   */
  editAnnotations?: boolean;
  /**
   * The armed annotation **creation tool** (the consumer's toolbar sets it), or
   * `null`/omitted for idle. When set, the plot captures a create gesture — a
   * preview tracks the pointer, and on release {@link onCreate} fires. The consumer
   * then adds the mark, disarms (back to `null`), and selects it (spring-loaded);
   * keep it set to place several. Requires {@link editAnnotations}.
   */
  creating?: AnnotationKind | null;
  /** Fired when a create gesture completes (on release). See {@link CreateSpec}. */
  onCreate?: (spec: CreateSpec) => void;
  /**
   * Fired when an annotation is clicked (its `id`), the plot is clicked empty
   * (`null`), or a region is double-clicked (the shortcut into edit). The consumer
   * holds the selected id and sets each mark's `selected={id === sel}`.
   */
  onSelectAnnotation?: (id: string | null) => void;
  /**
   * Fired when the pointer enters an annotation (its `id`) or leaves it (`null`).
   * Mirror it to a controlled `hovered` prop on each mark to sync hover both ways
   * (e.g. a legend row ↔ the mark). Fires in any mode.
   */
  onHoverAnnotation?: (id: string | null) => void;
  /**
   * Fired when a mark is **double-clicked** — the request to edit just that one
   * (set its `editing` prop in response). Single click selects (inspect); double
   * click edits. Works in any mode.
   */
  onEditAnnotation?: (id: string) => void;
  /**
   * Snap mode (the toolbar's "Snap"). **Default `true`.** When on, a dragged
   * mark snaps to other marks' **guidelines** (their x-positions, within a few
   * px) so spans align; off = free placement. (Snapping to the nearest data
   * sample is not implemented — guideline alignment only.)
   */
  snap?: boolean;
  /**
   * Time-axis **label** formatting — a d3 time specifier string (e.g. `'%H:%M'`)
   * or a `(epochMs) => string` function ({@link AxisFormat}). A custom format
   * **owns the labels**, so it opts the axis out of the `dateStyle` ladder
   * (flat / stacked) by design. **Omitted ⇒ the flat/stacked date style.** To
   * shape only the cursor readout while keeping a date style, use
   * {@link cursorFormat} instead. (For back-compat this also shapes the readout
   * when `cursorFormat` is absent.)
   */
  timeFormat?: AxisFormat;
  /**
   * The **cursor / marker readout** format — the crosshair x pill, marker
   * axis indicators, and annotation auto-labels — **independent of the tick
   * labels** on both axis kinds: it does **not** disqualify the `dateStyle`
   * ladder (time), and it never moves the tick labels (value). It beats an
   * explicit `<XAxis format>` for the **readout only** — pill precedence is
   * `cursorFormat → axis format → container` — so terse ticks can pair with a
   * precise readout (`+2.0σ` labels, `+1.83σ` pill).
   *
   * **Omitted ⇒ the axis's own formatter.** On a time axis that default is
   * grain-aware: the readout formats at the axis's granularity, so a
   * day-or-coarser axis reads a **date** (never a time-of-day) and a sub-day
   * axis reads date + clock — a daily bar at a foreign-tz midnight no longer
   * renders as `02 AM`. On a value axis it is the tick formatter
   * ({@link timeFormat}-shaped, else the d3 default).
   *
   * A d3 specifier **string** formats uniformly (time specifier on a time
   * axis, number specifier on a value axis); a **function**
   * `(value, { grain, defaultText }) => string` receives the axis's resolved
   * coarse {@link TimeGrain} (`undefined` on a value axis) and the default
   * readout text, so it can branch on the zoom level and pass `defaultText`
   * through for grains it doesn't override (no re-deriving the grain from the
   * range). See {@link CursorFormat}. This is the independent readout channel;
   * {@link timeFormat} owns the labels. (A category axis reads names, and a
   * `transform`ed axis's pill speaks its derived unit — neither consults
   * `cursorFormat`.)
   *
   * @deprecated Use `format` on the mounted cursor (`<CrosshairCursor
   * format={…}>`) — it feeds the same shared readout channel (marker
   * indicators and annotation auto-labels included). Works for one more
   * minor; a mounted cursor's `format` wins over this.
   */
  cursorFormat?: CursorFormat;
  /**
   * Label the x axis as **offsets from a zero point** instead of absolute
   * values — the *duration* (elapsed-time) axis. A time axis reads
   * `00:00 00:05 00:10` where it read `10:35 10:40 10:45`; a value axis reads
   * distance-from-the-origin (`0 500 1000`) where it read absolute distance.
   *
   * - **`'data'`** — the start of the data (the union of the layers' x extents),
   *   so the labels are "since the beginning of the series" and stay put as you
   *   pan.
   * - **a number** — an explicit zero point in axis units: a race gun, a trigger
   *   instant, a lap marker. Ticks before it read negative (`-00:05` — the
   *   T-minus case).
   *
   * Ticks are placed at round durations **measured from the origin**, not at the
   * wall-clock boundaries the calendar ladder would pick — that's the difference
   * between `00:00 00:05 00:10` and `00:01:43 00:06:43`. Gridlines follow them,
   * and so does the cursor pill (one grain finer, as ever: `00:05:12`).
   *
   * This is a **labelling** mode, not a data transform: `range`, an annotation's
   * `at`, an `onRegionSelect` span, `trackerPosition` are all still absolute
   * axis units. Ignored on a category axis. An explicit `timeFormat` /
   * `<XAxis format>` still wins — on a time axis a d3 *time* specifier can only
   * describe an instant, so it labels the underlying wall clock (the lever for
   * stacking a wall-clock strip under a duration strip, on shared ticks); on a
   * value axis a number specifier formats the offset. On a trading-calendar
   * axis the durations are **wall-clock**, so ticks spanning a collapsed session
   * gap sit unevenly — elapsed *trading* time is not implemented.
   */
  origin?: number | 'data';
  /** Visual theme for all rows; defaults to {@link defaultTheme}. */
  theme?: ChartTheme;
  children?: ReactNode;
}

/**
 * The top of the chart layout (react-timeseries-charts-style). Owns the shared
 * **x geometry**: it collects each row's per-slot gutter widths, reserves each
 * slot's max across rows (so the innermost axis aligns column-by-column and
 * every row's plot left-aligns), and from the slot sums derives `plotWidth` and
 * the shared time `xScale`. It renders its rows (separated by `rowGap`) then one
 * {@link TimeAxis} at the bottom, aligned under the plots. Y axes are per-row
 * (`<YAxis>`).
 */
export function ChartContainer({
  range,
  maxBandWidth,
  bandAlign = 'start',
  width,
  rowGap = 0,
  showAxis = true,
  trackerPosition,
  onTrackerChanged,
  onDrawStats,
  selected,
  onSelect,
  hovered,
  onHover,
  panZoom = false,
  bounds,
  onTimeRangeChange,
  minDuration = 1,
  cursor: cursorProp,
  cursorSequence: cursorSequenceProp,
  onRegionSelect,
  regionSelectModifier,
  cursorTime: cursorTimeProp,
  crosshairSnap: crosshairSnapProp,
  editAnnotations = false,
  creating = null,
  onCreate,
  onSelectAnnotation,
  onHoverAnnotation,
  onEditAnnotation,
  snap = true,
  timeFormat,
  cursorFormat: cursorFormatProp,
  origin,
  theme,
  discontinuities,
  calendar,
  spacing,
  grid = true,
  sessionDividers = 'none',
  children,
}: ChartContainerProps) {
  // ── Legacy cursor props (deprecated) ───────────────────────────────────────
  // The string surface keeps working for one minor: the resolved mode is
  // synthesized into the equivalent mounted preset below (`<LegacyCursor>`),
  // and a dev warning names the replacement whenever any of the props is
  // *explicitly* set (never on the defaults). Mounted cursor components in the
  // same scope override the shim. See docs/rfcs/interaction.md §9 / A4.4.
  const cursor = cursorProp ?? DEFAULT_CURSOR_MODE;
  const cursorTime = cursorTimeProp ?? false;
  const crosshairSnap = crosshairSnapProp ?? true;
  const warnedLegacyRef = useRef(false);
  useEffect(() => {
    if (!isDev || warnedLegacyRef.current) return;
    const legacy: string[] = [];
    if (cursorProp !== undefined)
      legacy.push(
        `cursor="${cursorProp}" → mount ${presetNameFor(cursorProp)}`,
      );
    if (crosshairSnapProp !== undefined)
      legacy.push('crosshairSnap → <CrosshairCursor snap>');
    if (cursorTimeProp !== undefined)
      legacy.push('cursorTime → showTime on the mounted cursor');
    if (cursorFormatProp !== undefined)
      legacy.push('cursorFormat → format on <CrosshairCursor>');
    if (cursorSequenceProp !== undefined)
      legacy.push('cursorSequence → <RangeCursor sequence>');
    if (onRegionSelect !== undefined)
      legacy.push(
        'onRegionSelect → <RangeCursor onDragRelease> (the payload becomes ' +
          '{ x: [lo, hi] })',
      );
    if (regionSelectModifier !== undefined)
      legacy.push('regionSelectModifier → <RangeCursor dragModifier>');
    if (legacy.length === 0) return;
    warnedLegacyRef.current = true;
    console.warn(legacyCursorWarning(legacy));
  }, [
    cursorProp,
    crosshairSnapProp,
    cursorTimeProp,
    cursorFormatProp,
    cursorSequenceProp,
    onRegionSelect,
    regionSelectModifier,
  ]);

  // Mounted-cursor registry ({@link ContainerFrame.registerCursor}): the
  // presets (and the legacy shim) register their specs here; rows and
  // `<XAxis>` render the effective set. Same per-instance-slot discipline as
  // the tracker sources; register is idempotent under reference equality (the
  // presets memoize their entries on props).
  const [cursorMap, setCursorMap] = useState<ReadonlyMap<symbol, CursorEntry>>(
    () => new Map(),
  );
  const registerCursor = useCallback((key: symbol, entry: CursorEntry) => {
    setCursorMap((m) =>
      m.get(key) === entry ? m : new Map(m).set(key, entry),
    );
  }, []);
  const unregisterCursor = useCallback((key: symbol) => {
    setCursorMap((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);
  const cursors = useMemo(() => Array.from(cursorMap.values()), [cursorMap]);
  // RFC A2.5: one snap/gesture owner per scope — warn (dev, once) on two.
  const warnedGestureRef = useRef(false);
  useEffect(() => {
    warnOnDuplicateGestureOwners(cursors, warnedGestureRef);
  }, [cursors]);

  // The registered cursors' resolution inputs, folded into the legacy
  // channels: a mounted `<CrosshairCursor format>` feeds the shared readout
  // channel exactly where `cursorFormat` fed it. First **component-mounted**
  // entry wins (the shim registers before the children mount, so a bare
  // first-wins would let the legacy synthesis shadow a real mount); the
  // legacy prop is the fallback during the window. (`sequence` resolves the
  // same way, below the selector registry — a `<MultiSelector sequence>`
  // feeds the same channel.)
  const cursorFormat = useMemo(
    () =>
      cursors.find((e) => !e.legacy && e.format !== undefined)?.format ??
      cursorFormatProp,
    [cursors, cursorFormatProp],
  );

  // Which axes the gestures own. **Pan follows zoom's degrees of freedom**: an
  // axis that can be zoomed can be panned, because a zoomed axis shows less than
  // all of itself and the reader needs to reach the rest. `'pan'` is the one
  // exception — pan with no zoom — and it stays x-only, which is what it has
  // always meant. `'panZoom'` and `true` are `'panZoomX'`: the original
  // behaviour, now named for the axis it acts on.
  const zoomX =
    panZoom === true ||
    panZoom === 'panZoom' ||
    panZoom === 'panZoomX' ||
    panZoom === 'panZoomXY';
  const zoomY = panZoom === 'panZoomY' || panZoom === 'panZoomXY';
  const panX = zoomX || panZoom === 'pan';
  const panY = zoomY;
  const panEnabled = panX || panY;
  const zoomEnabled = zoomX || zoomY;
  // **The aspect ratio is fixed only when BOTH axes zoom** — one factor about
  // the cursor, so a feature that looked square stays square. A single-axis zoom
  // necessarily changes the ratio, which is the whole point of asking for one.
  //
  // This is why the modes name their axes. An earlier cut had a single
  // `panZoom2D` that claimed both and then silently fell back to y-only wherever
  // x was a category axis: the ratio changed and nothing said so. Spelling out
  // the axes makes that the caller's choice instead of a hidden one.
  const aspectLocked = zoomX && zoomY;
  const [yTransform, setYTransform] = useState<{ k: number; ty: number }>({
    k: 1,
    ty: 0,
  });
  const applyYTransform = useCallback((next: { k: number; ty: number }) => {
    // `k < 1` would zoom out past the axis' natural fit, leaving blank bands the
    // reader cannot interpret; clamping at 1 makes the un-zoomed view the floor.
    const k = Math.max(1, next.k);
    setYTransform((prev) =>
      prev.k === k && prev.ty === next.ty ? prev : { k, ty: next.ty },
    );
  }, []);
  const interactive = panEnabled || zoomEnabled;

  // The explicit base domain from `range` (a tuple or a TimeRange). `undefined`
  // ⇒ auto-fit (resolved from the layers below). Pan/zoom seeds from it; `seed`
  // is the placeholder while auto-fitting.
  const explicitDomain = normalizeRange(range);
  const seed: readonly [number, number] = explicitDomain ?? [0, 1];

  // View range: pan/zoom moves it. Controlled (onTimeRangeChange) reads the prop
  // and routes gestures back through the callback; uncontrolled holds it
  // internally. With panZoom off, the seed is used directly — so a static or live
  // (sliding-prop) chart tracks the prop as before.
  const [internalRange, setInternalRange] = useState<[number, number]>([
    seed[0],
    seed[1],
  ]);
  const uncontrolled = interactive && onTimeRangeChange === undefined;
  // While the internal view isn't in use (not uncontrolled), keep it synced to
  // the prop — so *entering* uncontrolled pan/zoom (toggling panZoom on, or a
  // controlled→uncontrolled switch) starts from the current range, not the
  // mount-time one. While uncontrolled, leave it alone so a range change
  // can't fight the user's pan. (Adjusting state during render — React re-renders
  // before commit, no extra paint; the guard makes it converge in one step.)
  if (
    !uncontrolled &&
    (internalRange[0] !== seed[0] || internalRange[1] !== seed[1])
  ) {
    setInternalRange([seed[0], seed[1]]);
  }
  const view = uncontrolled ? internalRange : seed;
  const t0 = view[0];
  const t1 = view[1];

  // Latest onTimeRangeChange in a ref so applyRange stays stable. Written after
  // commit (not in render) so a gesture never reads a callback from a frame that
  // was abandoned under concurrent rendering.
  const onRangeRef = useRef(onTimeRangeChange);
  useLayoutEffect(() => {
    onRangeRef.current = onTimeRangeChange;
  });
  // Latest `bounds` in a ref too, so `applyRange` clamps to the current extent
  // while staying identity-stable (it's a frame field + a gesture callback dep).
  const boundsRef = useRef(bounds);
  useLayoutEffect(() => {
    boundsRef.current = bounds;
  });
  const applyRange = useCallback((range: [number, number]) => {
    const b = boundsRef.current;
    const next = b ? clampToBounds(range, b) : range;
    const cb = onRangeRef.current;
    if (cb) cb(next);
    else setInternalRange(next);
  }, []);

  // Cross-row tracker. We store the cursor's plot-pixel x (not a timestamp), so a
  // still cursor stays put while a live window slides under it; a controlled
  // `trackerPosition` resolves to a pixel below.
  const [hoverX, setHoverX] = useState<number | null>(null);
  // The region-cursor drag anchor (epoch ms) — set on press, cleared on release.
  const [regionAnchor, setRegionAnchor] = useState<number | null>(null);
  // The live sweep preview for span-only layers ([PND-TRACESEL]) — a paint
  // mirror beside `regionAnchor`, never part of the committed selection.
  // `EMPTY_PREVIEW_SPANS` keeps the at-rest case reference-stable so a
  // pointer move over an unswept plot re-identifies no layer entry.
  const [previewSpans, setPreviewSpans] =
    useState<readonly SpanSelection[]>(EMPTY_PREVIEW_SPANS);
  // The free-form crosshair also needs the pointer's y + which row (row-specific,
  // unlike the shared x). One state object so a move updates both atomically.
  const [hoverPoint, setHoverPoint] = useState<{
    y: number;
    rowKey: symbol;
  } | null>(null);
  const setHoverY = useCallback(
    (y: number | null, rowKey: symbol | null) =>
      setHoverPoint(y === null || rowKey === null ? null : { y, rowKey }),
    [],
  );
  // The actively-dragged annotation — excluded from the lane packers so static
  // marks hold their lanes while it crosses them (see ContainerFrame.draggingKey).
  const [draggingKey, setDragging] = useState<symbol | null>(null);

  // Draw layers register as tracker sources; on hover we fan in their values at
  // the cursor and hand them out via onTrackerChanged (held in a ref so an
  // inline callback doesn't churn the frame). This powers a readout rendered
  // *outside* the chart — the preferred surface for hover values.
  const [sources, setSources] = useState<ReadonlyMap<symbol, TrackerSource>>(
    () => new Map(),
  );
  const registerTrackerSource = useCallback(
    (key: symbol, source: TrackerSource) =>
      setSources((m) => new Map(m).set(key, source)),
    [],
  );
  const unregisterTrackerSource = useCallback((key: symbol) => {
    setSources((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  // Selectable-layer registry: an id-bearing Bar/Scatter registers here (keyed
  // by its slot) so the container knows whether *any* series is selectable. Only
  // used to power the dev-warn below — selection resolution itself walks the
  // rows' layers, not this set. Backed by a **ref** (the synchronous source of
  // truth) mirrored to state: a child layer's register effect runs before this
  // parent's dev-warn effect in the same commit, so the ref is already settled
  // there (reading state would lag a render). State only triggers the re-check.
  const selectableRef = useRef<ReadonlySet<symbol>>(new Set());
  const [selectableKeys, setSelectableKeys] = useState<ReadonlySet<symbol>>(
    selectableRef.current,
  );
  const registerSelectable = useCallback((key: symbol) => {
    if (selectableRef.current.has(key)) return;
    selectableRef.current = new Set(selectableRef.current).add(key);
    setSelectableKeys(selectableRef.current);
  }, []);
  const unregisterSelectable = useCallback((key: symbol) => {
    if (!selectableRef.current.has(key)) return;
    const next = new Set(selectableRef.current);
    next.delete(key);
    selectableRef.current = next;
    setSelectableKeys(next);
  }, []);

  // Mounted-selector registry ({@link ContainerFrame.registerSelector}):
  // `<Selector>` — and the legacy shim below — register here, and **the
  // registration is what enables a plot click** (interaction RFC §7.1). Same
  // per-instance-slot discipline as the cursors/tracker sources. Mirrored to a
  // ref because `select` / `setHovered` are `[]`-stable callbacks that must not
  // read a stale closure (the `onSelectRef` discipline, one level up).
  const [selectorMap, setSelectorMap] = useState<
    ReadonlyMap<symbol, SelectorEntry>
  >(() => new Map());
  const registerSelector = useCallback((key: symbol, entry: SelectorEntry) => {
    setSelectorMap((m) =>
      m.get(key) === entry ? m : new Map(m).set(key, entry),
    );
  }, []);
  const unregisterSelector = useCallback((key: symbol) => {
    setSelectorMap((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);
  const selectors = useMemo(
    () => Array.from(selectorMap.values()),
    [selectorMap],
  );
  const selectorsRef = useRef(selectors);
  // The shared snap-bucket sequence, folded into the legacy channel exactly as
  // `cursorFormat` is above: a component-mounted `<RangeCursor sequence>`
  // wins, then a mounted `<MultiSelector sequence>` (its sweep extends bucket
  // by bucket over the same realized buckets — one channel, so the band and
  // the sweep can never snap differently), then the legacy shim / prop.
  const cursorSequence = useMemo(
    () =>
      cursors.find((e) => !e.legacy && e.sequence !== undefined)?.sequence ??
      selectors.find((e) => e.sequence !== undefined)?.sequence ??
      cursors.find((e) => e.sequence !== undefined)?.sequence ??
      cursorSequenceProp,
    [cursors, selectors, cursorSequenceProp],
  );
  // …and the matching deprecation warning, once, naming the replacement. The
  // *state* props (`selected` / `hovered`) are not deprecated and are not
  // listed here — RFC A1.2 keeps them on the container deliberately.
  const warnedLegacySelectionRef = useRef(false);
  useEffect(() => {
    if (!isDev || warnedLegacySelectionRef.current) return;
    const legacy: string[] = [];
    if (onSelect !== undefined) legacy.push('onSelect');
    if (onHover !== undefined) legacy.push('onHover');
    if (legacy.length === 0) return;
    warnedLegacySelectionRef.current = true;
    warnLegacySelectionProps(legacy);
  }, [onSelect, onHover]);

  // Annotations register here so the container can do what a mark can't in
  // isolation: draw its guide line across other rows, order regions, serve snap
  // targets. Keyed by per-instance slot key (same discipline as the sources).
  const [annotationMap, setAnnotationMap] = useState<
    ReadonlyMap<symbol, AnnotationSpec>
  >(() => new Map());
  const registerAnnotation = useCallback(
    (key: symbol, spec: AnnotationSpec) =>
      setAnnotationMap((m) => new Map(m).set(key, spec)),
    [],
  );
  const unregisterAnnotation = useCallback((key: symbol) => {
    setAnnotationMap((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);
  const annotations = useMemo(
    () => Array.from(annotationMap.values()),
    [annotationMap],
  );

  // Legend rows register here (label + resolved swatch per layer, see
  // useLegendItem) so a `<Legend>` anywhere in the container can enumerate
  // every layer across rows. Same per-instance-slot discipline as the sources.
  const [legendItems, setLegendItems] = useState<
    ReadonlyMap<symbol, LegendItemSpec>
  >(() => new Map());
  const registerLegendItem = useCallback(
    (key: symbol, item: LegendItemSpec) =>
      setLegendItems((m) => new Map(m).set(key, item)),
    [],
  );
  const unregisterLegendItem = useCallback((key: symbol) => {
    setLegendItems((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  // The shared x scale's kind, **inferred from the registered layers**: a
  // ValueSeries row plots on a value axis, a TimeSeries on time. A container
  // has one shared x (the synced cursor's whole point), so the rows must agree
  // — a mix is a hard error. Defaults to `'time'` until a layer registers (the
  // two-pass: register → re-resolve → rescale).
  const resolvedKind: 'time' | 'value' | 'category' = useMemo(() => {
    let kind: 'time' | 'value' | 'category' | undefined;
    for (const s of sources.values()) {
      if (kind === undefined) kind = s.xKind;
      else if (kind !== s.xKind) {
        throw new Error(
          `ChartContainer: rows mix x-axis kinds ('${kind}' and '${s.xKind}'). ` +
            `A container has one shared x axis — every row must plot the same ` +
            `kind (all time-keyed, all value-keyed, or all category).`,
        );
      }
    }
    return kind ?? 'time';
  }, [sources]);

  // A `'category'` container's ordered category names — the ordinal axis domain.
  // Every category layer must agree on the same list (a mix is an error, like the
  // kind), so the shared band scale has one authoritative slot order. `null` when
  // no category layer has registered (or the kind isn't category).
  const categories = useMemo((): readonly string[] | null => {
    let cats: readonly string[] | null = null;
    for (const s of sources.values()) {
      const c = s.xCategories?.() ?? null;
      if (c === null) continue;
      if (cats === null) cats = c;
      else if (cats.length !== c.length || cats.some((v, i) => v !== c[i])) {
        throw new Error(
          `ChartContainer: category rows disagree on the axis categories. ` +
            `Every category layer in one container must share the same ordered ` +
            `column set (got [${cats.join(', ')}] and [${c.join(', ')}]).`,
        );
      }
    }
    return cats;
  }, [sources]);

  // Auto-fit extent — the union of the layers' x extents — used as the domain
  // when no explicit `range` is given. (Same source registry as the kind; the
  // two-pass register→resolve applies.)
  const autoExtent = useMemo((): readonly [number, number] | null => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of sources.values()) {
      const e = s.xExtent();
      if (e) {
        if (e[0] < lo) lo = e[0];
        if (e[1] > hi) hi = e[1];
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }, [sources]);

  const onTrackerRef = useRef(onTrackerChanged);
  onTrackerRef.current = onTrackerChanged;

  // Draw-stats sink: hold the latest `onDrawStats` in a ref and expose a *stable*
  // reporter that reads it, so an inline arrow doesn't re-identify the context
  // (which would thrash every row's draw memo). The reporter is `undefined` when
  // there's no subscriber — the signal for `Layers` to skip per-layer timing
  // entirely (zero overhead when unused). Its identity flips only when the
  // presence of `onDrawStats` toggles, not on every render.
  const onDrawStatsRef = useRef(onDrawStats);
  onDrawStatsRef.current = onDrawStats;
  const hasDrawStats = onDrawStats !== undefined;
  const reportDrawStats = useMemo(
    () =>
      hasDrawStats
        ? (frame: DrawStatsFrame) => onDrawStatsRef.current?.(frame)
        : undefined,
    [hasDrawStats],
  );

  // Selection: controlled (`selected` prop) or uncontrolled (internal). A click
  // on a selectable layer calls `select()` after hit-testing; the mounted
  // `<Selector>`s in scope are notified in both modes, and the internal state is
  // managed only when uncontrolled — **the state stays here** whether or not a
  // selector is mounted (interaction RFC A1.2). The full SelectInfo is the
  // identity (key + series), so multi-series marks at one timestamp stay
  // distinct. Refs written after commit (not in render) so the click handler
  // never reads a callback / mode from a frame abandoned under concurrent
  // rendering.
  // Widened past a single mark for the sweep (RFC A5.2): an uncontrolled
  // `<MultiSelector>` release commits its compact span descriptor here, so the
  // swept bars stay lit with no controlled prop — the sweep analog of the
  // uncontrolled click highlight. Clicks still store the single hit.
  const [internalSelected, setInternalSelected] = useState<
    SelectInfo | readonly SelectionEntry[] | null
  >(null);
  const controlledSelection = selected !== undefined;
  // Normalize the prop's three accepted shapes — a single mark, a set, or
  // nothing — into the shapes the frame carries ([PND-MULTISEL] / RFC A5.2).
  // A mixed `SelectionEntry` array is split ONCE here into its mark entries
  // (`selected`, the exact field every pre-span reader keeps consuming
  // unchanged) and its span descriptors (`selectedSpans`, which only the
  // span-aware layers read) — so a consumer who never passes a span pays
  // nothing anywhere: the marks array is the prop's own array (no copy), the
  // spans field is the module constant, and every downstream `length === 0`
  // gate short-circuits as before. `EMPTY_SELECTION` / `NO_SPANS` are module
  // constants so the common cases keep stable identities and don't
  // re-identify the frame on every render.
  const { selectedValue, selectedSpans } = useMemo<{
    selectedValue: readonly SelectInfo[];
    selectedSpans: readonly SpanSelection[];
  }>(() => {
    const raw = controlledSelection ? selected : internalSelected;
    if (raw === null || raw === undefined)
      return { selectedValue: EMPTY_SELECTION, selectedSpans: NO_SPANS };
    if (!Array.isArray(raw))
      return {
        selectedValue: [raw as SelectInfo],
        selectedSpans: NO_SPANS,
      };
    const entries = raw as readonly SelectionEntry[];
    // The overwhelmingly common case — no span entries — returns the caller's
    // array as-is rather than partitioning into fresh ones.
    let spanCount = 0;
    for (let i = 0; i < entries.length; i += 1) {
      if (isSpanSelection(entries[i]!)) spanCount += 1;
    }
    if (spanCount === 0)
      return {
        selectedValue: entries as readonly SelectInfo[],
        selectedSpans: NO_SPANS,
      };
    const marks: SelectInfo[] = [];
    const spans: SpanSelection[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i]!;
      if (isSpanSelection(e)) spans.push(e);
      else marks.push(e);
    }
    return {
      selectedValue: marks.length === 0 ? EMPTY_SELECTION : marks,
      selectedSpans: spans,
    };
  }, [controlledSelection, selected, internalSelected]);
  const controlledSelectionRef = useRef(controlledSelection);
  useLayoutEffect(() => {
    selectorsRef.current = selectors;
    controlledSelectionRef.current = controlledSelection;
  });
  // The library applies no set arithmetic: it reports the hit plus the
  // modifiers and, when uncontrolled, keeps the single-mark behaviour it always
  // had. A consumer wanting add/toggle reads `modifiers.additive` and drives
  // the controlled `selected` set — see `SelectModifiers`.
  //
  // `rowKey` present ⇒ a **plot gesture**, and RFC §7.1's gate applies: with no
  // `<Selector>` in scope the click does nothing at all — it does not even
  // commit the uncontrolled selection, which is the whole point (a chart that
  // silently highlighted on click now doesn't). Absent ⇒ a programmatic select
  // (a `<Legend>` chip), which is intentional by construction and stays
  // ungated.
  const warnedInertClickRef = useRef(false);
  const select = useCallback(
    (hit: SelectInfo | null, modifiers?: SelectModifiers, rowKey?: symbol) => {
      const entries = effectiveSelectorEntries(
        selectorsRef.current,
        rowKey ?? null,
      );
      if (rowKey !== undefined && entries.length === 0) {
        // A2.6: suppress when `selected` is supplied — after A1.2 that is the
        // signature of the *endorsed* controlled-highlight setup, not of a
        // consumer who lost their click.
        if (isDev && hit !== null && !controlledSelectionRef.current)
          warnInertClick(warnedInertClickRef);
        return;
      }
      // Pass the second argument only when there is one. Calling
      // `onSelect(hit, undefined)` unconditionally would change the observed
      // arity for every existing consumer — enough to break a
      // `toHaveBeenCalledWith(hit)` assertion, which is a silly thing to break
      // for a purely additive feature.
      for (const e of entries) {
        if (modifiers === undefined) e.onSelect?.(hit);
        else e.onSelect?.(hit, modifiers);
        // A mounted <MultiSelector> hears the same click in its own currency
        // (RFC §8: everything <Selector> does): 0/1 hits, no span — a click
        // produces marks, only a sweep produces a span (A5.2).
        e.onSelectMany?.(
          hit === null ? EMPTY_SELECTION : [hit],
          modifiers,
          null,
        );
      }
      if (!controlledSelectionRef.current) setInternalSelected(hit);
    },
    [],
  );

  // Dev-warn: selection is wired (`selected`, `onSelect`, or a mounted
  // `<Selector>`) but no layer carries an `id`, so nothing is selectable — `id`
  // gates interactivity, so a consumer who forgot it gets a silent no-op click
  // without this nudge. Fires once per wired-but-empty transition (guarded by a
  // ref); child layers register before this parent effect runs, so the set is
  // settled here.
  const selectionWired =
    controlledSelection ||
    onSelect !== undefined ||
    selectors.some((e) => !e.legacy);
  const warnedNoSelectableRef = useRef(false);
  useEffect(() => {
    if (selectionWired && selectableRef.current.size === 0) {
      if (!warnedNoSelectableRef.current) {
        warnedNoSelectableRef.current = true;
        console.warn(
          '[pond-charts] `selected`/`onSelect` is set but no layer has an `id` — ' +
            'nothing is selectable. Give a <BarChart>/<ScatterChart>/<BoxPlot> an ' +
            '`id` to make it interactive (an `id` gates selection + hover).',
        );
      }
    } else {
      warnedNoSelectableRef.current = false;
    }
  }, [selectionWired, selectableKeys]);

  // Hover-highlight: the transient mark under the pointer (distinct from the
  // committed selection). Controlled (`hovered` prop) or uncontrolled (internal),
  // mirroring selection; `onHover` notifies in both modes. Deduped by the mark's
  // full identity so it fires — and the data canvas repaints — only when the
  // hovered mark changes, not on every pointer move (the move itself just slides
  // the SVG cursor, which never touches the data canvas).
  //
  // "Full identity" means `label` and `mark` as well as `id` and `key`, and that
  // is load-bearing rather than belt-and-braces. `key` is the mark's position on
  // the **bin axis**, so any layer that stacks more than one mark in a bin — a
  // stacked bar, a `<HeatMap>` column — has several marks sharing a key, and
  // deduping on `id + key` alone silently swallows every move *within* a bin.
  // On a heat map that reads as the hover being stuck: dragging straight down a
  // column never changes the reported cell.
  // Widened past a single mark for the sweep's live preview (RFC A1.4/A3.4):
  // a drag under a mounted <MultiSelector> lights every covered mark at once
  // through this same field — the reason `hovered` became a set.
  const [internalHovered, setInternalHovered] = useState<
    SelectInfo | readonly SelectInfo[] | null
  >(null);
  const controlledHover = hovered !== undefined;
  // Same three-shape normalization `selected` does — a single mark, a set, or
  // nothing — so a pointer-driven hover (always one mark) and a sweep-driven
  // one (several) reach the draw paths in the same shape (RFC A4.2).
  const hoveredValue: readonly SelectInfo[] = useMemo(() => {
    const raw = controlledHover ? hovered : internalHovered;
    if (raw === null || raw === undefined) return EMPTY_SELECTION;
    return Array.isArray(raw) ? raw : [raw as SelectInfo];
  }, [controlledHover, hovered, internalHovered]);
  const controlledHoverRef = useRef(controlledHover);
  // The last mark we reported — so the callback dedups across pointer moves even
  // in controlled mode, where there's no internal state to compare against.
  const lastHoverRef = useRef<SelectInfo | null>(null);
  useLayoutEffect(() => {
    controlledHoverRef.current = controlledHover;
  });
  // The last resting BLOCK we reported (identity — the row keeps the array
  // reference-stable per block), so <MultiSelector onHover> hears one call per
  // block transition and within-block mark transitions re-render nothing.
  const lastHoverBlockRef = useRef<readonly SelectInfo[] | null>(null);
  // Unlike `select`, this is **not** gated on a mounted `<Selector>`: the
  // hover-highlight is container state (A1.2) and keeps working with none
  // mounted; with none mounted there is simply no `onHover` to fire.
  const setHovered = useCallback(
    (
      hit: SelectInfo | null,
      rowKey?: symbol,
      block?: readonly SelectInfo[],
    ) => {
      const prev = lastHoverRef.current;
      const sameMark =
        prev === hit ||
        (prev !== null &&
          hit !== null &&
          prev.id === hit.id &&
          prev.key === hit.key &&
          prev.label === hit.label &&
          prev.mark === hit.mark);
      const blockNow = block ?? null;
      const sameBlock = lastHoverBlockRef.current === blockNow;
      if (sameMark && sameBlock) return;
      lastHoverRef.current = hit;
      lastHoverBlockRef.current = blockNow;
      for (const e of effectiveSelectorEntries(
        selectorsRef.current,
        rowKey ?? null,
      )) {
        // <Selector onHover> keeps its per-mark currency regardless of any
        // block — the mark under the pointer, per mark transition.
        if (!sameMark) e.onHover?.(hit);
        // A mounted <MultiSelector> hears hover in its own plural currency:
        // the resting BLOCK preview when there is one (per block transition —
        // the marks a drag begun and released here would select), else 0/1
        // hits per mark transition. A live sweep reports through
        // `resolveSweep`'s preview instead, several at once.
        if (blockNow !== null) {
          if (!sameBlock) e.onHoverMany?.(blockNow);
        } else if (!sameMark) {
          e.onHoverMany?.(hit === null ? EMPTY_SELECTION : [hit]);
        }
      }
      // The block (reference-stable per block) is the hovered STATE when
      // present, so every mark in it lights — and a within-block mark
      // transition hands React the same value back (no re-render, no
      // repaint), which is the block-level analog of the single-mark dedup.
      if (!controlledHoverRef.current) setInternalHovered(blockNow ?? hit);
    },
    [],
  );

  // The sweep gesture's container half (interaction RFC §8 / A5.2): resolve a
  // row's press against the mounted <MultiSelector>s in scope and hand the
  // gesture engine its two sinks. Presence is the arm switch — `null` means no
  // sweep can claim the drag (§7.1's mounting-is-enablement, extended). The
  // entries are captured at the press and live for that one drag, matching the
  // ref-not-state discipline of the range drag (#508 item 7).
  const resolveSweep = useCallback((rowKey: symbol) => {
    const entries = effectiveSelectorEntries(
      selectorsRef.current,
      rowKey,
    ).filter((e) => e.multi);
    if (entries.length === 0) return null;
    return {
      // The *declaration*, not a measurement of the block — see the field doc.
      snapped: entries.some((e) => e.sequence !== undefined),
      preview: (hits: readonly SelectInfo[], light = true) => {
        // The single-hit / resting-block dedup state is meaningless mid-sweep;
        // reset both so the first post-sweep pointer hover always reports.
        lastHoverRef.current = null;
        lastHoverBlockRef.current = null;
        // Reporting and lighting are separate on purpose — see the field doc.
        for (const e of entries) e.onHoverMany?.(hits);
        if (!controlledHoverRef.current)
          setInternalHovered(light ? hits : null);
      },
      commit: (
        hits: readonly SelectInfo[],
        modifiers: SelectModifiers,
        span: SpanSelection | null,
      ) => {
        for (const e of entries) e.onSelectMany?.(hits, modifiers, span);
        // Uncontrolled: the compact span descriptor IS the selection (A5.2's
        // second currency) — the swept marks stay lit via the same membership
        // test a controlled span would use. The preview clears; the committed
        // highlight takes over.
        if (!controlledSelectionRef.current)
          setInternalSelected(span === null ? null : [span]);
        lastHoverRef.current = null;
        lastHoverBlockRef.current = null;
        if (!controlledHoverRef.current) setInternalHovered(null);
      },
    };
  }, []);

  // The render-time "is a <MultiSelector> in scope for this row" fact, for the
  // resting block preview (frame doc in context.ts). Unlike `resolveSweep` —
  // a []-stable callback over the selectors REF, correct at pointer-down — a
  // row reads this during render to pick its resting cursor, so it derives
  // from the selectors STATE and re-identifies when the registry changes.
  const hasMultiSelector = useCallback(
    (rowKey: symbol) =>
      effectiveSelectorEntries(selectors, rowKey).some((e) => e.multi),
    [selectors],
  );

  // Rows report their per-slot gutter widths; we reserve each slot's max.
  const [gutters, setGutters] = useState<readonly GutterReq[]>([]);
  const registerGutter = useCallback((req: GutterReq) => {
    setGutters((g) => [...g, req]);
    return () => setGutters((g) => g.filter((x) => x !== req));
  }, []);

  // Rows register on mount so we can mark the first (topmost) one — the shared
  // cursor-time chip shows there only. Effect order = mount order = top-to-bottom
  // for siblings, so the first row registers first (`rowKeys[0]`); this is robust
  // even when rows are wrapped in a fragment/helper component, where an index
  // injected into our direct children wouldn't reach through the wrapper.
  const [rowKeys, setRowKeys] = useState<readonly symbol[]>([]);
  const registerRow = useCallback((key: symbol) => {
    setRowKeys((k) => (k.includes(key) ? k : [...k, key]));
    return () => setRowKeys((k) => k.filter((x) => x !== key));
  }, []);
  const firstRowKey = rowKeys[0] ?? null;

  const leftSlots = useMemo(
    () => maxSlotWidths(gutters.map((g) => g.left)),
    [gutters],
  );
  const rightSlots = useMemo(
    () => maxSlotWidths(gutters.map((g) => g.right)),
    [gutters],
  );
  const leftGutter = sum(leftSlots);
  const rightGutter = sum(rightSlots);
  const plotWidth = Math.max(0, width - leftGutter - rightGutter);

  // The resolved x domain: while panning an explicit domain it's the live view
  // (t0/t1); otherwise the auto-fit extent (→ [0, 1] before any layer registers,
  // the two-pass settle). This is what the scale + cursor + axis read.
  const [d0, d1] =
    explicitDomain !== undefined ? [t0, t1] : (autoExtent ?? [0, 1]);

  // The shared x scale + its two formatting channels, built together so each
  // branch keeps its concrete scale type (no casts): a value axis is a
  // `scaleLinear` formatted by `resolveAxisFormat`, time is a `scaleTime`
  // formatted by d3's multi-scale `resolveTimeFormat`.
  //
  // - `formatTime` is the **label** channel — what `<XAxis>` ticks fall back to
  //   — shaped by `timeFormat` only, never `cursorFormat` (so a readout format
  //   can't move the tick labels). (The name predates the value axis — on a
  //   value axis it formats the value, not a time.)
  // - `formatReadout` is the **readout** channel — the crosshair pill, marker
  //   indicators, and annotation auto-labels — defined only when `cursorFormat`
  //   is set; consumers read `formatReadout ?? <their label formatter>`, which
  //   is how "the readout matches the axis" stays the default.
  // The trading-time provider only applies to a **time** axis — a value axis is
  // always a plain `scaleLinear`. Gate it once here so the scale branch AND the
  // frame (which pan/zoom read) agree: on a value axis the provider is dropped,
  // so interactions use continuous value math, not trading-time math.
  // Resolve the trading-time provider: the low-level `discontinuities` prop wins;
  // otherwise derive it from the high-level `calendar` sugar at the chosen
  // `spacing`. Memoized on `(calendar, spacing)` so a stable calendar yields a
  // stable provider (the scale + frame only rebuild when it actually changes) —
  // pan/zoom read the same provider identity as the low-level path would. Gated
  // on a time axis so a value-axis chart never calls `calendar.discontinuities`.
  const calendarProvider = useMemo(
    () =>
      resolvedKind === 'time' &&
      discontinuities === undefined &&
      calendar !== undefined
        ? calendar.discontinuities(spacing ? { spacing } : undefined)
        : undefined,
    [resolvedKind, discontinuities, calendar, spacing],
  );
  const xDiscontinuities =
    resolvedKind === 'time' ? (discontinuities ?? calendarProvider) : undefined;
  // The shared x-side tick count — labels, x gridlines, session dividers, and
  // `formatTime` all pass this one value, so they derive from the same instants
  // (the alignment previously held by three hardcoded constants agreeing).
  // Time axis (trading or plain — both run the logical tick ladder):
  // width-derived, since the ladder's `count` caps its calendar buckets rather
  // than targeting a tick total; floored at 2 so a pre-layout zero width still
  // requests a drawable tick set. Value/category axes keep the d3 target count.
  const xTickCount =
    resolvedKind === 'time'
      ? Math.max(2, Math.floor(plotWidth / TRADING_TICK_PX))
      : TIME_TICK_COUNT;
  // The elapsed-axis zero point (`origin`), resolved to a number: `'data'` is
  // the start of the data, which before any layer registers falls back to the
  // domain start (the same two-pass settle `resolvedKind` makes). A category
  // axis has no numeric origin to offset from, and a non-finite one is ignored
  // rather than poisoning every tick.
  const elapsedOrigin: number | undefined = useMemo(() => {
    if (origin === undefined || resolvedKind === 'category') return undefined;
    const at = origin === 'data' ? (autoExtent?.[0] ?? d0) : origin;
    return Number.isFinite(at) ? at : undefined;
  }, [origin, resolvedKind, autoExtent, d0]);
  const { xScale, formatTime, formatReadout } = useMemo(() => {
    if (resolvedKind === 'category') {
      // Ordinal column-domain axis: a band scale over the category slots. The
      // domain is **always** `[0, n]` (one unit slot per category) — NOT the
      // resolved `[d0, d1]`: a category axis ignores an explicit `range` (its
      // slots are absolute `0..n`, matching `categoryStack`), so an out-of-`[0,n]`
      // range can't silently offset the labels from the bars. The pixel mapping
      // stays linear; the formatter is the category-name lookup. A category
      // reads by **name** — `cursorFormat` has nothing to format, so the
      // readout channel stays unset.
      const cats = categories ?? [];
      // [PND-BANDPACK] Cap the slot pitch, then place the resulting block. With
      // no cap (or one too loose to bind) `packed === plotWidth` and `offset`
      // is 0, so the range is `[0, plotWidth]` exactly as before — the whole
      // feature collapses to the shipped behaviour when unused.
      const n = cats.length;
      const pitch = n > 0 ? plotWidth / n : plotWidth;
      const capped =
        maxBandWidth !== undefined && maxBandWidth > 0
          ? Math.min(pitch, maxBandWidth)
          : pitch;
      const packed = n > 0 ? capped * n : plotWidth;
      const slack = Math.max(0, plotWidth - packed);
      const offset =
        bandAlign === 'center' ? slack / 2 : bandAlign === 'end' ? slack : 0;
      const s = scaleBand(cats)
        .domain([0, n])
        .range([offset, offset + packed]);
      return {
        xScale: s,
        formatTime: (v: number) => s.label(v),
        formatReadout: undefined,
      };
    }
    if (resolvedKind === 'value') {
      const s = scaleLinear().domain([d0, d1]).range([0, plotWidth]);
      if (elapsedOrigin !== undefined) {
        // Offset (elapsed) value axis: same pixels, ticks anchored at the
        // origin, labels reading `v - origin`. A `timeFormat` / `cursorFormat`
        // number specifier resolves through the *offset* domain (that's what
        // the wrapper's `tickFormat` does), so a specifier describes the number
        // actually on show.
        const e = scaleElapsed(s, { origin: elapsedOrigin, kind: 'value' });
        const labels = resolveAxisFormat(e, xTickCount, timeFormat);
        return {
          xScale: e,
          formatTime: labels,
          formatReadout:
            typeof cursorFormat === 'function'
              ? (v: number) =>
                  cursorFormat(v, { grain: undefined, defaultText: labels(v) })
              : cursorFormat !== undefined
                ? resolveAxisFormat(e, xTickCount, cursorFormat)
                : undefined,
        };
      }
      const labels = resolveAxisFormat(s, xTickCount, timeFormat);
      // The value-axis readout channel: a `cursorFormat` **string** is a d3
      // *number* specifier here (resolved through the linear scale, exactly as
      // a tick format would be); a **function** gets `grain: undefined` (no
      // time grain to hand over) and the label formatter's text as its
      // pass-through default.
      const readout =
        typeof cursorFormat === 'function'
          ? (v: number) =>
              cursorFormat(v, { grain: undefined, defaultText: labels(v) })
          : cursorFormat !== undefined
            ? resolveAxisFormat(s, xTickCount, cursorFormat)
            : undefined;
      return { xScale: s, formatTime: labels, formatReadout: readout };
    }
    // Time axis, label channel: a container `timeFormat` when set (it owns the
    // labels and opts them out of the ladder); else the scale's **grain-aware**
    // default (a day-or-coarser axis reads a date, not a time-of-day — the
    // F-charts-7 `02 AM` fix), never d3's multi-scale default.
    const timeLabels = (s: TradingTimeScale): ((v: number) => string) =>
      timeFormat !== undefined
        ? resolveTimeFormat(s, xTickCount, timeFormat)
        : s.readoutFormat(xTickCount);
    // Time axis, readout channel — only when `cursorFormat` is set (otherwise
    // the readout falls back to the label channel at the consumer). A
    // **function** gets the axis's resolved coarse grain and the grain-aware
    // default text per instant, so it can branch on zoom and pass the default
    // through. A **string** formats uniformly (d3 time specifier).
    const timeReadout = (
      s: TradingTimeScale,
    ): ((v: number) => string) | undefined => {
      if (typeof cursorFormat === 'function') {
        const grain = s.grain(xTickCount);
        const def = s.readoutFormat(xTickCount);
        return (v) => cursorFormat(v, { grain, defaultText: def(v) });
      }
      if (cursorFormat !== undefined) {
        return resolveTimeFormat(s, xTickCount, cursorFormat);
      }
      return undefined;
    };
    // The **elapsed** (duration) flavour of both channels — the same scale
    // wrapped so its ticks are anchored at `at` and its labels are durations.
    // `at` is passed rather than closed over so the caller's `!== undefined`
    // narrowing carries in.
    const elapsedTime = (s: TradingTimeScale, at: number) => {
      const e = scaleElapsed(s, {
        origin: at,
        kind: 'time',
        // An explicit d3 time specifier can only describe an instant, so it
        // labels the wall clock underneath — the wall-clock-strip-under-a-
        // duration-strip lever (see the `origin` prop docs).
        absolute: (count, specifier) => {
          const f = s.tickFormat(count, specifier);
          return (v: number) => f(new Date(v));
        },
      });
      // Labels: durations, unless a container `timeFormat` owns them.
      const labels: (v: number) => string =
        timeFormat !== undefined
          ? resolveTimeFormat(e, xTickCount, timeFormat)
          : e.tickFormat(xTickCount);
      // Readout: one grain finer than the ticks (`00:05:12` under a `00:05`
      // axis) — the elapsed twin of the calendar axis's `readoutFormat`. Set
      // explicitly (not left `undefined` to fall back to the labels) because
      // here the labels ARE the terse tick text: an elapsed axis runs no
      // date-style ladder, so nothing else would restore the precision.
      const fine = e.readoutFormat(xTickCount);
      const readout: (v: number) => string =
        typeof cursorFormat === 'function'
          ? (v) =>
              cursorFormat(v, {
                grain: s.grain(xTickCount),
                defaultText: fine(v),
              })
          : cursorFormat !== undefined
            ? resolveTimeFormat(e, xTickCount, cursorFormat)
            : // A container `timeFormat` shapes the readout too when no
              // `cursorFormat` is set — its documented back-compat behaviour,
              // and the same inversion as the `<XAxis format>` one a rung down:
              // a custom format that owns the labels must own the pill rather
              // than watch the elapsed default overrule it (PR #541 review).
              timeFormat !== undefined
              ? labels
              : fine;
      return { xScale: e, formatTime: labels, formatReadout: readout };
    };
    if (xDiscontinuities !== undefined) {
      // Trading-time axis: closed-market gaps collapse, time proportional within
      // sessions. Same tickFormat surface as scaleTime, so the readout is shared.
      // `xTickCount` reaches `tickFormat` too: the trading scale picks its anchor
      // grain from the count, so labels sit on the exact instants the ticks do.
      const s = scaleTradingTime(xDiscontinuities)
        .domain([d0, d1])
        .range([0, plotWidth]);
      if (elapsedOrigin !== undefined) return elapsedTime(s, elapsedOrigin);
      return {
        xScale: s,
        formatTime: timeLabels(s),
        formatReadout: timeReadout(s),
      };
    }
    // Plain continuous time axis: the same trading-time scale over the
    // gap-free identity provider, so it runs the same logical tick ladder
    // (month starts over a year, clock-aligned hours over an afternoon) —
    // never d3's mixed multi-scale default. Interactions stay on continuous
    // time math: the frame's `discontinuities` remains undefined, and identity
    // distance/offset are plain subtraction/addition anyway.
    const s = scaleTradingTime(identityProvider())
      .domain([d0, d1])
      .range([0, plotWidth]);
    if (elapsedOrigin !== undefined) return elapsedTime(s, elapsedOrigin);
    return {
      xScale: s,
      formatTime: timeLabels(s),
      formatReadout: timeReadout(s),
    };
  }, [
    resolvedKind,
    categories,
    maxBandWidth,
    bandAlign,
    d0,
    d1,
    plotWidth,
    timeFormat,
    cursorFormat,
    elapsedOrigin,
    xDiscontinuities,
    xTickCount,
  ]);

  // The crosshair pixel (see resolveCursorX). A stored hoverX is a *plot* pixel;
  // if plotWidth changes mid-hover (a gutter reserving, or a width change) it's
  // briefly stale until the next pointer move — rare, and the bounds check below
  // hides an out-of-plot crosshair meanwhile.
  const cursorX = resolveCursorX(trackerPosition, hoverX, xScale);

  // `cursor="region"` snap buckets — the intervals the band snaps to (and a drag
  // extends bucket by bucket over). Two sources, in precedence order:
  //
  // 1. **An explicit `cursorSequence`** (time axis only): realized over the view
  //    (a `Sequence` → `.bounded`; a `BoundedSequence` used as-is). A `Sequence`
  //    bucket is a *time* interval, so it's gated to a time axis — realizing time
  //    buckets over a value domain is meaningless (it would shade the whole plot).
  // 2. **A bar/histogram layer's bins** (`binIntervals`, time **or** value axis):
  //    when no `cursorSequence` is set, the region cursor snaps to the bars —
  //    a histogram gets bin-aligned selection for free (the first bar layer that
  //    publishes bins wins; a plain histogram has exactly one).
  //
  // With neither, `undefined` ⇒ the freeform region cursor (raw-span drag).
  const cursorBuckets = useMemo<readonly Interval[] | undefined>(() => {
    if (cursorSequence !== undefined && resolvedKind === 'time') {
      if (!(cursorSequence instanceof Sequence))
        return cursorSequence.intervals();
      // `bounded` (sample 'begin') drops a partial *leading* bucket — the one that
      // contains the view start begins before it. Widen the realized range back by
      // one bucket width so that covering bucket is included (a coarse calendar
      // unit is bounded at ~a year; a fixed step uses its own width).
      const back =
        cursorSequence.kind() === 'fixed'
          ? cursorSequence.stepMs()
          : 366 * 86_400_000;
      return cursorSequence.bounded({ start: d0 - back, end: d1 }).intervals();
    }
    // No sequence → snap to a bar/histogram layer's bins, if any (a value axis,
    // or a time-axis histogram with no explicit sequence). `binIntervals` is only
    // published by a vertical bar layer, so this is a no-op for
    // line/area/scatter rows. On a **category** axis the bins are the unit
    // slots `[i, i+1)`: the region cursor never reads them (its band gates on
    // a continuous axis), but the `<MultiSelector>` sweep's band snaps over
    // them so it runs slot-edge to slot-edge — the band scale's `invert`
    // returns slot *centres*, and a centre-to-centre band disagreed with the
    // snapped-outward span the release commits (RFC A7.6's edge rule).
    //
    // **First bar layer wins** — deliberately non-fatal, unlike `xCategories`
    // (which *throws* when category rows disagree, because a mismatched slot order
    // corrupts the shared band scale). Two overlaid histograms with different bins
    // is a degenerate layout the region cursor just snaps to whichever registered
    // first; a wrong snap grid is harmless where a wrong axis is not.
    for (const s of sources.values()) {
      const bins = s.binIntervals?.() ?? null;
      if (bins && bins.length > 0) return bins;
    }
    return undefined;
  }, [cursorSequence, d0, d1, resolvedKind, sources]);

  // Emit { time, values } for an outside readout — recomputed as the cursor moves
  // *or* the window slides under it (xScale change → new time at the same pixel).
  // Out of the plot (null, or a controlled trackerPosition d3 extrapolated past
  // the edges) → no readout, matching the hidden overlay; the ref guard keeps a
  // not-hovering live chart from spamming `null`.
  const lastNullRef = useRef(false);
  useEffect(() => {
    const cb = onTrackerRef.current;
    if (cb === undefined) return;
    if (cursorX === null || cursorX < 0 || cursorX > plotWidth) {
      if (!lastNullRef.current) cb(null);
      lastNullRef.current = true;
      return;
    }
    lastNullRef.current = false;
    const time = +xScale.invert(cursorX);
    const values = Array.from(sources.values()).flatMap((s) =>
      s.sampleAt(time),
    );
    cb({ time, values });
  }, [cursorX, xScale, sources, plotWidth]);

  // Pack overlapping top-flag labels (markers + regions) into stacked lanes so
  // close-in-x labels don't collide; chips read their lane back off the frame.
  const labelLanes = useMemo(
    () =>
      computeLabelLanes(annotations, (v) => xScale(v), draggingKey, plotWidth),
    [annotations, xScale, draggingKey],
  );

  // The frame's `[d0, d1]` tuple, identity-stable on the endpoints. The frame
  // memo rebuilds whenever any of its (many) fields change — a `hovered`
  // transition, a selection, an annotation edit, a range change — so an inline
  // `[d0, d1]` literal there would mint a fresh array on any such rebuild, and
  // every draw callback listing `container.timeRange` in its deps (Layers'
  // data-canvas draw) would read that as a domain change and replot the row
  // canvas. Memoizing on the endpoints keeps the draw stable across those
  // unrelated rebuilds. (Cursor *position* no longer rebuilds the frame at all —
  // it lives in `cursorFrame` below, [PND-HOVCTX] — but the tuple stays a memo
  // to hold the line for every other rebuild path.)
  const timeRangeTuple = useMemo<readonly [number, number]>(
    () => [d0, d1],
    [d0, d1],
  );

  // The per-move cursor state, split into its own context so a mousemove
  // re-identifies only this small object — not the ~50-field frame below, which
  // stays stable across hovers so `YAxis` / `Bar` / `Box` don't re-render. See
  // [PND-HOVCTX] / {@link CursorContext}.
  const cursorFrame = useMemo<CursorFrame>(
    () => ({
      cursorX,
      cursorY: hoverPoint?.y ?? null,
      cursorRowKey: hoverPoint?.rowKey ?? null,
    }),
    [cursorX, hoverPoint],
  );

  const frame = useMemo<ContainerFrame>(
    () => ({
      timeRange: timeRangeTuple,
      width,
      theme: theme ?? defaultTheme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      setHoverX,
      setHoverY,
      crosshairSnap,
      cursorBuckets,
      regionAnchor,
      previewSpans,
      setPreviewSpans,
      setRegionAnchor,
      onRegionSelect,
      reportDrawStats,
      regionSelectModifier,
      draggingKey,
      setDragging,
      selected: selectedValue,
      selectedSpans,
      select,
      hovered: hoveredValue,
      setHovered,
      cursor,
      cursorTime,
      editAnnotations,
      creating,
      snap,
      onCreate,
      onSelectAnnotation,
      onHoverAnnotation,
      onEditAnnotation,
      formatTime,
      formatReadout,
      xFormatCustom: timeFormat !== undefined,
      xReadoutCustom: cursorFormat !== undefined,
      xTickCount,
      registerTrackerSource,
      unregisterTrackerSource,
      registerSelectable,
      unregisterSelectable,
      registerCursor,
      unregisterCursor,
      cursors,
      registerSelector,
      unregisterSelector,
      resolveSweep,
      hasMultiSelector,
      registerAnnotation,
      unregisterAnnotation,
      registerLegendItem,
      unregisterLegendItem,
      legendItems,
      rowOrder: rowKeys,
      annotations,
      labelLanes,
      xScale,
      xKind: resolvedKind,
      discontinuities: xDiscontinuities,
      grid,
      sessionDividers,
      panEnabled,
      zoomEnabled,
      minDuration,
      applyRange,
      zoomX,
      zoomY,
      panX,
      panY,
      aspectLocked,
      yTransform,
      applyYTransform,
      registerGutter,
      registerRow,
      firstRowKey,
    }),
    [
      timeRangeTuple,
      width,
      theme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      setHoverY,
      crosshairSnap,
      cursorBuckets,
      regionAnchor,
      previewSpans,
      setPreviewSpans,
      setRegionAnchor,
      onRegionSelect,
      reportDrawStats,
      regionSelectModifier,
      draggingKey,
      setDragging,
      selectedValue,
      selectedSpans,
      select,
      hoveredValue,
      setHovered,
      cursor,
      cursorTime,
      editAnnotations,
      creating,
      snap,
      onCreate,
      onSelectAnnotation,
      onHoverAnnotation,
      onEditAnnotation,
      formatTime,
      formatReadout,
      timeFormat,
      cursorFormat,
      xTickCount,
      registerTrackerSource,
      unregisterTrackerSource,
      registerSelectable,
      unregisterSelectable,
      registerCursor,
      unregisterCursor,
      cursors,
      registerSelector,
      unregisterSelector,
      resolveSweep,
      hasMultiSelector,
      registerAnnotation,
      unregisterAnnotation,
      registerLegendItem,
      unregisterLegendItem,
      legendItems,
      rowKeys,
      annotations,
      labelLanes,
      xScale,
      resolvedKind,
      xDiscontinuities,
      grid,
      sessionDividers,
      panEnabled,
      zoomEnabled,
      minDuration,
      applyRange,
      zoomX,
      zoomY,
      panX,
      panY,
      aspectLocked,
      yTransform,
      applyYTransform,
      registerGutter,
      registerRow,
      firstRowKey,
    ],
  );

  return (
    <ContainerContext.Provider value={frame}>
      <CursorContext.Provider value={cursorFrame}>
        {/* The deprecation shim: the container-level legacy `cursor` string
            (or its `'line'` default), synthesized as the equivalent mounted
            preset. Registers as `legacy`, so mounting a cursor component
            overrides it; rows synthesize their own for `<ChartRow cursor>`. */}
        <LegacyCursor
          mode={cursor}
          showTime={cursorTime}
          snap={crosshairSnap}
          sequence={cursorSequenceProp}
          // The 'line' default nobody asked for is IMPLICIT — the one cursor a
          // <MultiSelector>'s resting block preview may replace with the
          // brush band. An explicit `cursor` prop (any mode) still wins.
          implicit={cursorProp === undefined}
        />
        {/* The deprecation shim: the legacy `onSelect`/`onHover` props,
            synthesized as a container-scoped `<Selector>` registration so a
            chart written against them keeps its plot gesture for one more
            minor. Registers as `legacy`, so mounting a real <Selector>
            overrides it — and registers *nothing* when neither prop is set,
            which is what makes RFC §7.1's break detectable. */}
        <LegacySelector onSelect={onSelect} onHover={onHover} />
        <div style={{ width: `${width}px` }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: `${rowGap}px`,
              // The positioned ancestor for overlay chrome (`<Legend>`): the
              // card anchors to the rows block, never the axis strip below.
              position: 'relative',
            }}
          >
            {children}
          </div>
          {showAxis && <TimeAxis />}
        </div>
      </CursorContext.Provider>
    </ContainerContext.Provider>
  );
}
