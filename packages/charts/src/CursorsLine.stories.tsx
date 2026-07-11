import type { Meta, StoryObj } from '@storybook/react-vite';
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
 * `cursor="line"` (the **default**) — a single synced vertical line at the
 * cursor, **no marks over the data**; values are meant to be surfaced *outside*
 * the chart (`onTrackerChanged`). Its signature is **cross-row sync**: one line
 * spans every row on the shared x. Fan-out: live single-row and multi-row hover,
 * the `cursorTime` chip, and an externally-driven (`trackerPosition`) shot.
 */
const W = 560;
const s = twoSeries();
const hr = hrSeries();

const meta = {
  title: 'Charts/Cursors/Line',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Interactive** — hover-driven (no `trackerPosition` pin), so you can test
 *  the default cursor yourself: the synced vertical line follows the pointer, no
 *  marks on the data. `cursorTime` adds the time chip at the axis. */
export const Interactive: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} cursorTime theme={twoColorTheme}>
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

/** **Multi-row sync** — hover either row: the one shared line spans both on the
 *  common x, the time chip shows once at the bottom. */
export const MultiRowSync: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} cursorTime theme={twoColorTheme}>
      <ChartRow height={150}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
          <LineChart series={s} column="slow" as="slow" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
      <ChartRow height={150}>
        <Layers>
          <LineChart series={hr} column="bpm" as="fast" axis="bpm" />
        </Layers>
        <YAxis id="bpm" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Externally driven (`trackerPosition`)** — the other half of the tracker
 *  API: an app pins the line (a time slider, a video playhead). Here it's a
 *  static pin; hovering is ignored while a controlled position is set. */
export const Controlled: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursorTime
      trackerPosition={BASE + 45 * STEP}
      theme={twoColorTheme}
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
