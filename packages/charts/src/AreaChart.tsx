import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import { fromTimeSeries, fromValueSeries } from './data.js';
import { areaExtent, drawArea } from './area.js';
import type { DecimateOption } from './decimate.js';
import { resolveCurve, type Curve } from './curve.js';
import {
  DEFAULT_GAP_MODE,
  DEFAULT_GAP_CONNECTOR_OPACITY,
  type GapMode,
} from './gaps.js';
import { ContainerContext, LayersContext, type LayerEntry } from './context.js';
import {
  legendLabelFor,
  useLegendItems,
  type LegendItemInput,
} from './swatch.js';
import { useSlotKey } from './use-slot-key.js';

export interface AreaChartProps<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> {
  /**
   * The source series. A `TimeSeries` fills against the time axis; a
   * `ValueSeries` (`series.byValue('dist')`) against its value axis — the
   * container infers which from the data, no axis-type prop (mirrors
   * `<LineChart>`). Either way `column` names the numeric value to fill from.
   *
   * **Live charts:** `series.byValue(…)` mints a *fresh* projection each call, so
   * an inline `series={s.byValue('dist')}` re-registers this layer every render —
   * on a frequently re-rendering chart, memoize the projection (`useMemo`).
   */
  series: TimeSeries<S> | ValueSeries<VS>;
  /** Name of the numeric value column to fill from. */
  column: string;
  /**
   * The series' semantic identifier — what the data _is_ / how it should read
   * (e.g. `elevation`, or a signed-traffic role like `in` / `out`). The theme
   * maps it to an {@link AreaStyle} (`theme.area[as] ?? theme.area.default`) —
   * outline colour/width + the graded fill. **Omitted ⇒ the `default` style**;
   * there's no per-component colour/style override (restyle via the theme, the
   * single styling channel).
   */
  as?: string;
  /**
   * Which `<YAxis>` (by its `id`) this area scales against — picks the *scale*,
   * where `as` picks the *style*. **Omitted ⇒ the row's default axis.**
   */
  axis?: string;
  /**
   * The value the fill rests on — the flat edge opposite the value line. Two
   * forms:
   *
   * - **Omitted ⇒ the axis's lower bound** (the bottom of the plot): the
   *   elevation form — fill from the line down to the floor, shade grading down.
   * - **A number (e.g. `0`) ⇒ a fixed baseline**: the above/below-axis form —
   *   values above it fill up, below it fill down, each side's shade fading
   *   toward the baseline. For the esnet two-colour traffic look, compose two
   *   `<AreaChart>`s (an "in" column and an "out" column, distinct `as` roles).
   *
   * A fixed baseline is pulled into the auto-fit domain so the baseline line is
   * always visible (an above/below area with `baseline={0}` shows the zero
   * axis).
   */
  baseline?: number;
  /**
   * Render-time path interpolation for the outline + fill edge — a view concern
   * (denoise the data with pond's `smooth()` upstream). **Omitted ⇒ `'linear'`**
   * (straight segments). `'monotone'` is a smooth edge that still passes through
   * points.
   */
  curve?: Curve;
  /**
   * How a **gap** (a coast / dropout — a run of NaN in `column`) is rendered (a
   * {@link GapMode}). **Omitted ⇒ `'empty'`**: the fill *and* outline break at
   * the gap, leaving a hole (the honest default). `'none'` fills + bridges
   * straight across. For `'dashed'` / `'step'` / `'fade'` the **fill stays
   * broken** and only the **outline** gets the inferred connector across the gap
   * — a faint dashed straight bridge, a faint flat dashed line at the average of
   * the edge values, or estela's fade-to-baseline (which drops to this area's own
   * `baseline`, the fill floor). Shared with `<LineChart>` — one concept. (The
   * `'dashed'` / `'step'` connector faintness is the theme's `gap.connectorOpacity`.)
   */
  gaps?: GapMode;
  /**
   * **M4 viewport decimation** (charts decimator wave). **Omitted ⇒ `true`**:
   * once the visible data is denser than ~2 samples per device pixel, the fill +
   * outline are drawn from the per-pixel-column M4 buckets (a visually-lossless
   * polyline of O(plot width) points) instead of every sample. Applies with a
   * linear `curve`; pass `false` to always draw every point, or `{ threshold }`
   * to tune the samples-per-pixel factor. Shares {@link LineChart}'s
   * `DecimateOption`.
   */
  decimate?: DecimateOption;
  /**
   * This layer's `<Legend>` row: `false` ⇒ no row (opt out), a string ⇒ the
   * row's display name. **Omitted ⇒ a row named by the layer's readout
   * identity** (`as` ?? `column`). The swatch is the resolved area style.
   */
  legend?: boolean | string;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/** Read a d3 linear scale's domain lower bound (the axis floor) from the plain
 *  `(value) => pixel` function the row hands to `draw`. The runtime object is a
 *  d3 `ScaleLinear` (it carries `.domain()`); the {@link RowLayer} type narrows
 *  it to the call signature, so this reads the bound through a localized,
 *  documented shape rather than widening `drawArea`'s contract to d3-scale. */
function domainFloor(yScale: (value: number) => number): number {
  const d = (yScale as unknown as { domain?: () => number[] }).domain?.();
  return d && d.length > 0 ? d[0]! : 0;
}

/**
 * An area draw layer: fills between a value `column` and a `baseline`, with a
 * graded (gradient) shade — opaque at the line, transparent at the baseline —
 * and an outline stroke on top. Reads `column` into a {@link ChartSeries}
 * (columnar, gaps as NaN), registers into the enclosing {@link Layers} (scaling
 * against its `axis`), and renders nothing to the DOM — the row draws it. The
 * fill + outline break at gaps rather than spanning them.
 *
 * Two forms via `baseline` (see {@link AreaChartProps.baseline}): omit it for
 * the **elevation** form (rest on the axis floor) or pass `0` for the
 * **above/below-axis** form (positive up, negative down). The esnet two-colour
 * traffic look composes two layers, each with its own `as` role:
 *
 * ```tsx
 * <Layers>
 *   <AreaChart series={s} column="in"  baseline={0} as="in" />
 *   <AreaChart series={s} column="out" baseline={0} as="out" />
 * </Layers>
 * ```
 */
export function AreaChart<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>({
  series,
  column,
  as: semantic,
  axis,
  baseline,
  curve,
  gaps = DEFAULT_GAP_MODE,
  decimate = true,
  legend,
  index = 0,
}: AreaChartProps<S, VS>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<AreaChart> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<AreaChart> must be rendered inside a <Layers>');
  }

