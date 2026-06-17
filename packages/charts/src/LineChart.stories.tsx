import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { LineChart } from './LineChart.js';

const N = 60;

/** A deterministic sine wave with a coast (gap) from index 25–31. */
function sineWithGap() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 25 && i < 32;
    rows.push([i, inGap ? undefined : 50 + 40 * Math.sin(i / 5)]);
  }
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

/** A flat constant series — exercises the `min === max` y-domain headroom. */
function flat() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) rows.push([i, 42]);
  return new TimeSeries({
    name: 'flat',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

const meta = {
  title: 'Charts/LineChart',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** Line with a gap — the coast must read as a break, not a drop to zero. */
export const WithGap: Story = {
  render: () => {
    const series = sineWithGap();
    return (
      <ChartContainer timeRange={[0, N - 1]} width={480}>
        <ChartRow height={200}>
          <LineChart series={series} column="v" />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** Flat line — sits mid-row thanks to the auto-domain's ±1 headroom. */
export const Flat: Story = {
  render: () => {
    const series = flat();
    return (
      <ChartContainer timeRange={[0, N - 1]} width={480}>
        <ChartRow height={200}>
          <LineChart series={series} column="v" stroke="#10b981" />
        </ChartRow>
      </ChartContainer>
    );
  },
};
