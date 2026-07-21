import { createContext } from 'react';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import type { ChartTheme } from './theme.js';
import type { AxisFormat } from './format.js';
// Type-only (erased at runtime): swatch.ts imports RowContext from here, so a
// value import in this direction would be a cycle; a type import is not.
import type { LegendItemSpec } from './swatch.js';
import type { Interval } from 'pond-ts';
import type {
  TradingTimeScale,
  DiscontinuityProvider,
} from './tradingTimeScale.js';
import type { ScaleBand } from './bandScale.js';

/**
 * The frame a {@link ChartContainer} provides to its rows and the time axis.
 * The container owns the **shared x geometry**: each side is split into *slots*
 * (one axis column each, indexed from the plot outward — slot 0 nearest the
 * plot), and the container reserves each slot's max width across rows (see
 * {@link GutterReq}). The slot sums (`leftGutter`/`rightGutter`) are uniform, so
 * every row's plot left-aligns under one time axis; `plotWidth` and the shared
 * time→pixel `xScale` follow. Y scales stay per-row (row-local data), on the
 * {@link RowFrame}.
 */
/** Where a top-flag label sits: its lane (0 = top; overlapping labels stack
 *  down) and the chip text to render — the merged label for the representative of
 *  a coincident-marker group, `null` for the members folded into it, else the
 *  mark's own label. Computed by `computeLabelLanes`. */
export interface LabelPlacement {
  readonly lane: number;
  readonly label: string | null;
}

