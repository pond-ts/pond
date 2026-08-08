import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import { stacksFromColumns } from './data.js';
import type { DecimateOption } from './decimate.js';
import type { Orientation, StackMark } from './bars.js';
import {
  bandedColor,
  drawHeat,
  heatAt,
  heatValueExtent,
  type HeatNoData,
  type HeatScale,
  type HeatStyle,
} from './heat.js';
import { spansForLayer } from './span.js';
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
  /**
   * Which axis carries the **bins**. `'vertical'` (the default) puts them on
   * **x** with the columns as rows down y; `'horizontal'` transposes — bins run
   * down **y** and the columns become the categories along x.
   *
   * The transpose is cheaper here than for `<BarChart>`, because a heat map has
   * two *position* axes and no value axis: nothing has to change which scale it
   * is measured against, only which one is horizontal on the canvas.
   *
   * Reach for `'horizontal'` when the binned dimension is the long one and the
   * columns are few — a gene-expression matrix (thousands of gene buckets, a
   * handful of samples) is the canonical case, and it is the orientation that
   * literature draws. Note that the bins still come from the **key** axis, so
   * the genes must be the series' rows and the samples its columns; the
   * ordinary binning operators (`byColumn`, `aggregate`) then bucket them.
   */
  orientation?: Orientation;
  /** Semantic identifier — picks geometry defaults off `theme.bar[as]`. */
  as?: string;
  /** Which `<YAxis>` (by `id`) this layer scales against. */
  axis?: string;
  /** Px inset around each cell. **Omitted ⇒ `0`**, tiling flush. */
  gap?: number;
  /**
   * How value maps onto the ramp's bands. **Omitted ⇒ `'linear'`** — equal-width
   * bands across the domain.
   *
   * `'log'` gives equal-*ratio* bands, which is what a quantity spanning orders
   * of magnitude needs. US measles incidence runs from ~2,900 per 100k before
   * the vaccine to under 1 after it; linear banding over eight colours puts
   * everything below ~360 into a single band — the entire post-1965 record,
   * which is the half of that chart carrying the finding.
   *
   * Bands on `log1p` of the offset from the domain's floor, so a value **at**
   * the floor is a real band rather than `-Infinity`. Zero is the case that
   * needs it: an incidence grid is mostly zeros once a disease is eliminated,
   * and those cells are the point.
   */
  scale?: HeatScale;
  /**
   * How a cell with no value is drawn. **Omitted ⇒ `'blank'`** — nothing is
   * painted and the background shows through, which is right when a hole simply
   * means "outside the record".
   *
   * `'hatch'` draws diagonal lines in the theme's grid colour. Reach for it when
   * *missing* and *low* would otherwise be indistinguishable — on a pale ramp
   * "draw nothing" reads as the bottom of the scale, so a state with no
   * surveillance yet looks exactly like a state reporting zero cases. No ramp
   * colour can be mistaken for hatching, which is why it is the convention.
   *
   * Suppressed while decimated: an aggregated cell is not a hole.
   */
  noData?: HeatNoData;
  /**
   * Viewport decimation — **on by default**, and a perf knob rather than a
   * rendering-style one.
   *
   * Once the visible cells are denser than ~2 per device pixel they overlap and
   * overpaint each other, so what you see is already one cell per column picked
   * by draw order. Decimation replaces that with the **mean** per pixel column
   * — what the overdrawn picture resolves to at that size — from `O(W·G)` rects
   * instead of `O(V·G)`. A 20,000-bin grid over an 800px plot goes from ~48ms
   * to a fraction of it.
   *
   * `{ threshold }` moves the cells-per-pixel gate (default `2`). `false` draws
   * every visible cell — reach for it if you are screenshotting at a device
   * pixel ratio the gate can't see, not to "keep the data honest": undecimated
   * at this density is the less honest picture.
   *
   * While decimated, per-cell selection and hover outlines are suppressed (a
   * sub-pixel ring isn't visible anyway) and interaction still reads the source
   * grid.
   */
  decimate?: DecimateOption;
  /**
   * Stable identity — **gates selection + hover**, as every layer's does. Both
   * channels are sets, and **every** cell a member names outlines (bin `key` —
   * or the stable per-bin `mark` — plus the row `label`), so a multi-cell pin or
   * a drag-sweep hover lights all of it. A cell in both reads as selected.
   */
  id?: string;
  /** @internal Declaration position, injected by `Layers`. Do not set. */
  index?: number;
}

/** Stable identity for "nothing in this set" — the resting case, so the layer
 *  doesn't rebuild its `entry` (and the canvas doesn't repaint) merely because
 *  the container handed out a fresh empty array. */
const NO_MARKS: readonly StackMark[] = [];

/**
 * The cell identity of every member of `set` — the layer `id`, the bin `key`
 * (or the stable per-bin `mark` where the series carries one) and the row
 * `label`, which is the whole of what {@link drawHeat} matches on.
 *
 * Deliberately **not** filtered to this layer's own `id` — the draw matches on
 * it anyway, and gates its per-bin scan on whether either set names this layer
 * at all, so a component-side filter would buy nothing and add a second place
 * the id rule lives. What this *does* drop is the `SelectInfo` presentation
 * fields (`value`, `color`), which the draw has no business reading.
 */
