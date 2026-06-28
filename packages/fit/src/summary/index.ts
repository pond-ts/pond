/**
 * The activity summary: turn one activity's streams into the metrics + derived
 * series a Strava-class app shows — distance, moving time, elevation gain, the
 * map polyline, the elevation-vs-distance profile, per-km splits. This is the
 * domain layer over the pond-based geo operators in `../geo`.
 */
import { TimeSeries } from 'pond-ts';
import type { ImportedActivity, ActivityStreams, Lap } from '../types.js';
import * as geo from '../geo/index.js';
import type { Split, ProfilePoint, ProfileSample } from '../geo/index.js';

export type { Split, ProfilePoint, ProfileSample, Lap };

/** A channel that can be plotted against distance OR time on the DATA chart. */
export type ChannelKey =
  | 'elevation'
  | 'speed'
  | 'heartrate'
  | 'power'
  | 'cadence'
  | 'temperature';

/**
 * One resampled point carrying BOTH axes — distance and elapsed time — so the
 * chart can switch x-axis without recomputing. Buckets are even in distance;
 * `timeSeconds` is the elapsed time reached at that distance, so the time axis
 * spans 0 → total elapsed. `value` is native units (m, m/s, bpm, W, rpm, °C).
 */
export interface ChannelSample {
  distanceMeters: number;
  timeSeconds: number;
  /** Bucket median (the robust line). */
  value: number;
  /** Outer band edges — central-90% percentiles (the faint variance envelope). */
  bandLo: number;
  bandHi: number;
  /** Inner band edges — the inter-quartile range (the denser typical spread). */
  innerLo: number;
  innerHi: number;
  /** This bucket is a SUSTAINED coast (you stopped pedalling/moving for longer
   *  than the bridge window) on an output channel — value/band are NaN here, and
   *  the chart draws a drop-to-baseline rather than a line. Brief coasts aren't
   *  flagged: they stay real values and just dip the smoothed line. */
  coast: boolean;
}

/**
 * One channel resampled onto the grid. Only channels the activity actually
 * carries appear; the display layer converts native units.
 */
export interface ChannelProfile {
  key: ChannelKey;
  points: ChannelSample[];
}

/** Everything the activity summary holds, computed from one activity's streams. */
export interface ActivitySummary {
  startTimeUtc: string;
  pointCount: number;
  distanceMeters: number;
  /** Time the clock ran (last sample − first sample). */
  elapsedTimeSeconds: number;
  /** Time actually moving (speed above the stopped threshold). */
  movingTimeSeconds: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  /** `[[minLat, minLng], [maxLat, maxLng]]`, or null for a GPS-less activity. */
  bounds: [[number, number], [number, number]] | null;
  /** Douglas–Peucker-simplified `[lat, lng]` line for the map overview; empty
   *  for a GPS-less activity (no map). */
  polyline: Array<[number, number]>;
  /** Distance-grid profiles, one per present channel (elevation first). */
  channels: ChannelProfile[];
  /** Per-kilometre splits (computed, evenly spaced). */
  splits: Split[];
  /** Recorded laps (device-marked), if the source carried them. */
  laps: Lap[];
}

/** Options for {@link computeActivitySummary}. */
export interface ActivitySummaryOptions {
  /** Split interval in metres (default 1000 = per-km). */
  splitMeters?: number;
  /** Polyline simplification tolerance in metres (default 12). */
  simplifyMeters?: number;
  /** Channel-profile bucket width in metres (default 100). */
  profileBucketMeters?: number;
}

/**
 * Copy a per-sample array to a Float64Array, mapping every missing/non-finite
 * reading to NaN (so the bucketer skips it, not counts a false 0). Returns null
 * if the channel has no finite sample at all — it's then absent from the view.
 */
