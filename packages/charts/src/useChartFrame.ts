/**
 * `useChartFrame()` — **the resolved plot geometry, published**.
 *
 * A consumer whose chrome has to line up with the plot (a per-slot header
 * table above it, a column summary strip below it, a card pinned over one
 * band, a colour ramp keyed to the plot's own scale) needs the numbers the
 * container already resolved: where the plot starts, how wide it is, and the
 * scales that map data to pixels inside it. Before this hook none of that was
 * reachable, so consumers re-derived it — pin every axis gutter to a fixed
 * width so it stops depending on label content, measure the outer box,
 * subtract, and re-implement the band packing.
 *
 * **That duplicate is not merely verbose, it is wrong over time.** It holds
 * only until the library changes how a gutter is sized or how bands are
 * packed, at which point the consumer's chrome slides out of alignment with
 * the plot it labels — with no type error and no failing test. Reading the
 * frame converts a silent drift hazard into a version-checked API.
 *
 * ## The x / y split is the library's own
 *
 * The shape mirrors the architecture rather than flattening it: **the
 * container owns x** (one shared scale, so every row's plot left-aligns under
 * one time axis) and **rows own y** (row-local data, one scale per axis id).
 * So {@link ChartFrame.plot} carries x only, and y lives on
 * {@link ChartFrame.row} — which is `null` when the hook is called outside a
 * `<ChartRow>`.
 *
 * That `null` is the point. The common case (a header strip above the plot,
 * a sibling of the rows) genuinely has no y geometry, and the alternative —
 * reporting `height: 0` — is the same silent-misalignment failure this hook
 * exists to remove. A consumer that needs y must be inside a row, and the
 * type says so.
 *
 * ## Scope follows placement
 *
 * Exactly as {@link useChartLegend} does: at the container level you get the
 * shared x frame and `row: null`; inside a `<ChartRow>` you additionally get
 * that row's y scales. No prop selects the scope — placement does.
 *
 * ## Pixel origins
 *
 * Two different boxes, because the DOM has two:
 *
 * - `plot.x` / `plot.width` are relative to the **container's** box, so a
 *   `<div>` sibling of the rows pads by `plot.x` to align.
 * - `xScale(v)` and `bands.at(i)` are relative to the **plot**, i.e. `0 …
 *   plot.width` — the coordinate system the canvas draws in. Add `plot.x` to
 *   place DOM chrome in container space.
 * - `row.topInset` / `row.height` are relative to the **row's** box.
 *
 * @example Align a per-slot header strip above a categorical plot
 * ```tsx
 * function SlotHeader() {
 *   const { plot, bands } = useChartFrame();
 *   if (bands === null) return null;
 *   return (
 *     <div style={{ position: 'relative', height: 22, marginLeft: plot.x, width: plot.width }}>
 *       {bands.labels.map((label, i) => {
 *         const b = bands.at(i)!;
 *         return (
 *           <div key={label} style={{ position: 'absolute', left: b.x0, width: b.x1 - b.x0 }}>
 *             {label}
 *           </div>
 *         );
 *       })}
 *     </div>
 *   );
 * }
 *
 * <ChartContainer categories={tickers} width="auto">
 *   <SlotHeader />
 *   <ChartRow height={200}>…</ChartRow>
 * </ChartContainer>
 * ```
 *
 * @packageDocumentation
 */
import { useContext, useMemo } from 'react';
import {
  ContainerContext,
  RowContext,
  type ChartXScale,
  type YScale,
} from './context.js';
import type { ScaleBand } from './bandScale.js';

/**
 * One ordinal slot on a category axis — its pixel span within the plot, its
 * centre (where a mark is drawn and a tick is labelled), and its name.
 *
 * `x0`/`x1`/`center` are **plot-relative** (`0 … plot.width`); add
 * {@link ChartFrame.plot}`.x` for container-relative DOM placement.
 */
export interface ChartBand {
  /** The slot's left edge in px. */
  readonly x0: number;
  /** The slot's right edge in px. `x1 - x0` is {@link ChartBands.pitch}. */
  readonly x1: number;
  /** The slot's centre in px — where a bar centres and a tick labels. */
  readonly center: number;
  /** The category name at this slot. */
  readonly label: string;
}

/**
 * The ordinal slot geometry of a `'category'` x axis — `null` on a `'time'`
 * or `'value'` axis, which has no slots.
 *
 * **The pitch is not `plot.width / count`.** `<ChartContainer maxBandWidth>`
 * caps it and `bandAlign` places the resulting narrower block within the
 * plot, so the packed band run can be inset from both plot edges. Reading
 * `pitch` and `at(i)` rather than recomputing is the difference between
 * chrome that tracks that packing and chrome that ignores it.
 */
export interface ChartBands {
  /** Number of slots — the category count. */
  readonly count: number;
  /** One slot's width in px (the pitch; slots are contiguous and equal). */
  readonly pitch: number;
  /** The ordered category names, index-aligned with the slots. */
  readonly labels: readonly string[];
  /** The slot at `index`, or `null` when `index` is not a real slot. */
  at(index: number): ChartBand | null;
}

/**
 * The **row-scoped** half of the frame: y geometry and the row's value
 * scales. `null` on {@link ChartFrame.row} when the hook is called outside a
 * `<ChartRow>`.
 */
