/**
 * Many activities read together: `TrainingHistory.of(digests)`.
 *
 * A history works on {@link ActivityDigest}s, so an app can answer questions
 * across years without loading every recording. Full activities can be
 * passed in too; they are digested, and kept so a result can hand back the
 * activity behind it.
 *
 * Days are the local date where an activity happened (from the digest's
 * `localStart`), or the UTC date when the file gave no local time.
 *
 * `covers` is the stretch of days the history is known to be complete for.
 * A day inside it with no activity is a rest day; a day outside it is a gap
 * (nothing is known). By default it runs from the first activity's day to
 * the last one's.
 */
import { Activity } from '../activity/activity.js';
import type { Sport } from '../activity/sport.js';
import { Distance, Duration, Elevation } from '../quantities.js';
import { checkDigest, digestOf, type ActivityDigest } from './digest.js';

/** A calendar day, "YYYY-MM-DD". */
export type Day = string;

export interface DayRange {
  /** First day, inclusive. */
  from: Day;
  /** Last day, inclusive. */
  to: Day;
}

export interface HistoryOptions {
  /** The days the history is complete for. Default: first activity's day to
   *  the last one's. */
  covers?: DayRange;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function checkDay(day: string, what: string): void {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))
    throw new RangeError(
      `${what} must be a date like "2026-01-31", not "${day}"`,
    );
}

/** Days from 1970-01-01 to a day. @internal */
export function dayNumber(day: Day): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);
}

