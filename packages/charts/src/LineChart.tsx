import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { fromTimeSeries } from './data.js';
import { drawLine, yExtent } from './line.js';
import { resolveCurve, type Curve } from './curve.js';
import { ContainerContext, LayersContext, type LayerEntry } from './context.js';
import { useSlotKey } from './use-slot-key.js';

export interface LineChartProps<S extends SeriesSchema> {
  /** The source series. Its key column supplies the time axis. */
  series: TimeSeries<S>;
  /** Name of the numeric value column to plot. */
  column: string;
  /**
   * The series' semantic identifier — what the data _is_ / how it should read
   * (e.g. `heartrate`, `power`, or a role name like `foam`). The theme maps it
   * to a {@link LineStyle} (`theme.line[as] ?? theme.line.default`). **Omitted ⇒
   * the `default` style** — `column` is the data, `as` is the identity, and
   * there's no per-component colour/width override (that second styling channel
   * is what bred react-timeseries-charts' styling bugs; restyle via the theme).
   */
  as?: string;
  /**
   * Which `<YAxis>` (by its `id`) this line scales against — picks the *scale*,
   * where `as` picks the *style* (separate concerns). **Omitted ⇒ the row's
   * default axis** (the first declared, or the implicit auto-domain axis).
   */
  axis?: string;
  /**
   * Render-time path interpolation between points — a view concern (denoise the
   * data with pond's `smooth()` upstream). **Omitted ⇒ `'linear'`** (straight
   * segments). `'monotone'` is a smooth line that still passes through points.
   */
  curve?: Curve;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/**
 * A line draw layer. Reads `column` from `series` into a {@link ChartSeries}
 * (columnar, gaps as NaN), registers itself into the enclosing {@link Layers}
 * (scaling against its `axis`), and renders nothing to the DOM — the row draws
 * it. The line breaks at gaps rather than spanning them.
 */
export function LineChart<S extends SeriesSchema>({
  series,
  column,
  as: semantic,
  axis,
  curve,
  index = 0,
}: LineChartProps<S>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<LineChart> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<LineChart> must be rendered inside a <Layers>');
  }

  const cs = useMemo(() => fromTimeSeries(series, column), [series, column]);
  // Styling: semantic identifier → theme style. The single styling channel.
  const { line } = container.theme;
  const style =
    (semantic !== undefined ? line[semantic] : undefined) ?? line.default;
  // Series identity for the readout (the `as` role, else the column name).
  const label = semantic ?? column;
  const curveFactory = resolveCurve(curve);
  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => yExtent(cs),
        sampleAt: (time) => {
          // No readout past the data (tracker policy — core's nearest() clamps
          // to an endpoint outside the span); bounds from the columnar time axis.
          if (
            cs.length === 0 ||
            time < cs.x[0]! ||
            time > cs.x[cs.length - 1]!
          ) {
            return [];
          }
          const e = series.nearest(time);
          if (e === undefined) return [];
          // get() wants a literal key; column is a runtime string (same reason
          // data.ts reads via column().read). Runtime-safe string read + guard.
          const read = e.get as unknown as (field: string) => unknown;
          const v = read(column);
          return typeof v === 'number' && Number.isFinite(v)
            ? [{ x: e.begin(), value: v, color: style.color, label }]
            : [];
        },
        draw: (ctx, xScale, yScale) =>
          drawLine(ctx, cs, xScale, yScale, style, curveFactory),
      },
      axisId: axis,
      index,
    }),
    [cs, series, column, style, label, curveFactory, axis, index],
  );
  // A stable per-instance slot (see useSlotKey) keeps this layer's z-position
  // fixed: a series or style change updates the slot in place rather than
  // re-appending (which would jump the layer to the front of the z-stack on
  // every live update).
  const slot = useSlotKey();
  // Unregister on unmount only (stable deps); register + update in place.
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  // Also register as a tracker source so the container can fan in this series'
  // value at the cursor for the (outside-the-chart) readout.
  const { registerTrackerSource, unregisterTrackerSource } = container;
  useEffect(
    () => () => unregisterTrackerSource(slot),
    [unregisterTrackerSource, slot],
  );
  useEffect(() => {
    registerTrackerSource(slot, entry.layer);
  }, [registerTrackerSource, slot, entry.layer]);

  return null;
}
