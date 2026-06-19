import { createContext } from 'react';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import type { ChartTheme } from './theme.js';

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
   * Shared time→pixel scale, range `[0, plotWidth]`. A d3 `scaleTime` so ticks
   * land on wall-clock boundaries; the domain is the container's `timeRange`
   * (epoch ms, which `scaleTime` coerces).
   */
  readonly xScale: ScaleTime<number, number>;
  /**
   * A row reports its per-slot gutter widths each side; the container reserves
   * each slot's max so every row's plot left-aligns. Returns an unregister fn.
   */
  registerGutter(req: GutterReq): () => void;
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
  /** Draw into the plot canvas. `xScale`/`yScale` map data→pixels. */
  draw(
    ctx: CanvasRenderingContext2D,
    xScale: (value: number) => number,
    yScale: (value: number) => number,
  ): void;
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
export interface AxisSpec {
  readonly id: string;
  readonly side: 'left' | 'right';
  /** Gutter width in CSS pixels. */
  readonly width: number;
  /** Explicit domain bounds, or `undefined` to auto-fit linked layers. */
  readonly min: number | undefined;
  readonly max: number | undefined;
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
