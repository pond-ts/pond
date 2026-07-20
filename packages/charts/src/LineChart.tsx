import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import { fromTimeSeries, fromValueSeries } from './data.js';
import { drawLine, yExtent } from './line.js';
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
  type LegendRowInput,
} from './swatch.js';
import { useSlotKey } from './use-slot-key.js';

export interface LineChartProps<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> {
  /**
   * The source series. A `TimeSeries` plots against the time axis; a
   * `ValueSeries` (`series.byValue('cumDist')`) against its value axis — the
   * container infers which from the data, no axis-type prop. Either way the key
   * / axis column supplies x and `column` supplies y.
   *
   * **Live charts:** `series.byValue(…)` mints a *fresh* projection each call, so
   * passing `series={s.byValue('dist')}` inline re-registers this layer every
   * render — on a frequently re-rendering (e.g. scrub-driven) chart, memoize the
   * projection (`useMemo`) so the layer isn't rebuilt each frame.
   */
  series: TimeSeries<S> | ValueSeries<VS>;
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
   * How a **gap** (a coast / dropout — a run of NaN in `column`) is rendered (a
   * {@link GapMode}). **Omitted ⇒ `'empty'`**: the line breaks at the gap and
   * leaves a hole (the honest default). `'none'` bridges straight across;
   * `'dashed'` adds a faint dashed bridge over the break; `'step'` adds a faint
   * flat dashed line at the average of the two edge values; `'fade'` is estela's
   * fade-to-baseline at each gap edge. Shared with `<AreaChart>` — one concept.
   * (The `'dashed'` / `'step'` connector faintness is the theme's
   * `gap.connectorOpacity`.)
   */
  gaps?: GapMode;
  /**
   * Break the line at each **trading-axis discontinuity** (a session / day /
   * lunch close→open) when the container renders on a trading-time axis (a
   * `discontinuities` / `calendar` provider). **Omitted ⇒ `false`**: the line
   * connects the last pre-close point straight to the next open across the
   * collapsed gap (the near-vertical connector). `true` ends the line at the
   * close and re-starts it at the open — the intraday look, where a session's
   * price shouldn't visually flow into the next.
   *
   * This is a **scale** break (driven by the axis's collapsed gaps), orthogonal
   * to {@link gaps} (a **data** break, a NaN run) — set both independently. A
   * no-op on a continuous axis (no provider) or a provider without `boundaries`.
   */
  sessionBreaks?: boolean;
  /**
   * **M4 viewport decimation** (charts decimator wave). **Omitted ⇒ `true`**:
   * once the visible data is denser than ~2 samples per device pixel, the line
   * is drawn from the per-pixel-column min/max/first/last (a pixel-identical
   * polyline of O(plot width) points) instead of every sample — so a 1M-point
   * series pans at interactive rates. It is **visually lossless** (a perf knob,
   * not a style), and applies only to the honest default draw: a solid line with
   * `gaps="empty"`, a linear `curve`, and no `sessionBreaks` (other modes draw
   * full-resolution until later phases wire them). Pass `false` to always draw
   * every point, or `{ threshold }` to tune the samples-per-pixel factor.
   */
  decimate?: DecimateOption;
  /**
   * This layer's `<Legend>` row: `false` ⇒ no row (opt out), a string ⇒ the
   * row's display name. **Omitted ⇒ a row named by the layer's readout
   * identity** (`as` ?? `column`). The swatch is the resolved line style.
   */
  legend?: boolean | string;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/** Stable empty boundary list — so `sessionBreaks={false}` keeps a referentially
 *  constant array and the layer entry isn't rebuilt every render. */
const NO_BREAKS: readonly number[] = [];

/**
 * A line draw layer. Reads `column` from `series` into a {@link ChartSeries}
 * (columnar, gaps as NaN), registers itself into the enclosing {@link Layers}
 * (scaling against its `axis`), and renders nothing to the DOM — the row draws
 * it. The line breaks at gaps rather than spanning them.
 */
export function LineChart<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>({
  series,
  column,
  as: semantic,
  axis,
  curve,
  gaps = DEFAULT_GAP_MODE,
  sessionBreaks = false,
  decimate = true,
  legend,
  index = 0,
}: LineChartProps<S, VS>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<LineChart> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<LineChart> must be rendered inside a <Layers>');
  }

  const cs = useMemo(
    () =>
      series instanceof ValueSeries
        ? fromValueSeries(series, column)
        : fromTimeSeries(series, column),
    [series, column],
  );
  // Styling: semantic identifier → theme style. The single styling channel.
  const { line } = container.theme;
  const style =
    (semantic !== undefined ? line[semantic] : undefined) ?? line.default;
  // Series identity for the readout (the `as` role, else the column name).
  const label = semantic ?? column;
  const curveFactory = resolveCurve(curve);
  // Faintness of the inferred dashed connectors (dashed / step) — theme-level,
  // falling back to the shared default so a theme without it still renders faint.
  const gapConnectorOpacity =
    container.theme.gap?.connectorOpacity ?? DEFAULT_GAP_CONNECTOR_OPACITY;
  // Trading-axis session breaks: the collapse instants inside this series' span
  // (session/day/lunch opens the axis skips). Data instants, not pixels — so the
  // set is view-independent (pan/zoom reuse it). Only computed when opted in and
  // the container carries a boundary-reporting discontinuity provider.
  const sessionBreakInstants = useMemo<readonly number[]>(() => {
    const provider = container.discontinuities;
    if (!sessionBreaks || provider?.boundaries === undefined || cs.length < 2) {
      return NO_BREAKS;
    }
    return provider.boundaries(cs.x[0]!, cs.x[cs.length - 1]!);
  }, [sessionBreaks, container.discontinuities, cs]);
  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => yExtent(cs),
        // The container infers the shared x scale's kind + auto-fit domain from
        // its layers: a ValueSeries plots on a value axis, a TimeSeries on time.
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
          return typeof v === 'number' && Number.isFinite(v)
            ? [{ x: e.begin(), value: v, color: style.color, label }]
            : [];
        },
        draw: (ctx, xScale, yScale) =>
          drawLine(
            ctx,
            cs,
            xScale,
            yScale,
            style,
            curveFactory,
            gaps,
            gapConnectorOpacity,
            sessionBreakInstants,
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
      curveFactory,
      gaps,
      gapConnectorOpacity,
      sessionBreakInstants,
      decimate,
      axis,
      index,
    ],
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

  // And a legend row: the readout identity + the resolved line style, so a
  // `<Legend>` swatch can never drift from what the canvas draws.
  const legendRows = useMemo<readonly LegendRowInput[] | null>(() => {
    const name = legendLabelFor(legend, label);
    return name === null
      ? null
      : [
          {
            label: name,
            swatch: {
              kind: 'line',
              color: style.color,
              width: style.width,
              dash: style.dash,
            },
          },
        ];
  }, [legend, label, style]);
  useLegendItems(container, slot, index, legendRows);

  return null;
}
