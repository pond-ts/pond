import type { Meta, StoryObj } from '@storybook/react-vite';
import { BoundedSequence, Interval, TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { Candlestick } from './Candlestick.js';
import { YAxis } from './YAxis.js';
import type { DiscontinuityProvider } from './tradingTimeScale.js';

/**
 * Trading-time x axis — the discontinuous axis that collapses closed-market
 * time. These stories build a session calendar + provider **inline** (in real
 * use you'd pass `calendar.discontinuities()` from `@pond-ts/financial`); the
 * axis only needs the structural provider, so charts stays decoupled.
 */

const H = 3_600_000;
const DAY = 86_400_000;
const MIN = 60_000;
const MON = Date.UTC(2026, 0, 5); // a Monday

interface Session {
  date: string;
  open: number;
  close: number;
}

/** `count` weekday sessions from the anchor Monday (09:30–16:00 UTC), skipping
 *  weekends and an optional holiday date — a stand-in for a real calendar. */
function weekdaySessions(count: number, holiday?: string): Session[] {
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
function withHalfDay(sessions: Session[], closeHour = 13): Session[] {
  const last = sessions[sessions.length - 1]!;
  const dayStart = last.open - 9.5 * H;
  return [
    ...sessions.slice(0, -1),
    { ...last, close: dayStart + closeHour * H },
  ];
}

/** A proportional trading-time provider over the sessions' `[open, close)` spans. */
function provider(sessions: Session[]): DiscontinuityProvider {
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

/** One interval per session — the daily-bar grid. */
function sessionSeq(sessions: Session[]): BoundedSequence {
  return new BoundedSequence(
    sessions.map(
      (s) => new Interval({ value: s.date, start: s.open, end: s.close }),
    ),
  );
}

/** Intraday `period`-ms bars within each session (never crossing a boundary). */
function barSeq(sessions: Session[], periodMs: number): BoundedSequence {
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

const tickSchema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
] as const;

/** Deterministic in-session price ticks (a smooth random-ish walk on sines). */
function ticks(
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

const OHLC = {
  open: { from: 'price', using: 'first' },
  high: { from: 'price', using: 'max' },
  low: { from: 'price', using: 'min' },
  close: { from: 'price', using: 'last' },
} as const;

/** Interval-keyed OHLC candles over a bucket sequence (immune to point-key slot widths). */
function candles(sessions: Session[], seq: BoundedSequence, stepMs: number) {
  return ticks(sessions, stepMs).aggregate(seq, OHLC);
}

function rangeOf(sessions: Session[]): [number, number] {
  return [sessions[0]!.open, sessions[sessions.length - 1]!.close];
}

const meta = {
  title: 'Charts/TradingTimeAxis',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

const WIDTH = 720;

/** Daily candles over two weeks — the weekend gaps collapse to nothing. */
export const WeekendSkip: Story = {
  render: () => {
    const s = weekdaySessions(10);
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
      >
        <ChartRow height={260}>
          <YAxis id="p" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A holiday mid-window (2026-01-08 removed) — its gap collapses like a weekend. */
export const HolidayGap: Story = {
  render: () => {
    const s = weekdaySessions(10, '2026-01-08');
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
      >
        <ChartRow height={260}>
          <YAxis id="p" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A half-day (early close) — its session is a proportionally narrower block. */
export const HalfDay: Story = {
  render: () => {
    const s = withHalfDay(weekdaySessions(5));
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
      >
        <ChartRow height={260}>
          <YAxis id="p" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** Intraday 30-minute candles across three sessions — overnight gaps collapse,
 *  time stays proportional within each session. */
export const IntradaySessions: Story = {
  render: () => {
    const s = weekdaySessions(3);
    const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
      >
        <ChartRow height={260}>
          <YAxis id="p" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** The money shot: the *same* daily candles on a continuous time axis (top —
 *  weekends open as empty bands between candles) vs the trading-time axis
 *  (bottom — the bands collapse, candles run contiguously). */
export const ContinuousVsTrading: Story = {
  render: () => {
    const s = weekdaySessions(10);
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    const row = (
      <ChartRow height={150}>
        <YAxis id="p" />
        <Layers>
          <Candlestick series={bars} axis="p" />
        </Layers>
      </ChartRow>
    );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ChartContainer width={WIDTH} range={rangeOf(s)}>
          {row}
        </ChartContainer>
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
        >
          {row}
        </ChartContainer>
      </div>
    );
  },
};

/** ~4 months of daily candles — too many sessions to label each. The axis
 *  coarsens to a **calendar grain**: dividers and date labels land on month
 *  starts, not an arbitrary every-nth session (the trading-terminal habit). */
export const DailyMonths: Story = {
  render: () => {
    const s = weekdaySessions(85); // ~4 trading months
    const bars = candles(s, sessionSeq(s), 60 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
      >
        <ChartRow height={260}>
          <YAxis id="p" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
