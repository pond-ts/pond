import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { BoxPlot } from './BoxPlot.js';
import { YAxis } from './YAxis.js';
import { CrosshairCursor } from './cursors.js';
import { defaultTheme } from './theme.js';
import type { CursorSnap } from './context.js';
import { TimeSeries } from 'pond-ts';
import {
  twoSeries,
  hrSeries,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';

/**
 * `<CrosshairCursor>` — a single inspection **reticle**: a full-height dashed
 * vertical line + a full-width dashed horizontal line + a centre dot, with the
 * value pinned to the y-axis and the time to the **x-axis** (connected to the
 * vertical line).
 *
 * **`snap`** (default `true`) centres the reticle on the nearest **data
 * point** — the vertical line snaps to a sample's x, the horizontal to its value.
 * `false` is a **free** reticle following the raw pointer, the value read as
 * `yScale.invert(pointerY)`. The snap stories pin a controlled `trackerPosition`
 * (a static shot, no hover → the reticle centres on the first sample); the free
 * reticle is hover-driven (it needs the pointer y), so its story has no pin —
 * hover the plot to see it.
 *
 * Crosshair puts the time on the x-axis pill (its `showTime` defaults to
 * `true`) — unlike `<FlagCursor>` / `<InlineCursor>`'s `showTime`, there is no
 * per-row time chip.
 *
 * The **value pill** is an *axis indicator*: it lands on the axis whose scale
 * produced the number — its side, and its column when a side carries several —
 * wearing that axis's `<YAxis color>` when it has one. The last three stories
 * fan that out.
 */
const W = 620;
const PIN = BASE + 40 * STEP;
const s = twoSeries();
/** The axis-colour stories paint each axis its **series'** colour (the multi-axis
 *  convention `<YAxis color>` documents), read off the register the layer draws
 *  in — so the pair stays matched if the default palette moves. */
const PRIMARY = defaultTheme.line.primary!.color;
const SECONDARY = defaultTheme.line.secondary!.color;
const CONTEXT = defaultTheme.line.context!.color;

const meta = {
  title: 'Cursors/Crosshair',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Free reticle** — `snap={false}`: the horizontal line + centre
 *  follow the pointer **y** freely (value = `yScale.invert(pointerY)`), while the
 *  vertical line still snaps its **x** to the data grid (a clean time readout).
 *  Hover-driven — **hover the plot** to see it (no `trackerPosition` pin). */
export const FreeReticle: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <CrosshairCursor snap={false} />
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Single series** — line + dot, the value pinned to the y-axis, the time on the x. */
export const SingleSeries: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multiple series** — a value pill per series on the shared axis, each in its
 *  own series colour, each with its own dashed connector; one x-time pill. */
export const MultipleSeries: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
          <LineChart series={s} column="slow" as="secondary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Left-side single axis** — the lone axis is on the left, so the pill hugs the
 *  left gutter (not the right default) with its connector reaching left. */
export const LeftAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <YAxis id="usd" side="left" format=",.0f" />
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Dual axis** — each series' pill hugs its own axis's side (left vs right),
 *  each with a connector reaching its own gutter. */
export const DualAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <YAxis id="L" side="left" format=",.0f" />
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="L" />
          <LineChart series={s} column="slow" as="secondary" axis="R" />
        </Layers>
        <YAxis id="R" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multi-row** — the vertical line spans both rows; each row pins its own
 *  value on its own axis; the x-time pill shows once, on the shared x-axis. */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={150}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
      <ChartRow height={150}>
        <Layers>
          <LineChart series={hrSeries()} column="bpm" axis="bpm" />
        </Layers>
        <YAxis id="bpm" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Axis colour** — the value pill wears the reticle axis's own `<YAxis color>`
 *  (falling back to the cursor's ink when the axis sets none, as every story
 *  above shows). The pill is an *axis* indicator, so it reads as part of the axis
 *  it covers rather than as floating cursor chrome. */
export const AxisColor: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" color={PRIMARY} />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Two axes on one side** — the pill sits on the axis that *measured* the
 *  reticle's value, not on the innermost one. Here the reticle reads the `bpm`
 *  series, whose axis is the **outer** of the two right-hand axes, so the pill
 *  lands out there, over that axis's ticks; the inner `usd` axis is untouched. */
export const StackedAxes: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <Layers>
          <LineChart
            series={hrSeries()}
            column="bpm"
            as="secondary"
            axis="bpm"
          />
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        {/* Right axes are authored inner→outer: `usd` hugs the plot, `bpm` sits
            beyond it. */}
        <YAxis id="usd" side="right" format=",.0f" />
        <YAxis id="bpm" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Two axes on one side, each coloured** — position *and* ink together: the
 *  pill is out on the `bpm` axis and in that axis's colour, so a reader who
 *  hasn't followed the reticle across the plot can still tell which of two
 *  stacked scales the number is on. */
export const StackedAxesColored: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <Layers>
          <LineChart
            series={hrSeries()}
            column="bpm"
            as="secondary"
            axis="bpm"
          />
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" color={PRIMARY} />
        <YAxis id="bpm" side="right" format=",.0f" color={SECONDARY} />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Two axes on the LEFT** — the mirror of `StackedAxes`. Left axes are authored
 *  **outer→inner** (the opposite of right), so `bpm` is declared first and sits
 *  furthest from the plot; the pill runs out that way, anchored by its right edge
 *  instead of its left. */
export const StackedAxesLeft: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <YAxis id="bpm" side="left" format=",.0f" color={SECONDARY} />
        <YAxis id="usd" side="left" format=",.0f" color={PRIMARY} />
        <Layers>
          <LineChart
            series={hrSeries()}
            column="bpm"
            as="secondary"
            axis="bpm"
          />
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Stacked on both sides** — two axes each side, so each gutter's offsets are
 *  walked independently (a left pill counts only left columns, a right pill only
 *  right). The reticle reads `bpm` on the outer **left**; hover a trace to move
 *  the pill between all four axes. */
export const StackedAxesBothSides: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={240}>
        <YAxis id="bpm" side="left" format=",.0f" color={SECONDARY} />
        <YAxis id="usd" side="left" format=",.0f" color={PRIMARY} />
        <Layers>
          <LineChart
            series={hrSeries()}
            column="bpm"
            as="secondary"
            axis="bpm"
          />
          <LineChart series={s} column="fast" as="primary" axis="usd" />
          <LineChart series={s} column="slow" as="context" axis="slow" />
        </Layers>
        {/* Right pair: `slow` inner (carries the third trace), `spare` outer
            with no series of its own — an axis column the reticle never picks,
            which is what makes the offsets visible as columns. */}
        <YAxis id="slow" side="right" format=",.0f" color={CONTEXT} />
        <YAxis id="spare" side="right" format=",.0f" min={0} max={100} />
      </ChartRow>
    </ChartContainer>
  ),
};

