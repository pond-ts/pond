import { useMemo, type ReactNode } from 'react';
import { ContainerContext, type ContainerFrame } from './context.js';
import { defaultTheme, type ChartTheme } from './theme.js';

export interface ChartContainerProps {
  /** Time domain `[start, end]` in ms — the shared x-axis for all rows. */
  timeRange: readonly [number, number];
  /** Plot width in CSS pixels. */
  width: number;
  /** Visual theme for all rows; defaults to {@link defaultTheme}. */
  theme?: ChartTheme;
  children?: ReactNode;
}

/**
 * The top of the chart layout (react-timeseries-charts-style). Owns the time
 * (x) axis and the plot width, and provides the shared x-scale to its
 * {@link ChartRow}s via context so multiple rows line up on one time axis. The
 * y-axis is per-row.
 */
export function ChartContainer({
  timeRange,
  width,
  theme,
  children,
}: ChartContainerProps) {
  const t0 = timeRange[0];
  const t1 = timeRange[1];
  const frame = useMemo<ContainerFrame>(
    () => ({
      width,
      timeRange: [t0, t1],
      theme: theme ?? defaultTheme,
    }),
    [t0, t1, width, theme],
  );
  return (
    <ContainerContext.Provider value={frame}>
      <div style={{ width: `${width}px` }}>{children}</div>
    </ContainerContext.Provider>
  );
}
