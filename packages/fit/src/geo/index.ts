/**
 * Geospatial operators on a pond-ts `TimeSeries` — the geo layer of
 * `@pond-ts/fit`. The thesis: a GPS track is already a time-keyed series of
 * `number` columns, so the geospatial value lives in operators over those
 * columns, not in a new storage primitive.
 *
 * Built strictly on pond's PUBLIC surface: two `number` columns for lat/lng,
 * `column(name).toFloat64Array()` for zero-copy reads, and column reductions.
 * Where pond's public API can't express something cleanly we work around it in
 * here and record the pain in docs/pond-friction.md (the friction is
 * the deliverable). The two live ones, already confirmed:
 *   - F-geo-1: there is no public "attach a computed Float64Array as a column",
 *     so derived columns require a row-rebuild. We avoid it by computing over
 *     the raw typed arrays instead and only returning scalars / plain arrays.
 *   - F-geo-2: pond aggregates over a *temporal* Sequence, but splits and the
 *     elevation profile want a *distance* axis. We hand-roll the distance
 *     bucketing below — see `splitsByDistance` / `elevationProfile`.
 */
import { TimeSeries } from 'pond-ts';

/**
 * The canonical activity schema: time key + lat/lng, with every other per-sample
 * channel optional (present iff the source recorded it). This is the single
 * source the compute layer reads — the "consume the series directly" seam (see
 * docs/fit/api.md): power/cadence/temp live IN the series alongside ele/hr,
 * not as orphaned parallel arrays.
 */
export const TRACK_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'lat', kind: 'number', required: false },
  { name: 'lng', kind: 'number', required: false },
  { name: 'ele', kind: 'number', required: false },
  { name: 'hr', kind: 'number', required: false },
  { name: 'power', kind: 'number', required: false },
  { name: 'cadence', kind: 'number', required: false },
  { name: 'temp', kind: 'number', required: false },
  { name: 'distance', kind: 'number', required: false },
] as const;

export type TrackSeries = TimeSeries<typeof TRACK_SCHEMA>;

/**
 * One sample as a tuple matching {@link TRACK_SCHEMA}. Every channel is optional
 * — including lat/lng, absent for a GPS-less indoor activity (the series is then
 * just time + the recorded channels). Absent values are `undefined`: the
 * constructor accepts `undefined` for `required: false` columns and records it in
 * the validity bitmap (lossless); as of pond 0.29 `RowForSchema` honors
 * `required: false` so the row type admits it too. It rejects `null` and `NaN`.
 * See docs/pond-friction.md.
 */
export type TrackPoint = [
  timeMs: number,
  lat: number | undefined,
  lng: number | undefined,
  ele: number | undefined,
  hr: number | undefined,
  power: number | undefined,
  cadence: number | undefined,
  temp: number | undefined,
  distance: number | undefined,
];

/** Build a pond track from parallel sample tuples (already time-sorted). */
export function buildTrack(
  name: string,
  points: ReadonlyArray<TrackPoint>,
): TrackSeries {
  return new TimeSeries({ name, schema: TRACK_SCHEMA, rows: points });
}

/**
 * The raw typed-array columns of an activity — the zero-copy read path the whole
 * compute layer reads from. `lat`/`lng` are present only for a GPS activity; the
 * other channels are present iff the source recorded them (missing cells are
 * NaN). Optional channels are absent from the object when the source had none.
 */
export interface TrackColumns {
  /** Positions — present (length n) for a GPS activity, EMPTY for a GPS-less one
   *  (the `cols.lat.length` hasTrack signal). */
  lat: Float64Array;
  lng: Float64Array;
  ele: Float64Array;
  /** Absolute sample times in seconds (key column, ms → s). */
  timeSec: Float64Array;
  hr?: Float64Array;
  power?: Float64Array;
  cadence?: Float64Array;
  temp?: Float64Array;
  /** Device-recorded cumulative distance (m); present iff the source carried it
   *  (a GPS-less ride's distance axis). */
  distance?: Float64Array;
}

/** Does any of the first `n` cells pass the validity bitmap? (Distinguishes a
 *  channel the source recorded with gaps from one it lacked entirely.) */
function anyDefined(
  validity: { isDefined(i: number): boolean },
  n: number,
): boolean {
  for (let i = 0; i < n; i++) if (validity.isDefined(i)) return true;
  return false;
}

/**
 * Read one number column as a `Float64Array`, honouring the validity bitmap:
 * `toFloat64Array()` flattens a missing cell to `0` by design, but pond exposes
 * validity separately (`column.hasMissing()` / `column.validity`), so we map
 * missing cells to `NaN` and the math skips them. (Verified against pond's
 * types: missing IS recoverable via the validity API.)
 */
function numberColumn(
  track: TrackSeries,
  name: 'ele' | 'hr' | 'power' | 'cadence' | 'temp' | 'distance',
): Float64Array {
  const col = track.column(name);
  const arr = col.toFloat64Array();
  if (!col.hasMissing() || !col.validity) return arr;
  const v = col.validity;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = v.isDefined(i) ? arr[i]! : NaN;
  return out;
}

/**
 * Read a track's columns as `Float64Array`s. lat/lng off the packed value
 * columns (required — never missing); the time axis off the key column via
 * `keyColumn().begin` (a `Float64Array` of ms-since-epoch). Optional channels
 * are read validity-aware and included only when the column carried any value.
 */
