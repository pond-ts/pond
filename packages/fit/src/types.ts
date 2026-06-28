/**
 * Core activity types for the fitness domain.
 *
 * Units are SI throughout (meters, seconds) — the same units the Strava API
 * returns. Conversion to miles/feet happens at the display edge (see
 * `units.ts`); the model never stores imperial. (The ridgetrail proof of
 * concept stored miles/feet and paid for it in conversion bugs.)
 */

/** A geographic point as [latitude, longitude]. Matches Leaflet + tracks.json. */
export type GeoPoint = [number, number];

/** Where an activity came from. Extensible; Strava is the only source for now. */
export type ActivitySource = 'strava' | 'manual';

/**
 * The time-series channels recorded during an activity. `latlng` is the track;
 * everything else is optional and present only if the source provided it.
 * Channels are parallel arrays — index i of each is the same sample.
 */
export interface ActivityStreams {
  latlng: GeoPoint[];
  altitudeMeters?: number[];
  timeSeconds?: number[];
  heartrate?: number[];
  distanceMeters?: number[];
  /** Power, watts (from a power meter — real, not estimated). */
  watts?: number[];
  /** Cadence, rpm. */
  cadence?: number[];
  /** Temperature, °C. */
  temperatureC?: number[];
}

/**
 * Activity metadata — the witness statement, minus its substance. The track
 * and other streams live in {@link ActivityStreams}, stored alongside but
 * separately (a track is large; metadata is small and listed often).
 */
export interface ActivityMeta {
  /** Stable Estela id, `${source}:${externalId}` — never a raw provider id. */
  id: string;
  source: ActivitySource;
  /** The id this activity has in its source system (e.g. the Strava id). */
  externalId: string;
  name: string;
  /** ISO 8601, UTC. */
  startTimeUtc: string;
  /** ISO 8601, local to where the activity happened (if the source gives it). */
  startTimeLocal?: string;
  distanceMeters: number;
  movingTimeSeconds: number;
  elapsedTimeSeconds: number;
  elevationGainMeters: number;
  /** Source's own sport label, e.g. "Run", "Ride". Free text by design. */
  sportType: string;
}

/**
 * A recorded lap — a segment the device marked (auto-lap by distance/time, or
 * a button press), as opposed to the evenly-spaced splits Estela *computes*.
 * Recorded laps are the rider's own structure (intervals, climbs, rest stops),
 * so they're carried through as first-class evidence. SI throughout; optional
 * fields are present only when the source recorded them.
 */
export interface Lap {
  /** 1-based lap number in recorded order. */
  index: number;
  /** ISO 8601, UTC — when the lap began. Optional: absent (not `''`) when the
   *  source recorded no valid start time, so consumers must null-check rather
   *  than `Date.parse('')` → NaN. */
  startTimeUtc?: string;
  /** Cumulative distance at the lap's start (sum of prior laps' distance),
   *  metres — the lap's [start, start+distance] range into the activity, for
   *  chart bands and map-section highlighting. */
  startDistanceMeters: number;
  distanceMeters: number;
  /** Wall-clock for the lap (total_elapsed_time). */
  elapsedSeconds: number;
  /** Timer time, i.e. moving time (total_timer_time). */
  movingSeconds: number;
  avgSpeedMps?: number;
  maxSpeedMps?: number;
  avgWatts?: number;
  maxWatts?: number;
  avgHeartrate?: number;
  maxHeartrate?: number;
  /** Mechanical work over the lap, kJ (FIT total_work is joules). */
  totalWorkKj?: number;
  /** Energy, kcal. */
  calories?: number;
  elevationGainMeters?: number;
}

/** An activity together with its streams — the shape an import yields. Laps are
 *  present only for sources that record them (FIT); GPX/manual omit them. */
export interface ImportedActivity {
  activity: ActivityMeta;
  streams: ActivityStreams;
  laps?: Lap[] | undefined;
}