export interface ContainerFrame {
  readonly timeRange: readonly [number, number];
  readonly width: number;
  readonly theme: ChartTheme;
  /** Plot width in px after the gutters — shared by every row. */
  readonly plotWidth: number;
  /**
   * Reserved width of each left/right slot, slot 0 nearest the plot. A row
   * aligns its axis toward the plot within its slot's reserved width and pads
   * the outer slots it lacks. `leftGutter`/`rightGutter` are the sums.
   */
  readonly leftSlots: readonly number[];
  readonly rightSlots: readonly number[];
  /** Total reserved gutter each side (sum of the slot widths) — the plot offsets. */
  readonly leftGutter: number;
  readonly rightGutter: number;
  /** Vertical space between rows in px (not under the time axis). */
  readonly rowGap: number;
  /**
   * The crosshair's **plot-pixel x** (`0..plotWidth`), shared across rows so the
   * tracker syncs, or `null` when not hovering. A *pixel*, not a timestamp — so a
   * still cursor stays put while a live window slides under it (a stored
   * timestamp would drift sideways as `xScale` changes). A controlled
   * `trackerPosition` (a timestamp) resolves to a pixel here.
   */
  readonly cursorX: number | null;
  /** Set the hovered plot-pixel x; a row's event surface calls this on pointer move. */
  setHoverX(x: number | null): void;
  /**
   * The hovered plot-pixel **y** and the row it's in — for the free-form
   * crosshair's horizontal line + value readout (which are row-specific, unlike
   * the shared vertical `cursorX`). `null` when not hovering a plot. Hover-driven
   * only (no controlled equivalent).
   */
  readonly cursorY: number | null;
  readonly cursorRowKey: symbol | null;
  /** Set the hovered plot-pixel y + its row; the event surface calls this on move. */
  setHoverY(y: number | null, rowKey: symbol | null): void;
  /**
   * `cursor="crosshair"` **y** snapping. **Default `true`** — the reticle centres
   * on the nearest data point's value. `false` — the y follows the pointer freely
   * (`yScale.invert`). The x always snaps to the data grid either way.
   */
  readonly crosshairSnap: boolean;
  /**
   * `cursor="region"` buckets — the intervals (from `cursorSequence`) realized
   * over the current view, sorted + non-overlapping. `Layers` finds the one under
   * the pointer and shades it (mapped through `xScale`, so on a trading-time axis
   * the closed part of the bucket collapses). `undefined` when no `cursorSequence`
   * is set.
   */
  readonly cursorBuckets: readonly Interval[] | undefined;
  /**
   * The `region`-cursor **drag anchor** in axis units (epoch ms on a time axis,
   * the axis value on a value axis), or `null` when not dragging. A drag on a
   * region cursor (only when {@link onRegionSelect} is set) records the press
   * position here; the band then spans from the anchor's bucket to the pointer's
   * bucket (extending bucket by bucket), or freeform when there are no buckets.
   * Cleared on release.
   */
  readonly regionAnchor: number | null;
  /** Set / clear the region-drag anchor (see {@link regionAnchor}). */
  setRegionAnchor(value: number | null): void;
  /**
   * One-shot callback fired when a `region`-cursor **drag** is released, with the
   * selected `[lo, hi]` span in **axis units** — epoch ms on a time axis, the axis
   * value on a value axis (snapped to the `cursorSequence` buckets when present,
   * else the raw drag span). The neutral numeric pair mirrors the container's
   * polymorphic `range` input (which never takes the axis *kind* from its value);
   * a time-axis consumer who wants a `TimeRange` constructs one from the pair.
   * Providing it is what makes the region cursor **draggable**; the cursor does
   * not keep the range (it reverts to the single-bucket highlight). Typical use:
   * zoom the view, or map the span onto a subscription's range params.
   */
  readonly onRegionSelect:
    | ((range: readonly [number, number]) => void)
    | undefined;
  /**
   * A stable sink for per-repaint {@link DrawStatsFrame}s, or `undefined` when no
   * `onDrawStats` consumer is subscribed — the `undefined` is the signal for
   * `Layers` to skip per-layer timing entirely (zero overhead when unused). The
   * identity is stable while subscribed (it reads a ref), so an inline
   * `onDrawStats` arrow doesn't thrash the draw memo.
   */
  readonly reportDrawStats: ((frame: DrawStatsFrame) => void) | undefined;
  /**
   * Require a modifier key held to start a region-drag — set to `'shift'` to make
   * plain drag **pan** and **shift**-drag select, when `panZoom` is on. Only
   * enforced while pan is enabled (with no pan there's no gesture to share, so the
   * modifier is optional). `undefined` ⇒ a region-drag preempts pan.
   */
  readonly regionSelectModifier: 'shift' | undefined;
  /**
   * The selected mark, or `null`. Shared across rows (single selection). A layer
   * highlights the mark matching the selection's series **`id`** and the clicked
   * sample `key` (epoch ms) — the `id` picks the series (so two series sharing a
   * timestamp don't both light up), the `key` picks the mark within it. A
   * controlled `selected` prop pins it; otherwise a click on a selectable layer
   * (one with an `id`) sets it.
   */
  readonly selected: SelectInfo | null;
  /**
   * Select a mark, or `null` to clear — a row's click surface calls this after
   * hit-testing its layers. Always fires `onSelect`; manages the internal
   * selection only when uncontrolled (no `selectedKey` prop). The split mirrors
   * the tracker's `trackerPosition` (controlled by a *value* prop) + its
   * `onTrackerChanged` notification — not `applyRange`, which is controlled by
   * the presence of a *callback*.
   */
  select(hit: SelectInfo | null): void;
  /**
   * The **hovered** mark, or `null` — the transient hover-highlight, distinct
   * from the committed `selected`. A row's pointer-move surface hit-tests its
   * selectable layers and sets it; a layer that supports hover-highlight (Bar)
   * draws the matching mark lit (a lighter treatment than `selected`'s outline).
   * Set-on-change (deduped by the series `id` + sample `key`) so the data canvas
   * repaints only on a mark transition, not every pointer move.
   */
  readonly hovered: SelectInfo | null;
  /** Set the hovered mark (or `null` to clear) from a pointer-move hit-test;
   *  deduped by series `id` + sample `key`, so an unchanged mark is a no-op
   *  (no repaint). */
  setHovered(hit: SelectInfo | null): void;
  /** The default in-chart cursor presentation for all rows ({@link CursorMode});
   *  a row may override it via its own `cursor`. */
  readonly cursor: CursorMode;
  /** Show the cursor's time atop the in-chart readout (when a row's cursor draws
   *  one), formatted by {@link formatReadout} (else {@link formatTime}, matching
   *  the time axis). */
  readonly cursorTime: boolean;
  /**
   * Whether the chart is in **annotation-edit mode** — suppresses the data cursor
   * and makes editable annotations interactive (hovering reveals their handles +
   * highlights them, dragging edits them). Set by the container's
   * `editAnnotations` prop; annotations read it to switch from inert to interactive.
   */
  readonly editAnnotations: boolean;
  /** Format an epoch-ms instant the same way the time axis labels its ticks —
   *  shared by `<TimeAxis>` and (absent {@link formatReadout}) the cursor-time
   *  readout. Shaped by the container `timeFormat` only, never `cursorFormat`. */
  readonly formatTime: (epochMs: number) => string;
  /**
   * The **readout** channel — defined only when the container's `cursorFormat`
   * is set (time or value axis; a category axis reads names). Readout
   * consumers — the crosshair x pill and in-plot cursor time, marker axis
   * indicators, annotation auto-labels — read `formatReadout ?? <their label
   * formatter>`, so the readout can be shaped (or made more precise than the
   * tick labels) without moving them.
   */
  readonly formatReadout?: ((value: number) => string) | undefined;
  /** Whether an explicit container `timeFormat` shaped {@link formatTime}. The
   *  x axis suppresses its boundary (second) label row when it's set — a
   *  custom format owns the whole label, so the ladder mustn't second-line it. */
  readonly xFormatCustom: boolean;
  /**
   * The shared **x-side tick count** — the `count` every x-side `ticks()` /
   * `tickFormat()` call passes (`<XAxis>` labels, the canvas x gridlines and
   * session dividers, {@link formatTime}), so labels, grid, and dividers all
   * derive from the same instants. A fixed default on a continuous axis;
   * **width-derived on a trading-time axis**, where the count caps how many
   * calendar buckets `coarsenCalendar` may keep — a fixed small count would
   * coarsen any long daily view to year grain (2 ticks) no matter how wide
   * the plot is.
   */
  readonly xTickCount: number;
  /**
   * Register a draw layer as a tracker source so the container can fan in every
   * series' value at the cursor for `onTrackerChanged`. Keyed by the layer's
   * per-instance slot key; unregister on unmount.
   */
  registerTrackerSource(key: symbol, source: TrackerSource): void;
  unregisterTrackerSource(key: symbol): void;
  /**
   * Register this layer as **selectable** — a layer calls this (keyed by its
   * per-instance slot) only when it was given an `id`, so the container knows at
   * least one series can be selected. Powers the dev-warn when `selected` /
   * `onSelect` are wired but no layer carries an `id`. Unregister on unmount.
   */
  registerSelectable(key: symbol): void;
  unregisterSelectable(key: symbol): void;
  /**
   * Register this layer's **legend row** — its display label + resolved
   * {@link SwatchSpec} (and selection `id` when it has one) — keyed by the
   * layer's per-instance slot; unregister on unmount (see
   * {@link useLegendItems}). `<Legend>` renders this registry in
   * {@link rowOrder}-then-declaration order, deduped by `id ?? label`; a layer
   * that opted out (`legend={false}`) simply never registers.
   */
  registerLegendItem(key: symbol, item: LegendItemSpec): void;
  unregisterLegendItem(key: symbol): void;
  /** The registered legend rows, keyed by layer slot (see
   *  {@link registerLegendItem}). */
  readonly legendItems: ReadonlyMap<symbol, LegendItemSpec>;
  /**
   * The chart rows' keys in **display (top-to-bottom) order** — mount order,
   * exactly the ordering {@link firstRowKey} is head of. `<Legend>` sorts its
   * rows by this so a two-row chart lists the top row's series first.
   */
  readonly rowOrder: readonly symbol[];
  /**
   * Shared x→pixel scale, range `[0, plotWidth]`. A d3 `scaleTime` (default) so
   * ticks land on wall-clock boundaries, or a `scaleLinear` when the data is
   * value-keyed (a **value axis** — distance, cumulative work; see {@link xKind}).
   * The domain is the container's resolved `range` (auto-fit if omitted). Both
   * scales are callable
   * (`value → px`) and expose `invert`/`ticks`/`tickFormat`; consumers use only
   * that shared surface (the cursor coerces `invert` via `+`, `<TimeAxis>` keys
   * ticks via `+d`), so either kind drops in. A **`scaleTradingTime`** (when the
   * container is given `discontinuities`) is the third kind — same callable /
   * `invert` / `ticks` / `tickFormat` surface, but the mapping runs through
   * trading time so closed-market gaps collapse (see {@link discontinuities}).
   */
  readonly xScale:
    | ScaleTime<number, number>
    | ScaleLinear<number, number>
    | TradingTimeScale
    | ScaleBand;
  /**
   * The discontinuity provider backing a **trading-time** x axis, if one was
   * supplied to the container — closed-market time (weekends, holidays,
   * overnight, lunch breaks) collapsed. `undefined` for a normal continuous
   * time / value axis. Pan and zoom read it to move the view in *trading* time
   * rather than raw wall-clock ms.
   */
  readonly discontinuities?: DiscontinuityProvider | undefined;
  /** Draw the reference gridlines behind the data (default `true`; the
   *  container's `grid` prop). Session dividers are independent of this. */
  readonly grid: boolean;
  /** Where session dividers draw on a trading axis: `'none'` (the default —
   *  the hierarchical grid already marks calendar structure), `'all'` (every
   *  session boundary in view — the TradingView separator look), or
   *  `'labeled'` (only under labelled collapse points). */
  readonly sessionDividers: 'labeled' | 'all' | 'none';
  /**
   * The resolved kind of the shared x scale — `'time'` (a `scaleTime`),
   * `'value'` (a `scaleLinear`), or `'category'` (a {@link ScaleBand}: an ordinal
   * column-domain axis, one slot per category). Inferred from the layers' data.
   * `<XAxis>` reads it to pick its default tick formatter (time / number / the
   * category label), and the cursor readout to format the x position.
   */
  readonly xKind: 'time' | 'value' | 'category';
  /** Pan/zoom enabled — the plot drag-pans and wheel-zooms the shared time range. */
  readonly panZoom: boolean;
  /** Minimum visible duration (ms) — the zoom-in floor. */
  readonly minDuration: number;
  /**
   * Apply a new view range from a pan/zoom gesture. Routes to `onTimeRangeChange`
   * (controlled) or the container's internal view state (uncontrolled). Only
   * called while `panZoom` is on.
   */
  applyRange(range: readonly [number, number]): void;
  /**
   * A row reports its per-slot gutter widths each side; the container reserves
   * each slot's max so every row's plot left-aligns. Returns an unregister fn.
   */
  registerGutter(req: GutterReq): () => void;
  /**
   * A row registers on mount so the container can identify the **first** (top)
   * row by mount/DOM order — its key becomes {@link firstRowKey}. Used to show
   * the shared cursor-time chip once, atop the first row, not repeated per row.
   * Keyed by the row's per-instance `useSlotKey` symbol; returns an unregister fn.
   */
  registerRow(key: symbol): () => void;
  /** The first (topmost) row's key, or `null` before any row has registered. */
  readonly firstRowKey: symbol | null;
  /**
   * Register an annotation (`<Region>`/`<Marker>`/`<Baseline>`) so the container
   * can coordinate what a mark can't do in isolation: draw each mark's **guide
   * line** across the *other* rows, resolve cross-region z-order, and serve
   * **snap targets** to a drag. Keyed by the mark's per-instance slot key;
   * unregister on unmount.
   */
  registerAnnotation(key: symbol, spec: AnnotationSpec): void;
  unregisterAnnotation(key: symbol): void;
  /** Every registered annotation — read by each row to draw the *other* rows'
   *  guides, and by a drag to find snap targets. */
  readonly annotations: readonly AnnotationSpec[];
  /** Per-key top-flag {@link LabelPlacement} — the lane (0 = top; overlapping
   *  labels stack down) + the chip text (merged for the representative of a
   *  coincident-marker group, `null` for the folded-in members). A key absent
   *  from the map sits at lane 0 with its own label. */
  readonly labelLanes: ReadonlyMap<symbol, LabelPlacement>;
  /**
   * The annotation currently being **dragged** (its slot key), or `null`. Set on
   * drag-start, cleared on release. The lane packers (label lanes + x-axis pill
   * lanes) exclude it so the *static* marks don't reshuffle as the dragged one
   * crosses them — only the mark under the pointer moves; it settles on release.
   */
  readonly draggingKey: symbol | null;
  /** Mark/clear the actively-dragged annotation; a mark's drag calls this. */
  setDragging(key: symbol | null): void;
  /**
   * The armed creation tool, or `null` (idle). Set by the consumer's toolbar;
   * when non-null the plot captures a **create gesture** (draw a new mark) instead
   * of panning, and fires {@link onCreate} on release. While armed, existing
   * marks' edit handles stand down so the draw owns the surface.
   */
  readonly creating: AnnotationKind | null;
  /**
   * Snap mode — the toolbar's "Snap". When on, a dragged mark snaps to other
   * marks' **guidelines** (their x-positions) so spans align; off = free
   * placement. Read by {@link snapToGuides}. (Data-sample snapping — landing on a
   * clean `5:12` rather than `5:11:47` — is a future extension, not yet wired.)
   */
  readonly snap: boolean;
  /** Fired when a create gesture completes (on release). The consumer adds the
   *  mark, disarms ({@link creating} → `null`), and selects it. `undefined` ⇒
   *  creation is a no-op (the gesture still previews but commits nothing). */
  readonly onCreate: ((spec: CreateSpec) => void) | undefined;
  /** Fired when a mark is clicked (reports its `id`) or the plot is clicked empty
   *  (`null`) — the consumer updates its selection. A double-click on a region
   *  fires it too (the shortcut into a focused edit). */
  readonly onSelectAnnotation: ((id: string | null) => void) | undefined;
  /** Fired when the pointer enters a mark (reports its `id`) or leaves it (`null`),
   *  so the consumer can mirror hover out-of-band (e.g. a legend row). Pairs with a
   *  mark's controlled `hovered` prop to sync hover both ways. Works in any mode. */
  readonly onHoverAnnotation: ((id: string | null) => void) | undefined;
  /** Fired when a mark is **double-clicked** — the request to edit just that one.
   *  The consumer flips it into single-annotation edit (sets its `editing` prop),
   *  while the rest stay static. Distinct from {@link onSelectAnnotation} (single
   *  click = inspect-select). Works in any mode. */
  readonly onEditAnnotation: ((id: string) => void) | undefined;
}

