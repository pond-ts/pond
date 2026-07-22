import { useContext, useMemo } from 'react';
import {
  ContainerContext,
  CursorContext,
  RowContext,
  type ContainerFrame,
  type CursorFrame,
} from './context.js';
import type { SelectInfo } from './context.js';
import {
  orderLegendItems,
  type LegendItemInput,
  type SwatchSpec,
} from './swatch.js';

/** One legend **item** as {@link useChartLegend} serves it — a series entry:
 *  the registered identity + resolved swatch, plus its live interaction
 *  state. (Items are grouped into {@link LegendRow}s by chart row.) */
export interface LegendItem extends LegendItemInput {
  /** This item's series is the container's current selection (id-keyed). */
  readonly selected: boolean;
  /** This item's series is the container's current hover (id-keyed). */
  readonly hovered: boolean;
}

/** One **chart row's** group of legend {@link LegendItem}s — the grouping
 *  matches the chart's `<ChartRow>` layout, so a legend can mirror the rows
 *  (a flat legend is `rows.flatMap((r) => r.items)`). */
export interface LegendRow {
  /** The chart row these items belong to (its stable per-row key). */
  readonly rowKey: symbol;
  /** The row's items, in display order (declaration → stack position). */
  readonly items: readonly LegendItem[];
}

/** What {@link useChartLegend} returns — the data shape + the sync verbs a
 *  custom-rendered legend needs. */
export interface ChartLegend {
  /** The registered items **grouped by chart row** (top-to-bottom), each
   *  group's items in declaration → stack order, deduped by
   *  `(id ?? label, stack position)`. A flat list is
   *  `rows.flatMap((r) => r.items)`; a row-scoped legend has one entry. */
  readonly rows: readonly LegendRow[];
  /**
   * The container's reserved axis gutters in px — how far the **plot** is
   * inset from the chart box on each side. A custom legend laid out above /
   * below the chart pads by `gutters.left` (and `gutters.right`) to align
   * with the plot instead of the y-axis column.
   */
  readonly gutters: { readonly left: number; readonly right: number };
  /**
   * The **cursor's x position** in axis units — epoch ms on a time axis, the
   * axis value on a value axis (the `TrackerInfo.time` convention) — or
   * `null` when no cursor is live. The values-in-the-legend seam: with a
   * row's identity and this instant, look up each series' value at the
   * cursor (`series.nearest(cursorTime)`), falling back to the latest sample
   * when `null` — a "current or cursor value" readout per row. Live: the
   * frame rebuilds as the cursor moves, so a hook consumer re-renders with
   * it.
   */
  readonly cursorTime: number | null;
  /**
   * Echo a row hover into the container's `hovered` channel (the same one an
   * in-plot hover drives — marks light up where they support it, and
   * `onHover` fires); `null` clears. Id-gated: a row without an `id` is a
   * no-op (there is no series identity to point at).
   */
  hover(row: LegendItemInput | null): void;
  /**
   * Toggle the container selection to this row's series (fires `onSelect`;
   * clears when the row is already selected — the `<Legend>` click
   * semantics). Id-gated no-op for rows without an `id`.
   */
  select(row: LegendItemInput): void;
}

/** The series-scoped {@link SelectInfo} a legend interaction reports: no
 *  sample under it, so `key`/`value` are deliberately `NaN` (see the
 *  provenance note on {@link SelectInfo.key}); `color` is the swatch's
 *  primary colour. */
export function seriesSelectInfo(row: LegendItemInput): SelectInfo {
  return {
    id: row.id!,
    key: NaN,
    value: NaN,
    color: swatchColor(row.swatch),
    label: row.label,
  };
}

/** The swatch's primary colour — what a series-scoped `SelectInfo` reports. */
export function swatchColor(s: SwatchSpec): string {
  switch (s.kind) {
    case 'line':
      return s.color;
    case 'area':
      return s.line;
    case 'band':
      return s.fill;
    case 'scatter':
      return s.color;
    case 'box':
      return s.whisker;
    case 'bar':
      return s.fill;
    case 'candle':
      return s.up;
  }
}

