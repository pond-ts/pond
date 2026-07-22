import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type {
  SeriesSchema,
  TimeSeries,
  ValueSeriesColumnName,
  ValueSeriesSchema,
} from 'pond-ts';
import { fromTimeSeries, fromValueSeries } from './data.js';
import {
  drawScatter,
  hitTestScatter,
  nearestIndex,
  scatterExtent,
} from './scatter.js';
import {
  resolveEncoding,
  type ColorEncoding,
  type RadiusEncoding,
} from './encoding.js';
import type { DecimateOption } from './decimate.js';
import { ContainerContext, LayersContext, type LayerEntry } from './context.js';
import {
  legendLabelFor,
  useLegendItems,
  type LegendItemInput,
} from './swatch.js';
import { useSlotKey } from './use-slot-key.js';

export interface ScatterChartProps<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> {
  /**
   * The source series. A `TimeSeries` scatters against the time axis; a
   * `ValueSeries` (`series.byValue('cumDist')`, or `ValueSeries.fromColumns`
   * for natively value-keyed data — IV marks keyed by strike) against its
   * value axis — the container infers which from the data, no axis-type prop
   * (mirrors `<LineChart>`). Either way the key / axis column supplies each
   * point's x and `column` supplies y.
   *
   * **Live charts:** `series.byValue(…)` mints a *fresh* projection each call,
   * so passing `series={s.byValue('dist')}` inline re-registers this layer
   * every render — memoize the projection (`useMemo`) on a frequently
   * re-rendering chart.
   */
  series: TimeSeries<S> | ValueSeries<VS>;
  /** Name of the numeric value column — each point's y. */
  column: string;
  /**
   * The scatter's semantic identifier — what the marks _are_ / how they should
   * read. The theme maps it to a {@link ScatterStyle} (`theme.scatter[as] ??
   * theme.scatter.default`) — the **base** fill, radius, outline, and label
   * colour. **Omitted ⇒ the `default` style.** This is the single styling
   * channel for the base mark; per-point size / colour come from the data-driven
   * `radius` / `color` encodings below (the deliberate, signed-off scatter
   * exception), not a per-component style override.
   */
  as?: string;
  /**
   * The **stable series identity** for selection + hover. **Optional, and it
   * gates interactivity:** the scatter is selectable/hoverable only when given an
   * `id` — omit it and the points render + read out but can't be clicked (a click
   * on them reads as empty space ⇒ deselect). Distinct from `as` (a theme role
   * that can repeat): `id` must be unique among the selectable layers, and it is
   * the key the controlled `selected` echo, dedup, and (later) multi-select all
   * match on — so a selection survives a data update where a sample `key` goes
   * stale.
   *
   * A point's identity within the series is its **x** (key / axis value). The
   * key contract allows duplicate x's (equal timestamps; a value-axis plateau
   * from `byValue('cumDist')`) — points sharing an x share identity, so
   * selecting one highlights the last drawn point at that x.
   */
  id?: string;
  /**
   * Which `<YAxis>` (by its `id`) this scatter scales against — picks the
   * *scale*, where `as` picks the *style*. **Omitted ⇒ the row's default axis.**
   */
  axis?: string;
  /**
   * **Data-driven point radius** — the signed-off exception to one-channel
   * styling. Either a fixed px radius, or `{ column, range }` to size each point
   * from a numeric column (its finite extent → `[minR, maxR]` px via a linear
   * scale). A point whose radius column is non-finite falls back to the base
   * radius. **Omitted ⇒ the style's base radius.** The encoding is a column +
   * range, *not* a per-datum callback — there's no place for a styling bug to
   * hide (the trap the package avoids).
   */
  radius?: RadiusEncoding;
  /**
   * **Data-driven point colour** — `{ column, range }`: colour each point from a
   * numeric column (its finite extent → a two-stop hex ramp via a linear scale).
   * A point whose colour column is non-finite falls back to the base colour.
   * **Omitted ⇒ the style's base colour** for every point (the single styling
   * channel). Same discipline as `radius`: a column + range, not a callback.
   */
  color?: ColorEncoding;
  /**
   * An optional per-point text label, drawn just right of each mark, in the
   * style's `label` colour + the theme font. Two forms:
   * - **a column name** ⇒ that column's value at each point, stringified;
   * - **`true`** ⇒ the plotted `column`'s value, stringified.
   *
   * **Omitted / `false` ⇒ no labels.** Keep it sparse — a label per point on a
   * dense scatter is noise; this is for a handful of called-out marks.
   */
  label?: string | boolean;
  /**
   * A **pixel** shift applied to every point's x — zoom-stable. **Default `0`.**
   * For pairing marks that share a key side by side (a call and a put mark at one
   * strike: `offset={-4}` / `offset={+4}`). Pairs with `<BoxPlot offset>`; on the
   * scatter the shift is exact — both the draw and the click hit-test move
   * together, so a nudged point still selects.
   */
  offset?: number;
  /**
   * Collapse dense, **uniform** marks to one representative per pixel cell —
   * lossless at that density, so a scatter of 100k+ points stays interactive.
   * **Default `true`.** It engages only when the marks are a fixed size + colour
   * (no data-driven `radius`/`color`), the fill is opaque, and the visible points
   * are denser than the pixel grid; otherwise every point draws. Interaction
   * (hover / click / tracker) always reads the source points. `decimate={false}`
   * draws every mark; `{ threshold }` tunes the samples-per-pixel trigger.
   */
  decimate?: DecimateOption;
  /**
   * This layer's `<Legend>` row: `false` ⇒ no row (opt out), a string ⇒ the
   * row's display name. **Omitted ⇒ a row named by the layer's readout
   * identity** (`as` ?? `column`). The swatch is the resolved base dot style
   * (a data-driven `radius`/`color` encoding shows its base, not the range).
   */
  legend?: boolean | string;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/** Runtime field read off an event without detaching `get` (which would lose
 *  `this`); `column`/`label` are runtime strings, so a typed `.get(literal)`
 *  doesn't apply. Mirrors the LineChart/BandChart cast. */
type FieldReader = { get(field: string): unknown };

/**
 * A scatter draw layer: one mark per finite point at `(x, column-value)`
 * — x from the series' key / axis column (time or value axis) —
 * with **data-driven radius + colour** (the signed-off exception — encode from
 * columns via scales, not a per-event style callback). Reads `column` into a
 * {@link ChartSeries} (gaps as NaN → no mark), registers into the enclosing
 * {@link Layers} (scaling against its `axis`), and renders nothing to the DOM —
 * the row draws it.
 *
 * **Interactions.** Hover snaps the tracker dot to the nearest point
 * (`sampleAt`), and that sample flows to the container's `onTrackerChanged` —
 * the nearest-point readout. Scatter reuses the shared tracker rather than
 * adding a separate `onNearest` channel, so a scatter reads out exactly like a
 * line. Click selection hit-tests each point's disc (`hitTest`) — **opt-in via
 * `id`**; the selected point (matching the selection's series `id` and the sample
 * `key`) gets a highlight ring. Without an `id` the scatter is display-only.
 *
 * ```tsx
 * <Layers>
 *   <ScatterChart
 *     series={s}
 *     column="price"
 *     radius={{ column: 'volume', range: [3, 14] }}
 *     color={{ column: 'change', range: ['#e8836b', '#15B3A6'] }}
 *   />
 * </Layers>
 * ```
 */
export function ScatterChart<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>({
  series,
  column,
  as: semantic,
  id,
  axis,
  radius,
  color,
  label,
  offset = 0,
  decimate = true,
  legend,
  index = 0,
}: ScatterChartProps<S, VS>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error(
      '<ScatterChart> must be rendered inside a <ChartContainer>',
    );
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<ScatterChart> must be rendered inside a <Layers>');
  }

