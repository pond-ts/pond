import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';

const N = 60;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step, so the time axis
 *  shows wall-clock labels and the visual baselines stay deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** A deterministic sine series for layout fixtures. */
function demo(phase = 0, amp = 40, mid = 50) {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1)
    rows.push([BASE + i * STEP, mid + amp * Math.sin(i / 5 + phase)]);
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

/**
 * Stories for the layout system (`ChartContainer` / `ChartRow` / `YAxis` /
 * `Layers`) rather than a single chart's data. They double as the visual
 * baselines for the row + axis layout, and grow as features land (dual-axis,
 * estela-shaped — M2.4).
 */
const meta = {
  title: 'Layout',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** Baseline: one row, no axis — the plot fills the full container width. */
export const SingleRow: Story = {
  render: () => {
    const series = demo();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={520}>
        <ChartRow height={200}>
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * One left y-axis: the gutter reserves space, the plot shrinks, and ticks read
 * the row's scale. The line names no `axis`, so it binds to the first (default)
 * axis.
 */
export const LeftAxis: Story = {
  render: () => {
    const series = demo();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={520}>
        <ChartRow height={200}>
          <YAxis id="value" label="v" />
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * Two y-axes with independent scales — a left axis and a right one (authored
 * *after* `<Layers>`). Each line links to its own axis via `axis="…"`, so the
 * two series share the time axis but read different y-domains. `as="secondary"`
 * gives the right-axis line its own colour — style (`as`) and scale (`axis`)
 * are separate.
 */
export const DualAxis: Story = {
  render: () => {
    const temp = demo(0, 8, 20); // ~12–28
    const humidity = demo(2, 28, 58); // ~30–86
    return (
      <ChartContainer timeRange={TIME_RANGE} width={560}>
        <ChartRow height={220}>
          <YAxis id="temp" label="°C" />
          <Layers>
            <LineChart series={temp} column="v" axis="temp" />
            <LineChart
              series={humidity}
              column="v"
              axis="humidity"
              as="secondary"
            />
          </Layers>
          <YAxis id="humidity" side="right" label="%" />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * Three stacked rows on one shared time axis — the canonical dashboard. Each row
 * auto-fits its own y-scale; the single time axis is drawn once at the bottom.
 */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer timeRange={TIME_RANGE} width={520}>
      <ChartRow height={120}>
        <YAxis id="a" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="b" label="v" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="secondary" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="c" label="v" />
        <Layers>
          <LineChart series={demo(3)} column="v" as="context" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * Rows with different gutters still left-align: the top row has a y-axis, the
 * bottom has none, yet both plots start at the same x (and under the time axis)
 * because the container reserves a *uniform* gutter and the axis-less row pads
 * with a spacer.
 */
export const VaryingGutters: Story = {
  render: () => (
    <ChartContainer timeRange={TIME_RANGE} width={520}>
      <ChartRow height={130}>
        <YAxis id="withAxis" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={130}>
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="context" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * The estela shape on `estelaTheme`: a dual-axis activity chart — power (left,
 * `foam`) + heart rate (right, `coral`) — on estela's dark ground with dashed
 * gridlines. The whole look comes from swapping `theme={estelaTheme}`; the
 * chart markup is identical to {@link DualAxis}. This is the "drop-in for
 * estela" proof for M2 (the variance band + elevation `teal` underlay land in
 * M3).
 */
export const EstelaShaped: Story = {
  render: () => {
    const power = demo(0, 60, 220); // ~160–280 W
    const hr = demo(0.8, 22, 150); // ~128–172 bpm
    return (
      <ChartContainer timeRange={TIME_RANGE} width={560} theme={estelaTheme}>
        <ChartRow height={220}>
          <YAxis id="power" label="W" />
          <Layers>
            <LineChart series={power} column="v" axis="power" as="foam" />
            <LineChart series={hr} column="v" axis="hr" as="coral" />
          </Layers>
          <YAxis id="hr" side="right" label="bpm" />
        </ChartRow>
      </ChartContainer>
    );
  },
};
