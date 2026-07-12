import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import {
  twoSeries,
  hrSeries,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * `cursor="inline"` — a dot on each series with its value chip **beside the dot**
 * (in place, not stacked at the top). These stories fan out: single vs multiple
 * series, the `cursorTime` chip, the right-edge flip (`LABEL_FLIP_FRACTION` in
 * `Layers.tsx` — past 85% of the plot width a chip flips to the dot's *left*),
 * the per-row top/bottom clamp (a chip near the row edge is nudged back inside
 * rather than clipped), and multi-row (the cursor is shared; each row clamps
 * independently). Pinned via a controlled `trackerPosition` for a static shot —
 * no hover needed.
 */
const W = 560;
const s = twoSeries();

function Chart({
  pin,
  cursorTime,
  children,
}: {
  pin: number;
  cursorTime?: boolean;
  children: ReactNode;
}) {
  return (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="inline"
      cursorTime={cursorTime ?? false}
      trackerPosition={pin}
      theme={docsTheme}
    >
      <ChartRow height={220}>
        <Layers>{children}</Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  );
}

const meta = {
  title: 'Charts/Cursors/Inline',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Interactive** — hover-driven (no `trackerPosition` pin), so you can test
 *  the inline behaviour yourself: a dot rides each series with its value chip
 *  beside it, flipping/clamping near the edges as you move. The other stories
 *  pin a controlled position for a static regression shot; this is the live one. */
export const Interactive: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="inline"
      cursorTime
      theme={docsTheme}
    >
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
          <LineChart series={s} column="slow" as="slow" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Single series** — one dot, its value chip beside it. */
export const SingleSeries: Story = {
  render: () => (
    <Chart pin={BASE + 45 * STEP}>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
    </Chart>
  ),
};

/** **Multiple series** — a chip beside each series' dot. */
export const MultipleSeries: Story = {
  render: () => (
    <Chart pin={BASE + 45 * STEP}>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
      <LineChart series={s} column="slow" as="slow" axis="usd" />
    </Chart>
  ),
};

/** **With time** — `cursorTime` adds the cursor's time chip atop the readout. */
export const WithTime: Story = {
  render: () => (
    <Chart pin={BASE + 45 * STEP} cursorTime>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
      <LineChart series={s} column="slow" as="slow" axis="usd" />
    </Chart>
  ),
};

/** **Right-edge flip** — near the right edge the chips flip to the left of their
 *  dots so they don't overflow the plot. */
export const RightEdgeFlip: Story = {
  render: () => (
    <Chart pin={BASE + 84 * STEP}>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
      <LineChart series={s} column="slow" as="slow" axis="usd" />
    </Chart>
  ),
};

/** **Near-top clamp** — pinned at the series' peak (its dot sits at the very top
 *  of the plot); the chip is nudged down to stay inside the row instead of being
 *  clipped above it. */
export const NearTopClamp: Story = {
  render: () => (
    <Chart pin={BASE + 16 * STEP}>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
    </Chart>
  ),
};

/** **Near-bottom clamp** — pinned at the series' trough (its dot sits at the very
 *  bottom of the plot); the chip is nudged up to stay inside the row. */
export const NearBottomClamp: Story = {
  render: () => (
    <Chart pin={BASE + 45 * STEP}>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
    </Chart>
  ),
};

/** **Multi-row** — the cursor is shared across rows (one x); each row places and
 *  clamps its own chip independently. */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="inline"
      trackerPosition={BASE + 45 * STEP}
      theme={docsTheme}
    >
      <ChartRow height={150}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
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
