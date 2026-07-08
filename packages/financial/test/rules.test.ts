import { describe, it, expect } from 'vitest';
import { generateSessions, type SessionRules } from '../src/index.js';

// An NYSE-shaped rule set: 09:30–16:00 America/New_York, Mon–Fri.
const NYSE: SessionRules = {
  timeZone: 'America/New_York',
  open: '09:30',
  close: '16:00',
  holidays: ['2021-01-01', '2021-12-24'],
  earlyCloses: [{ date: '2021-11-26', close: '13:00' }],
};

describe('generateSessions', () => {
  it('emits Mon–Fri sessions and skips the weekend', () => {
    // 2021-01-04 Mon … 2021-01-10 Sun → 5 sessions (Mon–Fri).
    const out = generateSessions(NYSE, {
      from: '2021-01-04',
      to: '2021-01-10',
    });
    expect(out.map((x) => x.date)).toEqual([
      '2021-01-04',
      '2021-01-05',
      '2021-01-06',
      '2021-01-07',
      '2021-01-08',
    ]);
  });

  it('resolves wall-clock hours to UTC and is DST-correct', () => {
    // Winter (EST, UTC-5): 09:30 ET = 14:30 UTC, 16:00 ET = 21:00 UTC.
    const jan = generateSessions(NYSE, {
      from: '2021-01-04',
      to: '2021-01-04',
    })[0]!;
    expect(jan.open).toBe(Date.UTC(2021, 0, 4, 14, 30));
    expect(jan.close).toBe(Date.UTC(2021, 0, 4, 21, 0));
    // Summer (EDT, UTC-4): 09:30 ET = 13:30 UTC — one hour earlier in UTC.
    const jul = generateSessions(NYSE, {
      from: '2021-07-01',
      to: '2021-07-01',
    })[0]!;
    expect(jul.open).toBe(Date.UTC(2021, 6, 1, 13, 30));
    expect(jul.close).toBe(Date.UTC(2021, 6, 1, 20, 0));
  });

  it('resolves a spring-forward gap by shifting forward (compatible disambiguation)', () => {
    // US springs forward 2021-03-14 02:00→03:00. A 02:30 wall time does not
    // exist that day; "compatible" pushes it to 03:30 EDT = 07:30 UTC.
    const out = generateSessions(
      {
        timeZone: 'America/New_York',
        open: '02:30',
        close: '05:00',
        weekmask: [7],
      },
      { from: '2021-03-14', to: '2021-03-14' },
    )[0]!;
    expect(out.open).toBe(Date.UTC(2021, 2, 14, 7, 30));
  });

  it('resolves a fall-back fold to the earlier instant (compatible disambiguation)', () => {
    // US falls back 2021-11-07 02:00→01:00; 01:30 occurs twice. "compatible"
    // picks the earlier occurrence (still EDT, UTC-4) = 05:30 UTC.
    const out = generateSessions(
      {
        timeZone: 'America/New_York',
        open: '01:30',
        close: '05:00',
        weekmask: [7],
      },
      { from: '2021-11-07', to: '2021-11-07' },
    )[0]!;
    expect(out.open).toBe(Date.UTC(2021, 10, 7, 5, 30));
  });

  it('omits holidays entirely', () => {
    // 2021-01-01 is a Friday holiday → absent.
    const out = generateSessions(NYSE, {
      from: '2021-01-01',
      to: '2021-01-01',
    });
    expect(out).toEqual([]);
  });

  it('applies an early close (half day)', () => {
    const out = generateSessions(NYSE, {
      from: '2021-11-26',
      to: '2021-11-26',
    })[0]!;
    // 13:00 EST = 18:00 UTC.
    expect(out.close).toBe(Date.UTC(2021, 10, 26, 18, 0));
  });

  it('supports a 24:00 full-day close (weekday reference calendar)', () => {
    const full = generateSessions(
      { timeZone: 'UTC', open: '00:00', close: '24:00' },
      { from: '2021-01-04', to: '2021-01-04' },
    )[0]!;
    expect(full.open).toBe(Date.UTC(2021, 0, 4));
    expect(full.close).toBe(Date.UTC(2021, 0, 5)); // next-day midnight
  });

  it('supports intraday breaks and drops those a half-day closes before', () => {
    const withLunch: SessionRules = {
      timeZone: 'UTC',
      open: '09:00',
      close: '17:00',
      breaks: [{ start: '12:00', end: '13:00' }],
      earlyCloses: [{ date: '2021-01-05', close: '11:30' }],
    };
    const normal = generateSessions(withLunch, {
      from: '2021-01-04',
      to: '2021-01-04',
    })[0]!;
    expect(normal.breaks).toEqual([
      { start: Date.UTC(2021, 0, 4, 12), end: Date.UTC(2021, 0, 4, 13) },
    ]);
    // Half-day closes 11:30, before the 12:00 lunch → the break is dropped.
    const half = generateSessions(withLunch, {
      from: '2021-01-05',
      to: '2021-01-05',
    })[0]!;
    expect(half.breaks).toBeUndefined();
    expect(half.close).toBe(Date.UTC(2021, 0, 5, 11, 30));
  });

  it('honors a custom weekmask', () => {
    // Sun–Thu (a Middle-East-style week): 1..4 + 7.
    const out = generateSessions(
      {
        timeZone: 'UTC',
        open: '10:00',
        close: '14:00',
        weekmask: [7, 1, 2, 3, 4],
      },
      { from: '2021-01-03', to: '2021-01-09' }, // Sun..Sat
    );
    expect(out.map((x) => x.date)).toEqual([
      '2021-01-03', // Sun
      '2021-01-04', // Mon
      '2021-01-05', // Tue
      '2021-01-06', // Wed
      '2021-01-07', // Thu
    ]);
  });

  it('validates rule-level breaks directly (not only via the calendar path)', () => {
    const base = { timeZone: 'UTC', open: '09:00', close: '17:00' } as const;
    const range = { from: '2021-01-04', to: '2021-01-04' };
    // Break outside [open, close].
    expect(() =>
      generateSessions(
        { ...base, breaks: [{ start: '08:00', end: '09:30' }] },
        range,
      ),
    ).toThrow(/within/);
    // Overlapping / out-of-order breaks (sorted internally, then overlap caught).
    expect(() =>
      generateSessions(
        {
          ...base,
          breaks: [
            { start: '12:00', end: '13:00' },
            { start: '12:30', end: '14:00' },
          ],
        },
        range,
      ),
    ).toThrow(/non-overlapping|within/);
  });

  it('rejects overnight (close <= open) rules', () => {
    expect(() =>
      generateSessions(
        { timeZone: 'UTC', open: '17:00', close: '16:00' },
        { from: '2021-01-04', to: '2021-01-04' },
      ),
    ).toThrow(/overnight/);
  });

  it('accepts epoch-ms and Date range bounds', () => {
    const out = generateSessions(NYSE, {
      from: Date.UTC(2021, 0, 4, 20), // still 2021-01-04 in NY
      to: new Date(Date.UTC(2021, 0, 6, 2)), // 2021-01-05 21:00 ET
    });
    expect(out.map((x) => x.date)).toEqual(['2021-01-04', '2021-01-05']);
  });
});
