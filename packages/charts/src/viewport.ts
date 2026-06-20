/**
 * Pure time-range viewport math for pan/zoom (M4.2). The container holds the view
 * range; these compute the next range from a gesture (the event surface in
 * `Layers` supplies the pixel→time deltas). Kept pure + free of React/canvas so
 * the geometry is unit-tested directly, like {@link maxSlotWidths} / the tracker.
 */

export type TimeRange = readonly [number, number];

/**
 * Shift a range by `dt` ms (drag-pan). The caller signs `dt` from the gesture —
 * dragging the plot right reveals earlier data, i.e. a negative `dt`.
 */
export function panRange(range: TimeRange, dt: number): [number, number] {
  return [range[0] + dt, range[1] + dt];
}

/**
 * Zoom `range` around `pivot` (ms) by `factor` — `< 1` zooms in, `> 1` out, with
 * the pivot held fixed (the time under the cursor stays put). Clamped so the
 * duration never drops below `minDuration` (the zoom-in floor); at the floor the
 * pivot keeps its fractional position in the window.
 */
export function zoomRange(
  range: TimeRange,
  pivot: number,
  factor: number,
  minDuration = 1,
): [number, number] {
  const lo = pivot - (pivot - range[0]) * factor;
  const hi = pivot + (range[1] - pivot) * factor;
  if (hi - lo >= minDuration) return [lo, hi];
  // Floor reached: hold the pivot's fractional position, set span = minDuration.
  const span = range[1] - range[0];
  const frac = span > 0 ? (pivot - range[0]) / span : 0.5;
  return [pivot - minDuration * frac, pivot + minDuration * (1 - frac)];
}