function cleanColumn(
  values: ArrayLike<number> | undefined,
): Float64Array | null {
  if (!values) return null;
  const arr = new Float64Array(values.length);
  let any = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (typeof v === 'number' && Number.isFinite(v)) {
      arr[i] = v;
      any = true;
    } else {
      arr[i] = NaN;
    }
  }
  return any ? arr : null;
}

/** Fixed window (±metres) for the variance band's rolling spread — see
 *  geo.rollingSpread. A real distance, not a bucket count, so the band is
 *  zoom-stable: the same ~quarter-km of churn whether the chart is at 100 m
 *  (whole ride) or 10 m (a locked split) buckets. */
const SPREAD_RADIUS_M = 120;

/** A reading at/under this is "off" — coasting (0 W / 0 rpm) or stopped (~0
 *  speed). */
const COAST_EPS = 0.5;
/** A coast run longer than this is "sustained" (drop to baseline); shorter runs
 *  are flicker (between pedal strokes, a momentary freewheel) and just dip the
 *  smoothed line. Pond's fill({maxGap}) draws the line. */
const COAST_MAX_GAP = '10s';
/** Output channels where 0 = "you stopped doing it" (a real coast), not a real
 *  reading. (HR 0 = a strap dropout → handled as missing, not coast.) */
const COAST_CHANNELS = new Set<ChannelKey>(['speed', 'power', 'cadence']);

/** A 0-bpm heart rate is a strap dropout, never a real reading — blank it to
 *  NaN (missing) so it bridges/breaks like other missing data, instead of the
 *  line diving to zero. (Power/cadence/speed keep their real 0s: those are
 *  coasts/stops, handled by the coast classifier.) */
function blankHrDropout(key: ChannelKey, arr: Float64Array): void {
  if (key !== 'heartrate') return;
  for (let i = 0; i < arr.length; i++) if (arr[i]! <= COAST_EPS) arr[i] = NaN;
}

/** A 2-column series for the coast run-length classifier: time + a fillable
 *  value (required:false so gap cells can be `undefined`). */
const COAST_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

/**
 * Per-sample mask of SUSTAINED coasting, using pond's `fill({maxGap})` as a
 * temporal run-length classifier: mark every coast/missing sample `undefined`,
 * fill gaps ≤ {@link COAST_MAX_GAP}, and whatever stays `undefined` was a run
 * longer than the cap. Of those, the ones that began as a real coast (a sub-eps
 * reading, not absent data) are the sustained coasts. Brief coasts come back
 * filled → not flagged → they stay real 0s and merely dip the line.
 */
function sustainedCoastMask(
  key: ChannelKey,
  values: Float64Array,
  timeSec: Float64Array,
): boolean[] {
  const n = values.length;
  const mask = new Array<boolean>(n).fill(false);
  if (!COAST_CHANNELS.has(key)) return mask;
  const wasCoast = new Array<boolean>(n).fill(false);
  const rows: Array<[number, number | undefined]> = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    const coast = Number.isFinite(v) && v <= COAST_EPS;
    wasCoast[i] = coast;
    // pond rejects NaN; a gap cell (coast or missing) is `undefined`.
    rows[i] = [
      Math.round(timeSec[i]! * 1000),
      coast || !Number.isFinite(v) ? undefined : v,
    ];
  }
  // After fill, a cell still UNDEFINED was a gap longer than maxGap — a
  // sustained run. (Read the validity bitmap, not toFloat64Array, which renders
  // a gap as 0 — see geo.readColumns.) Of those, the ones that began as a real
  // coast (not absent data) are the sustained coasts we flag.
  // hold (forward) bridges interior + trailing gaps ≤ maxGap; it can't touch a
  // LEADING gap (no left neighbour), so a coast at sample 0 would always look
  // sustained — chain bfill to bridge a brief leading run from its right side.
  const filledCol = new TimeSeries({
    name: 'coast',
    schema: COAST_SCHEMA,
    rows,
  })
    .fill('hold', { maxGap: COAST_MAX_GAP })
    .fill('bfill', { maxGap: COAST_MAX_GAP })
    .column('v');
  const validity = filledCol.validity;
  const hasMissing = filledCol.hasMissing();
  for (let i = 0; i < n; i++) {
    const stillGap = hasMissing && validity ? !validity.isDefined(i) : false;
    mask[i] = !!wasCoast[i] && stillGap;
  }
  return mask;
}

