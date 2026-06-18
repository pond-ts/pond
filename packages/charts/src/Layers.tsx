import { useCallback, useContext, useMemo, type ReactNode } from 'react';
import { Canvas } from './Canvas.js';
import { drawGrid } from './grid.js';
import {
  ContainerContext,
  LayersContext,
  RowContext,
  type LayerRegistry,
} from './context.js';

/** Gridline tick count — matches the axes (`YAxis`/`TimeAxis`) so they align. */
const GRID_TICKS = 5;

export interface LayersProps {
  children?: ReactNode;
}

/**
 * The plot area of a {@link ChartRow}: a single `<canvas>` plus the draw-layer
 * registry. It is the boundary where the row's horizontal layout flips to
 * z-stacking — child layers ({@link LineChart}, …) register here and paint into
 * the one canvas, each with its own axis's y-scale (looked up by the layer's
 * `axis` id, defaulting to the row's default axis).
 *
 * **Z-order — declaration order, last child on top** (SVG / DOM / RTC). A row is
 * authored back-to-front: `<BandChart/>` then `<LineChart/>` puts the line over
 * its band. Layers register into a stable, id-keyed slot, so a series/style/prop
 * change updates in place and the z-order holds (it doesn't jump to the front on
 * every update — the trap that bites live charts).
 */
export function Layers({ children }: LayersProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<Layers> must be rendered inside a <ChartContainer>');
  }
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error('<Layers> must be rendered inside a <ChartRow>');
  }

  const registry = useMemo<LayerRegistry>(
    () => ({
      registerLayer: row.registerLayer,
      unregisterLayer: row.unregisterLayer,
    }),
    [row.registerLayer, row.unregisterLayer],
  );

  const background = container.theme.background;
  const { grid: gridColor, gridDash } = container.theme.axis;
  const { layers, yScales, defaultAxisId } = row;
  // x geometry is shared and lives on the container (uniform across rows).
  const { xScale, plotWidth } = container;
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (background !== undefined) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
      }
      // Gridlines behind the data, from the same ticks the axes label: vertical
      // from the shared time scale, horizontal from the row's default y-axis.
      const gridY = yScales.get(defaultAxisId);
      const xTicks = xScale.ticks(GRID_TICKS).map((d) => xScale(d));
      const yTicks = gridY ? gridY.ticks(GRID_TICKS).map((t) => gridY(t)) : [];
      drawGrid(ctx, xTicks, yTicks, w, h, gridColor, gridDash);
      for (const entry of layers) {
        const yScale = yScales.get(entry.axisId ?? defaultAxisId);
        if (yScale === undefined) continue;
        entry.layer.draw(ctx, xScale, yScale);
      }
    },
    [layers, yScales, xScale, defaultAxisId, background, gridColor, gridDash],
  );

  return (
    <LayersContext.Provider value={registry}>
      <Canvas width={plotWidth} height={row.height} draw={draw} />
      {children}
    </LayersContext.Provider>
  );
}
