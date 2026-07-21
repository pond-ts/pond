import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { ohlcFromTimeSeries } from './data.js';
import type { DecimateOption } from './decimate.js';
import {
  drawCandles,
  isFiniteOhlc,
  ohlcExtent,
  ohlcIndexAtTime,
  resolveCandleStyle,
  type CandleVariant,
  type ColorBy,
} from './ohlc.js';
import {
  ContainerContext,
  LayersContext,
  type LayerEntry,
  type TrackerSample,
} from './context.js';
import {
  legendLabelFor,
  useLegendItems,
  type LegendItemInput,
} from './swatch.js';
import { useSlotKey } from './use-slot-key.js';

export interface CandlestickProps<S extends SeriesSchema> {
  /**
   * The source series. **Point-keyed** (`time`) raw OHLCV feeds straight in —
   * each candle's slot is derived from neighbour spacing (see
   * {@link ohlcFromTimeSeries}), no `aggregate` pass needed. An **interval /
   * timeRange**-keyed series (an `aggregate` rollup — weekly / monthly bars) uses
   * the key's own `[begin, end)` as the slot. The chart infers the x-kind from
   * the data; there's no axis-type prop.
   */
  series: TimeSeries<S>;
  /** Opening-price column. **Omitted ⇒ `'open'`.** */
  open?: string;
  /** Session-high column. **Omitted ⇒ `'high'`.** */
  high?: string;
  /** Session-low column. **Omitted ⇒ `'low'`.** */
  low?: string;
  /** Closing-price column. **Omitted ⇒ `'close'`.** */
  close?: string;
  /**
   * The series' semantic identifier — what the data _is_ (e.g. a ticker). The
   * theme maps it to a {@link CandleStyle} (`theme.candle[as] ??
   * theme.candle.default`). **Omitted ⇒ the `default` candle style.** It's also
   * the tracker/readout label for the series (the primary `close` pill keys on
   * `as`, not the raw column name).
   */
  as?: string;
  /**
   * Which `<YAxis>` (by its `id`) this candle scales against — the *scale*, where
   * `as` picks the *style*. **Omitted ⇒ the row's default axis.**
   */
  axis?: string;
  /**
   * How each mark renders — `'candle'` (default; filled body + wick), `'bar'`
   * (OHLC tick bar), or `'hollow'` (rising hollow / falling filled). See
   * {@link CandleVariant}.
   */
  variant?: CandleVariant;
  /**
   * What drives the colour — `'direction'` (default; rising / falling / doji off
   * open vs close, the market convention) or `'series'` (one colour off the `as`
   * role, no green/red). See {@link ColorBy}.
   */
  colorBy?: ColorBy;
  /**
   * Total horizontal inset between adjacent candles in px (half each side), so
   * they breathe — see `barSpanPx`. **Omitted ⇒ `0`** (the body already insets to
   * `style.bodyWidth` of the slot). A candle narrower than 1px after the inset
   * collapses to a 1px mark, so a thin slot stays visible.
   */
  gap?: number;
  /**
   * Fan the **full O/H/L/C** to the tracker readout (four value pills) instead of
   * the default single `close` pill. **Omitted ⇒ `false`** — close is "the price"
   * for a compact legend; the full quote is opt-in for a dense hover readout.
   */
  showOHLC?: boolean;
  /**
   * **M4 viewport decimation** (charts decimator wave). **Omitted ⇒ `true`**:
   * once the visible candles are denser than ~2 per device pixel, they are drawn
   * as per-pixel-column **aggregate candles** (`open=first`, `high=max`,
   * `low=min`, `close=last`) — i.e. re-bucketed to the pixel-column timeframe, the
   * way a trading chart shows fewer, wider candles as you zoom out. It is a
   * faithful OHLC of each column's span (never a distortion), just at a coarser
   * timeframe. Pass `false` to draw every candle at its own slot (and
   * pre-aggregate upstream if you need a fixed timeframe). Shares
   * {@link LineChart}'s `DecimateOption`.
   */
  decimate?: DecimateOption;
  /**
   * This layer's `<Legend>` row: `false` ⇒ no row (opt out), a string ⇒ the
   * row's display name. **Omitted ⇒ a row named by the layer's readout
   * identity** (`as` ?? the `close` column). The swatch is the resolved
   * up/down candle pair.
   */
  legend?: boolean | string;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/**
 * A first-class OHLC **candlestick** draw layer — the financial sibling of
 * {@link BoxPlot}. Reads four price columns (`open`/`high`/`low`/`close`) of
 * `series` into an {@link OhlcSeries} and draws one candle per key: the
 * `open→close` body (direction-coloured) and the `high–low` wick, over the key's
 * slot x-span. Derives the body extents itself (`min`/`max` of open/close) — the
 * consumer never runs a `withColumn` precompute. Registers into the enclosing
 * {@link Layers}; renders nothing to the DOM — the row draws it. Gap-aware (a key
 * missing any price draws nothing).
 *
 * **Draws only** — windowing stays upstream: raw daily OHLCV is a point-keyed
 * `TimeSeries` fed straight in, and a weekly / monthly bar is the identical call
 * on an `aggregate(Sequence.calendar('week'), …)` rollup (interval-keyed). This
 * supersedes `BoxPlot shape='solid'` for OHLC (which needed a quantile remap, a
 * body precompute, two overlaid layers for green/red, and a column-name tracker).
 *
 * **Cursor.** Unlike `BoxPlot`, a candle **participates in the crosshair x-snap**
 * (it exposes plain `sampleAt`, not a consolidated `cursorFlag`), so the reticle
 * lands on candles. The readout keys on `as` and shows `close` by default; pass
 * `showOHLC` for the full four-pill quote.
 *
 * ```tsx
 * <Layers>
 *   <Candlestick series={daily} as="AAPL" />
 * </Layers>
 * ```
 */
export function Candlestick<S extends SeriesSchema>({
  series,
  open = 'open',
  high = 'high',
  low = 'low',
  close = 'close',
  as: semantic,
  axis,
  variant = 'candle',
  colorBy = 'direction',
  gap = 0,
  showOHLC = false,
  decimate = true,
  legend,
  index = 0,
}: CandlestickProps<S>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<Candlestick> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<Candlestick> must be rendered inside a <Layers>');
  }

