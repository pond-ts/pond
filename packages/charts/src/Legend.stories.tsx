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
import { useChartLegend } from './useChartLegend.js';
import { YAxis } from './YAxis.js';
import type { SelectInfo } from './context.js';
import { twoSeries, hrSeries, RANGE } from './story-data.fixture.js';
import { defaultTheme } from './theme.js';

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
 *  stack order, each with the group's resolved fill (`colors` gives the two
 *  segments distinct fills, so the two rows read as two things). */
export const StackedBarGroups: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={200}>
        <YAxis id="v" min={0} max={500} />
        <Layers>
          <BarChart
            series={s}
            columns={['fast', 'slow']}
            colors={{ fast: '#3b82f6', slow: '#f59e0b' }}
            axis="v"
          />
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

/** **Scoped to a row** — a `<Legend>` placed *inside* a `<Layers>` lists only
 *  that `<ChartRow>`'s layers and anchors to that row's plot (a per-row key
 *  needs no prop, just placement). Here each row keys its own series. */
export const ScopedPerRow: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={130}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="v" />
          <LineChart series={s} column="slow" as="slow" axis="v" />
          <Legend placement="top-right" />
        </Layers>
      </ChartRow>
      <ChartRow height={130}>
        <YAxis id="h" min={100} max={180} />
        <Layers>
          <LineChart series={hrSeries()} column="bpm" as="bpm" axis="h" />
          <Legend placement="top-right" />
        </Layers>
      </ChartRow>
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

/** **Id-gated interactions** — both scatters carry an `id`, so their rows
 *  hover (echo into the container's `hovered` channel) and **click toggles
 *  the selection**: click `fast`, then `slow`, and the series-coloured accent
 *  + bold visibly MOVE between rows (the readout below mirrors `onSelect`).
 *  The `bpm` line has no `id` — its row is inert. */
export const InteractiveSelect: Story = {
  render: function InteractiveSelectStory() {
    const [sel, setSel] = useState<SelectInfo | null>(null);
    return (
      <div>
        <ChartContainer range={RANGE} width={W} onSelect={setSel}>
          <ChartRow height={200}>
            <YAxis id="v" min={100} max={230} />
            <Layers>
              <ScatterChart
                series={s}
                column="fast"
                id="fast"
                as="fast"
                axis="v"
              />
              <ScatterChart
                series={s}
                column="slow"
                id="slow"
                as="slow"
                axis="v"
              />
              <LineChart series={hrSeries()} column="bpm" as="bpm" axis="v" />
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

/** **Headless — `useChartLegend()`** — the same rows + sync as data, rendered
 *  by the consumer: a **horizontal chip row above the plot** (a common layout
 *  the card deliberately isn't), left-aligned to the plot via the hook's
 *  `gutters`, with unselected series dimmed once a selection exists (the
 *  ticker-compare treatment). Each chip shows its **current-or-cursor
 *  value** — the hook's `cursorTime` (else the latest sample) looked up in
 *  the consumer's own series, the estela/Tidal readout-in-the-legend
 *  pattern. The two series carry distinct theme roles (blue / amber), and
 *  the chips inherit the resolved colours — no palette sharing. Click a chip
 *  to toggle selection; hover the plot to see the values track the cursor. */
export const HeadlessCustomLegend: Story = {
  render: function HeadlessCustomLegendStory() {
    function ChipRow() {
      const { rows, gutters, cursorTime, hover, select } = useChartLegend();
      // One chart row here → flatten the groups to a flat chip list.
      const items = rows.flatMap((r) => r.items);
      const anySelected = items.some((it) => it.selected);
      const dotColor = (item: (typeof items)[number]): string =>
        item.swatch.kind === 'line' || item.swatch.kind === 'scatter'
          ? item.swatch.color
          : item.swatch.kind === 'bar' || item.swatch.kind === 'band'
            ? item.swatch.fill
            : '#999';
      // Current-or-cursor value: the hook hands the cursor instant (null when
      // not hovering); the consumer owns the series, so the lookup is theirs.
      // This story's item ids are its column names.
      const valueOf = (item: (typeof items)[number]): number | undefined => {
        if (item.id !== 'fast' && item.id !== 'slow') return undefined;
        const e = cursorTime !== null ? s.nearest(cursorTime) : s.last();
        return e?.get(item.id);
      };
      return (
        <div
          style={{
            display: 'flex',
            gap: 8,
            // Align the chips with the PLOT, not the chart box — the hook
            // hands over the axis gutters for exactly this.
            padding: `0 ${gutters.right + 4}px 8px ${gutters.left + 4}px`,
          }}
        >
          {items.map((item) => {
            const v = valueOf(item);
            return (
              <button
                key={
                  item.id !== undefined
                    ? `${item.id} ${item.label}`
                    : item.label
                }
                onPointerEnter={() => hover(item)}
                onPointerLeave={() => hover(null)}
                onClick={() => select(item)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  font: '12px system-ui',
                  padding: '3px 10px',
                  borderRadius: 999,
                  border: `1px solid ${
                    item.selected ? dotColor(item) : '#e2e8f0'
                  }`,
                  background: item.selected ? '#eff6ff' : '#ffffff',
                  color: '#475569',
                  cursor: item.id !== undefined ? 'pointer' : 'default',
                  opacity: anySelected && !item.selected ? 0.45 : 1,
                  fontWeight: item.selected ? 600 : 400,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: dotColor(item),
                  }}
                />
                {item.label}
                {v !== undefined && (
                  <span style={{ color: '#94a3b8' }}>{v.toFixed(1)}</span>
                )}
              </button>
            );
          })}
        </div>
      );
    }
    // Distinct theme roles per series (the one styling channel): `slow` gets
    // an amber scatter style; the chips inherit both resolved colours.
    const theme = {
      ...defaultTheme,
      scatter: {
        ...defaultTheme.scatter,
        slow: { ...defaultTheme.scatter.default, color: '#f59e0b' },
      },
    };
    return (
      <ChartContainer range={RANGE} width={W} theme={theme}>
        {/* Declared before the row ⇒ the chips sit ABOVE the plot. */}
        <ChipRow />
        <ChartRow height={200}>
          <YAxis id="v" min={140} max={230} />
          <Layers>
            <ScatterChart
              series={s}
              column="fast"
              id="fast"
              as="fast"
              axis="v"
            />
            <ScatterChart
              series={s}
              column="slow"
              id="slow"
              as="slow"
              axis="v"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
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
