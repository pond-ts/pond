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
   * Semantic identifier for this series — what the data _is_ (e.g. `heartrate`,
   * `power`, or a generic `primary`). The theme maps it to a {@link LineStyle}
   * (`theme.line[semantic] ?? theme.line.default`); defaults to the `column`
   * name. There is intentionally no per-component colour/width override — that
   * second styling channel is what bred react-timeseries-charts' styling bugs;
   * restyle by editing the theme (or adding an identifier to it).
   */
  semantic?: string;
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
  semantic,
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
  // column → semantic identifier (defaults to the column name) → theme style.
  // The single styling channel; no per-component override.
  const { line } = container.theme;
  const style = line[semantic ?? column] ?? line.default;
  const layer = useMemo<RowLayer>(
    () => ({
      yExtent: () => yExtent(cs),
      draw: (ctx, xScale, yScale) => drawLine(ctx, cs, xScale, yScale, style),
    }),
    [cs, style],
  );
  useEffect(() => row.register(layer), [row, layer]);

  return null;
}
