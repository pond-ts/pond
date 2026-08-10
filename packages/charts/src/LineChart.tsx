import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import {
  assertNumericColumn,
  fromTimeSeries,
  fromValueSeries,
} from './data.js';
import type { NumericColumn, ValueNumericColumn } from './column-names.js';
import {
  drawLine,
  drawPartitioned,
  traceHitIndex,
  traceStateStyle,
  yExtent,
  type TraceState,
} from './line.js';
import { sweepSpan } from './sweep.js';
import type { LineStyle } from './theme.js';
import type { DecimateOption } from './decimate.js';
import { resolveCurve, type Curve } from './curve.js';
import {
  DEFAULT_GAP_MODE,
  DEFAULT_GAP_CONNECTOR_OPACITY,
  type GapMode,
} from './gaps.js';
import {
  ContainerContext,
  LayersContext,
  type LayerEntry,
  type SelectInfo,
  type SweepSession,
} from './context.js';
import {
  legendLabelFor,
  useLegendItems,
  type LegendItemInput,
} from './swatch.js';
import { useSlotKey } from './use-slot-key.js';

export interface LineChartCommon<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> {
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
   * **Opt in to selection** — the layer identity a `<Selector>` /
   * `<MultiSelector>` reports and a `selected` entry names. **Omitted ⇒ the
   * trace is inert**, exactly as every other layer's `id` gates it.
   *
   * A trace's selection is not shaped like a bar's, because **a trace has no
   * marks** ([PND-TRACESEL]):
   *
   * - a **click** commits a **series-scoped** {@link SelectInfo} — `key` and
   *   `value` are `NaN`, because no sample was selected, and a stable `mark`
   *   carries the identity so the documented deselect-toggle works;
   * - a **sweep** commits a {@link SpanSelection} with **no marks**. The span
   *   _is_ the selection. A trace's samples are usually undrawn and there are
   *   several per pixel, so "the samples you swept" is a set you never
   *   expressed — take the span and slice your own series with it.
   */
  id?: string;
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

/**
 * LineChart's source + column props, a **union over the series kind** so the
 * column names are checked against the schema that was actually passed
 * ([PND-CHARTAPI]). A single member carrying `NumericColumn<S> |
 * ValueNumericColumn<VS>` would silently widen to `string`: only one of the
 * two generics is ever inferred, and the other falls back (measured in
 * `spikes/charts-type-seam/`). Loosely-typed series still accept any name.
 */
type LineChartSource<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> =
  | {
      /**
       * The source series. **Live charts:** `series.byValue(…)` mints a
       * *fresh* projection each call, so an inline `series={s.byValue('d')}`
       * re-registers this layer every render — on a frequently re-rendering
       * (e.g. scrub-driven) chart, memoize the projection (`useMemo`) so the
       * layer isn't rebuilt each frame.
       */
      series: TimeSeries<S>;
      column: NumericColumn<S>;
      readout?: NumericColumn<S>;
    }
  | {
      series: ValueSeries<VS>;
      column: ValueNumericColumn<VS>;
      readout?: ValueNumericColumn<VS>;
    };

/** `<LineChart>`'s props: the shared knobs plus one series-kind source shape. */
export type LineChartProps<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> = LineChartCommon<S, VS> & LineChartSource<S, VS>;

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
  readout,
  as: semantic,
  axis,
  id,
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
  // Readout column values for a value-axis series (the time path reads it off
  // the event in `sampleAt`). Built once per (series, readout) so the tracker
  // can report a source value the line doesn't plot — see LineChartProps.readout.
  //
  // The time path buffers nothing (it has an event, not an index), so it
  // validates the name here instead: otherwise a mistyped `readout` throws on a
  // value axis but silently yields no readout on a time axis, and the same typo
  // fails two different ways. Both now throw the reader's errors.
  const readoutY = useMemo(() => {
    if (readout === undefined) return undefined;
    if (series instanceof ValueSeries)
      return fromValueSeries(series, readout).y;
    assertNumericColumn(series, readout);
    return undefined;
  }, [series, readout]);
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
  // ── The trace's interaction state ([PND-TRACESEL]).
  //
  // Read here so a selection change re-registers the layer and the canvas
  // repaints — the same plumbing `<BarChart>` uses. Reference-stable when
  // nothing names this layer, so an unrelated selection elsewhere in the
  // container neither re-identifies this entry nor repaints it.
  const selectedEntries = container.selected;
  const hoveredEntries = container.hovered;
  // The committed spans, plus the **live** ones of a sweep in flight. A
  // previewed span draws exactly as a committed one, so releasing changes
  // nothing visually — the preview cannot promise a picture the commit does not
  // deliver. The live channel wins while it is non-empty, because during a drag
  // it IS the current answer.
  const allSpans =
    container.previewSpans.length > 0
      ? container.previewSpans
      : container.selectedSpans;
  const traceState = useMemo<TraceState>(() => {
    if (id === undefined) return 'rest';
    // A span on THIS layer is handled by the partitioned draw below, not by a
    // whole-series state: the emphasis is a region, not the series.
    if (allSpans.some((sp) => sp.id === id)) return 'rest';
    const mine = (e: { readonly id: string }) => e.id === id;
    if (selectedEntries.some(mine)) return 'selected';
    if (hoveredEntries.some(mine)) return 'hover';
    // Something else is selected ⇒ recede. Nothing dims while the selection is
    // empty: with nothing selected there is nothing to recede *from*, the same
    // rule `BarStyle.dimmed` states for the marks.
    if (selectedEntries.length > 0 || allSpans.length > 0) return 'dimmed';
    return 'rest';
  }, [id, selectedEntries, hoveredEntries, allSpans]);
  // The swept window on this layer, in **key units** — mapped to pixels at draw
  // time, because that is when the scale is known.
  // **`spanColor` only when this is the ONLY swept trace.** The hue is
  // justified by identity not being in question inside a single series — but
  // sweep two traces and both would go blue, so inside the window you could no
  // longer tell them apart, which is the very thing the rule exists to prevent.
  // With more than one, the window thickens and every trace keeps its colour.
  const soleSpannedTrace = allSpans.length === 1;
  const spanX = useMemo<readonly [number, number] | null>(() => {
    if (id === undefined) return null;
    const mine = allSpans.find((sp) => sp.id === id);
    return mine === undefined ? null : mine.x;
  }, [id, allSpans]);

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        as: semantic,
        yExtent: () => yExtent(cs),
        // The container infers the shared x scale's kind + auto-fit domain from
        // its layers: a ValueSeries plots on a value axis, a TimeSeries on time.
        xKind: series instanceof ValueSeries ? 'value' : 'time',
        xExtent: () =>
          cs.length === 0 ? null : [cs.x[0]!, cs.x[cs.length - 1]!],
        // ── Selection, gated on `id` exactly as every other layer ([PND-TRACESEL]).
        ...(id === undefined
          ? {}
          : {
              // A trace is 1-D in x: the value axis says nothing about what a
              // drag covered, so no rect and no y window.
              sweepsRect: false,
              sweepAxis: 'x' as const,
              hitTest: (px, py, xScale, yScale): SelectInfo | null => {
                const i = traceHitIndex(cs, px, py, xScale, yScale);
                if (i === null) return null;
                return {
                  id,
                  // **Series-scoped**: no sample was selected, because a
                  // sample is not a mark. `NaN` is what that already means
                  // (see `SelectInfo.key`), and the stable `mark` below is
                  // what gives the entry an identity — `sameMark` prefers it
                  // over `key`, so two clicks anywhere on the trace are the
                  // same selection and re-clicking deselects. Without the
                  // `mark` they never would: `NaN !== NaN`.
                  key: NaN,
                  value: NaN,
                  color: style.color,
                  label,
                  mark: label,
                };
              },
              beginSweep: (): SweepSession | null =>
                cs.length === 0
                  ? null
                  : sweepSpan({
                      id,
                      // Clamped to the trace's own span, so a drag off the end
                      // does not commit a range the series never covered.
                      bounds: [cs.x[0]!, cs.x[cs.length - 1]!],
                    }),
            }),
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
            const rv = readoutY?.[i];
            return Number.isFinite(v)
              ? [
                  {
                    x: cs.x[i]!,
                    value: v,
                    color: style.color,
                    label,
                    ...(rv !== undefined && Number.isFinite(rv)
                      ? { readout: rv }
                      : {}),
                  },
                ]
              : [];
          }
          const e = series.nearest(x);
          if (e === undefined) return [];
          // get() wants a literal key; column is a runtime string. Cast the
          // *event* (not the method — that would detach `this`) to a
          // string-keyed get; runtime-safe read + guard.
          const ev = e as unknown as { get(field: string): unknown };
          const v = ev.get(column);
          const rv = readout !== undefined ? ev.get(readout) : undefined;
          return typeof v === 'number' && Number.isFinite(v)
            ? [
                {
                  x: e.begin(),
                  value: v,
                  color: style.color,
                  label,
                  ...(typeof rv === 'number' && Number.isFinite(rv)
                    ? { readout: rv }
                    : {}),
                },
              ]
            : [];
        },
        draw: (ctx, xScale, yScale) => {
          const stroke = (st: LineStyle, alpha: number) => () => {
            const prior = ctx.globalAlpha;
            if (alpha !== 1) ctx.globalAlpha = prior * alpha;
            const out = drawLine(
              ctx,
              cs,
              xScale,
              yScale,
              st,
              curveFactory,
              gaps,
              gapConnectorOpacity,
              sessionBreakInstants,
              decimate,
            );
            ctx.globalAlpha = prior;
            return out;
          };
          // No window on this layer ⇒ one pass, in the series' own state.
          if (spanX === null) {
            const [st, alpha] = traceStateStyle(style, traceState);
            return stroke(st, alpha)();
          }
          // A window: the trace outside it recedes and the portion inside is
          // emphasised — the trace's answer to lighting the covered marks.
          // `spanColor` is the one hue a trace's state may take, because inside
          // a single series identity is not in question; with none themed the
          // window just thickens.
          const [outStyle, outAlpha] = traceStateStyle(style, 'dimmed');
          const [inStyle] = traceStateStyle(style, 'selected');
          return drawPartitioned(
            ctx,
            [xScale(spanX[0]), xScale(spanX[1])],
            ctx.canvas.height,
            stroke(outStyle, outAlpha),
            stroke(
              style.spanColor === undefined || !soleSpannedTrace
                ? inStyle
                : { ...inStyle, color: style.spanColor },
              1,
            ),
          );
        },
      },
      axisId: axis,
      index,
    }),
    [
      cs,
      series,
      column,
      readout,
      readoutY,
      style,
      label,
      curveFactory,
      gaps,
      gapConnectorOpacity,
      sessionBreakInstants,
      decimate,
      axis,
      id,
      traceState,
      spanX,
      soleSpannedTrace,
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
  const legendRows = useMemo<readonly LegendItemInput[] | null>(() => {
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