  const ohlc = useMemo(
    () => ohlcFromTimeSeries(series, { open, high, low, close }),
    [series, open, high, low, close],
  );
  // Styling: semantic identifier → theme candle style. The single styling channel.
  const { candle } = container.theme;
  const style =
    (semantic !== undefined ? candle[semantic] : undefined) ?? candle.default;
  // Series identity for the readout (the `as` role, else the close column name) —
  // the primary `close` pill keys on this, like every other layer.
  const label = semantic ?? close;

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => ohlcExtent(ohlc),
        xKind: 'time',
        xExtent: () =>
          ohlc.length === 0 ? null : [ohlc.x[0]!, ohlc.xEnd[ohlc.length - 1]!],
        sampleAt: (time) => {
          // The readout reads the candle **under the cursor** (containment span,
          // not nearest-by-begin), anchored at the slot centre. Outside every
          // candle → no readout. No `cursorFlag`: the samples flow through the
          // normal per-series tracker path, which is also what keeps the candle
          // in the crosshair x-snap (BoxPlot's cursorFlag opts out of both).
          if (ohlc.length === 0) return [];
          const i = ohlcIndexAtTime(ohlc, time);
          if (i < 0 || !isFiniteOhlc(ohlc, i)) return [];
          const at = (ohlc.x[i]! + ohlc.xEnd[i]!) / 2;
          const { body, wick } = resolveCandleStyle(
            style,
            ohlc.open[i]!,
            ohlc.close[i]!,
            colorBy,
          );
          if (!showOHLC) {
            // Default: `close` is "the price", keyed on the series id.
            return [{ x: at, value: ohlc.close[i]!, color: body, label }];
          }
          // Opt-in full quote: four value pills (body colour for open/close, wick
          // colour for the high/low extremes). Each is a value-only axis pill.
          // With a semantic `as`, each reads under the series name + role
          // (`SPY high`) — BoxPlot's qLabel convention, so two quoted series
          // don't merge readout keys on the bare role words (F-charts-8 §3).
          const role = (r: string): string =>
            semantic !== undefined ? `${semantic} ${r}` : r;
          const samples: TrackerSample[] = [
            { x: at, value: ohlc.high[i]!, color: wick, label: role('high') },
            { x: at, value: ohlc.open[i]!, color: body, label: role('open') },
            { x: at, value: ohlc.close[i]!, color: body, label: role('close') },
            { x: at, value: ohlc.low[i]!, color: wick, label: role('low') },
          ];
          return samples;
        },
        draw: (ctx, xScale, yScale) =>
          drawCandles(
            ctx,
            ohlc,
            xScale,
            yScale,
            style,
            variant,
            colorBy,
            gap,
            undefined,
            decimate,
          ),
      },
      axisId: axis,
      index,
    }),
    [
      ohlc,
      style,
      label,
      semantic,
      variant,
      colorBy,
      gap,
      showOHLC,
      decimate,
      axis,
      index,
    ],
  );
  // Stable per-instance slot (see useSlotKey): keeps this candle layer's
  // z-position + identity across prop updates; the injected index drives the sort.
  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  // Also a tracker source: the container fans in this series' OHLC at the cursor
  // for the (outside-the-chart) readout.
  const { registerTrackerSource, unregisterTrackerSource } = container;
  useEffect(
    () => () => unregisterTrackerSource(slot),
    [unregisterTrackerSource, slot],
  );
  useEffect(() => {
    registerTrackerSource(slot, entry.layer);
  }, [registerTrackerSource, slot, entry.layer]);

  // And a legend row: the series identity + the resolved up/down pair, so a
  // `<Legend>` swatch can never drift from the drawn candles.
  const legendRows = useMemo<readonly LegendItemInput[] | null>(() => {
    const name = legendLabelFor(legend, label);
    return name === null
      ? null
      : [
          {
            label: name,
            swatch: {
              kind: 'candle',
              up: style.rising.body,
              down: style.falling.body,
            },
          },
        ];
  }, [legend, label, style]);
  useLegendItems(container, slot, index, legendRows);

  return null;
}
