import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { fromTimeSeries } from './data.js';
import { drawLine, yExtent } from './line.js';
import { ContainerContext, RowContext, type RowLayer } from './context.js';

export interface LineChartProps<S extends SeriesSchema> {
  /** The source series. Its key column supplies the time axis. */
  series: TimeSeries<S>;
  /** Name of the numeric value column to plot. */
  column: string;
  /**
   * Which theme line-role this series draws as: `primary` (default), the
   * `secondary` colour (e.g. a right-axis HR line), or the `context` underlay
   * (e.g. elevation). Colour **and** width come from `theme.line` — there is
   * intentionally no per-component colour/width override. That escape hatch is
   * the second styling channel that bred react-timeseries-charts' styling bugs;
   * to restyle, change the theme (or add a role), not the component.
   */
  role?: 'primary' | 'secondary' | 'context';
}

/**
 * A line draw layer. Reads `column` from `series` into a {@link ChartSeries}
 * (columnar, gaps as NaN), registers itself into the enclosing
 * {@link ChartRow}, and renders nothing to the DOM — the row draws it. The line
 * breaks at gaps rather than spanning them.
 */
export function LineChart<S extends SeriesSchema>({
  series,
  column,
  role = 'primary',
}: LineChartProps<S>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<LineChart> must be rendered inside a <ChartContainer>');
  }
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error('<LineChart> must be rendered inside a <ChartRow>');
  }

  const cs = useMemo(() => fromTimeSeries(series, column), [series, column]);
  // Colour + width come from the theme by role — the single styling channel.
  const { line } = container.theme;
  const layer = useMemo<RowLayer>(
    () => ({
      yExtent: () => yExtent(cs),
      draw: (ctx, xScale, yScale) =>
        drawLine(ctx, cs, xScale, yScale, {
          stroke: line[role],
          strokeWidth: line.width,
        }),
    }),
    [cs, line, role],
  );
  useEffect(() => row.register(layer), [row, layer]);

  return null;
}
