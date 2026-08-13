import { createContext, type ReactNode } from 'react';
import type {
  ScaleContinuousNumeric,
  ScaleLinear,
  ScaleLogarithmic,
  ScaleSymLog,
  ScaleTime,
} from 'd3-scale';
import type { ChartTheme } from './theme.js';
import type { AxisFormat, CursorFormat } from './format.js';
// Type-only (erased at runtime): swatch.ts imports RowContext from here, so a
// value import in this direction would be a cycle; a type import is not.
import type { LegendItemSpec } from './swatch.js';
import type { Interval, Sequence, BoundedSequence } from 'pond-ts';
import type {
  TradingTimeScale,
  DiscontinuityProvider,
} from './tradingTimeScale.js';
import type { ScaleBand } from './bandScale.js';
import type { ElapsedScale } from './elapsed.js';

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

/**
 * The container's shared x→pixel scale, in every kind it can resolve to. All
 * five are callable (`value → px`) and expose `invert` / `ticks` /
 * `tickFormat`, which is the whole surface the library — and a consumer
 * reading the frame ({@link ChartFrame.xScale}) — uses; that shared shape is
 * what lets a trading-time or ordinal axis drop in where a linear one went.
 *
 * Named (rather than written inline on {@link ContainerFrame.xScale}) because
 * {@link useChartFrame} publishes it: a consumer positioning DOM chrome over
 * the plot needs to be able to *write down the type* of the scale it maps
 * through.
 */
export type ChartXScale =
  | ScaleTime<number, number>
  | ScaleLinear<number, number>
  // `<ChartContainer xScale="log" | "symlog">`. Both share d3's continuous
  // surface with `ScaleLinear` — call, `invert`, `ticks`, `domain`, `range` —
  // so a reader that only uses the scale needs no branch. What *does* branch
  // is arithmetic over the domain, which must move into log space; see
  // `ViewportOptions`.
  | ScaleLogarithmic<number, number>
  | ScaleSymLog<number, number>
  | TradingTimeScale
  | ScaleBand
  | ElapsedScale;

