import { BoundedSequence, Interval, TimeSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import type {
  DiscontinuityProvider,
  TradingCalendarLike,
} from './tradingTimeScale.js';

/**
 * Shared fixtures for the trading-time-axis stories (reference + interaction).
 * A session calendar + **inline** discontinuity provider (in real use you'd pass
 * `calendar.discontinuities()` from `@pond-ts/financial`); the axis only needs
 * the structural provider, so charts stays decoupled.
 */

export const H = 3_600_000;
export const DAY = 86_400_000;
export const MIN = 60_000;
export const MON = Date.UTC(2026, 0, 5); // a Monday
export const WIDTH = 720;

export interface Session {
  date: string;
  open: number;
  close: number;
}

/** `count` weekday sessions from the anchor Monday (09:30–16:00 UTC), skipping
 *  weekends and an optional holiday date — a stand-in for a real calendar. */
export function weekdaySessions(count: number, holiday?: string): Session[] {
  const out: Session[] = [];
  for (let dayIdx = 0; out.length < count; dayIdx++) {
    const dayStart = MON + dayIdx * DAY;
    const dow = new Date(dayStart).getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekend
    const date = new Date(dayStart).toISOString().slice(0, 10);
    if (date === holiday) continue;
    out.push({ date, open: dayStart + 9.5 * H, close: dayStart + 16 * H });
  }
  return out;
}

/** An early-close (half-day) variant of the last session. */
export function withHalfDay(sessions: Session[], closeHour = 13): Session[] {
  const last = sessions[sessions.length - 1]!;
  const dayStart = last.open - 9.5 * H;
  return [
    ...sessions.slice(0, -1),
    { ...last, close: dayStart + closeHour * H },
  ];
}

/** A proportional trading-time provider over the sessions' `[open, close)` spans. */
export function provider(sessions: Session[]): DiscontinuityProvider {
  const segs = sessions.map((s) => [s.open, s.close] as const);
  const cum = [0];
  for (const [a, b] of segs) cum.push(cum[cum.length - 1]! + (b - a));
  const total = cum[cum.length - 1]!;
  const liveMs = (t: number): number => {
    if (t <= segs[0]![0]) return 0;
    if (t >= segs[segs.length - 1]![1]) return total;
    for (let i = 0; i < segs.length; i++) {
      const [a, b] = segs[i]!;
      if (t < a) return cum[i]!;
      if (t < b) return cum[i]! + (t - a);
    }
    return total;
  };
  const inst = (L: number): number => {
    if (L <= 0) return segs[0]![0];
    if (L >= total) return segs[segs.length - 1]![1];
    for (let i = 0; i < segs.length; i++) {
      if (L < cum[i + 1]!) return segs[i]![0] + (L - cum[i]!);
    }
    return segs[segs.length - 1]![1];
  };
  const self: DiscontinuityProvider = {
    distance: (a, b) => liveMs(b) - liveMs(a),
    offset: (v, amt) => inst(liveMs(v) + amt),
    clampUp: (t) => t,
    clampDown: (t) => t,
    copy: () => self,
    boundaries: (from, to) => {
      const out: number[] = [];
      for (let i = 1; i < segs.length; i++) {
        const start = segs[i]![0];
        if (start > segs[i - 1]![1] && start > from && start < to)
          out.push(start);
      }
      return out;
    },
  };
  return self;
}

/** A **uniform** trading-time provider — each session is one equal-width slot
 *  regardless of duration (a half-day is as wide as a full day). */
export function uniformProvider(sessions: Session[]): DiscontinuityProvider {
  const segs = sessions.map((s) => [s.open, s.close] as const);
  const n = segs.length;
  const uCoord = (t: number): number => {
    if (t <= segs[0]![0]) return 0;
    if (t >= segs[n - 1]![1]) return n;
    for (let i = 0; i < n; i++) {
      const [a, b] = segs[i]!;
      if (t < a) return i; // in a gap before session i → the boundary
      if (t < b) return i + (t - a) / (b - a); // linear within the session
    }
    return n;
  };
  const inst = (u: number): number => {
    if (u <= 0) return segs[0]![0];
    if (u >= n) return segs[n - 1]![1];
    const i = Math.floor(u);
    const [a, b] = segs[i]!;
    return a + (u - i) * (b - a);
  };
  const self: DiscontinuityProvider = {
    distance: (x, y) => uCoord(y) - uCoord(x),
    offset: (v, amt) => inst(uCoord(v) + amt),
    clampUp: (t) => t,
    clampDown: (t) => t,
    copy: () => self,
    boundaries: (from, to) => {
      const out: number[] = [];
      for (let i = 1; i < n; i++) {
        const start = segs[i]![0];
        if (start > segs[i - 1]![1] && start > from && start < to)
          out.push(start);
      }
      return out;
    },
  };
  return self;
}

/** A structural {@link TradingCalendarLike} — the shape `@pond-ts/financial`'s
 *  `TradingCalendar` satisfies — that the container's `spacing` prop drives. */
export function calendarOf(sessions: Session[]): TradingCalendarLike {
  return {
    discontinuities: (options) =>
      options?.spacing === 'uniform'
        ? uniformProvider(sessions)
        : provider(sessions),
  };
}

/** One interval per session — the daily-bar grid. */
export function sessionSeq(sessions: Session[]): BoundedSequence {
  return new BoundedSequence(
    sessions.map(
      (s) => new Interval({ value: s.date, start: s.open, end: s.close }),
    ),
  );
}

/** Intraday `period`-ms bars within each session (never crossing a boundary). */
export function barSeq(sessions: Session[], periodMs: number): BoundedSequence {
  const ivals: Interval[] = [];
  for (const s of sessions) {
    for (let t = s.open; t < s.close; t += periodMs) {
      ivals.push(
        new Interval({
          value: t,
          start: t,
          end: Math.min(t + periodMs, s.close),
        }),
      );
    }
  }
  return new BoundedSequence(ivals);
}

export const tickSchema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
] as const;

/** Deterministic in-session price ticks (a smooth random-ish walk on sines). */
export function ticks(
  sessions: Session[],
  stepMs: number,
): TimeSeries<typeof tickSchema> {
  const rows: Array<[number, number]> = [];
  let i = 0;
  for (const s of sessions) {
    for (let t = s.open; t < s.close; t += stepMs, i++) {
      const price =
        100 +
        9 * Math.sin(i / 22) +
        3 * Math.sin(i / 4.5) +
        1.4 * Math.sin(i / 1.3);
      rows.push([t, price]);
    }
  }
  return new TimeSeries({ name: 'ticks', schema: tickSchema, rows });
}

export const OHLC = {
  open: { from: 'price', using: 'first' },
  high: { from: 'price', using: 'max' },
  low: { from: 'price', using: 'min' },
  close: { from: 'price', using: 'last' },
} as const;

/** Interval-keyed OHLC candles over a bucket sequence (immune to point-key slot
 *  widths). Return type widened to the general `SeriesSchema`: the inferred
 *  aggregate schema references an internal pond-ts module and can't be named
 *  (TS2742), so an explicit annotation is required. `<Candlestick>` reads the
 *  o/h/l/c columns by runtime name, so the widening is invisible to callers. */
export function candles(
  sessions: Session[],
  seq: BoundedSequence,
  stepMs: number,
): TimeSeries<SeriesSchema> {
  return ticks(sessions, stepMs).aggregate(
    seq,
    OHLC,
  ) as TimeSeries<SeriesSchema>;
}

export function rangeOf(sessions: Session[]): [number, number] {
  return [sessions[0]!.open, sessions[sessions.length - 1]!.close];
}
