/**
 * What a stretch of an activity means for one athlete ({@link Analysis}),
 * and the best efforts inside it, kept under the metric they describe
 * ({@link PowerEfforts}, {@link PaceEfforts}).
 *
 * The recording never changes with the athlete; an analysis is computed
 * from it with the athlete's settings in force on the activity's date. A
 * setting the athlete hasn't recorded makes only the results that need it
 * `null`: no FTP means no intensity factor, no training load and no power
 * zones, while average and normalized power still come back.
 */
import {
  distanceAtSeconds,
  hasDistance,
  type PreparedActivity,
} from '../summary/index.js';
import { sectionBounds, sectionWindow, type Span } from '../stats/index.js';
import {
  powerCurve,
  zoneDistribution,
  type PowerZone,
} from '../power/index.js';
import { bestEffortsByDistance, BEST_EFFORT_DISTANCES } from '../geo/index.js';
import { hrZoneDistribution, paceZoneDistribution } from '../zones/index.js';
import type { ZoneTime } from '../zones/index.js';
import { Profile, type AthleteProfileJson } from '../profile/index.js';
import { Distance, Duration, Pace, Power } from '../quantities.js';
import type { Stats } from './stats.js';
import { Aerobic } from './aerobic.js';
import { techniqueOf, type Technique } from './technique.js';
import { EffortFinder } from './efforts.js';
import type { Section } from './activity.js';
import {
  coastingOf,
  distributionOf,
  type Coasting,
  type Distribution,
  type DistributionChannel,
  type DistributionOptions,
} from './distribution.js';
import { sportOf } from './sport.js';

/** The athlete to analyse for: a {@link Profile} already resolved to a date,
 *  or the stored profile with its dated history, which is resolved to the
 *  activity's start. */
export type AthleteInput = Profile | AthleteProfileJson;

export interface AnalyzeOptions {
  /** Left out: no settings, so only the readings that need none (power,
   *  aerobic, distributions, technique) come back. */
  athlete?: AthleteInput;
}

/** Power read against the athlete's settings. */
export interface PowerAnalysis {
  /** Over every sample (elapsed basis); null with no power recorded. */
  average: Power | null;
  normalized: Power | null;
  /** Normalized power ÷ FTP; null without FTP or without power. */
  intensityFactor: number | null;
  /** Normalized ÷ average power; null without power (or an average of 0). */
  variabilityIndex: number | null;
}

/** A training-load number, with the model that produced it. Rides only for
 *  now: running and swimming load use other models (RFC §15, §16). */
export interface Load {
  /** `'cycling-tss'`: elapsed seconds × NP × IF ÷ (FTP × 3600) × 100. */
  model: 'cycling-tss';
  value: number;
}

/** Time in each zone. Each is null when the athlete has no zones for that
 *  channel, the channel wasn't recorded, or the samples have no timestamps. */
export interface ZoneAnalysis {
  /** Coggan zones from FTP. */
  power: PowerZone[] | null;
  heartRate: ZoneTime[] | null;
  /** From the athlete's 5 km time, so runs, walks and hikes only; needs a
   *  distance. */
  pace: ZoneTime[] | null;
}

/** The parts of a section an analysis or an effort search reads. @internal */
export interface AnalysisSource {
  prep: PreparedActivity;
  span: Span;
  stats: () => Stats;
  /** Stats for a stretch inside the section. */
  statsOf: (span: Span, basis: 'elapsed' | 'moving') => Stats;
  /** A section for a stretch inside it. */
  section: (span: Span, label: string) => Section;
}

/** Resolve an {@link AthleteInput} for an activity that started at
 *  `startTimeUtc`. @internal */
export function resolveAthlete(
  athlete: AthleteInput,
  startTimeUtc: string,
): Profile {
  return athlete instanceof Profile
    ? athlete
    : Profile.asOf(athlete, startTimeUtc);
}

function windowOf(src: AnalysisSource) {
  const w = src.prep.hasTime ? sectionWindow(src.prep, src.span) : null;
  if (!w) return null;
  const slice = (a: Float64Array | undefined) =>
    a ? a.subarray(w.lo, w.hi + 1) : undefined;
  const { prep } = src;
  return {
    t: prep.timeRel.subarray(w.lo, w.hi + 1),
    power: hasFinite(slice(prep.cols.power)),
    hr: hasFinite(slice(prep.cols.hr)),
    speed: prep.speed.subarray(w.lo, w.hi + 1),
    cum: prep.cum.subarray(w.lo, w.hi + 1),
  };
}

/**
 * Time and distance to search for best efforts over. A pool swim of a known
 * pool length searches its lengths: each length's start and end, inside the
 * section (its ends included), whether or not a sample was taken there.
 * Anything else searches its samples.
 */
