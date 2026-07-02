import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Baseline } from './annotations.js';
import { priceSeries, RANGE } from './story-data.fixture.js';

/**
 * `<Baseline>` — a horizontal value line on a chart, in the turquoise annotation
 * register. These stories fan out its props one axis at a time: **label**
 * (auto / custom / off), the **indicator** axis-pill opt-in, **selection /
 * depth**, and **dual-axis** binding. Interaction demos (drag-to-edit, create)
 * live under **Annotations/Scenarios**.
 */
const W = 560;
const H = 220;

/** One price row with a right-hand USD axis; children are the annotation(s). */
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
  title: 'Charts/Annotations/Baseline',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Default** — no `label`, so the chip auto-labels with the axis-formatted
 *  value (`200`), anchored at the line's left. */
export const Default: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" />
    </Chart>
  ),
};

/** **Custom label** — a `label` string replaces the auto value chip. */
export const CustomLabel: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" label="resistance" />
    </Chart>
  ),
};

/** **No label** — `label={false}` draws the line with no chip at all. */
export const NoLabel: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" label={false} />
    </Chart>
  ),
};

/** **Label side** — `labelSide="right"` anchors the near-line chip to the right
 *  edge instead of the default left. */
export const LabelRight: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" label="resistance" labelSide="right" />
    </Chart>
  ),
};

/** **Label position** — `labelPosition="above"` sits the chip on top of the line
 *  (vs the default `center`, which rides on it). */
export const LabelAbove: Story = {
  render: () => (
    <Chart>
      <Baseline
        value={200}
        axis="usd"
        label="resistance"
        labelPosition="above"
      />
    </Chart>
  ),
};

/** **Indicator** — `indicator` also pins the value to the y-axis as an on-axis
 *  pill (the ChartIQ price-tag look), alongside the near-line chip. */
export const Indicator: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" indicator />
    </Chart>
  ),
};

/** **Indicator only** — `indicator` + `label={false}`: the axis pill (showing
 *  the value) with no in-plot chip. */
export const IndicatorOnly: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" indicator label={false} />
    </Chart>
  ),
};

/** **Indicator + label** — the near-line chip shows the custom label
 *  ("resistance"); the axis pill still shows the **value** (`200`). An indicator
 *  is always the axis coordinate — the label never moves to the axis. */
export const IndicatorWithLabel: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" indicator label="resistance" />
    </Chart>
  ),
};

/** **Selected** — a selected baseline brightens to the front (depth level 1). */
export const Selected: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" label="target" selected />
    </Chart>
  ),
};

/** **Inert** — `selectable={false}` pins it at the back (level 3) as background
 *  context: no hover, no select, dimmest. */
export const Inert: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" label="context" selectable={false} />
    </Chart>
  ),
};

/** **Multiple** — several baselines (a band of levels) on one axis. */
export const Multiple: Story = {
  render: () => (
    <Chart>
      <Baseline value={210} axis="usd" label="high" />
      <Baseline value={185} axis="usd" label="mid" selectable={false} />
      <Baseline value={160} axis="usd" label="low" />
    </Chart>
  ),
};

/** **Dual axis** — a baseline bound to the left axis and one to the right, each
 *  `indicator` pill on its own axis showing that axis's **value** (in its own
 *  units — USD vs %). */
export const DualAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={H}>
        <YAxis id="usd" side="left" min={150} max={220} format=",.0f" />
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Baseline value={205} axis="usd" indicator />
          <Baseline value={40} axis="pct" indicator />
        </Layers>
        <YAxis id="pct" side="right" min={0} max={100} format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Domain extreme** — a baseline `value` at (past) the axis's `max`: the
 *  `indicator` pill (showing the value) clamps inside the row (like the y-tick
 *  labels), instead of overflowing above the plot. */
export const DomainExtreme: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={H}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Baseline value={220} axis="usd" indicator />
        </Layers>
        <YAxis id="usd" side="right" min={150} max={220} format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};
