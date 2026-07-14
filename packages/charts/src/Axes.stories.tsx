import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { XAxis } from './XAxis.js';
import { YAxis } from './YAxis.js';
import { defaultTheme } from './theme.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * Axis behaviours, one per story, so we can eyeball each in isolation — the
 * reference gallery for the axis wave (labels, tick labels, sides, domains,
 * x-axis). Feature stories (suppress-extreme, nice/padded domain, tick
 * alignment, full-width x, full-bleed y) land here as those options ship.
 */
const N = 70;
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** Two numeric columns on different scales: `pct` ~0–1, `price` ~150–220. */
function demo() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      // deliberately non-round extent (~0.137–0.263) so auto-fit's `.nice()`
      // rounds outward with visible headroom — contrasts a tight explicit domain
      0.2 + 0.063 * Math.sin(i / 6),
      185 + 30 * Math.sin(i / 8),
    ]);
  }
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'pct', kind: 'number' },
      { name: 'price', kind: 'number' },
    ] as const,
    rows,
  });
}

const meta = {
  title: 'Axes',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const W = 560;

/** Left y-axis (the default side). */
export const LeftAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis id="pct" format=".0%" />
        <Layers>
          <LineChart series={demo()} column="pct" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** Right y-axis. */
export const RightAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis id="price" side="right" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** Dual axes — left + right, one series each, independent scales. */
export const DualAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <YAxis id="pct" side="left" format=".0%" />
        <YAxis id="price" side="right" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="pct" as="pct" axis="pct" />
          <LineChart
            series={demo()}
            column="price"
            as="secondary"
            axis="price"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Axis labels** — the rotated unit strip at the outer edge (`label`, falling
 * back to `id`). Shown left + right and with a long label, so the rotation,
 * placement, and gutter interaction are all visible. (This is the one to leave
 * notes on.)
 */
export const AxisLabels: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <YAxis
          id="pct"
          side="left"
          label="Implied volatility (%)"
          format=".0%"
        />
        <YAxis id="price" side="right" label="Price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="pct" as="pct" axis="pct" />
          <LineChart
            series={demo()}
            column="price"
            as="secondary"
            axis="price"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** Explicit `{ at, label }` ticks — drives both the labels and the gridlines. */
export const ExplicitTicks: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis
          id="pct"
          label="%"
          min={0.1}
          max={0.35}
          ticks={[
            { at: 0.1, label: 'low' },
            { at: 0.225, label: 'mid' },
            { at: 0.35, label: 'high' },
          ]}
        />
        <Layers>
          <LineChart series={demo()} column="pct" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Domain: auto-fit vs explicit.** Left auto-fits (d3 `.nice()` — round ticks
 * + headroom, so data doesn't touch the edge). Right is an explicit exact
 * `[min, max]` clamped tight to the data — its top/bottom labels (`0.263`,
 * `0.137`) sit **just inside** the row edge (clamped, not overflowing — the
 * F-charts-6 fix), rather than half-bleeding past it.
 */
export const DomainAutoVsExplicit: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis id="auto" side="left" format=".3f" />
        <YAxis id="tight" side="right" min={0.137} max={0.263} format=".3f" />
        <Layers>
          <LineChart series={demo()} column="pct" as="pct" axis="auto" />
          <LineChart series={demo()} column="pct" as="secondary" axis="tight" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Padded domain** (`pad`). Both axes use the same tight explicit
 * `[0.137, 0.263]`; the right adds `pad={0.15}` — 15% headroom each side, so
 * the line lifts off the edges without hand-computing rounder bounds.
 */
export const PaddedDomain: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis id="tight" side="left" min={0.137} max={0.263} format=".3f" />
        <YAxis
          id="padded"
          side="right"
          min={0.137}
          max={0.263}
          pad={0.15}
          format=".3f"
        />
        <Layers>
          <LineChart series={demo()} column="pct" as="pct" axis="tight" />
          <LineChart
            series={demo()}
            column="pct"
            as="secondary"
            axis="padded"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Suppress boundary labels** (`boundaryLabels={false}`). The right axis drops
 * the top & bottom numbers (the gridlines stay) — for stacked layouts where the
 * edge labels crowd the seam and you'd rather omit them than keep them.
 */
export const SuppressBoundaryLabels: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis id="all" side="left" format=".0%" />
        <YAxis id="trimmed" side="right" boundaryLabels={false} format=".0%" />
        <Layers>
          <LineChart series={demo()} column="pct" as="pct" axis="all" />
          <LineChart
            series={demo()}
            column="pct"
            as="secondary"
            axis="trimmed"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** X-axis on the bottom (default) with a label. */
export const XAxisBottom: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} showAxis={false} theme={docsTheme}>
      <ChartRow height={180}>
        <YAxis id="pct" format=".0%" />
        <Layers>
          <LineChart series={demo()} column="pct" axis="pct" />
        </Layers>
      </ChartRow>
      <XAxis label="Time" />
    </ChartContainer>
  ),
};

