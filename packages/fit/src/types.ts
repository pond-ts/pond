/**
 * Core activity types for the fitness domain.
 *
 * Units are SI throughout (meters, seconds) — the same units the Strava API
 * returns. Conversion to miles/feet happens at the display edge (see
 * `units.ts`); the model never stores imperial. (An earlier design stored
 * miles/feet and paid for it in conversion bugs.)
 */

/** A geographic point as [latitude, longitude]. Matches Leaflet + tracks.json. */
export type GeoPoint = [number, number];

/** Where an activity came from: the Strava API, a file the readers in
 *  `@pond-ts/fit/files` read (FIT, GPX, TCX), or entered by hand. */
export type ActivitySource = 'strava' | 'file' | 'manual';

/**
 * The time-series channels recorded during an activity. `latlng` is the track;
 * everything else is optional and present only if the source provided it.
 * Channels are parallel arrays — index i of each is the same sample.
 *
 * A sample a channel is missing is `NaN`, or `null` as an activity read back
 * from JSON has it (JSON has no `NaN`): every reading in this package treats
 * the two the same, as a gap, never as 0. `timeSeconds` is the exception: it
 * must be finite at every sample.
 */
export interface ActivityStreams {
  /** The position at each sample; `null` for a sample the device recorded
   *  without a GPS fix (before it found satellites, or a dropout). A GPS-less
   *  activity has an empty array. When some samples lack a fix and the device
   *  recorded `distanceMeters`, distance comes from that (the device kept
   *  counting without GPS); the map line joins only the fixes. */
  latlng: Array<GeoPoint | null>;
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
  /** An open water swim. The watch only gets a GPS fix while the arm is out of
   *  the water, so the fixes are sparse and noisy: the line is cleaned for the
   *  map (`cleanSwimTrack` in the geo module), and distance comes from `distanceMeters`
   *  (the watch's own filtered distance) rather than from the line, when the
   *  watch recorded it. Without it, distance is measured along the cleaned
   *  line, which cuts corners and so reads somewhat short. */
  openWater?: boolean;
}

/**
 * Activity metadata — the witness statement, minus its substance. The track
 * and other streams live in {@link ActivityStreams}, stored alongside but
 * separately (a track is large; metadata is small and listed often).
 */
export interface ActivityMeta {
  /** Stable activity id, `${source}:${externalId}` — never a raw provider id. */
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
 * a button press), as opposed to the evenly-spaced splits this library *computes*.
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

/** One pool length as the watch logged it: a swum length, or a rest at the
 *  wall (`active: false`, no strokes). */
export interface SwimLength {
  /** ISO 8601, UTC — when the length (or rest) began. */
  startTimeUtc: string;
  seconds: number;
  active: boolean;
  /** Strokes taken over the length. */
  strokes?: number;
  /** The stroke the watch recognised (FIT's names: freestyle, breaststroke,
   *  backstroke, butterfly, drill, mixed). */
  stroke?: string;
}

/**
 * What a swim watch records beyond the streams.
 *
 * `movingSeconds` is the time spent swimming. When present (finite and above
 * 0) the summary takes it as the activity's moving time, held to the elapsed
 * time, without checking it further. Readers fill it with the summed timer
 * time of the laps that covered distance (`swimMovingSeconds`), which leaves
 * out the rests between sets; on 20 real FIT swims (pool and open water) that
 * matched Strava's moving time to within a second. Working it out from the
 * samples instead (as for a run or ride) comes out far too low on a pool
 * swim, which logs one sample per length: a length timed together with its
 * rest at the wall reads as too slow to be moving.
 *
 * Only the whole-activity moving time uses it: a lap, split or `range()`
 * inside a swim still works its moving time out from the samples.
 */
export interface SwimData {
  movingSeconds: number;
  /** Pool swims only (open water has neither). */
  pool?: { lengthMeters: number; unit: 'm' | 'yd' };
  lengths?: SwimLength[];
}

/** An activity together with its streams — the shape an import yields. Laps are
 *  present only for sources that record them (FIT); GPX/manual omit them. */
export interface ImportedActivity {
  activity: ActivityMeta;
  streams: ActivityStreams;
  laps?: Lap[] | undefined;
  /** A swim watch's own record (pool, lengths, swim time), when it has one. */
  swim?: SwimData | undefined;
  /** What the file says made it: a FIT `file_id`'s maker (FIT's name, e.g.
   *  `"garmin"`, or its number) and product number, and a product or
   *  creator name (FIT `product_name`, TCX `<Creator><Name>`, GPX
   *  `creator`). As stated; turning a Garmin product number into a model
   *  name is left to the app. */
  creator?: FileCreator | undefined;
  /** Heart rate after the stop, when the file has it (a Garmin watch's
   *  two-minute `recovery_hr` reading). */
  recovery?: HeartRateRecovery | undefined;
}

/** What an activity file says made it (see {@link ImportedActivity.creator}). */
export interface FileCreator {
  /** FIT maker: FIT's name for it (`"garmin"`) or its number. */
  manufacturer?: string | number | undefined;
  /** FIT product number. */
  product?: number | undefined;
  /** Product or creator name as the file states it. */
  name?: string | undefined;
}

/** Heart rate after the activity stopped. */
export interface HeartRateRecovery {
  /** Heart rate when the activity stopped, bpm. */
  atStopBpm?: number | undefined;
  /** Readings after the stop, oldest first: seconds after the stop, bpm. */
  after: { sec: number; bpm: number }[];
}