export function readColumns(track: TrackSeries): TrackColumns {
  const beginsMs = track.keyColumn().begin;
  const nRows = beginsMs.length;
  const timeSec = new Float64Array(nRows);
  for (let i = 0; i < nRows; i++) timeSec[i] = beginsMs[i]! / 1000;
  // Whether the source recorded a channel: fully present, or partly present
  // (some sample defined). All-missing ⇒ the source lacked it.
  const present = (
    name:
      | 'lat'
      | 'lng'
      | 'ele'
      | 'hr'
      | 'power'
      | 'cadence'
      | 'temp'
      | 'distance',
  ): boolean => {
    const col = track.column(name);
    return (
      !col.hasMissing() ||
      (col.validity ? anyDefined(col.validity, nRows) : false)
    );
  };
  // lat/lng: full for a GPS activity, EMPTY when the source had no positions —
  // preserving `cols.lat.length` as the hasTrack signal the compute layer uses.
  // Require BOTH columns: the builder always writes them as a pair, so a lone
  // present `lat` would mean a malformed track — read it and we'd emit phantom
  // `(lat, 0)` points on the prime meridian, poisoning distance/bounds.
  const hasPos = present('lat') && present('lng');
  const lat = hasPos
    ? track.column('lat').toFloat64Array()
    : new Float64Array(0);
  const lng = hasPos
    ? track.column('lng').toFloat64Array()
    : new Float64Array(0);
  const ele = numberColumn(track, 'ele');
  const cols: TrackColumns = { lat, lng, ele, timeSec };
  // Optional channels: included only when the source recorded them — a channel
  // the source lacked is `undefined` in `cols`, mirroring an absent `streams.*`
  // array, so consumers omit it.
  for (const name of ['hr', 'power', 'cadence', 'temp', 'distance'] as const) {
    if (present(name)) cols[name] = numberColumn(track, name);
  }
  return cols;
}

/** Guard a distance-grid size (bucket / split interval): a non-finite or ≤0
 *  value would make `Math.ceil(total / size)` blow up to `Infinity` buckets and
 *  spin the bucketing loop forever. Reject it at the boundary instead. */
function assertPositiveMeters(meters: number, name: string): void {
  if (!Number.isFinite(meters) || meters <= 0) {
    throw new RangeError(
      `${name} must be a finite positive number of metres, got ${meters}`,
    );
  }
}

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
const DEG = Math.PI / 180;

/** Great-circle distance between two WGS84 points, in metres. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Per-step distances (step[0] = 0), in metres. */
export function stepDistances(
  lat: Float64Array,
  lng: Float64Array,
): Float64Array {
  const n = lat.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++)
    out[i] = haversineMeters(lat[i - 1]!, lng[i - 1]!, lat[i]!, lng[i]!);
  return out;
}

/** Running total of a per-step series (cumulative[0] = step[0]). */
export function cumulative(step: Float64Array): Float64Array {
  const out = new Float64Array(step.length);
  let acc = 0;
  for (let i = 0; i < step.length; i++) {
    acc += step[i]!;
    out[i] = acc;
  }
  return out;
}

/** Total track distance, in metres. */
export function totalDistanceMeters(
  lat: Float64Array,
  lng: Float64Array,
): number {
  let total = 0;
  for (let i = 1; i < lat.length; i++)
    total += haversineMeters(lat[i - 1]!, lng[i - 1]!, lat[i]!, lng[i]!);
  return total;
}

/**
 * Cumulative elevation gain/loss with a hysteresis threshold to reject the
 * metre-scale jitter in barometric/GPS elevation. We only commit a move once it
 * exceeds `thresholdMeters` from the last committed reference — the standard way
 * to keep noise from inflating "gain" (raw positive-diff sums overcount wildly).
 * NaN samples (missing ele) are skipped.
 */
export function elevationGainLoss(
  ele: Float64Array,
  thresholdMeters = 3,
): { gainMeters: number; lossMeters: number } {
  let gain = 0;
  let loss = 0;
  let ref = NaN;
  for (let i = 0; i < ele.length; i++) {
    const e = ele[i]!;
    if (Number.isNaN(e)) continue;
    if (Number.isNaN(ref)) {
      ref = e;
      continue;
    }
    const d = e - ref;
    if (d >= thresholdMeters) {
      gain += d;
      ref = e;
    } else if (d <= -thresholdMeters) {
      loss += -d;
      ref = e;
    }
  }
  return { gainMeters: gain, lossMeters: loss };
}

/**
 * Moving time: sum of inter-sample intervals where instantaneous speed is at or
 * above `speedThresholdMps` (default 0.5 m/s ≈ 1.8 km/h — below this you're
 * stopped/drifting). This is what separates "moving time" from "elapsed time".
 */
export function movingTimeSeconds(
  step: Float64Array,
  timeSec: Float64Array,
  speedThresholdMps = 0.5,
): number {
  let moving = 0;
  for (let i = 1; i < step.length; i++) {
    const dt = timeSec[i]! - timeSec[i - 1]!;
    if (dt <= 0) continue;
    if (step[i]! / dt >= speedThresholdMps) moving += dt;
  }
  return moving;
}

/** Bounding box as `[[minLat, minLng], [maxLat, maxLng]]`. */
export function boundsOf(
  lat: Float64Array,
  lng: Float64Array,
): [[number, number], [number, number]] {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    if (lat[i]! < minLat) minLat = lat[i]!;
    if (lat[i]! > maxLat) maxLat = lat[i]!;
    if (lng[i]! < minLng) minLng = lng[i]!;
    if (lng[i]! > maxLng) maxLng = lng[i]!;
  }
  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ];
}

