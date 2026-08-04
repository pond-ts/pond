import { Temporal } from '@js-temporal/polyfill';

export type CalendarUnit = 'day' | 'week' | 'month';
export type WeekStartsOn = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type TimeZoneOptions = {
  timeZone?: string;
};
export type CalendarOptions = TimeZoneOptions & {
  weekStartsOn?: WeekStartsOn;
};

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_TIME_LOCAL_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

export function resolveTimeZone(options: TimeZoneOptions = {}): string {
  return options.timeZone ?? 'UTC';
}

export function normalizeWeekStartsOn(value: number | undefined): WeekStartsOn {
  const weekStartsOn = value ?? 1;
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 1 || weekStartsOn > 7) {
    throw new TypeError(
      'weekStartsOn must be an integer from 1 (Monday) to 7 (Sunday)',
    );
  }
  return weekStartsOn as WeekStartsOn;
}

function zonedDateTimeFromPlainDateTime(
  plain: Temporal.PlainDateTime,
  timeZone: string,
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: plain.year,
    month: plain.month,
    day: plain.day,
    hour: plain.hour,
    minute: plain.minute,
    second: plain.second,
    millisecond: plain.millisecond,
    microsecond: plain.microsecond,
    nanosecond: plain.nanosecond,
  });
}

export function parseTimestampString(
  value: string,
  options: TimeZoneOptions = {},
): number {
  const timeZone = resolveTimeZone(options);

  if (YEAR_MONTH_RE.test(value)) {
    const date = Temporal.PlainYearMonth.from(value).toPlainDate({ day: 1 });
    return date.toZonedDateTime({ timeZone }).startOfDay().epochMilliseconds;
  }

  if (DATE_ONLY_RE.test(value)) {
    return Temporal.PlainDate.from(value)
      .toZonedDateTime({ timeZone })
      .startOfDay().epochMilliseconds;
  }

  if (DATE_TIME_LOCAL_RE.test(value)) {
    return zonedDateTimeFromPlainDateTime(
      Temporal.PlainDateTime.from(value),
      timeZone,
    ).epochMilliseconds;
  }

  return Temporal.Instant.from(value).epochMilliseconds;
}

export function toPlainDateStart(
  instantMs: number,
  timeZone: string,
  unit: CalendarUnit,
  weekStartsOn: WeekStartsOn,
): Temporal.PlainDate {
  // **Floor to the containing millisecond.** `Temporal.Instant` refuses a
  // fractional epoch ms outright — `fromEpochMilliseconds(1577836800000.37)`
  // throws `epoch milliseconds must be an integer` — and a fraction is not a
  // caller error here. A chart's wheel-zoom derives its view range from pixel
  // positions through `xScale.invert()`, so a perfectly ordinary gesture hands
  // us `1.7e12 + 0.37`; realizing a calendar sequence over that range then
  // crashed the page outright.
  //
  // Flooring is the only sane reading rather than a papering-over: the epoch
  // millisecond *is* the atomic unit of this model, so an over-precise input
  // can only mean the millisecond containing it, and calendar boundaries are
  // themselves whole milliseconds — so the bucket containing `t` and the one
  // containing `t + 0.37` are necessarily the same. Integer inputs are
  // untouched.
  //
  // `Math.floor`, not `Math.trunc`: before 1970 they disagree, and `-5.5` lies
  // inside the millisecond spanning `[-6, -5)`, which is `-6`.
  const zoned = Temporal.Instant.fromEpochMilliseconds(
    Math.floor(instantMs),
  ).toZonedDateTimeISO(timeZone);
  const date = zoned.toPlainDate();

  if (unit === 'day') {
    return date;
  }

  if (unit === 'month') {
    return Temporal.PlainDate.from({
      year: date.year,
      month: date.month,
      day: 1,
    });
  }

  const offset = (date.dayOfWeek - weekStartsOn + 7) % 7;
  return date.subtract({ days: offset });
}

export function plainDateToStart(
  date: Temporal.PlainDate,
  timeZone: string,
): Temporal.ZonedDateTime {
  return date.toZonedDateTime({ timeZone }).startOfDay();
}

export function nextCalendarStart(
  current: Temporal.PlainDate,
  unit: CalendarUnit,
): Temporal.PlainDate {
  if (unit === 'day') {
    return current.add({ days: 1 });
  }
  if (unit === 'week') {
    return current.add({ weeks: 1 });
  }
  return current.add({ months: 1 });
}

export function dayRangeForDate(
  reference: string,
  options: TimeZoneOptions = {},
): { start: number; end: number } {
  const timeZone = resolveTimeZone(options);
  const start = Temporal.PlainDate.from(reference)
    .toZonedDateTime({ timeZone })
    .startOfDay();
  const end = start.add({ days: 1 });
  return {
    start: start.epochMilliseconds,
    end: end.epochMilliseconds,
  };
}

export function calendarRangeForReference(
  unit: CalendarUnit,
  reference: string,
  options: CalendarOptions = {},
): { start: number; end: number } {
  const timeZone = resolveTimeZone(options);
  const weekStartsOn = normalizeWeekStartsOn(options.weekStartsOn);
  const referenceMs = parseTimestampString(reference, { timeZone });
  const startDate = toPlainDateStart(referenceMs, timeZone, unit, weekStartsOn);
  const start = plainDateToStart(startDate, timeZone);
  const end = plainDateToStart(nextCalendarStart(startDate, unit), timeZone);
  return {
    start: start.epochMilliseconds,
    end: end.epochMilliseconds,
  };
}
