/**
 * Training load across a history: each activity's load with the method that
 * made it, and a day-by-day timeline of long- and short-term load.
 *
 * Methods:
 *
 * - `'cycling-tss'`: a ride with power and an FTP: elapsed seconds × NP × IF
 *   ÷ (FTP × 3600) × 100, as `section.analyze().load`.
 * - `'heart-rate-zones'`: any sport with heart rate and heart-rate zones:
 *   minutes in zone 1 to 5 weighted 1 to 5 (Edwards' method, on the
 *   athlete's own zones). Over elapsed time, so a stop counts at the low
 *   heart rate it has.
 *
 * The two are on different scales (an hour at threshold is about 100 TSS
 * but 240 by heart-rate zones), so a timeline uses one method. Adding them
 * would make a new power meter, or a forgotten heart-rate strap, look like a
 * change in fitness. A day whose activities have no load in the chosen method
 * is marked `'unscored'`, apart from rest days and gaps.
 */
import type { Profile, ZoneDef } from '../profile/index.js';
import type { ActivityDigest } from './digest.js';
import {
  dayNumber,
  dayOf,
  dayOfNumber,
  type Day,
  type DayRange,
} from './history.js';

export type LoadMethod = 'cycling-tss' | 'heart-rate-zones';

/** Why an activity has no load in a method. */
export type NoLoadReason =
  | 'not-a-ride'
  | 'no-power'
  | 'no-ftp'
  | 'no-heart-rate'
  | 'no-zones'
  | 'no-time';

/** One activity's load in one method. */
export interface ActivityLoad {
  activity: string;
  day: Day;
  method: LoadMethod;
  /** Null when the activity has no load in this method; `reason` says why. */
  value: number | null;
  reason: NoLoadReason | null;
}

/** What a day was, for a timeline. */
export type DayStatus = 'trained' | 'unscored' | 'rest' | 'gap';

export interface DayLoad {
  day: Day;
  /** Load scored that day (0 on rest, gap and unscored days). */
  load: number;
  /** Long-term load at the end of the day (CTL, "fitness"). */
  chronic: number;
  /** Short-term load at the end of the day (ATL, "fatigue"). */
  acute: number;
  /** Long minus short at the start of the day, from the day before's end
   *  (TSB, "form"): what you bring into the day. */
  balance: number;
  /** `'trained'`: some activity scored. `'unscored'`: activities, none with
   *  a load in this method. `'rest'`: no activity on a covered day. `'gap'`:
   *  outside the history's `covers`; nothing is known, and load is taken as
   *  0 so the curves keep decaying. */
  status: DayStatus;
  /** Ids of the day's activities with a load in this method. */
  scored: string[];
  /** Ids of the day's activities without one. */
  unscored: string[];
}

export interface TimelineOptions {
  method: LoadMethod;
  /** Default 42. */
  chronicDays?: number;
  /** Default 7. */
  acuteDays?: number;
  /** Long- and short-term load going into the first day. Default 0 each. */
  start?: { chronic: number; acute: number };
}

export interface LoadTimeline {
  method: LoadMethod;
  chronicDays: number;
  acuteDays: number;
  /** One per day from the first covered day (or activity) to the last. */
  days: DayLoad[];
}

/** Edwards' weights for zones 1 to 5. */
const ZONE_WEIGHTS = [1, 2, 3, 4, 5];

function hrZoneLoad(d: ActivityDigest, zones: ZoneDef): number {
  const h = d.heartRate!.histogram;
  let minutes = 0;
  for (let i = 0; i < h.seconds.length; i++) {
    const bpm = h.start + i;
    // The zone whose [edge, next edge) holds this bpm.
    let z = zones.edges.length - 2;
    while (z > 0 && bpm < zones.edges[z]!) z--;
    minutes +=
      ((h.seconds[i] ?? 0) / 60) * (ZONE_WEIGHTS[z] ?? ZONE_WEIGHTS[4]!);
  }
  return minutes;
}

