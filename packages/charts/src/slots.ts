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
