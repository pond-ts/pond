import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { boxFromTimeSeries } from './data.js';
import {
  boxExtent,
  boxIndexAtTime,
  drawBox,
  isFiniteBox,
  type BoxShape,
} from './box.js';
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
   * How each box renders its spread — `'whisker'` (default; thin stems + caps),
   * `'solid'` (the candlestick look: a light outer bar over the full range with a
   * darker inner q1→q3 box, no stems), or `'none'` (the q1→q3 box only, no spread
   * marks). See {@link BoxShape}.
   */
  shape?: BoxShape;
  /** Draw the median (centre) line across each box. Always optional; default
   *  `true`. (The `median` prop above names the *column*; this toggles the line.) */
  showMedian?: boolean;
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
  shape = 'whisker',
  showMedian = true,
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
        xKind: 'time',
        xExtent: () =>
          bx.length === 0 ? null : [bx.x[0]!, bx.xEnd[bx.length - 1]!],
        sampleAt: (time) => {
          // The readout reads the box **under the cursor** (boxIndexAtTime — span
          // containment, not nearest-by-begin which flips past a wide box's
          // midpoint), anchored at the box **centre** `(x + xEnd) / 2`. Outside
          // every box → no readout. Off-chart fan-in only; the in-chart flag is
          // `cursorFlag`.
          if (bx.length === 0) return [];
          const i = boxIndexAtTime(bx, time);
          if (i < 0) return [];
          const at = (bx.x[i]! + bx.xEnd[i]!) / 2;
          const samples: TrackerSample[] = [];
          // The median is the primary readout (median colour); the four quantile
          // edges ride the whisker colour, each labelled by its own column. A
          // single non-finite quantile is omitted (a gap key yields nothing — all
          // five missing — but a malformed partial set still reads what it has).
          push(samples, at, bx.upper[i], style.whisker, upper);
          push(samples, at, bx.q3[i], style.whisker, q3);
          push(samples, at, bx.median[i], style.median, median);
          push(samples, at, bx.q1[i], style.whisker, q1);
          push(samples, at, bx.lower[i], style.whisker, lower);
          return samples;
        },
        cursorFlag: (time) => {
          // The in-chart `flag`: all five values on **one** flag at the box's
          // top-centre. The staff rises from `upper` (the mark's top); the values
          // run high→low across one horizontal row (Layers renders them
          // left→right), each coloured to its box piece. All-or-nothing — a gap
          // box (any quantile non-finite, not drawn) shows no flag.
          if (bx.length === 0) return null;
          const i = boxIndexAtTime(bx, time);
          if (i < 0 || !isFiniteBox(bx, i)) return null;
          return {
            x: (bx.x[i]! + bx.xEnd[i]!) / 2,
            topValue: bx.upper[i]!,
            lines: [
              { value: bx.upper[i]!, color: style.whisker, label: upper },
              { value: bx.q3[i]!, color: style.whisker, label: q3 },
              { value: bx.median[i]!, color: style.median, label: median },
              { value: bx.q1[i]!, color: style.whisker, label: q1 },
              { value: bx.lower[i]!, color: style.whisker, label: lower },
            ],
          };
        },
        draw: (ctx, xScale, yScale) =>
          drawBox(
            ctx,
            bx,
            xScale,
            yScale,
            style,
            gap,
            MIN_BOX_WIDTH_PX,
            shape,
            showMedian,
          ),
      },
      axisId: axis,
      index,
    }),
    [
      bx,
      series,
      lower,
      q1,
      median,
      q3,
      upper,
      style,
      gap,
      shape,
      showMedian,
      axis,
      index,
    ],
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
