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
  /** Line colour; defaults to the theme's `line.primary`. */
  stroke?: string;
  /** Line width in CSS pixels (default 1.5). */
  strokeWidth?: number;
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
  stroke,
  strokeWidth = 1.5,
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
  // Default to the theme's primary line colour; an explicit `stroke` overrides.
  const resolvedStroke = stroke ?? container.theme.line.primary;
  const layer = useMemo<RowLayer>(
    () => ({
      yExtent: () => yExtent(cs),
      draw: (ctx, xScale, yScale) =>
        drawLine(ctx, cs, xScale, yScale, {
          stroke: resolvedStroke,
          strokeWidth,
        }),
    }),
    [cs, resolvedStroke, strokeWidth],
  );
  useEffect(() => row.register(layer), [row, layer]);

  return null;
}
