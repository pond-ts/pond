import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { AreaChart } from './AreaChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';

const N = 60;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step, so the time axis
 *  shows wall-clock labels and the visual baselines stay deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/**
 * An elevation profile: a positive-only sine rolling between ~120 and ~480 m,
 * with a coast (gap) from index 25–31 so the fill + outline must break. The
 * elevation form rests on the axis floor and grades down from the line.
 */
function elevation() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 25 && i < 32;
    const v = 300 + 180 * Math.sin(i / 9);
    rows.push([BASE + i * STEP, inGap ? undefined : v]);
  }
  return new TimeSeries({
    name: 'elevation',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'elev', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

/**
 * Signed network traffic: an `in` channel (positive — bytes received) and an
 * `out` channel (negative — bytes sent), both centred on the zero axis. Each is
 * its own column so the two compose as two `<AreaChart>`s with distinct `as`
 * roles (the esnet "in above / out below" look). `out` is stored negative so it
 * fills downward from the baseline.
 */
function traffic() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const inbound = 40 + 30 * Math.sin(i / 7) + 8 * Math.sin(i * 1.3);
    const outbound = 25 + 18 * Math.sin(i / 6 + 1) + 6 * Math.sin(i * 1.1);
    rows.push([BASE + i * STEP, inbound, -outbound]);
  }
  return new TimeSeries({
    name: 'traffic',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'in', kind: 'number' },
      { name: 'out', kind: 'number' },
    ] as const,
    rows,
  });
}

const meta = {
  title: 'Charts/AreaChart',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * The elevation form (driver: estela elevation). One `<AreaChart>` with no
 * `baseline` rests on the axis floor; the graded shade fades from the brand-teal
 * outline down to the bottom. The coast reads as a break in both the fill and
 * the outline — never a bridge to the floor.
 */
export const Elevation: Story = {
  render: () => {
    const e = elevation();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={560} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="m" label="m" />
          <Layers>
            <AreaChart series={e} column="elev" as="default" curve="monotone" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * The above/below-axis form (driver: esnet traffic). Two `<AreaChart>`s share a
 * fixed `baseline={0}`: `in` (teal) fills up, `out` (warm filament, stored
 * negative) fills down. Each side's shade fades toward the zero axis. Two layers
 * + two `as` roles — the single styling channel, composed (no per-component
 * colour). The y-axis includes 0 because the fixed baseline is pulled into the
 * domain.
 */
export const AboveBelowAxis: Story = {
  render: () => {
    const t = traffic();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={560} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="mbps" label="Mb/s" />
          <Layers>
            <AreaChart series={t} column="in" baseline={0} as="in" />
            <AreaChart series={t} column="out" baseline={0} as="out" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
