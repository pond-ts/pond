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
 * - `'swimming'`: a swim's time spent swimming, its rests at the wall left
 *   out. For a swim it is the moving time (a pool swim moves only during
 *   its lengths, see `moving.ts`); any other sport has no swimming clock, so
 *   its time-based numbers are `null`. Channel numbers are over the swimming
 *   samples.
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
import type { MovingRule } from './moving.js';

/** The clock a {@link Stats} result is measured on. */
export type TimeBasis = 'elapsed' | 'moving' | 'timer' | 'swimming';

export interface StatsOptions {
  /** Default `'elapsed'`. */
  time?: TimeBasis;
}

/** The clocks, whatever the basis. */
export interface Clocks {
  /** Wall-clock time; null with no timestamps in the recording. */
  elapsed: Duration | null;
  /** By the moving rule; null with no timestamps to judge by. */
  moving: Duration | null;
  /** As the file records it; null when it doesn't. */
  timer: Duration | null;
  /** Time spent swimming; null for any sport but swimming. */
  swimming: Duration | null;
  /** A swim's time not swimming (elapsed − swimming): rests at the wall,
   *  and any timer pause. Null for any sport but swimming. */
  rest: Duration | null;
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
  /** The activity has a clock (sample timestamps or timed swim lengths). */
  hasTime: boolean;
  /** The recording has a distance (GPS or a distance channel). */
  hasDistance: boolean;
  /** The activity is a swim (so it has a swimming clock). */
  swim: boolean;
  /** How moving was decided (see `moving.ts`). */
  movingRule: MovingRule;
  /** Under the `'swim-time'` rule, the watch's swim time when this stretch
   *  is the whole activity (unknown for any part of it). */
  wholeSwimSeconds?: number | undefined;
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
  const { timerSeconds, hasTime, hasDistance, swim } = ctx;
  const moving = basis === 'moving' || basis === 'swimming';
  // the watch's swim time alone: no telling which samples were swimming
  const swimTimeOnly = ctx.movingRule === 'swim-time';
  const movingSeconds = swimTimeOnly
    ? ctx.wholeSwimSeconds
    : hasTime
      ? raw.movingSeconds
      : undefined;
  const swimmingSeconds = swim ? movingSeconds : undefined;
  const time: Clocks = {
    elapsed: hasTime ? Duration.seconds(raw.elapsedSeconds) : null,
    moving: q(movingSeconds, Duration.seconds),
    timer: q(timerSeconds, Duration.seconds),
    swimming: q(swimmingSeconds, Duration.seconds),
    // rest is elapsed − swimming, so it needs both clocks
    rest:
      swimmingSeconds !== undefined && hasTime
        ? Duration.seconds(Math.max(0, raw.elapsedSeconds - swimmingSeconds))
        : null,
  };
  const basisSeconds = {
    elapsed: hasTime ? raw.elapsedSeconds : undefined,
    moving: movingSeconds,
    timer: timerSeconds,
    swimming: swimmingSeconds,
  }[basis];
  const meters = raw.distanceMeters;
  const avgMps =
    hasDistance && basisSeconds !== undefined && basisSeconds > 0 && meters >= 0
      ? meters / basisSeconds
      : undefined;
  const ch = swimTimeOnly && moving ? {} : raw.channels;
  const speed = pick(ch.speed, moving);
  const hr = pick(ch.hr, moving);
  const power = pick(ch.power, moving);
  const cadence = pick(ch.cadence, moving);
  const ele = ch.elevation;
  const np =
    swimTimeOnly && moving
      ? undefined
      : 'sections' in raw
        ? groupNp(raw, moving)
        : moving
          ? raw.channels.power?.movingNp
          : raw.channels.power?.np;
  return {
    basis,
    distance: hasDistance ? Distance.meters(meters) : null,
    time,
    // a known standstill has a speed of 0 but no pace
    pace: {
      average:
        avgMps !== undefined && avgMps > 0
          ? Speed.metersPerSecond(avgMps).pace()
          : null,
    },
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