  const cs = useMemo(
    () =>
      series instanceof ValueSeries
        ? fromValueSeries(series, column)
        : fromTimeSeries(series, column),
    [series, column],
  );
  // Styling: semantic identifier → theme area style. The single styling channel.
  const { area } = container.theme;
  const style =
    (semantic !== undefined ? area[semantic] : undefined) ?? area.default;
  // Series identity for the readout (the `as` role, else the column name).
  const label = semantic ?? column;
  const curveFactory = resolveCurve(curve);
  // Faintness of the inferred dashed connectors (dashed / step) — theme-level,
  // falling back to the shared default so a theme without it still renders faint.
  const gapConnectorOpacity =
    container.theme.gap?.connectorOpacity ?? DEFAULT_GAP_CONNECTOR_OPACITY;
  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => areaExtent(cs, baseline),
        // The container infers the shared x scale's kind from its layers — a
        // ValueSeries plots on a value axis, a TimeSeries on time.
        xKind: series instanceof ValueSeries ? 'value' : 'time',
        xExtent: () =>
          cs.length === 0 ? null : [cs.x[0]!, cs.x[cs.length - 1]!],
        sampleAt: (x) => {
          // No readout past the data (tracker policy — nearest clamps to an
          // endpoint outside the span); bounds from the columnar x axis.
          if (cs.length === 0 || x < cs.x[0]! || x > cs.x[cs.length - 1]!) {
            return [];
          }
          if (series instanceof ValueSeries) {
            // Value axis: bisect the axis for the nearest row, read y from `cs`.
            const i = series.nearestIndex(x);
            if (i < 0) return [];
            const v = cs.y[i]!;
            return Number.isFinite(v)
              ? [{ x: cs.x[i]!, value: v, color: style.color, label }]
              : [];
          }
          const e = series.nearest(x);
          if (e === undefined) return [];
          // get() wants a literal key; column is a runtime string. Cast the
          // *event* (not the method — that would detach `this`) to a
          // string-keyed get; runtime-safe read + guard.
          const v = (e as unknown as { get(field: string): unknown }).get(
            column,
          );
          // The readout dot rides the value line (not the baseline), coloured by
          // the outline stroke. A gap yields no readout (like the fill).
          return typeof v === 'number' && Number.isFinite(v)
            ? [{ x: e.begin(), value: v, color: style.color, label }]
            : [];
        },
        draw: (ctx, xScale, yScale) =>
          drawArea(
            ctx,
            cs,
            xScale,
            yScale,
            style,
            // Omitted baseline rests on the axis floor (resolved late from the
            // scale, so it tracks the auto-fit domain); a fixed baseline is used
            // verbatim.
            baseline ?? domainFloor(yScale),
            curveFactory,
            gaps,
            gapConnectorOpacity,
            decimate,
          ),
      },
      axisId: axis,
      index,
    }),
    [
      cs,
      series,
      column,
      style,
      label,
      baseline,
      curveFactory,
      gaps,
      gapConnectorOpacity,
      decimate,
      axis,
      index,
    ],
  );
  // A stable per-instance slot (see useSlotKey) keeps this layer's z-position
  // fixed across series/style/prop updates (no jump to the front on live update).
  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  // Also a tracker source: the container fans in this series' value at the
  // cursor for the (outside-the-chart) readout.
  const { registerTrackerSource, unregisterTrackerSource } = container;
  useEffect(
    () => () => unregisterTrackerSource(slot),
    [unregisterTrackerSource, slot],
  );
  useEffect(() => {
    registerTrackerSource(slot, entry.layer);
  }, [registerTrackerSource, slot, entry.layer]);

  // And a legend row: the readout identity + the resolved area style (top line
  // over the translucent fill), so a `<Legend>` swatch can never drift.
  const legendRows = useMemo<readonly LegendItemInput[] | null>(() => {
    const name = legendLabelFor(legend, label);
    return name === null
      ? null
      : [
          {
            label: name,
            swatch: {
              kind: 'area',
              line: style.color,
              fill: style.fill,
              fillOpacity: style.fillOpacity,
            },
          },
        ];
  }, [legend, label, style]);
  useLegendItems(container, slot, index, legendRows);

  return null;
}
