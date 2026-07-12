import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { twoSeries, BASE, STEP, RANGE } from './story-data.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * `cursor="point"` — a dot rides each series at the cursor, **no line and no
 * text**. The bare readout: pair it with an off-chart display (`onTrackerChanged`)
 * for the values. Fan-out: the live hover story, plus single/multiple series
 * pinned for a static regression shot.
 */
const W = 560;
const s = twoSeries();

const meta = {
  title: 'Charts/Cursors/Point',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Interactive** — hover-driven (no `trackerPosition` pin), so you can test
 *  the point behaviour yourself: a dot tracks each series under the pointer, no
 *  line, no chip. The other stories pin a controlled position for a static shot. */
export const Interactive: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} cursor="point" theme={docsTheme}>
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

/** **Single series** — one dot on the series at the cursor. */
export const SingleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="point"
      trackerPosition={BASE + 45 * STEP}
      theme={docsTheme}
    >
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multiple series** — a dot on each series at the shared cursor. */
export const MultipleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="point"
      trackerPosition={BASE + 45 * STEP}
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
