import { describe, it, expect } from 'vitest';
import { TradingCalendar, type Session } from '../src/index.js';

// A tiny hand-built calendar (UTC), three consecutive weekdays with a lunch
// break on the middle one. Times chosen for easy arithmetic.
const H = 3_600_000;
const D0 = Date.UTC(2021, 0, 4); // Mon
const D1 = Date.UTC(2021, 0, 5); // Tue
const D2 = Date.UTC(2021, 0, 6); // Wed
const sessions: Session[] = [
  { date: '2021-01-04', open: D0 + 9 * H, close: D0 + 16 * H },
  {
    date: '2021-01-05',
    open: D1 + 9 * H,
    close: D1 + 16 * H,
    breaks: [{ start: D1 + 12 * H, end: D1 + 13 * H }],
  },
  { date: '2021-01-06', open: D2 + 9 * H, close: D2 + 16 * H },
];

describe('TradingCalendar — construction', () => {
  it('fromSessions and fromRules agree on the schedule', () => {
    const byList = TradingCalendar.fromSessions(sessions);
    const byRules = TradingCalendar.fromRules(
      { timeZone: 'UTC', open: '09:00', close: '16:00' },
      { from: '2021-01-04', to: '2021-01-06' },
    );
    expect(byRules.sessions().map((s) => [s.date, s.open, s.close])).toEqual(
      byList.sessions().map((s) => [s.date, s.open, s.close]),
    );
    expect(byList.length).toBe(3);
  });
});

describe('TradingCalendar — by-date queries', () => {
  const cal = TradingCalendar.fromSessions(sessions);
  it('sessionOn / isTradingDay', () => {
    expect(cal.sessionOn('2021-01-05')?.open).toBe(D1 + 9 * H);
    expect(cal.sessionOn('2021-01-09')).toBeUndefined(); // Saturday
    expect(cal.isTradingDay('2021-01-04')).toBe(true);
    expect(cal.isTradingDay('2021-01-02')).toBe(false);
  });
});

describe('TradingCalendar — instant containment', () => {
  const cal = TradingCalendar.fromSessions(sessions);

  it('sessionContaining resolves in-session, gap, and out-of-range', () => {
    expect(cal.sessionContaining(D0 + 10 * H)?.date).toBe('2021-01-04');
    expect(cal.sessionContaining(D0 + 16 * H)).toBeUndefined(); // exactly close → excluded
    expect(cal.sessionContaining(D0 + 20 * H)).toBeUndefined(); // overnight gap
    expect(cal.sessionContaining(D0 - H)).toBeUndefined(); // before the schedule
  });

  it('a break instant is still contained by its session', () => {
    expect(cal.sessionContaining(D1 + 12 * H + 30 * 60_000)?.date).toBe(
      '2021-01-05',
    );
  });

  it('isOpen excludes breaks and closed time', () => {
    expect(cal.isOpen(D1 + 10 * H)).toBe(true);
    expect(cal.isOpen(D1 + 12 * H + 30 * 60_000)).toBe(false); // inside lunch
    expect(cal.isOpen(D1 + 13 * H)).toBe(true); // break end is exclusive → open again
    expect(cal.isOpen(D0 + 20 * H)).toBe(false); // overnight
  });
});

describe('TradingCalendar — sessionsInRange', () => {
  const cal = TradingCalendar.fromSessions(sessions);

  it('returns sessions overlapping [start, end)', () => {
    // From mid-Mon to mid-Tue → Mon + Tue.
    const out = cal.sessionsInRange({ start: D0 + 12 * H, end: D1 + 12 * H });
    expect(out.map((s) => s.date)).toEqual(['2021-01-04', '2021-01-05']);
  });

  it('excludes a session whose close equals the range start', () => {
    const out = cal.sessionsInRange({ start: D0 + 16 * H, end: D1 + 10 * H });
    expect(out.map((s) => s.date)).toEqual(['2021-01-05']);
  });

  it('is empty for a closed-time window and for an inverted range', () => {
    expect(
      cal.sessionsInRange({ start: D0 + 17 * H, end: D0 + 20 * H }),
    ).toEqual([]);
    expect(cal.sessionsInRange({ start: D1, end: D0 })).toEqual([]);
  });
});

describe('TradingCalendar — navigation', () => {
  const cal = TradingCalendar.fromSessions(sessions);

  it('nextSession / previousSession by date', () => {
    expect(cal.nextSession('2021-01-04')?.date).toBe('2021-01-05');
    expect(cal.nextSession('2021-01-02')?.date).toBe('2021-01-04'); // weekend → first
    expect(cal.nextSession('2021-01-06')).toBeUndefined(); // past the end
    expect(cal.previousSession('2021-01-06')?.date).toBe('2021-01-05');
    expect(cal.previousSession('2021-01-04')).toBeUndefined();
  });

  it('nextSession / previousSession by instant', () => {
    // Mid-Tuesday: previous is Tuesday itself (its open precedes the instant),
    // next is Wednesday.
    expect(cal.previousSession(D1 + 10 * H)?.date).toBe('2021-01-05');
    expect(cal.nextSession(D1 + 10 * H)?.date).toBe('2021-01-06');
    // Exactly a session open: previous excludes it, next is the following.
    expect(cal.previousSession(D1 + 9 * H)?.date).toBe('2021-01-04');
    expect(cal.nextSession(D1 + 9 * H)?.date).toBe('2021-01-06');
  });
});
