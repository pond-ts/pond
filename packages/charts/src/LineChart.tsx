import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { fromTimeSeries } from './data.js';
import { drawLine, yExtent } from './line.js';
import { RowContext, type RowLayer } from './context.js';

export interface LineChartProps<S extends SeriesSchema> {
  /** The source series. Its key column supplies the time axis. */
  series: TimeSeries<S>;
  /** Name of the numeric value column to plot. */
  column: string;
  /** Line colour (default a blue). */
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
  stroke = '#2563eb',
  strokeWidth = 1.5,
}: LineChartProps<S>) {
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error('<LineChart> must be rendered inside a <ChartRow>');
  }

  const cs = useMemo(() => fromTimeSeries(series, column), [series, column]);
  const layer = useMemo<RowLayer>(
    () => ({
      yExtent: () => yExtent(cs),
      draw: (ctx, xScale, yScale) =>
        drawLine(ctx, cs, xScale, yScale, { stroke, strokeWidth }),
    }),
    [cs, stroke, strokeWidth],
  );
  useEffect(() => row.register(layer), [row, layer]);

  return null;
}