// ── Segments: a distance window of the route, for highlighting / re-scoping ──
// The map polyline is the simplified [lat,lng] line; these map a cumulative-
// distance window onto it so a lap/split (or any range) can be sliced out and
// drawn, and a scrub position can be placed. Distances are along the polyline
// itself (its own cumulative length), which is what the map renders.

/** A contiguous window of an activity, in cumulative distance (metres). */
export interface Segment {
  startMeters: number;
  endMeters: number;
}

/** Cumulative distance (m) at each polyline vertex; `[0] = 0`. */
export function polylineCumulative(
  polyline: ReadonlyArray<[number, number]>,
): number[] {
  const out = new Array<number>(polyline.length);
  if (polyline.length > 0) out[0] = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1]!;
    const b = polyline[i]!;
    out[i] = out[i - 1]! + haversineMeters(a[0], a[1], b[0], b[1]);
  }
  return out;
}

/** The `[lat,lng]` point at cumulative distance `meters` along the polyline,
 *  linearly interpolated between the bracketing vertices. Clamps to the ends;
 *  non-finite `meters` resolves to the start; null for an empty polyline.
 *  `cum` may be passed to avoid recomputation — it MUST correspond to
 *  `polyline` (same length/order); a mismatch yields silently wrong results. */
export function interpolateAtDistance(
  polyline: ReadonlyArray<[number, number]>,
  meters: number,
  cum: number[] = polylineCumulative(polyline),
): [number, number] | null {
  const n = polyline.length;
  if (n === 0) return null;
  if (n === 1) return [polyline[0]![0], polyline[0]![1]];
  // NaN/Infinity in → the start, rather than emitting [NaN,NaN] (which Leaflet
  // would render as a broken marker). Not reachable from the lap caller, but
  // the scrub UI could feed a stray 0/0 progress ratio.
  if (!Number.isFinite(meters)) return [polyline[0]![0], polyline[0]![1]];
  const total = cum[n - 1]!;
  const d = Math.max(0, Math.min(meters, total));
  // first vertex at or past d
  let hi = 1;
  while (hi < n - 1 && cum[hi]! < d) hi++;
  const lo = hi - 1;
  const span = cum[hi]! - cum[lo]!;
  const frac = span > 0 ? (d - cum[lo]!) / span : 0;
  const a = polyline[lo]!;
  const b = polyline[hi]!;
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
}

/**
 * The sub-polyline covering `[startMeters, endMeters]` of the route, with the
 * endpoints interpolated to the exact distances (so a highlight begins and ends
 * where the segment does, not at the nearest vertex) plus every vertex strictly
 * between. Range is clamped to the track and normalized (start ≤ end). Returns
 * the two interpolated endpoints for a zero-length range, `[]` for an empty
 * polyline.
 *
 * `opts.domainTotal` is the length of the ruler `start`/`end` are measured in
 * when that differs from this polyline's own length — laps come in FIT
 * odometer metres and splits in raw-track haversine metres, but the polyline is
 * Douglas–Peucker-simplified and a fraction shorter, so feeding those metres in
 * raw would drift the highlight (≈1 km late on a 180 km ride). Given
 * `domainTotal`, the window is rescaled proportionally onto the polyline so the
 * same FRACTION of the route is sliced. `opts.cum`, if passed, MUST correspond
 * to `polyline`.
 */
export function polylineSlice(
  polyline: ReadonlyArray<[number, number]>,
  startMeters: number,
  endMeters: number,
  opts: { domainTotal?: number; cum?: number[] } = {},
): Array<[number, number]> {
  const cum = opts.cum ?? polylineCumulative(polyline);
  const n = polyline.length;
  if (n === 0) return [];
  const total = cum[n - 1]!;
  // rescale the window from its own ruler onto the polyline's length
  const scale =
    opts.domainTotal && opts.domainTotal > 0 ? total / opts.domainTotal : 1;
  const startScaled = startMeters * scale;
  const endScaled = endMeters * scale;
  const s = Math.max(0, Math.min(Math.min(startScaled, endScaled), total));
  const e = Math.max(0, Math.min(Math.max(startScaled, endScaled), total));
  const out: Array<[number, number]> = [];
  out.push(interpolateAtDistance(polyline, s, cum)!);
  for (let i = 0; i < n; i++) {
    if (cum[i]! > s && cum[i]! < e)
      out.push([polyline[i]![0], polyline[i]![1]]);
  }
  out.push(interpolateAtDistance(polyline, e, cum)!);
  return out;
}

/**
 * Bounds via pond's column reductions — the clean, pond-native path (contrast
 * with the friction ones). Kept to exercise the public column API and to show
 * what pond *does* make easy.
 */
export function boundsViaPond(
  track: TrackSeries,
): [[number, number], [number, number]] {
  const lat = track.column('lat');
  const lng = track.column('lng');
  return [
    [lat.min() as number, lng.min() as number],
    [lat.max() as number, lng.max() as number],
  ];
}

/**
 * Douglas–Peucker polyline simplification with a metre tolerance, for the map
 * overview line. Returns the kept `[lat, lng]` points (endpoints always kept).
 * Perpendicular distance is approximated in a local equirectangular projection
 * (fine at track scale; we are not a projection engine — RFC §6 non-goals).
 */