/** Bucket the per-sample coast mask onto a profile's distance grid: a bucket is
 *  a coast if ≥ half its samples are sustained-coast. `cum`/`distances` ascend;
 *  a two-pointer keeps it ~O(samples + buckets). */
function bucketCoast(
  distances: number[],
  bucketMeters: number,
  cum: Float64Array,
  mask: boolean[],
): boolean[] {
  const n = Math.min(cum.length, mask.length);
  const out = new Array<boolean>(distances.length).fill(false);
  let p = 0;
  for (let b = 0; b < distances.length; b++) {
    const lo = distances[b]!;
    const hi = lo + bucketMeters;
    while (p < n && cum[p]! < lo) p++;
    let coast = 0;
    let total = 0;
    let q = p;
    while (q < n && cum[q]! < hi) {
      total++;
      if (mask[q]!) coast++;
      q++;
    }
    out[b] = total > 0 && coast * 2 >= total;
  }
  return out;
}

/**
 * Zip a distance-bucketed profile with the matching time axis (`timeProf`, same
 * bucketing) and the rolling variance spread into a ChannelProfile. The band
 * edges come from `spread` (a fixed-window percentile of the raw samples), NOT
 * the profile's within-bucket percentiles. Sustained-coast buckets (`coast[i]`)
 * have value + band NaN'd and carry the flag, so the chart breaks the line and
 * draws a drop there.
 */
function zipProfile(
  key: ChannelKey,
  prof: ProfileSample[],
  timeProf: ProfileSample[],
  spread: geo.Spread[],
  coast: boolean[],
): ChannelProfile {
  return {
    key,
    points: prof.map((p, i) => {
      const isCoast = coast[i] ?? false;
      return {
        distanceMeters: p.distanceMeters,
        timeSeconds: timeProf[i]?.value ?? 0,
        value: isCoast ? NaN : p.value,
        bandLo: isCoast ? NaN : (spread[i]?.bandLo ?? NaN),
        bandHi: isCoast ? NaN : (spread[i]?.bandHi ?? NaN),
        innerLo: isCoast ? NaN : (spread[i]?.innerLo ?? NaN),
        innerHi: isCoast ? NaN : (spread[i]?.innerHi ?? NaN),
        coast: isCoast,
      };
    }),
  };
}

/** Build one channel over the whole track at `bucketMeters`, or null if empty.
 *  `timeSec` is the per-sample time (for the coast classifier). */
function channelProfile(
  key: ChannelKey,
  values: ArrayLike<number> | undefined,
  cum: Float64Array,
  mask: boolean[] | undefined,
  bucketMeters: number,
  timeProf: ProfileSample[],
): ChannelProfile | null {
  const arr = cleanColumn(values);
  if (!arr) return null;
  blankHrDropout(key, arr);
  const prof = geo.profileByDistance(cum, arr, bucketMeters);
  const dists = prof.map((p) => p.distanceMeters);
  const spread = geo.rollingSpread(cum, arr, dists, SPREAD_RADIUS_M);
  const coast = bucketCoast(dists, bucketMeters, cum, mask ?? []);
  return zipProfile(key, prof, timeProf, spread, coast);
}

