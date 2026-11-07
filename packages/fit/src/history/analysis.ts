/**
 * A history read for one athlete: `history.analyze({ athlete })`.
 *
 * Settings are resolved per activity, on its own date, so a watts-per-kilogram
 * record uses the weight in force when the effort was made.
 */
import type { Activity, Section } from '../activity/activity.js';
import {
  distanceLabel,
  resolveAthlete,
  type AthleteInput,
} from '../activity/analysis.js';
import { Profile } from '../profile/index.js';
import { Distance, Duration, Pace, Power } from '../quantities.js';
import {
  DIGEST_PACE_DISTANCES,
  DIGEST_POWER_DURATIONS,
  type ActivityDigest,
} from './digest.js';
import { dayOf, type Day, type DayRange } from './history.js';
import { HistoryLoad } from './load.js';

export interface HistoryAnalyzeOptions {
  /** Dated settings: each activity uses the values in force at its start
   *  (resolved on the UTC start time, as `section.analyze()` does). A
   *  {@link Profile} is already resolved to one date, so it applies as is to
   *  every activity. Optional: records need none, W/kg needs weight. */
  athlete?: AthleteInput;
}

/** Where a record was set. */
export interface RecordPlace {
  /** The activity's id. */
  activity: string;
  day: Day;
  /** Elapsed time from the activity's start. */
  from: Duration;
  to: Duration;
  /** The stretch itself, when the history was given the full activity;
   *  null when it has only the digest. */
  section: Section | null;
}

/** The best average power over one duration across the history. */
export interface PowerRecord extends RecordPlace {
  duration: Duration;
  power: Power;
  /** Over the weight in force on the activity's date; null without one. */
  wattsPerKg: number | null;
}

/** The fastest time over one distance across the history. Elapsed time,
 *  stops included, as within one activity. */
export interface PaceRecord extends RecordPlace {
  distance: Distance;
  time: Duration;
  pace: Pace;
}

/** @internal what a history hands its analysis */
export interface HistoryParts {
  digests: readonly ActivityDigest[];
  activities: ReadonlyMap<string, Activity>;
  covers: DayRange | null;
}

const NO_SETTINGS = Profile.of({});

/** The kept values asked for (matched to a millionth, so `miles(1)` finds
 *  1609.344 m), sorted and without repeats. */
function pick(
  asked: readonly number[] | undefined,
  allowed: readonly number[],
  what: string,
): readonly number[] {
  if (!asked) return allowed;
  const out = new Set<number>();
  for (const v of asked) {
    const hit = allowed.find((a) => Math.abs(a - v) < 1e-6);
    if (hit === undefined)
      throw new RangeError(
        `a history keeps ${what} ${allowed.join(', ')}; ${v} isn't one`,
      );
    out.add(hit);
  }
  return [...out].sort((a, b) => a - b);
}

/** A history read for one athlete. */
export class HistoryAnalysis {
  readonly #parts: HistoryParts;
  readonly #athlete: AthleteInput | undefined;
  #power?: HistoryPower;
  #pace?: HistoryPace;
  #load?: HistoryLoad;

  /** @internal made by `history.analyze()` */
  constructor(parts: HistoryParts, options: HistoryAnalyzeOptions) {
    this.#parts = parts;
    this.#athlete = options.athlete;
  }

  /** Power records and the season's power curve. */
  get power(): HistoryPower {
    return (this.#power ??= new HistoryPower(this.#parts, (d) =>
      this.#athlete ? resolveAthlete(this.#athlete, d.startedAt) : NO_SETTINGS,
    ));
  }

  /** Each activity's load with its method, and the load timeline. */
  get load(): HistoryLoad {
    return (this.#load ??= new HistoryLoad(
      this.#parts.digests,
      this.#parts.covers,
      (d) =>
        this.#athlete
          ? resolveAthlete(this.#athlete, d.startedAt)
          : NO_SETTINGS,
    ));
  }

  /** Fastest times over distances. */
  get pace(): HistoryPace {
    return (this.#pace ??= new HistoryPace(this.#parts));
  }
}

