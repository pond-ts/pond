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
  RowContext,
  type RowLayer,
  type RowRegistry,
} from './context.js';

export interface ChartRowProps {
  /** Row height in CSS pixels. */
  height: number;
  /**
   * Explicit y-domain `[min, max]`. Omitted ⇒ auto-fit to the union of the
   * row's layers' finite-value extents (a flat line gets ±1 of headroom).
   */
  yDomain?: readonly [number, number];
  children?: ReactNode;
}

/**
 * A horizontal band sharing the container's time axis. Owns the y-domain, a
 * single `<canvas>`, and a draw-layer registry: child layers
 * ({@link LineChart}, …) register via context and are drawn in one canvas pass.
 *
 * **Z-order — declaration order, last child on top.** Layers paint in the order
 * they appear in JSX: the first child renders at the back, the last on top.
 * This matches SVG / DOM document order and react-timeseries-charts, so a row
 * is authored back-to-front (e.g. `<BandChart/>` then `<LineChart/>` puts the
 * line over its band — estela's terrain → bands → lines stack).
 *
 * M1 derives this from registration order, which equals declaration order on
 * mount; a layer that re-registers after a data change currently moves to the
 * front. That's invisible with one layer per row — it's hardened to a stable
 * slot when M3 brings the overlaid variance band in (the first row that
 * actually stacks).
 */
export function ChartRow({ height, yDomain, children }: ChartRowProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<ChartRow> must be rendered inside a <ChartContainer>');
  }

  const [layers, setLayers] = useState<readonly RowLayer[]>([]);
  const registry = useMemo<RowRegistry>(
    () => ({
      register: (layer) => {
        setLayers((ls) => [...ls, layer]);
        return () => setLayers((ls) => ls.filter((l) => l !== layer));
      },
    }),
    [],
  );

  const domain = useMemo<[number, number]>(() => {
    if (yDomain) return [yDomain[0], yDomain[1]];
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
  }, [layers, yDomain]);

  const yScale = useMemo(
    () => scaleLinear().domain(domain).range([height, 0]),
    [domain, height],
  );

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      for (const layer of layers) layer.draw(ctx, container.xScale, yScale);
    },
    [layers, container.xScale, yScale],
  );

  return (
    <RowContext.Provider value={registry}>
      <Canvas width={container.width} height={height} draw={draw} />
      {children}
    </RowContext.Provider>
  );
}