function marksOf(set: readonly SelectInfo[]): readonly StackMark[] {
  if (set.length === 0) return NO_MARKS;
  return set.map((m) => ({
    id: m.id,
    key: m.key,
    label: m.label,
    ...(m.mark !== undefined ? { mark: m.mark } : {}),
  }));
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
 * **Pair it with `<ChartContainer cursor="none">`.** The container's default is
 * the shared vertical line, and on a grid that is a *second, weaker* cursor
 * competing with the one that already works: the cell under the pointer takes an
 * outline, which says both axes at once. The line says only x, and a heat map's
 * x position is rarely the question. The pointer's own crosshair shape plus the
 * cell outline is the whole affordance.
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
  orientation = 'vertical',
  as: semantic,
  axis,
  gap = 0,
  scale = 'linear',
  noData = 'blank',
  decimate = true,
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

  // `columns`, `colors` and `domain` are **array** props, and the natural way to
  // write every one of them is a fresh array per render — a JSX literal, a
  // `.map()`, or a theme hook like the docs site's `useSequentialRamp()`. Keyed
  // by identity they would rebuild the layer `entry` every render, hence a
  // `registerLayer` every render: a repaint treadmill, not a noisy warning. So
  // memoize on **content**, exactly as `<BarChart thresholds>` does. The joiner
  // is NUL rather than a comma because a column name may contain a comma, and
  // `['a,b']` must not key the same as `['a', 'b']`.
  const columnsKey = columns.join('\u0000');
  const colorsKey = colors.join('\u0000');
  const domainKey =
    domain === undefined ? '' : `${domain[0]}\u0000${domain[1]}`;

  const ss = useMemo(
    () => stacksFromColumns(series, columns),
    [series, columnsKey],
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
      gridColor: container.theme.axis.grid,
    }),
    [base, gap, container.theme.axis.grid],
  );

  // One colour domain across the whole grid, so rows are comparable.
  const [lo, hi] = useMemo(
    () => domain ?? heatValueExtent(ss) ?? [0, 1],
    [domainKey, ss],
  );
  const G = ss.groups.length;
  const vertical = orientation === 'vertical';
  // Colour is a function of the **value**, which is the layer's whole model —
  // so the closure takes one. It also lets a decimated pixel column, which has
  // no source `(b, g)`, be coloured by the same ramp.
  const colorOf = useMemo(
    () => (value: number) => bandedColor(value, colors, lo, hi, scale),
    [colorsKey, lo, hi, scale],
  );

  const selected = container.selected;
  const hoveredMark = container.hovered;
  // Both channels are **sets** — `selected` since [PND-MULTISEL], `hovered`
  // since RFC A4.3 — and both reach `drawHeat` whole, which lights every cell a
  // member names. Narrowed here only from `SelectInfo` down to the cell identity
  // (`id` + `key`/`mark` + row `label`), so `heat.ts` stays free of the
  // selection's presentation fields exactly as it is free of the theme.
  const selection = useMemo(() => marksOf(selected), [selected]);
  const hover = useMemo(() => marksOf(hoveredMark), [hoveredMark]);
  // The selection's span entries, narrowed to this layer (interaction RFC
  // A5.2). A heat map's labels vary per cell (the row names — the ordinal
  // second dimension a span addresses via `rows`, RFC A5.3), so no label is
  // passed and the `rows` channel rides through for `drawHeat` to test per
  // cell. Reference-stable when empty, like the mark memos above.
  const layerSpans = useMemo(
    () => spansForLayer(container.selectedSpans, id),
    [container.selectedSpans, id],
  );

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        as: semantic,
        // Inferred, exactly as BarChart does it — no axis-kind prop.
        // Horizontal moves the bins to y, so x becomes the categories the
        // columns name — which is the container's `'category'` kind, exactly as
        // a categorical `<BarChart>` reports it.
        xKind: vertical
          ? series instanceof ValueSeries
            ? 'value'
            : 'time'
          : 'category',
        xExtent: () =>
          vertical
            ? ss.length === 0
              ? null
              : [ss.begin[0]!, ss.end[ss.length - 1]!]
            : [0, G],
        yExtent: () =>
          vertical
            ? [0, G]
            : ss.length === 0
              ? null
              : [ss.begin[0]!, ss.end[ss.length - 1]!],
        // Unit slots, one per column, labelled at each centre — on whichever
        // axis they landed. `binCategories` is the y-axis channel and
        // `xCategories` the x-axis one ([PND-HCAT]).
        ...(vertical
          ? { binCategories: () => ss.groups }
          : { xCategories: () => ss.groups }),
        // The x-scrub tracker samples along x, which is the bin axis only when
        // vertical. A horizontal grid answers through `onHover` / `onSelect`
        // instead, which resolve both axes — the same split the 2-D readout
        // already forced.
        sampleAt: (x) => {
          if (!vertical) return [];
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
                // `value` is where the cursor *draws* — `yScale(value)` — so
                // it must be a y coordinate, and for a cell that is its row's
                // centre, not its number. The number rides `readout`, which
                // an off-chart consumer shows as `readout ?? value`. Without
                // the split the dot would be placed at `yScale(anomaly)` on a
                // unit-slot axis and land outside the plot entirely.
                value: g + 0.5,
                readout: v,
                color: colorOf(v) ?? style.highlight,
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
                  orientation,
                );
                if (hit === null) return null;
                const [b, g, begin, name, value] = hit;
                const mark = ss.marks?.[b];
                return {
                  id,
                  key: begin,
                  value,
                  color: colorOf(value) ?? style.highlight,
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
            colorOf,
            id,
            // Both sets whole. Passing `selection[0]` here quietly showed one
            // outline for a three-cell selection — the memos above were plural
            // long before the draw was.
            selection,
            hover,
            decimate,
            orientation,
            noData,
            layerSpans,
          ),
      },
      axisId: axis,
      index,
    }),
    [
      ss,
      G,
      style,
      colorOf,
      decimate,
      orientation,
      noData,
      vertical,
      semantic,
      series,
      id,
      axis,
      index,
      selection,
      hover,
      layerSpans,
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
