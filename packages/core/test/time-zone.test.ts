import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { Sequence, TimeRange, TimeZone } from '../src/index.js';
import type { CalendarUnit } from '../src/index.js';

/**
 * The zone primitive is arithmetic on cached offset segments; Temporal is the
 * oracle it must agree with, instant for instant. Zones chosen for the ways
 * hand-rolled zone code breaks: northern and southern DST (opposite months),
 * a half-hour offset with no DST, a 30-minute DST shift, a zone that once
 * had no midnight, and UTC.
 */
const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Sydney',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Apia',
  'America/Sao_Paulo',
] as const;

const UNITS: readonly CalendarUnit[] = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function zdt(ms: number, zone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
}

/** Temporal's answer to `startOf(unit)` for the day containing `ms`. */
function oracleStartOf(
  unit: CalendarUnit,
  ms: number,
  zone: string,
  weekStartsOn = 1,
): number {
  const date = zdt(ms, zone).toPlainDate();
  let start: Temporal.PlainDate;
  switch (unit) {
    case 'day':
      start = date;
      break;
    case 'week':
      start = date.subtract({ days: (date.dayOfWeek - weekStartsOn + 7) % 7 });
      break;
    case 'month':
      start = date.with({ day: 1 });
      break;
    case 'quarter':
      start = date.with({ month: date.month - ((date.month - 1) % 3), day: 1 });
      break;
    case 'year':
      start = date.with({ month: 1, day: 1 });
      break;
  }
  return start.toZonedDateTime({ timeZone: zone }).startOfDay()
    .epochMilliseconds;
}

function oracleNext(
  unit: CalendarUnit,
  ms: number,
  zone: string,
  weekStartsOn = 1,
): number {
  const start = zdt(
    oracleStartOf(unit, ms, zone, weekStartsOn),
    zone,
  ).toPlainDate();
  const step =
    unit === 'day'
      ? { days: 1 }
      : unit === 'week'
        ? { weeks: 1 }
        : unit === 'month'
          ? { months: 1 }
          : unit === 'quarter'
            ? { months: 3 }
            : { years: 1 };
  return start.add(step).toZonedDateTime({ timeZone: zone }).startOfDay()
    .epochMilliseconds;
}

/** A deterministic spread of instants: every 7h 13m across 2024–2026 plus the DST edges. */
function sampleInstants(): number[] {
  const out: number[] = [];
  const from = Date.UTC(2024, 0, 1);
  const to = Date.UTC(2027, 0, 1);
  for (let t = from; t < to; t += 7 * HOUR + 13 * 60_000) out.push(t);
  return out;
}

describe('TimeZone — agrees with Temporal', () => {
  const instants = sampleInstants();

  for (const zone of ZONES) {
    it(`${zone}: offsetAt and parts match Temporal on ${instants.length} instants`, () => {
      const tz = TimeZone.of(zone);
      for (const t of instants) {
        const z = zdt(t, zone);
        expect(tz.offsetAt(t)).toBe(z.offsetNanoseconds / 1_000_000);
        const p = tz.parts(t);
        expect([
          p.year,
          p.month,
          p.day,
          p.hour,
          p.minute,
          p.second,
          p.millisecond,
          p.weekday,
        ]).toEqual([
          z.year,
          z.month,
          z.day,
          z.hour,
          z.minute,
          z.second,
          z.millisecond,
          z.dayOfWeek,
        ]);
      }
    });

    it(`${zone}: startOf / next match Temporal for every unit`, () => {
      const tz = TimeZone.of(zone);
      // Every 3rd instant keeps the oracle loop affordable across 5 units.
      for (let i = 0; i < instants.length; i += 3) {
        const t = instants[i]!;
        for (const unit of UNITS) {
          expect(tz.startOf(unit, t), `${unit} startOf ${t}`).toBe(
            oracleStartOf(unit, t, zone),
          );
          expect(tz.next(unit, t), `${unit} next ${t}`).toBe(
            oracleNext(unit, t, zone),
          );
        }
      }
    });

    it(`${zone}: instant() round-trips parts() and matches Temporal's 'compatible'`, () => {
      const tz = TimeZone.of(zone);
      for (const t of instants) {
        const p = tz.parts(t);
        const back = tz.instant(p);
        const oracle = Temporal.ZonedDateTime.from({
          timeZone: zone,
          year: p.year,
          month: p.month,
          day: p.day,
          hour: p.hour,
          minute: p.minute,
          second: p.second,
          millisecond: p.millisecond,
        }).epochMilliseconds;
        expect(back).toBe(oracle);
      }
    });
  }
});