/** The kind of an annotation, and of a creation tool. */
export type AnnotationKind = 'region' | 'marker' | 'baseline';

/** What a completed create gesture reports to {@link ContainerFrame.onCreate} —
 *  the new mark's kind + position in axis units (+ the y-axis id for a baseline).
 *  (Which row a mark lands on is the consumer's call for now; multi-row routing is
 *  a follow-up.) */
export type CreateSpec =
  | { readonly kind: 'marker'; readonly at: number }
  | { readonly kind: 'baseline'; readonly value: number; readonly axis: string }
  | { readonly kind: 'region'; readonly from: number; readonly to: number };

/**
 * A registered annotation as the container sees it — enough to draw its guide
 * line on other rows, order it against other marks, and offer it as a snap target.
 */
export interface AnnotationSpec {
  /** The mark's per-instance slot key — its identity in the registry. */
  readonly key: symbol;
  /** The consumer's stable id (its `id` prop), if any — what a click /
   *  double-click reports via {@link ContainerFrame.onSelectAnnotation}, so the
   *  consumer knows which mark to select. */
  readonly id: string | undefined;
  readonly kind: AnnotationKind;
  /** The row it lives on (its `<ChartRow>`'s key), so a row skips its own marks
   *  when drawing guides. */
  readonly rowKey: symbol;
  /**
   * Its vertical-guide x-position(s) in **axis units** (the shared x): a marker's
   * `[at]`, a region's `[from, to]`. Empty for a baseline — a horizontal line
   * casts no vertical guide.
   */
  readonly xs: readonly number[];
  /** Whether it's currently selected (controlled by the consumer). */
  readonly selected: boolean;
  /** Whether it's in single-annotation edit (the double-click target). The plot
   *  suppresses the data cursor while any mark is editing, as it does in global
   *  edit mode. */
  readonly editing: boolean;
  /** Whether it accepts hover + selection. A non-selectable region is skipped by
   *  the double-click hit-test (it's inert background context). */
  readonly selectable: boolean;
  /** The mark's resolved label text — used to pack overlapping top-flag labels
   *  (markers + regions) into stacked vertical lanes. */
  readonly label: string;
  /** Whether this mark shows its value as an **axis-edge pill** — a marker on the
   *  shared x-axis (drawn by `<XAxis>` at its `at`), a baseline on its y-axis
   *  (drawn in place). Regions never set it. */
  readonly indicator: boolean;
}

