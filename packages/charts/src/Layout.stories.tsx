import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';

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
