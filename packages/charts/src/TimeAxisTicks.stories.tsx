import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { Candlestick } from './Candlestick.js';
import { LineChart } from './LineChart.js';
import { TimeAxis } from './TimeAxis.js';
import { YAxis } from './YAxis.js';
import {
  MIN,
  WIDTH,
  barSeq,
  candles,
  provider,
  rangeOf,
  sessionSeq,
  tickSchema,
  weekdaySessions,
} from './tradingAxis.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * The logical tick ladder, walked rung by rung — one story per grain
 * (hours → days → months → quarters → years; the day grain also thins by
 * per-month midpoint subdivision before reaching month grain — there is no
 * separate week rung), each at a span/width that naturally lands on it, plus
 * narrow variants proving the grain coarsens
 * (never crowds) as room shrinks. Every story pins `dateStyle="stacked"` to
 * show the **two-tier** labels: the first row at the tick grain, the second
 * (boundary) row carrying the coarser context the first row omits — the date
 * under clock ticks, the year under everything coarser — once per boundary
 * crossing plus the first tick. (The shipped default is the single-row `flat`
 * style — see `Axes/TradingTimeAxis` → `DateStyle…` for the flat-vs-stacked
 * comparison.) The `Continuous…` stories are the same ladder on a **plain**
 * (gap-free) time axis: no calendar wiring needed.
 */

const meta = {
  title: 'Axes/TimeAxisTicks',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** A plain continuous series — one point per `stepMs`, gap-free — for the
 *  no-calendar stories (the ladder's identity-provider path). */
function continuousSeries(
  start: number,
  count: number,
  stepMs: number,
): TimeSeries<typeof tickSchema> {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const price = 100 + 9 * Math.sin(i / 22) + 3 * Math.sin(i / 4.5) + i * 0.01;
    rows.push([start + i * stepMs, price]);
  }
  return new TimeSeries({ name: 'continuous', schema: tickSchema, rows });
}

function tradingStory(
  sessionCount: number,
  width: number,
  barMinutes: number,
): Story {
  return {
    render: () => {
      const s = weekdaySessions(sessionCount);
      const bars = candles(s, barSeq(s, barMinutes * MIN), 5 * MIN);
      return (
        <ChartContainer
          width={width}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
          showAxis={false}
        >
          <ChartRow height={220}>
            <YAxis id="p" />
            <Layers>
              <Candlestick series={bars} axis="p" />
            </Layers>
          </ChartRow>
          <TimeAxis dateStyle="stacked" />
        </ChartContainer>
      );
    },
  };
}

function tradingDailyStory(sessionCount: number, width: number): Story {
  return {
    render: () => {
      const s = weekdaySessions(sessionCount);
      const bars = candles(s, sessionSeq(s), 60 * MIN);
      return (
        <ChartContainer
          width={width}
          range={rangeOf(s)}
          discontinuities={provider(s)}
          theme={docsTheme}
          showAxis={false}
        >
          <ChartRow height={220}>
            <YAxis id="p" />
            <Layers>
              <Candlestick series={bars} axis="p" />
            </Layers>
          </ChartRow>
          <TimeAxis dateStyle="stacked" />
        </ChartContainer>
      );
    },
  };
}

// ——— Trading-calendar axis, rung by rung ———

/** One 6.5h session, wide → **hour1** grain: the open, then every clock hour.
 *  The boundary row shows the session's date once, under the first tick. */
export const IntradayHourly = tradingStory(1, WIDTH, 30);

/** Three sessions → **hour3** grain: a few clock times per session; the
 *  boundary row dates each session's first tick (a new local day). */
export const IntradayThreeHour = tradingStory(3, WIDTH, 30);

/** A week of sessions at a modest width → **day** grain: one date per
 *  session (`%b %d`), the year on the boundary row once. */
export const WeekDaily = tradingDailyStory(5, 420);

/** ~6 trading weeks at a narrow width → still **day** grain, thinned by
 *  per-month midpoint subdivision in **session-index** space: marks an equal
 *  number of sessions apart (evenly spaced pixels — Mondays, on a weekday
 *  calendar), anchored at each month's first session, the year on the
 *  boundary row. (There is no separate week grain — the subdivision band owns
 *  everything down to month grain.) */
export const MultiWeekDaily = tradingDailyStory(28, 420);

/** ~3 trading months of dailies → **month** grain: bare month names, the
 *  year underneath at the first tick (and again only if it turns). */
export const QuarterDaily = tradingDailyStory(65, WIDTH);

/** A full trading year on a 900px plot → **month** grain: `Jul Aug Sep …`
 *  with the year on the boundary row — once at the start, once at the turn.
 *  This is the direct repro of the mixed `"Jun 23" / "Sep" / "Dec"` axis the
 *  d3 multi-scale default produced. */
export const YearMonthly = tradingDailyStory(252, 900);

/** The same year at 420px → the cap shrinks and the grain steps up to
 *  **quarter**: still month-name labels, still year context underneath. */
export const YearMonthlyNarrow = tradingDailyStory(252, 420);

/** ~2.5 trading years → **quarter** grain on a wide plot. */
export const MultiYearQuarterly = tradingDailyStory(600, 900);

/** The same ~2.5 years at 300px → **year** grain: bare years, and no
 *  boundary row (a year label already says everything). */
export const MultiYearNarrow = tradingDailyStory(600, 300);

// ——— Plain continuous axis (no calendar) — the same ladder ———

/** A year of continuous daily data with **no calendar wiring at all** — the
 *  plain time axis runs the identity-provider ladder, so it ticks on month
 *  starts with the year underneath, instead of d3's mixed multi-scale
 *  default (`"Jun 23"`, bare `"Sep"`, …). */
export const ContinuousYear: Story = {
  render: () => {
    const start = new Date(2025, 5, 23).getTime();
    const series = continuousSeries(start, 365, 24 * 60 * MIN);
    return (
      <ChartContainer width={900} theme={docsTheme} showAxis={false}>
        <ChartRow height={220}>
          <YAxis id="p" />
          <Layers>
            <LineChart series={series} column="price" axis="p" />
          </Layers>
        </ChartRow>
        <TimeAxis dateStyle="stacked" />
      </ChartContainer>
    );
  },
};

/** An afternoon of continuous minutely data — the plain axis descends the
 *  ladder to clock-aligned hours, with the date on the boundary row. */
export const ContinuousIntraday: Story = {
  render: () => {
    const start = new Date(2026, 0, 5, 9, 13).getTime();
    const series = continuousSeries(start, 460, MIN);
    return (
      <ChartContainer width={WIDTH} theme={docsTheme} showAxis={false}>
        <ChartRow height={220}>
          <YAxis id="p" />
          <Layers>
            <LineChart series={series} column="price" axis="p" />
          </Layers>
        </ChartRow>
        <TimeAxis dateStyle="stacked" />
      </ChartContainer>
    );
  },
};
