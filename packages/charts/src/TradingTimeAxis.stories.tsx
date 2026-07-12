import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { Candlestick } from './Candlestick.js';
import { YAxis } from './YAxis.js';
import {
  MIN,
  WIDTH,
  barSeq,
  calendarOf,
  candles,
  provider,
  rangeOf,
  sessionSeq,
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
  title: 'Charts/TradingTimeAxis',
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