/** X-axis on top. */
export const XAxisTop: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} showAxis={false} theme={docsTheme}>
      <XAxis side="top" label="Time" />
      <ChartRow height={180}>
        <YAxis id="pct" format=".0%" />
        <Layers>
          <LineChart series={demo()} column="pct" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Top axis, right-aligned labels** — `side="top"` + `align="right"`: each
 *  label sits to the **right** of a tick that rises from the axis line to the
 *  label (label beside the tick, not under it). Checks the tick + label line up
 *  correctly when the axis is on top (the tick grows downward-from-top, the label
 *  offset flips to the top edge). */
export const XAxisTopRightAlign: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} showAxis={false} theme={docsTheme}>
      <XAxis side="top" align="right" />
      <ChartRow height={180}>
        <YAxis id="pct" format=".0%" />
        <Layers>
          <LineChart series={demo()} column="pct" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

function AlignExample({ align }: { align: 'auto' | 'center' | 'right' }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          font: '12px ui-monospace, monospace',
          color: '#64748b',
          marginBottom: 4,
        }}
      >
        align="{align}"
      </div>
      <ChartContainer
        range={RANGE}
        width={W}
        showAxis={false}
        theme={docsTheme}
      >
        <ChartRow height={120}>
          <YAxis id="pct" format=".0%" />
          <Layers>
            <LineChart series={demo()} column="pct" axis="pct" />
          </Layers>
        </ChartRow>
        <XAxis align={align} />
      </ChartContainer>
    </div>
  );
}

/**
 * **X-axis tick-label alignment.** `center` (the default) centres every label
 * on its tick; `auto` centres but end-anchors the first/last so they stay in
 * bounds; `right` drops a longer tick and sets the label to its right (for
 * dense / wide labels).
 */
export const XTickAlignment: Story = {
  render: () => (
    <div>
      <AlignExample align="center" />
      <AlignExample align="auto" />
      <AlignExample align="right" />
    </div>
  ),
};

/**
 * **Horizontal axis title** (`labelPlacement="top"`) — the label drawn
 * horizontally at the top of the axis, aligned to its side, instead of the
 * rotated strip. Best for short unit labels; pairs with an auto-fit / padded
 * domain so it has headroom above the top tick.
 */
export const HorizontalLabel: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis id="pct" label="IV %" labelPlacement="top" format=".0%" />
        <YAxis
          id="price"
          side="right"
          label="USD"
          labelPlacement="top"
          format="$,.0f"
        />
        <Layers>
          <LineChart series={demo()} column="pct" as="pct" axis="pct" />
          <LineChart
            series={demo()}
            column="price"
            as="secondary"
            axis="price"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Themeable axis title.** `theme.axis.title` overrides the rotated y-axis
 * title (and the x-axis label) typography — here a larger, coloured title.
 */
export const ThemedTitle: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      theme={{
        ...defaultTheme,
        axis: {
          ...defaultTheme.axis,
          title: { color: '#2563eb', size: 14, opacity: 1 },
        },
      }}
    >
      <ChartRow height={200}>
        <YAxis id="pct" label="Implied volatility" format=".0%" />
        <Layers>
          <LineChart series={demo()} column="pct" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