/**
 * A row's per-slot axis widths each side, **slot 0 nearest the plot** (so the
 * innermost axis aligns across rows). A row with `k` axes on a side fills slots
 * `0..k-1`; it has no entry for the outer slots, which it pads.
 */
export interface GutterReq {
  readonly left: readonly number[];
  readonly right: readonly number[];
}

export const ContainerContext = createContext<ContainerFrame | null>(null);

/**
 * What a {@link RowLayer.draw} may return so the container can report render
 * cost + whether M4 decimation engaged this frame ({@link
 * ContainerProps.onDrawStats}). Optional — a layer that returns `void` reports
 * only its `drawMs` (the render loop times every layer regardless).
 */
export interface LayerDrawStats {
  /** Source series length the draw received (pre-cull, pre-decimation). */
  readonly sourceCount: number;
  /** Points / marks actually drawn this frame — after viewport culling and, if
   *  it engaged, M4 decimation. `drawnCount === sourceCount` with `decimated`
   *  false ⇒ neither fired (everything in view was drawn). */
  readonly drawnCount: number;
  /** Whether M4 decimation engaged (vs. drew the culled slice full-resolution). */
  readonly decimated: boolean;
}

/**
 * One layer's line in a {@link DrawStatsFrame}: its identity + measured draw
 * time, plus the {@link LayerDrawStats} the layer reported (`undefined` counts
 * for a layer that returns none — e.g. a non-decimating scatter/bar, which
 * still contributes its `drawMs`).
 */
