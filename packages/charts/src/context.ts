import { createContext } from 'react';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import type { ChartTheme } from './theme.js';

/**
 * The frame a {@link ChartContainer} provides to its rows and the time axis.
 * The container owns the **shared x geometry**: it reserves a *uniform* gutter
 * each side (the max any row needs — see {@link GutterReq}) so every row's plot
 * left-aligns under one time axis, then derives `plotWidth` and the shared
 * time→pixel `xScale` from it. Y scales stay per-row (row-local data), on the
 * {@link RowFrame}.
 */
export interface ContainerFrame {
  readonly timeRange: readonly [number, number];
  readonly width: number;
  readonly theme: ChartTheme;
  /** Plot width in px after the uniform gutters — shared by every row. */
  readonly plotWidth: number;
  /** Uniform reserved gutters (the max of any row's per-side axis widths). */
  readonly leftGutter: number;
  readonly rightGutter: number;
  /**
   * Shared time→pixel scale, range `[0, plotWidth]`. A d3 `scaleTime` so ticks
   * land on wall-clock boundaries; the domain is the container's `timeRange`
   * (epoch ms, which `scaleTime` coerces).
   */
  readonly xScale: ScaleTime<number, number>;
  /**
   * A row reports its per-side gutter need; the container reserves the max each
   * side so every row's plot left-aligns. Returns an unregister fn for cleanup.
   */
  registerGutter(req: GutterReq): () => void;
}

/** A row's per-side gutter requirement (sum of its axis widths on each side). */
export interface GutterReq {
  readonly left: number;
  readonly right: number;
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
  registerAxis(spec: AxisSpec): () => void;
  registerLayer(entry: LayerEntry): () => void;
  readonly layers: readonly LayerEntry[];
}

export const RowContext = createContext<RowFrame | null>(null);

/**
 * The registry a {@link Layers} exposes to its child draw layers — the boundary
 * that makes a layer a layer (children here register; a layer outside `<Layers>`
 * errors). Forwards to the row's layer registry.
 */
export interface LayerRegistry {
  registerLayer(entry: LayerEntry): () => void;
}

export const LayersContext = createContext<LayerRegistry | null>(null);
