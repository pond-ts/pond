import type { Meta, StoryObj } from '@storybook/react-vite';
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
 * `cursor="crosshair"` — the trading-terminal readout: a synced vertical line +
 * a dot per series, each series' value pinned to **its y-axis** as an on-axis
 * pill, and the hovered time pinned to the **x-axis**. These stories fan out:
 * single vs multiple series, dual-axis sides, and multi-row (one x-time pill,
 * shared). Pinned via `trackerPosition`.
 */
const W = 620;
const PIN = BASE + 40 * STEP;
const s = twoSeries();

const meta = {
  title: 'Charts/Cursors/Crosshair',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Single series** — line + dot, the value on the y-axis, the time on the x. */
export const SingleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multiple series** — a value pill per series on the shared axis, each in the
 *  series colour; one x-time pill. */
export const MultipleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
          <LineChart series={s} column="slow" as="slow" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Dual axis** — each series' pill hugs its own axis's side (left vs right). */
export const DualAxis: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <YAxis id="L" side="left" format=",.0f" />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="L" />
          <LineChart series={s} column="slow" as="slow" axis="R" />
        </Layers>
        <YAxis id="R" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multi-row** — the vertical line spans rows; each row pins its own value on
 *  its axis; the x-time pill shows once, on the shared x-axis. */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      cursorTime
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={150}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="a" />
        </Layers>
        <YAxis id="a" side="right" format=",.0f" />
      </ChartRow>
      <ChartRow height={150}>
        <Layers>
          <LineChart series={s} column="slow" as="slow" axis="b" />
        </Layers>
        <YAxis id="b" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};