/** Build one channel within a distance window at `bucketMeters` (fine grid). */
function windowChannelProfile(
  key: ChannelKey,
  values: ArrayLike<number> | undefined,
  cum: Float64Array,
  mask: boolean[] | undefined,
  startMeters: number,
  endMeters: number,
  bucketMeters: number,
  timeProf: ProfileSample[],
): ChannelProfile | null {
  const arr = cleanColumn(values);
  if (!arr) return null;
  blankHrDropout(key, arr);
  const prof = geo.profileByDistanceWindow(
    cum,
    arr,
    startMeters,
    endMeters,
    bucketMeters,
  );
  const dists = prof.map((p) => p.distanceMeters);
  // spread + coast use the FULL cum/arr/mask (not just the window) so edges near
  // the window's ends still see their ±radius of raw samples / surrounding runs.
  const spread = geo.rollingSpread(cum, arr, dists, SPREAD_RADIUS_M);
  const coast = bucketCoast(dists, bucketMeters, cum, mask ?? []);
  return zipProfile(key, prof, timeProf, spread, coast);
}

/**
 * Trailing `windowSec` boxcar mean (the NP smoothing), NaN-skipping. A small
 * array-side rolling, deliberately separate from `power.normalizedPower`'s
 * pond-based `rolling('30s')`: per-split NP would otherwise build ~one pond
 * series per split. It's a time-windowed mean (gaps just yield fewer samples,
 * never credited time), and reconciles with the pond path to rounding on real
 * 1 Hz data (151.7 vs 152 W on Vineman).
 */
function rolling(
  values: Float64Array,
  timeSec: Float64Array,
  windowSec = 30,
): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  let lo = 0;
  let sum = 0;
  let cnt = 0;
  for (let hi = 0; hi < n; hi++) {
    if (Number.isFinite(values[hi]!)) {
      sum += values[hi]!;
      cnt += 1;
    }
    while (lo < hi && timeSec[hi]! - timeSec[lo]! > windowSec) {
      if (Number.isFinite(values[lo]!)) {
        sum -= values[lo]!;
        cnt -= 1;
      }
      lo += 1;
    }
    out[hi] = cnt > 0 ? sum / cnt : NaN;
  }
  return out;
}

/**
 * Build the canonical pond series from an activity's streams (timeSeconds are
 * offsets). Works for GPS and GPS-less alike: lat/lng are `undefined` when the
 * source had no positions, so the series is then just time + the recorded
 * channels. The sample count is the positions when present, else the longest
 * recorded channel.
 */
export function buildTrackFromStreams(
  name: string,
  streams: ActivityStreams,
  startMs: number,
): geo.TrackSeries {
  const {
    latlng,
    altitudeMeters,
    timeSeconds,
    heartrate,
    watts,
    cadence,
    temperatureC,
  } = streams;
  const distanceMeters = streams.distanceMeters;
  // Sample count: positions when present, else the longest recorded channel. The
  // parsers (gpx/tcx/fit) build every channel by mapping one sample list, so all
  // present channels are equal-length — the tie-break order here is moot.
  const n = Math.max(
    latlng.length,
    timeSeconds?.length ?? 0,
    distanceMeters?.length ?? 0,
    heartrate?.length ?? 0,
    watts?.length ?? 0,
    cadence?.length ?? 0,
    temperatureC?.length ?? 0,
  );
  // Missing/non-finite → `undefined` (NOT 0, a valid reading). pond rejects
  // null/NaN but accepts undefined for required:false columns and records it in
  // the validity bitmap, so the gap stays a gap — lossless; readColumns reads it
  // back as NaN.
  const cell = (a: number[] | undefined, i: number): number | undefined => {
    const v = a?.[i];
    return v != null && Number.isFinite(v) ? v : undefined;
  };
  const points: geo.TrackPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ms = startMs + (timeSeconds?.[i] ?? i) * 1000;
    const pos = latlng[i];
    points[i] = [
      ms,
      pos ? pos[0] : undefined,
      pos ? pos[1] : undefined,
      cell(altitudeMeters, i),
      cell(heartrate, i),
      cell(watts, i),
      cell(cadence, i),
      cell(temperatureC, i),
      cell(distanceMeters, i),
    ];
  }
  return geo.buildTrack(name, points);
}