/** Build the {@link ChartLegend} from a frame — the pure core `<Legend>` and
 *  {@link useChartLegend} share, so a custom-rendered legend and the built-in
 *  card can never disagree about rows or sync semantics. Pass a `rowKey` to
 *  **scope** the rows to a single chart row (the layers registered under it);
 *  omit it for the whole container. */
export function buildChartLegend(
  container: ContainerFrame,
  cursor: CursorFrame,
  rowKey?: symbol,
): ChartLegend {
  const scoped = Array.from(container.legendItems.values()).filter(
    (it) => rowKey === undefined || it.rowKey === rowKey,
  );
  // Ordered + deduped specs (chart-row first), each carrying its `rowKey`;
  // group consecutive same-row specs into a LegendRow, mapping spec → item.
  const rows: LegendRow[] = [];
  for (const spec of orderLegendItems(scoped, container.rowOrder)) {
    const item: LegendItem = {
      label: spec.label,
      swatch: spec.swatch,
      ...(spec.id !== undefined ? { id: spec.id } : {}),
      selected: spec.id !== undefined && container.selected?.id === spec.id,
      hovered: spec.id !== undefined && container.hovered?.id === spec.id,
    };
    const last = rows[rows.length - 1];
    if (last !== undefined && last.rowKey === spec.rowKey) {
      (last.items as LegendItem[]).push(item);
    } else {
      rows.push({ rowKey: spec.rowKey, items: [item] });
    }
  }
  // The cursor pixel → axis units, exactly as the tracker fan-in resolves it
  // (in-bounds guard included, so an off-plot cursor reads as "no cursor").
  const cursorTime =
    cursor.cursorX !== null &&
    cursor.cursorX >= 0 &&
    cursor.cursorX <= container.plotWidth
      ? +container.xScale.invert(cursor.cursorX)
      : null;
  return {
    rows,
    gutters: { left: container.leftGutter, right: container.rightGutter },
    cursorTime,
    hover: (row) => {
      if (row === null) return container.setHovered(null);
      if (row.id !== undefined) container.setHovered(seriesSelectInfo(row));
    },
    select: (row) => {
      if (row.id === undefined) return;
      container.select(
        container.selected?.id === row.id ? null : seriesSelectInfo(row),
      );
    },
  };
}

/**
 * **Headless legend** — the registry `<Legend>` renders, as data, plus the
 * hover/select verbs already wired to the chart. For consumers whose legend
 * is a design of its own (a horizontal strip, a ticker-compare pair with the
 * secondary dimmed, values-in-the-legend): render from `rows` (items grouped
 * by chart row; a flat legend is `rows.flatMap((r) => r.items)`), call
 * `hover`/`select` from your item handlers, and read each item's
 * `selected`/`hovered` state back — the same contract the built-in card uses,
 * because both are built by {@link buildChartLegend}.
 *
 * **Readout integration:** an item's `label` is the layer's readout identity —
 * the same string the tracker's `onTrackerChanged` samples carry — so merging
 * live cursor values into your legend is a label-keyed join, no extra
 * plumbing.
 *
 * **Scope follows placement:** called at the container level it enumerates
 * **all** rows; called inside a `<Layers>` (i.e. under a `<ChartRow>`) it
 * **scopes to that row's** layers — a per-row legend needs no prop, just
 * placement, the same way annotations scope to the row they sit in.
 *
 * **Placement:** it reads the frame, so it works anywhere under the
 * `<ChartContainer>`. To render the markup *outside* the chart's box, portal
 * it out (`createPortal`) — context flows through portals.
 *
 * Must be under a `<ChartContainer>`; throws otherwise (for a fully detached
 * key, `<Legend items>` renders explicit rows without a chart).
 */
export function useChartLegend(): ChartLegend {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('useChartLegend() must be used inside a <ChartContainer>');
  }
  const cursor = useContext(CursorContext);
  // A RowContext in scope (rendered inside a <Layers>) narrows to that row.
  const rowKey = useContext(RowContext)?.rowKey;
  return useMemo(
    () => buildChartLegend(container, cursor, rowKey),
    [container, cursor, rowKey],
  );
}