export interface LayerDrawInfo {
  /** The layer's `as` role, or `undefined` if it set none. */
  readonly as: string | undefined;
  /** Z-order index within the row (the `<Layers>` declaration position). */
  readonly index: number;
  /** Wall-clock ms spent in this layer's `draw` this frame. */
  readonly drawMs: number;
  readonly sourceCount: number | undefined;
  readonly drawnCount: number | undefined;
  readonly decimated: boolean | undefined;
}

/**
 * The per-repaint draw-stats frame handed to {@link ContainerProps.onDrawStats}.
 * Fires **once per row-canvas repaint** (rows repaint independently, so a
 * multi-row container fires one frame per row that painted), carrying that row's
 * layers newest-drawn. The seam the dashboard A/B asked for (2026-07-21): read
 * `drawnCount` vs `sourceCount` to see whether M4 engaged, and `drawMs` for the
 * per-layer render cost the packaged layer otherwise hides.
 */
export interface DrawStatsFrame {
  readonly layers: readonly LayerDrawInfo[];
  /** Total ms across this row's layer draws this frame. */
  readonly totalDrawMs: number;
}

/**
 * A draw layer ({@link LineChart}, …) registered into a {@link Layers}, paired
 * with the id of the axis it scales against. The row computes a y-scale per
 * axis from the union of its linked layers' extents (or the axis's explicit
 * domain); each layer draws with its own axis's scale.
 */