/**
 * The streams decoded once into the per-sample arrays every downstream metric
 * reads — track, columns, cumulative distance, derived speed, relative time.
 * Building the pond track + reading columns is the expensive part of the
 * summary compute, so {@link prepareActivity} does it once and both the summary
 * ({@link summaryFromPrepared}) and the zoom-resolution profiles
 * ({@link windowChannels}) reuse it — no second decode per zoom. Opaque shape;
 * treat it as a handle, not a public data contract.
 */
export interface PreparedActivity {
  imported: ImportedActivity;
  /** The canonical pond series — always present (GPS or GPS-less). `hasTrack`
   *  says whether it carries positions. */
  track: geo.TrackSeries;
  cols: ReturnType<typeof geo.readColumns>;
  cum: Float64Array;
  step: Float64Array;
  /** Derived instantaneous speed (m/s); NaN where no timestamp delta. */
  speed: Float64Array;
  /** Elapsed seconds since the first sample. */
  timeRel: Float64Array;
  n: number;
  /** Whether the source carried timestamps (so speed is meaningful). */
  hasTime: boolean;
  /** Whether the activity has a GPS track. False for GPS-less sources (indoor /
   *  GPS-off head units): no map, distance comes from the device stream. */
  hasTrack: boolean;
  /** Per-sample sustained-coast mask per output channel (speed/power/cadence),
   *  computed ONCE here (it's window-independent and the pond-fill pass is the
   *  expensive part) and reused by every channel build / zoom. */
  coastMasks: Partial<Record<ChannelKey, boolean[]>>;
}

/** Cumulative distance from the device's `distance` column (clamped
 *  non-decreasing so splits/byColumn hold) — the GPS-less distance axis;
 *  all-zero when the source recorded no distance (a pure-HR indoor session). */
function cumFromCols(
  distance: Float64Array | undefined,
  n: number,
): Float64Array {
  const cum = new Float64Array(n);
  if (!distance) return cum;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = distance[i];
    prev = typeof v === 'number' && Number.isFinite(v) && v > prev ? v : prev;
    cum[i] = prev;
  }
  return cum;
}

/** Decode an activity's streams into the shared per-sample arrays. ONE path now:
 *  build the canonical series, read its columns; distance comes from haversine
 *  when there are positions, else the device `distance` column (GPS-less). */
export function prepareActivity(imported: ImportedActivity): PreparedActivity {
  const { activity, streams } = imported;
  const startMs = Date.parse(activity.startTimeUtc);
  const track = buildTrackFromStreams(activity.name, streams, startMs);
  const cols = geo.readColumns(track);
  const n = cols.timeSec.length;
  const hasTrack = cols.lat.length > 0;

  let step: Float64Array;
  let cum: Float64Array;
  if (hasTrack) {
    step = geo.stepDistances(cols.lat, cols.lng);
    cum = geo.cumulative(step);
  } else {
    cum = cumFromCols(cols.distance, n);
    step = new Float64Array(n);
    for (let i = 1; i < n; i++) step[i] = cum[i]! - cum[i - 1]!;
  }

  // instantaneous speed (m/s) derived from the track — a channel even when the
  // source never recorded one. Only meaningful with real timestamps.
  const speed = new Float64Array(n);
  speed[0] = NaN;
  for (let i = 1; i < n; i++) {
    const dt = cols.timeSec[i]! - cols.timeSec[i - 1]!;
    speed[i] = dt > 0 ? step[i]! / dt : NaN;
  }

  const timeRel = new Float64Array(n);
  for (let i = 0; i < n; i++) timeRel[i] = cols.timeSec[i]! - cols.timeSec[0]!;

  // sustained-coast masks for the output channels — once, not per zoom. Power /
  // cadence from the canonical `cols`; speed is the derived track speed.
  const coastMasks: Partial<Record<ChannelKey, boolean[]>> = {};
  const maskSources: Array<[ChannelKey, ArrayLike<number> | undefined]> = [
    ['speed', streams.timeSeconds ? speed : undefined],
    ['power', cols.power],
    ['cadence', cols.cadence],
  ];
  for (const [k, vals] of maskSources) {
    const a = cleanColumn(vals);
    if (a) coastMasks[k] = sustainedCoastMask(k, a, cols.timeSec);
  }

  return {
    imported,
    track,
    cols,
    cum,
    step,
    speed,
    timeRel,
    n,
    hasTime: !!streams.timeSeconds,
    hasTrack,
    coastMasks,
  };
}

