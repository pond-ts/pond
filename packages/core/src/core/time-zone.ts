import { Temporal } from '@js-temporal/polyfill';
import type { CalendarUnit, WeekStartsOn } from './calendar.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
/**
 * Half-window either side of a civil time within which every candidate
 * offset for that wall time must lie. IANA offsets span −12:00 … +14:00, and
 * the two offsets bracketing a transition differ by at most a few hours, so
 * ±16 h comfortably covers both sides of any transition.
 */
const CANDIDATE_WINDOW_MS = 16 * MS_PER_HOUR;

/**
 * How `TimeZone.instant()` resolves a wall-clock time that a transition
 * makes ambiguous (a fall-back repeats an hour) or skips (a spring-forward
 * drops one). Same vocabulary and same defaults as Temporal:
 *
 * - `'compatible'` (default) — the earlier instant when the time repeats,
 *   the instant *after* the gap when it is skipped (02:30 on a spring-forward
 *   night becomes 03:30). This is also what `startOf('day')` needs on the
 *   rare days that have no midnight.
 * - `'earlier'` / `'later'` — always the earlier / later of the two readings.
 * - `'reject'` — throw a `RangeError` for either case.
 */
export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';

/** The wall-clock reading of an instant in a zone. `weekday` is ISO: 1 = Monday … 7 = Sunday. */
export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
};

/** The date-and-time fields `TimeZone.instant()` accepts. Time fields default to zero. */
export type ZonedPartsInput = {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
};

export type StartOfOptions = {
  /** First day of the week for `'week'`, ISO numbering (1 = Monday, default) … 7 = Sunday. */
  weekStartsOn?: WeekStartsOn;
};

/**
 * A stretch of instants over which a zone's UTC offset is constant:
 * `[start, end)`, with `-Infinity` / `Infinity` at the ends of the zone's
 * known history. Everything the zone does in steady state is arithmetic on
 * the segment containing the instant; Temporal is consulted once per
 * segment and never again.
 */
type Segment = {
  readonly start: number;
  readonly end: number;
  readonly offsetMs: number;
  /** Short names already resolved for this segment, keyed by locale. */
  abbreviations?: Map<string, string>;
};

/**
 * Days since 1970-01-01 for a proleptic-Gregorian civil date (Howard
 * Hinnant's algorithm, valid for the whole `Date` range).
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Inverse of `daysFromCivil`: `[year, month, day]` for a day number. */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36_524) -
      Math.floor(doe / 146_096)) /
      365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

/** Days in a proleptic-Gregorian month. */
function daysInMonth(year: number, month: number): number {
  return (
    daysFromCivil(month === 12 ? year + 1 : year, (month % 12) + 1, 1) -
    daysFromCivil(year, month, 1)
  );
}

/** ISO weekday (1 = Monday … 7 = Sunday) for a day number; day 0 was a Thursday. */
function weekdayFromDays(days: number): ZonedParts['weekday'] {
  return ((((days % 7) + 7 + 3) % 7) + 1) as ZonedParts['weekday'];
}

function floorMs(ms: number, label: string): number {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`${label} must be a finite epoch millisecond`);
  }
  // Floor, not trunc: before 1970 they disagree, and -5.5 lies inside the
  // millisecond spanning [-6, -5). See `toPlainDateStart` for why a fraction
  // is not a caller error (a chart's wheel zoom hands us `1.7e12 + 0.37`).
  return Math.floor(ms);
}

function assertCalendarUnit(unit: string): asserts unit is CalendarUnit {
  switch (unit) {
    case 'day':
    case 'week':
    case 'month':
    case 'quarter':
    case 'year':
      return;
    default:
      throw new RangeError(
        `unknown calendar unit ${JSON.stringify(unit)}; expected 'day', 'week', 'month', 'quarter' or 'year'`,
      );
  }
}

const registry = new Map<string, TimeZone>();

/**
 * An IANA time zone as a calendar: the one place in pond that turns instants
 * (UTC epoch milliseconds) into wall-clock readings and calendar boundaries,
 * and back.
 *
 * Instances are interned — `TimeZone.of('Europe/Berlin')` returns the same
 * object every time — and cache the zone's offset transitions as they are
 * discovered, so after the first query in a stretch of history every call
 * is integer arithmetic. `Sequence.calendar` buckets with it; the charts'
 * time axis places and labels ticks with it; the two therefore agree on
 * every boundary by construction.
 *
 * A `TimeZone` holds no instant. Values (`Time`, `TimeRange`, `Interval`)
 * stay plain UTC milliseconds; the zone is a parameter to the code that
 * interprets them.
 */