export interface ChartFrameRow {
  /**
   * The plot's top inset within the row's box in px — the band reserved by a
   * `labelPlacement="top"` axis title, `0` when no axis draws one. An overlay
   * that ignores it sits under the title.
   */
  readonly topInset: number;
  /**
   * The plot's drawable height in px, below {@link topInset}. The row's own
   * `height` prop is `topInset + height`, and the y-scales' pixel range is
   * `[topInset + height, topInset]` (inverted — pixels grow downward).
   */
  readonly height: number;
  /**
   * One value→pixel scale per `<YAxis id>`, each mapping into
   * `[topInset + height, topInset]`. A row with no explicit `<YAxis>` has one
   * entry under the implicit default id.
   */
  readonly yScales: ReadonlyMap<string, YScale>;
  /** Which gutter each axis id sits in — so chrome hugs the right edge. */
  readonly axisSides: ReadonlyMap<string, 'left' | 'right'>;
}

/** The resolved geometry of a chart, as published by {@link useChartFrame}. */
export interface ChartFrame {
  /**
   * The plot's **x** geometry in px, relative to the container's own box:
   * `x` is the left gutter (where the plot starts) and `width` is the plot's
   * width after both gutters. Shared by every row.
   */
  readonly plot: { readonly x: number; readonly width: number };
  /**
   * The reserved axis gutters in px — how far the plot is inset on each side.
   * `left` equals {@link plot}`.x`; both are published because chrome above
   * the plot pads by `left` while chrome sized to the container subtracts
   * both.
   */
  readonly gutters: { readonly left: number; readonly right: number };
  /**
   * The shared x→pixel scale, mapping into `[0, plot.width]`. Callable
   * (`value → px`) with `invert` / `ticks` / `tickFormat`, whichever kind the
   * container resolved (see {@link ChartXScale}).
   */
  readonly xScale: ChartXScale;
  /**
   * Which kind of x axis resolved. `'category'` is exactly when
   * {@link bands} is non-null.
   */
  readonly xKind: 'time' | 'value' | 'category';
  /** Ordinal slot geometry on a `'category'` axis; `null` otherwise. */
  readonly bands: ChartBands | null;
  /** Row-scoped y geometry — `null` outside a `<ChartRow>`. */
  readonly row: ChartFrameRow | null;
}

/** Whether the container resolved an ordinal scale (which alone carries `label`). */
function asBandScale(scale: ChartXScale, kind: string): ScaleBand | null {
  return kind === 'category' ? (scale as ScaleBand) : null;
}

/**
 * Read the container's resolved plot geometry — the plot rect, the axis
 * gutters, the shared x scale, the row's y scales, and (on a category axis)
 * the ordinal slot edges. See the module docblock for the x/y split, the
 * placement-scoped `row` half, and which box each pixel value is relative to.
 *
 * Must be called under a `<ChartContainer>`; throws otherwise. To render the
 * markup *outside* the chart's box, portal it out (`createPortal`) — context
 * flows through portals.
 */
export function useChartFrame(): ChartFrame {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('useChartFrame() must be used inside a <ChartContainer>');
  }
  const row = useContext(RowContext);

  const { leftGutter, rightGutter, plotWidth, xScale, xKind } = container;

  const bands = useMemo((): ChartBands | null => {
    const band = asBandScale(xScale, xKind);
    if (band === null) return null;
    // The slot count is the scale's own domain width, not the label count:
    // `scaleBand` is built with `domain([0, n])` from the container's resolved
    // category list, so the domain is the authority on geometry (the labels
    // ride alongside for naming). They agree today; reading the domain means
    // they cannot disagree here if that ever stops being true.
    const [d0, d1] = band.domain();
    const count = Math.max(0, Math.round(d1 - d0));
    const pitch = band.step();
    // Slot `i` is the domain value `d0 + i`; the container always sets
    // `domain([0, n])` so `d0` is 0 today, but every read goes through it so
    // an offset domain could never silently shift the labels off the slots.
    const labels: string[] = [];
    for (let i = 0; i < count; i++) labels.push(band.label(d0 + i + 0.5));
    return {
      count,
      pitch,
      labels,
      at(index: number): ChartBand | null {
        if (!Number.isInteger(index) || index < 0 || index >= count) {
          return null;
        }
        return {
          x0: band(d0 + index),
          x1: band(d0 + index + 1),
          center: band(d0 + index + 0.5),
          label: labels[index] ?? '',
        };
      },
    };
  }, [xScale, xKind]);

  const rowHalf = useMemo((): ChartFrameRow | null => {
    if (row === null) return null;
    return {
      topInset: row.topInset,
      height: Math.max(0, row.height - row.topInset),
      yScales: row.yScales,
      axisSides: row.axisSides,
    };
  }, [row]);

  return useMemo(
    (): ChartFrame => ({
      plot: { x: leftGutter, width: plotWidth },
      gutters: { left: leftGutter, right: rightGutter },
      xScale,
      xKind,
      bands,
      row: rowHalf,
    }),
    [leftGutter, rightGutter, plotWidth, xScale, xKind, bands, rowHalf],
  );
}