export interface RowLayer {
  /**
   * The layer's `as` role (the series identity), surfaced in {@link
   * DrawStatsFrame} so a draw-stats consumer can label each line. `undefined`
   * when the layer was given no `as`.
   */
  readonly as?: string | undefined;
  /** This layer's finite-value `[min, max]`, or `null` if it has none. */
  yExtent(): [number, number] | null;
  /**
   * The **kind of x axis** this layer's data lives on — `'time'` for a
   * `TimeSeries`, `'value'` for a `ValueSeries`, `'category'` for a categorical
   * (ordinal column-domain) layer. The container infers the one shared x scale
   * from its layers (all must agree — a mix is an error), so the axis kind never
   * needs declaring. See {@link ContainerFrame.xScale}.
   */
  readonly xKind: 'time' | 'value' | 'category';
  /**
   * This layer's `[min, max]` along the **x** axis (the key / value-axis extent),
   * or `null` if empty. The container unions these to auto-fit the shared x
   * domain when no explicit `range` is given. For a `'category'` layer this is
   * the slot extent `[0, n]` (n = category count).
   */
  xExtent(): readonly [number, number] | null;
  /**
   * A `'category'` layer's ordered category names (the ordinal axis domain the
   * container builds a {@link ScaleBand} + label formatter from). `undefined` /
   * absent for a `'time'` or `'value'` layer. Category layers in one container
   * must agree on this list (a mix is an error), the same way {@link xKind} must.
   */
  xCategories?(): readonly string[] | null;
  /**
   * A bar/histogram layer's bar `[begin, end)` spans, as pond `Interval`s — the
   * **region cursor's snap buckets**. When present (and no `cursorSequence` is
   * set), a region drag snaps bar by bar and a hover highlights the bar under the
   * pointer, so a histogram gets bin-aligned selection for free. Only a
   * **vertical** bar layer on a **continuous** (time / value) x axis publishes
   * them — a horizontal chart puts the value on x (snapping counts is meaningless)
   * and a **category** (ordinal-slot) axis is excluded from the region cursor.
   * `null` / absent otherwise.
   */
  binIntervals?(): readonly Interval[] | null;
  /**
   * The layer's value(s) at `time` — the nearest sample — for the scrub tracker:
   * one for a line, two (lower/upper) for a band, empty at a gap. Each carries
   * the sample's own `x` (the dot snaps onto the data point) and dot colour.
   */
  sampleAt(time: number): readonly TrackerSample[];
  /**
   * The layer's **consolidated flag** at `time` — several values on **one** flag,
   * each its own colour, anchored to a single point. For chart types whose `flag`
   * cursor is one multi-line flag rather than a chip per series. **Optional:** only
   * {@link BoxPlot} implements it (low/q1/median/q3/high on one flag at the box's
   * top-centre); line/area/bar/scatter omit it and use the per-sample flag from
   * {@link sampleAt}. `null` when nothing is under the cursor. (`sampleAt` still
   * fans the same values to the off-chart readout; `cursorFlag` is the in-chart
   * presentation only.)
   */
  cursorFlag?(time: number): CursorFlag | null;
  /**
   * Hit-test plot-pixel `(px, py)` against this layer's marks for click
   * selection — the select-analog of {@link sampleAt}. Returns the hit mark or
   * `null`. **Optional, and gated on the layer's `id`:** a layer only wires
   * `hitTest` when it was given an `id` (the series identity). Layers without an
   * `id` — or without discrete selectable marks (line, band, area) — omit it,
   * so they render + read out but never select/hover (a click on them resolves
   * to empty space ⇒ deselect). `xScale`/`yScale` map data→pixels (the row
   * resolves the layer's axis scale, as for `draw`).
   */
  hitTest?(
    px: number,
    py: number,
    xScale: (value: number) => number,
    yScale: (value: number) => number,
  ): SelectInfo | null;
  /**
   * Draw into the plot canvas. `xScale`/`yScale` map data→pixels. May return
   * {@link LayerDrawStats} (source/drawn counts + whether decimation engaged) so
   * the container can surface them via {@link ContainerProps.onDrawStats}; a
   * layer that returns `void` still contributes its measured `drawMs`.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    xScale: (value: number) => number,
    yScale: (value: number) => number,
  ): LayerDrawStats | void;
}

/** One tracker readout point — a dot + value the overlay draws at the cursor. */
export interface TrackerSample {
  /** The sample's time (epoch ms); the dot sits at `xScale(x)`. */
  readonly x: number;
  /** The sample's value (y), placed at the layer's axis `yScale(value)`. */
  readonly value: number;
  /** Dot / label colour — the layer's resolved style colour. */
  readonly color: string;
  /** Labels the value in a readout: the series identity (`as` ?? column) for a
   *  single-value mark; a multi-value mark (band edges, box quantiles, an OHLC
   *  quote) emits `"<as> <role>"` composites (`iv lower`, `SPY high`) when its
   *  `as` is set, else the raw column / role word. */
  readonly label: string;
}

/** One line of a {@link CursorFlag} — a labelled, coloured value. */
export interface CursorFlagLine {
  readonly value: number;
  readonly color: string;
  readonly label: string;
}

/**
 * A consolidated multi-value flag for a {@link RowLayer.cursorFlag} layer (the
 * BoxPlot): several values on **one** flag, anchored to `(x, topValue)` — the
 * mark's centre time and the value its staff rises from (the box top). The lines
 * render left→right in one horizontal row, each in its own colour (matched to its
 * box piece).
 */
export interface CursorFlag {
  readonly x: number;
  readonly topValue: number;
  readonly lines: readonly CursorFlagLine[];
}

/**
 * A source of tracker samples — a draw layer, registered with the container so
 * it can fan in every series' value at the cursor for {@link onTrackerChanged}.
 * Also carries the layer's x-axis {@link RowLayer.xKind} + {@link RowLayer.xExtent}
 * so the container can infer the shared x scale's kind + auto-fit its domain
 * (the source registry is the container's only handle on its layers).
 */
export interface TrackerSource {
  sampleAt(time: number): readonly TrackerSample[];
  readonly xKind: 'time' | 'value' | 'category';
  xExtent(): readonly [number, number] | null;
  /** A `'category'` source's ordered category names (see {@link RowLayer.xCategories}). */
  xCategories?(): readonly string[] | null;
  /** A bar/histogram source's bar `[begin, end)` spans (see {@link RowLayer.binIntervals}). */
  binIntervals?(): readonly Interval[] | null;
}

/**
 * One selection — what {@link RowLayer.hitTest} returns and `onSelect` reports.
 * Selection identity is the **series `id`**, not the sample: `key`/`value` are
 * click **provenance** (the nearest sample under the pointer, informational);
 * equality, dedup, and the controlled echo all key on `id`. Because `id` is a
 * stable series identity — distinct from the `as` theme role, which can repeat —
 * a selection survives a streaming data update where a sample `key` would go
 * stale. Only layers that carry an `id` are selectable (see {@link RowLayer.hitTest}).
 */
export interface SelectInfo {
  /**
   * The **series identity** — the layer's `id` prop. The selection / dedup /
   * controlled-echo key; stable across data updates (unlike {@link key}).
   */
  readonly id: string;
  /**
   * The clicked sample's key as epoch ms (its event's `begin`) — click
   * **provenance**, informational. NOT the selection identity (that is {@link id}).
   * A **series-scoped** selection with no sample under it (a `<Legend>` row's
   * default hover/select) carries `NaN` here and in {@link value} — check
   * `Number.isFinite` before treating them as a sample.
   */
  readonly key: number;
  /** The clicked sample's value (the plotted column) — provenance. `NaN` for a
   *  series-scoped selection (see {@link key}). */
  readonly value: number;
  /** The mark's resolved style colour. */
  readonly color: string;
  /** Display label (`as` ?? column ?? id) — labels the selection in a readout. */
  readonly label: string;
  /**
   * An optional **stable per-mark identity within the layer** — a *category's
   * column name* on the categorical axis, where every bar shares the layer's
   * `id` but each column needs its own stable handle. When present, the
   * highlight match + controlled `selected` echo key on `(id, mark)` instead of
   * the sample `key`, so a pinned selection survives a column reorder / data
   * update (the slot index is not stable; the column name is). `undefined` for
   * marks whose sample `key` is already their identity (a time / value bar).
   */
  readonly mark?: string;
}

/** The hover snapshot handed to `onTrackerChanged` — the cursor time + every
 *  series' value there, so a consumer can render the readout outside the chart. */
export interface TrackerInfo {
  readonly time: number;
  readonly values: readonly TrackerSample[];
}

/**
 * The in-chart cursor presentation for a row (the synced vertical line is shared
 * across rows). Exclusive modes — pick one:
 *
 * - `none` — no in-chart cursor.
 * - `line` — the synced vertical line only, no per-series marks (pair with an
 *   off-chart readout via {@link onTrackerChanged}).
 * - `point` — a dot on each series at the cursor, no line.
 * - `inline` — dots + a value chip beside each.
 * - `flag` — dots + value flags (a staffed flag from each point; the staff
 *   geometry lands in a later phase — for now flags stack at the top).
 * - `crosshair` — the synced vertical line + a dot on each series, with each
 *   series' value pinned to its y-axis edge (an on-axis pill) and the cursor
 *   time pinned to the x-axis. The ChartIQ / trading-terminal readout. Values
 *   snap to the series (the axis pills read like ticks), not the raw mouse Y.
 */
export type CursorMode =
  | 'none'
  | 'line'
  | 'point'
  | 'inline'
  | 'flag'
  | 'crosshair'
  | 'region';

/** A registered layer plus the axis id it draws against. */
export interface LayerEntry {
  readonly layer: RowLayer;
  /**
   * The axis id this layer draws against, or `undefined` for the row's default
   * axis. Resolved late (at scale/draw time), so a layer that mounts before its
   * `<YAxis>` still binds to it.
   */
  readonly axisId: string | undefined;
  /**
   * Declaration position among the `<Layers>` children, injected by the parent
   * (see `Layers`). The row sorts layers by this for z-order, so the stack
   * follows JSX order regardless of mount timing — a layer toggled in between
   * two others slots into place rather than landing on top.
   */
  readonly index: number;
}

/** A y-axis declared in a {@link ChartRow} via `<YAxis>`. */
export interface AxisSpec {
  readonly id: string;
  readonly side: 'left' | 'right';
  /** Gutter width in CSS pixels. */
  readonly width: number;
  /** Explicit domain bounds, or `undefined` to auto-fit linked layers. */
  readonly min: number | undefined;
  readonly max: number | undefined;
  /** Fractional headroom added to each side of the resolved domain (`0` = none). */
  readonly pad: number;
  /** Title placement; `'top'` makes the row reserve a header band above the plot. */
  readonly labelPlacement: 'rotated' | 'top';
  /** Value formatting for the tick labels + the cursor readout ({@link AxisFormat}),
   *  or `undefined` for the scale's d3 default. */
  readonly format: AxisFormat | undefined;
  /** Explicit tick values (from `<YAxis ticks>`), driving BOTH the axis labels
   *  and the row's gridlines so they align; `undefined` auto-picks from the scale. */
  readonly tickValues: readonly number[] | undefined;
  /** Explicit auto-tick **count** (from `<YAxis tickCount>`) — a `ticks(count)`
   *  target; `undefined` derives the count from the row height (see
   *  {@link resolveYTickCount}). Ignored when {@link tickValues} is set. */
  readonly tickCount: number | undefined;
  /**
   * Declaration position among the row's children, injected by `ChartRow`. The
   * row sorts axes by this, so the **first declared** axis is the default
   * regardless of which axis last re-rendered.
   */
  readonly index: number;
}

/**
 * The frame a {@link ChartRow} provides to its axes (`<YAxis>`) and plot area
 * (`<Layers>`): the row height, the per-axis y-scales, and the registries.
 * `ChartRow` coordinates two registries — axes and layers — and computes a
 * y-scale **per axis id** (range `[height, 0]`). The x geometry (plot width,
 * time scale) is shared and lives on the {@link ContainerFrame}.
 */
export interface RowFrame {
  readonly height: number;
  readonly yScales: ReadonlyMap<string, ScaleLinear<number, number>>;
  /** Value formatter per axis id (resolved from the axis's {@link AxisSpec.format}
   *  against its scale) — used by both the tick labels and the cursor readout, so
   *  a value reads identically in both. */
  readonly formats: ReadonlyMap<string, (value: number) => string>;
  /** Explicit tick values per axis id (from {@link AxisSpec.tickValues}), for axes
   *  that set `<YAxis ticks>` — so `Layers` draws gridlines at the same positions
   *  the axis labels. Absent id ⇒ that axis auto-picks. */
  readonly tickValues: ReadonlyMap<string, readonly number[]>;
  /** Resolved auto-tick **count** per axis id — the explicit `<YAxis tickCount>`
   *  or the row-height-derived default ({@link resolveYTickCount}). The single
   *  source both the `<YAxis>` labels and the `Layers` gridlines read, so a
   *  label and its gridline stay on the same `ticks(count)`. */
  readonly tickCounts: ReadonlyMap<string, number>;
  /** The side each axis sits on, keyed by id — so an axis-edge overlay (the
   *  crosshair value pills) hugs the correct gutter. */
  readonly axisSides: ReadonlyMap<string, 'left' | 'right'>;
  /** This row's cursor-mode override, or `undefined` to inherit the container's
   *  default ({@link ContainerFrame.cursor}). */
  readonly cursor: CursorMode | undefined;
  /** Whether this is the first (topmost) row — the shared cursor-time chip shows
   *  here only, not repeated on every row. Derived from {@link ContainerFrame.firstRowKey}. */
  readonly isFirstRow: boolean;
  /** This row's per-instance key — annotations register it so the container can
   *  draw a mark's guide on the *other* rows (a row skips its own marks). */
  readonly rowKey: symbol;
  /** The axis a layer uses when it names none (the first declared, or implicit). */
  readonly defaultAxisId: string;
  /**
   * Reserved slot width for each axis, keyed by its **instance** slot key (the
   * `useSlotKey` symbol), not its data id — two axes may share an id (a
   * left/right mirror) yet need distinct slots. A `<YAxis>` sizes its box to this
   * and aligns its own narrower content toward the plot, so axes line up
   * column-by-column across rows.
   */
  readonly axisSlots: ReadonlyMap<symbol, number>;
  /**
   * Register or **update** an axis, keyed by a stable per-instance slot key (a
   * `Symbol` from `useSlotKey` — instance identity, not the data `id`). Update
   * is in place — the entry keeps its slot — so a `min`/`max`/`side` change
   * doesn't reorder the axes (the first declared stays the default). Pair with
   * `unregisterAxis(key)` on unmount only.
   */
  registerAxis(key: symbol, spec: AxisSpec): void;
  unregisterAxis(key: symbol): void;
  /** Register or update a draw layer by stable slot key; in-place so a
   *  series/style change keeps the layer's z-slot. Unregister on unmount. */
  registerLayer(key: symbol, entry: LayerEntry): void;
  unregisterLayer(key: symbol): void;
  /** Draw layers in stable declaration order — the z-stack, first at the back. */
  readonly layers: readonly LayerEntry[];
}

export const RowContext = createContext<RowFrame | null>(null);

/**
 * The registry a {@link Layers} exposes to its child draw layers — the boundary
 * that makes a layer a layer (children here register; a layer outside `<Layers>`
 * errors). Forwards to the row's layer registry; layers are keyed by a stable
 * per-instance slot key (`useSlotKey`) so re-registering on a prop change
 * updates in place rather than reordering the z-stack.
 */
export interface LayerRegistry {
  registerLayer(key: symbol, entry: LayerEntry): void;
  unregisterLayer(key: symbol): void;
}

export const LayersContext = createContext<LayerRegistry | null>(null);
