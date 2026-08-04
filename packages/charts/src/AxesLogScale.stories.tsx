import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { AreaChart } from './AreaChart.js';
import { BarChart } from './BarChart.js';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';

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
 * ways that constraint surfaces: a non-positive explicit bound, a zero sample
 * in the data, an area's baseline, and a bar layer (whose extent always widens
 * to include zero) sharing the axis.
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

const meta = {
  title: 'Axes/Log scale',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const W = 560;
const H = 220;

const chart = (axis: React.ReactNode, layers: React.ReactNode, grid = true) => (
  <ChartContainer range={RANGE} width={W} theme={docsTheme} grid={grid}>
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

/** **A non-positive `min` is refused.** `min={0}` on a log axis is a request
 *  for -Infinity; the axis falls back to the data's own floor rather than
 *  handing that to the scale. Identical to {@link Log}. */
export const NonPositiveMinRefused: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" min={0} format=".2s" width={64} />,
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
 *  line gaps there — and a dev-mode console warning fires, because silently
 *  vanishing samples are otherwise impossible to diagnose from the picture. */
export const ZeroInData: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <LineChart series={withZeroes()} column="v" axis="v" />,
    ),
};

/** **An area on a log axis.** `AreaChart` fills to the axis floor: an omitted
 *  baseline already resolves there, and an explicit `baseline={0}` — natural,
 *  and correct on a linear axis — is clamped to it rather than scaling to
 *  -Infinity and dropping the whole filled path. */
export const AreaBaseline: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <AreaChart series={growth()} column="v" axis="v" baseline={0} />,
    ),
};

/** **A bar layer sharing a log axis.** `barExtent` always widens to include
 *  zero so a bar can reach its baseline; auto-fit takes the smallest
 *  *positive* extent instead, so that zero can't collapse the domain, and the
 *  bars rest on the axis floor. */
export const WithBars: Story = {
  render: () =>
    chart(
      <YAxis id="v" scale="log" format=".2s" width={64} />,
      <BarChart series={growth()} column="v" axis="v" />,
    ),
};

/** **Mixed scales in one row** — a log axis on the left, linear on the right.
 *  The kind is per-axis, so two scales can disagree without either layer
 *  knowing. */
export const LogAndLinearTogether: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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
