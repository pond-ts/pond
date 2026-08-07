import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import { stacksFromColumns } from './data.js';
import {
  bandedColor,
  drawHeat,
  heatAt,
  heatValueExtent,
  type HeatStyle,
} from './heat.js';
import {
  ContainerContext,
  LayersContext,
  type LayerEntry,
  type SelectInfo,
} from './context.js';
import { useSlotKey } from './use-slot-key.js';

export interface HeatMapProps<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> {
  /**
   * The source series. A **`TimeSeries`** puts time intervals on x, a
   * **`ValueSeries`** puts value intervals on x — inferred, no axis-kind prop,
   * the same rule `<BarChart>` uses.
   *
   * Because the cell spans are the ordinary bin spans, the whole of pond's
   * binning machinery applies unchanged: `aggregate` over a trading calendar
   * with sessions, `Sequence.calendar` day/week/month buckets, `byColumn` value
   * bands. The heat map inherits all of it by having no opinion about x.
   */
  series: TimeSeries<S> | ValueSeries<VS>;
  /**
   * The numeric columns forming the **rows**, bottom → top — one row per
   * column. Give one column for a single-row **stripe**; a stripe is just
   * `columns.length === 1`, drawn by the same path.
   *
   * The y dimension must be columns, which is the layer's one real constraint.
   * A month-of-year grid means a column per month; a per-city grid means a
   * column per city (`pivotByGroup`'s long→wide output, or `partitionBy`
   * reshaped). That keeps the second dimension in the data model, where pond's
   * own reshaping operators can produce it, rather than inventing a
   * chart-level pivot.
   *
   * Row `0` is at the **bottom**, matching the band-axis convention; reverse
   * the list to read top-down.
   */
  columns: readonly string[];
  /**
   * The colour ramp, low → high. The value domain splits into `colors.length`
   * equal bands and a cell takes its band's colour (see {@link bandedColor}).
   * A diverging ramp is just a ramp whose middle is pale.
   */
  colors: readonly string[];
  /**
   * Pin the colour domain as `[lo, hi]`. **Omitted ⇒ the finite extent across
   * the whole grid**, so every row is read against one scale and rows are
   * comparable to each other.
   *
   * Pin it when two charts must be read against each other, or when the window
   * is a slice of a longer record and the colours should not re-mean themselves
   * as it moves — a colour scale has no tick labels to reveal that it moved.
   */
  domain?: readonly [number, number];
  /** Semantic identifier — picks geometry defaults off `theme.bar[as]`. */
  as?: string;
  /** Which `<YAxis>` (by `id`) this layer scales against. */
  axis?: string;
  /** Px inset around each cell. **Omitted ⇒ `0`**, tiling flush. */
  gap?: number;
  /** Stable identity — **gates selection + hover**, as every layer's does. */
  id?: string;
  /** @internal Declaration position, injected by `Layers`. Do not set. */
  index?: number;
}

/**
 * A **heat-map draw layer**: a grid of cells, bins along x and the series'
 * columns down y, colour carrying the aggregate ([PND-HEATMAP]).
 *
 * ```tsx
 * // A stripe — one column.
 * <HeatMap series={hourly} columns={['count']} colors={ramp} id="load" />
 *
 * // A grid — one column per row.
 * <HeatMap series={byCity} columns={['London', 'Paris', 'Berlin']} colors={ramp} />
 * ```
 *
 * **No reader of its own.** It builds on `stacksFromColumns`, whose output is
 * already a heat map's data shape — bin spans, named rows, a row-major value
 * grid. That covers all four shapes pond can express today (`TimeSeries` or
 * `ValueSeries` × one column or many), and the stripe is simply `G === 1`, so
 * there is one draw path rather than two.
 *
 * **The readout is the point.** A cell carries its value, so hover and click
 * report it and the readout pill takes the cell's own colour. The bar-based
 * workaround this replaces cannot: its bars are a constant-height column
 * carrying no value, so the number has to be looked up out-of-band.
 *
 * **Styling.** Colour is data and comes from `colors`, not the theme. Geometry
 * and the selected-cell treatment are borrowed from
 * `theme.bar[as] ?? theme.bar.default` rather than a new `theme.heat` slot:
 * `ChartTheme`'s slots are required, so adding one is breaking for every custom
 * theme, and the M5 "theme tokens optional-with-default" gate has to land
 * first. Borrowing defers that decision instead of pre-empting it.
 *
 * **Not built:** a grouped two-level x axis, and cell value labels. The former
 * is axis work that would serve bars equally; the latter is small and
 * independent.
 */
