import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { barsFromTimeSeries } from './data.js';
import { barAt, barExtent, drawBars, resolveBarBaseline } from './bars.js';
import {
  ContainerContext,
  LayersContext,
  type LayerEntry,
  type SelectInfo,
} from './context.js';
import { useSlotKey } from './use-slot-key.js';

export interface BarChartProps<S extends SeriesSchema> {
  /**
   * The source series. **Interval / timeRange-keyed** is the primary form — each
   * event's key `[begin, end]` is a bar's x-span. A **point-keyed** (`time`)
   * series is supported too: each bar's width is derived from neighbour spacing
   * (see {@link barsFromTimeSeries}).
   */
  series: TimeSeries<S>;
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
 * **Interaction.** Hover joins the tracker (`sampleAt` → the bar's value at the
 * cursor). Click selects the hit bar (`hitTest`), and the matching bar — same
 * key **and** this series' `label` — draws highlighted, so two series sharing a
 * timestamp don't both light up. Hover and select resolve differently: select is
 * **rect-containment** over the bar's `[begin, end]` span, while the tracker
 * readout is **nearest-by-`begin`** — so near a *wide* bucket's edge a click can
 * select bar *i* while the readout reads *i±1*. Both are correct (matching the
 * line/area hover policy); they only diverge on wide buckets.
 *
 * **Distance domain is deferred** — v1 bars scale on the shared **time** xScale
 * only. estela's distance-domain (records over a monotonic value axis) needs
 * value-axis support that isn't built yet (charts RFC perf section).
 *
 * ```tsx
 * <Layers>
 *   <BarChart series={hourlyVolume} column="count" />
 * </Layers>
 * ```
 */
export function BarChart<S extends SeriesSchema>({
  series,
  column,
  as: semantic,
  axis,
  gap,
  index = 0,
}: BarChartProps<S>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<BarChart> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<BarChart> must be rendered inside a <Layers>');
  }

  const bs = useMemo(
    () => barsFromTimeSeries(series, column),
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

  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => barExtent(bs),
        sampleAt: (time) => {
          // No readout past the data (tracker policy — core's nearest() clamps
          // to an endpoint outside the span). A bar spans [begin, end], so the
          // window runs from the first bar's begin to the last bar's end (its
          // right edge), not begin[n-1] — otherwise hovering the tail of the
          // last bar would read nothing.
          if (
            bs.length === 0 ||
            time < bs.begin[0]! ||
            time > bs.end[bs.length - 1]!
          ) {
            return [];
          }
          const e = series.nearest(time);
          if (e === undefined) return [];
          // get() wants a literal key; column is a runtime string. Cast the
          // *event* (not the method — that would detach `this`) to a
          // string-keyed get; runtime-safe read + guard.
          const v = (e as unknown as { get(field: string): unknown }).get(
            column,
          );
          // The dot rides the bar's value, keyed at the bar's begin (its left
          // edge — where the bar's x-span starts), coloured by the fill.
          return typeof v === 'number' && Number.isFinite(v)
            ? [{ x: e.begin(), value: v, color: style.fill, label }]
            : [];
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
          ),
      },
      axisId: axis,
      index,
    }),
    [bs, series, column, style, label, gapPx, selection, axis, index],
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