/** The day a day number names. @internal */
export function dayOfNumber(n: number): Day {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The day an activity counts on. */
export function dayOf(d: ActivityDigest): Day {
  return (d.localStart ?? d.startedAt).slice(0, 10);
}

/** Many activities, ordered by start. */
export class TrainingHistory {
  readonly #digests: readonly ActivityDigest[];
  readonly #activities: ReadonlyMap<string, Activity>;
  readonly #covers: DayRange | null;

  private constructor(
    digests: readonly ActivityDigest[],
    activities: ReadonlyMap<string, Activity>,
    covers: DayRange | null,
  ) {
    this.#digests = digests;
    this.#activities = activities;
    this.#covers = covers;
  }

  /** A history of activities or their digests (both can be mixed). Two
   *  items with the same id are an error. */
  static of(
    items: Iterable<Activity | ActivityDigest>,
    options: HistoryOptions = {},
  ): TrainingHistory {
    const digests: ActivityDigest[] = [];
    const activities = new Map<string, Activity>();
    const seen = new Set<string>();
    for (const item of items) {
      let d: ActivityDigest;
      if (item instanceof Activity) {
        d = digestOf(item);
        activities.set(d.id, item);
      } else {
        checkDigest(item);
        d = item;
      }
      if (seen.has(d.id))
        throw new RangeError(`activity "${d.id}" is in the history twice`);
      seen.add(d.id);
      digests.push(d);
    }
    digests.sort((a, b) =>
      a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
    );
    let covers: DayRange | null = null;
    if (options.covers) {
      checkDay(options.covers.from, 'covers.from');
      checkDay(options.covers.to, 'covers.to');
      if (options.covers.from > options.covers.to)
        throw new RangeError('covers.from is after covers.to');
      covers = { ...options.covers };
    } else if (digests.length > 0) {
      const days = digests.map(dayOf).sort();
      covers = { from: days[0]!, to: days[days.length - 1]! };
    }
    return new TrainingHistory(digests, activities, covers);
  }

  /** The digests, ordered by start. */
  get digests(): readonly ActivityDigest[] {
    return this.#digests;
  }

  get length(): number {
    return this.#digests.length;
  }

  /** The days the history is complete for; null for an empty history with
   *  no `covers` given. */
  get covers(): DayRange | null {
    return this.#covers;
  }

  /** The full activity behind a digest, when it was passed in as one. */
  activity(id: string): Activity | null {
    return this.#activities.get(id) ?? null;
  }

  /** Activities on days `from` to `to`, inclusive. `covers` is narrowed to
   *  the same days. */
  between(range: DayRange): TrainingHistory {
    checkDay(range.from, 'from');
    checkDay(range.to, 'to');
    if (range.from > range.to) throw new RangeError('from is after to');
    const digests = this.#digests.filter((d) => {
      const day = dayOf(d);
      return day >= range.from && day <= range.to;
    });
    const c = this.#covers;
    const covers =
      c && c.from <= range.to && c.to >= range.from
        ? {
            from: c.from > range.from ? c.from : range.from,
            to: c.to < range.to ? c.to : range.to,
          }
        : null;
    return new TrainingHistory(digests, this.#activities, covers);
  }

  /** Only activities of these sports. `covers` is kept: a day with only
   *  other sports is a rest day for these. */
  sports(sports: readonly Sport[]): TrainingHistory {
    const keep = new Set(sports);
    return new TrainingHistory(
      this.#digests.filter((d) => keep.has(d.sport)),
      this.#activities,
      this.#covers,
    );
  }

  /** Totals by week. Needs no athlete settings. */
  get volume(): Volume {
    return new Volume(this.#digests, this.#covers);
  }
}

/** Totals over a set of activities. */
export interface VolumeTotals {
  count: number;
  distance: Distance;
  /** Summed over activities with a moving time. */
  moving: Duration;
  elapsed: Duration;
  ascent: Elevation;
}

/** One week of training. */
export interface WeekVolume extends VolumeTotals {
  /** The week's first day. */
  week: Day;
  /** Its last day. */
  to: Day;
  /** `'full'` when every day of the week is inside `covers`, `'partial'`
   *  when some are, `'gap'` when none are (nothing known about the week;
   *  its totals are 0 but don't mean rest). */
  coverage: 'full' | 'partial' | 'gap';
  /** The longest activity by distance, or by elapsed time when none has a
   *  distance; null in an empty week. */
  longest: {
    id: string;
    distance: Distance | null;
    elapsed: Duration | null;
  } | null;
  /** The same totals for each sport that week. */
  bySport: Partial<Record<Sport, VolumeTotals>>;
}

export interface WeeklyOptions {
  /** Default `'monday'`. */
  weekStart?: 'monday' | 'sunday';
}

interface Acc {
  count: number;
  distance: number;
  moving: number;
  elapsed: number;
  ascent: number;
}

const emptyAcc = (): Acc => ({
  count: 0,
  distance: 0,
  moving: 0,
  elapsed: 0,
  ascent: 0,
});

function add(a: Acc, d: ActivityDigest): void {
  a.count++;
  a.distance += d.distance ?? 0;
  a.moving += d.time.moving ?? 0;
  a.elapsed += d.time.elapsed ?? 0;
  a.ascent += d.ascent ?? 0;
}

function totals(a: Acc): VolumeTotals {
  return {
    count: a.count,
    distance: Distance.meters(a.distance),
    moving: Duration.seconds(a.moving),
    elapsed: Duration.seconds(a.elapsed),
    ascent: Elevation.meters(a.ascent),
  };
}

/** Training volume. Made by `history.volume`. */
export class Volume {
  readonly #digests: readonly ActivityDigest[];
  readonly #covers: DayRange | null;

  /** @internal */
  constructor(digests: readonly ActivityDigest[], covers: DayRange | null) {
    this.#digests = digests;
    this.#covers = covers;
  }

  /** Every week from the one holding the first covered day (or activity) to
   *  the one holding the last, empty weeks kept, so the array feeds a chart
   *  as it is. */
  weekly(options: WeeklyOptions = {}): WeekVolume[] {
    const startDow = options.weekStart === 'sunday' ? 0 : 1;
    const days = this.#digests.map((d) => dayNumber(dayOf(d)));
    const c = this.#covers;
    const lo = Math.min(...days, ...(c ? [dayNumber(c.from)] : []));
    const hi = Math.max(...days, ...(c ? [dayNumber(c.to)] : []));
    if (!Number.isFinite(lo)) return [];
    // 1970-01-01 was a Thursday (day of week 4).
    const weekOf = (n: number) => n - ((((n + 4 - startDow) % 7) + 7) % 7);
    const first = weekOf(lo);
    const weeks: {
      acc: Acc;
      sports: Map<Sport, Acc>;
      items: ActivityDigest[];
    }[] = [];
    for (let w = first; w <= hi; w += 7)
      weeks.push({ acc: emptyAcc(), sports: new Map(), items: [] });
    this.#digests.forEach((d, i) => {
      const wk = weeks[(weekOf(days[i]!) - first) / 7]!;
      add(wk.acc, d);
      let s = wk.sports.get(d.sport);
      if (!s) wk.sports.set(d.sport, (s = emptyAcc()));
      add(s, d);
      wk.items.push(d);
    });
    const cLo = c ? dayNumber(c.from) : null;
    const cHi = c ? dayNumber(c.to) : null;
    return weeks.map((wk, k) => {
      const from = first + k * 7;
      const to = from + 6;
      let covered = 0;
      if (cLo !== null && cHi !== null)
        covered = Math.max(0, Math.min(to, cHi) - Math.max(from, cLo) + 1);
      const longest = wk.items.reduce<ActivityDigest | null>((best, d) => {
        if (!best) return d;
        const key = (x: ActivityDigest) =>
          [x.distance ?? -1, x.time.elapsed ?? -1] as const;
        const [a1, a2] = key(d);
        const [b1, b2] = key(best);
        return a1 > b1 || (a1 === b1 && a2 > b2) ? d : best;
      }, null);
      const bySport: Partial<Record<Sport, VolumeTotals>> = {};
      for (const [sport, acc] of wk.sports) bySport[sport] = totals(acc);
      return {
        week: dayOfNumber(from),
        to: dayOfNumber(to),
        ...totals(wk.acc),
        coverage: covered === 7 ? 'full' : covered > 0 ? 'partial' : 'gap',
        longest: longest
          ? {
              id: longest.id,
              distance:
                longest.distance !== null
                  ? Distance.meters(longest.distance)
                  : null,
              elapsed:
                longest.time.elapsed !== null
                  ? Duration.seconds(longest.time.elapsed)
                  : null,
            }
          : null,
        bySport,
      };
    });
  }
}
