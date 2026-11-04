import type { GeoPoint } from '../types.js';

/**
 * Small copies of a track, for lists, thumbnails and maps that shouldn't load
 * every recorded point: an outline of at most N points, finer detail levels
 * by distance error, and the encoded polyline format (the common Google one,
 * 5 decimal places ≈ 1 m) to store them in — a few hundred bytes where the
 * numbers would be a few KB, and a plain string where a store can't hold an
 * array of arrays.
 *
 * From Estela (estela-app/estela, `packages/core/src/shape/index.ts`).
 */

/** A track's shape: whether it has GPS at all, where it starts, and a
 *  simplified outline (see {@link trackShape}). */
export interface TrackShape {
  /** False for a pool swim, a gym session, a trainer ride: no usable points. */
  hasGps: boolean;
  start?: { lat: number; lng: number };
  /** Encoded polyline of the simplified track; absent without GPS. */
  outline?: string;
}

/** Points an outline keeps at most. */
export const OUTLINE_POINTS = 100;

/** A point a device actually recorded: finite, on the globe, and not the
 *  0,0 some devices write while they have no fix. */
export function isUsableFix(p: GeoPoint | null | undefined): p is GeoPoint {
  if (!p) return false;
  const [lat, lng] = p;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Where a track starts: its first usable point, as {@link TrackShape} stores
 *  it; undefined without GPS. */
export function trackStart(
  latlng: readonly (GeoPoint | null)[],
): TrackShape['start'] {
  const p = latlng.find(isUsableFix);
  return p && { lat: round5(p[0]), lng: round5(p[1]) };
}

/** The shape of a track (see {@link TrackShape}): its usable fixes cut to at
 *  most `maxPoints` and encoded. Points with no fix, and 0,0 placeholders,
 *  are left out. */
export function trackShape(
  latlng: readonly (GeoPoint | null)[],
  maxPoints = OUTLINE_POINTS,
): TrackShape {
  const pts = latlng.filter(isUsableFix);
  if (pts.length === 0) return { hasGps: false };
  const start = trackStart(pts);
  return {
    hasGps: true,
    ...(start ? { start } : {}),
    outline: encodePolyline(simplifyToPoints(pts, maxPoints)),
  };
}

/**
 * Reduce a track to at most `max` points that keep its shape: first thin a
 * long track by index (a day's hike can be 20,000 points), then drop the
 * points that bend the line least (Ramer–Douglas–Peucker), searching for the
 * smallest tolerance that fits. Distances are in degrees with longitude
 * scaled by latitude, which is plenty for a thumbnail.
 */
export function simplifyToPoints(
  points: readonly GeoPoint[],
  max: number,
): GeoPoint[] {
  if (points.length <= max) return [...points];
  const thin = thinByIndex(points, 2000);
  const k = Math.cos(((thin[0]![0] as number) * Math.PI) / 180) || 1;
  let lo = 0;
  let hi = 1; // degrees; wider than any single activity needs
  let best = thinByIndex(thin, max);
  for (let i = 0; i < 20; i++) {
    const eps = (lo + hi) / 2;
    const kept = rdp(thin, eps, k);
    if (kept.length <= max) {
      best = kept;
      hi = eps;
    } else lo = eps;
  }
  return best;
}

function thinByIndex(points: readonly GeoPoint[], max: number): GeoPoint[] {
  if (points.length <= max) return [...points];
  const out: GeoPoint[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

function rdp(points: readonly GeoPoint[], eps: number, k: number): GeoPoint[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let farD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = offLine(points[i]!, points[a]!, points[b]!, k);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** How far `p` is from the segment a–b (degrees, longitude scaled by `k`). */
function offLine(p: GeoPoint, a: GeoPoint, b: GeoPoint, k: number): number {
  const ax = a[1] * k;
  const ay = a[0];
  const dx = b[1] * k - ax;
  const dy = b[0] - ay;
  const px = p[1] * k - ax;
  const py = p[0] - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}

/**
 * Finer copies of a track for a map that zooms in: a 100-point outline suits
 * a list and looks blocky once a map zooms to one activity. Each level keeps the points needed to stay within
 * `metres` of the recorded line, so a map can draw the coarsest level whose
 * error is under a screen pixel ({@link levelFor}). Encoded like the
 * outline; the 112-mile Vineman bike comes to about 10 KB in all, against
 * 1.8 MB for its track file.
 */
export interface TrackLevel {
  /** Every recorded point is within this many metres of the drawn line. */
  metres: number;
  /** Encoded polyline (see {@link encodePolyline}). */
  line: string;
}

/** The levels {@link trackLevels} builds, coarse to fine. */
export const LEVEL_METRES = [40, 10, 2.5] as const;

/** Detail levels of a track, coarse to fine (see {@link TrackLevel}); empty
 *  without GPS. */
export function trackLevels(
  latlng: readonly (GeoPoint | null)[],
  metres: readonly number[] = LEVEL_METRES,
): TrackLevel[] {
  const pts = latlng.filter(isUsableFix);
  if (pts.length < 2) return [];
  const k = Math.cos((pts[0]![0] * Math.PI) / 180) || 1;
  return [...metres]
    .sort((a, b) => b - a)
    .map((m) => ({
      metres: m,
      line: encodePolyline(rdp(pts, m / METRES_PER_DEGREE, k)),
    }));
}

/**
 * The level to draw when one screen pixel covers `metresPerPixel`: the
 * coarsest whose error stays under a pixel, or the finest when even that is
 * too coarse. Undefined with no levels. A pixel here is a CSS pixel; on a
 * 2× screen the error can reach two device pixels, which still looks smooth.
 */
export function levelFor(
  levels: readonly TrackLevel[],
  metresPerPixel: number,
): TrackLevel | undefined {
  const coarseFirst = [...levels].sort((a, b) => b.metres - a.metres);
  return (
    coarseFirst.find((l) => l.metres <= metresPerPixel) ??
    coarseFirst[coarseFirst.length - 1]
  );
}

/** Metres of latitude in one degree (and of longitude at the equator). */
const METRES_PER_DEGREE = 111_320;

/** Encode points as a polyline string, 5 decimal places. */
export function encodePolyline(points: readonly GeoPoint[]): string {
  let out = '';
  let pLat = 0;
  let pLng = 0;
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeValue(iLat - pLat) + encodeValue(iLng - pLng);
    pLat = iLat;
    pLng = iLng;
  }
  return out;
}

function encodeValue(v: number): string {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (n >= 0x20) {
    s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return s + String.fromCharCode(n + 63);
}

/** Decode a polyline string back to points. Stops at a malformed tail. */
export function decodePolyline(s: string): GeoPoint[] {
  const out: GeoPoint[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= s.length) return null;
      const b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  for (;;) {
    const dLat = next();
    const dLng = dLat === null ? null : next();
    if (dLat === null || dLng === null) break;
    lat += dLat;
    lng += dLng;
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
