import { scaleLinear } from 'd3-scale';

/**
 * Resolve a y-axis `[lo, hi]` domain from its explicit bounds and the extents of
 * the layers linked to it. An `undefined` bound auto-fits the data: with no
 * finite data the domain is `[0, 1]`, a flat extent gets ±1 of headroom (so a
 * constant line sits mid-row, not on an edge).
 *
 * A **fully auto-fit** domain (both bounds `undefined`) is rounded out to nice
 * boundaries (d3 `.nice()`) — headroom so peaks / whisker caps don't sit on the
 * plot edge, plus rounder tick values. An explicit bound (full or partial) is
 * left **exact**: the caller's number is never nice'd or moved.
 *
 * Guarantees an **ascending, non-degenerate** domain whenever a bound was
 * auto-fit — a partial explicit bound with no (or flat) data on the other side
 * can otherwise invert it (e.g. `min=5` with no data would naively give
 * `[5, 1]`). Two explicit bounds are returned as-is (an inverted explicit domain
 * is a deliberate axis flip; we don't second-guess it).
 */
export function resolveYDomain(
  min: number | undefined,
  max: number | undefined,
  extents: Iterable<readonly [number, number] | null>,
): [number, number] {
  // Both bounds explicit: trust them verbatim (allows an intentional flip).
  if (min !== undefined && max !== undefined) return [min, max];

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const e of extents) {
    if (e) {
      if (e[0] < dataMin) dataMin = e[0];
      if (e[1] > dataMax) dataMax = e[1];
    }
  }
  if (dataMin === Infinity) {
    dataMin = 0; // no finite data yet
    dataMax = 1;
  } else if (dataMin === dataMax) {
    dataMin -= 1; // flat — give it room
    dataMax += 1;
  }

  let lo = min ?? dataMin;
  let hi = max ?? dataMax;
  // A partial explicit bound can sit at/above the auto-fit other side (explicit
  // min above empty-data's max, or explicit max below the data). Keep the axis
  // ascending by moving the *auto-fit* side — never discard the caller's
  // explicit bound. Exactly one side is explicit here: both-explicit returned
  // early, and a both-auto domain can't invert after the empty/flat guards.
  if (lo >= hi) {
    if (min === undefined)
      lo = hi - 1; // max is explicit → preserve it
    else hi = lo + 1; // min is explicit → preserve it
  }
  // Fully auto-fit → round the domain out for headroom + nicer ticks. A
  // partial/full explicit bound is left exact (returned as-is below).
  if (min === undefined && max === undefined) {
    return scaleLinear().domain([lo, hi]).nice().domain() as [number, number];
  }
  return [lo, hi];
}
