import { createContext } from 'react';
import type { ScaleLinear } from 'd3-scale';

/**
 * The time-axis frame a {@link ChartContainer} provides to its rows: the shared
 * x-scale (time→pixels), the plot width, and the time domain.
 */
export interface ContainerFrame {
  readonly xScale: ScaleLinear<number, number>;
  readonly width: number;
  readonly timeRange: readonly [number, number];
}

export const ContainerContext = createContext<ContainerFrame | null>(null);

/**
 * A draw layer registered into a {@link ChartRow}. The row computes its
 * y-domain from the union of its layers' {@link RowLayer.yExtent} (unless an
 * explicit domain is given), then runs each layer's {@link RowLayer.draw} in
 * registration order in one canvas pass.
 */
export interface RowLayer {
  /** This layer's finite-value `[min, max]`, or `null` if it has none. */
  yExtent(): [number, number] | null;
  /** Draw into the row's canvas. `xScale`/`yScale` map data→pixels. */
  draw(
    ctx: CanvasRenderingContext2D,
    xScale: (value: number) => number,
    yScale: (value: number) => number,
  ): void;
}

/** The registry a {@link ChartRow} exposes to its child draw layers. */
export interface RowRegistry {
  /** Register a layer; returns an unregister function for effect cleanup. */
  register(layer: RowLayer): () => void;
}

export const RowContext = createContext<RowRegistry | null>(null);
