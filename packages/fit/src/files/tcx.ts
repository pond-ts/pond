import type {
  ActivityMeta,
  ActivityStreams,
  ImportedActivity,
  Lap,
} from '../types.js';
import { compact, type ReadOptions } from './options.js';

// One <Trackpoint>…</Trackpoint> at a time; fields are pulled from its body.
const TRACKPOINT = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/g;
const LAT = /<LatitudeDegrees>([^<]+)<\/LatitudeDegrees>/;
const LON = /<LongitudeDegrees>([^<]+)<\/LongitudeDegrees>/;
const ALT = /<AltitudeMeters>([^<]+)<\/AltitudeMeters>/;
const TIME = /<Time>([^<]+)<\/Time>/;
// HR is wrapped in a <Value> (the element may carry an xsi:type attribute).
const HR = /<HeartRateBpm\b[^>]*>[\s\S]*?<Value>([^<]+)<\/Value>/;
// Cadence is a bare child for cycling; the trailing lookahead avoids matching a
// lap-level <Cadence> (trackpoint bodies never contain a nested <Cadence>).
const CADENCE = /<Cadence>([^<]+)<\/Cadence>/;
// Power + speed live in the activity-extension namespace (ns3:TPX), prefix varies.
const WATTS = /<(?:\w+:)?Watts>([^<]+)<\/(?:\w+:)?Watts>/;

// One <Lap StartTime="…">…</Lap> at a time, with its start time captured.
/** The recording device: `<Activity><Creator><Name>` (an `<Author>` has a
 *  `<Name>` too, for the program that wrote the file). */
const CREATOR = /<Creator\b[^>]*>\s*<Name>([^<]*)<\/Name>/;
const LAP = /<Lap\b[^>]*\bStartTime="([^"]*)"[^>]*>([\s\S]*?)<\/Lap>/g;
const TOTAL_TIME = /<TotalTimeSeconds>([^<]+)<\/TotalTimeSeconds>/;
const DISTANCE = /<DistanceMeters>([^<]+)<\/DistanceMeters>/;
const MAX_SPEED = /<MaximumSpeed>([^<]+)<\/MaximumSpeed>/;
const CALORIES = /<Calories>([^<]+)<\/Calories>/;
const AVG_HR = /<AverageHeartRateBpm\b[^>]*>[\s\S]*?<Value>([^<]+)<\/Value>/;
const MAX_HR = /<MaximumHeartRateBpm\b[^>]*>[\s\S]*?<Value>([^<]+)<\/Value>/;
const AVG_WATTS = /<(?:\w+:)?AvgWatts>([^<]+)<\/(?:\w+:)?AvgWatts>/;
const MAX_WATTS = /<(?:\w+:)?MaxWatts>([^<]+)<\/(?:\w+:)?MaxWatts>/;
const AVG_SPEED = /<(?:\w+:)?AvgSpeed>([^<]+)<\/(?:\w+:)?AvgSpeed>/;

const ACTIVITY_SPORT = /<Activity\b[^>]*\bSport="([^"]*)"/;
const ACTIVITY_ID = /<Activity\b[^>]*>[\s\S]*?<Id>([^<]+)<\/Id>/;
const NOTES = /<Notes>([^<]+)<\/Notes>/;

const num = (s: string | undefined): number | undefined => {
  if (s == null) return undefined;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : undefined;
};

/**
 * Parse a TCX (Garmin Training Center) activity into an {@link ImportedActivity}.
 * Regex-based and single-pass, like {@link parseGpx} — fast on a 15k-point track
 * and DOM-free. Trackpoints across every lap form the parallel streams. If any
 * sample is positioned it's a GPS activity (streams align to the positioned
 * points, dropping the rare dropped-fix sample); if NONE are, it's a GPS-less
 * activity (indoor / GPS-off head unit) — every sample is kept, `latlng` is
 * empty, and the device's per-sample `<DistanceMeters>` carries the distance
 * axis. Recorded `<Lap>`s become {@link Lap}s with their power/HR/speed where
 * TCX carried them. Time streams are offsets from the first sample (Strava
 * convention); `activity.startTimeUtc` is the absolute base. Activity-level
 * distances/times stay 0 — `computeActivitySummary` derives them.
 */
/** One parsed trackpoint; every field optional (TCX varies by device/sport). */
interface TcxPoint {
  lat?: number | undefined;
  lon?: number | undefined;
  ele?: number | undefined;
  hr?: number | undefined;
  watts?: number | undefined;
  cadence?: number | undefined;
  dist?: number | undefined;
  ms: number;
}

/** Name: `options.name`, else the TCX `<Notes>`, else "Untitled"; sport:
 *  `options.sportType`, else the `<Activity Sport>`, else "Unknown". */