describe('TimeZone — DST edges', () => {
  it('New York spring-forward: the day is 23 h, 02:30 does not exist', () => {
    const ny = TimeZone.of('America/New_York');
    const t = Date.UTC(2025, 2, 9, 12); // 2025-03-09, transition at 07:00Z
    const start = ny.startOf('day', t);
    const end = ny.next('day', t);
    expect(start).toBe(Date.UTC(2025, 2, 9, 5));
    expect(end - start).toBe(23 * HOUR);
    const skipped = { year: 2025, month: 3, day: 9, hour: 2, minute: 30 };
    // 'compatible' moves forward past the gap: 03:30 EDT.
    expect(ny.parts(ny.instant(skipped)).hour).toBe(3);
    expect(ny.instant(skipped)).toBe(Date.UTC(2025, 2, 9, 7, 30));
    expect(ny.instant(skipped, { disambiguation: 'earlier' })).toBe(
      Date.UTC(2025, 2, 9, 6, 30),
    );
    expect(ny.instant(skipped, { disambiguation: 'later' })).toBe(
      Date.UTC(2025, 2, 9, 7, 30),
    );
    expect(() => ny.instant(skipped, { disambiguation: 'reject' })).toThrow(
      RangeError,
    );
  });

  it('New York fall-back: the day is 25 h, 01:30 happens twice', () => {
    const ny = TimeZone.of('America/New_York');
    const t = Date.UTC(2025, 10, 2, 12); // 2025-11-02, transition at 06:00Z
    const start = ny.startOf('day', t);
    expect(ny.next('day', t) - start).toBe(25 * HOUR);
    const repeated = { year: 2025, month: 11, day: 2, hour: 1, minute: 30 };
    const first = Date.UTC(2025, 10, 2, 5, 30); // EDT
    const second = Date.UTC(2025, 10, 2, 6, 30); // EST
    expect(ny.instant(repeated)).toBe(first); // compatible = earlier
    expect(ny.instant(repeated, { disambiguation: 'earlier' })).toBe(first);
    expect(ny.instant(repeated, { disambiguation: 'later' })).toBe(second);
    expect(() => ny.instant(repeated, { disambiguation: 'reject' })).toThrow(
      RangeError,
    );
    expect(ny.abbreviation(first, { locale: 'en-US' })).toBe('EDT');
    expect(ny.abbreviation(second, { locale: 'en-US' })).toBe('EST');
    // The runtime locale may not know US abbreviations; the fallback is an offset string.
    expect(ny.abbreviation(first)).toMatch(/^(EDT|GMT-4)$/);
  });

  it('Sydney: DST ends in April and starts in October', () => {
    const syd = TimeZone.of('Australia/Sydney');
    const april = Date.UTC(2025, 3, 6, 4); // 2025-04-06 local
    const october = Date.UTC(2025, 9, 5, 4); // 2025-10-05 local
    expect(syd.next('day', april) - syd.startOf('day', april)).toBe(25 * HOUR);
    expect(syd.next('day', october) - syd.startOf('day', october)).toBe(
      23 * HOUR,
    );
    expect(syd.abbreviation(Date.UTC(2025, 0, 15), { locale: 'en-AU' })).toBe(
      'AEDT',
    );
    expect(syd.abbreviation(Date.UTC(2025, 6, 15), { locale: 'en-AU' })).toBe(
      'AEST',
    );
    // en-US has no name for Sydney: the offset string is the documented fallback.
    expect(syd.abbreviation(Date.UTC(2025, 0, 15), { locale: 'en-US' })).toBe(
      'GMT+11',
    );
  });

  it('Lord Howe: a 30-minute DST shift gives a 23.5 h day', () => {
    const lh = TimeZone.of('Australia/Lord_Howe');
    const t = Date.UTC(2025, 9, 5, 4);
    expect(lh.next('day', t) - lh.startOf('day', t)).toBe(23.5 * HOUR);
  });

  it('Kolkata: a fixed +05:30 offset, midnight is 18:30Z the day before', () => {
    const kol = TimeZone.of('Asia/Kolkata');
    expect(kol.offsetAt(Date.UTC(2025, 5, 1))).toBe(5.5 * HOUR);
    expect(kol.startOf('day', Date.UTC(2025, 5, 1))).toBe(
      Date.UTC(2025, 4, 31, 18, 30),
    );
    expect(kol.abbreviation(Date.UTC(2025, 5, 1), { locale: 'en-US' })).toBe(
      'GMT+5:30',
    );
    expect(kol.abbreviation(Date.UTC(2025, 5, 1), { locale: 'en-IN' })).toBe(
      'IST',
    );
  });

  it('São Paulo 2018: the day with no midnight starts at 01:00', () => {
    // DST began at 00:00 on 2018-11-04; startOf('day') must be the first
    // instant that exists, as Temporal's startOfDay() reports.
    const sp = TimeZone.of('America/Sao_Paulo');
    const t = Date.UTC(2018, 10, 4, 12);
    const start = sp.startOf('day', t);
    expect(start).toBe(
      zdt(t, 'America/Sao_Paulo').startOfDay().epochMilliseconds,
    );
    expect(sp.parts(start).hour).toBe(1);
  });

  it('Apia 2011: the day that was skipped entirely', () => {
    // Samoa crossed the date line: 2011-12-30 never happened. Bucket edges
    // around it must still match Temporal exactly.
    const apia = TimeZone.of('Pacific/Apia');
    const t = Date.UTC(2011, 11, 29, 20);
    for (const unit of UNITS) {
      expect(apia.startOf(unit, t)).toBe(
        oracleStartOf(unit, t, 'Pacific/Apia'),
      );
      expect(apia.next(unit, t)).toBe(oracleNext(unit, t, 'Pacific/Apia'));
    }
  });
});