export function simplify(
  points: ReadonlyArray<[number, number]>,
  toleranceMeters: number,
): Array<[number, number]> {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const lat0 = (points[0]![0] * Math.PI) / 180;
  const mPerDegLat = 111132.92;
  const mPerDegLng = 111412.84 * Math.cos(lat0);
  const proj = (p: [number, number]): [number, number] => [
    p[1] * mPerDegLng,
    p[0] * mPerDegLat,
  ];

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let idx = -1;
    const [ax, ay] = proj(points[first]!);
    const [bx, by] = proj(points[last]!);
    const dx = bx - ax;
    const dy = by - ay;
    const segLen2 = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = proj(points[i]!);
      let dist: number;
      if (segLen2 === 0) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        const t = ((px - ax) * dx + (py - ay) * dy) / segLen2;
        const tc = Math.max(0, Math.min(1, t));
        dist = Math.hypot(px - (ax + tc * dx), py - (ay + tc * dy));
      }
      if (dist > maxDist) {
        maxDist = dist;
        idx = i;
      }
    }
    if (maxDist > toleranceMeters && idx !== -1) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++)
    if (keep[i]) out.push([points[i]![0], points[i]![1]]);
  return out;
}

/** A per-interval split (the per-km/per-mile row). */
export interface Split {
  /** 1-based split index. */
  index: number;
  /** Distance covered in this split, metres (the last split may be short). */
  distanceMeters: number;
  /** Elapsed seconds within the split. */
  durationSeconds: number;
  /** Elevation gain within the split, metres. */
  elevationGainMeters: number;
  /** Elevation loss within the split, metres (same ±3 m hysteresis as gain,
   *  reference carried across split boundaries). */
  elevationLossMeters: number;
  /** Normalized power over the split, watts — present only with a power meter
   *  (caller passes the 30 s-rolled power; see `splitsByDistance`). */
  normalizedWatts?: number | undefined;
  /** Per-split channel aggregates (mean of finite samples; max of finite
   *  samples) — present only when the matching stream is supplied to
   *  `splitsByDistance` via `extras`. Speed is m/s. */
  avgHeartrate?: number | undefined;
  maxHeartrate?: number | undefined;
  avgWatts?: number | undefined;
  maxWatts?: number | undefined;
  avgCadence?: number | undefined;
  avgSpeedMps?: number | undefined;
  maxSpeedMps?: number | undefined;
}

/** Optional per-sample channels for `splitsByDistance` to aggregate per split
 *  (avg = mean of finite samples, max = max finite). All aligned to `step`. */
export interface SplitExtras {
  heartrate?: Float64Array | undefined;
  watts?: Float64Array | undefined;
  cadence?: Float64Array | undefined;
  /** Derived instantaneous speed (m/s); index 0 is typically NaN. */
  speed?: Float64Array | undefined;
}

/**
 * Per-interval splits over the DISTANCE axis (per-km, per-mile). This is
 * **F-geo-2**: pond's `aggregate(Sequence, …)` buckets over the temporal key,
 * but a split is a bucket over *cumulative distance* — a derived, monotonic,
 * non-key column. Pond has no public "aggregate over an arbitrary monotonic
 * column", so we walk the arrays by hand here. The note in docs/pond-friction.md
 * proposes what the pond-native primitive could look like.
 */
