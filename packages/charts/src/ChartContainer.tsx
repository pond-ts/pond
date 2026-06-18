import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { scaleTime } from 'd3-scale';
import {
  ContainerContext,
  type ContainerFrame,
  type GutterReq,
} from './context.js';
import { TimeAxis } from './TimeAxis.js';
import { defaultTheme, type ChartTheme } from './theme.js';

export interface ChartContainerProps {
  /** Time domain `[start, end]` in epoch ms — the shared x-axis for all rows. */
  timeRange: readonly [number, number];
  /** Total width in CSS pixels (plot + axis gutters). */
  width: number;
  /** Visual theme for all rows; defaults to {@link defaultTheme}. */
  theme?: ChartTheme;
  children?: ReactNode;
}

/**
 * The top of the chart layout (react-timeseries-charts-style). Owns the shared
 * **x geometry**: it collects each row's per-side gutter need, reserves the max
 * each side so every row's plot left-aligns, and from that derives `plotWidth`
 * and the shared time `xScale`. It renders its rows then one {@link TimeAxis} at
 * the bottom, aligned under the plots. Y axes are per-row (`<YAxis>`).
 */
export function ChartContainer({
  timeRange,
  width,
  theme,
  children,
}: ChartContainerProps) {
  const t0 = timeRange[0];
  const t1 = timeRange[1];

  // Rows report their per-side gutter need; we reserve the max each side.
  const [gutters, setGutters] = useState<readonly GutterReq[]>([]);
  const registerGutter = useCallback((req: GutterReq) => {
    setGutters((g) => [...g, req]);
    return () => setGutters((g) => g.filter((x) => x !== req));
  }, []);

  const leftGutter = useMemo(
    () => gutters.reduce((m, g) => Math.max(m, g.left), 0),
    [gutters],
  );
  const rightGutter = useMemo(
    () => gutters.reduce((m, g) => Math.max(m, g.right), 0),
    [gutters],
  );
  const plotWidth = Math.max(0, width - leftGutter - rightGutter);

  const xScale = useMemo(
    () => scaleTime().domain([t0, t1]).range([0, plotWidth]),
    [t0, t1, plotWidth],
  );

  const frame = useMemo<ContainerFrame>(
    () => ({
      timeRange: [t0, t1],
      width,
      theme: theme ?? defaultTheme,
      plotWidth,
      leftGutter,
      rightGutter,
      xScale,
      registerGutter,
    }),
    [
      t0,
      t1,
      width,
      theme,
      plotWidth,
      leftGutter,
      rightGutter,
      xScale,
      registerGutter,
    ],
  );

  return (
    <ContainerContext.Provider value={frame}>
      <div style={{ width: `${width}px` }}>
        {children}
        <TimeAxis />
      </div>
    </ContainerContext.Provider>
  );
}