export function HeatMap<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>({
  series,
  columns,
  colors,
  domain,
  as: semantic,
  axis,
  gap = 0,
  id,
  index = 0,
}: HeatMapProps<S, VS>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<HeatMap> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<HeatMap> must be rendered inside a <Layers>');
  }
  if (columns.length === 0) {
    throw new Error('<HeatMap> needs at least one column (one row per column)');
  }

  const ss = useMemo(
    () => stacksFromColumns(series, columns),
    [series, columns],
  );

  const { bar } = container.theme;
  const base =
    (semantic !== undefined ? bar[semantic] : undefined) ?? bar.default;
  const style = useMemo<HeatStyle>(
    () => ({
      opacity: base.opacity,
      highlight: base.highlight,
      outlineWidth: base.outlineWidth,
      gap,
      minWidth: base.minWidth,
    }),
    [base, gap],
  );

  // One colour domain across the whole grid, so rows are comparable.
  const [lo, hi] = useMemo(
    () => domain ?? heatValueExtent(ss) ?? [0, 1],
    [domain, ss],
  );
  const G = ss.groups.length;
  const colorAt = useMemo(
    () => (b: number, g: number) =>
      bandedColor(ss.values[b * G + g]!, colors, lo, hi),
    [ss, G, colors, lo, hi],
  );

  const selected = container.selected;
  const hoveredMark = container.hovered;
  const selection = useMemo(
    () =>
      selected === null
        ? null
        : {
            id: selected.id,
            key: selected.key,
            label: selected.label,
            ...(selected.mark !== undefined ? { mark: selected.mark } : {}),
          },
    [selected],
  );
  const hover = useMemo(
    () =>
      hoveredMark === null
        ? null
        : {
            id: hoveredMark.id,
            key: hoveredMark.key,
            label: hoveredMark.label,
            ...(hoveredMark.mark !== undefined
              ? { mark: hoveredMark.mark }
              : {}),
          },
    [hoveredMark],
  );

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        as: semantic,
        // Inferred, exactly as BarChart does it — no axis-kind prop.
        xKind: series instanceof ValueSeries ? 'value' : 'time',
        xExtent: () =>
          ss.length === 0 ? null : [ss.begin[0]!, ss.end[ss.length - 1]!],
        // Unit slots, one per row; `binCategories` labels each at its centre.
        yExtent: () => [0, G],
        binCategories: () => ss.groups,
        sampleAt: (x) => {
          // Every row's value at the cursor — the whole column of the grid,
          // which is what an off-chart readout wants from a heat map.
          for (let b = 0; b < ss.length; b += 1) {
            if (x < ss.begin[b]! || x > ss.end[b]!) continue;
            const out = [];
            for (let g = 0; g < G; g += 1) {
              const v = ss.values[b * G + g]!;
              if (!Number.isFinite(v)) continue;
              out.push({
                x: (ss.begin[b]! + ss.end[b]!) / 2,
                value: v,
                color: colorAt(b, g) ?? style.highlight,
                label: ss.groups[g]!,
              });
            }
            return out;
          }
          return [];
        },
        ...(id === undefined
          ? {}
          : {
              hitTest: (px, py, xScale, yScale): SelectInfo | null => {
                const hit = heatAt(
                  ss,
                  px,
                  py,
                  xScale,
                  yScale,
                  style.gap,
                  style.minWidth,
                );
                if (hit === null) return null;
                const [b, g, begin, name, value] = hit;
                const mark = ss.marks?.[b];
                return {
                  id,
                  key: begin,
                  value,
                  color: colorAt(b, g) ?? style.highlight,
                  label: name,
                  ...(mark !== undefined ? { mark } : {}),
                };
              },
            }),
        draw: (ctx, xScale, yScale) =>
          drawHeat(
            ctx,
            ss,
            xScale,
            yScale,
            style,
            colorAt,
            id,
            selection,
            hover,
          ),
      },
      axisId: axis,
      index,
    }),
    [
      ss,
      G,
      style,
      colorAt,
      semantic,
      series,
      id,
      axis,
      index,
      selection,
      hover,
    ],
  );

  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  const { registerTrackerSource, unregisterTrackerSource } = container;
  useEffect(
    () => () => unregisterTrackerSource(slot),
    [unregisterTrackerSource, slot],
  );
  useEffect(() => {
    registerTrackerSource(slot, entry.layer);
  }, [registerTrackerSource, slot, entry.layer]);

  const { registerSelectable, unregisterSelectable } = container;
  useEffect(() => {
    if (id === undefined) return;
    registerSelectable(slot);
    return () => unregisterSelectable(slot);
  }, [registerSelectable, unregisterSelectable, slot, id]);

  return null;
}