describe('TimeZone — calendar units', () => {
  const berlin = TimeZone.of('Europe/Berlin');
  const t = Date.UTC(2025, 7, 20, 10); // 2025-08-20 12:00 CEST

  it('quarter and year floor to local midnight of the period start', () => {
    expect(berlin.startOf('quarter', t)).toBe(Date.UTC(2025, 5, 30, 22)); // Jul 1 00:00 CEST
    expect(berlin.next('quarter', t)).toBe(Date.UTC(2025, 8, 30, 22)); // Oct 1 00:00 CEST
    expect(berlin.startOf('year', t)).toBe(Date.UTC(2024, 11, 31, 23)); // Jan 1 00:00 CET
    expect(berlin.next('year', t)).toBe(Date.UTC(2025, 11, 31, 23));
  });

  it('week honours weekStartsOn', () => {
    // 2025-08-20 is a Wednesday.
    const monday = Date.UTC(2025, 7, 17, 22);
    const sunday = Date.UTC(2025, 7, 16, 22);
    expect(berlin.startOf('week', t)).toBe(monday);
    expect(berlin.startOf('week', t, { weekStartsOn: 7 })).toBe(sunday);
    expect(berlin.next('week', t, { weekStartsOn: 7 }) - sunday).toBe(7 * DAY);
  });

  it('rejects an unknown unit with RangeError', () => {
    expect(() => berlin.startOf('hour' as CalendarUnit, t)).toThrow(RangeError);
    expect(() => Sequence.calendar('hour' as CalendarUnit)).toThrow(
      /unknown calendar unit "hour"/,
    );
  });
});

describe('TimeZone — identity and lookup', () => {
  it('interns instances and canonicalises the id', () => {
    expect(TimeZone.of('America/New_York')).toBe(
      TimeZone.of('America/New_York'),
    );
    expect(TimeZone.of('utc')).toBe(TimeZone.UTC);
    expect(TimeZone.of('utc').id).toBe('UTC');
    expect(String(TimeZone.of('Europe/Berlin'))).toBe('Europe/Berlin');
    expect(JSON.stringify({ tz: TimeZone.UTC })).toBe('{"tz":"UTC"}');
  });

  it('rejects an unknown zone with RangeError', () => {
    expect(() => TimeZone.of('Mars/Olympus_Mons')).toThrow(
      /unknown time zone "Mars\/Olympus_Mons"/,
    );
    expect(() => Sequence.calendar('day', { timeZone: 'Nowhere' })).toThrow(
      RangeError,
    );
  });

  it('local() resolves to the runtime zone', () => {
    expect(TimeZone.local().id).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it('rejects a non-finite instant and an impossible date', () => {
    expect(() => TimeZone.UTC.parts(Number.NaN)).toThrow(RangeError);
    expect(() =>
      TimeZone.UTC.instant({ year: 2025, month: 13, day: 1 }),
    ).toThrow(RangeError);
  });
});

describe('Sequence.calendar on the primitive', () => {
  it('quarter and year buckets in a zone', () => {
    const seq = Sequence.calendar('quarter', { timeZone: 'America/New_York' });
    const b = seq.bounded(
      new TimeRange({
        start: Date.UTC(2025, 0, 15),
        end: Date.UTC(2025, 11, 1),
      }),
      { coverage: 'overlap' },
    );
    expect(b.length).toBe(4);
    expect(b.at(0)?.begin()).toBe(Date.UTC(2025, 0, 1, 5)); // Jan 1 00:00 EST
    expect(b.at(2)?.begin()).toBe(Date.UTC(2025, 6, 1, 4)); // Jul 1 00:00 EDT
    const years = Sequence.calendar('year').bounded(
      new TimeRange({ start: Date.UTC(2024, 5, 1), end: Date.UTC(2026, 0, 1) }),
    );
    expect(years.length).toBe(2);
    expect(years.at(0)?.begin()).toBe(Date.UTC(2025, 0, 1));
  });

  it('a non-UTC weekly aggregate lands events in zone-local weeks', () => {
    // Monday 00:00 Sydney is Sunday 13:00Z (AEDT) — an event at Sunday 20:00Z
    // is already Monday in Sydney and must be in the *next* UTC-week's bucket.
    const seq = Sequence.calendar('week', { timeZone: 'Australia/Sydney' });
    const sundayEvening = Date.UTC(2025, 0, 12, 20); // Sun 12 Jan 20:00Z = Mon 13 Jan 07:00 AEDT
    const b = seq.bounded(
      new TimeRange({ start: sundayEvening, end: sundayEvening }),
      {
        coverage: 'overlap',
      },
    );
    expect(b.length).toBe(1);
    expect(b.at(0)?.begin()).toBe(Date.UTC(2025, 0, 12, 13)); // Mon 13 Jan 00:00 AEDT
  });
});
