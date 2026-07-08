import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Temporal } from '@js-temporal/polyfill';
import { TimeSeries } from 'pond-ts';
import { TradingCalendar } from '../src/index.js';

/**
 * Real-data regression against curated SPY 5-minute fixtures
 * (`fixtures/market-fixtures/`, US/Eastern timestamps): ten sessions with real
 * overnight gaps + a holiday, and the 2024-11-29 post-Thanksgiving half-day,
 * each in regular-hours and all-hours variants. These exercise what the
 * synthetic tests and the daily-bar reality check can't: session-boundary
 * splitting on real intraday ticks, a real early close, and the
 * regular-vs-extended-hours distinction. The data is deliberately imperfect
 * (a duplicated session, close-boundary bars) — the tests pin how the calendar
 * handles that.
 */

interface Bar {
  ts: string;
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** US/Eastern wall-clock timestamp → UTC epoch-ms (DST-correct via Temporal). */
const etToEpoch = (ts: string): number =>
  Temporal.PlainDateTime.from(ts.replace(' ', 'T')).toZonedDateTime(
    'America/New_York',
  ).epochMilliseconds;

function load(name: string): Bar[] {
  const url = new URL(
    `../fixtures/market-fixtures/${name}.csv`,
    import.meta.url,
  );
  const [, ...lines] = readFileSync(url, 'utf8').trim().split('\n');
  return lines.map((l) => {
    const [, ts, , open, high, low, close, volume] = l.split(',');
    return {
      ts: ts!,
      t: etToEpoch(ts!),
      open: +open!,
      high: +high!,
      low: +low!,
      close: +close!,
      volume: +volume!,
    };
  });
}

const OHLCV_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
] as const;

function toSeries(bars: Bar[]): TimeSeries<typeof OHLCV_SCHEMA> {
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  return TimeSeries.fromColumns({
    name: 'SPY',
    schema: OHLCV_SCHEMA,
    columns: {
      time: sorted.map((b) => b.t),
      open: sorted.map((b) => b.open),
      high: sorted.map((b) => b.high),
      low: sorted.map((b) => b.low),
      close: sorted.map((b) => b.close),
      volume: sorted.map((b) => b.volume),
    },
  });
}

const OHLCV_ROLLUP = {
  open: { from: 'open', using: 'first' },
  high: { from: 'high', using: 'max' },
  low: { from: 'low', using: 'min' },
  close: { from: 'close', using: 'last' },
  volume: { from: 'volume', using: 'sum' },
} as const;

describe('market-fixtures: ten sessions, regular hours', () => {
  const bars = load('spy-10-sessions-5m-regular');
  const days = [...new Set(bars.map((b) => b.ts.slice(0, 10)))].sort();
  // NYSE over the fixture window with Good Friday (2025-04-18) as the holiday.
  const nyse = TradingCalendar.fromRules(
    {
      timeZone: 'America/New_York',
      open: '09:30',
      close: '16:00',
      holidays: ['2025-04-18'],
    },
    { from: days[0]!, to: days[days.length - 1]! },
  );

  it('the calendar reproduces the real trading days, Good Friday excluded', () => {
    expect(days.length).toBe(9); // 2025-04-07..04-17 weekdays minus Good Friday
    expect(nyse.length).toBe(9);
    expect(nyse.isTradingDay('2025-04-18')).toBe(false); // Good Friday
    expect(days.every((d) => nyse.isTradingDay(d))).toBe(true);
  });

  it('30-minute bars never span a session boundary (overnight gaps respected)', () => {
    // De-duplicate first (see the dirty-data test) so the roll-up isn't skewed.
    const series = toSeries(bars).dedupe();
    const b30 = series.aggregate(nyse.barSequence('30m'), OHLCV_ROLLUP);
    const filled = b30.toArray().filter((e) => e.get('open') !== undefined);
    expect(filled.length).toBeGreaterThan(0);
    for (const e of filled) {
      const s = nyse.sessionContaining(e.begin());
      expect(s).toBeDefined();
      // The whole 30m bucket lies within that one session.
      expect(e.end()).toBeLessThanOrEqual(s!.close);
    }
  });

  it('the close-boundary bars (16:00, one per session) are closed time', () => {
    // Each session carries a bar stamped exactly at 16:00 — the close. Under
    // half-open [open, close) these are NOT in the session (the open-stamp vs
    // close-stamp convention the RFC flags for a future `stamped` knob).
    const tagged = nyse.tagSessions(toSeries(bars).dedupe());
    const untagged = tagged
      .toArray()
      .filter((e) => e.get('session') === undefined);
    expect(untagged.length).toBe(9); // one 16:00 bar per session
    for (const e of untagged) {
      expect(new Date(e.begin()).getUTCHours()).toBe(20); // 16:00 ET = 20:00 UTC (EDT)
    }
  });
});