export function splitsByDistance(
  step: Float64Array,
  timeSec: Float64Array,
  ele: Float64Array,
  intervalMeters = 1000,
  /** Optional 30 s-rolled power (NP smoothing) aligned to the samples; when
   *  given, each split gets `normalizedWatts = (mean of rolled^4)^¼`. */
  npRolled?: Float64Array,
  /** Optional raw channels to aggregate per split (avg + max). See {@link SplitExtras}. */
  extras: SplitExtras = {},
): Split[] {
  assertPositiveMeters(intervalMeters, 'intervalMeters');
  const splits: Split[] = [];
  let acc = 0;
  let splitDist = 0;
  let splitStart = timeSec[0] ?? 0;
  // refEle carries the hysteresis reference ACROSS split boundaries (a climb
  // spanning a boundary isn't restarted); gain/loss reset each split.
  let refEle = ele[0] ?? NaN;
  let gain = 0;
  let loss = 0;
  let sum4 = 0;
  let cnt = 0;
  let index = 1;
  // mean = sum/n of finite samples, max = max finite — per channel, per split.
  const hr = new MeanMax();
  const watt = new MeanMax();
  const cad = new MeanMax();
  const spd = new MeanMax();
  const np = (): number | undefined =>
    cnt > 0 ? (sum4 / cnt) ** 0.25 : undefined;
  const emit = (
    idx: number,
    distanceMeters: number,
    endTime: number,
  ): Split => ({
    index: idx,
    distanceMeters,
    durationSeconds: endTime - splitStart,
    elevationGainMeters: gain,
    elevationLossMeters: loss,
    normalizedWatts: np(),
    avgHeartrate: extras.heartrate ? hr.mean() : undefined,
    maxHeartrate: extras.heartrate ? hr.peak() : undefined,
    avgWatts: extras.watts ? watt.mean() : undefined,
    maxWatts: extras.watts ? watt.peak() : undefined,
    avgCadence: extras.cadence ? cad.mean() : undefined,
    avgSpeedMps: extras.speed ? spd.mean() : undefined,
    maxSpeedMps: extras.speed ? spd.peak() : undefined,
  });
  // Clear the per-split aggregates (channel means/maxes + the elevation
  // hysteresis gain/loss) WITHOUT moving the distance/time cursor. refEle is
  // intentionally left alone — the climb reference carries across boundaries.
  const clearAggregates = () => {
    gain = 0;
    loss = 0;
    sum4 = 0;
    cnt = 0;
    hr.reset();
    watt.reset();
    cad.reset();
    spd.reset();
  };
  const resetSplit = (endTime: number) => {
    acc -= intervalMeters;
    splitDist = 0;
    splitStart = endTime;
    clearAggregates();
  };
  // Accumulate sample i's channel/elevation/NP data into the currently-open
  // split. Used by the dense path (sample i lands in the split being built) and
  // by the gap path's remainder split (sample i is at the END of a big step).
  const accumulateSample = (i: number) => {
    const e = ele[i]!;
    if (!Number.isNaN(e) && !Number.isNaN(refEle)) {
      const d = e - refEle;
      if (d >= 3) {
        gain += d;
        refEle = e;
      } else if (d <= -3) {
        loss += -d;
        refEle = e;
      }
    } else if (!Number.isNaN(e)) {
      refEle = e;
    }
    if (npRolled) {
      const r = npRolled[i]!;
      if (Number.isFinite(r)) {
        sum4 += r ** 4;
        cnt += 1;
      }
    }
    if (extras.heartrate) hr.add(extras.heartrate[i]!);
    if (extras.watts) watt.add(extras.watts[i]!);
    if (extras.cadence) cad.add(extras.cadence[i]!);
    if (extras.speed) spd.add(extras.speed[i]!);
  };
  for (let i = 1; i < step.length; i++) {
    const dStep = step[i]!;
    splitDist += dStep;
    acc += dStep;
    if (dStep <= intervalMeters) {
      // ---- DENSE PATH ----------------------------------------------------
      // The step fits inside one interval, so (acc was < intervalMeters before
      // this step) it can close AT MOST one split. This branch is the original
      // algorithm untouched — dense, gap-free tracks stay byte-identical.
      accumulateSample(i);
      if (acc >= intervalMeters) {
        splits.push(emit(index++, splitDist, timeSec[i]!));
        resetSplit(timeSec[i]!);
      }
      continue;
    }

    // ---- GAP PATH --------------------------------------------------------
    // One step is larger than the interval — a GPS gap (tunnel, lost signal,
    // auto-pause) drops one big haversine step between consecutive fixes. The
    // original code closed only ONE split here and folded the rest of the
    // distance into it; instead we peel a split at EVERY interval boundary the
    // step spans, apportioning the step's distance and time linearly.
    //
    // The channel/elevation sample sits at the END of the step (sample i), so
    // it belongs only to the final (remainder) split. The synthetic peels in
    // between carry no channel samples (avg/max → undefined). Any aggregates
    // already accrued from earlier dense samples in the open split ride out on
    // the FIRST peel (that is, in time, where they physically landed).
    const openDist = splitDist; // full open-split distance, incl. this step
    const carried = acc - splitDist; // leftover offset from a prior overshoot
    const splitDistPrev = openDist - dStep; // distance accrued before this step
    const t0 = timeSec[i - 1] ?? splitStart;
    const t1 = timeSec[i]!;
    let bPrev = 0;
    // bk = open-split distance from splitStart to the next interval boundary.
    // Strict `<`: a step that ends exactly ON a boundary leaves a full-interval
    // remainder rather than a 0 m one, so the end-of-step sample (below) always
    // has a non-empty split to land in. The remainder is in (0, interval].
    for (
      let bk = intervalMeters - carried;
      bk < openDist;
      bk += intervalMeters
    ) {
      const endTime =
        dStep > 0 ? t0 + ((bk - splitDistPrev) / dStep) * (t1 - t0) : t1;
      splits.push(emit(index++, bk - bPrev, endTime));
      splitStart = endTime;
      clearAggregates();
      bPrev = bk;
    }
    // The leftover past the last boundary stays open as the remainder split. It
    // starts exactly on a boundary, so the carried offset resets to 0.
    splitDist = openDist - bPrev;
    acc = splitDist;
    accumulateSample(i);
  }
  if (splitDist > 1) {
    splits.push(emit(index, splitDist, timeSec[timeSec.length - 1]!));
  }
  return splits;
}

/** A running mean (of finite samples) + max — one per channel per split. NaN /
 *  non-finite samples are skipped, so a gap doesn't drag the average to 0. */
class MeanMax {
  private sum = 0;
  private n = 0;
  private hi = -Infinity;
  add(v: number): void {
    if (!Number.isFinite(v)) return;
    this.sum += v;
    this.n += 1;
    if (v > this.hi) this.hi = v;
  }
  mean(): number | undefined {
    return this.n > 0 ? this.sum / this.n : undefined;
  }
  peak(): number | undefined {
    return this.n > 0 ? this.hi : undefined;
  }
  reset(): void {
    this.sum = 0;
    this.n = 0;
    this.hi = -Infinity;
  }
}

/** A point on the elevation-vs-distance profile. */
export interface ProfilePoint {
  distanceMeters: number;
  elevationMeters: number;
}

/**
 * The elevation-vs-distance profile, resampled onto an even distance grid (also
 * **F-geo-2** — distance-domain, not time). We average elevation within each
 * distance bucket. Used for the profile chart and as the downsample for drawing.
 */
export function elevationProfile(
  cumDist: Float64Array,
  ele: Float64Array,
  bucketMeters = 100,
): ProfilePoint[] {
  return profileByDistance(cumDist, ele, bucketMeters).map((p) => ({
    distanceMeters: p.distanceMeters,
    elevationMeters: p.value,
  }));
}