function effortTimeline(
  src: AnalysisSource,
): { t: Float64Array; cum: Float64Array } | null {
  const { prep } = src;
  const lengths = prep.poolLengths;
  if (!lengths) {
    const w = windowOf(src);
    return w ? { t: w.t, cum: w.cum } : null;
  }
  const b = prep.hasClock ? sectionBounds(prep, src.span) : null;
  if (!b || !(b.to > b.from)) return null;
  const times = [b.from];
  for (const l of lengths)
    for (const x of [l.from, l.to])
      if (x > b.from && x < b.to && x !== times[times.length - 1])
        times.push(x);
  times.push(b.to);
  const t = Float64Array.from(times);
  const cum = t.map((sec) => distanceAtSeconds(prep, sec));
  return { t, cum };
}

function hasFinite(a: Float64Array | undefined): Float64Array | undefined {
  if (!a) return undefined;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]!)) return a;
  return undefined;
}

/** Pace zones from a 5 km time are on-foot zones. */
const ON_FOOT = new Set(['run', 'walk', 'hike']);

function sport(prep: PreparedActivity) {
  return sportOf(prep.imported.activity.sportType);
}

/** A section read for one athlete. Made by `section.analyze({ athlete })`. */
export class Analysis {
  /** The settings used, resolved for the activity's date. */
  readonly athlete: Profile;
  readonly #src: AnalysisSource;
  #power?: PowerAnalysis;
  #load?: Load | null;
  #zones?: ZoneAnalysis;
  #aerobic?: Aerobic;
  #coasting?: Coasting | null;
  #technique?: Technique | null;
  #efforts?: EffortFinder<Section>;

  /** @internal */
  constructor(src: AnalysisSource, athlete: Profile) {
    this.#src = src;
    this.athlete = athlete;
  }

  get power(): PowerAnalysis {
    if (this.#power) return this.#power;
    const { average, normalized } = this.#src.stats().power;
    const ftp = this.athlete.ftpWatts;
    return (this.#power = {
      average,
      normalized,
      intensityFactor:
        normalized && ftp && ftp > 0 ? normalized.watts / ftp : null,
      variabilityIndex:
        normalized && average && average.watts > 0
          ? normalized.watts / average.watts
          : null,
    });
  }

