import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { Candlestick } from './Candlestick.js';
import { LineChart } from './LineChart.js';
import { TimeAxis } from './TimeAxis.js';
import { YAxis } from './YAxis.js';
import type { DiscontinuityProvider } from './tradingTimeScale.js';
import {
  DAY,
  H,
  MIN,
  WIDTH,
  barSeq,
  calendarOf,
  candles,
  gappingTicks,
  provider,
  rangeOf,
  sessionSeq,
  tickSchema,
  weekdaySessions,
  withHalfDay,
} from './tradingAxis.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * Trading-time x axis — the discontinuous axis that collapses closed-market
 * time. Fixtures (session calendar + inline provider) live in
 * `tradingAxis.fixture.ts`; in real use you'd pass `calendar.discontinuities()`
 * from `@pond-ts/financial`. The axis only needs the structural provider, so
 * charts stays decoupled. Interaction coverage (cursors, annotations, pan/zoom)
 * lives under `Charts/TradingTimeAxis/Interactions`.
 */

const meta = {
  title: 'Axes/TradingTimeAxis',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

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
        theme={docsTheme}
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
        theme={docsTheme}
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
        theme={docsTheme}
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
        theme={docsTheme}
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

/** A 5-minute price **line** across three sessions, with `sessionBreaks`: the
 *  line ends at each session's close and re-starts at the next open, instead of
 *  the near-vertical connector bridging the collapsed overnight gap. The break
 *  rides the trading-axis discontinuity — a *scale* gap, distinct from a NaN
 *  *data* gap (`gaps`). Top row omits it (connected close→open) for contrast. */
export const SessionBreaks: Story = {
  render: () => {
    const s = weekdaySessions(3);
    const px = gappingTicks(s, 5 * MIN);
    const row = (broken: boolean) => (
      <ChartRow height={150}>
        <YAxis id="p" />
        <Layers>
          <LineChart
            series={px}
            column="price"
            axis="p"
            sessionBreaks={broken}
          />
        </Layers>
      </ChartRow>
    );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
        >
          {row(false)}
        </ChartContainer>
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
        >
          {row(true)}
        </ChartContainer>
      </div>
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
        <ChartContainer width={WIDTH} range={rangeOf(s)} theme={docsTheme}>
          {row}
        </ChartContainer>
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
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
        theme={docsTheme}
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

/** A full year of daily candles on a wide (900px) plot — the tick count is
 *  **width-derived** on a trading axis, so the year lands on **month grain**
 *  (~12 date labels with dividers under each). At a fixed count of 5 this view
 *  coarsened to 2–5 ticks regardless of width (the 0.44 Tidal report). */
export const YearDaily: Story = {
  render: () => {
    const s = weekdaySessions(252); // one trading year
    const bars = candles(s, sessionSeq(s), 60 * MIN);
    return (
      <ChartContainer
        width={900}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        theme={docsTheme}
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

/** The same year of daily candles on a narrow (420px) plot — fewer labels fit,
 *  so the width-derived count steps the grain up the ladder to **quarters**.
 *  Density follows the room the labels have, not a constant. */
export const YearDailyNarrow: Story = {
  render: () => {
    const s = weekdaySessions(252);
    const bars = candles(s, sessionSeq(s), 60 * MIN);
    return (
      <ChartContainer
        width={420}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        theme={docsTheme}
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

/**
 * `dateStyle` — how the time axis lays out its date context. **`'flat'`
 * (default, top)** promotes the coarsest calendar unit each tick opens
 * **inline** into one row (the month at a month turn, the year at a year turn),
 * every other tick terse — the TradingView look. **`'stacked'` (bottom)** keeps
 * the two-row layout: a `%b %d` major row plus a boundary row underneath
 * carrying the year, with a pinned left-edge context. Here: ~4 months of daily
 * candles, so flat reads `Jul … Sep … Nov 2026 Feb` on one row while stacked
 * reads dates with the year underneath.
 */
export const DateStyleDaily: Story = {
  render: () => {
    const s = weekdaySessions(85);
    const bars = candles(s, sessionSeq(s), 60 * MIN);
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
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
          showAxis={false}
        >
          {row}
          <TimeAxis /> {/* dateStyle="flat" is the default */}
        </ChartContainer>
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
          showAxis={false}
        >
          {row}
          <TimeAxis dateStyle="stacked" />
        </ChartContainer>
      </div>
    );
  },
};

/**
 * `dateStyle` on an **intraday** axis: flat (top) shows clock times with the
 * session's date promoted inline at each midnight/open; stacked (bottom) pins
 * the date to the boundary row. Three 30-minute-candle sessions.
 */
export const DateStyleIntraday: Story = {
  render: () => {
    const s = weekdaySessions(3);
    const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
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
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
          showAxis={false}
        >
          {row}
          <TimeAxis />
        </ChartContainer>
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
          showAxis={false}
        >
          {row}
          <TimeAxis dateStyle="stacked" />
        </ChartContainer>
      </div>
    );
  },
};

/**
 * The whole ladder, interactive. **Pan** (drag) and **zoom** (wheel) all the
 * way from a 3-year span down to seconds, and flip the **`dateStyle`** toggle
 * live. The preset buttons jump between scales; drag / wheel explore from
 * there. Watch the flat row relabel as you go — years → months → days → clock
 * → seconds — each boundary promoted inline (the year at a year turn, the
 * month at a month turn, the date at a midnight), versus the stacked two-row
 * layout on the same view. The **labels** control flips tick-label alignment
 * (`align`): centred on the tick, or left-aligned beside it.
 *
 * The switches below the chart drive the public container props. **Sessions**
 * swaps in a weekend-excising discontinuity provider (full-day Mon–Fri
 * sessions, Sat+Sun collapsed) — the checker for the session-index tick
 * stride on a gappy calendar: marks stay an equal number of *sessions* apart
 * (even pixels), and a month whose 1st lands on a weekend anchors on its
 * first session. **Grid** gates the reference gridlines (`grid`), and
 * **Session markers** draws a divider at every collapse *seam*
 * (`sessionDividers="all"`) — with this calendar's contiguous 24h weekday
 * sessions, that is exactly the excised weekends (one line per Monday open),
 * not every day roll; a real exchange calendar with overnight gaps would
 * seam at every session open. (Markers need the calendar, so turn on
 * Sessions to see them.)
 *
 * The line is a synthetic multi-octave signal on a 30-minute grid, so it
 * smooths out below ~30 minutes; the **axis** keeps laddering down to
 * one-second ticks regardless of the data behind it.
 */
const PANZOOM_START = new Date(2024, 0, 1).getTime(); // a local-midnight Monday
// A deliberately mid-period right edge (not on a year/month/day boundary): every
// preset anchors here, so each scale contains an *interior* boundary — a midnight
// inside the 1D view, a month-start inside the 1M view, year turns inside the
// full view — where the flat style shows its inline promotion. Anchoring on a
// boundary would push that label onto the clipped right edge and hide it.
const PANZOOM_END = new Date(2026, 10, 20, 14, 30).getTime();
const SEC = 1_000;

/** A deterministic ~3-year price walk: 14 octaves of sine (self-similar-ish
 *  detail from the full span down to ~30 min) sampled on a 30-minute grid. */
function fractalRows(): Array<[number, number]> {
  const span = PANZOOM_END - PANZOOM_START;
  const rows: Array<[number, number]> = [];
  for (let t = PANZOOM_START; t <= PANZOOM_END; t += 30 * MIN) {
    let v = 100;
    let amp = 32;
    let freq = (2 * Math.PI) / span;
    for (let o = 0; o < 14; o++) {
      v += amp * Math.sin(freq * (t - PANZOOM_START) + o * 1.7);
      amp *= 0.62;
      freq *= 2.3;
    }
    rows.push([t, v]);
  }
  return rows;
}

const isWeekday = (t: number): boolean => {
  const dow = new Date(t).getDay();
  return dow !== 0 && dow !== 6;
};

const midnightOf = (t: number): number => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * A weekend-excising {@link DiscontinuityProvider} for the checker toggle:
 * Mon–Fri are live full-day sessions, Sat+Sun collapse. **Calendar-day
 * aligned** — live position is `(whole weekdays before this day) + (time into
 * the day)`, both anchored to *local midnight* — so sessions sit exactly on
 * local days with no drift (an earlier fixed-ms-week version drifted an hour
 * off midnight across DST, which put tick marks inside the collapsed weekend
 * and piled their date labels on the seam). O(1) via the closed-form weekday
 * count; DST-robust through `Math.round` on the day index. A demo stand-in —
 * real calendars come from `@pond-ts/financial`.
 */
function weekendSkip(): DiscontinuityProvider {
  // Signed day index from PANZOOM_START (a local-midnight Monday).
  const dayIndex = (t: number): number =>
    Math.round((midnightOf(t) - PANZOOM_START) / DAY);
  // Local midnight of calendar day `di` — through the local calendar (the Date
  // ctor normalizes day overflow), NOT `PANZOOM_START + di * DAY`: that raw form
  // lands 01:00 local on the far side of a DST change, and the +1h it injected
  // per `offset()` round-trip made every pan/zoom step drift the window
  // (`offset` must invert `distance` — the provider contract the viewport
  // math leans on).
  const localMidnight = (di: number): number =>
    new Date(2024, 0, 1 + di).getTime();
  // Mon–Fri days in [0, di) — closed form (di may be negative).
  const weekdaysBefore = (di: number): number => {
    const w = Math.floor(di / 7);
    return w * 5 + Math.min(di - w * 7, 5);
  };
  const liveMs = (t: number): number => {
    const base = weekdaysBefore(dayIndex(t)) * DAY;
    return isWeekday(t) ? base + (t - midnightOf(t)) : base;
  };
  const stepToWeekday = (t: number, dir: 1 | -1): number => {
    let d = new Date(midnightOf(t));
    do {
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dir);
    } while (!isWeekday(d.getTime()));
    return d.getTime();
  };
  const self: DiscontinuityProvider = {
    distance: (from, to) => liveMs(to) - liveMs(from),
    offset: (v, amount) => {
      const live = liveMs(v) + amount;
      const ld = Math.floor(live / DAY); // whole live weekdays
      const weeks = Math.floor(ld / 5);
      const calDi = weeks * 7 + (ld - weeks * 5); // → calendar day index
      return localMidnight(calDi) + (live - ld * DAY);
    },
    // Weekend → forward to next Monday open / back to Friday's close (= Sat 00:00).
    clampUp: (t) => (isWeekday(t) ? t : stepToWeekday(t, 1)),
    clampDown: (t) =>
      isWeekday(t) ? t : midnightOf(stepToWeekday(t, -1)) + DAY,
    copy: () => self,
    boundaries: (from, to) => {
      const out: number[] = [];
      const d = new Date(from);
      let cur = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      while (cur.getTime() < to) {
        if (isWeekday(cur.getTime()) && cur.getTime() > from) {
          out.push(cur.getTime());
        }
        cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      }
      return out;
    },
  };
  return self;
}

/** Scale presets (anchored at the right edge), one per rung of the ladder. */
const PANZOOM_PRESETS: Array<[string, number]> = [
  ['Max', PANZOOM_END - PANZOOM_START],
  ['6M', 182 * DAY],
  ['1M', 30 * DAY],
  ['1W', 7 * DAY],
  ['1D', DAY],
  ['3H', 3 * H],
  ['30m', 30 * MIN],
  ['5m', 5 * MIN],
  ['30s', 30 * SEC],
];

/** A small labelled switch — the story-control look for the public boolean
 *  props ( ●) . */
function Toggle({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        color: docsTheme.axis.label,
        fontSize: 12,
        fontFamily: docsTheme.font.family,
      }}
    >
      <span
        style={{
          width: 28,
          height: 16,
          borderRadius: 8,
          background: on ? '#3b82f6' : '#cbd5e1',
          position: 'relative',
          transition: 'background 120ms',
          flex: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 14 : 2,
            width: 12,
            height: 12,
            borderRadius: 6,
            background: '#fff',
            transition: 'left 120ms',
          }}
        />
      </span>
      {label}
    </button>
  );
}

function DateStylePanZoomDemo() {
  const rows = useMemo(fractalRows, []);
  const series = useMemo(
    () => new TimeSeries({ name: 'px', schema: tickSchema, rows }),
    [rows],
  );
  // The session-axis variant drops Sat/Sun rows too — otherwise two days of
  // points pile up on the collapse seam as a vertical smear.
  const weekdaySeries = useMemo(
    () =>
      new TimeSeries({
        name: 'px',
        schema: tickSchema,
        rows: rows.filter(([t]) => isWeekday(t)),
      }),
    [rows],
  );
  const skipProvider = useMemo(weekendSkip, []);
  const [style, setStyle] = useState<'flat' | 'stacked'>('flat');
  const [labels, setLabels] = useState<'center' | 'left'>('center');
  const [grid, setGrid] = useState(true);
  const [sessions, setSessions] = useState(false);
  const [markers, setMarkers] = useState(false);
  const [range, setRange] = useState<[number, number]>([
    PANZOOM_START,
    PANZOOM_END,
  ]);
  const btn = (active: boolean) => ({
    padding: '3px 10px',
    fontSize: 12,
    borderRadius: 4,
    border: `1px solid ${docsTheme.axis.grid}`,
    background: active ? '#3b82f6' : 'transparent',
    color: active ? '#fff' : docsTheme.axis.label,
    cursor: 'pointer',
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontFamily: docsTheme.font.family,
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {(['flat', 'stacked'] as const).map((s) => (
            <button
              key={s}
              type="button"
              style={btn(style === s)}
              onClick={() => setStyle(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {PANZOOM_PRESETS.map(([label, dur]) => (
            <button
              key={label}
              type="button"
              style={btn(false)}
              onClick={() => setRange([PANZOOM_END - dur, PANZOOM_END])}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: docsTheme.axis.label }}>
            labels
          </span>
          {(['center', 'left'] as const).map((a) => (
            <button
              key={a}
              type="button"
              style={btn(labels === a)}
              onClick={() => setLabels(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <ChartContainer
        width={WIDTH}
        range={range}
        theme={docsTheme}
        panZoom
        onTimeRangeChange={setRange}
        minDuration={5 * SEC}
        showAxis={false}
        discontinuities={sessions ? skipProvider : undefined}
        grid={grid}
        sessionDividers={markers ? 'all' : 'none'}
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <LineChart
              series={sessions ? weekdaySeries : series}
              column="price"
              axis="p"
            />
          </Layers>
        </ChartRow>
        <TimeAxis
          dateStyle={style}
          align={labels === 'left' ? 'right' : 'center'}
        />
      </ChartContainer>
      <div
        style={{
          display: 'flex',
          gap: 20,
          alignItems: 'center',
          fontFamily: docsTheme.font.family,
        }}
      >
        <Toggle on={grid} onClick={() => setGrid((v) => !v)} label="Grid" />
        <Toggle
          on={sessions}
          onClick={() => setSessions((v) => !v)}
          label="Sessions"
        />
        <Toggle
          on={markers}
          onClick={() => setMarkers((v) => !v)}
          label="Session markers"
        />
      </div>
    </div>
  );
}
export const DateStylePanZoom: Story = {
  render: () => <DateStylePanZoomDemo />,
};

/** The `spacing` prop over the `calendar` sugar: **proportional** (top — the
 *  last session is a half-day, so its block is proportionally narrower) vs
 *  **uniform** (bottom — every session is equal width, the TradingView look).
 *  Same calendar, driven by `spacing`; charts derives the provider itself. */
export const SpacingProportionalVsUniform: Story = {
  render: () => {
    // A dramatic early close (11:00 → ~1.5h vs 6.5h) makes the metric obvious.
    const s = withHalfDay(weekdaySessions(6), 11);
    const cal = calendarOf(s);
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
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          calendar={cal}
          theme={docsTheme}
        >
          {row}
        </ChartContainer>
        <ChartContainer
          width={WIDTH}
          range={rangeOf(s)}
          calendar={cal}
          spacing="uniform"
          theme={docsTheme}
        >
          {row}
        </ChartContainer>
      </div>
    );
  },
};
