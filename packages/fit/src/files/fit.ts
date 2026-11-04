import {
  parseFitBytes,
  type FitData,
  type FitRecord,
  type FitLap,
} from './fitParser.js';
import { fitRecovery } from './recovery.js';
import { swimMovingSeconds } from '../swim.js';
import type {
  ActivityMeta,
  ActivityStreams,
  ImportedActivity,
  FileCreator,
  Lap,
  SwimData,
  SwimLength,
} from '../types.js';
import { compact, type ReadOptions } from './options.js';

/** The `file_id` message: who made the device and which one it is. */
type FileId = {
  manufacturer?: number | string;
  product?: number;
  product_name?: string;
};

/**
 * Parse a FIT file (binary, the rich device format) into an
 * {@link ImportedActivity}. FIT routinely carries real power, cadence and
 * temperature, laps, the swim watch's lengths, and the device. Decoded with
 * `fit-file-parser`, then projected to parallel stream arrays. `timeSeconds`
 * are offsets from the first sample; absent optional channels are omitted.
 * Name: `options.name`, else "Untitled"; sport: `options.sportType`, else the
 * file's sport as a Strava-style label (see {@link fitSport}); id:
 * `options.id`, else `fit:<start time>`.
 */
export function parseFit(
  buffer: ArrayBuffer | Uint8Array,
  options: ReadOptions = {},
): ImportedActivity {
  const data = parseFitBytes(buffer);

  // Every timed record is kept. GPS mode = at least one record with a fix; a
  // record with no fix gets a null position. Those are the minutes before the
  // watch finds satellites (a Venu Sq run, 2026: 5 minutes, 556 m by the
  // watch's motion sensor) or a dropout; the watch keeps counting distance
  // and heart rate through them, and the summary then measures by the
  // watch's distance. A file with NO positions is a GPS-less activity — a
  // pool swim, strength session, trainer ride, or GPS-off recording: latlng
  // stays empty and the device's per-record `distance` is the distance axis,
  // as parseTcx does.
  const fix = (r: FitRecord) =>
    r.position_lat != null && r.position_long != null;
  const recs: FitRecord[] = (data.records ?? []).filter(
    (r) => r.timestamp != null,
  );
  if (recs.length === 0) throw new Error('FIT has no timed records');
  const fixes = recs.filter(fix).length;
  const gps = fixes > 0;
  const gaps = gps && fixes < recs.length;

  const latlng: Array<[number, number] | null> = [];
  const altitudeMeters: number[] = [];
  const heartrate: number[] = [];
  const watts: number[] = [];
  const cadence: number[] = [];
  const temperatureC: number[] = [];
  const distanceMeters: number[] = [];
  const epochMs: number[] = [];
  let hasEle = false;
  let hasHr = false;
  let hasWatts = false;
  let hasCadence = false;
  let hasTemp = false;
  let hasDist = false;

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  for (const r of recs) {
    if (gps)
      latlng.push(
        fix(r) ? [r.position_lat as number, r.position_long as number] : null,
      );
    epochMs.push(+new Date(r.timestamp as Date | string));

    // Newer Garmin watches (a Venu Sq, 2026) write only enhanced_altitude.
    const a = num(r.altitude) ?? num(r.enhanced_altitude);
    altitudeMeters.push(a ?? NaN);
    if (a != null) hasEle = true;
    const hr = num(r.heart_rate);
    heartrate.push(hr ?? NaN);
    if (hr != null) hasHr = true;
    const p = num(r.power);
    watts.push(p ?? NaN);
    if (p != null) hasWatts = true;
    const c = num(r.cadence);
    cadence.push(c ?? NaN);
    if (c != null) hasCadence = true;
    const t = num(r.temperature);
    temperatureC.push(t ?? NaN);
    if (t != null) hasTemp = true;
    const d = num(r.distance);
    distanceMeters.push(d ?? NaN);
    if (d != null) hasDist = true;
  }

  const startMs = epochMs[0]!;
  const timeSeconds = epochMs.map((t) => (t - startMs) / 1000);

  // Recorded laps (device-marked), if present. Units already follow the parser
  // options (m/s, m); work is joules → kJ, calories are kcal. startDistance is
  // accumulated from prior laps so each lap knows its [start, end] range into
  // the activity (for chart bands + map highlighting downstream).
  const laps = projectLaps(data.laps ?? []);

  const streams: ActivityStreams = { latlng, timeSeconds };
  if (hasEle) streams.altitudeMeters = altitudeMeters;
  if (hasHr) streams.heartrate = heartrate;
  if (hasWatts) streams.watts = watts;
  if (hasCadence) streams.cadence = cadence;
  if (hasTemp) streams.temperatureC = temperatureC;
  const name = options.name ?? 'Untitled';
  const sportType = options.sportType ?? fitSport(data) ?? 'Unknown';
  // An open water swim: the watch gets a fix only when the wrist leaves the
  // water, so the joined fixes zigzag and measure far too long. The watch's
  // own distance is filtered; mark the swim so the summary measures by that
  // and draws a cleaned line on the map.
  const sub = fitSubSport(data);
  const openWater =
    gps &&
    sub !== 'lap_swimming' &&
    (sub === 'open_water' || /swim/i.test(sportType));
  if (openWater) streams.openWater = true;
  // Otherwise only GPS-less, or with samples that have no fix: a GPS file
  // with a fix on every sample measures its track, and leaving the watch's
  // distance out keeps those imports as they were.
  if ((openWater || !gps || gaps) && hasDist)
    streams.distanceMeters = distanceMeters;
  const startTimeLocal = fitLocalStart(data, startMs);
  const id = options.id ?? `fit:${new Date(startMs).toISOString()}`;
  const activity: ActivityMeta = {
    id,
    source: options.source ?? 'file',
    externalId: id,
    name,
    startTimeUtc: new Date(startMs).toISOString(),
    ...(startTimeLocal ? { startTimeLocal } : {}),
    distanceMeters: 0,
    movingTimeSeconds: 0,
    elapsedTimeSeconds: 0,
    elevationGainMeters: 0,
    sportType,
  };

  const swim = /swim/i.test(sportType) ? fitSwim(data, laps) : undefined;
  const fileId =
    (data.file_ids as FileId[] | undefined)?.[0] ??
    (data.file_id as FileId | undefined);
  const creator = fileId ? fitCreator(fileId) : undefined;
  // The heart rate a Garmin watch took after the stop.
  const recovery = fitRecovery(data);
  // one session's timer is the activity's; a multisport file's legs each
  // have their own, so none is claimed for the whole
  const sessions = data.sessions as Record<string, unknown>[] | undefined;
  const sessionTimer =
    sessions?.length === 1 ? num(sessions[0]!.total_timer_time) : undefined;
  return {
    activity,
    streams,
    laps,
    ...(sessionTimer !== undefined ? { timerSeconds: sessionTimer } : {}),
    ...(swim ? { swim } : {}),
    ...(creator ? { creator } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

/** The `file_id`'s maker and product as the file states them. */
function fitCreator(fileId: FileId): FileCreator | undefined {
  const out: FileCreator = {};
  if (fileId.manufacturer != null) out.manufacturer = fileId.manufacturer;
  if (typeof fileId.product === 'number') out.product = fileId.product;
  const name =
    typeof fileId.product_name === 'string'
      ? fileId.product_name.replace(/\0/g, '').trim()
      : '';
  if (name) out.name = name;
  return Object.keys(out).length ? out : undefined;
}

/**
 * A swim's own record (see {@link SwimData}): the time spent swimming from the
 * laps that covered distance, and for a pool swim the pool and every length
 * (rests at the wall included, marked inactive). Undefined when the file has
 * no lap with distance to count.
 */
export function fitSwim(
  data: FitData,
  laps: readonly Lap[],
): SwimData | undefined {
  const movingSeconds = swimMovingSeconds(laps);
  if (movingSeconds === undefined) return undefined;
  const swim: SwimData = { movingSeconds };

  const session = (data.sessions as Record<string, unknown>[] | undefined)?.[0];
  const poolLength = session?.pool_length;
  if (typeof poolLength === 'number' && poolLength > 0) {
    // FIT says "statute" for a pool measured in yards.
    const unit = session?.pool_length_unit === 'statute' ? 'yd' : 'm';
    swim.pool = { lengthMeters: poolLength, unit };
  }

  const lengths: SwimLength[] = [];
  for (const l of (data.lengths as Record<string, unknown>[] | undefined) ??
    []) {
    const startTimeUtc = toIsoOrUndefined(
      l.start_time as Date | string | undefined,
    );
    const seconds = l.total_timer_time ?? l.total_elapsed_time;
    if (
      !startTimeUtc ||
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds)
    )
      continue;
    const active = l.length_type === 'active';
    const length: SwimLength = { startTimeUtc, seconds, active };
    if (active && typeof l.total_strokes === 'number')
      length.strokes = l.total_strokes;
    if (active && typeof l.swim_stroke === 'string')
      length.stroke = l.swim_stroke;
    lengths.push(length);
  }
  if (lengths.length) swim.lengths = lengths;
  return swim;
}

/** FIT's sport names → the labels Strava uses, so a dropped file groups
 *  with the same sport imported from Strava. */
const FIT_SPORTS: Record<string, string> = {
  running: 'Run',
  cycling: 'Ride',
  swimming: 'Swim',
  walking: 'Walk',
  hiking: 'Hike',
  rowing: 'Rowing',
  cross_country_skiing: 'NordicSki',
  alpine_skiing: 'AlpineSki',
  training: 'Workout',
};

/** The sport the device recorded (the session's, else the sport message's),
 *  as a Strava-style label; the device's own profile name for a sport not in
 *  the list; undefined when the file names none. */
export function fitSport(data: FitData): string | undefined {
  const first = (k: string) =>
    (data[k] as Record<string, unknown>[] | undefined)?.[0];
  const session = first('sessions');
  const sports = first('sports');
  const sport = (session?.sport ?? sports?.sport) as string | undefined;
  if (sport && FIT_SPORTS[sport]) return FIT_SPORTS[sport];
  // Some watches record an open water swim as sport "generic".
  if (fitSubSport(data) === 'open_water') return 'Swim';
  const profile = (session?.sport_profile_name ?? sports?.name) as
    | string
    | undefined;
  if (typeof profile === 'string' && profile.trim()) return profile.trim();
  if (sport && sport !== 'generic')
    return sport.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return undefined;
}

/** The session's sub-sport as the file names it ("open_water",
 *  "lap_swimming", "trail"…), else the sport message's; undefined when neither
 *  names one. */
export function fitSubSport(data: FitData): string | undefined {
  const first = (k: string) =>
    (data[k] as Record<string, unknown>[] | undefined)?.[0];
  const sub = first('sessions')?.sub_sport ?? first('sports')?.sub_sport;
  return typeof sub === 'string' ? sub : undefined;
}

/** The start on the wall clock where the activity happened
 *  ("2019-11-16T07:08:14", no zone), from the activity message's
 *  `local_timestamp` beside its UTC `timestamp`; undefined when the file has
 *  no local time. */
export function fitLocalStart(
  data: FitData,
  startMs: number,
): string | undefined {
  const act = data.activity as Record<string, unknown> | undefined;
  const ms = (v: unknown) =>
    v instanceof Date || typeof v === 'string' ? new Date(v).getTime() : NaN;
  const utc = ms(act?.timestamp);
  const local = ms(act?.local_timestamp);
  if (Number.isNaN(utc) || Number.isNaN(local)) return undefined;
  const offset = local - utc;
  // Real zones sit within ±14 h; anything else is a bad field.
  if (Math.abs(offset) > 14 * 3600_000) return undefined;
  return new Date(startMs + offset).toISOString().slice(0, 19);
}

/** A FIT date field → ISO string, or undefined if absent/invalid. A single
 *  corrupt lap timestamp must not throw and abort the whole import (RangeError
 *  from `new Date('garbage').toISOString()`), so validity is checked, not just
 *  truthiness. */
export function toIsoOrUndefined(
  v: Date | string | undefined,
): string | undefined {
  if (v == null) return undefined;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Project raw FIT laps to {@link Lap}s, accumulating start distance. */
function projectLaps(raw: FitLap[]): Lap[] {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const laps: Lap[] = [];
  let startDistanceMeters = 0;
  raw.forEach((l, i) => {
    const distanceMeters = num(l.total_distance) ?? 0;
    const workJ = num(l.total_work);
    laps.push(
      compact<Lap>({
        index: i + 1,
        startTimeUtc: toIsoOrUndefined(
          (l.start_time ?? l.timestamp) as Date | string | undefined,
        ),
        startDistanceMeters,
        distanceMeters,
        elapsedSeconds: num(l.total_elapsed_time) ?? 0,
        movingSeconds:
          num(l.total_timer_time) ?? num(l.total_elapsed_time) ?? 0,
        timerSeconds: num(l.total_timer_time),
        avgSpeedMps: num(l.avg_speed),
        maxSpeedMps: num(l.max_speed),
        avgWatts: num(l.avg_power),
        maxWatts: num(l.max_power),
        avgHeartrate: num(l.avg_heart_rate),
        maxHeartrate: num(l.max_heart_rate),
        totalWorkKj: workJ != null ? workJ / 1000 : undefined,
        calories: num(l.total_calories),
        elevationGainMeters: num(l.total_ascent),
      }),
    );
    startDistanceMeters += distanceMeters;
  });
  return laps;
}
