import { describe, expect, it } from 'vitest';
import {
  Interval,
  Sequence,
  TimeRange,
  TimeSeries,
  TimeZone,
} from '../src/index.js';

/**
 * [PND-TZTEST] — the operators over a **non-UTC** calendar sequence. Every
 * earlier aggregate / align / materialize test passed `timeZone: 'UTC'`, so a
 * zone that shifts a bucket edge off the UTC grid (a +05:30 zone, a
 * southern-hemisphere DST change, a Monday that is Sunday in UTC) was never
 * exercised through the operators themselves — only through `bounded()`.
 * Expectations derive from `TimeZone`, never from a pinned literal.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Hourly points from `start`, value 1, so any sum reads "hours in bucket". */
const hourly = (start: number, hours: number) =>
  TimeSeries.fromColumns({
    name: 'h',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    columns: {
      time: Array.from({ length: hours }, (_, i) => start + i * HOUR),
      v: Array.from({ length: hours }, () => 1),
    },
  });

const keys = (s: TimeSeries<never>) =>
  s.events.map((e) => {
    const k = e.key() as Interval | { begin(): number; end(): number };
    return [k.begin(), k.end()] as const;
  });

describe('aggregate over a zoned calendar sequence', () => {
  it('Kolkata (+05:30): daily buckets start at 18:30Z and hold 24 hours each', () => {
    const kol = TimeZone.of('Asia/Kolkata');
    const start = kol.instant({ year: 2025, month: 6, day: 2 });
    const s = hourly(start, 5 * 24);
    const out = s.aggregate(Sequence.calendar('day', { timeZone: kol.id }), {
      v: 'sum',
    });
    expect(out.length).toBe(5);
    for (const [b, e] of keys(out)) {
      expect(b % DAY).toBe((18.5 * HOUR) % DAY);
      expect(b).toBe(kol.startOf('day', b));
      expect(e).toBe(kol.next('day', b));
    }
    for (const ev of out.events) expect(ev.get('v')).toBe(24);
  });

  it('New York fall-back: the 25 h day holds 25 hourly points, the week 169', () => {
    const ny = TimeZone.of('America/New_York');
    const monday = ny.instant({ year: 2025, month: 10, day: 27 }); // week of Nov 2
    const s = hourly(monday, 7 * 24 + 1);
    const days = s.aggregate(Sequence.calendar('day', { timeZone: ny.id }), {
      v: 'sum',
    });
    const sums = days.events.map((e) => e.get('v'));
    expect(sums).toEqual([24, 24, 24, 24, 24, 24, 25]);
    const weeks = s.aggregate(Sequence.calendar('week', { timeZone: ny.id }), {
      v: 'sum',
    });
    expect(weeks.length).toBe(1);
    expect(weeks.events[0]!.get('v')).toBe(7 * 24 + 1);
    const [[wb, we]] = keys(weeks);
    expect(wb).toBe(monday);
    expect(we - wb).toBe(7 * DAY + HOUR);
  });

  it('Sydney October: DST starts, the month of October is 30 days and 23 hours', () => {
    const syd = TimeZone.of('Australia/Sydney');
    const sep = syd.instant({ year: 2025, month: 9, day: 1 });
    const s = hourly(sep, 3 * 31 * 24);
    const months = s.aggregate(
      Sequence.calendar('month', { timeZone: syd.id }),
      { v: 'sum' },
    );
    const byMonth = new Map(
      months.events.map((e) => [
        syd.parts((e.key() as Interval).begin()).month,
        e.get('v'),
      ]),
    );
    expect(byMonth.get(9)).toBe(30 * 24);
    expect(byMonth.get(10)).toBe(31 * 24 - 1);
    expect(byMonth.get(11)).toBe(30 * 24);
    for (const [b] of keys(months)) expect(b).toBe(syd.startOf('month', b));
  });

  it('weekStartsOn in a zone whose Monday midnight is Sunday in UTC', () => {
    // Sunday 20:00Z is already Monday 07:00 in Sydney (AEDT): the event lands
    // in the week starting Monday-local, not the UTC week that ends on it.
    const syd = TimeZone.of('Australia/Sydney');
    const sundayEveningZ = Date.UTC(2025, 0, 12, 20);
    const s = hourly(sundayEveningZ, 3);
    const weeks = s.aggregate(
      Sequence.calendar('week', { timeZone: syd.id, weekStartsOn: 1 }),
      { v: 'sum' },
    );
    expect(weeks.length).toBe(1);
    const [[b]] = keys(weeks);
    expect(b).toBe(syd.instant({ year: 2025, month: 1, day: 13 }));
    expect(syd.parts(b).weekday).toBe(1);
    // A Sunday-start week puts the same event in the week that began the
    // day before, Sunday-local.
    const sundayWeeks = s.aggregate(
      Sequence.calendar('week', { timeZone: syd.id, weekStartsOn: 7 }),
      { v: 'sum' },
    );
    const [[sb]] = keys(sundayWeeks);
    expect(sb).toBe(syd.instant({ year: 2025, month: 1, day: 12 }));
    expect(syd.parts(sb).weekday).toBe(7);
  });

  it('quarter and year buckets in a zone: a whole year of hours sums to the year length', () => {
    const berlin = TimeZone.of('Europe/Berlin');
    const jan1 = berlin.instant({ year: 2025, month: 1, day: 1 });
    const nextJan1 = berlin.instant({ year: 2026, month: 1, day: 1 });
    const hours = (nextJan1 - jan1) / HOUR;
    const s = hourly(jan1, hours);
    const years = s.aggregate(
      Sequence.calendar('year', { timeZone: berlin.id }),
      {
        v: 'sum',
      },
    );
    expect(years.length).toBe(1);
    expect(years.events[0]!.get('v')).toBe(hours);
    const quarters = s.aggregate(
      Sequence.calendar('quarter', { timeZone: berlin.id }),
      { v: 'sum' },
    );
    expect(quarters.length).toBe(4);
    const qs = quarters.events.map((e) => e.get('v') as number);
    // Q1 loses an hour (March DST start), Q4 gains one (October).
    expect(qs[0]).toBe((31 + 28 + 31) * 24 - 1);
    expect(qs[1]).toBe((30 + 31 + 30) * 24);
    expect(qs[2]).toBe((31 + 31 + 30) * 24);
    expect(qs[3]).toBe((31 + 30 + 31) * 24 + 1);
    expect(qs.reduce((a, b) => a + b, 0)).toBe(hours);
  });
});