/** A `(distance, value)` sample on a distance-domain channel profile. */
export interface ProfileSample {
  distanceMeters: number;
  /** Median of the raw samples in the bucket — robust to anomalies. */
  value: number;
  /** Outer band edge (low) — a low percentile, not the raw min. NaN if empty. */
  bandLo: number;
  /** Outer band edge (high) — a high percentile, not the raw max. */
  bandHi: number;
  /** Inner band edge (low) — the 25th percentile (the typical-range floor). */
  innerLo: number;
  /** Inner band edge (high) — the 75th percentile (the typical-range ceiling). */
  innerHi: number;
}

/** Fraction trimmed from EACH tail for the OUTER band edges (0.05 ⇒ p5..p95).
 *  The band/scale follow the central 90% so GPS-spike anomalies (speed
 *  especially) don't dominate. Tighten by raising this. */
const BAND_TAIL = 0.05;

/** The INNER band is the inter-quartile range (p25..p75) — the dense, typical
 *  middle half of each bucket. Drawn denser than the outer envelope. */
const INNER_LO_Q = 0.25;
const INNER_HI_Q = 0.75;

/** How far {@link bucketByColumn} carries the last value across empty bins
 *  before it gives up and breaks the line. Short gaps (a few missing samples)
 *  carry forward for continuity; a SUSTAINED hole — a dropped HR strap for an
 *  hour, a paused sensor — would otherwise draw a long flat line at a stale
 *  value, so beyond this distance we emit NaN and let the chart break instead
 *  of fabricating data. */
const MAX_CARRY_METERS = 1000;

/**
 * Resample ANY per-sample channel (elevation, hr, power, cadence, speed, …)
 * onto an even distance grid — the generalization of {@link elevationProfile}
 * to any value column. Per bucket: `value` is the **median** (robust), and
 * `bandLo`/`bandHi` are the central-90% **percentiles** (not raw min/max), so
 * a single anomalous sample can't set the band or the chart scale. `NaN`
 * (missing) samples are skipped; the last bucket carries forward so the line
 * stays continuous. F-geo-2 again: distance-domain bucketing of an arbitrary
 * value array (the `byColumn` primitive proposed to pond).
 */
export function profileByDistance(
  cumDist: Float64Array,
  values: Float64Array,
  bucketMeters = 100,
): ProfileSample[] {
  assertPositiveMeters(bucketMeters, 'bucketMeters');
  const total = cumDist[cumDist.length - 1] ?? 0;
  const nBuckets = Math.max(1, Math.ceil(total / bucketMeters));
  return bucketByColumn(cumDist, values, bucketMeters, 0, nBuckets);
}

/**
 * Like {@link profileByDistance} but buckets ONLY the samples whose cumulative
 * distance falls in `[startMeters, endMeters]`, at `bucketMeters` resolution.
 * Returned `distanceMeters` are absolute (offset by `startMeters`), so the
 * output drops straight into the same distance axis as the full-activity
 * profile. This is what lets the chart reveal fine detail when zoomed to a
 * locked split/lap — the bucket can be far finer than the whole-activity grid
 * (e.g. ~10 m vs 100 m) without paying to re-bucket the entire track. Buckets
 * here are aligned to `startMeters`, an independent grid from profileByDistance.
 */
export function profileByDistanceWindow(
  cumDist: Float64Array,
  values: Float64Array,
  startMeters: number,
  endMeters: number,
  bucketMeters = 25,
): ProfileSample[] {
  assertPositiveMeters(bucketMeters, 'bucketMeters');
  const span = Math.max(0, endMeters - startMeters);
  const nBuckets = Math.max(1, Math.ceil(span / bucketMeters));
  return bucketByColumn(
    cumDist,
    values,
    bucketMeters,
    startMeters,
    nBuckets,
    startMeters,
    endMeters,
  );
}

/** The 3-column series `bucketByColumn` feeds to pond's value-axis aggregator:
 *  a dummy time key (byColumn ignores the temporal axis), the distance the
 *  bin is keyed on, and the channel value being reduced. */
const PROFILE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number' },
  // optional so a missing/NaN sample can ride as `undefined` (validity bitmap);
  // pond's reducer non-finite policy then skips it. See F-geo-row-optional.
  { name: 'val', kind: 'number', required: false },
] as const;

/**
 * Distance-domain bucketing of an arbitrary value column — the line + band — via
 * pond's `byColumn` (the value-axis aggregator that landed for exactly this
 * friction, F-geo-2). Per bin: `value` is the **median**, `bandLo/bandHi` the
 * central-90% percentiles (`p5/p95`), `innerLo/innerHi` the IQR (`p25/p75`) —
 * all pond reducers, same linear-interpolated method we used by hand. We then
 * scatter the bins onto a FIXED `0..nBuckets-1` grid and **carry forward** across
 * empty bins (NaN before the first occupied), preserving the prior continuity
 * semantics. The final-boundary sample (`dist === total`) is clamped into the
 * last bin (as the old `Math.min` did) so the grids match exactly. `window`
 * restricts to `[start, end]`; `origin` aligns bin 0's left edge.
 */
