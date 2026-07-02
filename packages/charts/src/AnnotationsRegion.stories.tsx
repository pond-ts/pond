import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Region } from './annotations.js';
import { priceSeries, BASE, STEP, RANGE } from './story-data.fixture.js';

/**
 * `<Region>` — a shaded x-span, in the turquoise annotation register. These
 * stories fan out its props: **label** (auto `from–to` / custom / off),
 * **selection / depth**, and **multiple** spans. Drag-to-move / resize-edges /
 * create live under **Annotations/Scenarios**.
 */
const W = 560;
const H = 220;
const at = (i: number) => BASE + i * STEP;

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
  title: 'Charts/Annotations/Region',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Default** — no `label`, so the chip auto-labels the `from–to` span. */
export const Default: Story = {
  render: () => (
    <Chart>
      <Region from={at(30)} to={at(55)} />
    </Chart>
  ),
};

/** **Custom label** — a `label` string replaces the auto span chip. */
export const CustomLabel: Story = {
  render: () => (
    <Chart>
      <Region from={at(30)} to={at(55)} label="session" />
    </Chart>
  ),
};

/** **No label** — `label={false}` shades the span with no chip. */
export const NoLabel: Story = {
  render: () => (
    <Chart>
      <Region from={at(30)} to={at(55)} label={false} />
    </Chart>
  ),
};

/** **No outlines** — `edges={false}` drops the vertical side lines, leaving just
 *  the shaded fill — a soft highlight band. */
export const NoOutlines: Story = {
  render: () => (
    <Chart>
      <Region from={at(30)} to={at(55)} label="soft" edges={false} />
    </Chart>
  ),
};

/** **Selected** — a selected region brightens to the front (level 1); its edges
 *  read as the grabbable thing in edit mode. */
export const Selected: Story = {
  render: () => (
    <Chart>
      <Region from={at(30)} to={at(55)} label="session" selected />
    </Chart>
  ),
};

/** **Inert** — `selectable={false}` pins it at the back as background context
 *  (e.g. a shaded "closed" window the data just reads through). */
export const Inert: Story = {
  render: () => (
    <Chart>
      <Region from={at(30)} to={at(55)} label="closed" selectable={false} />
    </Chart>
  ),
};

/** **Multiple** — adjacent spans (zones) across the window. */
export const Multiple: Story = {
  render: () => (
    <Chart>
      <Region from={at(8)} to={at(24)} label="warmup" selectable={false} />
      <Region from={at(30)} to={at(55)} label="work" />
      <Region from={at(62)} to={at(80)} label="cooldown" selectable={false} />
    </Chart>
  ),
};

/** **Narrow vs wide** — a few-minute blip next to a span covering most of the
 *  window; the fill and edges hold up at both extremes. */
export const NarrowAndWide: Story = {
  render: () => (
    <Chart>
      <Region from={at(10)} to={at(13)} label="blip" />
      <Region from={at(20)} to={at(85)} label="wide" selectable={false} />
    </Chart>
  ),
};
