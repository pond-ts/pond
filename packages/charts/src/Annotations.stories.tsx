import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Region } from './annotations.js';
import { Baseline } from './annotations.js';
import { Marker } from './annotations.js';
import { estelaTheme } from './theme.js';

/** A 40-minute interval on a 1-minute grid (5:00–5:40), so the x is wall-clock. */
const BASE = Date.UTC(2026, 0, 1, 5, 0, 0);
const STEP = 60_000;
const N = 41;
const INTERVAL: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** A wavy power trace (W) over the interval — the foam (data) line. */
function power() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      165 + 60 * Math.sin(i / 3) + 22 * Math.sin(i * 1.4),
    ]);
  }
  return new TimeSeries({
    name: 'power',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'watts', kind: 'number' },
    ] as const,
    rows,
  });
}

/** HR re-keyed onto cumulative distance (metres) — drives the value-axis variant. */
function rideByDistance() {
  const rows: Array<[number, number, number]> = [];
  let cum = 0;
  for (let i = 0; i < 50; i += 1) {
    cum += 90 + 40 * Math.sin(i / 6);
    rows.push([BASE + i * STEP, cum, 140 + 28 * Math.sin(i / 7)]);
  }
  return new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cumDist', kind: 'number' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows,
  }).byValue('cumDist');
}

const meta = {
  title: 'Charts/Annotations',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * **In context** — the data stays **foam** (white), the marks you place are
 * **turquoise**: a selected `<Region>` (5:15–5:35, with edge handles), a
 * `<Baseline>` at 225 W, and a `<Marker>` at 5:28. They render above the data,
 * inert to the pointer (pan/zoom keeps the surface). Move the pointer over the
 * region / marker to see it brighten — luminosity = attention.
 */
export const InContext: Story = {
  render: () => (
    <ChartContainer range={INTERVAL} width={680} theme={estelaTheme}>
      <ChartRow height={280}>
        <YAxis id="power" label="W" min={0} max={300} />
        <Layers>
          <LineChart series={power()} column="watts" as="foam" />
          <Region
            from={BASE + 15 * STEP}
            to={BASE + 35 * STEP}
            label="5:15–5:35"
            selected
          />
          <Baseline value={225} label="225 W" />
          <Marker at={BASE + 28 * STEP} label="5:28" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **The names generalize past time.** Same `<Marker>` / `<Region>`, now on a
 * **value** x axis (HR over cumulative distance) — a `<Marker at={3000}>` is a
 * lap boundary, a `<Region>` is a zone. The mockup called the vertical mark a
 * "time line"; it's really a marker at an x, time or value.
 */
export const ValueAxis: Story = {
  render: () => {
    const ride = rideByDistance();
    return (
      <ChartContainer width={680} theme={estelaTheme} timeFormat=",.0f">
        <ChartRow height={260}>
          <YAxis id="hr" label="bpm" />
          <Layers>
            <LineChart series={ride} column="hr" as="foam" />
            <Region from={2000} to={3200} label="Climb" />
            <Marker at={3000} label="Lap 3" selected />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Selection state** — toggle `selected` to flip a region between `rest` (calm,
 * the data reads through) and `selected` (brighter, edge handles out). Live
 * select + drag-to-edit is a later phase (an explicit edit mode); here it's a
 * controlled input.
 */
export const Selectable: Story = {
  args: { selected: true },
  argTypes: { selected: { control: 'boolean' } },
  render: (args) => {
    const selected = (args as { selected?: boolean }).selected ?? false;
    return (
      <ChartContainer range={INTERVAL} width={680} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="power" label="W" min={0} max={300} />
          <Layers>
            <LineChart series={power()} column="watts" as="foam" />
            <Region
              from={BASE + 15 * STEP}
              to={BASE + 35 * STEP}
              label="interval"
              selected={selected}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
