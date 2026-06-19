/**
 * Per-slot gutter math, shared by {@link ChartContainer} (reserve) and
 * {@link ChartRow} (place). A "slot" is one axis column on a side; slots are
 * indexed **from the plot outward** — slot 0 is the axis nearest the plot. Each
 * row contributes a list of its axis widths for one side in slot order (slot 0
 * first). Kept pure + free of React so the column-alignment rule is unit-tested
 * directly.
 */

/**
 * The reserved width of each slot: the max any row needs in that slot. A row
 * with fewer axes simply has no entry for the outer slots, contributing nothing
 * there — so `leftSlots[i]` is `max` over the rows that *have* a slot `i`.
 *
 * The sum is the side's total gutter; the plot starts after the left sum and
 * ends before the right sum, identically on every row.
 */
export function maxSlotWidths(rows: readonly (readonly number[])[]): number[] {
  const len = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const slots = new Array<number>(len).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      slots[i] = Math.max(slots[i]!, row[i]!);
    }
  }
  return slots;
}

/** Sum of an array of widths (a side's total gutter). */
export function sum(widths: readonly number[]): number {
  let total = 0;
  for (const w of widths) total += w;
  return total;
}

/** A row axis as the layout sees it: its per-instance slot **key** + width. */
export interface SlotAxis {
  /** Stable per-instance key (the `useSlotKey` symbol), NOT the data id. */
  readonly key: symbol;
  readonly width: number;
}

/** What {@link placeAxisSlots} computes for one row. */
export interface AxisSlotPlacement {
  /** Axis instance key → its reserved slot width (that column's max across rows). */
  readonly axisSlots: ReadonlyMap<symbol, number>;
  /** Width of the outer slots this row lacks — padded so its plot stays aligned. */
  readonly leftPad: number;
  readonly rightPad: number;
}

/**
 * Place a row's real axes into the container's reserved slots (slot 0 nearest the
 * plot). `leftAxes` are in author order (outer→inner), so the i-th sits in slot
 * `len-1-i`; `rightAxes` are author order (inner→outer), so the j-th sits in slot
 * `j`. Each axis's reserved width is its slot's max (falling back to its own
 * width until the container has reserved); a row with fewer axes than the widest
 * pads the outer slots it lacks — so a no-axis row pads the whole gutter and its
 * plot still left-aligns.
 *
 * Keyed by **instance** (the `key` symbol), not the data `id`: two axes can share
 * an id (a left/right mirror of one scale, or a duplicate) yet must keep distinct
 * slots, or the rendered gutter would not match what the container reserved.
 */
export function placeAxisSlots(
  leftAxes: readonly SlotAxis[],
  rightAxes: readonly SlotAxis[],
  leftSlots: readonly number[],
  rightSlots: readonly number[],
): AxisSlotPlacement {
  const axisSlots = new Map<symbol, number>();
  leftAxes.forEach((ax, i) => {
    axisSlots.set(ax.key, leftSlots[leftAxes.length - 1 - i] ?? ax.width);
  });
  rightAxes.forEach((ax, j) => {
    axisSlots.set(ax.key, rightSlots[j] ?? ax.width);
  });
  let leftPad = 0;
  for (let i = leftAxes.length; i < leftSlots.length; i++)
    leftPad += leftSlots[i] ?? 0;
  let rightPad = 0;
  for (let j = rightAxes.length; j < rightSlots.length; j++) {
    rightPad += rightSlots[j] ?? 0;
  }
  return { axisSlots, leftPad, rightPad };
}
