import { Sequence } from 'pond-ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { Candlestick } from './Candlestick.js';
import { YAxis } from './YAxis.js';
import { priceSeries, RANGE, twoColorTheme } from './story-data.fixture.js';
import {
  MIN,
  barSeq,
  candles,
  provider,
  rangeOf,
  sessionSeq,
  weekdaySessions,
} from './tradingAxis.fixture.js';

/**
 * `cursor="region"` — instead of a line or reticle, a shaded **band** highlights
 * the **bucket** under the pointer. The bucketing is `cursorSequence`: a pond
 * `Sequence` (duration or calendar-aware — `Sequence.every('15m')`,
 * `Sequence.calendar('week')`) realized over the view, or a `BoundedSequence`
 * (e.g. a trading calendar's `sessionSequence()`) used as-is. The band maps
 * through the x scale, so on a **trading-time** axis the closed part of a bucket
 * collapses and it crops to the live session(s). **Hover the plot** to see it.
 */
const meta = {
  title: 'Charts/Cursors/Region',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

const W = 640;

/** **Fixed-duration bucket.** A plain time chart with `Sequence.every('15m')` —
 *  hover and the band shades the 15-minute window the pointer is in. The general
 *  (non-trading) region cursor. */
export const Default: Story = {
  render: () => (
    <ChartContainer
      width={W}
      range={RANGE}
      theme={twoColorTheme}
      cursor="region"
      cursorSequence={Sequence.every('15m')}
    >
      <ChartRow height={240}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="p" />
        </Layers>
        <YAxis id="p" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Session bucket.** A `BoundedSequence` (a trading calendar's session
 *  sequence) — hover highlights the whole trading **session** under the pointer,
 *  edge to edge. */
export const Sessions: Story = {
  render: () => {
    const s = weekdaySessions(4);
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    return (
      <ChartContainer
        width={W}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="region"
        cursorSequence={sessionSeq(s)}
      >
        <ChartRow height={240}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Calendar bucket, cropped to the disjoined scale.** `Sequence.calendar(
 *  'week')` on a trading-time axis — hover shades the whole trading **week**, and
 *  because the band maps through the scale the weekend + overnight gaps inside it
 *  **collapse**, so it crops to the live sessions. */
export const CroppedToSessions: Story = {
  render: () => {
    const s = weekdaySessions(8); // ~1.5 weeks
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    return (
      <ChartContainer
        width={W}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="region"
        cursorSequence={Sequence.calendar('week')}
      >
        <ChartRow height={240}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Aggregation-aligned.** 5-minute ticks aggregated to **1-hour** candles, with
 *  the region cursor driven by the **same** 1-hour windows — the one
 *  `barSequence` feeds both `aggregate` and `cursorSequence`. So hovering a candle
 *  shades exactly the bucket that produced it: the band frames the candle's hour,
 *  the last (truncated) bar of each session included. */
export const AggregationAligned: Story = {
  render: () => {
    const s = weekdaySessions(3);
    const hourGrid = barSeq(s, 60 * MIN); // the 1-hour aggregation windows
    const bars = candles(s, hourGrid, 5 * MIN); // 5m ticks → 1h OHLC over that grid
    return (
      <ChartContainer
        width={W}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="region"
        cursorSequence={hourGrid}
      >
        <ChartRow height={240}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