  const cs = useMemo(
    () =>
      series instanceof ValueSeries
        ? fromValueSeries(series, column)
        : fromTimeSeries(series, column),
    [series, column],
  );
  // Styling: semantic identifier → theme scatter style. The single styling
  // channel for the base mark.
  const { scatter } = container.theme;
  const style =
    (semantic !== undefined ? scatter[semantic] : undefined) ?? scatter.default;
  // Series identity for the readout + selection match (the `as` role, else the
  // column name).
  const seriesLabel = semantic ?? column;
  const { font } = container.theme;

  // Resolve the data-driven encoding once per data/encoding change. The reader
  // pulls a named numeric column to a Float64Array (gaps NaN) — the same path
  // fromTimeSeries uses; an unknown / non-numeric column throws there (eager,
  // so a typo surfaces at render, not silently as base-styled points).
  const encoding = useMemo(
    () =>
      resolveEncoding(cs, style.radius, style.color, radius, color, (col) =>
        series instanceof ValueSeries
          ? fromValueSeries(series, col).y
          : fromTimeSeries(series, col).y,
      ),
    [cs, style.radius, style.color, radius, color, series],
  );

  // Per-point label accessor: a column name reads that field, `true` reads the
  // plotted column, anything else (false / omitted) ⇒ no labels.
  const labelAt = useMemo<
    ((i: number) => string | undefined) | undefined
  >(() => {
    if (label === undefined || label === false) return undefined;
    const field = label === true ? column : label;
    if (series instanceof ValueSeries) {
      // Columnar read — a ValueSeries has no per-row events. The field is a
      // runtime string, cast onto the schema-literal column name (the same
      // pattern as data.ts' readValueColumn). A gap or an unknown column reads
      // undefined => no label at that point.
      const col = series.column(field as ValueSeriesColumnName<VS>);
      return (i) => {
        const v = col?.read(i);
        return v === undefined || v === null ? undefined : String(v);
      };
    }
    return (i) => {
      // series.at(i) is O(1) per row (columnar eventAt cache), so a label per
      // point stays cheap. The field is a runtime string → cast off the literal-
      // keyed get (mirrors the value reads).
      const e = series.at(i) as unknown as FieldReader | undefined;
      if (e === undefined) return undefined;
      const v = e.get(field);
      return v === undefined || v === null ? undefined : String(v);
    };
  }, [label, column, series]);

