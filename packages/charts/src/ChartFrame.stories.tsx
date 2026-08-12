import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { useChartFrame } from './useChartFrame.js';
import { twoSeries, RANGE } from './story-data.fixture.js';

/**
 * `useChartFrame()` — the container's **resolved plot geometry**, published so
 * DOM chrome can line up with the plot without re-deriving it.
 *
 * Every story here renders a plain `<div>` as a sibling of the `<ChartRow>`
 * and positions it from the frame. The thing to watch across the fan-out is
 * that the chrome tracks the plot through changes it did not know about — a
 * wider axis gutter, a capped band pitch, a top axis title — because it is
 * reading the same numbers the canvas drew with rather than a parallel guess.
 */
const W = 620;
const s = twoSeries();

const cats = [
  { label: 'AAPL', value: 41 },
  { label: 'MSFT', value: 33 },
  { label: 'NVDA', value: 58 },
  { label: 'AMZN', value: 24 },
  { label: 'META', value: 47 },
];

const meta = {
  title: 'Frame/useChartFrame',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

const cell: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  textAlign: 'center',
  font: '11px system-ui, sans-serif',
  lineHeight: '20px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
};

/** A strip that pads by the left gutter and spans exactly the plot. */
function PlotStrip({
  children,
  height = 22,
}: {
  children?: React.ReactNode;
  height?: number;
}) {
  const { plot } = useChartFrame();
  return (
    <div
      style={{
        position: 'relative',
        marginLeft: plot.x,
        width: plot.width,
        height,
        outline: '1px dashed #94a3b8',
      }}
    >
      {children}
    </div>
  );
}

/** One labelled cell per ordinal slot, placed from `bands.at(i)`. */
function SlotHeader() {
  const { plot, bands } = useChartFrame();
  if (bands === null) return null;
  return (
    <div
      style={{
        position: 'relative',
        marginLeft: plot.x,
        width: plot.width,
        height: 20,
      }}
    >
      {bands.labels.map((label, i) => {
        const b = bands.at(i)!;
        return (
          <div
            key={label}
            style={{
              ...cell,
              left: b.x0,
              width: b.x1 - b.x0,
              borderLeft: '1px solid #cbd5e1',
              borderTop: '1px solid #cbd5e1',
              borderRight:
                i === bands.count - 1 ? '1px solid #cbd5e1' : undefined,
            }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}

/**
 * **Default** — the plot rect on a time axis. The dashed strip pads by
 * `plot.x` and spans `plot.width`, so it starts where the plot starts and ends
 * where it ends, whatever the y axis reserved.
 */
export const Default: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <PlotStrip />
      <ChartRow height={180}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **WideGutter** — the same markup with a wider axis (a `label` and bigger
 * numbers). Nothing in the strip changed; it moved because the gutter did.
 * This is the case the re-derivation gets wrong: a gutter is sized from label
 * content, so a consumer pinning it to a constant drifts the moment the data
 * relabels the axis.
 */
export const WideGutter: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <PlotStrip />
      <ChartRow height={180}>
        <YAxis id="v" label="Requests / sec" min={140000} max={230000} />
        <Layers>
          <LineChart series={s} column="fast" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **DualAxis** — an axis in each gutter. `gutters.left` and `gutters.right`
 * differ, and the strip is inset by both.
 */
export const DualAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <PlotStrip />
      <ChartRow height={180}>
        <YAxis id="v" label="fast" min={140} max={230} />
        <YAxis id="w" label="slow" side="right" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" axis="v" />
          <LineChart series={s} column="slow" axis="w" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **PerSlotHeader** — one header cell per ordinal slot, the case the hook was
 * asked for. Cell edges come from `bands.at(i)`, so they land on the same
 * boundaries the bars are drawn between.
 */
export const PerSlotHeader: Story = {
  render: () => (
    <ChartContainer width={W}>
      <SlotHeader />
      <ChartRow height={180}>
        <YAxis id="v" label="" />
        <Layers>
          <BarChart categories={cats} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **CappedBands** — the same header over a capped pitch
 * (`maxBandWidth={70} bandAlign="center"`). The bars no longer fill the plot,
 * and the header cells follow them because `bands.at(i)` reads the packed
 * scale. `plot.width / count` — the obvious re-derivation — would spread the
 * cells across the full plot and misalign every one of them.
 */
export const CappedBands: Story = {
  render: () => (
    <ChartContainer width={W} maxBandWidth={70} bandAlign="center">
      <SlotHeader />
      <ChartRow height={180}>
        <YAxis id="v" label="" />
        <Layers>
          <BarChart categories={cats} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **BandAlignEnd** — the packed run pushed to the right edge. The header
 * tracks it with no change to the header's own code.
 */
export const BandAlignEnd: Story = {
  render: () => (
    <ChartContainer width={W} maxBandWidth={70} bandAlign="end">
      <SlotHeader />
      <ChartRow height={180}>
        <YAxis id="v" label="" />
        <Layers>
          <BarChart categories={cats} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **InPlotOverlay** — mounted *inside* a `<ChartRow>`, so `row` is non-null
 * and carries the y scales. The band marks a value window using `row.yScales`
 * for its top and bottom, and the shared `xScale` for its horizontal extent.
 */
export const InPlotOverlay: Story = {
  render: () => {
    function ValueWindow() {
      const { plot, row } = useChartFrame();
      if (row === null) return null;
      const y = row.yScales.get('v');
      if (y === undefined) return null;
      const top = y(200);
      const bottom = y(170);
      return (
        <div
          style={{
            position: 'absolute',
            left: plot.x,
            width: plot.width,
            top,
            height: bottom - top,
            background: 'rgba(63, 91, 224, 0.12)',
            borderTop: '1px solid #3F5BE0',
            borderBottom: '1px solid #3F5BE0',
            pointerEvents: 'none',
          }}
        />
      );
    }
    return (
      <ChartContainer range={RANGE} width={W}>
        <ChartRow height={220}>
          <YAxis id="v" min={140} max={230} />
          <Layers>
            <LineChart series={s} column="fast" axis="v" />
          </Layers>
          <ValueWindow />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **TopInset** — the same overlay under a `labelPlacement="top"` axis title.
 * `row.topInset` is the band the title reserved; the y scale already starts
 * below it, so an overlay positioned from the scale clears the title without
 * knowing it exists. An overlay positioned from the row's own `height` would
 * not.
 */
export const TopInset: Story = {
  render: () => {
    function InsetMarker() {
      const { plot, row } = useChartFrame();
      if (row === null) return null;
      return (
        <div
          style={{
            position: 'absolute',
            left: plot.x,
            width: plot.width,
            top: row.topInset,
            height: row.height,
            outline: '1px dashed #94a3b8',
            pointerEvents: 'none',
          }}
        />
      );
    }
    return (
      <ChartContainer range={RANGE} width={W}>
        <ChartRow height={220}>
          <YAxis
            id="v"
            label="Latency (ms)"
            labelPlacement="top"
            min={140}
            max={230}
          />
          <Layers>
            <LineChart series={s} column="fast" axis="v" />
          </Layers>
          <InsetMarker />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **MultiRow** — one strip above two rows. x geometry is shared, so a single
 * container-level reading aligns over both plots; y would need a reading
 * inside each row.
 */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} rowGap={8}>
      <PlotStrip />
      <ChartRow height={130}>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" axis="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={130}>
        <YAxis id="w" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="slow" axis="w" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
