import { createContext } from 'react';
import type { ScaleLinear } from 'd3-scale';
import type { ChartTheme } from './theme.js';

/**
 * The frame a {@link ChartContainer} provides to its rows: the shared x-scale
 * (time→pixels), the plot width, the time domain, and the resolved theme.
 */
export interface ContainerFrame {
  readonly xScale: ScaleLinear<number, number>;
  readonly width: number;
  readonly timeRange: readonly [number, number];
  readonly theme: ChartTheme;
}

export const ContainerContext = createContext<ContainerFrame | null>(null);

/**
 * The frame a {@link ChartRow} provides to its plot area (`<Layers>`) and axes:
 * the row height, the pixel width available for the plot (the row width minus
 * any axis gutters — full width until `YAxis` lands in M2.3), and the optional
 * explicit y-domain.
 */
export interface RowFrame {
  readonly height: number;
  readonly plotWidth: number;
  readonly yDomain: readonly [number, number] | undefined;
}

export const RowContext = createContext<RowFrame | null>(null);

/**
 * A draw layer registered into a {@link Layers}. The plot area computes its
 * y-domain from the union of its layers' {@link RowLayer.yExtent} (unless the
 * row gives an explicit domain), then runs each layer's {@link RowLayer.draw} in
 * declaration order in one canvas pass.
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

/** The registry a {@link Layers} exposes to its child draw layers. */
export interface LayerRegistry {
  /** Register a layer; returns an unregister function for effect cleanup. */
  register(layer: RowLayer): () => void;
}

export const LayersContext = createContext<LayerRegistry | null>(null);