function place(
  parts: HistoryParts,
  d: ActivityDigest,
  from: number,
  to: number,
  label: string,
): RecordPlace {
  const activity = parts.activities.get(d.id);
  return {
    activity: d.id,
    day: dayOf(d),
    from: Duration.seconds(from),
    to: Duration.seconds(to),
    section: activity
      ? activity.section(
          {
            elapsed: { from: Duration.seconds(from), to: Duration.seconds(to) },
          },
          label,
        )
      : null,
  };
}

/** Power across a history. Made by `analysis.power`. */
export class HistoryPower {
  readonly #parts: HistoryParts;
  readonly #athleteOf: (d: ActivityDigest) => Profile;

  /** @internal */
  constructor(parts: HistoryParts, athleteOf: (d: ActivityDigest) => Profile) {
    this.#parts = parts;
    this.#athleteOf = athleteOf;
  }

  /** The best average power for each duration, shortest first. Durations
   *  must be ones a digest keeps ({@link DIGEST_POWER_DURATIONS}); by
   *  default all of them. A duration no activity lasted is left out. On a
   *  tie the earlier activity keeps the record. */
  records(options: { durations?: readonly Duration[] } = {}): PowerRecord[] {
    const secs = pick(
      options.durations?.map((d) => d.seconds),
      DIGEST_POWER_DURATIONS,
      'power durations (seconds)',
    );
    const out: PowerRecord[] = [];
    for (const s of secs) {
      let best: {
        d: ActivityDigest;
        watts: number;
        from: number;
        to: number;
      } | null = null;
      for (const d of this.#parts.digests) {
        const p = d.power?.curve.find((c) => c.seconds === s);
        if (p && (!best || p.watts > best.watts))
          best = { d, watts: p.watts, from: p.from, to: p.to };
      }
      if (!best) continue;
      const weight = this.#athleteOf(best.d).weightKg;
      out.push({
        duration: Duration.seconds(s),
        power: Power.watts(best.watts),
        wattsPerKg: weight && weight > 0 ? best.watts / weight : null,
        ...place(
          this.#parts,
          best.d,
          best.from,
          best.to,
          `Best ${Duration.seconds(s).format()}`,
        ),
      });
    }
    return out;
  }

  /** The power curve over the history: {@link records} at every kept
   *  duration. Each point names the activity and stretch behind it. */
  curve(): PowerRecord[] {
    return this.records();
  }
}

/** Pace across a history. Made by `analysis.pace`. */
export class HistoryPace {
  readonly #parts: HistoryParts;

  /** @internal */
  constructor(parts: HistoryParts) {
    this.#parts = parts;
  }

  /** The fastest time over each distance, shortest first. Distances must be
   *  ones a digest keeps ({@link DIGEST_PACE_DISTANCES}); by default all of
   *  them. A distance nobody covered is left out. On a tie the earlier
   *  activity keeps the record. */
  records(options: { distances?: readonly Distance[] } = {}): PaceRecord[] {
    const metres = pick(
      options.distances?.map((d) => d.meters),
      DIGEST_PACE_DISTANCES,
      'pace distances (metres)',
    );
    const out: PaceRecord[] = [];
    for (const m of metres) {
      let best: {
        d: ActivityDigest;
        seconds: number;
        from: number;
        to: number;
      } | null = null;
      for (const d of this.#parts.digests) {
        const p = d.pace.find((c) => c.metres === m);
        if (p && (!best || p.seconds < best.seconds))
          best = { d, seconds: p.seconds, from: p.from, to: p.to };
      }
      if (!best) continue;
      out.push({
        distance: Distance.meters(m),
        time: Duration.seconds(best.seconds),
        pace: Pace.secondsPerKm(best.seconds / (m / 1000)),
        ...place(
          this.#parts,
          best.d,
          best.from,
          best.to,
          `Best ${distanceLabel(m)}`,
        ),
      });
    }
    return out;
  }
}
