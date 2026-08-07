import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Zone } from './annotations.js';
import { priceSeries, RANGE } from './story-data.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';
import type { ChartTheme } from './theme.js';

/**
 * `<Zone>` — a shaded **y-span**, the value-axis counterpart of `<Region>`.
 * These stories fan out its props: **bounds** (ordering, clamping, open-ended),
 * **edges**, **label** (+ side), **selection / depth**, **role** (the palette),
 * and the tiled **zone set** that is the primitive's reason for existing.
 *
 * The price line runs ~155–215, so the bands below are placed to straddle it.
 */
const W = 560;
const H = 220;

function Chart({
  children,
  theme = docsTheme,
}: {
  children: ReactNode;
  theme?: ChartTheme;
}) {
  return (
    <ChartContainer range={RANGE} width={W} theme={theme}>
      <ChartRow height={H}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          {children}
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" min={140} max={230} />
      </ChartRow>
    </ChartContainer>
  );
}

/**
 * A **semantic palette as a theme** — the discipline the primitive is built
 * around. Colour never appears at the call site; a band names a `role` and the
 * theme says what that role looks like. Swap this map and every zone set in the
 * app re-colours at once.
 */
const banded: ChartTheme = {
  ...docsTheme,
  annotation: {
    ...docsTheme.annotation!,
    roles: {
      low: { color: '#1f9d63', fillOpacity: 0.14 },
      mid: { color: '#c2a20f', fillOpacity: 0.14 },
      high: { color: '#d8733f', fillOpacity: 0.14 },
      extreme: { color: '#d8473f', fillOpacity: 0.14 },
    },
  },
};

const meta = {
  title: 'Annotations/Zone',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Default** — a band between two values. Inert background context: no
 *  boundary lines, no label, no pointer response. */
export const Default: Story = {
  render: () => (
    <Chart>
      <Zone from={160} to={190} axis="usd" />
    </Chart>
  ),
};

/** **Bounds order doesn't matter** — `from`/`to` are ordered internally, so a
 *  band written high-to-low is the same band. Identical to **Default**. */
export const ReversedBounds: Story = {
  render: () => (
    <Chart>
      <Zone from={190} to={160} axis="usd" />
    </Chart>
  ),
};

/** **Edges** — `edges` outlines the band's boundaries. Off by default because
 *  contiguous sets share every interior boundary; on, it suits an isolated
 *  band like a target range. */
export const Edges: Story = {
  render: () => (
    <Chart>
      <Zone from={160} to={190} axis="usd" edges />
    </Chart>
  ),
};

/** **Label** — a chip at the band's vertical centre. A zone never auto-labels
 *  its bounds (the y axis already shows them); the label is a *name*. */
export const Label: Story = {
  render: () => (
    <Chart>
      <Zone from={160} to={190} axis="usd" label="target" />
    </Chart>
  ),
};

/** **Label on the right** — `labelSide="right"`, for when the left edge is busy
 *  (or, as here, to sit under a right-hand axis). */
export const LabelSideRight: Story = {
  render: () => (
    <Chart>
      <Zone from={160} to={190} axis="usd" label="target" labelSide="right" />
    </Chart>
  ),
};

/** **Clamped** — a band running past the axis domain is cut at the plot edge
 *  rather than painting into the gutter, and the cut-off boundary draws no
 *  line even with `edges` on (only the real 200 edge shows). */
export const Clamped: Story = {
  render: () => (
    <Chart>
      <Zone from={200} to={400} axis="usd" edges label="over" />
    </Chart>
  ),
};

/** **Open-ended** — `to={Infinity}` is the honest spelling of a top band with no
 *  ceiling (AQI "Hazardous", a "critical and above" alert band). It reaches the
 *  plot edge and, having no real upper bound, draws no upper boundary. */
export const OpenEnded: Story = {
  render: () => (
    <Chart>
      <Zone from={205} to={Infinity} axis="usd" edges label="critical" />
    </Chart>
  ),
};

/** **Selectable** — opt in to hover + click-select. Off by default: a zone spans
 *  the full plot width, so an interactive one lights up whenever the pointer is
 *  anywhere at its height, and its hit area takes the plot's clicks. */
export const Selectable: Story = {
  render: () => (
    <Chart>
      <Zone from={160} to={190} axis="usd" label="hover me" selectable />
    </Chart>
  ),
};

/** **Selected** — a selected band comes forward (depth level 1): brighter fill
 *  than the inert **Default**. */
export const Selected: Story = {
  render: () => (
    <Chart>
      <Zone
        from={160}
        to={190}
        axis="usd"
        label="selected"
        selectable
        selected
      />
    </Chart>
  ),
};

/** **Role** — the band takes its colour from `theme.annotation.roles[role]`, not
 *  from a prop. Same geometry as **Default**, different register entry. */
export const Role: Story = {
  render: () => (
    <Chart theme={banded}>
      <Zone from={160} to={190} axis="usd" role="high" />
    </Chart>
  ),
};

/** **Unknown role** — falls back to the base annotation register rather than
 *  throwing or rendering invisibly. */
export const UnknownRole: Story = {
  render: () => (
    <Chart theme={banded}>
      <Zone from={160} to={190} axis="usd" role="nope" />
    </Chart>
  ),
};

/** **Zone set** — the thing the primitive exists for: contiguous bands tiling
 *  the value axis into a scale, with the data read *against* it. One `<Zone>`
 *  per band, mapped from a table; the top band is open-ended. */
export const ZoneSet: Story = {
  render: () => (
    <Chart theme={banded}>
      {[
        { role: 'low', from: 140, to: 170 },
        { role: 'mid', from: 170, to: 195 },
        { role: 'high', from: 195, to: 215 },
        { role: 'extreme', from: 215, to: Infinity },
      ].map((z) => (
        <Zone key={z.role} from={z.from} to={z.to} axis="usd" role={z.role} />
      ))}
    </Chart>
  ),
};

/** **Labelled zone set** — the same set with names. The chips sit at each band's
 *  centre, so they read as a legend down the axis. */
export const LabelledZoneSet: Story = {
  render: () => (
    <Chart theme={banded}>
      {[
        { role: 'low', from: 140, to: 170, label: 'calm' },
        { role: 'mid', from: 170, to: 195, label: 'normal' },
        { role: 'high', from: 195, to: 215, label: 'elevated' },
        { role: 'extreme', from: 215, to: Infinity, label: 'critical' },
      ].map((z) => (
        <Zone
          key={z.role}
          from={z.from}
          to={z.to}
          axis="usd"
          role={z.role}
          label={z.label}
        />
      ))}
    </Chart>
  ),
};

/** **Dual axis** — a zone is scaled by the axis it names, so on a two-axis row
 *  the band lands in the units it belongs to. Here the same 0–40 band is drawn
 *  against the right-hand `pct` axis while the price line keeps the left. */
export const DualAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={banded}>
      <ChartRow height={H}>
        <YAxis id="usd" side="left" format=",.0f" min={140} max={230} />
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Zone from={0} to={40} axis="pct" role="low" label="0–40%" />
        </Layers>
        <YAxis id="pct" side="right" format=",.0f" min={0} max={100} />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Dashed boundaries** — `annotation.dash` (or a role's `dash`) dashes every
 *  line in the register, so an outlined band reads as placed rather than
 *  measured. Fills are never dashed. */
export const DashedEdges: Story = {
  render: () => (
    <Chart
      theme={{
        ...banded,
        annotation: { ...banded.annotation!, dash: [6, 4] },
      }}
    >
      <Zone from={160} to={190} axis="usd" role="mid" edges label="target" />
    </Chart>
  ),
};
