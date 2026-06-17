import { useCallback, useContext, useMemo, type ReactNode } from 'react';
import { Canvas } from './Canvas.js';
import {
  ContainerContext,
  LayersContext,
  RowContext,
  type LayerRegistry,
} from './context.js';

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
 * its band. (Currently registration-order; hardened to a stable slot when M3's
 * overlaid band lands.)
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
    () => ({ registerLayer: row.registerLayer }),
    [row.registerLayer],
  );

  const background = container.theme.background;
  const { layers, yScales, xScale, defaultAxisId } = row;
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (background !== undefined) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
      }
      for (const entry of layers) {
        const yScale = yScales.get(entry.axisId ?? defaultAxisId);
        if (yScale === undefined) continue;
        entry.layer.draw(ctx, xScale, yScale);
      }
    },
    [layers, yScales, xScale, defaultAxisId, background],
  );

  return (
    <LayersContext.Provider value={registry}>
      <Canvas width={row.plotWidth} height={row.height} draw={draw} />
      {children}
    </LayersContext.Provider>
  );
}
