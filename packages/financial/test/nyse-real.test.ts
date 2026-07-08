import { describe, it, expect } from 'vitest';
import { TradingCalendar } from '../src/index.js';

/**
 * A reality check against the **real NYSE calendar** for 2025-06-30 … 2026-06-29.
 *
 * The trading-day count (251) and the holiday list below are public exchange
 * facts, cross-validated against real EODHD daily bars (AAPL/MSFT/NVDA/QQQ/SPY,
 * all five sharing this identical calendar). No vendor data is committed — only
 * the calendar facts — but this pins that `fromRules` (weekmask + holidays +
 * DST) reproduces an actual exchange year, not just synthetic fixtures.
 */

const RANGE = { from: '2025-06-30', to: '2026-06-29' } as const;

// Real NYSE holidays in the window (the weekdays with no session).
const NYSE_HOLIDAYS_2025_26 = [
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
];

const nyse = TradingCalendar.fromRules(
  {
    timeZone: 'America/New_York',
    open: '09:30',
    close: '16:00',
    holidays: NYSE_HOLIDAYS_2025_26,
  },
  RANGE,
);

describe('real NYSE 2025-26 calendar (fromRules vs reality)', () => {
  it('produces exactly 251 trading sessions — the real count', () => {
    // The whole weekmask + holiday machinery reproduces the actual exchange
    // year; off-by-one in weekday or holiday logic would break this.
    expect(nyse.length).toBe(251);
  });

  it('excludes every real holiday and both weekend days', () => {
    for (const h of NYSE_HOLIDAYS_2025_26) {
      expect(nyse.isTradingDay(h)).toBe(false);
    }
    expect(nyse.isTradingDay('2025-07-05')).toBe(false); // Saturday
    expect(nyse.isTradingDay('2025-07-06')).toBe(false); // Sunday
  });

  it('keeps the trading days around a holiday and navigates across it', () => {
    expect(nyse.isTradingDay('2025-12-24')).toBe(true);
    expect(nyse.isTradingDay('2025-12-26')).toBe(true);
    expect(nyse.nextSession('2025-12-25')?.date).toBe('2025-12-26');
    expect(nyse.previousSession('2025-12-25')?.date).toBe('2025-12-24');
  });

  it('is DST-correct across the real year: summer 13:30 UTC, winter 14:30 UTC opens', () => {
    // 09:30 ET → 13:30 UTC in July (EDT), 14:30 UTC in December (EST).
    expect(nyse.sessionOn('2025-07-01')?.open).toBe(
      Date.UTC(2025, 6, 1, 13, 30),
    );
    expect(nyse.sessionOn('2025-12-01')?.open).toBe(
      Date.UTC(2025, 11, 1, 14, 30),
    );
  });

  it('sessionsInRange over Christmas week returns only the real trading days', () => {
    const week = nyse.sessionsInRange({
      start: Date.UTC(2025, 11, 22),
      end: Date.UTC(2025, 11, 27),
    });
    // Mon 22, Tue 23, Wed 24 (half-day in reality, but a full session here),
    // Thu 25 Christmas excluded, Fri 26.
    expect(week.map((s) => s.date)).toEqual([
      '2025-12-22',
      '2025-12-23',
      '2025-12-24',
      '2025-12-26',
    ]);
  });
});
