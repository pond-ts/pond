import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Marker } from './annotations.js';
import { priceSeries, BASE, STEP, RANGE } from './story-data.fixture.js';

/**
 * `<Marker>` — a vertical line at an x position (a time here), in the turquoise
 * annotation register. These stories fan out its props: **label** (auto time /
 * custom / off), the **indicator** x-axis-pill opt-in, **selection / depth**, and
 * **multiple** markers. Drag-to-edit + create live under **Annotations/Scenarios**.
 */
const W = 560;
const H = 220;
const at = (i: number) => BASE + i * STEP;

/** One price row with a right-hand USD axis. The container's default bottom time
 *  axis draws a marker's `indicator` pill; children are the annotation(s). */
function Chart({ children }: { children: ReactNode }) {
  return (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={H}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          {children}
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  );
}

const meta = {
  title: 'Charts/Annotations/Marker',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Default** — no `label`, so the chip auto-labels with the formatted time. */
export const Default: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} />
    </Chart>
  ),
};

/** **Custom label** — a `label` string replaces the auto time chip. */
export const CustomLabel: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} label="open" />
    </Chart>
  ),
};

/** **No label** — `label={false}` draws the line with no chip. */
export const NoLabel: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} label={false} />
    </Chart>
  ),
};

/** **Indicator** — `indicator` pins the time to the x-axis as an on-axis pill,
 *  alongside the near-line chip. */
export const Indicator: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} indicator />
    </Chart>
  ),
};

/** **Indicator only** — `indicator` + `label={false}`: the x-axis pill (showing
 *  the time) with no in-plot chip. */
export const IndicatorOnly: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} indicator label={false} />
    </Chart>
  ),
};

/** **Indicator echoes a custom label** — with a `label`, the x-axis pill shows
 *  the label ("open"), not the time. */
export const IndicatorWithLabel: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} indicator label="open" />
    </Chart>
  ),
};

/** **Selected** — a selected marker brightens to the front (depth level 1). */
export const Selected: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} label="event" selected />
    </Chart>
  ),
};

/** **Inert** — `selectable={false}` pins it at the back as background context. */
export const Inert: Story = {
  render: () => (
    <Chart>
      <Marker at={at(45)} label="context" selectable={false} />
    </Chart>
  ),
};

/** **Multiple** — several markers across the window, each auto-labelled. */
export const Multiple: Story = {
  render: () => (
    <Chart>
      <Marker at={at(20)} label="A" />
      <Marker at={at(45)} label="B" />
      <Marker at={at(70)} label="C" />
    </Chart>
  ),
};

/** **Off-plot** — an `at` outside the container's `range`: the line, chip, and
 *  (if set) axis-edge indicator pill are all off-screen, so nothing renders. A
 *  marker just past the visible window (rather than one still in range) makes
 *  the filtering obvious — this chart shows only the price line. */
export const OffPlot: Story = {
  render: () => (
    <Chart>
      <Marker at={RANGE[1] + 10 * STEP} label="future" indicator />
    </Chart>
  ),
};