describe('align and materialize over a zoned calendar sequence', () => {
  const ny = TimeZone.of('America/New_York');
  // Six local days around the spring-forward, one point every 6 h.
  const start = ny.instant({ year: 2025, month: 3, day: 7 });
  const points = TimeSeries.fromColumns({
    name: 'p',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    columns: {
      time: Array.from({ length: 24 }, (_, i) => start + i * 6 * HOUR),
      v: Array.from({ length: 24 }, (_, i) => i),
    },
  });
  const days = Sequence.calendar('day', { timeZone: ny.id });

  it('align samples at the zone-local midnight of each day', () => {
    const aligned = points.align(days, { method: 'linear' });
    for (const e of aligned.events) {
      const t = (e.key() as { begin(): number }).begin();
      expect(t).toBe(ny.startOf('day', t));
    }
    // The midnight after the 23 h day is 23 h (not 24 h) after the previous
    // one, so linear interpolation there lands between two source points.
    const sunday = ny.instant({ year: 2025, month: 3, day: 9 });
    const monday = ny.next('day', sunday);
    expect(monday - sunday).toBe(23 * HOUR);
    const atMonday = aligned.events.find(
      (e) => (e.key() as { begin(): number }).begin() === monday,
    );
    expect(atMonday).toBeDefined();
    // Points are at start + 6h·i; monday = start + 2 days(48h) + 23h = 71 h in
    // → between i = 11 (66 h) and i = 12 (72 h): 11 + 5/6.
    expect(atMonday!.get('v')).toBeCloseTo(11 + 5 / 6, 9);
  });

  it('materialize emits one time-keyed row per zone-local day, selecting inside [midnight, next midnight)', () => {
    const rows = points.materialize(days, { select: 'first' });
    expect(rows.length).toBe(6);
    rows.events.forEach((e, i) => {
      const t = (e.key() as { begin(): number }).begin();
      expect(t).toBe(ny.startOf('day', t));
      // First point at or after each local midnight: day i starts at
      // start + i·24h, except after the short day where it is an hour earlier
      // — the 6 h points keep their UTC cadence, so that day's first point is
      // the one at wall 01:00 EDT.
      const first = e.get('v') as number;
      const pointTime = start + first * 6 * HOUR;
      expect(pointTime).toBeGreaterThanOrEqual(t);
      expect(pointTime).toBeLessThan(ny.next('day', t));
      expect(pointTime - t).toBeLessThan(6 * HOUR);
      void i;
    });
  });
});

describe('TimeRange / Interval calendar factories in a zone', () => {
  it('fromCalendar uses the zone for quarter and year and a half-hour zone', () => {
    const kol = TimeZone.of('Asia/Kolkata');
    const q = TimeRange.fromCalendar('quarter', '2025-05-15', {
      timeZone: kol.id,
    });
    expect(q.begin()).toBe(kol.instant({ year: 2025, month: 4, day: 1 }));
    expect(q.end()).toBe(kol.instant({ year: 2025, month: 7, day: 1 }));
    const y = Interval.fromCalendar('year', '2025-05-15', { timeZone: kol.id });
    expect(y.begin()).toBe(kol.instant({ year: 2025, month: 1, day: 1 }));
    expect(y.end()).toBe(kol.instant({ year: 2026, month: 1, day: 1 }));
    expect(() =>
      TimeRange.fromCalendar('hour' as never, '2025-05-15', {
        timeZone: kol.id,
      }),
    ).toThrow(RangeError);
  });
});