export class TimeZone {
  /** The canonical IANA identifier, e.g. `'America/New_York'` or `'UTC'`. */
  readonly id: string;
  /** Offset segments sorted by `start`, non-overlapping. */
  readonly #segments: Segment[] = [];
  /** The segment most recently hit — almost every query lands here. */
  #last: Segment | undefined;
  #abbreviationFormats: Map<string, Intl.DateTimeFormat> | undefined;

  private constructor(id: string) {
    this.id = id;
    Object.freeze(this);
  }

  /**
   * Example: `TimeZone.of('Australia/Sydney')`. Looks up a zone by IANA
   * identifier. Throws `RangeError` for an identifier the runtime does not
   * know. Case-insensitive on input; `id` reports the canonical spelling.
   * A fixed-offset identifier such as `'+05:30'` is accepted too, as
   * Temporal accepts it, and behaves as a zone with a single segment.
   */
  static of(id: string): TimeZone {
    const hit = registry.get(id);
    if (hit !== undefined) return hit;
    let canonical: string;
    try {
      canonical =
        Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(
          id,
        ).timeZoneId;
    } catch {
      throw new RangeError(`unknown time zone ${JSON.stringify(id)}`);
    }
    const existing = registry.get(canonical);
    const zone = existing ?? new TimeZone(canonical);
    registry.set(id, zone);
    registry.set(canonical, zone);
    return zone;
  }

  /** Example: `TimeZone.UTC.startOf('month', t)`. The UTC zone. */
  static get UTC(): TimeZone {
    return TimeZone.of('UTC');
  }

