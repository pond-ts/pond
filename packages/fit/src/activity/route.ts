/**
 * Where an activity went (RFC §8): `run.route`. Its line as drawn on a map,
 * at full resolution, and the box around it. Null for an activity with no
 * GPS.
 */
import { trackLine, type PreparedActivity } from '../summary/index.js';

/** A `[latitude, longitude]` pair, in degrees. */
export type LatLng = readonly [number, number];

/** The line an activity followed. */
export class Route {
  /** The fixes in order, samples with no fix left out. An open water swim's
   *  line is the cleaned one (its raw fixes zigzag), see `cleaned`. */
  readonly points: readonly LatLng[];
  /** The line was cleaned rather than drawn from the raw fixes. */
  readonly cleaned: boolean;
  #bounds?: { southWest: LatLng; northEast: LatLng };

  /** @internal */
  constructor(points: readonly LatLng[], cleaned: boolean) {
    this.points = points;
    this.cleaned = cleaned;
  }

  /** The smallest box holding the line. */
  get bounds(): { southWest: LatLng; northEast: LatLng } {
    if (this.#bounds) return this.#bounds;
    let s = Infinity;
    let w = Infinity;
    let n = -Infinity;
    let e = -Infinity;
    for (const [lat, lng] of this.points) {
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
    }
    return (this.#bounds = { southWest: [s, w], northEast: [n, e] });
  }
}

/** The route of a prepared activity, or null with no GPS. @internal */
export function routeOf(prep: PreparedActivity): Route | null {
  if (!prep.hasTrack) return null;
  const points = trackLine(prep);
  if (!points.length) return null;
  return new Route(points, !!prep.imported.streams.openWater);
}