  // The point's stable key is its x — the event begin (epoch ms) on a time
  // axis, the axis value on a value axis; either way it's cs.x[i], the key
  // column's begin buffer. Used for selection identity.
  const keyAt = useMemo(() => (i: number) => cs.x[i]!, [cs]);

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        as: semantic,
        yExtent: () => scatterExtent(cs),
        // The container infers the shared x scale's kind + auto-fit domain from
        // its layers: a ValueSeries scatters on a value axis, a TimeSeries on time.
        xKind: series instanceof ValueSeries ? 'value' : 'time',
        xExtent: () =>
          cs.length === 0 ? null : [cs.x[0]!, cs.x[cs.length - 1]!],
        sampleAt: (x) => {
          // No readout past the data (tracker policy — the dot snaps to a drawn
          // mark, never extrapolates past the span); bounds from the columnar x
          // axis (epoch ms or axis value — the bisect doesn't care).
          if (cs.length === 0 || x < cs.x[0]! || x > cs.x[cs.length - 1]!) {
            return [];
          }
          // Nearest *drawn* point by index (skips gaps) — O(log N). Reading by
          // index gives the value, the snap-to x, and the encoded colour in one
          // shot, so the readout swatch matches the mark the user sees.
          const i = nearestIndex(cs, x);
          if (i < 0) return [];
          return [
            {
              x: cs.x[i]!,
              value: cs.y[i]!,
              color: encoding.colorAt(i),
              label: seriesLabel,
            },
          ];
        },
        // `id` gates interactivity: only an id-bearing layer wires a hitTest, so
        // a no-id scatter is display-only (a click on it resolves to empty space).
        // Omit the key entirely when there's no id (exactOptionalPropertyTypes).
        ...(id === undefined
          ? {}
          : {
              hitTest: (px, py, xScale, yScale) =>
                hitTestScatter(
                  cs,
                  px,
                  py,
                  xScale,
                  yScale,
                  encoding,
                  keyAt,
                  id,
                  seriesLabel,
                  offset,
                ),
            }),
        draw: (ctx, xScale, yScale) =>
          drawScatter(
            ctx,
            cs,
            xScale,
            yScale,
            style,
            encoding,
            keyAt,
            labelAt,
            font,
            container.selected,
            id,
            offset,
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
      seriesLabel,
      id,
      encoding,
      keyAt,
      labelAt,
      font,
      container.selected,
      offset,
      decimate,
      axis,
      index,
    ],
  );
  // A stable per-instance slot (see useSlotKey) keeps this layer's z-position
  // fixed across data/style/selection updates (no jump to the front on update).
  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  // Also a tracker source: the container fans in this series' nearest-point
  // value at the cursor for the (outside-the-chart) readout.
  const { registerTrackerSource, unregisterTrackerSource } = container;
  useEffect(
    () => () => unregisterTrackerSource(slot),
    [unregisterTrackerSource, slot],
  );
  useEffect(() => {
    registerTrackerSource(slot, entry.layer);
  }, [registerTrackerSource, slot, entry.layer]);

  // And a legend row: the readout identity + the resolved base dot (a fixed
  // `radius` number shows at size; an encoding shows the style's base radius).
  // Carries the layer's `id` so the legend's default interactions are id-gated
  // exactly like the mark's own.
  const legendRows = useMemo<readonly LegendItemInput[] | null>(() => {
    const name = legendLabelFor(legend, seriesLabel);
    return name === null
      ? null
      : [
          {
            label: name,
            id,
            swatch: {
              kind: 'scatter',
              color: style.color,
              radius: typeof radius === 'number' ? radius : style.radius,
              outline: style.outline,
            },
          },
        ];
  }, [legend, seriesLabel, id, style, radius]);
  useLegendItems(container, slot, index, legendRows);

  // Advertise selectability (only when an `id` was given) so the container can
  // warn if selection is wired but nothing is selectable.
  const { registerSelectable, unregisterSelectable } = container;
  useEffect(() => {
    if (id === undefined) return;
    registerSelectable(slot);
    return () => unregisterSelectable(slot);
  }, [registerSelectable, unregisterSelectable, slot, id]);

  return null;
}
