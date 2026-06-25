import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { fromTimeSeries } from './data.js';
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
import { ContainerContext, LayersContext, type LayerEntry } from './context.js';
import { useSlotKey } from './use-slot-key.js';

export interface ScatterChartProps<S extends SeriesSchema> {
  /** The source series. Its key column supplies the time axis (each point's x). */
  series: TimeSeries<S>;
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
 * A scatter draw layer: one mark per finite point at `(time, column-value)`,
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
 * line. Click selection hit-tests each point's disc (`hitTest`); the selected
 * point (matching both its key and this series' label) gets a highlight ring.
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
export function ScatterChart<S extends SeriesSchema>({
  series,
  column,
  as: semantic,
  axis,
  radius,
  color,
  label,
  index = 0,
}: ScatterChartProps<S>) {
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

  const cs = useMemo(() => fromTimeSeries(series, column), [series, column]);
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
      resolveEncoding(
        cs,
        style.radius,
        style.color,
        radius,
        color,
        (col) => fromTimeSeries(series, col).y,
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

  // The point's stable key is its event begin (epoch ms) — the same as cs.x[i],
  // which is the key column's begin buffer. Used for selection identity.
  const keyAt = useMemo(() => (i: number) => cs.x[i]!, [cs]);

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => scatterExtent(cs),
        xKind: 'time',
        xExtent: () =>
          cs.length === 0 ? null : [cs.x[0]!, cs.x[cs.length - 1]!],
        sampleAt: (time) => {
          // No readout past the data (tracker policy — the dot snaps to a drawn
          // mark, never extrapolates past the span); bounds from the time axis.
          if (
            cs.length === 0 ||
            time < cs.x[0]! ||
            time > cs.x[cs.length - 1]!
          ) {
            return [];
          }
          // Nearest *drawn* point by index (skips gaps) — O(log N). Reading by
          // index gives the value, the snap-to x, and the encoded colour in one
          // shot, so the readout swatch matches the mark the user sees.
          const i = nearestIndex(cs, time);
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
        hitTest: (px, py, xScale, yScale) =>
          hitTestScatter(
            cs,
            px,
            py,
            xScale,
            yScale,
            encoding,
            keyAt,
            seriesLabel,
          ),
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
            seriesLabel,
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
      encoding,
      keyAt,
      labelAt,
      font,
      container.selected,
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

  return null;
}