/** The `SnapReadout` story's body: a chart plus a line of text showing the
 *  latest `onSnap` report. */
function SnapReadoutDemo() {
  const [snap, setSnap] = useState<CursorSnap | null>(null);
  return (
    <div>
      <ChartContainer range={RANGE} width={W}>
        <CrosshairCursor onSnap={setSnap} />
        <ChartRow height={240}>
          <Layers>
            <LineChart series={s} column="fast" as="primary" axis="usd" />
            <LineChart series={s} column="slow" as="secondary" axis="usd" />
          </Layers>
          <YAxis id="usd" side="right" format=",.0f" />
        </ChartRow>
      </ChartContainer>
      <div
        style={{
          fontFamily: defaultTheme.font.family,
          fontSize: 12,
          marginTop: 8,
          color: snap?.color ?? defaultTheme.axis.label,
        }}
      >
        {snap === null
          ? 'Not snapped — hover a line'
          : `Snapped to ${snap.label} (axis ${snap.axisId}) at ` +
            `${new Date(snap.x).toISOString()}: ${snap.formatted}`}
      </div>
    </div>
  );
}

/** **Snap readout** — `<CrosshairCursor onSnap>` reports what the reticle is
 *  snapped to: the series (label, colour, axis) and the point (time, value).
 *  The centre dot wears the snapped series' colour. Hover-driven: move between
 *  the two lines and the text below follows. */
export const SnapReadout: Story = {
  render: () => <SnapReadoutDemo />,
};

/** Six 10-step boxes across the fixture range, each with visible spread. */
function boxSeries() {
  const width = 10 * STEP;
  const rows = Array.from({ length: 6 }, (_, i) => {
    const begin = BASE + i * width;
    const mid = 100 + 12 * Math.sin(i / 1.3);
    const spread = 8 + 3 * Math.cos(i);
    return [
      [begin, begin + width],
      mid - spread,
      mid - spread / 2,
      mid,
      mid + spread / 2,
      mid + spread,
    ];
  });
  return new TimeSeries({
    name: 'boxes',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'lo', kind: 'number' },
      { name: 'q1', kind: 'number' },
      { name: 'med', kind: 'number' },
      { name: 'q3', kind: 'number' },
      { name: 'hi', kind: 'number' },
    ] as const,
    rows: rows as never,
  });
}

/** The `BoxPlot` story's body: a box plot plus the latest `onSnap` report. */
function BoxPlotDemo() {
  const [snap, setSnap] = useState<CursorSnap | null>(null);
  return (
    <div>
      <ChartContainer range={RANGE} width={W}>
        <CrosshairCursor onSnap={setSnap} />
        <ChartRow height={240}>
          <Layers>
            <BoxPlot
              series={boxSeries()}
              lower="lo"
              q1="q1"
              median="med"
              q3="q3"
              upper="hi"
              axis="v"
              gap={14}
            />
          </Layers>
          <YAxis id="v" side="right" format=",.0f" />
        </ChartRow>
      </ChartContainer>
      <div
        style={{
          fontFamily: defaultTheme.font.family,
          fontSize: 12,
          marginTop: 8,
          color: snap?.color ?? defaultTheme.axis.label,
        }}
      >
        {snap === null
          ? 'Not snapped — hover a box'
          : `Snapped to ${snap.label}: ${snap.formatted}`}
      </div>
    </div>
  );
}

/** **On a box plot** ([PND-BOXPLT]) — the reticle snaps to the box: the
 *  vertical line to the box centre, the horizontal line to the quantile
 *  nearest the pointer, whose value goes on the y-axis pill and to `onSnap`.
 *  Hover-driven: move up and down inside a box and the reading steps through
 *  `hi` / `q3` / `med` / `q1` / `lo`. */
export const BoxPlotSnap: Story = {
  name: 'BoxPlot',
  render: () => <BoxPlotDemo />,
};
