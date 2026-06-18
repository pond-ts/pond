import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { bandFromTimeSeries } from './data.js';
import { bandExtent, drawBand } from './band.js';
import { resolveCurve, type Curve } from './curve.js';
import { ContainerContext, LayersContext, type LayerEntry } from './context.js';
import { useSlotKey } from './use-slot-key.js';

export interface BandChartProps<S extends SeriesSchema> {
  /** The source series. Its key column supplies the time axis. */
  series: TimeSeries<S>;
  /** Name of the numeric column for the band's lower edge (e.g. `p25`). */
  lower: string;
  /** Name of the numeric column for the band's upper edge (e.g. `p75`). */
  upper: string;
  /**
   * The band's semantic identifier — what the spread _is_ (e.g. `outer` for a
   * p5/p95 envelope, `inner` for p25/p75). The theme maps it to a
   * {@link BandStyle} (`theme.band[as] ?? theme.band.default`). **Omitted ⇒ the
   * `default` band style** — no per-component fill/opacity override (restyle via
   * the theme, the single styling channel).
   */
  as?: string;
  /**
   * Which `<YAxis>` (by its `id`) this band scales against — the *scale*, where
   * `as` picks the *style*. **Omitted ⇒ the row's default axis.**
   */
  axis?: string;
  /**
   * Render-time edge interpolation — both edges drawn with this curve. **Omitted
   * ⇒ `'linear'`.** `'basis'`/`'monotone'` smooth a sparse aggregated envelope
   * (RTC's `interpolation`); denoise the underlying values with `smooth()`.
   */
  curve?: Curve;
  /**
   * @internal Declaration position among the `<Layers>` children, injected by
   * `Layers` so z-order follows JSX order. Do not set.
   */
  index?: number;
}

/**
 * A variance-band draw layer: fills the envelope between the `lower` and `upper`
 * columns of `series` (typically `rollingByColumn` percentiles), gap-aware, and
 * registers itself into the enclosing {@link Layers}. Renders nothing to the
 * DOM — the row draws it.
 *
 * Compose two for a two-tone spread — author the wider band first so it sits
 * behind (declaration order = z-order, back-to-front), then the line on top:
 *
 * ```tsx
 * <Layers>
 *   <BandChart series={s} lower="p5"  upper="p95" as="outer" />
 *   <BandChart series={s} lower="p25" upper="p75" as="inner" />
 *   <LineChart series={s} column="p50" />
 * </Layers>
 * ```
 */
export function BandChart<S extends SeriesSchema>({
  series,
  lower,
  upper,
  as: semantic,
  axis,
  curve,
  index = 0,
}: BandChartProps<S>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<BandChart> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<BandChart> must be rendered inside a <Layers>');
  }

  const bs = useMemo(
    () => bandFromTimeSeries(series, lower, upper),
    [series, lower, upper],
  );
  // Styling: semantic identifier → theme band style. The single styling channel.
  const { band } = container.theme;
  const style =
    (semantic !== undefined ? band[semantic] : undefined) ?? band.default;
  const curveFactory = resolveCurve(curve);
  const entry = useMemo<LayerEntry>(
    () => ({
      layer: {
        yExtent: () => bandExtent(bs),
        draw: (ctx, xScale, yScale) =>
          drawBand(ctx, bs, xScale, yScale, style, curveFactory),
      },
      axisId: axis,
      index,
    }),
    [bs, style, curveFactory, axis, index],
  );
  // Stable per-instance slot (see useSlotKey): keeps this band's z-position +
  // identity across prop updates; the injected index drives the sort.
  const slot = useSlotKey();
  useEffect(() => () => layers.unregisterLayer(slot), [layers, slot]);
  useEffect(() => {
    layers.registerLayer(slot, entry);
  }, [layers, slot, entry]);

  return null;
}
