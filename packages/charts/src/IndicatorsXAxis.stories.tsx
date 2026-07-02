import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Marker } from './annotations.js';
import {
  priceSeries,
  twoColorTheme,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';

/**
 * **X-axis indicators** — a value pinned to the x-axis edge as an on-axis pill.
 * Two producers today (there's no standalone `XAxisIndicator` component):
 *  - **`<Marker indicator>`** — a static x-pill at the marker's `at`.
 *  - **`cursor="crosshair"`** — the hovered time, pinned to the x-axis live.
 * (The y-axis counterpart is the standalone `<YAxisIndicator>`, under
 * **Indicators/Y Axis**.)
 */
const W = 620;
const at = (i: number) => BASE + i * STEP;

const meta = {
  title: 'Charts/Indicators/X Axis',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Marker pill** — `<Marker indicator label={false}>`: the marker's time pinned
 *  to the x-axis, no in-plot chip. */
export const MarkerPill: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Marker at={at(45)} indicator label={false} />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Marker pill (labelled)** — with a `label`, the x-pill echoes it ("open")
 *  instead of the time. */
export const MarkerPillLabelled: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Marker at={at(45)} indicator label="open" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Crosshair time** — `cursor="crosshair"` pins the hovered time to the x-axis
 *  (pinned here via `trackerPosition` for a static shot). */
export const CrosshairTime: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={at(40)}
      theme={twoColorTheme}
    >
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};
