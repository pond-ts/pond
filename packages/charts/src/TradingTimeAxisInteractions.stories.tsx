import { useState } from 'react';
import { Sequence } from 'pond-ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { Candlestick } from './Candlestick.js';
import { YAxis } from './YAxis.js';
import { Marker, Region } from './annotations.js';
import {
  H,
  MIN,
  WIDTH,
  barSeq,
  candles,
  provider,
  rangeOf,
  sessionSeq,
  weekdaySessions,
} from './tradingAxis.fixture.js';

/**
 * Interaction coverage for the **trading-time (discontinuous) axis** — the
 * concerns that only bite once closed time is excised from the x scale: does the
 * cursor snap to a candle in trading-time, does an annotation box drawn *across*
 * an overnight gap collapse it, does edge-snapping still land, and does pan/zoom
 * move in trading-time (gaps staying shut). Each reuses the shared inline
 * provider from `tradingAxis.fixture.ts`.
 */
const meta = {
  title: 'Charts/TradingTimeAxis/Interactions',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

// ── Cursors ────────────────────────────────────────────────────────────────

/** **Crosshair + snap on candlesticks.** `cursor="crosshair"` with the default
 *  `crosshairSnap` — **hover the plot**: the reticle snaps its **x** to the
 *  nearest candle and reads the time on the x-axis pill, all resolved through the
 *  trading-time scale (`invert(pointer) → sampleAt → scale`), so the overnight
 *  gaps stay collapsed behind it and the snap lands on a real bar. */
export const CrosshairSnap: Story = {
  render: () => {
    const s = weekdaySessions(4);
    const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="crosshair"
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Free crosshair** (`crosshairSnap={false}`) — the reticle follows the raw
 *  pointer y; the vertical line still resolves its **x** through the trading-time
 *  scale, so the time readout stays on the live grid. Hover the plot to see it. */
export const CrosshairFree: Story = {
  render: () => {
    const s = weekdaySessions(4);
    const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="crosshair"
        crosshairSnap={false}
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Flag cursor across sessions.** `cursor="flag"` + `cursorTime` — hover and a
 *  staff rises from the candle to a value flag; the shared time reads once atop.
 *  Confirms the readout tracks the candle under the pointer across gaps. */
export const FlagOnCandles: Story = {
  render: () => {
    const s = weekdaySessions(4);
    const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="flag"
        cursorTime
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Annotations ──────────────────────────────────────────────────────────────

/** **A box across the gap.** A `<Region>` spanning sessions 2→4 (crossing two
 *  overnight closures). On the trading-time axis the shaded box **collapses the
 *  closed time** — its width is the trading-time span, its edges land on the
 *  session bars, not out in dead space. */
export const RegionAcrossSessions: Story = {
  render: () => {
    const s = weekdaySessions(5);
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
            <Region from={s[1]!.open} to={s[3]!.close} label="Tue–Thu" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Editable box across the gap.** `editAnnotations` + `onChange` — grab an edge
 *  and drag it across a closure. The edge resolves through the scale, so a drop
 *  inside dead time lands on the nearest live instant (the box never straddles a
 *  gap edge). Reported `from`/`to` are epoch-ms. */
function EditableRegionDemo() {
  const s = weekdaySessions(5);
  const bars = candles(s, sessionSeq(s), 15 * MIN);
  const [region, setRegion] = useState({ from: s[1]!.open, to: s[3]!.close });
  return (
    <ChartContainer
      width={WIDTH}
      range={rangeOf(s)}
      discontinuities={provider(s)}
      editAnnotations
    >
      <ChartRow height={260}>
        <YAxis id="p" side="right" />
        <Layers>
          <Candlestick series={bars} axis="p" />
          <Region
            from={region.from}
            to={region.to}
            label="drag the edges"
            onChange={setRegion}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
export const EditableRegion: Story = { render: () => <EditableRegionDemo /> };

/** **Snapping across the gap.** An editable `<Region>` plus a static `<Marker>`
 *  in a later session; `snap` (default on) pulls a dragged region edge onto the
 *  marker's guideline. Confirms snapping resolves in pixel/trading-time space —
 *  the edge snaps to the marker even though wall-clock time between them is
 *  mostly closed. Drag the region's right edge toward the marker. */
function SnappingDemo() {
  const s = weekdaySessions(4);
  const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
  const [region, setRegion] = useState({
    from: s[1]!.open,
    to: s[1]!.open + 3 * H,
  });
  return (
    <ChartContainer
      width={WIDTH}
      range={rangeOf(s)}
      discontinuities={provider(s)}
      editAnnotations
    >
      <ChartRow height={260}>
        <YAxis id="p" side="right" />
        <Layers>
          <Candlestick series={bars} axis="p" />
          <Marker at={s[2]!.open + 2 * H} label="snap target" />
          <Region
            from={region.from}
            to={region.to}
            label="drag to snap"
            onChange={setRegion}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
export const Snapping: Story = { render: () => <SnappingDemo /> };

// ── Pan / zoom ───────────────────────────────────────────────────────────────

/** **Pan / zoom in trading-time.** `panZoom` (uncontrolled) — drag to pan and
 *  wheel to zoom (to a 30-minute floor). Both move through the trading-time
 *  scale (`panRangeTrading` / `zoomRangeTrading`), so the overnight gaps stay
 *  collapsed and never reappear as you scrub or zoom across a session boundary. */
export const PanZoom: Story = {
  render: () => {
    const s = weekdaySessions(6);
    const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        panZoom
        minDuration={30 * MIN}
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Region cursor ────────────────────────────────────────────────────────────

/** **Region cursor over sessions.** `cursor="region"` + `cursorSequence` — hover
 *  and a band shades the **bucket** under the pointer. Here the calendar's session
 *  sequence (a `BoundedSequence`), so hovering highlights the whole trading
 *  **session** the pointer is in. */
export const RegionCursorSession: Story = {
  render: () => {
    const s = weekdaySessions(4);
    const bars = candles(s, barSeq(s, 30 * MIN), 5 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="region"
        cursorSequence={sessionSeq(s)}
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Region cursor, calendar week (cropped).** `cursorSequence={Sequence.calendar(
 *  'week')}` — a calendar-aware bucket. Hover and the band shades the whole trading
 *  **week**; because it maps through the trading-time scale, the weekend + overnight
 *  gaps inside the week **collapse**, so the band crops to the live sessions — the
 *  "duration or calendar aware, cropped to the disjoined scale" case. */
export const RegionCursorWeek: Story = {
  render: () => {
    const s = weekdaySessions(8); // ~1.5 weeks
    const bars = candles(s, sessionSeq(s), 15 * MIN);
    return (
      <ChartContainer
        width={WIDTH}
        range={rangeOf(s)}
        discontinuities={provider(s)}
        cursor="region"
        cursorSequence={Sequence.calendar('week')}
      >
        <ChartRow height={260}>
          <YAxis id="p" side="right" />
          <Layers>
            <Candlestick series={bars} axis="p" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
