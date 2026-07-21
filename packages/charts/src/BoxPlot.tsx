import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import { boxFromTimeSeries, boxFromValueSeries } from './data.js';
import {
  boxAt,
  boxExtent,
  boxIndexAtTime,
  drawBox,
  isFiniteBox,
  type BoxShape,
} from './box.js';
import type { DecimateOption } from './decimate.js';
import {
  ContainerContext,
  LayersContext,
  type CursorFlagLine,
  type LayerEntry,
  type SelectInfo,
  type TrackerSample,
} from './context.js';
import {
  legendLabelFor,
  useLegendItems,
  type LegendItemInput,
} from './swatch.js';
import { useSlotKey } from './use-slot-key.js';

export interface BoxPlotProps<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> {
  /**
   * The source series. A `TimeSeries` plots against the time axis; a `ValueSeries`
   * (`series.byValue('strike')`, or `ValueSeries.fromColumns` for natively
   * value-keyed data — a per-strike IV distribution) against its value axis — the
   * container infers which from the data, no axis-type prop (mirrors `<LineChart>`
   * / `<ScatterChart>`). The box x-span is the key's `[begin, end)` for an
   * interval-keyed `TimeSeries`, else synthesized from neighbour spacing (a
   * point-keyed `TimeSeries`, or a `ValueSeries`) so the box keeps real width.
   */
  series: TimeSeries<S> | ValueSeries<VS>;
  /** Name of the numeric column for the lower whisker end (e.g. `p5` / `min`).
   *  **Required** — with `upper` it's the whisker reach. */
  lower: string;
  /**
   * Name of the numeric column for the box bottom — first quartile (e.g. `p25`).
   * **Optional:** omit `q1` **and** `q3` together for a **range-only** box — a
   * whisker-only `lower→upper` segment, no body (a bid→ask IV mark). Giving just
   * one of `q1`/`q3` throws.
   */
  q1?: string;
  /** Name of the numeric column for the median line (e.g. `p50`). **Optional** —
   *  omit for no centre line (independent of the box body). */
  median?: string;
  /** Name of the numeric column for the box top — third quartile (e.g. `p75`).
   *  **Optional** — omit with `q1` for a range-only box (see `q1`). */
  q3?: string;
  /** Name of the numeric column for the upper whisker end (e.g. `p95` / `max`).
   *  **Required** — with `lower` it's the whisker reach. */
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
   * marks). See {@link BoxShape}. On a **range-only** box (no `q1`/`q3`),
   * `'whisker'` is one full `lower→upper` stem and `'solid'` the outer bar; `'none'`
   * would draw **nothing** (no body + no spread), so use `'whisker'`/`'solid'` there.
   */
  shape?: BoxShape;
  /** Draw the median (centre) line across each box. Default `true`, but a no-op
   *  when the `median` column is omitted (nothing to draw). The `median` prop
   *  names the *column*; this toggles the line. */
  showMedian?: boolean;
  /**
   * A **pixel** shift applied to every box's x — zoom-stable (unlike a data-space
   * nudge). **Default `0`.** For pairing marks that share a key side by side: e.g.
   * a call and a put box at the same strike, `offset={-4}` / `offset={+4}` (the
   * react-timeseries-charts side-by-side-bars precedent). Pairs with
   * `<ScatterChart offset>`.
   *
   * Only the **draw** is shifted. The box's **readouts** stay in un-shifted data
   * space — the off-chart hover finds a box by span containment (`xScale.invert`),
   * and the in-chart `flag` staff anchors at the box's data centre — so both can
   * sit up to `offset` px from the pixel-shifted box. Keep the offset small (a
   * pairing nudge, not a layout tool) and it's imperceptible. (`<ScatterChart
   * offset>` has no such gap — its hit-test is pixel-space and shifts too.)
   */
  offset?: number;
  /**
   * Whisker end-cap **total width in pixels** (the top/bottom bars of the `T`).
   * **Omitted ⇒ half the box width** (responsive — scales with the slot). Set a
   * small fixed value (e.g. `6`) to keep the caps narrow so two `offset`-paired
   * marks (call/put at one strike) don't overlap their T-bars — the caps no longer
   * grow with the wide value-axis slot. Clamped to the box width. Only affects the
   * `'whisker'` shape (`'solid'`/`'none'` have no caps).
   */
  capWidth?: number;
  /**
   * Stable series identity — **gates selection + hover**, the same id-gated
   * contract `<BarChart>` / `<ScatterChart>` carry. With an `id`, a click on a
   * box (body or whisker — a range-only bid→ask segment included) selects it
   * (`selected`/`onSelect`) and pointer-over lights it (`hovered`/`onHover`);
   * the box matching the selection's `(id, key)` outlines. **Omitted ⇒
   * display-only** (a click resolves to empty space). `key` is the box's `x`
   * (its `begin`).
   */
  id?: string;
  /**
   * **M4 viewport decimation** (charts decimator wave). **Omitted ⇒ `true`**:
   * once the visible boxes are denser than ~2 per device pixel, they are drawn as
   * per-pixel-column **aggregate boxes** — whiskers widen to the column's reach
   * (`min(lower)`/`max(upper)`), the body to its IQR envelope
   * (`min(q1)`/`max(q3)`), the centre line to the first box's median. Pass `false`
   * to draw every box at its own slot. Interaction is unaffected (hit-testing
   * reads the source boxes). Shares {@link LineChart}'s `DecimateOption`.
   */
  decimate?: DecimateOption;
  /**
   * This layer's `<Legend>` row: `false` ⇒ no row (opt out), a string ⇒ the
   * row's display name. **Omitted ⇒ a row named by the layer's readout
   * identity** (`as`, else `"<lower>–<upper>"`). The swatch is the resolved
   * whisker style.
   */
  legend?: boolean | string;
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
 * band. Reads **pre-computed quantile columns** of `series` (typically a
 * `rolling`/`aggregate` percentile pass — the chart does **not** compute them)
 * into a {@link BoxSeries} and draws one box per key: the q1→q3 body, the median
 * line, and whiskers out to lower/upper. Registers itself into the enclosing
 * {@link Layers}; renders nothing to the DOM — the row draws it.
 *
 * - **Any axis.** A `TimeSeries` plots on time, a `ValueSeries`
 *   (`series.byValue('strike')` or `ValueSeries.fromColumns`) on its value axis —
 *   a vol smile's per-strike IV. The box width is the interval key's `[begin, end)`
 *   or, for a point key (a `ValueSeries`, or a point-keyed `TimeSeries`),
 *   neighbour spacing — so it never collapses to the 1px floor.
 * - **Range-only.** `q1`/`q3` (the body) and `median` (the centre line) are
 *   optional: omit `q1`+`q3` for a whisker-only `lower→upper` segment — a bid→ask
 *   IV mark. Gap-aware: a key missing any **present** quantile draws nothing.
 * - **`offset`** nudges the whole layer in pixel space, for pairing same-key marks
 *   (call/put at one strike) side by side.
 *
 * There's no baseline — a box is a spread, not a bar to a floor; the y-domain
 * auto-fits the whisker reach (lower→upper).
 *
 * ```tsx
 * <Layers>
 *   <BoxPlot series={q} lower="p5" q1="p25" median="p50" q3="p75" upper="p95"
 *     as="latency" gap={6} />
 *   // range-only bid→ask on a value axis (a vol smile):
 *   <BoxPlot series={smile} lower="bid" upper="ask" />
 * </Layers>
 * ```
 */
