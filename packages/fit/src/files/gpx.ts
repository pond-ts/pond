import type {
  ActivityMeta,
  ActivityStreams,
  ImportedActivity,
} from '../types.js';
import type { ReadOptions } from './options.js';
import { attr, childText, offsetSeconds } from './xml.js';

// One track point, self-closing or not, with any namespace prefix
// (`<trkpt …/>`, `<gpx:trkpt …>…</gpx:trkpt>`).
const TRKPT =
  /<(?:[\w-]+:)?trkpt\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?trkpt>)/g;
/** The first `<trk>`, for its name and type. */
const TRK = /<(?:[\w-]+:)?trk\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?trk>/;
/** The root element's attributes, for `creator`. */
const GPX = /<(?:[\w-]+:)?gpx\b((?:[^>"']|"[^"]*"|'[^']*')*)>/;

/**
 * Parse a GPX track into an {@link ImportedActivity}. Name: `options.name`,
 * else the track's `<name>`, else "Untitled"; sport: `options.sportType`,
 * else its `<type>`, else "Unknown"; id: `options.id`, else
 * `gpx:<start time>`. A point with no `<time>` takes the time before it, so
 * `timeSeconds` never runs backwards; a file with no times at all has no
 * `timeSeconds` and a start of 1970-01-01, since the file can't say when it was.
 * Points without a position are dropped. Regex-based and
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

  let m: RegExpExecArray | null;
  TRKPT.lastIndex = 0;
  while ((m = TRKPT.exec(xml)) !== null) {
    const attrs = m[1]!;
    const body = m[2] ?? '';
    const lat = parseFloat(attr(attrs, 'lat') ?? '');
    const lon = parseFloat(attr(attrs, 'lon') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    latlng.push([lat, lon]);

    const ele = childText(body, 'ele');
    if (ele !== undefined) {
      altitudeMeters.push(parseFloat(ele));
      hasEle = true;
    } else {
      altitudeMeters.push(NaN);
    }

    const hr = childText(body, 'hr');
    if (hr !== undefined) {
      heartrate.push(parseFloat(hr));
      hasHr = true;
    } else {
      heartrate.push(NaN);
    }

    const time = childText(body, 'time');
    epochMs.push(time !== undefined ? Date.parse(time) : NaN);
  }

  const timeSeconds = offsetSeconds(epochMs);
  const startMs = timeSeconds ? epochMs.find((t) => !Number.isNaN(t))! : 0;

  const trk = TRK.exec(xml)?.[1] ?? '';
  // The track's own name and type, not a <name> inside a later element.
  const trkHead = trk.split(/<(?:[\w-]+:)?trkseg\b/)[0]!;
  const name = options.name ?? childText(trkHead, 'name') ?? 'Untitled';
  const sportType =
    options.sportType ?? childText(trkHead, 'type') ?? 'Unknown';
  const startTimeUtc = new Date(startMs).toISOString();
  const id = options.id ?? `gpx:${startTimeUtc}`;

  const streams: ActivityStreams = { latlng };
  if (hasEle) streams.altitudeMeters = altitudeMeters;
  if (hasHr) streams.heartrate = heartrate;
  if (timeSeconds) streams.timeSeconds = timeSeconds;

  const activity: ActivityMeta = {
    id,
    source: options.source ?? 'file',
    externalId: id,
    name,
    startTimeUtc,
    distanceMeters: 0,
    movingTimeSeconds: 0,
    elapsedTimeSeconds: 0,
    elevationGainMeters: 0,
    sportType,
  };

  const creator = attr(GPX.exec(xml)?.[1] ?? '', 'creator');
  return creator
    ? { activity, streams, creator: { name: creator } }
    : { activity, streams };
}