export function parseTcx(
  xml: string,
  options: ReadOptions = {},
): ImportedActivity {
  const pts: TcxPoint[] = [];
  let m: RegExpExecArray | null;
  TRACKPOINT.lastIndex = 0;
  while ((m = TRACKPOINT.exec(xml)) !== null) {
    const body = m[1]!;
    const t = TIME.exec(body)?.[1];
    pts.push({
      lat: num(LAT.exec(body)?.[1]),
      lon: num(LON.exec(body)?.[1]),
      ele: num(ALT.exec(body)?.[1]),
      hr: num(HR.exec(body)?.[1]),
      watts: num(WATTS.exec(body)?.[1]),
      cadence: num(CADENCE.exec(body)?.[1]),
      dist: num(DISTANCE.exec(body)?.[1]),
      ms: t ? Date.parse(t) : NaN,
    });
  }

  // GPS mode = at least one positioned sample; align the streams to the
  // positioned points (dropping the odd dropped-fix sample, as GPX does). A
  // file with NO positions is a GPS-less activity (indoor / GPS-off head unit):
  // keep every sample, leave latlng empty, and rely on the device's per-sample
  // <DistanceMeters> as the distance axis (computeActivitySummary builds from it).
  const positioned = pts.filter(
    (p) => p.lat !== undefined && p.lon !== undefined,
  );
  const samples = positioned.length > 0 ? positioned : pts;
  const gps = positioned.length > 0;

  const col = <K extends keyof TcxPoint>(key: K): number[] =>
    samples.map((p) => (p[key] ?? NaN) as number);
  const has = (key: keyof TcxPoint): boolean =>
    samples.some((p) => p[key] !== undefined);

  const startMs = samples.find((p) => !Number.isNaN(p.ms))?.ms ?? NaN;
  const hasTime = !Number.isNaN(startMs);
  const timeSeconds = hasTime
    ? samples.map((p) => (Number.isNaN(p.ms) ? 0 : (p.ms - startMs) / 1000))
    : undefined;

  const sportType =
    options.sportType ?? ACTIVITY_SPORT.exec(xml)?.[1]?.trim() ?? 'Unknown';
  const name = options.name ?? NOTES.exec(xml)?.[1]?.trim() ?? 'Untitled';
  const id = options.id ?? `tcx:${name}`;
  // Prefer the first sample's time for the base; fall back to <Activity><Id>.
  const baseMs = hasTime
    ? startMs
    : Date.parse(ACTIVITY_ID.exec(xml)?.[1]?.trim() ?? '');

  const streams: ActivityStreams = {
    latlng: gps ? samples.map((p) => [p.lat!, p.lon!]) : [],
  };
  if (has('ele')) streams.altitudeMeters = col('ele');
  if (has('hr')) streams.heartrate = col('hr');
  if (has('watts')) streams.watts = col('watts');
  if (has('cadence')) streams.cadence = col('cadence');
  // The cumulative distance stream — the only distance source for a GPS-less
  // activity; harmless alongside GPS (computeActivitySummary prefers haversine there).
  if (has('dist')) streams.distanceMeters = col('dist');
  if (timeSeconds) streams.timeSeconds = timeSeconds;

  const activity: ActivityMeta = {
    id,
    source: options.source ?? 'file',
    externalId: id,
    name,
    startTimeUtc: new Date(Number.isNaN(baseMs) ? 0 : baseMs).toISOString(),
    distanceMeters: 0,
    movingTimeSeconds: 0,
    elapsedTimeSeconds: 0,
    elevationGainMeters: 0,
    sportType,
  };

  const laps = parseLaps(xml);
  const creator = CREATOR.exec(xml)?.[1]?.trim();
  return {
    activity,
    streams,
    ...(laps.length ? { laps } : {}),
    ...(creator ? { creator: { name: creator } } : {}),
  };
}

/** Project the TCX `<Lap>`s to {@link Lap}s, accumulating start distance.
 *  TCX has no moving time → `movingSeconds` falls back to elapsed; no per-lap
 *  ascent → `elevationGainMeters` is left undefined. */
function parseLaps(xml: string): Lap[] {
  const laps: Lap[] = [];
  let startDistanceMeters = 0;
  let m: RegExpExecArray | null;
  LAP.lastIndex = 0;
  let i = 0;
  while ((m = LAP.exec(xml)) !== null) {
    const startTime = m[1]!.trim();
    const body = m[2]!;
    // Split the lap around its <Track>: summary fields (distance, time, HR, …)
    // sit BEFORE it, the LX power/speed extension AFTER it. Scoping each read to
    // its own slice keeps a trackpoint's cumulative <DistanceMeters> or
    // <HeartRateBpm><Value> from being grabbed when a lap summary field is
    // absent or an empty container (the over-reach a whole-body search risks).
    const trackStart = body.indexOf('<Track');
    const trackEnd = body.indexOf('</Track>');
    const head = trackStart >= 0 ? body.slice(0, trackStart) : body;
    const tail = trackEnd >= 0 ? body.slice(trackEnd) : '';
    const distanceMeters = num(DISTANCE.exec(head)?.[1]) ?? 0;
    const elapsedSeconds = num(TOTAL_TIME.exec(head)?.[1]) ?? 0;
    laps.push(
      compact<Lap>({
        index: ++i,
        startTimeUtc: startTime || undefined,
        startDistanceMeters,
        distanceMeters,
        elapsedSeconds,
        movingSeconds: elapsedSeconds,
        avgSpeedMps: num(AVG_SPEED.exec(tail)?.[1]),
        maxSpeedMps: num(MAX_SPEED.exec(head)?.[1]),
        avgWatts: num(AVG_WATTS.exec(tail)?.[1]),
        maxWatts: num(MAX_WATTS.exec(tail)?.[1]),
        avgHeartrate: num(AVG_HR.exec(head)?.[1]),
        maxHeartrate: num(MAX_HR.exec(head)?.[1]),
        calories: num(CALORIES.exec(head)?.[1]),
      }),
    );
    startDistanceMeters += distanceMeters;
  }
  return laps;
}
