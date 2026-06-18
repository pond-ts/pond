import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BandChart } from './BandChart.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';

const N = 60;
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/**
 * A percentile fan: a sine centerline (`p50`) with a spread that widens toward
 * the middle of the window — the shape of a real variance envelope. Columns are
 * the percentiles a `rollingByColumn` pass would produce.
 */
function variance() {
  const rows: Array<[number, number, number, number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const mid = 50 + 22 * Math.sin(i / 8);
    const spread = 4 + 28 * Math.sin((i / (N - 1)) * Math.PI); // 4 → 32 → 4
    rows.push([
      BASE + i * STEP,
      mid - spread, // p5
      mid - spread / 2, // p25
      mid, // p50
      mid + spread / 2, // p75
      mid + spread, // p95
    ]);
  }
  return new TimeSeries({
    name: 'variance',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'p5', kind: 'number' },
      { name: 'p25', kind: 'number' },
      { name: 'p50', kind: 'number' },
      { name: 'p75', kind: 'number' },
      { name: 'p95', kind: 'number' },
    ] as const,
    rows,
  });
}

/** A single band with a coast (gap) from index 25–31 — the fill must break. */
function bandWithGap() {
  const rows: Array<[number, number | undefined, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 25 && i < 32;
    const mid = 50 + 20 * Math.sin(i / 7);
    rows.push([
      BASE + i * STEP,
      inGap ? undefined : mid - 10,
      inGap ? undefined : mid + 10,
    ]);
  }
  return new TimeSeries({
    name: 'gap',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'lo', kind: 'number', required: false },
      { name: 'hi', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

const meta = {
  title: 'Charts/BandChart',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * The estela signature: a two-tone variance underlay. Two bands compose in the
 * z-stack — `outer` (p5/p95, wide + faint) behind `inner` (p25/p75, tighter +
 * stronger) — with the `p50` centerline on top. Authored back-to-front; the
 * order-stable registry keeps the stack honest.
 */
export const TwoTone: Story = {
  render: () => {
    const v = variance();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={560} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="v" label="v" min={0} max={100} />
          <Layers>
            <BandChart series={v} lower="p5" upper="p95" as="outer" />
            <BandChart series={v} lower="p25" upper="p75" as="inner" />
            <LineChart series={v} column="p50" as="foam" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A single band that breaks at a coast — the envelope must not bridge the gap. */
export const WithGap: Story = {
  render: () => {
    const g = bandWithGap();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={480}>
        <ChartRow height={200}>
          <YAxis id="v" label="v" min={0} max={100} />
          <Layers>
            <BandChart series={g} lower="lo" upper="hi" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
