/**
 * A small, storable summary of one activity, for {@link TrainingHistory}.
 *
 * An app keeps one digest per activity instead of loading every recording to
 * answer a question across months. A digest needs no athlete settings: FTP,
 * weight and zones are applied when a history is analysed, with the values in
 * force on each activity's date, so changing a setting never means reading the
 * files again.
 *
 * Plain JSON, SI units (seconds, metres, watts, beats per minute).
 */
import type { Activity } from '../activity/activity.js';
import type { Sport } from '../activity/sport.js';
import { sportOf } from '../activity/sport.js';
import { Distance, Duration } from '../quantities.js';
import type { FileCreator } from '../types.js';
import { BEST_EFFORT_DISTANCES } from '../geo/index.js';

/** The digest format this pond writes. */
export const DIGEST_VERSION = 1;

/** Best average power over one duration, and where in the activity it was. */
export interface DigestPowerPoint {
  seconds: number;
  watts: number;
  /** Elapsed seconds from the activity's start. */
  from: number;
  to: number;
}

/** Fastest elapsed time over one distance, and where it was. */
export interface DigestPaceBest {
  metres: number;
  /** Elapsed time over the stretch, stops included. */
  seconds: number;
  from: number;
  to: number;
}

export interface ActivityDigest {
  version: typeof DIGEST_VERSION;
  id: string;
  name: string;
  sport: Sport;
  /** The source's own sport label ("TrailRun"). */
  sportType: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  /** Wall-clock start where the activity happened ("2019-11-16T07:08:14",
   *  no zone), when the file gives it. A history uses its date as the day. */
  localStart: string | null;
  device: FileCreator | null;
  time: {
    /** Seconds; null with no timestamps. */
    elapsed: number | null;
    moving: number | null;
  };
  /** Metres; null with no distance recorded. */
  distance: number | null;
  /** Metres climbed; null with no elevation. */
  ascent: number | null;
  /** Null with no heart rate recorded. */
  heartRate: {
    average: number;
    max: number;
    /** Elapsed seconds at each whole beat per minute, from `start` up:
     *  `seconds[i]` is the time at `start + i` bpm. Enough to work out
     *  time in any heart-rate zones later. */
    histogram: { start: number; seconds: number[] };
  } | null;
  /** Null with no power recorded. */
  power: {
    average: number;
    normalized: number | null;
    /** Best average power at {@link DIGEST_POWER_DURATIONS} that fit in the
     *  activity, shortest first. */
    curve: DigestPowerPoint[];
  } | null;
  /** Fastest times at {@link DIGEST_PACE_DISTANCES} that fit; empty with no
   *  distance. */
  pace: DigestPaceBest[];
}

/** Power curve durations kept in a digest, in seconds: 1 s to 5 h. */
export const DIGEST_POWER_DURATIONS: readonly number[] = [
  1, 5, 15, 30, 60, 120, 180, 300, 480, 600, 900, 1200, 1800, 2700, 3600, 5400,
  7200, 10800, 14400, 18000,
];

/** Pace distances kept in a digest, in metres: 400 m to 100 km. */
export const DIGEST_PACE_DISTANCES: readonly number[] = [
  ...BEST_EFFORT_DISTANCES,
  15000,
  30000,
  50000,
  100000,
].sort((a, b) => a - b);

const round = (v: number, places = 1) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** The digest of one activity. */
export function digestOf(activity: Activity): ActivityDigest {
  const record = activity.record.activity;
  const elapsed = activity.stats();
  const moving = activity.stats({ time: 'moving' });

  const hrDist = activity.analyze().distribution('heartRate', { binWidth: 1 });
  const hrAvg = elapsed.heartRate.average?.bpm;
  const hrMax = elapsed.heartRate.max?.bpm;
  const heartRate =
    hrDist &&
    hrDist.bins.length > 0 &&
    hrAvg !== undefined &&
    hrMax !== undefined
      ? {
          average: round(hrAvg),
          max: round(hrMax),
          histogram: {
            start: hrDist.bins[0]!.start,
            seconds: hrDist.bins.map((b) => round(b.seconds)),
          },
        }
      : null;

  const avgPower = elapsed.power.average?.watts;
  const power =
    avgPower !== undefined
      ? {
          average: round(avgPower),
          normalized:
            elapsed.power.normalized !== null
              ? round(elapsed.power.normalized.watts)
              : null,
          curve: activity.power
            .curve(DIGEST_POWER_DURATIONS.map((s) => Duration.seconds(s)))
            .map((e) => ({
              seconds: e.duration.seconds,
              watts: round(e.power.watts),
              from: round(e.section.fromSeconds),
              to: round(e.section.toSeconds),
            })),
        }
      : null;

  const pace = activity.pace
    .bestEfforts(DIGEST_PACE_DISTANCES.map((m) => Distance.meters(m)))
    .map((e) => ({
      metres: e.distance.meters,
      seconds: round(e.time.seconds),
      from: round(e.section.fromSeconds),
      to: round(e.section.toSeconds),
    }));

  return {
    version: DIGEST_VERSION,
    id: record.id,
    name: activity.name,
    sport: sportOf(record.sportType),
    sportType: record.sportType,
    startedAt: activity.startedAt.toISOString(),
    localStart: record.startTimeLocal ?? null,
    device: activity.device,
    time: {
      elapsed: elapsed.time.elapsed
        ? round(elapsed.time.elapsed.seconds)
        : null,
      moving: moving.time.moving ? round(moving.time.moving.seconds) : null,
    },
    distance: elapsed.distance ? round(elapsed.distance.meters) : null,
    ascent: elapsed.elevation.gain
      ? round(elapsed.elevation.gain.meters)
      : null,
    heartRate,
    power,
    pace,
  };
}

/** Throws when a value isn't a digest this pond can read. */
export function checkDigest(d: unknown): asserts d is ActivityDigest {
  const v = d as Partial<ActivityDigest> | null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string')
    throw new TypeError('not an activity digest');
  if (v.version !== DIGEST_VERSION)
    throw new TypeError(
      `activity digest version ${String(v.version)}; this pond reads ${DIGEST_VERSION}`,
    );
}