  /** Efficiency (output per heartbeat) and decoupling. Needs no athlete
   *  settings; it sits here with the other readings of the section. */
  get aerobic(): Aerobic {
    return (this.#aerobic ??= new Aerobic(this.#src));
  }

  /** Time at each level of a channel:
   *  `a.distribution('power', { binWidth: 25 })`. Null when the channel
   *  wasn't recorded here or the samples have no timestamps. */
  distribution(
    channel: DistributionChannel,
    options?: DistributionOptions,
  ): Distribution | null {
    return distributionOf(this.#src.prep, this.#src.span, channel, options);
  }

  /** Moving time with the pedals still, on a ride; null for other sports
   *  or with neither cadence nor power recorded. */
  get coasting(): Coasting | null {
    if (this.#coasting === undefined)
      this.#coasting = coastingOf(this.#src.prep, this.#src.span);
    return this.#coasting;
  }

  /** Stroke metrics over the pool lengths whose middle is in the section, drills
   *  left out; null off the pool or with no counted length. */
  get technique(): Technique | null {
    if (this.#technique === undefined)
      this.#technique = techniqueOf(this.#src.prep, this.#src.span);
    return this.#technique;
  }

  /** Efforts and the recovery after each: `efforts.fromLaps()` or
   *  `efforts.detect({ powerAbove: 300 })`, then `.compare()`. */
  get efforts(): EffortFinder<Section> {
    return (this.#efforts ??= new EffortFinder({
      prep: this.#src.prep,
      span: this.#src.span,
      make: this.#src.section,
    }));
  }

  /** Null for any sport but cycling, and without FTP, power or
   *  timestamps. */
  get load(): Load | null {
    if (this.#load !== undefined) return this.#load;
    const { intensityFactor, normalized } = this.power;
    const elapsed = this.#src.stats().time.elapsed;
    const ftp = this.athlete.ftpWatts;
    this.#load =
      sport(this.#src.prep) === 'ride' &&
      intensityFactor !== null &&
      normalized &&
      elapsed &&
      ftp
        ? {
            model: 'cycling-tss',
            value:
              ((elapsed.seconds * normalized.watts * intensityFactor) /
                (ftp * 3600)) *
              100,
          }
        : null;
    return this.#load;
  }

  get zones(): ZoneAnalysis {
    if (this.#zones) return this.#zones;
    const w = windowOf(this.#src);
    const a = this.athlete;
    const ftp = a.ftpWatts;
    const hrZones = a.heartRateZones;
    const paceZones = a.paceZones;
    return (this.#zones = {
      power:
        w?.power && ftp && ftp > 0 ? zoneDistribution(w.t, w.power, ftp) : null,
      heartRate:
        w?.hr && hrZones ? hrZoneDistribution(w.t, w.hr, hrZones) : null,
      pace:
        w &&
        paceZones &&
        ON_FOOT.has(sport(this.#src.prep)) &&
        hasDistance(this.#src.prep)
          ? paceZoneDistribution(w.t, w.speed, paceZones)
          : null,
    });
  }
}

/** The highest average power held for one duration. */
export interface PowerBestEffort<S> {
  duration: Duration;
  power: Power;
  /** Where it was. Its own `stats()` counts both end samples, so its
   *  average can differ a little from `power`. Pauses count as at most
   *  10 s toward `duration`, so an effort across a pause has a section
   *  longer than its duration. */
  section: S;
}

/** The fastest time over one distance. */
export interface PaceBestEffort<S> {
  distance: Distance;
  /** Elapsed time over the stretch, stops included. */
  time: Duration;
  pace: Pace;
  section: S;
}

const METERS_PER_MILE = 1609.344;

/** "400 m", "5 km", "1 mi", "marathon", else kilometres to two places. */
function distanceLabel(m: number): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  if (near(m, 21097.5)) return 'half marathon';
  if (near(m, 42195)) return 'marathon';
  if (m < 1000 && near(m, Math.round(m))) return `${Math.round(m)} m`;
  if (near(m / 1000, Math.round(m / 1000))) return `${Math.round(m / 1000)} km`;
  const mi = m / METERS_PER_MILE;
  if (near(mi * 2, Math.round(mi * 2))) return `${mi} mi`;
  return `${(m / 1000).toFixed(2)} km`;
}

type MakeSection<S> = (span: Span, label: string) => S;

/** Best efforts by power inside a section: `ride.power.bestEffort(minutes(20))`. */
export class PowerEfforts<S> {
  readonly #src: AnalysisSource;
  readonly #make: MakeSection<S>;

  /** @internal */
  constructor(src: AnalysisSource, make: MakeSection<S>) {
    this.#src = src;
    this.#make = make;
  }

  /** The best average power held for `duration`; null with no power, no
   *  timestamps, or when the section is shorter. */
  bestEffort(duration: Duration): PowerBestEffort<S> | null {
    return this.curve([duration])[0] ?? null;
  }

  /** The best average power for each duration (by default a spread from
   *  1 s up to the section's length), shortest first. Never rises as the
   *  duration grows.
   *  Durations longer than the section are left out. Pauses longer than
   *  10 s count as 10 s, as in every time-weighted number here. */
  curve(durations?: readonly Duration[]): PowerBestEffort<S>[] {
    const w = windowOf(this.#src);
    if (!w?.power) return [];
    const secs = durations?.map((d) => d.seconds);
    if (secs?.some((d) => !Number.isFinite(d) || d <= 0))
      throw new RangeError('durations must be positive and finite');
    // the curve is built shortest first, and stops at the section's length
    const points = powerCurve(
      w.t,
      w.power,
      secs?.sort((a, b) => a - b),
    );
    const out: PowerBestEffort<S>[] = [];
    for (const p of points) {
      if (p.startIndex === undefined || p.endIndex === undefined) continue;
      // the first sample's power covers the time just before it
      const from = w.t[Math.max(p.startIndex - 1, 0)]!;
      const to = w.t[p.endIndex]!;
      const duration = Duration.seconds(p.durationSeconds);
      out.push({
        duration,
        power: Power.watts(p.watts),
        section: this.#make(
          { fromSeconds: from, toSeconds: to },
          `Best ${duration.format()}`,
        ),
      });
    }
    return out;
  }
}

/** Best efforts by pace inside a section: `run.pace.bestEffort(km(5))`. */
export class PaceEfforts<S> {
  readonly #src: AnalysisSource;
  readonly #make: MakeSection<S>;

  /** @internal */
  constructor(src: AnalysisSource, make: MakeSection<S>) {
    this.#src = src;
    this.#make = make;
  }

  /** The fastest time over `distance`; null with no distance, no
   *  timestamps, or when the section is shorter. */
  bestEffort(distance: Distance): PaceBestEffort<S> | null {
    return this.bestEfforts([distance])[0] ?? null;
  }

  /** The fastest time over each distance (by default 400 m up to the
   *  marathon), shortest first. Distances longer than the section are left
   *  out. A pool swim searches its lengths, so an effort starts and ends at
   *  a length's start or end (or the section's own ends). */
  bestEfforts(distances?: readonly Distance[]): PaceBestEffort<S>[] {
    const w = effortTimeline(this.#src);
    if (!w || !hasDistance(this.#src.prep)) return [];
    const meters = distances
      ? distances.map((d) => d.meters)
      : BEST_EFFORT_DISTANCES;
    if (meters.some((m) => !Number.isFinite(m) || m <= 0))
      throw new RangeError('distances must be positive and finite');
    const sorted = [...meters].sort((a, b) => a - b);
    return bestEffortsByDistance(w.cum, w.t, sorted).map((e) => {
      const from = w.t[e.startIndex ?? 0]!;
      const to = w.t[e.endIndex ?? w.t.length - 1]!;
      const distance = Distance.meters(e.meters);
      return {
        distance,
        time: Duration.seconds(e.seconds),
        pace: Pace.secondsPerKm(e.seconds / (e.meters / 1000)),
        section: this.#make(
          { fromSeconds: from, toSeconds: to },
          `Best ${distanceLabel(e.meters)}`,
        ),
      };
    });
  }
}