export interface ContainerFrame {
  readonly timeRange: readonly [number, number];
  readonly width: number;
  /**
   * Whether the container is managing vertical layout ([PND-HEIGHT]) — it was
   * given a `height` (number or `'auto'`), renders as a flex column, and flex
   * rows have real space to divide. `false` is the classic mode: rows declare
   * pixel heights and the container's height is their sum. A `<ChartRow
   * flex>` reads this to warn when mounted somewhere it can never resolve.
   */
  readonly managesHeight: boolean;
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
  /** Set the hovered plot-pixel x; a row's event surface calls this on pointer move.
   *  The value itself is on {@link CursorFrame.cursorX} ({@link CursorContext}) —
   *  split out so a hover doesn't re-identify this frame (see [PND-HOVCTX]). */
  setHoverX(x: number | null): void;
  /** Set the hovered plot-pixel y + its row; the event surface calls this on move.
   *  The values are on {@link CursorFrame} ({@link CursorContext}). */
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
   * The **live** spans of a sweep in flight — the preview a span-only layer
   * paints ([PND-TRACESEL]), and empty at rest.
   *
   * A mark layer previews through plural `hovered`: the covered marks light.
   * A **trace has no marks**, so there is nothing for that channel to carry —
   * what wants lighting is the *portion of the trace inside the window*, which
   * is a span, not a set of marks. Hence a second preview channel rather than
   * an abuse of the first.
   *
   * A paint mirror in the same sense as {@link regionAnchor}: `Layers` writes
   * it from the live session and clears it on release, and it never enters the
   * committed selection — {@link selectedSpans} is the consumer's, this is the
   * gesture's. A layer that finds itself named here should draw as though the
   * span were committed, so releasing changes nothing visually and the preview
   * cannot promise a different picture than the commit delivers.
   */
  readonly previewSpans: readonly SpanSelection[];
  /** Set / clear the live sweep preview (see {@link previewSpans}). */
  setPreviewSpans(spans: readonly SpanSelection[]): void;
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
   * The selected marks — **empty when nothing is selected**, never `null`.
   * Shared across rows, insertion-ordered. A layer highlights every mark
   * matching a member's series **`id`** and clicked sample `key` (epoch ms) —
   * the `id` picks the series (so two series sharing a timestamp don't both
   * light up), the `key` picks the mark within it. A controlled `selected` prop
   * pins the set; otherwise a click on a selectable layer (one with an `id`)
   * sets it.
   *
   * **A set, not a single mark, since [PND-MULTISEL].** The container prop
   * accepts either shape and normalizes here, so a single-selection consumer is
   * unaffected; this frame field is internal (not exported from `index.ts`), so
   * widening it breaks nobody. A layer that only ever wants one mark can read
   * `selected[0]`, but membership is the honest test — see `isSelected`.
   */
  readonly selected: readonly SelectInfo[];
  /**
   * The **span** entries of the controlled `selected` prop — **empty when it
   * carries none**, never `null`. The container splits the prop's mixed
   * `SelectionEntry` array into per-mark entries ({@link selected}) and range
   * descriptors (this field) once at the boundary, so every existing reader of
   * {@link selected} keeps its exact shape (and cost) while span-aware layers
   * read this **additionally** — the union of the two fields is the selection
   * (interaction RFC A5.2). Like `selected`, this frame field is internal (not
   * exported from `index.ts`).
   *
   * Only the controlled prop can populate it: clicks produce marks, so the
   * uncontrolled path never holds a span.
   */
  readonly selectedSpans: readonly SpanSelection[];
  /**
   * Select a mark, or `null` to clear. Reports the hit to the `<Selector>`s in
   * scope and manages the internal selection only when uncontrolled (no
   * `selected` prop). The split mirrors the tracker's `trackerPosition`
   * (controlled by a *value* prop) + its `onTrackerChanged` notification — not
   * `applyRange`, which is controlled by the presence of a *callback*.
   *
   * **`rowKey` distinguishes the two callers, and it is load-bearing**
   * (interaction RFC §7.1). Pass a row's key for a **plot gesture** — the row's
   * click surface, after hit-testing — and the call is *gated on a mounted
   * `<Selector>`*: with none in scope it does nothing at all (the deliberate
   * break), and dev-warns on the hit that went nowhere. Omit it for a
   * **programmatic** select (a `<Legend>` chip, a consumer's own control),
   * which reports to the container-scoped selectors and commits as it always
   * has — mounting gates the *plot*, not an explicit call.
   */
  select(
    hit: SelectInfo | null,
    modifiers?: SelectModifiers,
    rowKey?: symbol,
  ): void;
  /**
   * The **hovered** marks — **empty when nothing is hovered, never `null`** —
   * the transient hover-highlight, distinct from the committed `selected`. A
   * row's pointer-move surface hit-tests its selectable layers and sets it; a
   * layer that supports hover-highlight (Bar) draws every matching mark lit (a
   * lighter treatment than `selected`'s outline).
   *
   * **A set, not one mark, since RFC `selection.md` A4.2.** A1.4 argued hover
   * "is inherently one mark under the pointer" — true while hover *means*
   * pointer position, and false under a drag sweep, where it means "would be
   * selected if you released now" and several marks are lit at once. Plain
   * pointer-over therefore carries 0 or 1 members; that slightly odd type for
   * the common case is the accepted cost of not minting a third `preview`
   * state a theme would style identically anyway.
   * Set-on-change (deduped by the series `id` + sample `key`) so the data canvas
   * repaints only on a mark transition, not every pointer move.
   */
  readonly hovered: readonly SelectInfo[];
  /**
   * Set the hovered mark (or `null` to clear) from a pointer-move hit-test;
   * deduped by series `id` + sample `key`, so an unchanged mark is a no-op (no
   * repaint). `rowKey` scopes which `<Selector>`s hear about it (a row's own
   * mounts, else the container's) exactly as {@link select} does; omit it for a
   * programmatic hover (a `<Legend>` chip).
   *
   * **Not gated on a mounted `<Selector>`, unlike {@link select}.** With no
   * selector mounted there is simply nobody registered to hear about it (RFC
   * A10.3) — the hover state still moves, it just has nothing to report to,
   * which needs no gate to arrange.
   *
   * `block` — the **resting block preview** under a mounted `<MultiSelector>`
   * (the marks of the snap block the pointer is in — exactly the set a drag
   * begun and released there would select). When present it becomes the
   * hovered *state* (every mark in the block lights) and what
   * `<MultiSelector onHover>` hears, deduped by the block array's identity
   * (the caller keeps it reference-stable per block, so within-block mark
   * transitions re-render nothing). `<Selector onHover>` keeps its per-mark
   * currency — `hit` still reports per mark transition. Omitted ⇒ the
   * plain single-mark hover, exactly as before.
   */
  setHovered(
    hit: SelectInfo | null,
    rowKey?: symbol,
    block?: readonly SelectInfo[],
  ): void;
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
   * Whether an explicit container `cursorFormat` shaped {@link formatReadout} —
   * as opposed to the axis kind supplying its own default readout (the elapsed
   * axis's finer duration). The two are indistinguishable from the field alone,
   * and `<XAxis>` must tell them apart to honour the documented pill precedence
   * `cursorFormat → axis format → container`: a **`cursorFormat`** outranks an
   * explicit `<XAxis format>`, a **default** does not. Without this the elapsed
   * default silently occupied the `cursorFormat` slot and a wall-clock strip's
   * pill read durations (issue #540, finding 2).
   */
  readonly xReadoutCustom: boolean;
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
   * Register a mounted **selector** ({@link SelectorEntry}) — `<Selector>` /
   * `<MultiSelector>` call this, keyed by the component's per-instance slot
   * key. The same idiom as `registerCursor` / `registerAxis` / `registerLayer`:
   * update in place, unregister on unmount.
   *
   * **The registration is the enablement** (interaction RFC §7.1): a plot click
   * resolves the selectors in scope (`effectiveSelectorEntries`) and does
   * nothing when there are none.
   *
   * The registry itself is deliberately **not** exposed on the frame (unlike
   * `cursors`, which the rows and `<XAxis>` render): nothing outside the
   * container reads it — `select` / `setHovered` resolve the scope internally —
   * and publishing it would re-identify the whole frame on every selector
   * mount. Same shape as `registerSelectable`, which also keeps its set private.
   */
  registerSelector(key: symbol, entry: SelectorEntry): void;
  unregisterSelector(key: symbol): void;
  /**
   * Resolve a row's press against the mounted `<MultiSelector>`s in scope
   * (interaction RFC §8): the {@link SweepGesture} sinks when at least one is
   * in scope, else `null` — which is how the brush recognizer learns whether a
   * sweep can claim the drag at all (mounting arms the gesture, §7.1's rule
   * extended to the sweep). Scope resolution mirrors {@link select}'s: the
   * row's own mounts when it has any, else the container's. The selector
   * registry itself stays private, for the reason documented on
   * {@link registerSelector}.
   */
  resolveSweep(rowKey: symbol): SweepGesture | null;
  /**
   * Whether a `<MultiSelector>` is in scope for this row — the *render-time*
   * fact behind {@link resolveSweep} (which builds the per-drag gesture and is
   * for the pointer-down path). Rows read this to decide the **resting block
   * preview**: with one in scope over a sweep-capable row, the shared brush
   * band becomes the resting cursor (replacing the implicit line shim) and
   * hover lights the whole snap block a drag would select. Identity changes
   * when the selector registry does, so it is safe in render memos.
   */
  hasMultiSelector(rowKey: symbol): boolean;
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
   *
   * A container given an `origin` wraps whichever of these it built in an
   * {@link ElapsedScale} — the same pixel mapping, but ticks anchored at the
   * origin and labelled as offsets (`00:05`), which is how the whole frame
   * (axis labels, gridlines, cursor pill) reads durations without any consumer
   * knowing about the mode.
   */
  readonly xScale: ChartXScale;
  /**
   * Is the x scale **logarithmic** (`log` or `symlog`)?
   *
   * Detected structurally rather than threaded from the prop: `base()` exists
   * on d3's log scales and on no other continuous scale, which is the same test
   * `yticks.ts` already uses on the y side. Read by the viewport gestures,
   * which must do their arithmetic in log space (see `ViewportOptions`).
   */
  readonly xIsLog: boolean;
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
  /** Drag-pan enabled (the `'pan'` and `'panZoom'` container modes). */
  readonly panEnabled: boolean;
  /** Wheel-zoom enabled (the `'panZoom'` container mode only). */
  readonly zoomEnabled: boolean;
  /** Minimum visible duration (ms) — the zoom-in floor. */
  readonly minDuration: number;
  /**
   * Apply a new view range from a pan/zoom gesture. Routes to `onTimeRangeChange`
   * (controlled) or the container's internal view state (uncontrolled). Only
   * called while `panZoom` is on.
   */
  applyRange(range: readonly [number, number]): void;
  /**
   * The **y view transform** for 2-D pan/zoom (`panZoom="panZoom2D"`), in
   * *pixel* space: a y scale's range becomes `ty + k · basePixel`. Identity is
   * `{ k: 1, ty: 0 }`.
   *
   * Pixel space rather than domain space is what makes this axis-independent.
   * A row may carry several y axes with unrelated domains (left price, right
   * volume), and the question "which one does a vertical gesture own?" has no
   * good answer — but a uniform pixel transform sidesteps it: every axis zooms
   * by the same factor about its own pivot, which is also exactly what keeps
   * the **aspect ratio** fixed. The x half stays in domain space, where
   * `bounds`, `minDuration` and the trading-calendar zoom maths live.
   */
  /** Which axes the gestures own; pan follows zoom's degrees of freedom. */
  readonly zoomX: boolean;
  readonly zoomY: boolean;
  readonly panX: boolean;
  readonly panY: boolean;
  /** True only when both axes zoom — one factor, so the ratio is fixed. */
  readonly aspectLocked: boolean;
  readonly yTransform: { readonly k: number; readonly ty: number };
  applyYTransform(next: { k: number; ty: number }): void;
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
   * Register a mounted **cursor** ({@link CursorEntry}) — the `<LineCursor>` /
   * `<CrosshairCursor>` / … presets (and the deprecation shim synthesizing them
   * from the legacy string props) call this, keyed by the component's
   * per-instance slot key. The container resolves the per-row effective set
   * (row mounts override container mounts — see `effectiveCursorEntries`) and
   * the rows/`<XAxis>` render the registered slots. Update is in place;
   * unregister on unmount.
   */
  registerCursor(key: symbol, entry: CursorEntry): void;
  unregisterCursor(key: symbol): void;
  /** Every registered cursor, in mount order (see {@link registerCursor}). */
  readonly cursors: readonly CursorEntry[];
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

/**
 * The kind of a **registered** mark — wider than {@link AnnotationKind}.
 *
 * A `<Zone>` is a mark you place in JSX but **not** a create *tool*: there is no
 * draw gesture for it and no {@link CreateSpec} variant, so it registers under
 * its own kind without widening the toolbar vocabulary (which would let
 * `creating="zone"` type-check and then silently never fire `onCreate`).
 */
export type AnnotationSpecKind = AnnotationKind | 'zone';

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
  readonly kind: AnnotationSpecKind;
  /** The row it lives on (its `<ChartRow>`'s key), so a row skips its own marks
   *  when drawing guides. */
  readonly rowKey: symbol;
  /**
   * Its vertical-guide x-position(s) in **axis units** (the shared x): a marker's
   * `[at]`, a region's `[from, to]`. Empty for a baseline or a zone — a
   * horizontal line (or band) casts no vertical guide.
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
 * The **per-move** cursor state — split out of {@link ContainerFrame} so a
 * mousemove re-identifies only this (small) context, not the whole frame.
 * `ContainerFrame` carries ~50 mostly-static fields; when the cursor lived
 * there, every pointer move rebuilt it and re-rendered **all** its consumers
 * (both `YAxis`, `Legend`, `Bar`/`Box`) even though only the SVG overlay moved.
 * Config consumers now read the stable frame and skip hover re-renders; the
 * genuine cursor consumers (`Layers` overlay, `XAxis` crosshair pill,
 * `useChartLegend` values) read this. See [PND-HOVCTX] and the note it links.
 *
 * The cursor *time* is **not** here — each consumer derives it locally from
 * `cursorX` + its own `xScale` (an in-bounds `xScale.invert`), as before.
 * ({@link ContainerFrame} still carries a `cursorTime` **boolean** — the
 * unrelated "show time in the readout" config flag.)
 */
export interface CursorFrame {
  /**
   * The crosshair's **plot-pixel x** (`0..plotWidth`), shared across rows so the
   * tracker syncs, or `null` when not hovering. A *pixel*, not a timestamp — so a
   * still cursor stays put while a live window slides under it (a stored
   * timestamp would drift sideways as `xScale` changes). A controlled
   * `trackerPosition` (a timestamp) resolves to a pixel here.
   */
  readonly cursorX: number | null;
  /**
   * The hovered plot-pixel **y** and the row it's in — for the free-form
   * crosshair's horizontal line + value readout (which are row-specific, unlike
   * the shared vertical `cursorX`). `null` when not hovering a plot. Hover-driven
   * only (no controlled equivalent).
   */
  readonly cursorY: number | null;
  readonly cursorRowKey: symbol | null;
}

/** No-cursor default, so a consumer outside a provider reads "not hovering"
 *  rather than needing a null guard (the container always provides a real one). */
const NO_CURSOR: CursorFrame = {
  cursorX: null,
  cursorY: null,
  cursorRowKey: null,
};

export const CursorContext = createContext<CursorFrame>(NO_CURSOR);

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
   *  it engaged, M4 decimation. `drawnCount < sourceCount` can come from **either**
   *  culling (a zoomed-in view drops off-screen points) **or** decimation — read
   *  `decimated` to tell which; `drawnCount === sourceCount` means everything in
   *  view was drawn full-resolution. */
  readonly drawnCount: number;
  /** Whether M4 decimation engaged (vs. drew the culled slice full-resolution).
   *  Distinguishes a decimated draw from a merely culled one — both shrink
   *  `drawnCount`. */
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
  /**
   * Opaque, stable identity of the **row** this frame is for — rows repaint
   * independently, so a multi-row container fires one frame per row and this is
   * how a consumer attributes each (group frames by `rowKey`, e.g. as a `Map`
   * key). Not human-readable; `layers[].as` labels the series within a row.
   */
  readonly rowKey: symbol;
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
   * A **horizontal** categorical source's ordered category names — the same
   * list {@link xCategories} carries for a vertical one, but for the axis it
   * lands on when the bars grow right: the **y** axis ([PND-HCAT]).
   *
   * The y axis stays a linear scale over the layer's unit slots (`[i, i+1]`),
   * so this only supplies *labels*: a `<YAxis>` in the row with no explicit
   * `ticks` derives one tick per category at the slot centre (`i + 0.5`).
   * That hand-built tick list was the friction the gallery funnel documented.
   */
  binCategories?(): readonly string[] | null;
  /**
   * A bar/histogram layer's bar `[begin, end)` spans, as pond `Interval`s — the
   * **shared snap buckets**. When present (and no `cursorSequence` is set), a
   * region drag snaps bar by bar and a `<MultiSelector>` sweep's band extends
   * bar by bar, so a histogram gets bin-aligned selection for free. Only a
   * **vertical** bar layer publishes them — a horizontal chart puts the value
   * on x (snapping counts is meaningless). On a **category** axis they are
   * the unit slots `[i, i+1)`: the region cursor still ignores them (its band
   * gates on a continuous axis), but the sweep band snaps over them to the
   * slots' outer edges (RFC A7.6's edge rule — the band must agree with the
   * span the release commits). `null` / absent otherwise.
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
   *
   * `mode` says which gesture is asking, and a layer whose hover target is
   * generous may narrow the *select* one. The single-series bar path does:
   * **hover** attributes the bar's whole slot (full interval width, full plot
   * height — the continuous model #582 asked for, so the highlight tracks
   * like the readout), while **select** additionally requires the pointer to
   * be within the bar's drawn ink vertically. Without that narrowing, slots
   * tile the entire plot and a click can never resolve to `null` — RFC §7's
   * empty-click deselect path becomes unreachable on any full-range bar
   * chart. Layers whose hit target is already the drawn mark (stacks,
   * scatter, boxes, heat cells) ignore `mode`.
   */
  hitTest?(
    px: number,
    py: number,
    xScale: (value: number) => number,
    yScale: (value: number) => number,
    mode?: 'hover' | 'select',
  ): SelectInfo | null;
  /**
   * Begin a **sweep session** over this layer's marks — `<MultiSelector>`'s
   * range query (interaction RFC A7.6/A7.7), the range analog of
   * {@link hitTest} and gated exactly like it: only a layer with an `id` (and
   * discrete selectable marks) wires it, so an untagged layer is never swept.
   * Called on the pointer-down that survives `DRAG_SLOP` under a mounted
   * `<MultiSelector>`; the session lives for that one drag and nothing
   * persists outside it. Returns `null` when there is nothing sweepable.
   *
   * `xScale`/`yScale` are the resolved scales (as for `draw`/`hitTest`) —
   * unused by the 1-D layers, but part of the seam so the 2-D sessions
   * (scatter's y-window, the heat map's row cut — [PND-INTERACT2D]) can be
   * added without redesigning the shape (RFC A7.6).
   */
  beginSweep?(
    xScale: (value: number) => number,
    yScale: (value: number) => number,
  ): SweepSession | null;
  /**
   * Whether a sweep over this layer cuts a **rect** rather than a band — the
   * same fact {@link SweepSession.twoD} reports, declared on the layer because
   * the RESTING state has to know it and there is no session at rest.
   *
   * It decides what the row's resting cursor is: a band over the snap block
   * for a 1-D layer, a small crosshair at the pointer for a 2-D one (a rect
   * gesture has no resting block to preview — see `Layers`). Building a
   * per-drag session just to ask would be the wrong shape and would snapshot
   * the layer's arrays for nothing.
   *
   * Must agree with the session the layer's own `beginSweep` returns;
   * `sweep-capabilities.test.ts` pins that across every layer.
   */
  readonly sweepsRect?: boolean;
  /**
   * **Which screen axis a sweep over this layer cuts** — `'x'` (the default,
   * and every layer that shipped before [PND-HSWEEP]) or `'y'` for a
   * transposed layer whose bins run down the screen: a horizontal
   * `<BarChart>` puts the value on the shared x, so a window there says
   * nothing about which bins are covered and the cut has to come from the
   * pointer's y.
   *
   * **Orthogonal to {@link sweepsRect}, and all four pairs are real** — (x,
   * band) a vertical bar, (y, band) a horizontal bar, (x, rect) a scatter or a
   * vertical heat map, (y, rect) a horizontal heat map. That is why this is a
   * second field rather than a third value on `sweepsRect`.
   *
   * The session itself is unaffected: {@link SweepSession.update} takes
   * **key-axis units** and does not care which screen axis produced them, so a
   * transposed layer builds the same `sweep1D` a vertical one does. What the
   * axis changes is the *gesture* — which pointer coordinate is inverted (and
   * through which scale), where the drag slop lives (`|dy|` rather than
   * `|dx|`), and which way the brush band is drawn.
   *
   * A `'y'` cut is measured against **one row's** axis, so its band is
   * row-local exactly as a rect is, and it takes its geometry from
   * {@link SweepSession.extent} rather than from the shared bin channel —
   * `binIntervals` carries the *value* axis on a transposed layer.
   */
  readonly sweepAxis?: 'x' | 'y';
  /**
   * **Whether a sweep over this layer has a range but no marks** — the same
   * fact {@link SweepSession.spanOnly} reports, declared on the layer for
   * exactly the reason {@link sweepsRect} is: the RESTING state has to know it
   * and there is no session at rest.
   *
   * It suppresses the resting **block** band. That band previews "a drag begun
   * here selects this block", and a trace has no blocks — a drag takes a
   * freeform window — so the band would advertise a set the gesture never
   * selects. Precisely the reason a `twoD` layer gets no resting band either.
   */
  readonly sweepSpanOnly?: boolean;
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

/**
 * A layer's per-drag **sweep session** ({@link RowLayer.beginSweep} — RFC
 * A7.7's `beginSweep(scales) → session` shape, 1-D form). The gesture engine
 * drives it: `update` per coalesced frame with the swept key-window,
 * {@link hits} for the frame-gated live preview, and — at release — the same
 * `hits()` again as the commit payload plus {@link extent} for the span, so
 * the committed hits ARE the materialised preview rather than a fresh range
 * query (RFC A5.2's "the hits are free"). Internal, like `RowLayer` itself.
 */
export interface SweepSession {
  /** The layer's `id` — what the committed {@link SpanSelection} carries. */
  readonly id: string;
  /**
   * Re-cut the covered set to the marks intersecting the half-open window
   * `[x0, x1)` (key-axis units, `x0 <= x1`). Returns whether the covered set
   * changed — the delta gate: an unchanged frame re-materialises nothing.
   *
   * `y0`/`y1` are the rect's second dimension in the layer's **y-axis data
   * units** (not pixels — the gesture inverts through the same `yScale` the
   * session was built with), and only a {@link twoD} session reads them; the
   * gesture omits them entirely for a 1-D layer. They are unordered, because
   * a drag upward hands them over inverted and the session is the one place
   * that knows whether its axis descends.
   *
   * **A `twoD` session must include y in its own delta gate.** A purely
   * vertical drag leaves the x run untouched, so a gate that watched x alone
   * would answer `false` and freeze the preview under a moving pointer.
   */
  update(x0: number, x1: number, y0?: number, y1?: number): boolean;
  /**
   * The covered marks, materialised (and cached until the next change) — the
   * live preview `hovered` lights, and verbatim the release payload.
   */
  hits(): readonly SelectInfo[];
  /**
   * The covered marks' snapped-outward key extent `[begin(first), end(last))`
   * — {@link SpanSelection.x} per RFC A7.6's edge rule, so the span's
   * half-open containment test reproduces exactly the captured set. `null`
   * when nothing is covered.
   */
  extent(): readonly [number, number] | null;
  /**
   * **Set by a layer whose marks live in two dimensions** — a scatter (a point
   * is a position, not a column) or a heat map (a grid of cells). The gesture
   * reads this to decide whether to track a y window alongside x and to draw a
   * rect rather than a band: dimensionality is a property of the *layer*, so a
   * consumer mounts the same `<MultiSelector>` either way (RFC Q14).
   */
  readonly twoD?: boolean;
  /**
   * **Set by a layer that has a range but no marks** — a continuous trace
   * ([PND-TRACESEL]). `hits()` is always empty and the span is the whole
   * selection.
   *
   * The gesture reads this to answer "who else did I sweep?". Topmost-wins
   * exists because a release carried **one** span, and on mark layers it is
   * defensible — you were pointing at marks, so the topmost is the one you
   * meant. A trace sweep points at *nothing*: every trace in the row shares
   * the same x window, so singling one out by z-order is arbitrary to the
   * reader. Every span-only layer in the row is therefore swept together,
   * while mark layers keep topmost-wins unchanged.
   */
  readonly spanOnly?: boolean;
  /**
   * The captured set's **second-dimension** channels, for a `twoD` session —
   * whichever of {@link SpanSelection.y} (a scatter's continuous window) and
   * {@link SpanSelection.rows} (a heat map's ordinal row set) the layer uses.
   * `null` when nothing is covered. Absent on a 1-D session.
   */
  extent2D?(): {
    readonly y?: readonly [number, number];
    readonly rows?: readonly string[];
  } | null;
  /**
   * The cut's **snapped rect in axis units** (x in key units, y in the
   * sweeping layer's y-axis units), for the brush to draw — `null` when the
   * layer's cut is free, or when nothing is covered.
   *
   * A snapping layer must draw the rect it is going to *take*, not the one
   * the pointer traced: a heat map snaps to whole cells, so a raw pointer
   * rect promises a different set than the release delivers, and the two
   * disagree most visibly at exactly the moment the user is deciding where
   * to let go.
   */
  snappedRect?(): {
    readonly x: readonly [number, number];
    readonly y: readonly [number, number];
  } | null;
}

/**
 * What the container resolves for a row's press under a mounted
 * `<MultiSelector>` ({@link ContainerFrame.resolveSweep}): the two sinks of
 * the sweep gesture, with the selector registry kept private (the same reason
 * `select` resolves scope internally). Both operate on the entries that were
 * in scope at the press, for the lifetime of that one drag.
 */
export interface SweepGesture {
  /**
   * Whether an in-scope `<MultiSelector>` **declared a `sequence`** — i.e. the
   * consumer said selection happens in bucket units rather than in marks.
   *
   * This is what widens a *click* from the mark under the pointer to the whole
   * snap block (RFC §8). It has to be the declaration and not a property of
   * what the block happened to contain: a stack's bin holds one mark per
   * group, so "the block covers more than one mark" is true of an ordinary
   * single-bin click on a stacked chart, and using that as the test made a
   * click there select the whole bin instead of the clicked segment.
   */
  readonly snapped: boolean;
  /**
   * The frame-coalesced **live preview**: light `hits` through the plural
   * `hovered` (RFC A3.4 — the library owns the state, each layer renders its
   * own hover treatment) and report them to the `<MultiSelector>`s in scope.
   * Nothing else crosses the public boundary until release (RFC A1.4).
   *
   * `light: false` **reports without lighting** — for a layer whose brush
   * already outlines exactly the covered region (a heat map's snapped rect).
   * Its hover treatment is a ring around *the cell under the pointer*, and
   * during a sweep there is no such cell: a ring on every covered cell turns
   * the region into the mostly-border grid the selection outline exists to
   * avoid, inside a rect that is already saying the same thing. The consumer
   * still hears the full set through `onHoverMany`, so a controlled `hovered`
   * can render it however it likes.
   */
  preview(hits: readonly SelectInfo[], light?: boolean): void;
  /**
   * The release: report `(hits, modifiers, span)` to the `<MultiSelector>`s in
   * scope (RFC A5.2), clear the preview, and — when `selected` is
   * uncontrolled — commit the compact span descriptor as the selection.
   */
  commit(
    hits: readonly SelectInfo[],
    modifiers: SelectModifiers,
    /** Every span the gesture produced, **topmost first** — see
     *  `<MultiSelector onSelect>`. Empty for a click, or for a sweep that
     *  covered nothing. */
    spans: readonly SpanSelection[],
  ): void;
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
  /**
   * Optional **source value for the off-chart readout**, when the layer plots a
   * *derived* column but a `readout` column names the raw value (see
   * `LineChart`/`AreaChart` `readout`). `value` stays the plotted number — so
   * the in-chart cursor dot is unchanged — while an off-chart consumer shows
   * `readout ?? value`. `undefined` when the layer has no `readout` column (the
   * common case: the plotted value *is* the value to show).
   */
  readonly readout?: number;
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
  /**
   * A **horizontal** categorical source's ordered category names — the same
   * list {@link xCategories} carries for a vertical one, but for the axis it
   * lands on when the bars grow right: the **y** axis ([PND-HCAT]).
   *
   * The y axis stays a linear scale over the layer's unit slots (`[i, i+1]`),
   * so this only supplies *labels*: a `<YAxis>` in the row with no explicit
   * `ticks` derives one tick per category at the slot centre (`i + 0.5`).
   * That hand-built tick list was the friction the gallery funnel documented.
   */
  binCategories?(): readonly string[] | null;
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
/**
 * The keyboard modifiers held during the click that produced a selection —
 * handed to `<Selector onSelect>` alongside the hit ([PND-MULTISEL]).
 *
 * **Why the library reports these instead of acting on them.** A consumer with
 * a multi-valued filter needs ⌘/Ctrl-click to mean "add to the selection", and
 * without the modifier state on the callback it simply cannot: the click has
 * already been reduced to a hit by the time it arrives, so every consumer is
 * forced to treat every click as a replace. Reporting the modifiers keeps the
 * *policy* with the consumer while removing the thing that made the policy
 * unexpressible.
 *
 * The library itself still applies no modifier semantics — a chart click sets
 * the single hit as it always has. A consumer that wants add/toggle reads
 * {@link additive} and drives the controlled `selected` set itself.
 */
export interface SelectModifiers {
  /**
   * The platform-idiomatic **"add to selection"** chord — `metaKey` on macOS,
   * `ctrlKey` elsewhere, surfaced as one boolean so every consumer doesn't
   * re-derive the same platform rule (and get it wrong on one of the two).
   * Prefer this over the raw keys unless you specifically want one of them.
   */
  readonly additive: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /**
   * **Note the conflict:** `shift` is already the drag chord for
   * `<ChartContainer regionSelectModifier="shift">` on a continuous axis, so a
   * shift-click there may also be the start of a region drag. Reported for
   * completeness; think before you give it a second meaning. (There is
   * deliberately no derived `range` flag for this reason — an ordinal range
   * gesture is [PND-CATRANGE], not a modifier.)
   */
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * A mounted `<Selector>` as the container holds it — the reporting callbacks
 * plus the mount scope (interaction RFC §7 / A4.2). **A selector both reports
 * and, optionally, owns controlled state** (`selected` / `hovered` — A10.3):
 * the gesture and the state it drives are declared on the same mount.
 *
 * Registered via {@link ContainerFrame.registerSelector}, the same idiom as
 * `registerCursor`. Internal (not exported from `index.ts`) — `<Selector>`'s
 * props are the public surface.
 */
export interface SelectorEntry {
  /** Report the mark under the pointer (`null` on leaving every mark). */
  readonly onHover: ((hit: SelectInfo | null) => void) | undefined;
  /** Report the clicked mark plus the modifiers held. The library applies no
   *  policy to them and holds no set — see {@link SelectModifiers}. */
  readonly onSelect:
    | ((hit: SelectInfo | null, modifiers?: SelectModifiers) => void)
    | undefined;
  /**
   * Whether this entry is a mounted `<MultiSelector>` (RFC §8) — the flag the
   * sweep gesture resolves on: **mounting one is what arms the sweep drag** on
   * the plot, exactly as mounting any selector is what arms the click (§7.1).
   * `<Selector>` registers `false`.
   */
  readonly multi: boolean;
  /** `<MultiSelector onHover>` — the marks a live sweep covers (0/1 outside a
   *  drag, mirroring the single-hit channel). Plural entries only. */
  readonly onHoverMany?: ((hits: readonly SelectInfo[]) => void) | undefined;
  /** `<MultiSelector onSelect>` — RFC A5.2's `(hits, modifiers, span)`. A
   *  plain click reports `([hit] | [], modifiers, null)`; a sweep release
   *  reports the covered marks plus the span they demote to. Plural entries
   *  only. */
  readonly onSelectMany?:
    | ((
        hits: readonly SelectInfo[],
        modifiers: SelectModifiers | undefined,
        spans: readonly SpanSelection[],
      ) => void)
    | undefined;
  /** `<MultiSelector sequence>` — the sweep's bucket snap, folded into the
   *  container's shared snap-bucket channel (as `<RangeCursor sequence>` is). */
  readonly sequence?: Sequence | BoundedSequence | undefined;
  /** Mount scope: a row's key when mounted inside a `<ChartRow>` (that row's
   *  clicks only), `null` when mounted at the container (every row). */
  readonly rowKey: symbol | null;
  /**
   * Whether the **gesture** is active (`<Selector enabled>`, A10.2). `false`
   * means the plot behaves as if this entry were unmounted — no hit-testing,
   * no callbacks fire, no sweep arms — while the entry may still be the
   * chart's controlled-state owner below. This is what makes
   * `<Selector enabled={false} selected={sel} />` the "highlight only, no
   * plot gesture" configuration: one component, gesture off, state on.
   */
  readonly gestureEnabled: boolean;
  /** Whether `selected` was explicitly passed to this mount — distinguishes
   *  "controlled with nothing selected" (`null`) from "not the state owner"
   *  (`undefined`), the same three-state shape `selected` itself needs. */
  readonly declaresSelected: boolean;
  /** `<Selector selected>` / `<MultiSelector selected>` (A10.3) — meaningful
   *  only when {@link declaresSelected} is true. */
  readonly selected?: SelectInfo | readonly SelectionEntry[] | null | undefined;
  /** As {@link declaresSelected}, for `hovered`. */
  readonly declaresHovered: boolean;
  /** `<Selector hovered>` / `<MultiSelector hovered>` (A10.3) — meaningful
   *  only when {@link declaresHovered} is true. */
  readonly hovered?: SelectInfo | readonly SelectInfo[] | null | undefined;
}

/**
 * The span a completed `<RangeCursor>` drag reports to `onDragRelease` —
 * **one uniform shape with an optional y** (interaction RFC A3.3), not the
 * bare pair the legacy `onRegionSelect` used, and not a polymorphic union a
 * consumer must narrow.
 *
 * `x` is `[lo, hi]` in **axis units** — epoch ms on a time axis, the axis
 * value (strike, distance, …) on a value axis — snapped to the cursor's
 * buckets when it has a `sequence` (or a histogram's bins), else the raw drag
 * span. `y` is **absent on today's 1-D layers**; the 2-D drag (scatter / heat
 * map — [PND-INTERACT2D]) will populate it *without a breaking change*, which
 * is the whole reason the 1-D payload is already an object.
 *
 * The x pair feeds `ChartContainer.range` directly (it accepts a
 * `readonly [number, number]`), so drag-to-zoom is
 * `onDragRelease={(s) => setRange(s.x)}`; a time-axis consumer who wants a
 * `TimeRange` constructs one from the pair.
 */
export interface RangeSpan {
  readonly x: readonly [number, number];
  /** Present only on a 2-D drag (scatter / heat map) — not yet emitted. */
  readonly y?: readonly [number, number];
}

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
   * An optional **stable per-mark identity within the layer** — every mark
   * shares the layer's `id`, so this is the handle that picks one *within* it.
   * When a selection carries it, the highlight match + controlled `selected`
   * echo key on `(id, mark)` instead of the sample `key`, so a pin survives a
   * reorder / data update that renumbers the slot.
   *
   * Two layers report one today:
   *
   * - A **categorical** bar reports its *column name* — the slot index is not
   *   stable across a reorder, the name is.
   * - A **single-series** bar (`<BarChart series column>`) reports its own axis
   *   key, stringified. On a **point-keyed** series the sample `key` is *not*
   *   its identity: the bar span is synthesized from neighbour spacing, so
   *   `key` is a derived edge (`t - halfGap`) rather than the sample's own
   *   time. See `BarSeries.marks`.
   *
   * `undefined` for every other mark (scatter, box, candle), whose sample `key`
   * *is* its identity. A selection without a `mark` still matches on `key`
   * everywhere — the mark is an additional channel, not a replacement.
   */
  readonly mark?: string;
}

/**
 * A **span selection** — a compact range descriptor over one layer's marks, the
 * second currency `selected` accepts beside per-mark {@link SelectInfo} entries
 * (interaction RFC A5.2). Where a mark entry names one mark, a span names
 * *every* mark of layer {@link id} inside its extent — the shape a sweep
 * gesture commits, and the shape a consumer with a range-valued filter already
 * has. Membership is evaluated per draw against the mark's own channels, so a
 * span costs O(1) per mark however many marks it covers.
 *
 * **The containment rule, stated once** (evaluated by `selectionContains` and,
 * identically, by every layer's draw): a mark is inside a span when the span's
 * `id` is the mark's layer, the mark's **key** (its `SelectInfo.key` — the bin
 * axis position in axis units) lies in the **half-open** interval
 * `x[0] <= key < x[1]`, the mark's **value** (its `SelectInfo.value`) lies in
 * `y[0] <= value < y[1]` when {@link y} is present, and the mark's **label**
 * (its `SelectInfo.label` — the row/group name on a 2-D-ordinal layer) is a
 * member of {@link rows} when present.
 *
 * **Half-open, deliberately** — the pond bucket convention (`[begin, end)`),
 * and the half the edge rule needs: contiguous interval marks share edges
 * (`end[i] === begin[i+1]`), so a sweep that captures marks `i..j` by
 * *intersection* stores the snapped-outward edges `[begin(i), end(j)]`, and the
 * half-open key test then reproduces exactly the captured set — `begin(j+1) ===
 * end(j)` falls out on the open side (RFC A7.6). A closed test would light the
 * first mark *past* the sweep on every shared edge.
 *
 * **Two optional second dimensions, not one** (RFC A5.3): {@link y} is a
 * numeric interval for a continuous × continuous layer (scatter), where the
 * second coordinate is the mark's plotted value. {@link rows} is a label set
 * for a continuous × ordinal layer (heat map), whose second coordinate is an
 * ordinal row **name** — a numeric y-interval there would be untestable from a
 * hit (the hit carries no slot number) and unstable under a row reorder. Do not
 * conflate them.
 */
export interface SpanSelection {
  /** Discriminant against {@link SelectInfo} (which has no `kind`). */
  readonly kind: 'span';
  /** The **layer** whose marks the span covers — a layer `id`, exactly as
   *  {@link SelectInfo.id}. A span never matches marks of another layer. */
  readonly id: string;
  /**
   * The key-axis extent in **axis units** (epoch ms on a time axis, the axis
   * value on a value axis), half-open `[lo, hi)` against each mark's
   * {@link SelectInfo.key}. This is the layer's **bin/key axis** whatever the
   * orientation — a horizontal heat map's bins run down the screen, but their
   * keys (and so this interval) stay in bin-axis units. Must be ordered
   * `lo <= hi`; a reversed or empty pair matches nothing.
   */
  readonly x: readonly [number, number];
  /**
   * Optional **value-axis** interval, half-open against each mark's
   * {@link SelectInfo.value} — the continuous second dimension of a 2-D sweep
   * on a scatter (RFC A3.3/A5.3). Omit for 1-D layers.
   */
  readonly y?: readonly [number, number];
  /**
   * Optional **row label set**, matched against each mark's
   * {@link SelectInfo.label} — the ordinal second dimension of a 2-D sweep on
   * a heat map (RFC A5.3), stable under a row reorder because it names rows
   * rather than numbering slots. Omit for 1-D layers.
   */
  readonly rows?: readonly string[];
}

/**
 * One entry of a plural `selected` — a single mark ({@link SelectInfo}) or a
 * whole range of one layer's marks ({@link SpanSelection}). The two currencies
 * of interaction RFC A5.2: clicks produce marks, sweeps produce a span (plus
 * the marks it covered, for demote-on-edit). Discriminate with
 * `isSpanSelection` / the `kind` field.
 */
export type SelectionEntry = SelectInfo | SpanSelection;

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

/**
 * How a cursor wants the shared `cursorX` snapped, **declared, resolved by the
 * container** (interaction RFC A2.3). The x-snap consults each layer's
 * `sampleAt` in the hovered row and writes the result into the shared
 * {@link CursorFrame.cursorX} every other row reads — a cursor component has
 * neither the layers nor the right to write that value, so it declares the
 * policy and the container resolves it. Container resolves; slots draw.
 *
 * - `'none'` — the raw pointer x.
 * - `'sample'` — snap to the nearest data sample's x (the crosshair).
 * - `'sequence'` — bucket-shaped: the *rendering* snaps to the realized
 *   sequence buckets (the range cursor's band); `cursorX` itself stays raw.
 */
export type CursorSnapX = 'none' | 'sample' | 'sequence';

/**
 * One resolved per-series measurement at the cursor — **finished numbers, not
 * raw materials** (interaction RFC A2.3): the sample's plot pixels, the axis it
 * scales against (id + side, so a pill can hug the right gutter), and its value
 * already formatted by that axis's formatter. A cursor slot draws these; it
 * never sees a scale, a format map, or an axis-side map.
 */
export interface ResolvedCursorSample {
  readonly px: number;
  readonly py: number;
  readonly axisId: string;
  readonly side: 'left' | 'right';
  readonly formatted: string;
  readonly color: string;
  readonly label: string;
}

/** A resolved consolidated multi-value flag (a {@link RowLayer.cursorFlag}
 *  layer — the BoxPlot): its anchor pixels + the formatted, coloured lines. */
export interface ResolvedCursorFlag {
  readonly px: number;
  readonly topPy: number;
  readonly lines: readonly { readonly text: string; readonly color: string }[];
}

/**
 * The frame handed to a {@link CursorSpec}'s render slots — resolved geometry
 * and finished measurements (RFC A2.3), never scales or format maps.
 *
 * **Internal for now** (deliberately not exported from `index.ts`): RFC Q3
 * publishes the cursor contract only after every built-in preset — and the SR
 * gapped crosshair — is written against it. The presets in `cursors.tsx` are
 * that litmus; until it passes, this shape may still move.
 */
export interface ResolvedCursorFrame {
  /** The shared plot-pixel x ({@link CursorFrame.cursorX}) — may be out of
   *  `[0, plotWidth]` (a controlled tracker extrapolated); slots gate. */
  readonly cursorX: number | null;
  /** The hovered plot-pixel y (row-local; see {@link CursorFrame.cursorY}). */
  readonly cursorY: number | null;
  /** The **renderer's own** row, `null` in the x-axis slot… */
  readonly rowKey: symbol | null;
  /** …alongside the **hovered** row (A1.3: a slot needs both to know whether
   *  it is drawing in the row the pointer is in). */
  readonly hoveredRowKey: symbol | null;
  /** Per-series resolved measurements at the cursor time (empty when the
   *  effective cursors declared no need for them, or nothing is hovered). */
  readonly samples: readonly ResolvedCursorSample[];
  /** Resolved consolidated flags (BoxPlot) — the flag cursor's one-chip form. */
  readonly flags: readonly ResolvedCursorFlag[];
  /**
   * The **raw pointer**'s y resolved against the row's default axis — position,
   * formatted value, and axis side — or `null` when this row isn't hovered.
   * The free (non-snapping) crosshair reads this; it is resolved here because a
   * slot has no `yScale.invert` to do it itself.
   */
  readonly pointer: {
    readonly py: number;
    readonly formatted: string;
    readonly side: 'left' | 'right';
  } | null;
  /** The range cursor's **band** under the pointer (bucket-snapped via the
   *  declared sequence, else the drag span), as clamped plot pixels; `null`
   *  when nothing to shade. Resolved by the container from `regionSpan`. */
  readonly band: { readonly x0: number; readonly x1: number } | null;
  /**
   * The **transposed band** — the same brush over a layer that declares
   * `sweepAxis: 'y'` (a horizontal `<BarChart>`, whose bins run down the
   * screen), as plot pixels on the row's own y axis. `null` in every other
   * state, including an x sweep, which paints {@link band}.
   *
   * Row-local for {@link rect}'s reason: a y interval only means anything
   * against the axis that measured it, so the row owning the drag resolves it
   * and the others stay `null`. It is drawn by the same `renderBrushBand` with
   * the geometry transposed — one renderer, so the two orientations of one
   * gesture cannot drift (§8.1).
   */
  readonly bandY: { readonly y0: number; readonly y1: number } | null;
  /** Degenerate range cursor (no buckets, not mid-drag): draw a plain line. */
  readonly bandLine: boolean;
  /**
   * Whether the band's extent is being **dragged** right now — a range drag
   * anchored, or a `<MultiSelector>` sweep past its slop — rather than merely
   * previewing the block under the pointer.
   *
   * The band renders in both states; this is what separates them. The edges
   * are the gesture's grabbed boundary, so they draw only while there is a
   * gesture: at rest the band is a *preview*, and edging a preview reads as a
   * committed range the user hasn't made yet.
   */
  readonly bandDragging: boolean;
  /**
   * The **2-D brush rect** — a live `<MultiSelector>` sweep over a `twoD`
   * layer ({@link SweepSession.twoD}: a scatter, a heat map), as clamped plot
   * pixels. `null` in every other state, including a 1-D sweep, which paints
   * {@link band} instead.
   *
   * It is deliberately **not** a band with a y range bolted on. The band is
   * container state, so every row paints it from one anchor — right for an
   * x-range, which means the same thing in every row. A rect's y is only
   * meaningful in the row whose layer's axis it was measured against, so this
   * is resolved per row by the row that owns the drag, and stays `null` in
   * the others.
   *
   * **Unsorted, on purpose:** `(x0, y0)` is the corner the drag was anchored
   * at and `(x1, y1)` the corner under the pointer, so either may be the
   * larger. The renderer sorts for the box, but it needs the diagonal intact
   * to put the two crosshairs on the corners the user is actually holding.
   * (`x` is still the *snapped* band edge where the layer snaps — assigned to
   * whichever end the anchor is on.)
   */
  readonly rect: {
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
  } | null;
  /**
   * Draw the **resting** 2-D brush — a small grey `+` at the pointer, the
   * rect gesture's answer to {@link band}'s resting block preview.
   *
   * Small on purpose, and not a crosshair in the usual sense. A full-plot
   * crosshair is a value-reading instrument: it exists to project the pointer
   * onto both axes. This one marks *a corner a rect would start from*, and
   * the rect draws its own edges out to those axes the moment a drag begins —
   * so plot-spanning rules would add two more lines to a picture that is
   * about to have them anyway. The compact `+` says "here", which is all a
   * corner needs to say.
   */
  readonly restingCross: boolean;
  /** The cursor time, formatted by the container's readout channel
   *  (`formatReadout ?? formatTime` in a row; the axis's own resolved readout
   *  formatter in the x-axis slot). `null` when out of bounds / not wanted. */
  readonly formattedTime: string | null;
  readonly plotWidth: number;
  /** The renderer's row height (`0` in the x-axis slot). */
  readonly rowHeight: number;
  /** Whether this row is the topmost — the shared time chip shows once, here. */
  readonly isFirstRow: boolean;
  readonly theme: ChartTheme;
  /** X-axis slot placement (set only when invoking {@link CursorSpec.renderXAxis}):
   *  which side the axis strip is on and the pill's tick-label offset. */
  readonly xAxis: {
    readonly onTop: boolean;
    readonly pillOffset: number;
  } | null;
}

/**
 * A mounted cursor's contract with the container (interaction RFC A2.3):
 * **declared** snap plus up to three render slots taking resolved geometry.
 * The container resolves (`cursorX` snapping, per-sample measurements, the
 * band); the slots draw. Registered via {@link ContainerFrame.registerCursor}
 * — the same idiom as `registerAxis` / `registerLayer`.
 *
 * Internal for now, like {@link ResolvedCursorFrame} (RFC Q3).
 */
export interface CursorSpec {
  /** How the shared `cursorX` snaps while this cursor owns the hovered row. */
  readonly snapX?: CursorSnapX;
  /** SVG into the row's cursor overlay (above the data canvas — hovering never
   *  repaints the canvas). */
  renderPlot?(f: ResolvedCursorFrame): ReactNode;
  /**
   * DOM into the row's overlay, above the SVG — the value chips (inline /
   * flag) and the in-plot time readout. NOT in RFC A2.3's three-slot shape:
   * the production flag/inline cursors are DOM chips positioned in plot space,
   * which "SVG into the overlay" cannot express — the same gap A1.3 called on
   * §5. Kept internal; the published contract must resolve this (see the
   * step-2 notes in the charts plan).
   */
  renderPlotHtml?(f: ResolvedCursorFrame): ReactNode;
  /** DOM, per row: the axis-edge **value pill** (positioned via `axisPillX`,
   *  overflowing the plot into its axis gutter). */
  renderYGutter?(f: ResolvedCursorFrame): ReactNode;
  /** DOM, on the shared x axis: the **time pill** (+ its connector). `<XAxis>`
   *  shows it whenever the hovered row's effective cursor registers this slot
   *  — the mount is the gate, not a mode string. */
  renderXAxis?(f: ResolvedCursorFrame): ReactNode;
}

/** What a cursor needs the container to resolve per pointer move — declared at
 *  registration so a line-only cursor never pays for per-sample measurement. */
export interface CursorWants {
  /** Per-series {@link ResolvedCursorSample}s (dots, chips, the reticle pick). */
  readonly samples: boolean;
  /** Consolidated {@link ResolvedCursorFlag}s (the flag cursor only). */
  readonly flags: boolean;
  /** The range band (+ the degenerate band line). */
  readonly band: boolean;
  /** The raw-pointer readout (the free crosshair). */
  readonly pointer: boolean;
  /** The formatted in-plot cursor time (`showTime` presets). */
  readonly time: boolean;
}

/**
 * A registered cursor as the container holds it: the {@link CursorSpec} plus
 * the resolution inputs that must live on the registration rather than the
 * spec — scope, gesture ownership, and the declared needs.
 */
export interface CursorEntry {
  readonly spec: CursorSpec;
  /** Mount scope: a row's key when mounted inside a `<ChartRow>` (the per-row
   *  override), `null` when mounted at the container (the default for all rows). */
  readonly rowKey: symbol | null;
  /** Synthesized by the deprecation shim from the legacy string props. A scope
   *  with any non-legacy (component-mounted) cursor drops its legacy entries —
   *  mounting a component overrides the string prop during the window. */
  readonly legacy: boolean;
  /**
   * The shim entry nobody asked for: the container's `'line'` **default**,
   * synthesized with no `cursor` prop set. A mounted `<MultiSelector>`'s
   * resting block preview (the brush band as the resting cursor) replaces
   * only these — an explicitly chosen cursor, component-mounted or via the
   * legacy string prop, still wins.
   */
  readonly implicit?: boolean;
  /**
   * Whether this cursor owns **snap and gesture** (RFC A2.5): at most one per
   * scope (dev-warned otherwise), resolved to the hovered row's innermost
   * mount. Render-only presets (line/point/inline/flag) stack freely.
   */
  readonly ownsGesture: boolean;
  readonly wants: CursorWants;
  /** The range cursor's bucket sequence (realized by the container into the
   *  shared snap buckets — the `cursorSequence` successor). */
  readonly sequence?: Sequence | BoundedSequence | undefined;
  /** The range cursor's drag-release callback (the `onRegionSelect`
   *  successor) — read by the brush recognizer (`resolveRangeDrag`), which
   *  wraps it into the range-drag session. Only a `<RangeCursor>` sets it. */
  readonly onDragRelease?: ((span: RangeSpan) => void) | undefined;
  /** Whether the range drag is live — **resolved** at build time
   *  (`enableDrag ?? !!onDragRelease`), so `false` here means frozen: the
   *  gesture is off even though the callback is wired (§6's OFF switch). */
  readonly enableDrag?: boolean | undefined;
  /** The modifier the range drag needs (the `regionSelectModifier`
   *  successor) — only enforced while pan is enabled. */
  readonly dragModifier?: 'shift' | undefined;
  /** The cursor's readout format (the `cursorFormat` successor) — resolved by
   *  the container into the shared readout channel. */
  readonly format?: CursorFormat | undefined;
}

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
/** Which scale a y axis maps its domain through. */
export type YScaleKind = 'linear' | 'log' | 'symlog';

/**
 * A row's resolved y scale — d3's `scaleLinear()`, `scaleLog()` when the axis
 * asks for `scale="log"`, or `scaleSymlog()` for `scale="symlog"`.
 *
 * Deliberately the **continuous-numeric** supertype rather than `ScaleLinear`:
 * every consumer (the axis labels, the row's gridlines, the cursor readout, and
 * every draw layer) only ever calls it, or reads `domain` / `range` / `ticks` /
 * `tickFormat` / `invert` — the surface all three scales share. Keeping the
 * shared type here is what lets a log or symlog axis be transparent to the draw
 * layers instead of every layer growing a branch.
 */
export type YScale = ScaleContinuousNumeric<number, number>;

export interface AxisSpec {
  readonly id: string;
  readonly side: 'left' | 'right';
  /** Gutter width in CSS pixels. */
  readonly width: number;
  /** Which scale the axis maps its domain through ({@link YAxisProps.scale}). */
  readonly scale: YScaleKind;
  /** `scale="symlog"`'s linear window as a **fraction of the domain's largest
   *  magnitude** ({@link YAxisProps.linearWindow}) — `undefined` on any other
   *  scale. Domain-relative rather than absolute so it survives a domain change
   *  without a recompute ([PND-SYMLOG]). */
  readonly linearWindow?: number | undefined;
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
  /**
   * The plot's **top inset** within the row's box, in px — the header band
   * reserved when any axis in the row draws a `labelPlacement="top"` title,
   * and `0` when none does. The y-scales' range is `[height, topInset]`, so
   * the drawable plot is `topInset … height`.
   *
   * Carried on the frame (rather than staying a local in `ChartRow`) because
   * {@link useChartFrame} publishes it — without it a consumer placing an
   * overlay inside the plot would silently sit under a top axis title.
   */
  readonly topInset: number;
  readonly yScales: ReadonlyMap<string, YScale>;
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
