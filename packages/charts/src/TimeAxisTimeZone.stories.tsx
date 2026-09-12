import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sequence, TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { CrosshairCursor } from './cursors.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { BarChart } from './BarChart.js';
import { XAxis } from './XAxis.js';
import { TimeAxis } from './TimeAxis.js';
import { YAxis } from './YAxis.js';
import { identityProvider } from './tradingTimeScale.js';

/**
 * The `timeZone` knob, one story per state ([PND-TZAXIS]). Every story plots
 * the **same** series — hourly points across the New York spring-forward week
 * of March 2025 — so the only thing that moves between stories is the zone
 * the axis reads in: where the day ticks fall (that zone's midnights), what
 * the labels and the crosshair pill say, and where the stacked date bands
 * turn. `Local` is the shipped default (the viewer's own zone, whatever the
 * browser reports); the rest name a zone. All on `defaultTheme`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WIDTH = 900;

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'load', kind: 'number' },
] as const;

/** Hourly points, 8 days from the Thursday before the 2025 US spring-forward. */
function week(): TimeSeries<typeof schema> {
  const start = Date.UTC(2025, 2, 6, 5); // Thu 6 Mar 00:00 New York
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < 8 * 24; i++) {
    const hourOfDay = i % 24;
    // A daily curve whose amplitude drifts day to day, so daily totals differ
    // and a bar per day reads as data rather than a flat row.
    const day = Math.floor(i / 24);
    const amplitude = 30 * (1 + 0.35 * Math.sin(day * 1.3));
    rows.push([
      start + i * HOUR,
      40 +
        amplitude * Math.sin(((hourOfDay - 6) / 24) * 2 * Math.PI) +
        (i % 5) +
        6 * day * 0.5,
    ]);
  }
  return new TimeSeries({ name: 'load', schema, rows });
}

const series = week();
const range: [number, number] = [
  series.timeRange()!.begin(),
  series.timeRange()!.end(),
];
const dayRange: [number, number] = [
  range[0] + 3 * DAY,
  range[0] + 4 * DAY + 6 * HOUR,
];

function Chart({
  timeZone,
  dateStyle = 'flat',
  domain = range,
  cursor = false,
}: {
  timeZone?: string;
  dateStyle?: 'flat' | 'stacked';
  domain?: [number, number];
  cursor?: boolean;
}) {
  return (
    <ChartContainer
      range={domain}
      width={WIDTH}
      showAxis={false}
      grid
      {...(timeZone === undefined ? {} : { timeZone })}
    >
      <ChartRow height={220}>
        <YAxis id="y" label="load" />
        <Layers>
          <LineChart series={series} column="load" />
          {cursor ? <CrosshairCursor /> : null}
        </Layers>
      </ChartRow>
      <TimeAxis dateStyle={dateStyle} />
    </ChartContainer>
  );
}

const ZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Apia',
] as const;

const meta = {
  title: 'Axes/TimeAxis/TimeZone',
  parameters: { layout: 'centered' },
  argTypes: {
    timeZone: { control: 'select', options: ZONES },
  },
} satisfies Meta<{ timeZone: string }>;
export default meta;
type Story = StoryObj<{ timeZone: string }>;

/** No `timeZone`: the viewer's zone, as every chart rendered before the prop. */
export const Local: Story = { render: () => <Chart /> };

/** `timeZone="UTC"`: day ticks at 00:00Z whatever the browser's zone. */
export const UTC: Story = { render: () => <Chart timeZone="UTC" /> };

/** New York across its spring-forward: Sunday 9 March is 23 h wide. */
export const NewYork: Story = {
  render: () => <Chart timeZone="America/New_York" />,
};

/** Southern hemisphere: Sydney is on AEDT (+11) in March; its day starts 11 h before UTC's. */
export const Sydney: Story = {
  render: () => <Chart timeZone="Australia/Sydney" />,
};

/** A half-hour offset (+05:30) — day ticks at 18:30Z. */
export const Kolkata: Story = {
  render: () => <Chart timeZone="Asia/Kolkata" />,
};

/** Hour grain across the DST day: 6 h anchors read 00 / 06 / 12 / 18 New York
 *  on both sides of the 02:00 → 03:00 jump instead of drifting by an hour. */
