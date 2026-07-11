import { useContext, useEffect, useMemo } from 'react';
import { Interval, ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import {
  barsFromTimeSeries,
  barsFromValueSeries,
  categoryStack,
  stacksFromBins,
  stacksFromColumns,
  stacksFromGroups,
  type BinRecord,
  type CategoryDatum,
  type StackedBarSeries,
} from './data.js';
import {
  barAt,
  barExtent,
  barIndexAtTime,
  drawBars,
  drawStacks,
  resolveBarBaseline,
  stackAt,
  stackBinExtent,
  stackValueExtent,
  type Orientation,
  type StackMark,
  type StackStyle,
} from './bars.js';
import {
  ContainerContext,
  LayersContext,
  type LayerEntry,
  type SelectInfo,
} from './context.js';
import { useSlotKey } from './use-slot-key.js';

export interface BarChartProps<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> {
  /**
   * The source series. Provide **exactly one** of `series` or `bins`.
   *
   * - A **`TimeSeries`** (interval / timeRange-keyed is the primary form — each
   *   event's key `[begin, end]` is a bar's x-span; a point-keyed series derives
   *   its width from neighbour spacing) → single-series bars via `column`, or
   *   stacked bars from a **wide** series via `columns`.
   * - A **`ValueSeries`** (`series.byValue('dist')`) bars against its value axis.
   * - A **`ReadonlyMap<group, TimeSeries>`** — one series per stack group, all on
   *   the same bin grid, the shape
   *   `series.partitionBy('host', { groups }).aggregate(seq, m).toMap()` returns.
   *   Stacked bars, `column` names the shared value column, groups = map order.
   *
   * **Live charts:** `series.byValue(…)` / `.toMap()` mint fresh objects each
   * call, so an inline `series={…}` re-registers this layer every render — on a
   * frequently re-rendering chart, memoize the projection (`useMemo`).
   */
  series?: TimeSeries<S> | ValueSeries<VS> | ReadonlyMap<string, TimeSeries<S>>;
  /**
   * `byColumn` **bin records** — `Array<{ start, end, …aggregates }>` from a
   * value-band aggregation
   * (`series.byColumn('power', { width: 20 }, { seconds: … })`). The value-axis
   * alternative to `series`: `column` / `columns` name the aggregate field(s) to
   * draw. Pair with `ordinal` for a category (band) axis.
   */
  bins?: readonly BinRecord[];
  /**
   * **Categorical** data — an ordered `{ label, value }[]`, one bar per category
   * on a first-class **ordinal category x-axis** (the container infers
   * `xKind:'category'` and builds a band scale over the labels). The transpose
   * view's "columns on x": each `label` is a category (ticker / account / zone),
   * `value` its bar height. Provide **exactly one** of `series` / `bins` /
   * `categories`; `categories` takes no `column`/`columns` and is **vertical only**
   * (categories on x). Colour per category via `binColors`. (Categorical-axis RFC,
   * Phase 1.)
   */
  categories?: readonly CategoryDatum[];
  /** Name of the numeric value column for the bar height (single series). Provide
   *  `column` **or** `columns`, not both. */
  column?: string;
  /**
   * Stacked-segment columns, **bottom → top** — one segment per name. Use with a
   * **wide** `series` (e.g. `pivotByGroup` output) or with `bins`. Mutually
   * exclusive with `column`, and invalid with a `Map` series (there the segments
   * are the map's groups; use `column`).
   */
  columns?: readonly string[];
  /**
   * The single series' semantic identifier — what the data _is_. The theme maps
   * it to a {@link BarStyle} (`theme.bar[as] ?? theme.bar.default`). **Single
   * series only** — **ignored** (not an error) on a stacked chart, which colours
   * its segments per group instead (see `colors`).
   */
  as?: string;
  /**
   * Per-group colour override for a **stacked** chart — `{ group: cssColor }`.
   * A segment resolves `colors[group] ?? theme.bar[group]?.fill ??
   * theme.bar.default.fill`, so named roles (e.g. a `crit` band styled in the
   * theme) come from the theme while ad-hoc groups (five hosts) take a colour
   * here without minting a theme role. The single styling channel still holds:
   * this is the stack's one colour input.
   */
  colors?: Readonly<Record<string, string>>;
  /**
   * **Per-bin** colours for a single-series band chart — `binColors[i]` fills
   * bar `i` (aligned to the bins / bands in order), overriding the `as`/theme
   * fill. This is the way to colour heart-rate / power **zones** or value bands
   * each their own colour (the `colors` map above is per-**group**, for stacks).
   * An `undefined`/short entry falls back to the theme fill. Meant for a
   * single-series chart (`column` + `bins`, or a horizontal single series); on a
   * multi-group stack it would tint every segment of a bin alike, so it's not
   * the tool there.
   */
  binColors?: readonly (string | undefined)[];
  /**
   * Bar growth direction (the histogram orientation). **Default `'vertical'`.**
   *
   * - `'vertical'` — bars grow **up** from a value baseline, bins on the **x**
   *   axis (time buckets, value bands). The column / time-histogram look.
   * - `'horizontal'` — bars grow **right**, bins on the **y** axis (a band axis
   *   like heart-rate zones). Label the bands with `<YAxis ticks={[{ at, label }]}>`.
   *
   * A `'horizontal'` chart puts the **value** on the shared x axis, so its
   * container's x-kind is `'value'` — it cannot share a `<ChartContainer>` with
   * time-series rows (each horizontal histogram stands alone). Vertical charts
   * have no such constraint. The in-chart `flag` / `crosshair` value cursor is
   * drawn for the **single-series vertical** case only; stacked and horizontal
   * charts read out via hover / click (`onHover` / `onSelect`).
   */
  orientation?: Orientation;
  /**
   * For `bins`: lay the bands out as uniform **unit slots** (`[i, i+1]`) instead
   * of their numeric `[start, end]` edges — an ordinal band axis where every band
   * reads the same width (heart-rate zones). Ignored for `series`.
   */
  ordinal?: boolean;
  /**
   * The **stable series identity** for selection + hover — and it **gates
   * interactivity** (a bar layer is selectable/hoverable only when given an
   * `id`). For a stack, a clicked / hovered **segment** is identified by
   * `(id, key = bin begin, label = group)`, so two segments in one bin don't both
   * light up.
   */
  id?: string;
  /**
   * Which `<YAxis>` (by its `id`) this layer scales against — the *scale* (`as`
   * picks the *style*). **Omitted ⇒ the row's default axis.** For a horizontal
   * histogram this is the **bin (band) axis**; for a vertical one the **value**
   * axis.
   */
  axis?: string;
  /**
   * Pixel gap between adjacent bars / bins — the bar's key span is inset by this
   * total (half each side). **Omitted ⇒ the theme's `bar` `gap`.** A span the gap
   * would invert collapses to the style's `minWidth`.
   */
  gap?: number;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/** Discriminated build result: a single-series bar view or a stacked one. */
type BarShape =
  | {
      readonly kind: 'single';
      readonly bs: ReturnType<typeof barsFromTimeSeries>;
    }
  | { readonly kind: 'stacked'; readonly ss: StackedBarSeries };

/**
 * A bar / histogram draw layer. In its simplest form, one rectangle per event
 * spanning the key's `[begin, end]` from the axis baseline to a numeric
 * `column`'s value (see below). It also draws **stacked** bars (a group-by
 * dimension → segments, `columns` / a `Map` series / `bins`) and **horizontal**
 * bars (`orientation='horizontal'`, bins on the y axis) — first-class histogram
 * support. Registers into the enclosing {@link Layers} and renders nothing to the
 * DOM; the row draws it.
 *
 * **Data sources.** A time / value `TimeSeries` or `ValueSeries` (`column`), a
 * wide series or `bins` array (`columns`), or a `Map<group, TimeSeries>`
 * (`column`) — the last three stack. Every shape composes from pond's own
 * aggregation (`aggregate` / `byColumn` / `partitionBy`); the histogram guide
 * has the recipes.
 *
 * **Baseline (single, vertical).** Bars rest on the zero line when the axis
 * domain spans zero, or on the axis floor when an explicit `<YAxis min>` sits
 * above zero (see {@link resolveBarBaseline}).
 *
 * **Baseline (stacked).** A stack is **cumulative from value 0** — the segments
 * sum upward from the zero line, so its value axis **must include 0**. The
 * auto-fit guarantees this: {@link stackValueExtent} always returns `[0, maxTotal]`.
 * An explicit `<YAxis min>` **above** 0 is therefore unsupported for a stack — it
 * would hide the bottom of the cumulative column; only the portion above the floor
 * draws (clipped cleanly at the plot floor, as any bar below an explicit floor is).
 * Segment values are assumed **non-negative** (a negative or zero segment is
 * skipped — diverging stacks are out of scope).
 *
 * **Interaction (opt-in via `id`).** Hover lights the bar / segment under the
 * cursor (hit-tested by pixel rect, so it works in both orientations); click
 * selects it (outlined). A stacked segment's identity is `(id, key = bin begin,
 * label = group)`. Both channels are controllable from outside via the container
 * (`selected`/`onSelect`, `hovered`/`onHover`). The in-chart `flag`/`crosshair`
 * value cursor is single-series-vertical only.
 *
 * ```tsx
 * <Layers>
 *   <BarChart series={hourlyVolume} column="count" />
 *   <BarChart series={byHost} column="n" colors={{ web1: '#…' }} />
 *   <BarChart bins={powerDist} column="seconds" orientation="horizontal" ordinal />
 * </Layers>
 * ```
 */
export function BarChart<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>({
  series,
  bins,
  categories,
  column,
  columns,
  as: semantic,
  colors,
  binColors,
  orientation = 'vertical',
  ordinal = false,
  id,
  axis,
  gap,
  index = 0,
}: BarChartProps<S, VS>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<BarChart> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<BarChart> must be rendered inside a <Layers>');
  }

  // Validate the data-source / value-column combination up front (throws are
  // stable across renders, so no need to memoize them).
  const nSources =
    (series !== undefined ? 1 : 0) +
    (bins !== undefined ? 1 : 0) +
    (categories !== undefined ? 1 : 0);
  if (nSources !== 1) {
    throw new Error(
      '<BarChart> needs exactly one of `series`, `bins`, or `categories`',
    );
  }
  if (categories !== undefined) {
    if (column !== undefined || columns !== undefined) {
      throw new Error(
        '<BarChart categories> takes no `column`/`columns` (each datum carries its own value)',
      );
    }
    if (orientation === 'horizontal') {
      throw new Error(
        '<BarChart categories> is vertical only (categories on x); horizontal category axes are not yet supported',
      );
    }
  }
  const isMap = series instanceof Map;
  if (isMap && columns !== undefined) {
    throw new Error(
      '<BarChart> with a `Map` series stacks its groups — use `column` (the shared value column), not `columns`',
    );
  }
  if (column !== undefined && columns !== undefined) {
    throw new Error('<BarChart> takes `column` or `columns`, not both');
  }

  // The single series' semantic label (its identity for the readout + selection):
  // the `as` role, else the value column. Used only on the single path.
  const label = semantic ?? column ?? id ?? 'value';

  // Build the chart-ready data view. Single-series *vertical* stays on the
  // original BarSeries path (its pixels are unchanged); everything else — any
  // stack, any horizontal — builds a StackedBarSeries (G === 1 for a single
  // horizontal bar) so one oriented draw path covers it.
  const shape = useMemo<BarShape>(() => {
    if (categories !== undefined) {
      // Categorical row-read: one unit-slot bar per category (G === 1), drawn on
      // the container's band scale. The reused stacked geometry — only the axis
      // (band scale + labels) is new.
      return { kind: 'stacked', ss: categoryStack(categories) };
    }
    if (bins !== undefined) {
      const cols = columns ?? (column !== undefined ? [column] : undefined);
      if (cols === undefined) {
        throw new Error('<BarChart bins> needs `column` or `columns`');
      }
      return { kind: 'stacked', ss: stacksFromBins(bins, cols, { ordinal }) };
    }
    if (isMap) {
      if (column === undefined) {
        throw new Error('<BarChart> with a `Map` series needs `column`');
      }
      return {
        kind: 'stacked',
        ss: stacksFromGroups(
          series as ReadonlyMap<string, TimeSeries<S>>,
          column,
        ),
      };
    }
    const s = series as TimeSeries<S> | ValueSeries<VS>;
    if (columns !== undefined) {
      return { kind: 'stacked', ss: stacksFromColumns(s, columns) };
    }
    if (column === undefined) {
      throw new Error('<BarChart> needs `column` or `columns`');
    }
    if (orientation === 'horizontal') {
      // Single horizontal bar: route through the stacked path (G === 1), naming
      // the one group with the series' label so selection matches on it.
      const ss = stacksFromColumns(s, [column]);
      return { kind: 'stacked', ss: { ...ss, groups: [label] } };
    }
    return {
      kind: 'single',
      bs:
        s instanceof ValueSeries
          ? barsFromValueSeries(s, column)
          : barsFromTimeSeries(s, column),
    };
  }, [
    series,
    bins,
    categories,
    column,
    columns,
    ordinal,
    orientation,
    isMap,
    label,
  ]);

  // The category labels — the ordinal axis's ordered column set (`xCategories`),
  // and the per-bar readout label. `null` unless this is a categorical chart.
  const categoryLabels = useMemo<readonly string[] | null>(
    () => categories?.map((c) => c.label) ?? null,
    [categories],
  );

  // The bin axis kind — `'category'` for a categorical chart, else `'time'`/`'value'`
  // (a `TimeSeries`/`Map` bins on time, a `ValueSeries`/`bins`-array on a value
  // axis). For a vertical chart this is the shared x-kind; a horizontal one puts
  // the *value* on x (always 'value') and the bin axis on a linear y.
  const binAxisKind: 'time' | 'value' | 'category' =
    categories !== undefined
      ? 'category'
      : bins !== undefined
        ? 'value'
        : isMap
          ? 'time'
          : series instanceof ValueSeries
            ? 'value'
            : 'time';

  // The bars' `[begin, end)` spans as pond `Interval`s — the region cursor's snap
  // buckets (a region drag snaps bar by bar; a hover highlights the bar under the
  // pointer). Published only for a **vertical** bar layer on a **continuous**
  // (time / value) x axis: a horizontal chart puts the value/count on x (snapping
  // it is meaningless) and a categorical (ordinal-slot) axis is out of the region
  // cursor's scope. Memoized off the shape alone, so a hover / selection change
  // (which rebuilds the layer entry) doesn't re-allocate the intervals.
  const binBuckets = useMemo<readonly Interval[] | null>(() => {
    if (orientation !== 'vertical' || binAxisKind === 'category') return null;
    const { begin, end, length } =
      shape.kind === 'single' ? shape.bs : shape.ss;
    if (length === 0) return null;
    const out = new Array<Interval>(length);
    for (let i = 0; i < length; i += 1) {
      const b = begin[i]!;
      out[i] = new Interval({ value: b, start: b, end: end[i]! });
    }
    return out;
  }, [shape, orientation, binAxisKind]);

  const { bar } = container.theme;
  // Single-series style: the `as` role → theme bar style (the single channel).
  const singleStyle =
    (semantic !== undefined ? bar[semantic] : undefined) ?? bar.default;
  const gapPx = gap ?? bar.default.gap;
  // The stacked path's bar-thickness floor comes from `bar.default` (not the `as`
  // role — `as` is single-series only), matching how `gapPx` sources its default.
  const stackMinWidth = bar.default.minWidth;

  // Stacked style: per-group fills (colors override → theme role → default),
  // plus the shared opacity / outline from the default bar style. Memoized on the
  // groups + colours so a selection change doesn't rebuild it.
  const groups = shape.kind === 'stacked' ? shape.ss.groups : undefined;
  const stackStyle = useMemo<StackStyle>(() => {
    const base = bar.default;
    const fills = (groups ?? []).map(
      (g) => colors?.[g] ?? (bar[g] ?? base).fill,
    );
    return {
      fills,
      opacity: base.opacity,
      outlineWidth: base.outlineWidth,
      ...(binColors !== undefined ? { binFills: binColors } : {}),
    };
  }, [bar, groups, colors, binColors]);

  // The current selection / hover, narrowed to the identity the highlight match
  // needs. For a stack that's (id, key, label = group); the single path uses just
  // (id, key). Read here so a change re-registers the layer → the canvas repaints.
  const selected = container.selected;
  const hoveredMark = container.hovered;
  const selection = useMemo<StackMark | null>(
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
  const hover = useMemo<StackMark | null>(
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

  const entry = useMemo<LayerEntry>(() => {
    // ── Single-series, vertical: the original bar path, pixels unchanged. ──
    if (shape.kind === 'single') {
      const bs = shape.bs;
      return {
        layer: {
          yExtent: () => barExtent(bs),
          xKind: binAxisKind,
          xExtent: () =>
            bs.length === 0 ? null : [bs.begin[0]!, bs.end[bs.length - 1]!],
          ...(binBuckets !== null ? { binIntervals: () => binBuckets } : {}),
          sampleAt: (time) => {
            if (bs.length === 0) return [];
            const i = barIndexAtTime(bs, time);
            if (i < 0) return [];
            const v = bs.y[i]!;
            if (!Number.isFinite(v)) return [];
            return [
              {
                x: (bs.begin[i]! + bs.end[i]!) / 2,
                value: v,
                color: singleStyle.fill,
                label,
              },
            ];
          },
          ...(id === undefined
            ? {}
            : {
                hitTest: (px, py, xScale, yScale): SelectInfo | null => {
                  const baseline = resolveBarBaseline(yScale);
                  const hit = barAt(
                    bs,
                    px,
                    py,
                    xScale,
                    yScale,
                    baseline,
                    gapPx,
                    singleStyle.minWidth,
                  );
                  if (hit === null) return null;
                  const [, begin, value] = hit;
                  return {
                    id,
                    key: begin,
                    value,
                    color: singleStyle.fill,
                    label,
                  };
                },
              }),
          draw: (ctx, xScale, yScale) =>
            drawBars(
              ctx,
              bs,
              xScale,
              yScale,
              singleStyle,
              resolveBarBaseline(yScale),
              gapPx,
              id,
              selection,
              hover,
            ),
        },
        axisId: axis,
        index,
      };
    }

    // ── Stacked (or single horizontal): the oriented, transposed draw path. ──
    const ss = shape.ss;
    const binExtent = () => stackBinExtent(ss);
    const valueExtent = () => stackValueExtent(ss);
    const vertical = orientation === 'vertical';
    return {
      layer: {
        // Horizontal puts the value on the shared x (always 'value'); vertical
        // keeps the bin axis on x. The bin axis on the *other* side is a linear
        // numeric scale either way (time ms label via <YAxis ticks>).
        xKind: vertical ? binAxisKind : 'value',
        xExtent: vertical ? binExtent : valueExtent,
        yExtent: vertical ? valueExtent : binExtent,
        ...(binBuckets !== null ? { binIntervals: () => binBuckets } : {}),
        // A categorical chart hands the container its ordered category names — the
        // ordinal axis domain the shared band scale + label formatter build on.
        ...(categoryLabels !== null
          ? { xCategories: () => categoryLabels }
          : {}),
        // No x-scrub flag for a stack / horizontal chart — hover + click read it
        // out instead (the flag is single-series-vertical only).
        sampleAt: () => [],
        ...(id === undefined
          ? {}
          : {
              hitTest: (px, py, xScale, yScale): SelectInfo | null => {
                const hit = stackAt(
                  ss,
                  px,
                  py,
                  orientation,
                  xScale,
                  yScale,
                  gapPx,
                  stackMinWidth,
                );
                if (hit === null) return null;
                const [bi, g, begin, name, value] = hit;
                // A categorical bar carries a stable per-bar `mark` (its column
                // name); the selection keys on `(id, mark)` so it survives a
                // reorder. `bi` is the exact bin index from the hit.
                const stableMark = ss.marks?.[bi];
                return {
                  id,
                  key: begin,
                  value,
                  // A per-bin colour override wins over the group fill, so the
                  // readout pill reads the bar's own colour.
                  color: stackStyle.binFills?.[bi] ?? stackStyle.fills[g]!,
                  // A categorical bar reports its category name; a stack reports
                  // the group.
                  label: stableMark ?? name,
                  ...(stableMark !== undefined ? { mark: stableMark } : {}),
                };
              },
            }),
        draw: (ctx, xScale, yScale) =>
          drawStacks(
            ctx,
            ss,
            orientation,
            xScale,
            yScale,
            stackStyle,
            gapPx,
            stackMinWidth,
            id,
            selection,
            hover,
          ),
      },
      axisId: axis,
      index,
    };
  }, [
    shape,
    binAxisKind,
    binBuckets,
    categoryLabels,
    orientation,
    singleStyle,
    stackStyle,
    label,
    id,
    gapPx,
    stackMinWidth,
    selection,
    hover,
    axis,
    index,
  ]);

  // A stable per-instance slot keeps this layer's z-position fixed across data /
  // style / selection updates (see useSlotKey).
  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  // Also a tracker source: the container fans in this layer's value at the cursor
  // for the (outside-the-chart) readout. A stacked / horizontal layer's sampleAt
  // returns nothing, so it contributes no flag but still registers cleanly.
  const { registerTrackerSource, unregisterTrackerSource } = container;
  useEffect(
    () => () => unregisterTrackerSource(slot),
    [unregisterTrackerSource, slot],
  );
  useEffect(() => {
    registerTrackerSource(slot, entry.layer);
  }, [registerTrackerSource, slot, entry.layer]);

  // Advertise selectability (only when an `id` was given).
  const { registerSelectable, unregisterSelectable } = container;
  useEffect(() => {
    if (id === undefined) return;
    registerSelectable(slot);
    return () => unregisterSelectable(slot);
  }, [registerSelectable, unregisterSelectable, slot, id]);

  return null;
}
