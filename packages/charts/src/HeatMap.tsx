import { useContext, useEffect, useMemo } from 'react';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { barsFromTimeSeries } from './data.js';
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

export interface HeatMapProps<S extends SeriesSchema = SeriesSchema> {
  /**
   * The source series. An **interval / timeRange** key uses its own span per
   * cell; a **point** key tiles by neighbour spacing — so a year-keyed record
   * becomes contiguous year cells with no pre-binning, which is exactly the
   * climate-stripes shape.
   */
  series: TimeSeries<S>;
  /**
   * The numeric column the cell's **colour encodes** — and the value the cursor
   * and a click report. One column, two jobs, which is the point: in the
   * bar-based workaround the colour came from a caller-computed array while the
   * height came from a constant column, so nothing could answer "what number is
   * this cell".
   */
  column: string;
  /**
   * The colour ramp, low → high. The value domain is split into
   * `colors.length` equal bands and a cell takes the colour of its band (see
   * {@link bandedColor} for why banded rather than interpolated).
   */
  colors: readonly string[];
  /**
   * Pin the colour domain as `[lo, hi]`. **Omitted ⇒ the column's own finite
   * extent**, so the ramp always spans the data present.
   *
   * Pin it when several heat maps must be read against each other, or when the
   * visible window is a slice of a longer record and the colours should not
   * re-scale as it moves — an auto-fit domain silently re-meanings every cell
   * when the data changes under it.
   */
  domain?: readonly [number, number];
  /** Semantic identifier — picks the geometry defaults off `theme.bar[as]`.
   *  See the note on styling in the component doc. */
  as?: string;
  /** Which `<YAxis>` (by `id`) this layer scales against. */
  axis?: string;
  /** Px inset between adjacent cells. **Omitted ⇒ `0`** — cells tile flush,
   *  which is the stripes look; bars default to the theme's gap instead. */
  gap?: number;
  /** Stable identity — **gates selection + hover**, as every other layer's does. */
  id?: string;
  /** @internal Declaration position, injected by `Layers`. Do not set. */
  index?: number;
}

/**
 * A **heat-map draw layer**: a row of cells tiling the x axis, each filled by
 * the colour its value maps to ([PND-HEATMAP], prototype).
 *
 * ```tsx
 * <HeatMap series={gistemp} column="anomaly" colors={ramp} id="anomaly" />
 * ```
 *
 * **What it replaces.** The climate-stripes card builds this by hand from a
 * `<BarChart>`: a constant `stripe: 1` column so every bar is full height, and
 * a caller-computed `binColors` array carrying the encoding. Both disappear —
 * and with them the card's biggest limitation, that the number behind a stripe
 * had to be looked up out-of-band because a constant-height bar carries no
 * value. Here the cell *is* the value, so hover and click report it.
 *
 * **Prototype scope, stated plainly.** One row. `yExtent` is the degenerate
 * `[0, 1]` — a single band filling the plot — so this is the stripes case and
 * the "colour a time series" case, not yet the two-dimensional grid
 * [PND-HEATMAP] describes. The second dimension (calendar position, category,
 * value bucket) and the day/month/year granularity toggle are the open design
 * questions; `heat.ts` takes its row band as an explicit `[y0, y1]` so adding
 * rows does not change the geometry's call shape.
 *
 * **Styling.** Colour is data, so it comes from `colors` — not the theme. The
 * geometry and the selected-cell treatment (`opacity`, `highlight`,
 * `outlineWidth`, `minWidth`) are borrowed from `theme.bar[as] ?? theme.bar.default`
 * rather than a new `theme.heat` slot: `ChartTheme`'s slots are required, so
 * adding one is a breaking change for every custom theme, and the M5
 * "theme tokens optional-with-default" gate has to land first. Borrowing keeps
 * the prototype non-breaking and defers that decision honestly instead of
 * pre-empting it.
 */
export function HeatMap<S extends SeriesSchema = SeriesSchema>({
  series,
  column,
  colors,
  domain,
  as: semantic,
  axis,
  gap = 0,
  id,
  index = 0,
}: HeatMapProps<S>) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<HeatMap> must be rendered inside a <ChartContainer>');
  }
  const layers = useContext(LayersContext);
  if (layers === null) {
    throw new Error('<HeatMap> must be rendered inside a <Layers>');
  }

  // Same reader as bars: a one-row heat map is a bar series geometrically, and
  // reusing it means cells and bars tile identically (see heat.ts).
  const cs = useMemo(
    () => barsFromTimeSeries(series, column),
    [series, column],
  );

  const label = semantic ?? column;
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

  // The colour domain: pinned, or the column's own finite extent.
  const [lo, hi] = useMemo(() => {
    if (domain !== undefined) return domain;
    return heatValueExtent(cs) ?? [0, 1];
  }, [domain, cs]);

  const colorAt = useMemo(
    () => (i: number) => bandedColor(cs.y[i]!, colors, lo, hi),
    [cs, colors, lo, hi],
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
        xKind: 'time',
        xExtent: () =>
          cs.length === 0 ? null : [cs.begin[0]!, cs.end[cs.length - 1]!],
        // One row filling the plot. Rows will subdivide this span.
        yExtent: () => [0, 1],
        sampleAt: (time) => {
          // The readout the workaround could not produce: the cell's own value,
          // straight from the data, coloured as it is drawn.
          for (let i = 0; i < cs.length; i += 1) {
            if (time >= cs.begin[i]! && time <= cs.end[i]!) {
              const v = cs.y[i]!;
              if (!Number.isFinite(v)) return [];
              return [
                {
                  x: (cs.begin[i]! + cs.end[i]!) / 2,
                  value: v,
                  color: colorAt(i) ?? style.highlight,
                  label,
                },
              ];
            }
          }
          return [];
        },
        ...(id === undefined
          ? {}
          : {
              hitTest: (px, py, xScale, yScale): SelectInfo | null => {
                const hit = heatAt(
                  cs,
                  px,
                  py,
                  xScale,
                  yScale,
                  style.gap,
                  style.minWidth,
                );
                if (hit === null) return null;
                const [ci, begin, value] = hit;
                const mark = cs.marks?.[ci];
                return {
                  id,
                  key: begin,
                  value,
                  color: colorAt(ci) ?? style.highlight,
                  label,
                  ...(mark !== undefined ? { mark } : {}),
                };
              },
            }),
        draw: (ctx, xScale, yScale) =>
          drawHeat(
            ctx,
            cs,
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
    [cs, style, colorAt, label, semantic, id, axis, index, selection, hover],
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