  /**
   * Example: `TimeZone.local()`. The runtime's own zone, as the environment
   * reports it. Resolved on every call, so a test that changes `TZ` between
   * calls sees the change.
   */
  static local(): TimeZone {
    return TimeZone.of(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /** Example: `zone.offsetAt(t)`. The zone's UTC offset at an instant, in milliseconds east of UTC. */
  offsetAt(ms: number): number {
    return this.#segmentAt(floorMs(ms, 'instant')).offsetMs;
  }

  /**
   * Example: `zone.parts(t).hour`. The wall-clock reading of an instant in
   * this zone.
   */
  parts(ms: number): ZonedParts {
    const t = floorMs(ms, 'instant');
    const civil = t + this.#segmentAt(t).offsetMs;
    return TimeZone.#civilParts(civil);
  }

  /**
   * Example: `zone.instant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 })`.
   * The instant at which this zone's clocks read the given wall time. When
   * a transition makes the reading ambiguous or nonexistent,
   * `disambiguation` decides (default `'compatible'`, as Temporal).
   */
  instant(
    parts: ZonedPartsInput,
    options: { disambiguation?: Disambiguation } = {},
  ): number {
    const civil = TimeZone.#civilMs(parts);
    return this.#instantForCivil(civil, options.disambiguation ?? 'compatible');
  }

  /**
   * Example: `zone.startOf('week', t, { weekStartsOn: 7 })`. The first
   * instant of the calendar unit containing `ms`, in this zone. On a day
   * with no midnight (a spring-forward at 00:00) this is the first instant
   * that exists, as `Temporal.ZonedDateTime.startOfDay` does.
   */
  startOf(
    unit: CalendarUnit,
    ms: number,
    options: StartOfOptions = {},
  ): number {
    assertCalendarUnit(unit);
    const t = floorMs(ms, 'instant');
    const civil = t + this.#segmentAt(t).offsetMs;
    const days = Math.floor(civil / MS_PER_DAY);
    return this.#instantForCivil(
      TimeZone.#startDays(unit, days, options.weekStartsOn ?? 1) * MS_PER_DAY,
      'compatible',
    );
  }

  /**
   * Example: `zone.next('month', t)`. The first instant of the calendar unit
   * *after* the one containing `ms` — i.e. the exclusive end of `startOf`'s
   * bucket.
   */
  next(unit: CalendarUnit, ms: number, options: StartOfOptions = {}): number {
    assertCalendarUnit(unit);
    const t = floorMs(ms, 'instant');
    const civil = t + this.#segmentAt(t).offsetMs;
    const days = Math.floor(civil / MS_PER_DAY);
    const startDays = TimeZone.#startDays(
      unit,
      days,
      options.weekStartsOn ?? 1,
    );
    return this.#instantForCivil(
      TimeZone.#advanceDays(unit, startDays) * MS_PER_DAY,
      'compatible',
    );
  }

  /**
   * Example: `zone.abbreviation(t)` → `'EDT'`. The zone's short name at an
   * instant, as `Intl` reports it for `locale` (default: the runtime's
   * locale). Which zones have a conventional abbreviation is a locale
   * question — `en-US` knows `EST`, `en-AU` knows `AEDT`, and neither knows
   * the other's; the fallback is a `GMT±h[:mm]` offset string. Pass the
   * viewer's locale when rendering.
   */
  abbreviation(ms: number, options: { locale?: string } = {}): string {
    const t = floorMs(ms, 'instant');
    const segment = this.#segmentAt(t);
    const locale = options.locale ?? '';
    const cached = segment.abbreviations?.get(locale);
    if (cached !== undefined) return cached;
    this.#abbreviationFormats ??= new Map();
    let format = this.#abbreviationFormats.get(locale);
    if (format === undefined) {
      format = new Intl.DateTimeFormat(locale === '' ? undefined : locale, {
        timeZone: this.id,
        timeZoneName: 'short',
      });
      this.#abbreviationFormats.set(locale, format);
    }
    const part = format
      .formatToParts(new Date(t))
      .find((p) => p.type === 'timeZoneName');
    const abbreviation = part?.value ?? this.id;
    (segment.abbreviations ??= new Map()).set(locale, abbreviation);
    return abbreviation;
  }

  toString(): string {
    return this.id;
  }

  toJSON(): string {
    return this.id;
  }

  // ---- internals ---------------------------------------------------------

  #segmentAt(t: number): Segment {
    const last = this.#last;
    if (last !== undefined && t >= last.start && t < last.end) return last;
    const segments = this.#segments;
    // Binary search for the segment whose start is the greatest <= t.
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid]!;
      if (t < s.start) hi = mid - 1;
      else if (t >= s.end) lo = mid + 1;
      else {
        this.#last = s;
        return s;
      }
    }
    const created = this.#discoverSegment(t);
    segments.splice(lo, 0, created);
    this.#last = created;
    return created;
  }

  /**
   * Ask Temporal for the offset at `t` and the transitions bracketing it.
   *
   * `getTimeZoneTransition('previous')` is *strictly* before its receiver,
   * while the offset at a transition instant is already the new one — so
   * asking at `t` itself, when `t` *is* a transition, would pair the new
   * offset with the start of the old segment and poison the cache for the
   * whole preceding stretch (every hourly series crosses a DST instant
   * exactly). Asking from `t + 1 ms` returns transitions `<= t`, which is
   * the segment start we want; `'next'` from `t` is strictly after, which
   * is the exclusive end we want.
   */
  #discoverSegment(t: number): Segment {
    const zoned = Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO(
      this.id,
    );
    const previous = Temporal.Instant.fromEpochMilliseconds(t + 1)
      .toZonedDateTimeISO(this.id)
      .getTimeZoneTransition('previous');
    const next = zoned.getTimeZoneTransition('next');
    return {
      start: previous === null ? -Infinity : previous.epochMilliseconds,
      end: next === null ? Infinity : next.epochMilliseconds,
      offsetMs: zoned.offsetNanoseconds / 1_000_000,
    };
  }

  /**
   * The instant whose wall-clock reading is the civil millisecond `civil`
   * (a UTC-encoded wall time). Candidate offsets are the ones in force just
   * before and just after the wall time; a candidate is valid when the
   * instant it implies actually carries that offset.
   */
  #instantForCivil(civil: number, disambiguation: Disambiguation): number {
    const before = this.#segmentAt(civil - CANDIDATE_WINDOW_MS);
    const after = this.#segmentAt(civil + CANDIDATE_WINDOW_MS);
    const tBefore = civil - before.offsetMs;
    const validBefore = this.#segmentAt(tBefore).offsetMs === before.offsetMs;
    if (before === after || before.offsetMs === after.offsetMs) {
      if (validBefore) return tBefore;
      // Same offset either side but a transition pair sits in between
      // (a brief change and back) — fall through to the general search.
    }
    const tAfter = civil - after.offsetMs;
    const validAfter = this.#segmentAt(tAfter).offsetMs === after.offsetMs;

    if (validBefore && validAfter) {
      if (tBefore === tAfter) return tBefore;
      // The wall time repeats: `tBefore` is the earlier reading.
      switch (disambiguation) {
        case 'reject':
          throw new RangeError(
            `wall-clock time ${TimeZone.#civilString(civil)} is ambiguous in ${this.id}`,
          );
        case 'later':
          return Math.max(tBefore, tAfter);
        default:
          return Math.min(tBefore, tAfter);
      }
    }
    if (validBefore) return tBefore;
    if (validAfter) return tAfter;

    // The wall time is skipped. Temporal's 'compatible' moves forward past
    // the gap: keep the offset that was in force before it, which lands
    // the same distance after the transition as the wall time was after
    // the old clock's last reading.
    switch (disambiguation) {
      case 'reject':
        throw new RangeError(
          `wall-clock time ${TimeZone.#civilString(civil)} does not exist in ${this.id}`,
        );
      case 'earlier':
        return civil - after.offsetMs;
      default:
        return civil - before.offsetMs;
    }
  }

  static #civilMs(parts: ZonedPartsInput): number {
    const { year, month, day } = parts;
    const hour = parts.hour ?? 0;
    const minute = parts.minute ?? 0;
    const second = parts.second ?? 0;
    const millisecond = parts.millisecond ?? 0;
    const inRange = (v: number, lo: number, hi: number) =>
      Number.isInteger(v) && v >= lo && v <= hi;
    if (
      !Number.isInteger(year) ||
      !inRange(month, 1, 12) ||
      !inRange(day, 1, daysInMonth(year, month)) ||
      !inRange(hour, 0, 23) ||
      !inRange(minute, 0, 59) ||
      !inRange(second, 0, 59) ||
      !inRange(millisecond, 0, 999)
    ) {
      // Reject rather than roll over: `{ month: 2, day: 30 }` is a caller
      // error, not February 30th, and silently landing on March 2nd is how
      // a bucket edge ends up in the wrong month.
      throw new RangeError(`invalid wall-clock time ${JSON.stringify(parts)}`);
    }
    return (
      daysFromCivil(year, month, day) * MS_PER_DAY +
      hour * MS_PER_HOUR +
      minute * 60_000 +
      second * 1_000 +
      millisecond
    );
  }

  static #civilParts(civil: number): ZonedParts {
    const days = Math.floor(civil / MS_PER_DAY);
    let rem = civil - days * MS_PER_DAY;
    const [year, month, day] = civilFromDays(days);
    const hour = Math.floor(rem / MS_PER_HOUR);
    rem -= hour * MS_PER_HOUR;
    const minute = Math.floor(rem / 60_000);
    rem -= minute * 60_000;
    const second = Math.floor(rem / 1_000);
    const millisecond = rem - second * 1_000;
    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      millisecond,
      weekday: weekdayFromDays(days),
    };
  }

  static #civilString(civil: number): string {
    return new Date(civil).toISOString().replace('Z', '');
  }

  /** Day number of the first day of the `unit` containing day number `days`. */
  static #startDays(
    unit: CalendarUnit,
    days: number,
    weekStartsOn: WeekStartsOn,
  ): number {
    switch (unit) {
      case 'day':
        return days;
      case 'week':
        return days - ((weekdayFromDays(days) - weekStartsOn + 7) % 7);
      case 'month': {
        const [y, m] = civilFromDays(days);
        return daysFromCivil(y, m, 1);
      }
      case 'quarter': {
        const [y, m] = civilFromDays(days);
        return daysFromCivil(y, m - ((m - 1) % 3), 1);
      }
      case 'year': {
        const [y] = civilFromDays(days);
        return daysFromCivil(y, 1, 1);
      }
    }
  }

  /** Day number of the start of the following `unit`, given a unit-start day number. */
  static #advanceDays(unit: CalendarUnit, startDays: number): number {
    switch (unit) {
      case 'day':
        return startDays + 1;
      case 'week':
        return startDays + 7;
      case 'month':
      case 'quarter':
      case 'year': {
        const [y, m] = civilFromDays(startDays);
        const months = unit === 'month' ? 1 : unit === 'quarter' ? 3 : 12;
        const total = y * 12 + (m - 1) + months;
        return daysFromCivil(Math.floor(total / 12), (total % 12) + 1, 1);
      }
    }
  }
}

export { assertCalendarUnit };