/** The raw per-sample array backing each channel, in display order (elevation
 *  first). One source of truth for which stream feeds which channel, and the
 *  emit order — shared by the whole-track build and the windowed (zoom) build
 *  so they can't drift. Only present (non-null) channels are emitted. */
function channelInputs(
  prep: PreparedActivity,
): { key: ChannelKey; values: ArrayLike<number> | undefined }[] {
  // Sourced from the canonical `cols` — power/cadence/temp/hr now live in the
  // series (GPS) or the GPS-less `cols`, not the orphaned `streams` arrays.
  // (channelProfile still applies cleanColumn + blankHrDropout downstream, so the
  // NaN-for-missing columns behave exactly as the raw streams did.)
  const { cols } = prep;
  return [
    { key: 'elevation', values: cols.ele },
    { key: 'speed', values: prep.hasTime ? prep.speed : undefined },
    { key: 'heartrate', values: cols.hr },
    { key: 'power', values: cols.power },
    { key: 'cadence', values: cols.cadence },
    { key: 'temperature', values: cols.temp },
  ];
}

/** All present channels over the whole track at `bucketMeters` (display order). */
function buildChannels(
  prep: PreparedActivity,
  bucketMeters: number,
): ChannelProfile[] {
  const timeProf = geo.profileByDistance(prep.cum, prep.timeRel, bucketMeters);
  return channelInputs(prep)
    .map((c) =>
      channelProfile(
        c.key,
        c.values,
        prep.cum,
        prep.coastMasks[c.key],
        bucketMeters,
        timeProf,
      ),
    )
    .filter((c): c is ChannelProfile => c != null);
}

/** Options for {@link windowChannels}. */
export interface WindowChannelOptions {
  startMeters: number;
  endMeters: number;
  /** Target number of buckets across the window (default 160). The bucket width
   *  is the window span / this, clamped to [minBucketMeters, maxBucketMeters]. */
  targetBuckets?: number;
  /** Floor on bucket width, m — don't out-resolve the raw sampling (default 5). */
  minBucketMeters?: number;
  /** Ceiling on bucket width, m — never coarser than the overview (default 100). */
  maxBucketMeters?: number;
}

/**
 * Re-bucket the channels at high resolution within a distance window — the
 * chart's payoff when a split/lap is locked and zoomed: the same lines, but
 * resolved to ~10 m instead of the whole-activity 100 m grid, revealing detail
 * the overview averages away. Distances are absolute, so the result drops into
 * the same axis as {@link ActivitySummary.channels} and the chart's range clip.
 */
export function windowChannels(
  prep: PreparedActivity,
  opts: WindowChannelOptions,
): ChannelProfile[] {
  const {
    startMeters,
    endMeters,
    targetBuckets = 160,
    minBucketMeters = 5,
    maxBucketMeters = 100,
  } = opts;
  const span = Math.max(0, endMeters - startMeters);
  const bucket = Math.min(
    maxBucketMeters,
    Math.max(minBucketMeters, span / targetBuckets),
  );
  const timeProf = geo.profileByDistanceWindow(
    prep.cum,
    prep.timeRel,
    startMeters,
    endMeters,
    bucket,
  );
  return channelInputs(prep)
    .map((c) =>
      windowChannelProfile(
        c.key,
        c.values,
        prep.cum,
        prep.coastMasks[c.key],
        startMeters,
        endMeters,
        bucket,
        timeProf,
      ),
    )
    .filter((c): c is ChannelProfile => c != null);
}

