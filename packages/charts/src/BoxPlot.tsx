import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { boxFromTimeSeries } from './data.js';
import { boxExtent, drawBox } from './box.js';
import {
  ContainerContext,
  LayersContext,
  type LayerEntry,
  type TrackerSample,
} from './context.js';
import { useSlotKey } from './use-slot-key.js';

export interface BoxPlotProps<S extends SeriesSchema> {
  /** The source series. Its interval key column supplies the time axis (the box
   *  x-span is the key's `[begin, end)`). */
  series: TimeSeries<S>;
  /** Name of the numeric column for the lower whisker end (e.g. `p5` / `min`). */
  lower: string;
  /** Name of the numeric column for the box bottom — first quartile (e.g. `p25`). */
  q1: string;
  /** Name of the numeric column for the median line (e.g. `p50`). */
  median: string;
  /** Name of the numeric column for the box top — third quartile (e.g. `p75`). */
  q3: string;
  /** Name of the numeric column for the upper whisker end (e.g. `p95` / `max`). */
  upper: string;
  /**
   * The box series' semantic identifier — what the spread _is_ (e.g. `latency`).
   * The theme maps it to a {@link BoxStyle} (`theme.box[as] ?? theme.box.default`
   * — box fill/outline, median, whisker). **Omitted ⇒ the `default` box style**;
   * there's no per-component colour/style override (restyle via the theme, the
   * single styling channel).
   */
  as?: string;
  /**
   * Which `<YAxis>` (by its `id`) this box scales against — the *scale*, where
   * `as` picks the *style*. **Omitted ⇒ the row's default axis.**
   */
  axis?: string;
  /**
   * Total horizontal inset between adjacent boxes in px (half each side), so they
   * breathe — see `barSpanPx`. **Omitted ⇒ `0`** (boxes fill their interval span
   * edge-to-edge). A box narrower than 1px after the inset collapses to a 1px
   * mark centred in its slot, so a thin bucket stays visible.
   */
  gap?: number;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/** Whisker collapse floor (px) — a too-thin box still draws a 1px mark. */
const MIN_BOX_WIDTH_PX = 1;

/**
 * A discrete box-and-whisker draw layer — the bar-chart analog of the variance
 * band. Reads five **pre-computed quantile columns** of `series` (typically a
 * `rolling`/`aggregate` percentile pass — the chart does **not** compute them)
 * into a {@link BoxSeries} and draws one box per key: the q1→q3 box, the median
 * line, and whiskers out to lower/upper, over the key's interval x-span. Gap-aware
 * (a key missing any quantile draws nothing) and registers itself into the
 * enclosing {@link Layers}. Renders nothing to the DOM — the row draws it.
 *
 * There's no baseline — a box is a spread, not a bar to a floor; the y-domain
 * auto-fits the whisker reach (lower→upper).
 *
 * ```tsx
 * <Layers>
 *   <BoxPlot
 *     series={q}
 *     lower="p5" q1="p25" median="p50" q3="p75" upper="p95"
 *     as="latency"
 *     gap={6}
 *   />
 * </Layers>
 * ```
 */
export function BoxPlot<S extends SeriesSchema>({
  series,
  lower,
  q1,
  median,
  q3,
  upper,
  as: semantic,
  axis,
  gap = 0,
  index = 0,
}: BoxPlotProps<S>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<BoxPlot> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<BoxPlot> must be rendered inside a <Layers>');
  }

  const bx = useMemo(
    () => boxFromTimeSeries(series, { lower, q1, median, q3, upper }),
    [series, lower, q1, median, q3, upper],
  );
  // Styling: semantic identifier → theme box style. The single styling channel.
  const { box } = container.theme;
  const style =
    (semantic !== undefined ? box[semantic] : undefined) ?? box.default;
  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => boxExtent(bx),
        sampleAt: (time) => {
          // No readout past the data (tracker policy — nearest() clamps); bounds
          // from the columnar interval axis (begin of the first key → end of the
          // last). Empty series or out of range yields no readout.
          if (
            bx.length === 0 ||
            time < bx.x[0]! ||
            time > bx.xEnd[bx.length - 1]!
          ) {
            return [];
          }
          const e = series.nearest(time);
          if (e === undefined) return [];
          // get() wants a literal key; the column names are runtime strings. Cast
          // the *event* (not the method — detaching `this` breaks `get`).
          const ev = e as unknown as { get(field: string): unknown };
          const at = e.begin();
          const samples: TrackerSample[] = [];
          // The median is the primary readout (median colour); the four quantile
          // edges ride the whisker colour, each labelled by its own column. A
          // single non-finite quantile is omitted (a gap key yields nothing — all
          // five missing — but a malformed partial set still reads what it has).
          push(samples, at, ev.get(upper), style.whisker, upper);
          push(samples, at, ev.get(q3), style.whisker, q3);
          push(samples, at, ev.get(median), style.median, median);
          push(samples, at, ev.get(q1), style.whisker, q1);
          push(samples, at, ev.get(lower), style.whisker, lower);
          return samples;
        },
        draw: (ctx, xScale, yScale) =>
          drawBox(ctx, bx, xScale, yScale, style, gap, MIN_BOX_WIDTH_PX),
      },
      axisId: axis,
      index,
    }),
    [bx, series, lower, q1, median, q3, upper, style, gap, axis, index],
  );
  // Stable per-instance slot (see useSlotKey): keeps this box's z-position +
  // identity across prop updates; the injected index drives the sort.
  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  // Also a tracker source: the container fans in the box quantiles at the cursor
  // for the (outside-the-chart) readout.
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

/** Append a tracker sample for a quantile, skipping a non-finite value. */
function push(
  out: TrackerSample[],
  x: number,
  value: unknown,
  color: string,
  label: string,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push({ x, value, color, label });
  }
}