/** One activity's load in one method. @internal */
export function loadOf(
  d: ActivityDigest,
  method: LoadMethod,
  athlete: Profile,
): ActivityLoad {
  const base = { activity: d.id, day: dayOf(d), method };
  const none = (reason: NoLoadReason): ActivityLoad => ({
    ...base,
    value: null,
    reason,
  });
  if (method === 'cycling-tss') {
    if (d.sport !== 'ride') return none('not-a-ride');
    const np = d.power?.normalized;
    if (np === undefined || np === null) return none('no-power');
    const ftp = athlete.ftpWatts;
    if (!ftp || ftp <= 0) return none('no-ftp');
    const elapsed = d.time.elapsed;
    if (!elapsed) return none('no-time');
    const intensity = np / ftp;
    return {
      ...base,
      value: ((elapsed * np * intensity) / (ftp * 3600)) * 100,
      reason: null,
    };
  }
  if (!d.heartRate) return none('no-heart-rate');
  const zones = athlete.heartRateZones;
  if (!zones) return none('no-zones');
  return { ...base, value: hrZoneLoad(d, zones), reason: null };
}

/** Load across a history. Made by `analysis.load`. */
export class HistoryLoad {
  readonly #digests: readonly ActivityDigest[];
  readonly #covers: DayRange | null;
  readonly #athleteOf: (d: ActivityDigest) => Profile;

  /** @internal */
  constructor(
    digests: readonly ActivityDigest[],
    covers: DayRange | null,
    athleteOf: (d: ActivityDigest) => Profile,
  ) {
    this.#digests = digests;
    this.#covers = covers;
    this.#athleteOf = athleteOf;
  }

  /** Each activity's load in one method, in start order. */
  activities(method: LoadMethod): ActivityLoad[] {
    return this.#digests.map((d) => loadOf(d, method, this.#athleteOf(d)));
  }

  /** Day-by-day long- and short-term load in one method:
   *  `chronic += (load − chronic) / chronicDays`, the same for acute, as
   *  TrainingPeaks' Performance Manager does (CTL / ATL / TSB). */
  timeline(options: TimelineOptions): LoadTimeline {
    const chronicDays = options.chronicDays ?? 42;
    const acuteDays = options.acuteDays ?? 7;
    if (!(chronicDays >= 1) || !(acuteDays >= 1))
      throw new RangeError('chronicDays and acuteDays must be at least 1');
    const loads = this.activities(options.method);
    const c = this.#covers;
    let lo = c ? dayNumber(c.from) : Infinity;
    let hi = c ? dayNumber(c.to) : -Infinity;
    const byDay = new Map<number, ActivityLoad[]>();
    for (const l of loads) {
      const n = dayNumber(l.day);
      if (n < lo) lo = n;
      if (n > hi) hi = n;
      const list = byDay.get(n);
      if (list) list.push(l);
      else byDay.set(n, [l]);
    }
    const days: DayLoad[] = [];
    if (!Number.isFinite(lo))
      return { method: options.method, chronicDays, acuteDays, days };
    const cLo = c ? dayNumber(c.from) : null;
    const cHi = c ? dayNumber(c.to) : null;
    let chronic = options.start?.chronic ?? 0;
    let acute = options.start?.acute ?? 0;
    for (let n = lo; n <= hi; n++) {
      const list = byDay.get(n) ?? [];
      const scored = list.filter((l) => l.value !== null);
      const load = scored.reduce((s, l) => s + l.value!, 0);
      const covered = cLo !== null && cHi !== null && n >= cLo && n <= cHi;
      const status: DayStatus =
        scored.length > 0
          ? 'trained'
          : list.length > 0
            ? 'unscored'
            : covered
              ? 'rest'
              : 'gap';
      const balance = chronic - acute;
      chronic += (load - chronic) / chronicDays;
      acute += (load - acute) / acuteDays;
      days.push({
        day: dayOfNumber(n),
        load,
        chronic,
        acute,
        balance,
        status,
        scored: scored.map((l) => l.activity),
        unscored: list.filter((l) => l.value === null).map((l) => l.activity),
      });
    }
    return { method: options.method, chronicDays, acuteDays, days };
  }
}