/** The full activity summary from already-prepared streams (single decode). */
export function summaryFromPrepared(
  prep: PreparedActivity,
  options: ActivitySummaryOptions = {},
): ActivitySummary {
  const {
    splitMeters = 1000,
    simplifyMeters = 12,
    profileBucketMeters = 100,
  } = options;
  const { imported, track, cols, cum, step, n } = prep;
  const { activity } = imported;

  const { gainMeters, lossMeters } = geo.elevationGainLoss(cols.ele);

  // map outputs only exist for a GPS activity; GPS-less ⇒ no polyline / bounds.
  const latlng: Array<[number, number]> = prep.hasTrack ? new Array(n) : [];
  if (prep.hasTrack)
    for (let i = 0; i < n; i++) latlng[i] = [cols.lat[i]!, cols.lng[i]!];

  const channels = buildChannels(prep, profileBucketMeters);

  // cleaned per-sample power (NaN for gaps) — feeds both NP rolling and the
  // per-split avg/max watts. Sourced from the canonical `cols` (cleanColumn
  // copies, so blanking below can't mutate the shared column).
  const watts = cleanColumn(cols.power);
  // per-split normalized power needs the 30 s-rolled power (NP smoothing)
  const npRolled = watts ? rolling(watts, cols.timeSec, 30) : undefined;
  // per-split channel aggregates (avg + max): HR / cadence from `cols`, speed
  // from the derived track speed (prepared once). Blank HR dropouts (0 / -1
  // sentinels) so a dropped-strap split reports no HR, not a fake -1.
  const hr = cleanColumn(cols.hr);
  if (hr) blankHrDropout('heartrate', hr);
  const splitExtras: geo.SplitExtras = {
    heartrate: hr ?? undefined,
    watts: watts ?? undefined,
    cadence: cleanColumn(cols.cadence) ?? undefined,
    speed: prep.hasTime ? prep.speed : undefined,
  };

  return {
    startTimeUtc: activity.startTimeUtc,
    pointCount: n,
    distanceMeters: cum[n - 1] ?? 0,
    elapsedTimeSeconds: n > 1 ? cols.timeSec[n - 1]! - cols.timeSec[0]! : 0,
    movingTimeSeconds: geo.movingTimeSeconds(step, cols.timeSec),
    elevationGainMeters: gainMeters,
    elevationLossMeters: lossMeters,
    bounds: prep.hasTrack && track ? geo.boundsViaPond(track) : null,
    polyline: prep.hasTrack ? geo.simplify(latlng, simplifyMeters) : [],
    channels,
    splits: geo.splitsByDistance(
      step,
      cols.timeSec,
      cols.ele,
      splitMeters,
      npRolled,
      splitExtras,
    ),
    laps: imported.laps ?? [],
  };
}

/** Compute the full activity summary for one imported activity. */
export function computeActivitySummary(
  imported: ImportedActivity,
  options: ActivitySummaryOptions = {},
): ActivitySummary {
  // Truly empty only when there are NO samples at all — no positions, no
  // distance, no time. A GPS-less source (positions empty but distance/time
  // present) flows through prepareActivity to a track-less, map-less activity.
  const s = imported.streams;
  const empty =
    s.latlng.length === 0 &&
    !(s.distanceMeters?.length ?? 0) &&
    !(s.timeSeconds?.length ?? 0) &&
    !(s.heartrate?.length ?? 0) &&
    !(s.watts?.length ?? 0);
  if (empty) {
    return {
      startTimeUtc: imported.activity.startTimeUtc,
      pointCount: 0,
      distanceMeters: 0,
      elapsedTimeSeconds: 0,
      movingTimeSeconds: 0,
      elevationGainMeters: 0,
      elevationLossMeters: 0,
      bounds: null,
      polyline: [],
      channels: [],
      splits: [],
      laps: imported.laps ?? [],
    };
  }
  return summaryFromPrepared(prepareActivity(imported), options);
}
