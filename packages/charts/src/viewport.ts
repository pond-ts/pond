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

/**
 * The slice of a discontinuity provider the trading-time viewport math needs —
 * a structural subset of the charts `DiscontinuityProvider` (so `viewport.ts`
 * stays free of any provider dependency).
 */
export interface ViewportDiscontinuity {
  distance(from: number, to: number): number;
  offset(value: number, amount: number): number;
}

/**
 * Pan a range on a **trading-time** axis: shift both endpoints by the same
 * amount of *trading* time, so the pan feels uniform on screen even across
 * collapsed gaps (a raw-ms shift would jump at each weekend/holiday). `fraction`
 * is the signed share of the plot width dragged — the caller passes `-dx/plotWidth`
 * (drag right → reveal earlier data → negative).
 */
export function panRangeTrading(
  range: TimeRange,
  fraction: number,
  provider: ViewportDiscontinuity,
): [number, number] {
  const span = provider.distance(range[0], range[1]);
  const shift = fraction * span;
  // Anchor on the endpoint being pushed toward its boundary and rebuild the
  // other from the preserved span, so panning into *either* calendar edge stops
  // (the window holds its trading width) rather than shrinking or collapsing.
  if (shift <= 0) {
    const start = provider.offset(range[0], shift);
    return [start, provider.offset(start, span)];
  }
  const end = provider.offset(range[1], shift);
  return [provider.offset(end, -span), end];
}

/**
 * Zoom a **trading-time** range around `pivot` by `factor` (`< 1` in, `> 1` out),
 * scaling the *trading* distance from the pivot to each endpoint so the pivot's
 * on-screen position holds. Floors the visible trading time at `minLive`.
 */
export function zoomRangeTrading(
  range: TimeRange,
  pivot: number,
  factor: number,
  provider: ViewportDiscontinuity,
  minLive = 1,
): [number, number] {
  const left = provider.distance(range[0], pivot); // trading-ms d0 → pivot (≥ 0)
  const right = provider.distance(pivot, range[1]); // trading-ms pivot → d1 (≥ 0)
  let nl = left * factor;
  let nr = right * factor;
  if (nl + nr < minLive) {
    const total = left + right;
    const frac = total > 0 ? left / total : 0.5;
    nl = minLive * frac;
    nr = minLive * (1 - frac);
  }
  let d0 = provider.offset(pivot, -nl);
  let d1 = provider.offset(pivot, nr);
  // If one side clamped at a calendar edge (couldn't extend as far as asked),
  // give the shortfall to the other side so the visible trading span — and the
  // `minLive` floor — is preserved. (The pivot's *fraction* can then drift at
  // the edge: there is no trading time before the first / after the last session
  // to hold it against.)
  const shortLeft = nl - provider.distance(d0, pivot);
  const shortRight = nr - provider.distance(pivot, d1);
  if (shortLeft > 0) d1 = provider.offset(pivot, nr + shortLeft);
  else if (shortRight > 0) d0 = provider.offset(pivot, -(nl + shortRight));
  return [d0, d1];
}
