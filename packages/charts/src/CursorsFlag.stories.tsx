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
  N,
  RANGE,
} from './story-data.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * `cursor="flag"` — a dot on each series at the cursor, each value flying as a
 * **flag** on a staff stacked near the top of the row. These stories fan out:
 * single vs multiple series, the `cursorTime` time chip (caps the stack),
 * multi-row (one shared cursor, the time chip shows once), and a near-right-edge
 * pin (the flag flips left of its staff so it stays in-plot). The cursor is
 * pinned with a controlled `trackerPosition` for a static shot — no hover.
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
      cursor="flag"
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
  title: 'Cursors/Flag',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Interactive** — hover-driven (no `trackerPosition` pin), so you can test
 *  the flag behaviour yourself: the dots + stacked flags track the pointer, and
 *  the time chip caps the stack. The other stories pin a controlled position for
 *  a static regression shot; this is the live one. */
export const Interactive: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="flag"
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

/** **Single series** — one dot, one flag on its staff. */
export const SingleSeries: Story = {
  render: () => (
    <Chart pin={BASE + 45 * STEP}>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
    </Chart>
  ),
};

/** **Multiple series** — a flag per series, stacked at the top of the row. */
export const MultipleSeries: Story = {
  render: () => (
    <Chart pin={BASE + 45 * STEP}>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
      <LineChart series={s} column="slow" as="slow" axis="usd" />
    </Chart>
  ),
};

/** **With time** — `cursorTime` caps the flag stack with the cursor's time. */
export const WithTime: Story = {
  render: () => (
    <Chart pin={BASE + 45 * STEP} cursorTime>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
      <LineChart series={s} column="slow" as="slow" axis="usd" />
    </Chart>
  ),
};

/** **Multi-row** — the cursor is shared across rows (one x); the time chip
 *  shows once, atop the first row, not repeated on the second. */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="flag"
      cursorTime
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

/** **Near-right-edge pin** — close to the plot's right edge the flags (and the
 *  time chip) flip to the left of their staffs so they stay in-plot. */
export const NearRightEdge: Story = {
  render: () => (
    <Chart pin={BASE + (N - 3) * STEP} cursorTime>
      <LineChart series={s} column="fast" as="fast" axis="usd" />
      <LineChart series={s} column="slow" as="slow" axis="usd" />
    </Chart>
  ),
};
