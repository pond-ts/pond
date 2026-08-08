import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { AreaChart } from './AreaChart.js';
import { BandChart } from './BandChart.js';
import { BarChart } from './BarChart.js';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';

/**
 * `<YAxis scale="log">`, one story per state.
 *
 * The motivating case is data that grows by orders of magnitude — network
 * traffic, storage, anything compounding. On a linear axis every decade below
 * the top one collapses onto the baseline, so the first two stories are the
 * same series drawn both ways: that contrast is the whole argument for the
 * prop, and it's the one thing a reader should see first.
 *
 * A log domain cannot contain zero, so the rest of the fan-out is mostly the
 * ways that constraint surfaces — one story per way, because each one was a
 * separate silent failure before it had a story:
 *
 * - **Bounds** — a refused `min`, a refused `max`, an explicit bound the domain
 *   must not discard, and the `.nice()` rounding of a fully auto-fit domain.
 * - **Unplottable samples** — a zero in a line, in an area, and in a band's
 *   lower edge; a negative sample. Each renders as a *gap*, which is the whole
 *   point: a `lineTo` with a `NaN` coordinate is dropped by the canvas rather
 *   than breaking the path, so these used to be drawn straight over.
 * - **Layers that reach for a baseline** — an area's `baseline={0}`, a bar
 *   layer (whose extent always widens to include zero), and a *stacked* bar
 *   layer, whose bottom segment is the one that disappeared.
 */
const N = 72;
const BASE = Date.UTC(2020, 0, 1);
const STEP = 30 * 24 * 3_600_000; // ~monthly
const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

/** Compounding growth: ~1e3 → ~1e9 over six years. Six decades — the shape a
 *  linear axis cannot show. */
function growth(): TimeSeries<typeof SCHEMA> {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const v = 1_000 * 10 ** ((6 * i) / (N - 1));
    // A little wobble so it isn't a suspiciously perfect line.
    rows.push([BASE + i * STEP, v * (1 + 0.08 * Math.sin(i / 3))]);
  }
  return new TimeSeries({ name: 'growth', schema: SCHEMA, rows });
}

/** The same shape, but touching zero twice — the outage case. */
function withZeroes(): TimeSeries<typeof SCHEMA> {
  const base = growth();
  const rows = base.toJSON().rows.map((r, i) => {
    const [t, v] = r as [number, number];
    return [t, i === 20 || i === 21 ? 0 : v] as [number, number];
  });
  return new TimeSeries({ name: 'with-zeroes', schema: SCHEMA, rows });
}

/** The same shape, dipping **below** zero — the case the dev warning can name
 *  without ambiguity (a bar layer's extent only ever reaches exactly zero). */
function withNegatives(): TimeSeries<typeof SCHEMA> {
  const base = growth();
  const rows = base.toJSON().rows.map((r, i) => {
    const [t, v] = r as [number, number];
    return [t, i === 30 || i === 31 ? -v / 4 : v] as [number, number];
  });
  return new TimeSeries({ name: 'with-negatives', schema: SCHEMA, rows });
}

const BAND_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'lo', kind: 'number' },
  { name: 'hi', kind: 'number' },
] as const;

/** A variance envelope measured up from zero — `lower` is `0` for two samples,
 *  which is the common way a band ends up unplottable on a log axis. */
function envelope(): TimeSeries<typeof BAND_SCHEMA> {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const v = 1_000 * 10 ** ((6 * i) / (N - 1));
    rows.push([BASE + i * STEP, i === 20 || i === 21 ? 0 : v / 3, v * 3]);
  }
  return new TimeSeries({ name: 'envelope', schema: BAND_SCHEMA, rows });
}

/** Two stacked groups, both strictly positive — the shape whose **bottom**
 *  segment used to disappear on a log axis. */
const STACK_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number' },
  { name: 'b', kind: 'number' },
] as const;

function stackedGrowth(): TimeSeries<typeof STACK_SCHEMA> {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < 24; i += 1) {
    const v = 1_000 * 10 ** ((5 * i) / 23);
    rows.push([BASE + i * STEP, v * 0.4, v * 0.6]);
  }
  return new TimeSeries({ name: 'stacked', schema: STACK_SCHEMA, rows });
}

