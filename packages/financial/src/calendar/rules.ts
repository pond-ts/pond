import { Temporal } from '@js-temporal/polyfill';
import type { Session, SessionBreak } from './session.js';

/**
 * The rule-based construction path: a compact description that *generates* a
 * session schedule over a date range. The other, first-class path is an
 * explicit {@link Session} list (see `session.ts`); rules are for consumers who
 * have hours + a holiday list rather than dated instants.
 *
 * Session hours are given in **exchange-local wall time against an IANA zone**
 * and resolved to UTC instants per-day, so DST is handled correctly (a
 * 09:30 open is 09:30 local year-round, not a fixed UTC offset).
 *
 * Only **regular** (same-day, `open < close`) sessions are supported here, plus
 * the full-day `"24:00"` close. True overnight sessions (close on the next
 * calendar day, e.g. CME 17:00→16:00) need an explicit trading-day-assignment
 * rule and are deferred to a later phase — build those via an explicit
 * {@link Session} list for now.
 */
export interface SessionRules {
  /** IANA zone the wall-clock hours are interpreted in, e.g. `"America/New_York"`. */
  timeZone: string;
  /** Regular open, local `"HH:MM"`. */
  open: string;
  /** Regular close, local `"HH:MM"` (or `"24:00"` for end-of-day). Must be after `open`. */
  close: string;
  /** Trading days of week as ISO weekday numbers (1 = Monday … 7 = Sunday). Defaults to Monday–Friday `[1, 2, 3, 4, 5]`. */
  weekmask?: readonly number[];
  /** Intraday breaks (e.g. a lunch), each local `"HH:MM"`, within `[open, close]`. */
  breaks?: readonly { start: string; end: string }[];
  /** Dates (`YYYY-MM-DD`) with no session — the market is closed. */
  holidays?: readonly string[];
  /** Per-date early closes (`YYYY-MM-DD` → local `"HH:MM"`) — half-days that override the regular close. */
  earlyCloses?: readonly { date: string; close: string }[];
}

/** A generation range. Each bound is a `YYYY-MM-DD` date, epoch-ms, or `Date`; instants are resolved to the local date in the rules' zone. */
export interface DateRange {
  from: string | number | Date;
  to: string | number | Date;
}

const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Parse `"HH:MM"` (or `"24:00"`) to minutes-since-midnight in `[0, 1440]`. */
function parseMinutes(time: string): number {
  const m = TIME_RE.exec(time);
  if (!m)
    throw new TypeError(`time must be "HH:MM"; got ${JSON.stringify(time)}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59)
    throw new RangeError(`minutes out of range in ${JSON.stringify(time)}`);
  const total = hours * 60 + minutes;
  if (total > 1440)
    throw new RangeError(`time past 24:00 in ${JSON.stringify(time)}`);
  return total;
}

/** Resolve a local wall-clock minute-of-day on `date` to a UTC epoch-ms instant, DST-correct. */
function instantAt(
  date: Temporal.PlainDate,
  minutes: number,
  timeZone: string,
): number {
  if (minutes === 1440) {
    // End-of-day: the start of the following day in this zone.
    return date.add({ days: 1 }).toZonedDateTime({ timeZone })
      .epochMilliseconds;
  }
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  }).epochMilliseconds;
}

/** Resolve a range bound to a `Temporal.PlainDate` in the given zone. */
function toPlainDate(
  bound: string | number | Date,
  timeZone: string,
): Temporal.PlainDate {
  if (typeof bound === 'string') return Temporal.PlainDate.from(bound);
  const ms = bound instanceof Date ? bound.getTime() : bound;
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
}

/**
 * Generate the {@link Session} list a {@link SessionRules} describes over
 * `range` (inclusive of both endpoint dates). Non-trading days (off the
 * weekmask or in `holidays`) are simply absent; `earlyCloses` shorten the
 * matching day. The result is sorted, well-formed, and ready to build a
 * `TradingCalendar` from.
 */
export function generateSessions(
  rules: SessionRules,
  range: DateRange,
): Session[] {
  const { timeZone } = rules;
  const weekmask = new Set(rules.weekmask ?? [1, 2, 3, 4, 5]);
  const holidays = new Set(rules.holidays ?? []);
  const earlyByDate = new Map(
    (rules.earlyCloses ?? []).map((e) => [e.date, e.close]),
  );

  const openMin = parseMinutes(rules.open);
  const regularCloseMin = parseMinutes(rules.close);
  if (regularCloseMin <= openMin) {
    throw new RangeError(
      `SessionRules close (${rules.close}) must be after open (${rules.open}); ` +
        'overnight sessions are not supported by rules — use an explicit session list.',
    );
  }
  const breakMins = (rules.breaks ?? [])
    .map((b) => ({ start: parseMinutes(b.start), end: parseMinutes(b.end) }))
    .sort((a, b) => a.start - b.start);
  // Validate the rule-level breaks once (they repeat every day) so a direct
  // generateSessions caller can't get a malformed list — not only the
  // fromRules path, which re-validates via normalizeSessions.
  let prevEnd = openMin;
  for (const b of breakMins) {
    if (b.end <= b.start) {
      throw new RangeError('break end must be after start');
    }
    if (b.start < prevEnd || b.end > regularCloseMin) {
      throw new RangeError(
        'breaks must be within [open, close], sorted, and non-overlapping',
      );
    }
    prevEnd = b.end;
  }

  const start = toPlainDate(range.from, timeZone);
  const end = toPlainDate(range.to, timeZone);
  if (Temporal.PlainDate.compare(end, start) < 0) {
    throw new RangeError('range.to must be on or after range.from');
  }

  const sessions: Session[] = [];
  for (
    let date = start;
    Temporal.PlainDate.compare(date, end) <= 0;
    date = date.add({ days: 1 })
  ) {
    if (!weekmask.has(date.dayOfWeek)) continue;
    const iso = date.toString();
    if (holidays.has(iso)) continue;

    const earlyClose = earlyByDate.get(iso);
    const closeMin =
      earlyClose === undefined ? regularCloseMin : parseMinutes(earlyClose);
    if (closeMin <= openMin) {
      throw new RangeError(
        `early close ${earlyClose} on ${iso} is not after open ${rules.open}`,
      );
    }

    const open = instantAt(date, openMin, timeZone);
    const close = instantAt(date, closeMin, timeZone);
    const breaks: SessionBreak[] = breakMins
      .filter((b) => b.end <= closeMin) // drop breaks a half-day closes before
      .map((b) => ({
        start: instantAt(date, b.start, timeZone),
        end: instantAt(date, b.end, timeZone),
      }));

    sessions.push(
      breaks.length > 0
        ? { date: iso, open, close, breaks }
        : { date: iso, open, close },
    );
  }
  return sessions;
}