describe('market-fixtures: ten sessions, all hours (extended)', () => {
  it('extended-hours bars (past 16:00) fall outside the regular sessions', () => {
    const bars = load('spy-10-sessions-5m-all');
    const days = [...new Set(bars.map((b) => b.ts.slice(0, 10)))].sort();
    const nyse = TradingCalendar.fromRules(
      {
        timeZone: 'America/New_York',
        open: '09:30',
        close: '16:00',
        holidays: ['2025-04-18'],
      },
      { from: days[0]!, to: days[days.length - 1]! },
    );
    // The all-hours feed runs to 20:00 ET; everything at/after each 16:00 close
    // is post-market → contained by no regular session.
    const postMarket = bars.filter((b) => b.ts.slice(11, 16) > '16:00');
    expect(postMarket.length).toBeGreaterThan(0);
    for (const b of postMarket) {
      expect(nyse.sessionContaining(b.t)).toBeUndefined();
    }
  });
});

describe('market-fixtures: half-day regular feed vs a half-day calendar', () => {
  it('post-13:00 bars in the full-length feed are closed time under the early close', () => {
    // The "regular" half-day feed actually runs 09:30–16:00 (full length); a
    // correct half-day calendar (13:00 close) marks everything from 13:00 on
    // as closed — the calendar, not the feed, defines the session.
    const bars = load('spy-2024-11-29-halfday-5m-regular');
    const cal = TradingCalendar.fromRules(
      {
        timeZone: 'America/New_York',
        open: '09:30',
        close: '16:00',
        earlyCloses: [{ date: '2024-11-29', close: '13:00' }],
      },
      { from: '2024-11-29', to: '2024-11-29' },
    );
    const inSession = bars.filter(
      (b) => cal.sessionContaining(b.t)?.date === '2024-11-29',
    );
    const afterEarlyClose = bars.filter((b) => b.ts.slice(11, 16) >= '13:00');
    expect(inSession.length).toBe(42); // 09:30–12:55
    expect(afterEarlyClose.length).toBeGreaterThan(0); // the feed keeps going
    for (const b of afterEarlyClose) {
      expect(cal.sessionContaining(b.t)).toBeUndefined();
    }
  });
});

describe('market-fixtures: dirty feed (duplicated session)', () => {
  it('2025-04-17 is fully duplicated; dedupe() collapses it', () => {
    const apr17 = load('spy-10-sessions-5m-regular').filter((b) =>
      b.ts.startsWith('2025-04-17'),
    );
    const unique = new Set(apr17.map((b) => b.t)).size;
    expect(apr17.length).toBeGreaterThan(unique); // duplicates present
    const deduped = toSeries(apr17).dedupe();
    expect(deduped.toArray().length).toBe(unique);
  });
});

describe('market-fixtures: 2024-11-29 half-day (early close)', () => {
  const bars = load('spy-2024-11-29-halfday-5m-all');
  const cal = TradingCalendar.fromRules(
    {
      timeZone: 'America/New_York',
      open: '09:30',
      close: '16:00',
      earlyCloses: [{ date: '2024-11-29', close: '13:00' }],
    },
    { from: '2024-11-29', to: '2024-11-29' },
  );

  it('the session closes at 13:00 ET (18:00 UTC, EST)', () => {
    const s = cal.sessionOn('2024-11-29')!;
    expect(s.open).toBe(Date.UTC(2024, 10, 29, 14, 30)); // 09:30 EST
    expect(s.close).toBe(Date.UTC(2024, 10, 29, 18, 0)); // 13:00 EST
  });

  it('separates regular-hours bars from pre-market and post-close (extended)', () => {
    const s = cal.sessionOn('2024-11-29')!;
    const inSession = bars.filter(
      (b) => cal.sessionContaining(b.t)?.date === '2024-11-29',
    );
    const preMarket = bars.filter((b) => b.t < s.open);
    const postClose = bars.filter((b) => b.t >= s.close);
    expect(inSession.length).toBe(42); // 09:30–13:00 at 5m
    expect(preMarket.length + inSession.length + postClose.length).toBe(
      bars.length,
    );
    expect(preMarket.length).toBeGreaterThan(0); // 08:45.. pre-market present
    expect(postClose.length).toBeGreaterThan(0); // ..17:00 post-close present
  });

  it('isOpen tracks the early close', () => {
    const s = cal.sessionOn('2024-11-29')!;
    expect(cal.isOpen(s.open + 60_000)).toBe(true); // just after open
    expect(cal.isOpen(s.close - 60_000)).toBe(true); // just before 13:00
    expect(cal.isOpen(s.close)).toBe(false); // 13:00 close (exclusive)
    expect(cal.isOpen(s.close + 3_600_000)).toBe(false); // 14:00 — closed
  });
});
