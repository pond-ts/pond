import type { Meta, StoryObj } from '@storybook/react-vite';
import { ValueSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { ScatterChart } from './ScatterChart.js';
import { BandChart } from './BandChart.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';

/**
 * `<ChartContainer categories>` — the ordinal axis declared at the
 * **container**, so any value-keyed layer can live on it.
 *
 * Until this prop the band scale was reachable only through a layer, and the
 * container throws on a mixed x-kind — so a line, a point or an envelope over
 * categorical bars was not expressible at all. The workaround (key everything
 * to a synthetic integer index and hand-supply the ticks) forfeits the axis's
 * own label thinning and the `maxBandWidth` / `bandAlign` slot packing, which
 * is why this is a container prop rather than advice.
 *
 * **Keying convention:** the band domain is numeric, slot `i` occupying
 * `[i, i+1]`, so a mark belongs at **`i + 0.5`** — the slot centre, and where
 * `<XAxis>` puts the tick.
 */
const W = 620;

const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOG'];

const realized = [41, 33, 58, 24, 47, 36];
const target = [45, 30, 52, 31, 44, 39];
const lo = [38, 25, 46, 26, 38, 33];
const hi = [52, 36, 61, 37, 51, 46];

const bars = TICKERS.map((label, i) => ({ label, value: realized[i]! }));

/** The overlay, keyed to slot centres. */
const marks = ValueSeries.fromColumns({
  name: 'target',
  schema: [
    { name: 'slot', kind: 'value' },
    { name: 'target', kind: 'number' },
    { name: 'lo', kind: 'number' },
    { name: 'hi', kind: 'number' },
  ] as const,
  columns: {
    slot: TICKERS.map((_, i) => i + 0.5),
    target,
    lo,
    hi,
  },
});

const meta = {
  title: 'Category axis/Container categories',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/**
 * **Default** — categories declared on the container, and a value-keyed line
 * as the only layer. No bar chart anywhere, yet the axis is ordinal and ticks
 * once per name.
 */
export const Default: Story = {
  render: () => (
    <ChartContainer width={W} categories={TICKERS}>
      <ChartRow height={200}>
        <YAxis id="v" min={0} max={70} />
        <Layers>
          <LineChart series={marks} column="target" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **LineOverBars** — the case the report asked for: a target line over
 * categorical bars. The line's points sit on the bar centres because both key
 * to the same slot geometry.
 */
export const LineOverBars: Story = {
  render: () => (
    <ChartContainer width={W} categories={TICKERS}>
      <ChartRow height={200}>
        <YAxis id="v" min={0} max={70} />
        <Layers>
          <BarChart categories={bars} />
          <LineChart series={marks} column="target" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **PointsOverBars** — a point mark per slot instead of a connected line, for
 * a target that is a per-category fact rather than a trend.
 */
export const PointsOverBars: Story = {
  render: () => (
    <ChartContainer width={W} categories={TICKERS}>
      <ChartRow height={200}>
        <YAxis id="v" min={0} max={70} />
        <Layers>
          <BarChart categories={bars} />
          <ScatterChart series={marks} column="target" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **EnvelopeOverBars** — a filled uncertainty band across the slots, under a
 * point mark. Three layers of three different kinds on one ordinal axis.
 */
export const EnvelopeOverBars: Story = {
  render: () => (
    <ChartContainer width={W} categories={TICKERS}>
      <ChartRow height={200}>
        <YAxis id="v" min={0} max={70} />
        <Layers>
          <BandChart series={marks} lower="lo" upper="hi" axis="v" />
          <BarChart categories={bars} />
          <ScatterChart series={marks} column="target" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **CappedPitch** — `maxBandWidth` + `bandAlign` still apply, and the overlay
 * moves with the packed run. This is [PG-21]: the integer-index workaround
 * loses the cap and turns bar width into an absolute pixel value the consumer
 * recomputes on every resize.
 */
export const CappedPitch: Story = {
  render: () => (
    <ChartContainer
      width={W}
      categories={TICKERS}
      maxBandWidth={56}
      bandAlign="center"
    >
      <ChartRow height={200}>
        <YAxis id="v" min={0} max={70} />
        <Layers>
          <BarChart categories={bars} />
          <LineChart series={marks} column="target" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **ManyThinnedLabels** — 30 long category names in a narrow panel. The axis
 * thins and ellipsizes them ([PG-7]); a hand-supplied tick list would print
 * all thirty into one smear.
 */
export const ManyThinnedLabels: Story = {
  render: () => {
    const many = Array.from({ length: 30 }, (_, i) => `instrument-${i}`);
    const series = ValueSeries.fromColumns({
      name: 'v',
      schema: [
        { name: 'slot', kind: 'value' },
        { name: 'v', kind: 'number' },
      ] as const,
      columns: {
        slot: many.map((_, i) => i + 0.5),
        v: many.map((_, i) => 20 + 15 * Math.sin(i / 3)),
      },
    });
    return (
      <ChartContainer width={420} categories={many}>
        <ChartRow height={180}>
          <YAxis id="v" min={0} max={40} />
          <Layers>
            <LineChart series={series} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **MultiRow** — one declared slot list, two rows. The ordinal axis is shared
 * exactly as a time axis is, so the rows line up column by column.
 */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer width={W} categories={TICKERS} rowGap={8}>
      <ChartRow height={130}>
        <YAxis id="v" min={0} max={70} />
        <Layers>
          <BarChart categories={bars} />
        </Layers>
      </ChartRow>
      <ChartRow height={110}>
        <YAxis id="t" min={0} max={70} />
        <Layers>
          <LineChart series={marks} column="target" axis="t" />
          <ScatterChart series={marks} column="target" axis="t" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
