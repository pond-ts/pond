import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Baseline } from './annotations.js';
import { priceSeries, RANGE } from './story-data.fixture.js';
import { LineCursor } from './cursors.js';
import { defaultTheme, type ChartTheme } from './theme.js';

/**
 * `<Baseline>` — a horizontal value line on a chart, in the amber annotation
 * register. These stories fan out its props one axis at a time: **label**
 * (auto / custom / off), the **indicator** axis-pill opt-in, **selection /
 * depth**, **line width**, **dual-axis** binding, and a level **panned off**
 * the y range. Interaction demos (drag-to-edit, create) live under
 * **Annotations/Scenarios**.
 */
const W = 560;
const H = 220;

/** One price row with a right-hand USD axis; children are the annotation(s).
 *  `theme` is for the stories whose subject is a theme role. */
function Chart({
  children,
  theme,
}: {
  children: ReactNode;
  theme?: ChartTheme;
}) {
  return (
    <ChartContainer range={RANGE} width={W} {...(theme ? { theme } : {})}>
      <LineCursor />
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
  title: 'Annotations/Baseline',
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

/** **Inert, strong** — an inert line rests at the role's level-3 alpha, so
 *  `role="argument"` (shipped in the built-in themes, ramp `[1, 0.95, 0.85]`)
 *  draws one reference line at 0.85 while the plain inert line beside it, and
 *  every other mark, keeps the register's 0.4. No `depth` change needed. */
export const InertStrong: Story = {
  render: () => (
    <Chart>
      <Baseline
        value={200}
        axis="usd"
        label="argument"
        role="argument"
        selectable={false}
      />
      <Baseline value={180} axis="usd" label="plain" selectable={false} />
    </Chart>
  ),
};

/** A theme that adds one `reference` role with its own near-full ramp; the
 *  register's `[1, 0.7, 0.4]` is untouched. */
const referenceTheme: ChartTheme = {
  ...defaultTheme,
  annotation: {
    ...defaultTheme.annotation!,
    roles: {
      ...defaultTheme.annotation!.roles,
      reference: { depth: [1, 0.85, 0.8] },
    },
  },
};

/** **Inert, custom role** — the same idea with a host's own role
 *  (`reference: { depth: [1, 0.85, 0.8] }`): the inert `reference` line draws
 *  at 0.8, the plain inert line and the selectable one stay on the base ramp.
 *  Themed on purpose — the role lives in the theme. */
export const InertCustomRole: Story = {
  render: () => (
    <Chart theme={referenceTheme}>
      <Baseline
        value={200}
        axis="usd"
        label="reference"
        role="reference"
        selectable={false}
      />
      <Baseline value={180} axis="usd" label="plain" selectable={false} />
      <Baseline value={160} axis="usd" label="selectable" />
    </Chart>
  ),
};

/** **Line width** — `lineWidth` sets the stroke in px: the default 1px line
 *  (`200`) against a 3px one (`180`). A theme role can set the same field
 *  (`annotation.roles[role].lineWidth`); the prop wins over it. */
export const LineWidth: Story = {
  render: () => (
    <Chart>
      <Baseline value={200} axis="usd" label="1px" />
      <Baseline value={180} axis="usd" label="3px" lineWidth={3} />
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
      <LineCursor />
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

/** **Domain extreme** — a baseline `value` at the axis's `max`: the line sits
 *  on the top edge, and the `indicator` pill (showing the value) and the label
 *  chip clamp inside the row (like the y-tick labels), instead of overflowing
 *  above the plot. Past the `max` the line and label are hidden, but the pill
 *  stays pinned at the edge (see {@link PannedOff}). */
export const DomainExtreme: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <LineCursor />
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

/** A 40-unit y window the slider pans across the price range. */
function PannedOffDemo() {
  const [min, setMin] = useState(170);
  return (
    <div>
      <ChartContainer range={RANGE} width={W}>
        <LineCursor />
        <ChartRow height={H}>
          <Layers>
            <LineChart series={priceSeries()} column="price" axis="usd" />
            <Baseline value={205} axis="usd" label="resistance" />
            <Baseline value={165} axis="usd" label="support" />
          </Layers>
          <YAxis id="usd" side="right" min={min} max={min + 40} format=",.0f" />
        </ChartRow>
      </ChartContainer>
      <label style={{ display: 'block', font: '12px sans-serif' }}>
        y window {min}–{min + 40}{' '}
        <input
          type="range"
          min={140}
          max={190}
          value={min}
          onChange={(e) => setMin(Number(e.target.value))}
        />
      </label>
    </div>
  );
}

/** **Panned off** — slide the y window: a baseline whose level leaves the
 *  visible range draws neither its line nor its label (no chip floating
 *  outside the row), and both come back when the level returns. At the
 *  start `support` (165) is below the window and hidden. A label near an edge
 *  stops at the edge rather than riding out of the row. */
export const PannedOff: Story = {
  render: () => <PannedOffDemo />,
};
