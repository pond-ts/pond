import {
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { scaleLinear } from 'd3-scale';
import { Canvas } from './Canvas.js';
import {
  ContainerContext,
  LayersContext,
  RowContext,
  type LayerRegistry,
  type RowLayer,
} from './context.js';

export interface LayersProps {
  children?: ReactNode;
}

/**
 * The plot area of a {@link ChartRow}: a single `<canvas>` plus the draw-layer
 * registry. It is the boundary where the row's **horizontal** layout (axes
 * positioned left/right) flips to **z-stacking** — child layers
 * ({@link LineChart}, …) register here via context and paint into the one canvas.
 *
 * **Z-order — declaration order, last child on top.** Layers paint in the order
 * they appear in JSX: the first child renders at the back, the last on top. This
 * matches SVG / DOM document order and react-timeseries-charts, so a row is
 * authored back-to-front (e.g. `<BandChart/>` then `<LineChart/>` puts the line
 * over its band — estela's terrain → bands → lines stack).
 *
 * Z-order currently derives from registration order, which equals declaration
 * order on mount; a layer that re-registers after a prop change moves to the
 * front. Invisible with one layer — hardened to a stable slot when M3 brings the
 * overlaid variance band in (the first stack that matters).
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

  const [layers, setLayers] = useState<readonly RowLayer[]>([]);
  const registry = useMemo<LayerRegistry>(
    () => ({
      register: (layer) => {
        setLayers((ls) => [...ls, layer]);
        return () => setLayers((ls) => ls.filter((l) => l !== layer));
      },
    }),
    [],
  );

  const domain = useMemo<[number, number]>(() => {
    if (row.yDomain) return [row.yDomain[0], row.yDomain[1]];
    let min = Infinity;
    let max = -Infinity;
    for (const layer of layers) {
      const e = layer.yExtent();
      if (e) {
        if (e[0] < min) min = e[0];
        if (e[1] > max) max = e[1];
      }
    }
    if (min === Infinity) return [0, 1]; // no finite data yet
    if (min === max) return [min - 1, max + 1]; // flat — give it room
    return [min, max];
  }, [layers, row.yDomain]);

  const yScale = useMemo(
    () => scaleLinear().domain(domain).range([row.height, 0]),
    [domain, row.height],
  );

  const background = container.theme.background;
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (background !== undefined) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
      }
      for (const layer of layers) layer.draw(ctx, container.xScale, yScale);
    },
    [layers, container.xScale, yScale, background],
  );

  return (
    <LayersContext.Provider value={registry}>
      <Canvas width={row.plotWidth} height={row.height} draw={draw} />
      {children}
    </LayersContext.Provider>
  );
}
