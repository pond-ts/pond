import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import {
  twoSeries,
  twoColorTheme,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';

/**
 * `cursor="inline"` — a dot on each series with its value chip **beside the dot**
 * (in place, not stacked at the top). These stories fan out: single vs multiple
 * series, the `cursorTime` chip, and the right-edge flip (a chip near the right
 * edge flips to the dot's left so it stays in-plot). Pinned via `trackerPosition`.
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
      theme={twoColorTheme}
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