function bucketByColumn(
  cumDist: Float64Array,
  values: Float64Array,
  bucketMeters: number,
  originMeters: number,
  nBuckets: number,
  startMeters?: number,
  endMeters?: number,
): ProfileSample[] {
  const top = originMeters + nBuckets * bucketMeters;
  const len = Math.min(cumDist.length, values.length);
  const rows: Array<[number, number, number | undefined]> = [];
  for (let i = 0; i < len; i++) {
    const d = cumDist[i]!;
    if (startMeters !== undefined && (d < startMeters || d > endMeters!))
      continue;
    const v = values[i]!;
    // clamp the boundary sample into the last bin (the old Math.min behaviour),
    // and drop NaN to `undefined` so pond's reducer non-finite policy skips it.
    rows.push([i, Math.min(d, top - 1e-6), Number.isNaN(v) ? undefined : v]);
  }
  const bins = rows.length
    ? new TimeSeries({
        name: 'profile',
        schema: PROFILE_SCHEMA,
        rows,
      }).byColumn(
        'dist',
        { width: bucketMeters, origin: originMeters },
        {
          value: { from: 'val', using: 'median' },
          bandLo: { from: 'val', using: `p${BAND_TAIL * 100}` },
          bandHi: { from: 'val', using: `p${(1 - BAND_TAIL) * 100}` },
          innerLo: { from: 'val', using: `p${INNER_LO_Q * 100}` },
          innerHi: { from: 'val', using: `p${INNER_HI_Q * 100}` },
          count: { from: 'val', using: 'count' },
        },
      )
    : [];
  const byIndex = new Map<number, (typeof bins)[number]>();
  for (const b of bins)
    byIndex.set(Math.round((b.start - originMeters) / bucketMeters), b);

  const out: ProfileSample[] = [];
  let lastV = 0;
  let lastLo = 0;
  let lastHi = 0;
  let lastILo = 0;
  let lastIHi = 0;
  let seen = false;
  // carry forward across short gaps, but break the line across a sustained hole
  // (see MAX_CARRY_METERS) rather than draw a long flat line at a stale value.
  const maxCarryBins = Math.max(1, Math.ceil(MAX_CARRY_METERS / bucketMeters));
  let emptyRun = 0;
  for (let i = 0; i < nBuckets; i++) {
    const b = byIndex.get(i);
    if (b && (b.count as number) > 0) {
      lastV = b.value as number;
      lastLo = b.bandLo as number;
      lastHi = b.bandHi as number;
      lastILo = b.innerLo as number;
      lastIHi = b.innerHi as number;
      seen = true;
      emptyRun = 0;
    } else {
      emptyRun++;
    }
    // draw the carried value only before the gap outgrows the carry window
    const live = seen && emptyRun <= maxCarryBins;
    out.push({
      distanceMeters: originMeters + i * bucketMeters,
      value: live ? lastV : NaN,
      bandLo: live ? lastLo : NaN,
      bandHi: live ? lastHi : NaN,
      innerLo: live ? lastILo : NaN,
      innerHi: live ? lastIHi : NaN,
    });
  }
  return out;
}

/** Percentile spread of the raw samples around a point — the variance band. */
export interface Spread {
  /** Outer envelope (p5..p95) — the full excursions. NaN if no samples. */
  bandLo: number;
  bandHi: number;
  /** Inner band (p25..p75) — the dense typical range. */
  innerLo: number;
  innerHi: number;
}

/**
 * Rolling percentile spread of a raw per-sample channel, evaluated at each
 * `distance` over a FIXED ±`radiusMeters` window of the raw samples — NOT the
 * chart's buckets. This is what makes the variance underlay zoom-stable: the
 * band measures the same real span of churn whether the chart is bucketed at
 * 100 m (whole ride) or 10 m (a locked split), so it blooms where effort was
 * genuinely punchy and pinches where steady, identically at every zoom. The
 * within-bucket percentiles in {@link profileByDistance} can't do this — their
 * width scales with bucket duration.
 *
 * pond 0.30's `rollingByColumn('dist', { radius, at: distances }, …)` owns the
 * whole thing: the raw samples are the rows, and `at` evaluates the ±radius
 * window + the four percentiles at each chart-grid center directly (one record
 * per center) — no interleave, no read-back bookkeeping. `cum` and `distances`
 * must both ascend (rollingByColumn enforces it). The `{ at }` option landed
 * for exactly this friction (F-rolling-by-row, resolved in 0.30).
 */
export function rollingSpread(
  cumDist: Float64Array,
  values: Float64Array,
  distances: number[],
  radiusMeters: number,
): Spread[] {
  const n = Math.min(cumDist.length, values.length);
  // The raw samples become the rows (NaN/±Inf → undefined so the percentile
  // reducer skips them); `distances` are passed as explicit window centers via
  // pond 0.30's `{ at }`, returning one record per center over the ±radius
  // window of surrounding samples. Both `dist` and `at` must be non-decreasing —
  // rollingByColumn throws otherwise, enforcing the ascending precondition.
  const rows: Array<[number, number, number | undefined]> = [];
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    rows.push([i, cumDist[i]!, Number.isFinite(v) ? v : undefined]);
  }
  const recs = new TimeSeries({
    name: 'spread',
    schema: PROFILE_SCHEMA,
    rows,
  }).rollingByColumn(
    'dist',
    { radius: radiusMeters, at: distances },
    {
      bandLo: { from: 'val', using: `p${BAND_TAIL * 100}` },
      bandHi: { from: 'val', using: `p${(1 - BAND_TAIL) * 100}` },
      innerLo: { from: 'val', using: `p${INNER_LO_Q * 100}` },
      innerHi: { from: 'val', using: `p${INNER_HI_Q * 100}` },
    },
  );
  return recs.map((r) => ({
    bandLo: (r.bandLo as number | undefined) ?? NaN,
    bandHi: (r.bandHi as number | undefined) ?? NaN,
    innerLo: (r.innerLo as number | undefined) ?? NaN,
    innerHi: (r.innerHi as number | undefined) ?? NaN,
  }));
}

