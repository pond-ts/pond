import type { ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { XAxis } from './XAxis.js';
import { YAxis } from './YAxis.js';
import { Marker } from './annotations.js';

/**
 * The **duration (elapsed) x axis** — `<ChartContainer origin>`. One story per
 * knob: each grain the duration formatter picks, both origin kinds, the value
 * axis, the format overrides, and the interactive surfaces (cursor readout,
 * pan). The wall-clock story is the before-picture: same data, no `origin`.
 */

/** A deliberately un-round start instant, so a duration label and a wall-clock
 *  label can never be mistaken for each other. */
const START = Date.UTC(2026, 0, 15, 10, 33, 17);

/** A ride of `n` samples `step` ms apart from `START` — heart rate wandering. */
function ride(step: number, n = 60, start = START) {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    rows.push([start + i * step, 138 + 22 * Math.sin(i / 7) + (i % 3)]);
  }
  return new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows,
  });
}

/** The same ride re-keyed onto cumulative distance — a **value** x axis that
 *  starts at 1,200 m (the ride log didn't start at zero). */
function rideByDistance() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push([
      START + i * 10_000,
      1200 + i * 68,
      138 + 22 * Math.sin(i / 7) + (i % 3),
    ]);
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
  title: 'Axes/DurationAxis',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const W = 620;

/**
 * The shared body: one row of heart rate, one x axis. Takes **either** series
 * kind, so the time and value flavours share it.
 *
 * The cast at the `<LineChart>` below is the documented workaround for a
 * genuine [PND-CHARTAPI] limitation, and this helper is its representative
 * case: the layer's props are a union *per series kind* (so a column name is
 * checked against the schema actually passed), and a value typed as "either
 * kind" therefore matches no single member. A wrapper that forwards either
 * kind must narrow — or, as here where the union is the whole point, cast at
 * the boundary. Nothing is lost at the story call sites, which each pass a
 * concrete kind.
 */
const chart = (
  props: Partial<ComponentProps<typeof ChartContainer>>,
  series: ReturnType<typeof ride> | ReturnType<typeof rideByDistance> = ride(
    10_000,
  ),
  axis = <XAxis />,
) => (
  <ChartContainer width={W} showAxis={false} {...props}>
    <ChartRow height={180}>
      <YAxis id="hr" label="bpm" />
      <Layers>
        {/* Union-typed series: narrow or cast — see the doc above. */}
        <LineChart
          series={series as ReturnType<typeof ride>}
          column="hr"
          axis="hr"
        />
      </Layers>
    </ChartRow>
    {axis}
  </ChartContainer>
);

/** The before-picture: no `origin`, so the axis reads wall-clock instants. */
export const WallClock: Story = {
  render: () => chart({}),
};

/** `origin="data"` — durations since the first sample. The same chart, read as
 *  ten minutes of riding rather than as a slice of the afternoon. */
export const Default: Story = {
  render: () => chart({ origin: 'data' }),
};

/** An explicit origin (here the fifth minute — a gun, a trigger, a lap): ticks
 *  before it read negative, the T-minus case. */
export const ExplicitOrigin: Story = {
  render: () => chart({ origin: START + 5 * 60_000 }),
};

/** A 90-second span: the step is fine enough for seconds, so the clock drops to
 *  `MM:SS` rather than heading with a zero hour. */
export const SecondsGrain: Story = {
  render: () => chart({ origin: 'data' }, ride(1500, 60)),
};

/** A two-second span — a sub-second step adds milliseconds. */
export const MillisGrain: Story = {
  render: () => chart({ origin: 'data' }, ride(40, 50)),
};

/** Six hours: minutes-or-coarser steps head the clock with hours (`02:00`). */
export const HoursGrain: Story = {
  render: () => chart({ origin: 'data' }, ride(6 * 60_000, 60)),
};

/** Three days: the day part appears only once there is one — `18:00` then
 *  `1d 00:00`, the same promotion-at-the-turn the flat date style makes. */
export const MultiDay: Story = {
  render: () => chart({ origin: 'data' }, ride(80 * 60_000, 55)),
};

/** A month: at a day-or-coarser step there is no clock left to show, so the
 *  labels are whole days. */
export const DayGrain: Story = {
  render: () => chart({ origin: 'data' }, ride(12 * 3_600_000, 60)),
};

/** A **value** x axis (cumulative distance, starting at 1,200 m) offset from its
 *  own start: distance travelled, not distance recorded. */
export const ValueAxis: Story = {
  render: () =>
    chart(
      { origin: 'data' },
      rideByDistance(),
      <XAxis label="Metres ridden" />,
    ),
};

/** Two strips on one tick set: durations on top, the wall clock underneath. A
 *  d3 *time* specifier can only describe an instant, so `<XAxis format>` on an
 *  elapsed axis labels the absolute time — which is exactly the lever. */
export const WallClockUnderDuration: Story = {
  render: () =>
    chart(
      { origin: 'data' },
      ride(10_000),
      <>
        <XAxis />
        <XAxis format="%H:%M" color="#8b8fa3" />
      </>,
    ),
};

/** A `timeFormat` **function** owns the labels outright — here a terse
 *  minutes-only ruler. The elapsed default is a starting point, not a ceiling. */
export const CustomFormat: Story = {
  render: () =>
    chart({
      origin: 'data',
      timeFormat: (t: number) => `${Math.round((t - START) / 60_000)}m`,
    }),
};

/** Hover: the ticks stay terse (`00:05`) while the axis pill reads one grain
 *  finer (`00:05:12`) — the same precise-readout-over-terse-ticks split the
 *  calendar axis makes. */
export const CrosshairReadout: Story = {
  render: () => chart({ origin: 'data', cursor: 'crosshair' }),
};

/** A `<Marker indicator>` pins its instant to the axis in the axis's own
 *  language — elapsed, like every other readout on it. */
export const MarkerIndicator: Story = {
  render: () => (
    <ChartContainer width={W} origin="data" showAxis={false}>
      <ChartRow height={180}>
        <YAxis id="hr" label="bpm" />
        <Layers>
          <LineChart series={ride(10_000)} column="hr" axis="hr" />
          <Marker at={START + 220_000} label="attack" indicator />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/** Drag to pan, wheel to zoom: the origin is the **data**'s start, not the
 *  view's, so `00:00` travels with the first sample instead of re-zeroing at the
 *  left edge — pan past the start and the labels go negative. */
export const PanZoom: Story = {
  render: () => chart({ origin: 'data', panZoom: true, cursor: 'crosshair' }),
};
