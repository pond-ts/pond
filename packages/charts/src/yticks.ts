/**
 * The **y-axis auto-tick count** — the `count` a `<YAxis>`'s labels and the
 * row's gridlines both pass to `scale.ticks(count)` / `tickFormat(count)`, so
 * a label and its gridline stay on the same instants (the alignment the two
 * hardcoded `5`s in `YAxis` + `Layers` used to hold by agreeing).
 *
 * Height-derived by default — a short strip gets fewer ticks than a tall row,
 * so a 72px histogram lane no longer crushes 5 labels into the space a 380px
 * row uses (the #508 vol-surface friction). This mirrors the trading-time x
 * axis, whose count is width-derived (0.44.1). An explicit `<YAxis tickCount>`
 * overrides the derivation; explicit `<YAxis ticks>` bypasses this entirely.
 */

/** Target px of row height per y tick. A y label is one line, so this is the
 *  vertical breathing room between gridlines — a touch tighter than the x
 *  axis's per-tick budget, since stacked numbers need less room than dates. */
const Y_TICK_PX = 48;

/**
 * Resolve a y-axis's auto-tick count: the explicit `tickCount` when given,
 * else `floor(height / Y_TICK_PX)` floored at 2 (a drawable minimum even on a
 * pre-layout zero height). `ticks(count)` treats it as a target and returns
 * nice 1-2-5 values near it, so a larger count on a tall row is exactly right.
 */
export function resolveYTickCount(
  height: number,
  explicit?: number | undefined,
): number {
  if (explicit !== undefined) return Math.max(1, Math.floor(explicit));
  return Math.max(2, Math.floor(height / Y_TICK_PX));
}