export function BoxPlot<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>({
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
  offset = 0,
  capWidth,
  id,
  decimate = true,
  legend,
  index = 0,
}: BoxPlotProps<S, VS>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<BoxPlot> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<BoxPlot> must be rendered inside a <Layers>');
  }

  const isValue = series instanceof ValueSeries;
  const bx = useMemo(
    () =>
      series instanceof ValueSeries
        ? boxFromValueSeries(series, { lower, q1, median, q3, upper })
        : boxFromTimeSeries(series, { lower, q1, median, q3, upper }),
    [series, lower, q1, median, q3, upper],
  );
  // Styling: semantic identifier → theme box style. The single styling channel.
  const { box } = container.theme;
  const style =
    (semantic !== undefined ? box[semantic] : undefined) ?? box.default;
  // Readout label per quantile: when a semantic `as` is set, label reads under the
  // series name + role (`iv upper`, `iv median`) — the `as ?? column` convention
  // Line/Scatter use, so a box no longer reads out as bare column names (e.g.
  // `bidIv`); with no `as`, fall back to the column name (its role is self-evident).
  const qLabel = useMemo(() => {
    return (col: string | undefined, role: string): string =>
      semantic !== undefined ? `${semantic} ${role}` : (col ?? role);
  }, [semantic]);
  // The series identity for selection/legend: the `as` role, else the range
  // columns as a span (matches the legend row's label).
  const label = semantic ?? `${lower}–${upper}`;
  // Current selection / hover narrowed to this layer's box key (its `x`), or
  // `null` — matched by the series `id`, so a change re-registers the layer and
  // the canvas repaints the outline. A no-`id` layer never matches.
  const sel = container.selected;
  const hov = container.hovered;
  const selectedKey =
    id !== undefined && sel !== null && sel.id === id ? sel.key : null;
  const hoveredKey =
    id !== undefined && hov !== null && hov.id === id ? hov.key : null;
  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => boxExtent(bx),
        // A ValueSeries plots on a value axis, a TimeSeries on time; the container
        // infers the shared x kind from its layers.
        xKind: isValue ? 'value' : 'time',
        xExtent: () =>
          bx.length === 0 ? null : [bx.x[0]!, bx.xEnd[bx.length - 1]!],
        sampleAt: (x) => {
          // The readout reads the box **under the cursor** (boxIndexAtTime — span
          // containment, not nearest-by-begin which flips past a wide box's
          // midpoint), anchored at the box **centre** `(x + xEnd) / 2`. Outside
          // every box → no readout. Off-chart fan-in only; the in-chart flag is
          // `cursorFlag`. `push` skips a non-finite quantile, so an absent
          // (range-only) q1/q3/median simply doesn't read out.
          if (bx.length === 0) return [];
          const i = boxIndexAtTime(bx, x);
          if (i < 0) return [];
          const at = (bx.x[i]! + bx.xEnd[i]!) / 2;
          const samples: TrackerSample[] = [];
          push(samples, at, bx.upper[i], style.whisker, qLabel(upper, 'upper'));
          push(samples, at, bx.q3[i], style.whisker, qLabel(q3, 'q3'));
          push(
            samples,
            at,
            bx.median[i],
            style.median,
            qLabel(median, 'median'),
          );
          push(samples, at, bx.q1[i], style.whisker, qLabel(q1, 'q1'));
          push(samples, at, bx.lower[i], style.whisker, qLabel(lower, 'lower'));
          return samples;
        },
        cursorFlag: (x) => {
          // The in-chart `flag`: the box's values on **one** flag at its
          // top-centre. The staff rises from `upper` (the mark's top); the values
          // run high→low across one horizontal row (Layers renders them
          // left→right), each coloured to its box piece. A gap box (its present
          // quantiles not all finite) shows no flag; an absent (range-only)
          // quantile is simply skipped.
          if (bx.length === 0) return null;
          const i = boxIndexAtTime(bx, x);
          if (i < 0 || !isFiniteBox(bx, i)) return null;
          const lines: CursorFlagLine[] = [];
          const line = (value: number, color: string, label: string) => {
            if (Number.isFinite(value)) lines.push({ value, color, label });
          };
          line(bx.upper[i]!, style.whisker, qLabel(upper, 'upper'));
          line(bx.q3[i]!, style.whisker, qLabel(q3, 'q3'));
          line(bx.median[i]!, style.median, qLabel(median, 'median'));
          line(bx.q1[i]!, style.whisker, qLabel(q1, 'q1'));
          line(bx.lower[i]!, style.whisker, qLabel(lower, 'lower'));
          return {
            x: (bx.x[i]! + bx.xEnd[i]!) / 2,
            topValue: bx.upper[i]!,
            lines,
          };
        },
        // Selection hit-test (opt-in via `id`, like Bar/Scatter): the first box
        // whose bounding rect contains the click. A box is a discrete interval
        // mark, so this is rect-containment (`boxAt`) — not the continuous
        // nearest-point threshold. `key` is the box's `x`; `value` its `upper`.
        ...(id === undefined
          ? {}
          : {
              hitTest: (px, py, xScale, yScale): SelectInfo | null => {
                const hit = boxAt(
                  bx,
                  px,
                  py,
                  xScale,
                  yScale,
                  gap,
                  MIN_BOX_WIDTH_PX,
                  offset,
                );
                if (hit === null) return null;
                const [, begin, value] = hit;
                return { id, key: begin, value, color: style.whisker, label };
              },
            }),
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
            offset,
            capWidth,
            selectedKey,
            hoveredKey,
            decimate,
          ),
      },
      axisId: axis,
      index,
    }),
    [
      bx,
      isValue,
      series,
      lower,
      q1,
      median,
      q3,
      upper,
      qLabel,
      style,
      gap,
      shape,
      showMedian,
      offset,
      capWidth,
      id,
      label,
      selectedKey,
      hoveredKey,
      decimate,
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

  // Advertise selectability (only when an `id` was given) — powers the
  // container's "wired but nothing selectable" dev-warn, like Bar/Scatter.
  const { registerSelectable, unregisterSelectable } = container;
  useEffect(() => {
    if (id === undefined) return;
    registerSelectable(slot);
    return () => unregisterSelectable(slot);
  }, [registerSelectable, unregisterSelectable, slot, id]);

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

  // And a legend row: the series identity (`as`, else the range columns as a
  // span) + the resolved whisker style, so a `<Legend>` swatch can never drift.
  const legendRows = useMemo<readonly LegendItemInput[] | null>(() => {
    const name = legendLabelFor(legend, semantic ?? `${lower}–${upper}`);
    return name === null
      ? null
      : [
          {
            label: name,
            swatch: {
              kind: 'box',
              whisker: style.whisker,
              whiskerWidth: style.whiskerWidth,
            },
          },
        ];
  }, [legend, semantic, lower, upper, style]);
  useLegendItems(container, slot, index, legendRows);

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