const meta = {
  title: 'Axes/Log scale',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const W = 560;
const H = 220;

const chart = (axis: React.ReactNode, layers: React.ReactNode, grid = true) => (
  <ChartContainer range={RANGE} width={W} grid={grid}>
    <ChartRow height={H}>
      {axis}
      <Layers>{layers}</Layers>
    </ChartRow>
  </ChartContainer>
);

/** **Linear (the default)** — six decades of growth, and only the top one is
 *  legible. Everything before ~2025 is pinned to the baseline. */
export const Linear: Story = {
  render: () =>
    chart(
      <YAxis id="v" format=".2s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **`scale="log"`** — the same series, same data, mapped by ratio. The growth
 *  is a straight line, which is the finding a linear axis hides. */
export const Log: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **Ticks land on the decades**, and `format` still formats the *value* — the
 *  transform is in the scale, not in the data, so a readout says `1.0M`, never
 *  its logarithm. */
export const DecadeTicks: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".0s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **Explicit domain** — `min` / `max` are honoured verbatim when both are
 *  positive, so you can pin the axis to whole decades. */
export const ExplicitDomain: Story = {
  render: () =>
    chart(
      <YAxis
        id="v"
        scale="log"
        min={100}
        max={10_000_000_000}
        format=".0s"
        width={64}
      />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **A non-positive `min` is refused.** `min={0}` on a log axis asks for a
 *  value the scale maps to `NaN`; the axis falls back to the data's own floor
 *  rather than handing that to the scale, and dev-warns that it did. Identical
 *  to {@link Log}. */
export const NonPositiveMinRefused: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" min={0} format=".2s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **A non-positive `max` is refused too** — and now says so. It used to be
 *  dropped in silence, since the warning only ever looked at `min`. */
export const NonPositiveMaxRefused: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" max={0} format=".2s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **A positive explicit bound is never discarded.** With only `max` given, the
 *  *auto-fit* floor moves to keep the domain ascending — the caller's number
 *  stays exactly where they put it, which is what a linear axis already did.
 *  Here `max` sits below the whole series, so the axis shows the one decade
 *  under it and the data runs off the top. */
export const ExplicitMaxBelowData: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" max={5_000} format=".0s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **An auto-fit domain is rounded out to whole decades** (`.nice()`), so the
 *  extremes have headroom instead of sitting clipped against the plot edge and
 *  the decade ticks reach the bounds. Contrast {@link ExplicitDomain}, where
 *  the caller's numbers are used exactly as given. */
export const NiceAutoDomain: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".0s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **`pad` is multiplicative.** A fraction of the domain, where the domain's
 *  span is a *ratio* — so it adds the same fraction of a decade at each end.
 *  Padding additively would be invisible at the top and enormous at the
 *  bottom. */
export const Padded: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" pad={0.25} format=".2s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
    ),
};

/** **Zero in the data.** Those samples have no position on a log axis, so the
 *  line **gaps** there. That is the fix this story is really for: the gap used
 *  to be a straight line joining the two neighbours, because a `lineTo` with a
 *  `NaN` coordinate is *dropped* by the canvas rather than breaking the path —
 *  so the chart quietly drew over its own missing data. */
export const ZeroInData: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <LineChart series={withZeroes()} column="v" axis="v" />,
    ),
};

/** **The same zeroes, as an area.** The fill and its outline break at the gap
 *  together — a hole in the shade, never a slab down to the baseline. */
export const ZeroInDataArea: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <AreaChart series={withZeroes()} column="v" axis="v" />,
    ),
};

/** **Negative data on a log axis.** Nothing to draw for those samples, and the
 *  one case the dev warning can name without ambiguity — a bar layer's extent
 *  reaches *exactly* zero, never below it. */
export const NegativeInData: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <LineChart series={withNegatives()} column="v" axis="v" />,
    ),
};

/** **An area on a log axis.** `AreaChart` fills to the axis floor: an omitted
 *  baseline already resolves there, and an explicit `baseline={0}` — natural,
 *  and correct on a linear axis — is clamped to it rather than scaling to
 *  `NaN` and dropping the whole filled path. */
export const AreaBaseline: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <AreaChart series={growth()} column="v" axis="v" baseline={0} />,
    ),
};

/** **A band whose lower edge is zero.** Measuring an envelope up from nothing
 *  is the ordinary shape, and zero has no position here — so those samples are
 *  a break in the envelope rather than a fill stitched across them. */
export const BandFromZero: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <BandChart
        series={envelope()}
        lower="lo"
        upper="hi"
        axis="v"
        as="secondary"
      />,
    ),
};

/** **A bar layer sharing a log axis.** `barExtent` always widens to include
 *  zero so a bar can reach its baseline; auto-fit takes the smallest
 *  *positive* extent instead, so that zero can't collapse the domain, and the
 *  bars rest on the axis floor. **No warning here** — the data is strictly
 *  positive, and a warning that fires on every bar chart is one nobody reads.
 */
export const WithBars: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <BarChart series={growth()} column="v" axis="v" />,
    ),
};

/** **A stacked bar layer on a log axis.** Each stack starts at the axis floor
 *  rather than at zero. Starting at zero is what a linear axis does — and it is
 *  the same code, since zero clamped into a linear domain *is* zero — but on a
 *  log axis zero has no position, so the whole bottom segment used to be
 *  dropped by the canvas and become unhittable along with it. */
export const StackedOnLog: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <BarChart series={stackedGrowth()} columns={['a', 'b']} axis="v" />,
    ),
};

/** **Mixed scales in one row** — a log axis on the left, linear on the right.
 *  The kind is per-axis, so two scales can disagree without either layer
 *  knowing. */
export const LogAndLinearTogether: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={H}>
        <YAxis id="log" scale="log" side="left" format=".2s" width={64} />
        <YAxis id="lin" side="right" format=".2s" width={64} />
        <Layers>
          <LineChart series={growth()} column="v" axis="log" />
          <LineChart series={growth()} column="v" axis="lin" as="secondary" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Gridlines off** — the decade gridlines are the main way a log axis reads
 *  as logarithmic, so this is the state worth checking deliberately. */
export const NoGrid: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <LineChart series={growth()} column="v" axis="v" />,
      false,
    ),
};
