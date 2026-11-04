/**
 * The one stats contract every {@link Section} (and so every activity, lap
 * and split) answers, and every {@link Sections} collection too.
 *
 * A result is computed on one time basis and says which:
 *
 * - `'elapsed'` (the default): wall-clock time from start to end; channel
 *   numbers over every sample.
 * - `'moving'`: only the time classified as moving; channel numbers over the
 *   moving samples only.
 * - `'timer'`: the time the recording timer ran, as the file records it.
 *   `null` (with every number that needs it) when the file doesn't say.
 *   Channel numbers are over every sample, since a device writes samples
 *   only while its timer runs.
 *
 * `null` means unavailable (the channel wasn't recorded, or the basis's time
 * isn't known); a real zero stays zero.
 */
import {
  Cadence,
  Distance,
  Duration,
  Elevation,
  HeartRate,
  Pace,
  Power,
  Speed,
} from '../quantities.js';
import type {
  ChannelStats,
  GroupChannelStats,
  SectionGroupStats,
  SectionStats,
} from '../stats/index.js';

/** The clock a {@link Stats} result is measured on. */
export type TimeBasis = 'elapsed' | 'moving' | 'timer';

export interface StatsOptions {
  /** Default `'elapsed'`. */
  time?: TimeBasis;
}

/** The three clocks, whatever the basis. */
export interface Clocks {
  elapsed: Duration;
  /** By the moving rule; null with no timestamps to judge by. */
  moving: Duration | null;
  /** As the file records it; null when it doesn't. */
  timer: Duration | null;
}

export interface Stats {
  /** The clock every time-based number here uses. */
  basis: TimeBasis;
  distance: Distance | null;
  time: Clocks;
  /** Distance over the basis's time. */
  pace: { average: Pace | null };
  speed: { average: Speed | null; max: Speed | null };
  heartRate: {
    average: HeartRate | null;
    min: HeartRate | null;
    max: HeartRate | null;
  };
  power: {
    average: Power | null;
    max: Power | null;
    normalized: Power | null;
  };
  cadence: { average: Cadence | null; max: Cadence | null };
  elevation: {
    gain: Elevation | null;
    loss: Elevation | null;
    min: Elevation | null;
    max: Elevation | null;
  };
}

const q = <T>(v: number | undefined, make: (v: number) => T): T | null =>
  v !== undefined && Number.isFinite(v) ? make(v) : null;

type Channel = ChannelStats | GroupChannelStats | undefined;

function pick(c: Channel, moving: boolean) {
  if (!c) return { avg: undefined, min: undefined, max: undefined };
  return moving
    ? { avg: c.avgMoving, min: c.minMoving, max: c.maxMoving }
    : { avg: c.avg, min: c.min, max: c.max };
}

/** What a recording can and can't tell, for {@link toStats}. */
export interface StatsContext {
  /** The file's timer time for this stretch, when it records one. */
  timerSeconds: number | undefined;
  /** Samples carry timestamps (so moving can be judged). */
  hasTime: boolean;
  /** The recording has a distance (GPS or a distance channel). */
  hasDistance: boolean;
  /** Moving time known better than the samples tell it (a swim watch's own
   *  swim time for the whole activity). */
  movingSeconds?: number;
}

/** Normalized power across sections, combined as it's made: the
 *  time-weighted mean of each section's NP to the 4th power, 4th-rooted. */
function groupNp(g: SectionGroupStats, moving: boolean): number | undefined {
  let sum = 0;
  let w = 0;
  for (const s of g.sections) {
    const v = moving ? s.channels.power?.movingNp : s.channels.power?.np;
    const t = moving ? s.movingSeconds : s.elapsedSeconds;
    if (v === undefined || !Number.isFinite(v) || !(t > 0)) continue;
    sum += v ** 4 * t;
    w += t;
  }
  return w > 0 ? (sum / w) ** 0.25 : undefined;
}

/** Build a {@link Stats} from the engine's numbers for a section or group. */
export function toStats(
  raw: SectionStats | SectionGroupStats,
  basis: TimeBasis,
  ctx: StatsContext,
): Stats {
  const { timerSeconds, hasTime, hasDistance } = ctx;
  const moving = basis === 'moving';
  const movingSeconds = ctx.movingSeconds ?? raw.movingSeconds;
  const movingKnown = hasTime || ctx.movingSeconds !== undefined;
  const time: Clocks = {
    elapsed: Duration.seconds(raw.elapsedSeconds),
    moving: movingKnown ? Duration.seconds(movingSeconds) : null,
    timer: q(timerSeconds, Duration.seconds),
  };
  const basisSeconds =
    basis === 'elapsed'
      ? raw.elapsedSeconds
      : basis === 'moving'
        ? movingKnown
          ? movingSeconds
          : undefined
        : timerSeconds;
  const meters = raw.distanceMeters;
  const avgMps =
    hasDistance && basisSeconds !== undefined && basisSeconds > 0 && meters > 0
      ? meters / basisSeconds
      : undefined;
  const ch = raw.channels;
  const speed = pick(ch.speed, moving);
  const hr = pick(ch.hr, moving);
  const power = pick(ch.power, moving);
  const cadence = pick(ch.cadence, moving);
  const ele = ch.elevation;
  const np =
    'sections' in raw
      ? groupNp(raw, moving)
      : moving
        ? raw.channels.power?.movingNp
        : raw.channels.power?.np;
  return {
    basis,
    distance: hasDistance ? Distance.meters(meters) : null,
    time,
    pace: { average: q(avgMps, (v) => Speed.metersPerSecond(v).pace()) },
    speed: {
      average: q(avgMps, Speed.metersPerSecond),
      max: q(speed.max, Speed.metersPerSecond),
    },
    heartRate: {
      average: q(hr.avg, HeartRate.bpm),
      min: q(hr.min, HeartRate.bpm),
      max: q(hr.max, HeartRate.bpm),
    },
    power: {
      average: q(power.avg, Power.watts),
      max: q(power.max, Power.watts),
      normalized: q(np, Power.watts),
    },
    cadence: {
      average: q(cadence.avg, Cadence.rpm),
      max: q(cadence.max, Cadence.rpm),
    },
    elevation: {
      gain: q(ele?.gain, Elevation.meters),
      loss: q(ele?.loss, Elevation.meters),
      min: q(ele?.min, Elevation.meters),
      max: q(ele?.max, Elevation.meters),
    },
  };
}
