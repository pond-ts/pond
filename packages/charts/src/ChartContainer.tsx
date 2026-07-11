import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { scaleLinear, scaleTime } from 'd3-scale';
import {
  scaleTradingTime,
  type DiscontinuityProvider,
  type TradingCalendarLike,
} from './tradingTimeScale.js';
import { scaleBand } from './bandScale.js';
import { Sequence, BoundedSequence } from 'pond-ts';
import type { Interval, TimeRange } from 'pond-ts';
import {
  ContainerContext,
  type AnnotationKind,
  type AnnotationSpec,
  type ContainerFrame,
  type CreateSpec,
  type GutterReq,
  type CursorMode,
  type SelectInfo,
  type TrackerInfo,
  type TrackerSource,
} from './context.js';
import { maxSlotWidths, sum } from './slots.js';
import { computeLabelLanes } from './annotations.js';
import { resolveCursorX, DEFAULT_CURSOR_MODE } from './tracker.js';
import {
  resolveAxisFormat,
  resolveTimeFormat,
  type AxisFormat,
} from './format.js';
import { TimeAxis } from './TimeAxis.js';
import { defaultTheme, type ChartTheme } from './theme.js';

/** Time-axis tick count — matches `<TimeAxis>` so the cursor-time formatter is
 *  calibrated as the time-axis labels are. */
