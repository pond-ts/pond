import { createContext } from 'react';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import type { ChartTheme } from './theme.js';
import type { AxisFormat } from './format.js';

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
   * The selected mark, or `null`. Shared across rows (single selection). A layer
   * highlights the mark matching **both** the key (epoch ms) and the series
   * (`label`) — so two series sharing a timestamp don't both light up. A
   * controlled `selected` prop pins it; otherwise a click on a selectable layer
   * sets it. The full {@link SelectInfo} (not just the key) is the identity so
   * multi-series Bar/Scatter can target the exact clicked mark.
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
   * Set-on-change (deduped by key+label) so the data canvas repaints only on a
   * mark transition, not every pointer move.
   */
  readonly hovered: SelectInfo | null;
  /** Set the hovered mark (or `null` to clear) from a pointer-move hit-test;
   *  deduped, so an unchanged mark is a no-op (no repaint). */
  setHovered(hit: SelectInfo | null): void;
  /** The default in-chart cursor presentation for all rows ({@link CursorMode});
   *  a row may override it via its own `cursor`. */
  readonly cursor: CursorMode;
  /** Show the cursor's time atop the in-chart readout (when a row's cursor draws
   *  one), formatted by {@link formatTime} to match the time axis. */
  readonly cursorTime: boolean;
  /** Format an epoch-ms instant the same way the time axis labels its ticks —
   *  shared by `<TimeAxis>` and the cursor-time readout. */
  readonly formatTime: (epochMs: number) => string;
  /**
   * Register a draw layer as a tracker source so the container can fan in every
   * series' value at the cursor for `onTrackerChanged`. Keyed by the layer's
   * per-instance slot key; unregister on unmount.
   */
  registerTrackerSource(key: symbol, source: TrackerSource): void;
  unregisterTrackerSource(key: symbol): void;
  /**
   * Shared x→pixel scale, range `[0, plotWidth]`. A d3 `scaleTime` (default) so
   * ticks land on wall-clock boundaries, or a `scaleLinear` when the container's
   * `xScaleType` is `'linear'` (a **value axis** — distance, cumulative work).
   * The domain is the container's `timeRange`. Both scales are callable
   * (`value → px`) and expose `invert`/`ticks`/`tickFormat`; consumers use only
   * that shared surface (the cursor coerces `invert` via `+`, `<TimeAxis>` keys
   * ticks via `+d`), so either kind drops in.
   */
  readonly xScale: ScaleTime<number, number> | ScaleLinear<number, number>;
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
 * A draw layer ({@link LineChart}, …) registered into a {@link Layers}, paired
 * with the id of the axis it scales against. The row computes a y-scale per
 * axis from the union of its linked layers' extents (or the axis's explicit
 * domain); each layer draws with its own axis's scale.
 */
export interface RowLayer {
  /** This layer's finite-value `[min, max]`, or `null` if it has none. */
  yExtent(): [number, number] | null;
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
   * `null`. **Optional:** layers without discrete selectable marks (line, band,
   * area) omit it; bar / box / scatter implement it. `xScale`/`yScale` map
   * data→pixels (the row resolves the layer's axis scale, as for `draw`).
   */
  hitTest?(
    px: number,
    py: number,
    xScale: (value: number) => number,
    yScale: (value: number) => number,
  ): SelectInfo | null;
  /** Draw into the plot canvas. `xScale`/`yScale` map data→pixels. */
  draw(
    ctx: CanvasRenderingContext2D,
    xScale: (value: number) => number,
    yScale: (value: number) => number,
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
  /** Series identity (`as` ?? column) — labels the value in a readout. */
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

/** A source of tracker samples — a draw layer, registered with the container so
 *  it can fan in every series' value at the cursor for {@link onTrackerChanged}. */
export interface TrackerSource {
  sampleAt(time: number): readonly TrackerSample[];
}

/**
 * One selected mark — what {@link RowLayer.hitTest} returns and `onSelect`
 * reports. Mirrors {@link TrackerSample}: the mark's key (its stable identity,
 * for controlled selection + highlight matching), value, colour, and series
 * label.
 */
export interface SelectInfo {
  /** The mark's key as epoch ms (its event's `begin`) — its stable identity. */
  readonly key: number;
  /** The mark's value (the plotted column). */
  readonly value: number;
  /** The mark's resolved style colour. */
  readonly color: string;
  /** Series identity (`as` ?? column) — labels the selection in a readout. */
  readonly label: string;
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
 */
export type CursorMode = 'none' | 'line' | 'point' | 'inline' | 'flag';

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
  /** Value formatting for the tick labels + the cursor readout ({@link AxisFormat}),
   *  or `undefined` for the scale's d3 default. */
  readonly format: AxisFormat | undefined;
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
  /** This row's cursor-mode override, or `undefined` to inherit the container's
   *  default ({@link ContainerFrame.cursor}). */
  readonly cursor: CursorMode | undefined;
  /** Whether this is the first (topmost) row — the shared cursor-time chip shows
   *  here only, not repeated on every row. Derived from {@link ContainerFrame.firstRowKey}. */
  readonly isFirstRow: boolean;
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
