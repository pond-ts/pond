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
  twoColorTheme,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';

/**
 * `cursor="flag"` — a dot on each series at the cursor, each value flying as a
 * **flag** on a staff stacked near the top of the row. These stories fan out:
 * single vs multiple series, the `cursorTime` time chip, and multi-row. The
 * cursor is pinned with a controlled `trackerPosition` for a static shot.
 */
const W = 560;
const PIN = BASE + 45 * STEP;
const s = twoSeries();

function Row({ children }: { children: ReactNode }) {
  return (
    <ChartRow height={220}>
      <Layers>{children}</Layers>
      <YAxis id="usd" side="right" format=",.0f" />
    </ChartRow>
  );
}

const meta = {
  title: 'Charts/Cursors/Flag',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Single series** — one dot, one flag. */
export const SingleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="flag"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <Row>
        <LineChart series={s} column="fast" as="fast" axis="usd" />
      </Row>
    </ChartContainer>
  ),
};

/** **Multiple series** — a flag per series, stacked at the top. */
export const MultipleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="flag"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <Row>
        <LineChart series={s} column="fast" as="fast" axis="usd" />
        <LineChart series={s} column="slow" as="slow" axis="usd" />
      </Row>
    </ChartContainer>
  ),
};

/** **With time** — `cursorTime` caps the flag stack with the cursor's time. */
export const WithTime: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="flag"
      cursorTime
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <Row>
        <LineChart series={s} column="fast" as="fast" axis="usd" />
        <LineChart series={s} column="slow" as="slow" axis="usd" />
      </Row>
    </ChartContainer>
  ),
};

/** **Multi-row** — the cursor is shared across rows (one x); the time chip shows
 *  once, atop the first row. */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="flag"
      cursorTime
      trackerPosition={PIN}
      theme={twoColorTheme}
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
