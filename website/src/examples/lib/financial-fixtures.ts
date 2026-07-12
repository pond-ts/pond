import { TimeSeries } from 'pond-ts';
import { TradingCalendar } from '@pond-ts/financial';

/**
 * A small NYSE-like calendar (regular hours, Mon-Fri, no holiday list —
 * this is a stub demo, not a real exchange calendar) over six weeks,
 * spanning two real weekends' worth of closed time.
 */
export function demoCalendar(): TradingCalendar {
  return TradingCalendar.fromRules(
    { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
    { from: '2026-01-05', to: '2026-02-13' },
  );
}

const ohlcSchema = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
] as const;

/** A tiny deterministic PRNG (mulberry32) — no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One daily bar per session in {@link demoCalendar} — deterministic (a
 * seeded PRNG, never `Math.random()`), so it renders identically on every
 * visit. Bars are stamped at each session's `open`, so weekends genuinely
 * don't exist in the raw data — a plain time axis and a calendar-aware
 * axis are drawing from exactly the same series, only the axis differs.
 */
export function demoDailyBars(cal: TradingCalendar) {
  const rand = mulberry32(17);
  const rows: Array<[number, number, number, number, number]> = [];
  let close = 148;
  for (const session of cal.sessions()) {
    const open = close;
    const drift = 2.6 * Math.sin(rows.length / 6) + 1.2 * (rand() - 0.5);
    close = Math.max(60, open + drift);
    const wick = 0.6 + 1.1 * Math.abs(rand());
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    rows.push([session.open, open, high, low, close]);
  }
  return new TimeSeries({ name: 'daily', schema: ohlcSchema, rows });
}

/** A view range padded half a session each side, so the first/last candle's
 *  slot is fully in view (point-keyed slots reach halfway to a notional
 *  neighbour) — the same padding `Candlestick.stories.tsx`'s `dayRange`
 *  helper uses. */
export function demoRange(cal: TradingCalendar): [number, number] {
  const sessions = cal.sessions();
  const first = sessions[0]!;
  const last = sessions[sessions.length - 1]!;
  const halfDay = (first.close - first.open) / 2;
  return [first.open - halfDay, last.open + halfDay];
}