export const HourGrainAcrossDST: Story = {
  render: () => <Chart timeZone="America/New_York" domain={dayRange} />,
};

/** The stacked style: the date bands turn at the zone's midnights and the
 *  band labels read the zone's dates. */
export const StackedBands: Story = {
  render: () => (
    <Chart timeZone="Asia/Kolkata" dateStyle="stacked" domain={dayRange} />
  ),
};

/** Hover: the crosshair pill reads the zone too (grain-aware readout). */
export const CursorReadout: Story = {
  render: () => <Chart timeZone="Australia/Sydney" cursor />,
};

/** A calendar that carries a `timeZone` supplies the axis default — no prop
 *  needed. The container renders in Tokyo time because the calendar says so. */
export const FromCalendar: Story = {
  render: () => {
    const calendar = {
      timeZone: 'Asia/Tokyo',
      discontinuities: () => identityProvider({ timeZone: 'Asia/Tokyo' }),
    };
    return (
      <ChartContainer
        range={range}
        width={WIDTH}
        showAxis={false}
        grid
        calendar={calendar}
      >
        <ChartRow height={220}>
          <YAxis id="y" label="load" />
          <Layers>
            <LineChart series={series} column="load" />
          </Layers>
        </ChartRow>
        <TimeAxis />
      </ChartContainer>
    );
  },
};

/** A `%Z`-carrying custom `timeFormat` reads the zone's abbreviation. */
export const AbbreviationInFormat: Story = {
  render: () => (
    <ChartContainer
      range={dayRange}
      width={WIDTH}
      showAxis={false}
      timeZone="America/New_York"
      timeFormat="%H:%M %Z"
    >
      <ChartRow height={220}>
        <YAxis id="y" label="load" />
        <Layers>
          <LineChart series={series} column="load" />
        </Layers>
      </ChartRow>
      <TimeAxis />
    </ChartContainer>
  ),
};

/** Change the zone in the controls panel: ticks move to the new zone's
 *  midnights and every label re-reads, on the same data and pixel mapping. */
export const PickAZone: Story = {
  args: { timeZone: 'Europe/Berlin' },
  render: ({ timeZone }) => <Chart timeZone={timeZone} cursor />,
};

/** Two strips, two zones on one shared mapping: the container's zone (UTC)
 *  below the plot, a second `<XAxis timeZone>` above it in New York time.
 *  Same instants, different calendars — the top strip's day turns sit at New
 *  York midnight, the bottom strip's at 00:00Z. */
export const DualZones: Story = {
  render: () => (
    <ChartContainer
      range={dayRange}
      width={WIDTH}
      showAxis={false}
      grid
      timeZone="UTC"
    >
      <XAxis side="top" timeZone="America/New_York" label="New York" />
      <ChartRow height={220}>
        <YAxis id="y" label="load" />
        <Layers>
          <LineChart series={series} column="load" />
        </Layers>
      </ChartRow>
      <XAxis label="UTC" />
    </ChartContainer>
  ),
};

/**
 * Aggregate, then chart, in one zone: the hourly series rolled up to
 * **calendar days** with `Sequence.calendar('day', { timeZone })` and drawn as
 * bars in a container given the same zone. Each bar spans exactly one day tick
 * to the next — including the 23 h spring-forward day in a DST zone — because
 * the same primitive cuts the buckets and places the ticks. Pick another zone
 * in the controls panel and both move together.
 */
export const DailyBucketsInZone: Story = {
  args: { timeZone: 'America/New_York' },
  render: ({ timeZone }) => {
    const daily = series.aggregate(Sequence.calendar('day', { timeZone }), {
      load: 'sum',
    });
    return (
      <ChartContainer
        range={range}
        width={WIDTH}
        showAxis={false}
        grid
        timeZone={timeZone}
      >
        <ChartRow height={220}>
          <YAxis id="y" label="load / day" min={0} />
          <Layers>
            <BarChart series={daily} column="load" gap={3} />
            <CrosshairCursor />
          </Layers>
        </ChartRow>
        <TimeAxis dateStyle="stacked" />
      </ChartContainer>
    );
  },
};
