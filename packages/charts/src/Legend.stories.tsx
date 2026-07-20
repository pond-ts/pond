import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { AreaChart } from './AreaChart.js';
import { BandChart } from './BandChart.js';
import { ScatterChart } from './ScatterChart.js';
import { BarChart } from './BarChart.js';
import { Legend } from './Legend.js';
import { YAxis } from './YAxis.js';
import type { SelectInfo } from './context.js';
import { twoSeries, hrSeries, RANGE } from './story-data.fixture.js';

/**
 * `<Legend>` — the series key, rendered from the layers' own registrations:
 * each draw layer registers its readout identity (`as ?? column`) and its
 * **resolved** style as a swatch, so the key can never drift from the plot.
 * Rows follow chart-row → declaration order; two layers sharing an identity
 * collapse to one row; `legend={false}` opts a layer out and
 * `legend="name"` renames its row. Interactions are id-gated (the selection
 * contract): rows whose layer has an `id` echo hover + toggle selection.
 */
const W = 620;
const s = twoSeries();

const meta = {
  title: 'Legend',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Zero config** — `<Legend />` enumerates the registered layers in
 *  declaration order, one row per series, anchored top-right. */
export const Default: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={200}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="v" />
          <LineChart series={s} column="slow" as="slow" axis="v" />
        </Layers>
      </ChartRow>
      <Legend />
    </ChartContainer>
  ),
};

/** **Swatches are resolved styles** — a line, an area, a band, and a scatter
 *  each register their own mark vocabulary: stroke+dash, outline over fill,
 *  translucent envelope, dot. */
export const MixedMarkSwatches: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <YAxis id="v" min={120} max={240} />
        <Layers>
          <BandChart
            series={s}
            lower="slow"
            upper="fast"
            as="spread"
            axis="v"
          />
          <AreaChart series={hrSeries()} column="bpm" as="bpm" axis="v" />
          <LineChart series={s} column="fast" as="fast" axis="v" />
          <ScatterChart series={s} column="slow" as="slow" axis="v" />
        </Layers>
      </ChartRow>
      <Legend />
    </ChartContainer>
  ),
};

/** **Stacked bars** — a multi-group layer registers **one row per group** in
 *  stack order, each with the group's resolved fill. */
export const StackedBarGroups: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={200}>
        <YAxis id="v" min={0} max={500} />
        <Layers>
          <BarChart series={s} columns={['fast', 'slow']} axis="v" />
        </Layers>
      </ChartRow>
      <Legend />
    </ChartContainer>
  ),
};

/** **`placement="top-left"`** — the other corners below. */
export const PlacementTopLeft: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={180}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="v" />
        </Layers>
      </ChartRow>
      <Legend placement="top-left" />
    </ChartContainer>
  ),
};

/** **`placement="bottom-left"`**. */
export const PlacementBottomLeft: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={180}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="v" />
        </Layers>
      </ChartRow>
      <Legend placement="bottom-left" />
    </ChartContainer>
  ),
};

/** **`placement="bottom-right"`**. */
export const PlacementBottomRight: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={180}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="v" />
        </Layers>
      </ChartRow>
      <Legend placement="bottom-right" />
    </ChartContainer>
  ),
};

/** **`legend={false}` opts a layer out** — the slow line draws but has no
 *  row; **`legend="name"` renames** — the fast line reads "Fast (bpm)". */
export const OptOutAndRename: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={200}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart
            series={s}
            column="fast"
            as="fast"
            axis="v"
            legend="Fast (bpm)"
          />
          <LineChart
            series={s}
            column="slow"
            as="slow"
            axis="v"
            legend={false}
          />
        </Layers>
      </ChartRow>
      <Legend />
    </ChartContainer>
  ),
};

/** **Dedup by identity** — two layers sharing `as="pair"` (a line and its
 *  scatter overlay) collapse to one row, exactly as the tracker readout
 *  merges keys. */
export const DedupSharedIdentity: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={200}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" as="pair" axis="v" />
          <ScatterChart series={s} column="fast" as="pair" axis="v" />
        </Layers>
      </ChartRow>
      <Legend />
    </ChartContainer>
  ),
};

/** **Rows follow chart rows** — a two-row chart lists the top row's series
 *  first, then the bottom row's. */
export const MultiRowOrder: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={140}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={140}>
        <YAxis id="h" min={100} max={180} />
        <Layers>
          <LineChart series={hrSeries()} column="bpm" as="bpm" axis="h" />
        </Layers>
      </ChartRow>
      <Legend />
    </ChartContainer>
  ),
};

/** **Id-gated interactions** — the scatter carries `id="dots"`, so its row
 *  hovers (echoes into the container's `hovered` channel) and **click toggles
 *  the selection** (the selected row reads emphasized; the readout below
 *  mirrors `onSelect`). The line has no `id` — its row is inert. */
export const InteractiveSelect: Story = {
  render: function InteractiveSelectStory() {
    const [sel, setSel] = useState<SelectInfo | null>(null);
    return (
      <div>
        <ChartContainer range={RANGE} width={W} onSelect={setSel}>
          <ChartRow height={200}>
            <YAxis id="v" min={140} max={230} />
            <Layers>
              <ScatterChart
                series={s}
                column="fast"
                id="dots"
                as="dots"
                axis="v"
              />
              <LineChart series={s} column="slow" as="slow" axis="v" />
            </Layers>
          </ChartRow>
          <Legend />
        </ChartContainer>
        <div style={{ font: '12px system-ui', marginTop: 8 }}>
          selected: {sel === null ? '(none)' : sel.id}
        </div>
      </div>
    );
  },
};

/** **`items` escape hatch, standalone** — explicit rows rendered outside any
 *  container (a dashboard-side key): the consumer supplies resolved swatches
 *  and places the card in normal flow. */
export const StandaloneItems: Story = {
  render: () => (
    <Legend
      items={[
        {
          label: 'observed',
          swatch: { kind: 'line', color: '#2563eb', width: 2 },
        },
        {
          label: 'forecast',
          swatch: { kind: 'line', color: '#64748b', width: 2, dash: [6, 4] },
        },
        { label: 'volume', swatch: { kind: 'bar', fill: '#93c5fd' } },
      ]}
    />
  ),
};
