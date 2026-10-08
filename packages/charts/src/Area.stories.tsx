import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { AreaChart } from './AreaChart.js';
import { YAxis } from './YAxis.js';
import { LineCursor } from './cursors.js';

const N = 60;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step, so the time axis
 *  shows wall-clock labels and the visual baselines stay deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/**
 * An elevation profile: a positive-only sine rolling between ~120 and ~480 m,
 * with a coast (gap) from index 25–31 so the fill + outline must break. The
 * elevation form (`baseline="floor"`) rests on the axis floor and grades down
 * from the line.
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

/**
 * The esnet "site traffic" shape: a diurnal-ish `in` curve (bytes received,
 * positive) mirrored by a smaller `out` curve (bytes sent, stored negative) so
 * the two areas read as "Into Site" above the zero axis and "Out of site" below.
 * Deterministic (two summed sines per channel) — the *static* reproduction of
 * the classic esnet network-traffic example (the range-editing overlay is
 * designed separately; this is just the picture).
 */
function siteTraffic() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const phase = (i / (N - 1)) * Math.PI * 2; // one "day" across the window
    // Inbound peaks mid-window (business hours), with a faster ripple.
    const inbound =
      520 + 360 * Math.sin(phase - Math.PI / 2) + 60 * Math.sin(i / 3);
    // Outbound tracks it at ~40% with its own ripple — always less than inbound.
    const outbound =
      210 + 150 * Math.sin(phase - Math.PI / 2) + 40 * Math.sin(i / 4);
    rows.push([BASE + i * STEP, inbound, -outbound]);
  }
  return new TimeSeries({
    name: 'site-traffic',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'in', kind: 'number' },
      { name: 'out', kind: 'number' },
    ] as const,
    rows,
  });
}

/**
 * A price that moves from `from` to `to` in three steps — starting exactly at
 * `from`, ending exactly at `to`, and never leaving the range between them, so
 * the data's extent is its two endpoints. `price(50, -100)` crosses zero;
 * `price(100, 200)` never comes near it.
 */
function price(from: number, to: number) {
  const d = to - from;
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const t = i / (N - 1);
    const v =
      from +
      (d * (1 - Math.cos(Math.PI * t))) / 2 +
      0.06 * d * Math.sin(8 * Math.PI * t) * Math.sin(Math.PI * t);
    rows.push([BASE + i * STEP, v]);
  }
  return new TimeSeries({
    name: 'price',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'usd', kind: 'number' },
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

/** One price row — the scaffold the baseline fan-out below shares. */
function PriceArea({
  series,
  baseline,
  min,
}: {
  series: ReturnType<typeof price>;
  baseline?: 'floor';
  min?: number;
}) {
  return (
    <ChartContainer range={TIME_RANGE} width={560}>
      <LineCursor />
      <ChartRow height={240}>
        <YAxis id="usd" format="$,.0f" min={min} />
        <Layers>
          <AreaChart
            series={series}
            column="usd"
            as="default"
            {...(baseline === undefined ? {} : { baseline })}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/**
 * **The default: the fill rests on zero.** No `baseline`, on a price that
 * crosses zero ($50 → −$100): the stretch above zero fills down to the zero
 * line, the stretch below fills up to it, and each side's shade fades toward
 * it. The axis fits the data — the baseline never changes the axis range.
 */
export const ZeroBaseline: Story = {
  render: () => <PriceArea series={price(50, -100)} />,
};

/**
 * `baseline="floor"` on the same price as {@link ZeroBaseline}: the fill
 * reaches the bottom of the plot even though zero is on screen. The axis is
 * identical — only where the fill stops has moved.
 */
export const FloorCrossingZero: Story = {
  render: () => <PriceArea series={price(50, -100)} baseline="floor" />,
};

/**
 * **Zero below the axis.** The default on a price that never nears zero
 * ($100 → $200): the axis still fits the data, so zero is off the plot and the
 * fill rests on the bottom edge (the baseline is clamped into the axis range).
 * On data like this the default draws exactly what `baseline="floor"` does.
 */
export const ZeroOffAxis: Story = {
  render: () => <PriceArea series={price(100, 200)} />,
};

/**
 * **Putting zero on the axis.** The same $100 → $200 price under
 * `<YAxis min={0}>`: the axis is the caller's to widen, and once zero is on it
 * the default fill reaches down to it, so each value's fill is as tall as the
 * value.
 */
export const ZeroOnAxis: Story = {
  render: () => <PriceArea series={price(100, 200)} min={0} />,
};

/**
 * The elevation form (driver: estela elevation). `baseline="floor"` rests the
 * fill on the bottom of the plot, wherever the axis starts; the graded shade
 * fades from the themed outline down to the bottom. The coast reads as a break in both the fill and the outline — never a
 * bridge to the floor.
 */
export const Elevation: Story = {
  render: () => {
    const e = elevation();
    return (
      <ChartContainer range={TIME_RANGE} width={560}>
        <LineCursor />
        <ChartRow height={240}>
          <YAxis id="m" label="m" />
          <Layers>
            <AreaChart
              series={e}
              column="elev"
              as="default"
              curve="monotone"
              baseline="floor"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **A reference level other than zero.** `baseline={300}` on the same profile:
 * stretches above 300 m fill up, stretches below it fill down, each side's
 * shade fading toward the 300 m line — the above/below form around a level
 * that means something in the data (a target, a par value, an index's base).
 */
export const ReferenceLevel: Story = {
  render: () => {
    const e = elevation();
    return (
      <ChartContainer range={TIME_RANGE} width={560}>
        <LineCursor />
        <ChartRow height={240}>
          <YAxis id="m" label="m" />
          <Layers>
            <AreaChart
              series={e}
              column="elev"
              as="default"
              curve="monotone"
              baseline={300}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * The above/below-axis form (driver: esnet traffic). Two `<AreaChart>`s share a
 * `baseline={0}` (the default, written out): `in` (blue) fills up, `out` (rose, stored
 * negative) fills down. Each side's shade fades toward the zero axis. Two layers
 * + two `as` roles — the single styling channel, composed (no per-component
 * colour). The y-axis includes 0 because the data does — `in` is positive and
 * `out` negative — not because of the baseline, which never widens the axis.
 */
export const AboveBelowAxis: Story = {
  render: () => {
    const t = traffic();
    return (
      <ChartContainer range={TIME_RANGE} width={560}>
        <LineCursor />
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

/**
 * The esnet network-traffic look reproduced statically: **"Into Site"** (blue,
 * above the zero axis) over **"Out of site"** (rose, below), two
 * `<AreaChart>`s on a shared `baseline={0}`, each side's shade fading toward the
 * axis. This is the static picture from the classic esnet example — deterministic
 * diurnal data, no brush (the range-editing overlay is designed separately).
 */
export const TrafficAreas: Story = {
  render: () => {
    const t = siteTraffic();
    return (
      <ChartContainer range={TIME_RANGE} width={640}>
        <LineCursor />
        <ChartRow height={260}>
          <YAxis id="bps" label="Gbps" />
          <Layers>
            <AreaChart series={t} column="in" baseline={0} as="in" />
            <AreaChart series={t} column="out" baseline={0} as="out" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
