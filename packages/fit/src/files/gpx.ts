import type {
  ActivityMeta,
  ActivityStreams,
  ImportedActivity,
} from '../types.js';
import type { ReadOptions } from './options.js';

const TRKPT = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
const LAT = /\blat="([^"]+)"/;
const LON = /\blon="([^"]+)"/;
const ELE = /<ele>([^<]+)<\/ele>/;
const TIME = /<time>([^<]+)<\/time>/;
const HR = /<(?:\w+:)?hr>([^<]+)<\/(?:\w+:)?hr>/;
/** The program or device that wrote the file: `<gpx creator="…">`. */
const CREATOR = /<gpx\b[^>]*\bcreator="([^"]*)"/;
const TRK_NAME = /<trk>[\s\S]*?<name>([^<]+)<\/name>/;
const TRK_TYPE = /<trk>[\s\S]*?<type>([^<]+)<\/type>/;

/**
 * Parse a GPX track into an {@link ImportedActivity}. Name: `options.name`,
 * else the track's `<name>`, else "Untitled"; sport: `options.sportType`,
 * else its `<type>`, else "Unknown". Regex-based and
 * single-pass — for a 15k-point track this is fast and avoids a DOM. Streams
 * are parallel arrays; `timeSeconds` are offsets from the first sample (Strava
 * convention), with `activity.startTimeUtc` the absolute base. Activity
 * *metadata* distances/times are left at 0 — they're computed by
 * `computeActivitySummary`, not claimed by the file.
 */
export function parseGpx(
  xml: string,
  options: ReadOptions = {},
): ImportedActivity {
  const latlng: Array<[number, number]> = [];
  const altitudeMeters: number[] = [];
  const heartrate: number[] = [];
  const epochMs: number[] = [];
  let hasEle = false;
  let hasHr = false;
  let hasTime = false;

  let m: RegExpExecArray | null;
  TRKPT.lastIndex = 0;
  while ((m = TRKPT.exec(xml)) !== null) {
    const attrs = m[1]!;
    const body = m[2]!;
    const lat = LAT.exec(attrs);
    const lon = LON.exec(attrs);
    if (!lat || !lon) continue;
    latlng.push([parseFloat(lat[1]!), parseFloat(lon[1]!)]);

    const ele = ELE.exec(body);
    if (ele) {
      altitudeMeters.push(parseFloat(ele[1]!));
      hasEle = true;
    } else {
      altitudeMeters.push(NaN);
    }

    const hr = HR.exec(body);
    if (hr) {
      heartrate.push(parseFloat(hr[1]!));
      hasHr = true;
    } else {
      heartrate.push(NaN);
    }

    const time = TIME.exec(body);
    if (time) {
      epochMs.push(Date.parse(time[1]!));
      hasTime = true;
    } else {
      epochMs.push(NaN);
    }
  }

  const startMs = hasTime ? (epochMs.find((t) => !Number.isNaN(t)) ?? 0) : 0;
  const timeSeconds = hasTime
    ? epochMs.map((t) => (Number.isNaN(t) ? 0 : (t - startMs) / 1000))
    : undefined;

  const name = options.name ?? TRK_NAME.exec(xml)?.[1]?.trim() ?? 'Untitled';
  const sportType =
    options.sportType ?? TRK_TYPE.exec(xml)?.[1]?.trim() ?? 'Unknown';
  const id = options.id ?? `gpx:${name}`;

  const streams: ActivityStreams = { latlng };
  if (hasEle) streams.altitudeMeters = altitudeMeters;
  if (hasHr) streams.heartrate = heartrate;
  if (timeSeconds) streams.timeSeconds = timeSeconds;

  const activity: ActivityMeta = {
    id,
    source: options.source ?? 'file',
    externalId: id,
    name,
    startTimeUtc: new Date(startMs).toISOString(),
    distanceMeters: 0,
    movingTimeSeconds: 0,
    elapsedTimeSeconds: 0,
    elevationGainMeters: 0,
    sportType,
  };

  const creator = CREATOR.exec(xml)?.[1]?.trim();
  return creator
    ? { activity, streams, creator: { name: creator } }
    : { activity, streams };
}
