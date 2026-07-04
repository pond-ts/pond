import { useContext, useEffect, useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import { barsFromTimeSeries, barsFromValueSeries } from './data.js';
import {
  barAt,
  barExtent,
  barIndexAtTime,
  drawBars,
  resolveBarBaseline,
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
   * The source series. **Interval / timeRange-keyed** `TimeSeries` is the primary
   * form — each event's key `[begin, end]` is a bar's x-span. A **point-keyed**
   * (`time`) series is supported too: each bar's width is derived from neighbour
   * spacing (see {@link barsFromTimeSeries}). A **`ValueSeries`**
   * (`series.byValue('dist')`) bars against its value axis — also point-keyed, so
   * the same neighbour-spacing span applies (see {@link barsFromValueSeries}); the
   * container infers the x-kind from the data, no axis-type prop (mirrors the
   * other layers).
   */
  series: TimeSeries<S> | ValueSeries<VS>;
  /** Name of the numeric value column for the bar height. */
  column: string;
  /**
   * The series' semantic identifier — what the data _is_ / how it should read.
   * The theme maps it to a {@link BarStyle} (`theme.bar[as] ?? theme.bar.default`).
   * **Omitted ⇒ the `default` style** — `column` is the data, `as` is the
   * identity, and there's no per-component colour override (the single styling
   * channel; restyle via the theme).
   */
  as?: string;
  /**
   * Which `<YAxis>` (by its `id`) this bar scales against — picks the *scale*,
   * where `as` picks the *style* (separate concerns). **Omitted ⇒ the row's
   * default axis.**
   */
  axis?: string;
  /**
   * Pixel gap between adjacent bars — each bar's key span is inset by this total
   * (half each side), so neighbours breathe. **Omitted ⇒ the theme's
   * `bar[as].gap`.** A span the gap would invert collapses to the style's
   * `minWidth`, so a too-thin bucket stays visible.
   */
  gap?: number;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/**
 * A bar draw layer: one rectangle per event, spanning the key's `[begin, end]`
 * (inset by `gap`) from the axis baseline to a numeric `column`'s value. Reads
 * the key endpoints + column into a {@link BarSeries}, registers into the
 * enclosing {@link Layers} (scaling against its `axis`), and renders nothing to
 * the DOM — the row draws it. A gap (missing value) is skipped (no bar).
 *
 * **Baseline.** Bars rest on the zero line when the axis domain spans zero (the
 * common all-positive auto-fit case — {@link barExtent} pulls `0` into the
 * domain), or on the axis floor when an explicit `<YAxis min={…}>` sits above
 * zero (see {@link resolveBarBaseline}).
 *
 * **Interaction.** Hover joins the tracker (`sampleAt` → the value of the bar
 * **under the cursor**) and lights that bar (hover-highlight). Click selects the
 * hit bar (`hitTest`); the matching bar — same key **and** this series' `label`,
 * so two series sharing a timestamp don't both light up — draws highlighted
 * (outlined for the committed select, fill-only for the transient hover). Both
 * resolve by **containment**: the tracker by the bar's `[begin, end]` time span
 * (`barIndexAtTime`), the click by the bar's pixel rect (`barAt`) — so the
 * readout reads the same bar you click, even across a wide bucket (they differ
 * only by the `gap` inset, where the pixel rect is narrower than the span).
 *
 * Both channels are also **controllable from outside** the chart via the
 * container: `selected`/`onSelect` (committed) and `hovered`/`onHover` (transient)
 * — pass either to pin the lit/selected bar from a legend or list row, and read
 * the callback to mirror a bar-originated hover/click out-of-band. Symmetric pair,
 * keyed by the same {@link SelectInfo} identity.
 *
 * **Value axis** — bars also scale on a value axis when fed a `ValueSeries`
 * (`series.byValue('dist')`): estela's distance-domain splits/laps, one bar per
 * segment over a monotonic axis. A `ValueSeries` is point-keyed, so the span is
 * neighbour-derived like a point `TimeSeries` (see {@link barsFromValueSeries}).
 *
 * ```tsx
 * <Layers>
 *   <BarChart series={hourlyVolume} column="count" />
 * </Layers>
 * ```
 */
export function BarChart<
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>({
  series,
  column,
  as: semantic,
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

  const bs = useMemo(
    () =>
      series instanceof ValueSeries
        ? barsFromValueSeries(series, column)
        : barsFromTimeSeries(series, column),
    [series, column],
  );
  // Styling: semantic identifier → theme bar style. The single styling channel.
  const { bar } = container.theme;
  const style =
    (semantic !== undefined ? bar[semantic] : undefined) ?? bar.default;
  // Series identity for the readout + selection match (the `as` role, else the
  // column name).
  const label = semantic ?? column;
  // The gap prop overrides the theme default; otherwise the style carries it.
  const gapPx = gap ?? style.gap;
  // The current selection, narrowed to what the highlight match needs (key +
  // label). Read here so a selection change re-registers the layer (in the deps)
  // → the data canvas repaints with the highlight. Infrequent (a click).
  const selected = container.selected;
  const selection = useMemo(
    () =>
      selected === null ? null : { key: selected.key, label: selected.label },
    [selected],
  );
  // The transient hover-highlight, narrowed to the match key (key + label) like
  // the selection. Read here so a hover change re-registers the layer → the data
  // canvas repaints with the lit bar. Deduped in the container, so this only
  // fires on a bar transition (not every pointer move).
  const hoveredMark = container.hovered;
  const hover = useMemo(
    () =>
      hoveredMark === null
        ? null
        : { key: hoveredMark.key, label: hoveredMark.label },
    [hoveredMark],
  );

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => barExtent(bs),
        // The container infers the shared x scale's kind from its layers — a
        // ValueSeries bars on a value axis, a TimeSeries on time.
        xKind: series instanceof ValueSeries ? 'value' : 'time',
        xExtent: () =>
          bs.length === 0 ? null : [bs.begin[0]!, bs.end[bs.length - 1]!],
        sampleAt: (time) => {
          // The flag belongs to the bar **under the cursor** — the bar whose
          // span `[begin, end]` contains `time` (barIndexAtTime), NOT
          // nearest-by-begin (which flips to the next bar past a wide bar's
          // midpoint, landing the flag on the wrong bar). For a point key the
          // span is the neighbour-derived Voronoi cell (`barsFromTimeSeries`
          // widens `begin === end` into one), so the cells tile the axis and a
          // moving cursor always lands in one. Before the first / after the last
          // bar → no readout, matching the line/area tracker.
          if (bs.length === 0) return [];
          const i = barIndexAtTime(bs, time);
          if (i < 0) return [];
          const v = bs.y[i]!;
          if (!Number.isFinite(v)) return []; // a gap bar (missing value) reads nothing
          // Anchor at the bar's **top-centre** (RFC): the span's centre time
          // `(begin + end) / 2` (the bucket mid for an interval key; the Voronoi
          // cell centre — ~on the point — for a point key), at `yScale(value)` =
          // the bar top. A tall bar (top above the flag stack) drops the staff for
          // free (the shared `s.py > stackBottom` rule).
          return [
            {
              x: (bs.begin[i]! + bs.end[i]!) / 2,
              value: v,
              color: style.fill,
              label,
            },
          ];
        },
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
            style.minWidth,
          );
          if (hit === null) return null;
          const [, begin, value] = hit;
          // key = the bar's begin (its stable identity); colour = the resolved
          // fill; label = this series' identity (so the highlight targets the
          // exact clicked series, not another sharing the timestamp).
          return { key: begin, value, color: style.fill, label };
        },
        draw: (ctx, xScale, yScale) =>
          drawBars(
            ctx,
            bs,
            xScale,
            yScale,
            style,
            resolveBarBaseline(yScale),
            gapPx,
            label,
            selection,
            hover,
          ),
      },
      axisId: axis,
      index,
    }),
    [bs, series, column, style, label, gapPx, selection, hover, axis, index],
  );
  // A stable per-instance slot (see useSlotKey) keeps this layer's z-position
  // fixed across series/style/selection updates (no jump to the front).
  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  // Also a tracker source: the container fans in this series' value at the
  // cursor for the (outside-the-chart) readout.
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
