/**
 * `Track` — an ergonomic value object over a bare polyline (`GeoPoint[]`), for
 * the GPS-only case with no activity behind it: a route drawn from stored
 * `[lat, lng]` vertices, a map overlay, a planned line. The fluent face over the
 * polyline operators in {@link import('../geo/index.js') geo} (`polylineCumulative`,
 * `interpolateAtDistance`, `polylineSlice`, `boundsOf`) — measure it, sample a
 * point at a distance, slice a sub-track, get its bounds.
 *
 * For a track WITH time/channels (a recorded activity), use {@link
 * import('../activity/index.js').Activity} instead — `Track` is deliberately the
 * lightweight, position-only sibling. Immutable; the cumulative profile memoizes.
 */
import type { GeoPoint } from '../types.js';
import {
  polylineCumulative,
  interpolateAtDistance,
  polylineSlice,
  boundsOf,
} from '../geo/index.js';
import { Distance } from '../quantities.js';

export class Track {
  private _cumulative?: number[];

  private constructor(private readonly pts: ReadonlyArray<GeoPoint>) {}

  /** Wrap a polyline — an array of `[latitude, longitude]` vertices. */
  static of(points: ReadonlyArray<GeoPoint>): Track {
    return new Track(points);
  }

  /** The underlying polyline vertices (the escape hatch to the raw line). */
  get points(): ReadonlyArray<GeoPoint> {
    return this.pts;
  }
  /** Number of vertices. */
  get count(): number {
    return this.pts.length;
  }
  get isEmpty(): boolean {
    return this.pts.length === 0;
  }

  /** Cumulative distance (metres) at each vertex; `[0] = 0`. Memoized. */
  cumulativeMeters(): number[] {
    return (this._cumulative ??= polylineCumulative(this.pts));
  }

  /** Total length along the polyline. */
  distance(): Distance {
    const cumulative = this.cumulativeMeters();
    return Distance.meters(
      cumulative.length ? cumulative[cumulative.length - 1]! : 0,
    );
  }

  /** Bounding box `[[minLatitude, minLongitude], [maxLatitude, maxLongitude]]`;
   *  `null` for an empty track. */
  bounds(): [[number, number], [number, number]] | null {
    const n = this.pts.length;
    if (n === 0) return null;
    const latitude = new Float64Array(n);
    const longitude = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      latitude[i] = this.pts[i]![0];
      longitude[i] = this.pts[i]![1];
    }
    return boundsOf(latitude, longitude);
  }

  /** The point at a distance along the track, interpolated between the
   *  bracketing vertices and clamped to the ends; `null` for an empty track. */
  pointAt(distance: Distance): GeoPoint | null {
    return interpolateAtDistance(
      this.pts,
      distance.meters,
      this.cumulativeMeters(),
    );
  }

  /** The sub-track over `[from, to]`, with the endpoints interpolated to the
   *  exact distances. `domainTotal` is the length the `from`/`to` ruler is
   *  measured in when it differs from this track's own (e.g. odometer metres vs
   *  a simplified polyline) — the window is then rescaled proportionally. */
  slice(
    from: Distance,
    to: Distance,
    opts: { domainTotal?: Distance } = {},
  ): Track {
    const sliceOpts: { domainTotal?: number; cum?: number[] } = {
      cum: this.cumulativeMeters(),
    };
    if (opts.domainTotal) sliceOpts.domainTotal = opts.domainTotal.meters;
    return new Track(
      polylineSlice(this.pts, from.meters, to.meters, sliceOpts),
    );
  }
}
