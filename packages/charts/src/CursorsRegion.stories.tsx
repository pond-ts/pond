import { useState } from 'react';
import { Sequence } from 'pond-ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TimeRange } from 'pond-ts';
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

/** **Drag to select → zoom.** Providing `onRegionSelect` makes the region cursor
 *  **draggable**: drag across the plot and the band extends **bucket by bucket**
 *  (here 1-hour candles), and on release it fires once with the selected
 *  `TimeRange`. The cursor doesn't keep the range — the callback does. This demo
 *  zooms the view to the selection (the container doesn't zoom itself; that's the
 *  consumer's job); **Reset** restores the full range. */
function DragToSelectDemo() {
  const s = weekdaySessions(3);
  const hourGrid = barSeq(s, 60 * MIN);
  const bars = candles(s, hourGrid, 5 * MIN);
  const full = rangeOf(s);
  const [range, setRange] = useState<[number, number]>(full);
  const zoomed = range[0] !== full[0] || range[1] !== full[1];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <button
        type="button"
        onClick={() => setRange(full)}
        disabled={!zoomed}
        style={{ alignSelf: 'flex-start', padding: '2px 10px', fontSize: 12 }}
      >
        Reset zoom
      </button>
      <ChartContainer
        width={W}
        range={range}
        discontinuities={provider(s)}
        cursor="region"
        cursorSequence={hourGrid}
        onRegionSelect={(r: TimeRange) => setRange([r.begin(), r.end()])}
      >
        <ChartRow height={220}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
export const DragToSelect: Story = { render: () => <DragToSelectDemo /> };

/** **Freeform (no sequence).** Omit `cursorSequence` and the region cursor is the
 *  degenerate case: it renders as a **line** on hover, and a drag selects a
 *  **freeform** range (no bucket snapping) — the same `onRegionSelect` fires on
 *  release. Here it zooms; **Reset** restores the full range. */
function FreeformDemo() {
  const full: [number, number] = [RANGE[0], RANGE[1]];
  const [range, setRange] = useState<[number, number]>(full);
  const zoomed = range[0] !== full[0] || range[1] !== full[1];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <button
        type="button"
        onClick={() => setRange(full)}
        disabled={!zoomed}
        style={{ alignSelf: 'flex-start', padding: '2px 10px', fontSize: 12 }}
      >
        Reset zoom
      </button>
      <ChartContainer
        width={W}
        range={range}
        theme={twoColorTheme}
        cursor="region"
        onRegionSelect={(r: TimeRange) => setRange([r.begin(), r.end()])}
      >
        <ChartRow height={220}>
          <Layers>
            <LineChart series={priceSeries()} column="price" axis="p" />
          </Layers>
          <YAxis id="p" side="right" format=",.0f" />
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
export const Freeform: Story = { render: () => <FreeformDemo /> };

/** **Pan + shift-select.** With `panZoom` on, `regionSelectModifier="shift"` shares
 *  the drag: **plain drag pans**, **shift-drag** selects a region (shown below).
 *  Wheel-zoom works either way. Without the modifier a region-drag would preempt
 *  pan entirely. */
function PanAndSelectDemo() {
  const s = weekdaySessions(3);
  const hourGrid = barSeq(s, 60 * MIN);
  const bars = candles(s, hourGrid, 5 * MIN);
  const [sel, setSel] = useState('— (shift-drag to select)');
  const fmt = (t: number) => new Date(t).toISOString().slice(5, 16);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <div style={{ fontSize: 12 }}>selected: {sel}</div>
      <ChartContainer
        width={W}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        panZoom
        cursor="region"
        cursorSequence={hourGrid}
        regionSelectModifier="shift"
        onRegionSelect={(r: TimeRange) =>
          setSel(`${fmt(r.begin())} → ${fmt(r.end())}`)
        }
      >
        <ChartRow height={220}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
export const PanAndSelect: Story = { render: () => <PanAndSelectDemo /> };