/** Canonical distances (metres) for a run's best-efforts table: 400 m, ½ mi,
 *  1 K, 1 mi, 2 mi, 5 K, 10 K, half, full. */
export const BEST_EFFORT_DISTANCES = [
  400, 804.672, 1000, 1609.344, 3218.688, 5000, 10000, 21097.5, 42195,
];

/** A fastest-over-distance effort: the quickest time to cover `meters`. */
export interface DistanceEffort {
  meters: number;
  /** Fastest time over any window covering ≥ `meters`, seconds. */
  seconds: number;
  /** Mean HR over that fastest window, when an `hr` channel is supplied. */
  avgHeartrate?: number;
  /** Inclusive sample range of the fastest window — for focusing the chart/map
   *  on where the effort happened (maps to distance via `cumDist`). */
  startIndex?: number;
  endIndex?: number;
}

/**
 * Best efforts over distance: for each target distance, the fastest time over
 * any window covering at least that distance. The distance-axis analogue of the
 * power curve — a two-pointer over cumulative distance keeps the window just ≥
 * the target while minimising elapsed time, O(n) per distance. Times are clamped
 * non-decreasing across the (ascending) distance list. Hand-rolled: a fastest
 * rolling window over a derived monotonic axis + a multi-window sweep — the
 * `rollingSpread` / `F-power-curve` friction family (see docs/pond-friction.md).
 * `hr` (optional) yields the mean heart rate over each fastest window.
 * Precondition: `distances` must be ascending — the `> total` early-exit and the
 * non-decreasing-time clamp both rely on it (`BEST_EFFORT_DISTANCES` is).
 */
export function bestEffortsByDistance(
  cumDist: Float64Array,
  timeSec: Float64Array,
  distances: number[] = BEST_EFFORT_DISTANCES,
  hr?: Float64Array,
): DistanceEffort[] {
  const n = Math.min(cumDist.length, timeSec.length);
  const total = n > 0 ? cumDist[n - 1]! - cumDist[0]! : 0;
  const out: DistanceEffort[] = [];
  let prev = 0;
  for (const d of distances) {
    if (d > total) break;
    let best = Infinity;
    let bestLo = 0;
    let bestHi = 0;
    let lo = 0;
    for (let hi = 1; hi < n; hi++) {
      // advance lo to the tightest window ending at hi that still covers ≥ d
      while (lo + 1 < hi && cumDist[hi]! - cumDist[lo + 1]! >= d) lo++;
      if (cumDist[hi]! - cumDist[lo]! >= d) {
        const t = timeSec[hi]! - timeSec[lo]!;
        if (t < best) {
          best = t;
          bestLo = lo;
          bestHi = hi;
        }
      }
    }
    if (!Number.isFinite(best)) continue;
    // fastest time can only grow with distance; clamp the discrete-window blips.
    const seconds = Math.max(best, prev);
    prev = seconds;
    const e: DistanceEffort = {
      meters: d,
      seconds,
      startIndex: bestLo,
      endIndex: bestHi,
    };
    if (hr) {
      let sum = 0;
      let cnt = 0;
      for (let i = bestLo; i <= bestHi && i < hr.length; i++) {
        if (Number.isFinite(hr[i]!)) {
          sum += hr[i]!;
          cnt += 1;
        }
      }
      if (cnt > 0) e.avgHeartrate = sum / cnt;
    }
    out.push(e);
  }
  return out;
}

/**
 * The contiguous track pieces where a per-sample channel falls within
 * `[lo, hi]` (inclusive) — the selection driver behind zone / power-distribution
 * highlighting. A value predicate over the series yields the scattered stretches
 * of the ride that match (e.g. "every part in the Tempo HR band"). Non-finite
 * samples are out of range (they break a run). `cumDist` and `values` are
 * sample-aligned. Adjacent runs separated by ≤ `bridgeMeters` of out-of-range
 * distance merge into one (default 0 = faithful, no merge) so a momentary
 * excursion doesn't shatter the selection into hundreds of slivers. Each run
 * spans [cum at its first in-range sample, cum at its last]; a lone sample is a
 * zero-length segment at its point.
 *
 * Hand-rolled run-length encoding of a predicate over a value column: pond has
 * no contiguous-run / RLE-by-predicate primitive — it's the scan/segmentation
 * family (see docs/pond-friction.md, F-geo-2-splits / the proposed `scan`).
 */
export function segmentsInRange(
  cumDist: Float64Array,
  values: ArrayLike<number>,
  lo: number,
  hi: number,
  bridgeMeters = 0,
): Segment[] {
  const n = Math.min(cumDist.length, values.length);
  const raw: Segment[] = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (Number.isFinite(v) && v >= lo && v <= hi) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0) {
      raw.push({ startMeters: cumDist[start]!, endMeters: cumDist[end]! });
      start = -1;
    }
  }
  if (start >= 0)
    raw.push({ startMeters: cumDist[start]!, endMeters: cumDist[end]! });
  if (bridgeMeters <= 0 || raw.length < 2) return raw;
  // merge runs whose out-of-range gap is within bridgeMeters
  const merged: Segment[] = [{ ...raw[0]! }];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1]!;
    if (raw[i]!.startMeters - last.endMeters <= bridgeMeters)
      last.endMeters = raw[i]!.endMeters;
    else merged.push({ ...raw[i]! });
  }
  return merged;
}