const TIME_TICK_COUNT = 5;

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
   */
  discontinuities?: DiscontinuityProvider;
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
   * Controlled tracker position (epoch ms) — pins the synced crosshair across
   * rows. Omit for uncontrolled (the chart tracks the pointer itself); pass
   * `null` to force it hidden. See {@link onTrackerChanged}.
   */
  trackerPosition?: number | null;
  /**
   * In-chart cursor presentation — the default for all rows (a row may override
   * via `<ChartRow cursor>`). **Default `'line'`** — the synced vertical line,
   * with values surfaced *outside* the chart via {@link onTrackerChanged}.
   * `'point'` / `'inline'` / `'flag'` add per-series marks; `'none'` hides it.
   * `'region'` shades the bucket under the pointer (needs {@link cursorSequence}).
   * See {@link CursorMode}.
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
   */
  cursorSequence?: Sequence | BoundedSequence;
  /**
   * Makes the `region` cursor **draggable**: drag across the plot and the band
   * extends **bucket by bucket** (snapping to `cursorSequence` points); on
   * release this fires **once** with the selected `[start, end)` `TimeRange`, and
   * the cursor reverts to the single-bucket highlight (it does not keep the
   * range). Typical use — zoom the view to the returned range (the container
   * doesn't zoom itself; that's the consumer's call).
   *
   * With **no `cursorSequence`** the region cursor is the degenerate case — it
   * renders as a **line** on hover and the drag is **freeform** (raw `[start,
   * end)`, no bucket snapping); the same callback fires on release. No-op unless
   * `cursor="region"` (and a **time** x-axis).
   */
  onRegionSelect?: (range: TimeRange) => void;
  /**
   * Which modifier a region-drag needs — set `'shift'` when you also enable
   * `panZoom` and want **plain drag to pan, shift-drag to select**. It's only
   * enforced while `panZoom` is on (with pan off there's no gesture conflict, so
   * shift is optional — either drag selects). **Omitted** ⇒ a region-drag
   * **preempts** pan (drag always selects; document that precedence for users).
   * Wheel-zoom is unaffected in every case.
   */
  regionSelectModifier?: 'shift';
  /**
   * Fires on pointer move with the hovered time + every series' value there (so
   * you can render a readout outside the chart), and `null` on leave.
   */
  onTrackerChanged?: (info: TrackerInfo | null) => void;
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
   */
  selected?: SelectInfo | null;
  /**
   * Fires when a selectable layer's mark is clicked, with the hit mark, or `null`
   * when a click misses every mark (or hits a layer with no `id` — display-only,
   * so it reads as empty space). Notification only — works in both controlled and
   * uncontrolled mode. If this or `selected` is set but no layer has an `id`, a
   * dev-warning notes that nothing is selectable.
   */
  onSelect?: (hit: SelectInfo | null) => void;
  /**
   * Controlled hover-highlight — the transiently lit mark (echo the `onHover` arg
   * back), or `null`. **Omitted ⇒ uncontrolled** (the pointer over a selectable
   * layer manages it internally). The hover analog of {@link selected}: pass it to
   * **pin** a lit mark from outside the chart (e.g. hovering a legend / list row
   * lights the matching {@link BarChart} bar). Only layers with a hover-highlight
   * (currently `BarChart`) render it; keyed by the same {@link SelectInfo} identity
   * as selection.
   */
  hovered?: SelectInfo | null;
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
   */
  onHover?: (hit: SelectInfo | null) => void;
  /**
   * Enable pan/zoom: drag the plot to pan the time range, wheel to zoom around
   * the cursor. **Default off** — so it doesn't capture drag/scroll unless asked.
   */
  panZoom?: boolean;
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
   * Time-axis value formatting — a d3 time specifier string (e.g. `'%H:%M'`) or a
   * `(epochMs) => string` function ({@link AxisFormat}); applies to both the time
   * axis labels and the cursor-time readout. **Omitted ⇒ d3's multi-scale time
   * format** (`12 PM`, `12:10`, …).
   */
  timeFormat?: AxisFormat;
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
  width,
  rowGap = 0,
  showAxis = true,
  trackerPosition,
  onTrackerChanged,
  selected,
  onSelect,
  hovered,
  onHover,
  panZoom = false,
  onTimeRangeChange,
  minDuration = 1,
  cursor = DEFAULT_CURSOR_MODE,
  cursorSequence,
  onRegionSelect,
  regionSelectModifier,
  cursorTime = false,
  crosshairSnap = true,
  editAnnotations = false,
  creating = null,
  onCreate,
  onSelectAnnotation,
  onHoverAnnotation,
  onEditAnnotation,
  snap = true,
  timeFormat,
  theme,
  discontinuities,
  calendar,
  spacing,
  children,
}: ChartContainerProps) {
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
  const uncontrolled = panZoom && onTimeRangeChange === undefined;
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
  const applyRange = useCallback((range: [number, number]) => {
    const cb = onRangeRef.current;
    if (cb) cb(range);
    else setInternalRange(range);
  }, []);

  // Cross-row tracker. We store the cursor's plot-pixel x (not a timestamp), so a
  // still cursor stays put while a live window slides under it; a controlled
  // `trackerPosition` resolves to a pixel below.
  const [hoverX, setHoverX] = useState<number | null>(null);
  // The region-cursor drag anchor (epoch ms) — set on press, cleared on release.
  const [regionAnchor, setRegionAnchor] = useState<number | null>(null);
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

  // Selection: controlled (`selected` prop) or uncontrolled (internal). A click
  // on a selectable layer calls `select()` after hit-testing; `onSelect` notifies
  // in both modes, the internal state is managed only when uncontrolled. The full
  // SelectInfo is the identity (key + series), so multi-series marks at one
  // timestamp stay distinct. Refs written after commit (not in render) so the
  // click handler never reads a callback / mode from a frame abandoned under
  // concurrent rendering.
  const [internalSelected, setInternalSelected] = useState<SelectInfo | null>(
    null,
  );
  const controlledSelection = selected !== undefined;
  const selectedValue = controlledSelection
    ? (selected ?? null)
    : internalSelected;
  const onSelectRef = useRef(onSelect);
  const controlledSelectionRef = useRef(controlledSelection);
  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
    controlledSelectionRef.current = controlledSelection;
  });
  const select = useCallback((hit: SelectInfo | null) => {
    onSelectRef.current?.(hit);
    if (!controlledSelectionRef.current) setInternalSelected(hit);
  }, []);

  // Dev-warn: selection is wired (`selected` and/or `onSelect`) but no layer
  // carries an `id`, so nothing is selectable — `id` gates interactivity, so a
  // consumer who forgot it gets a silent no-op click without this nudge. Fires
  // once per wired-but-empty transition (guarded by a ref); child layers
  // register before this parent effect runs, so the set is settled here.
  const selectionWired = controlledSelection || onSelect !== undefined;
  const warnedNoSelectableRef = useRef(false);
  useEffect(() => {
    if (selectionWired && selectableRef.current.size === 0) {
      if (!warnedNoSelectableRef.current) {
        warnedNoSelectableRef.current = true;
        console.warn(
          '[pond-charts] `selected`/`onSelect` is set but no layer has an `id` — ' +
            'nothing is selectable. Give a <BarChart>/<ScatterChart> an `id` to ' +
            'make it interactive (an `id` gates selection + hover).',
        );
      }
    } else {
      warnedNoSelectableRef.current = false;
    }
  }, [selectionWired, selectableKeys]);

  // Hover-highlight: the transient mark under the pointer (distinct from the
  // committed selection). Controlled (`hovered` prop) or uncontrolled (internal),
  // mirroring selection; `onHover` notifies in both modes. Deduped by key+label
  // so it fires — and the data canvas repaints — only when the hovered mark
  // changes, not on every pointer move (the move itself just slides the SVG
  // cursor, which never touches the data canvas).
  const [internalHovered, setInternalHovered] = useState<SelectInfo | null>(
    null,
  );
  const controlledHover = hovered !== undefined;
  const hoveredValue = controlledHover ? (hovered ?? null) : internalHovered;
  const onHoverRef = useRef(onHover);
  const controlledHoverRef = useRef(controlledHover);
  // The last mark we reported — so the callback dedups across pointer moves even
  // in controlled mode, where there's no internal state to compare against.
  const lastHoverRef = useRef<SelectInfo | null>(null);
  useLayoutEffect(() => {
    onHoverRef.current = onHover;
    controlledHoverRef.current = controlledHover;
  });
  const setHovered = useCallback((hit: SelectInfo | null) => {
    const prev = lastHoverRef.current;
    const same =
      prev === hit ||
      (prev !== null &&
        hit !== null &&
        prev.id === hit.id &&
        prev.key === hit.key);
    if (same) return;
    lastHoverRef.current = hit;
    onHoverRef.current?.(hit);
    if (!controlledHoverRef.current) setInternalHovered(hit);
  }, []);

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

  // The shared x scale + the formatter for its ticks / cursor readout, built
  // together so each branch keeps its concrete scale type (no casts): a value
  // axis is a `scaleLinear` formatted by `resolveAxisFormat`, time is a
  // `scaleTime` formatted by d3's multi-scale `resolveTimeFormat`. `formatTime`
  // is the one formatter <TimeAxis> + the cursor readout share, so a tick and
  // the cursor read identically. (The `formatTime` name predates the value axis
  // — on a value axis it formats the value, not a time.)
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
  const { xScale, formatTime } = useMemo(() => {
    if (resolvedKind === 'category') {
      // Ordinal column-domain axis: a band scale over the category slots. The
      // domain is **always** `[0, n]` (one unit slot per category) — NOT the
      // resolved `[d0, d1]`: a category axis ignores an explicit `range` (its
      // slots are absolute `0..n`, matching `categoryStack`), so an out-of-`[0,n]`
      // range can't silently offset the labels from the bars. The pixel mapping
      // stays linear; the formatter is the category-name lookup.
      const cats = categories ?? [];
      const s = scaleBand(cats).domain([0, cats.length]).range([0, plotWidth]);
      return { xScale: s, formatTime: (v: number) => s.label(v) };
    }
    if (resolvedKind === 'value') {
      const s = scaleLinear().domain([d0, d1]).range([0, plotWidth]);
      return {
        xScale: s,
        formatTime: resolveAxisFormat(s, TIME_TICK_COUNT, timeFormat),
      };
    }
    if (xDiscontinuities !== undefined) {
      // Trading-time axis: closed-market gaps collapse, time proportional within
      // sessions. Same tickFormat surface as scaleTime, so the readout is shared.
      const s = scaleTradingTime(xDiscontinuities)
        .domain([d0, d1])
        .range([0, plotWidth]);
      return {
        xScale: s,
        formatTime: resolveTimeFormat(s, TIME_TICK_COUNT, timeFormat),
      };
    }
    const s = scaleTime().domain([d0, d1]).range([0, plotWidth]);
    return {
      xScale: s,
      formatTime: resolveTimeFormat(s, TIME_TICK_COUNT, timeFormat),
    };
  }, [
    resolvedKind,
    categories,
    d0,
    d1,
    plotWidth,
    timeFormat,
    xDiscontinuities,
  ]);

  // The crosshair pixel (see resolveCursorX). A stored hoverX is a *plot* pixel;
  // if plotWidth changes mid-hover (a gutter reserving, or a width change) it's
  // briefly stale until the next pointer move — rare, and the bounds check below
  // hides an out-of-plot crosshair meanwhile.
  const cursorX = resolveCursorX(trackerPosition, hoverX, xScale);

  // `cursor="region"` buckets: realize the `cursorSequence` over the current view
  // (a `Sequence` → `.bounded`; a `BoundedSequence` used as-is), so the band can
  // find the interval under the pointer. Memoized on the sequence + view range;
  // a coarse sequence (days / sessions) is a handful of intervals.
  // A `Sequence` bucket is a **time** interval, so gate it to a time axis — on a
  // value axis (a horizontal histogram, a value-keyed chart) the value domain is
  // not epoch-ms, so realizing time buckets over it is meaningless (it would
  // shade the whole plot). Region cursor is time-axis only.
  const cursorBuckets = useMemo<readonly Interval[] | undefined>(() => {
    if (cursorSequence === undefined || resolvedKind !== 'time')
      return undefined;
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
  }, [cursorSequence, d0, d1, resolvedKind]);

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
    () => computeLabelLanes(annotations, (v) => xScale(v), draggingKey),
    [annotations, xScale, draggingKey],
  );

  const frame = useMemo<ContainerFrame>(
    () => ({
      timeRange: [d0, d1],
      width,
      theme: theme ?? defaultTheme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      cursorX,
      setHoverX,
      cursorY: hoverPoint?.y ?? null,
      cursorRowKey: hoverPoint?.rowKey ?? null,
      setHoverY,
      crosshairSnap,
      cursorBuckets,
      regionAnchor,
      setRegionAnchor,
      onRegionSelect,
      regionSelectModifier,
      draggingKey,
      setDragging,
      selected: selectedValue,
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
      registerTrackerSource,
      unregisterTrackerSource,
      registerSelectable,
      unregisterSelectable,
      registerAnnotation,
      unregisterAnnotation,
      annotations,
      labelLanes,
      xScale,
      xKind: resolvedKind,
      discontinuities: xDiscontinuities,
      panZoom,
      minDuration,
      applyRange,
      registerGutter,
      registerRow,
      firstRowKey,
    }),
    [
      d0,
      d1,
      width,
      theme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      cursorX,
      hoverPoint,
      setHoverY,
      crosshairSnap,
      cursorBuckets,
      regionAnchor,
      setRegionAnchor,
      onRegionSelect,
      regionSelectModifier,
      draggingKey,
      setDragging,
      selectedValue,
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
      registerTrackerSource,
      unregisterTrackerSource,
      registerSelectable,
      unregisterSelectable,
      registerAnnotation,
      unregisterAnnotation,
      annotations,
      labelLanes,
      xScale,
      resolvedKind,
      xDiscontinuities,
      panZoom,
      minDuration,
      applyRange,
      registerGutter,
      registerRow,
      firstRowKey,
    ],
  );

  return (
    <ContainerContext.Provider value={frame}>
      <div style={{ width: `${width}px` }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: `${rowGap}px`,
          }}
        >
          {children}
        </div>
        {showAxis && <TimeAxis />}
      </div>
    </ContainerContext.Provider>
  );
}
