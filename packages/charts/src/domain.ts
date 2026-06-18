/**
 * Resolve a y-axis `[lo, hi]` domain from its explicit bounds and the extents of
 * the layers linked to it. An `undefined` bound auto-fits the data: with no
 * finite data the domain is `[0, 1]`, a flat extent gets ±1 of headroom (so a
 * constant line sits mid-row, not on an edge).
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

  const lo = min ?? dataMin;
  let hi = max ?? dataMax;
  // A partial explicit bound can still sit at/above the auto-fit other side
  // (e.g. explicit min above empty-data's [0,1] max); keep the axis ascending.
  if (lo >= hi) hi = lo + 1;
  return [lo, hi];
}
