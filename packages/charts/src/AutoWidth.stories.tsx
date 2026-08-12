import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { twoSeries, RANGE } from './story-data.fixture.js';

/**
 * `<ChartContainer width="auto">` — fill the available width.
 *
 * The canvas renderer needs real pixels before it can lay out ticks and slots,
 * so `'auto'` does not hand the canvas a percentage: the container renders a
 * plain full-width box, measures it, and mounts the chart at that pixel width,
 * re-rendering as the box resizes. Nothing paints until a real width exists.
 *
 * Resize the Storybook viewport (or drag the `resize` handle in
 * `ResizableBox`) to watch it track.
 */
const s = twoSeries();

const meta = {
  title: 'Layout/Auto width',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

const chart = (
  <>
    <ChartRow height={180}>
      <YAxis id="v" label="Latency (ms)" min={140} max={230} />
      <Layers>
        <LineChart series={s} column="fast" axis="v" />
        <LineChart series={s} column="slow" axis="v" />
      </Layers>
    </ChartRow>
  </>
);

/**
 * **Default** — `width="auto"` in an ordinary block context, so the chart
 * fills whatever the story canvas gives it.
 */
export const Default: Story = {
  render: () => (
    <ChartContainer range={RANGE} width="auto">
      {chart}
    </ChartContainer>
  ),
};

/**
 * **OmittedWidth** — no `width` prop at all, which means the same thing.
 * Filling is the sensible default for a component that knows how to measure.
 */
export const OmittedWidth: Story = {
  render: () => <ChartContainer range={RANGE}>{chart}</ChartContainer>,
};

/**
 * **Fixed** — a numeric `width` still skips the measure pass and paints on the
 * first render. Use it when the width is already known (a fixed panel, a print
 * layout, a test).
 */
export const Fixed: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={420}>
      {chart}
    </ChartContainer>
  ),
};

/**
 * **ConstrainedParent** — auto measures its *parent's* content width, so a
 * narrow wrapper narrows the chart. Auto width only does something when
 * something upstream actually constrains it.
 */
export const ConstrainedParent: Story = {
  render: () => (
    <div style={{ width: 360 }}>
      <ChartContainer range={RANGE} width="auto">
        {chart}
      </ChartContainer>
    </div>
  ),
};

/**
 * **PaddedWrapper** — the recipe's sharpest edge, now unhittable. Style the
 * wrapper however you like: the measured box is the library's own plain
 * `<div>` *inside* it, so the chart gets the content width and cannot overflow
 * by the padding + border. Hand-rolling this by measuring the padded box is
 * what used to clip the right-hand axis.
 */
export const PaddedWrapper: Story = {
  render: () => (
    <div
      style={{
        width: 520,
        padding: 24,
        border: '2px solid #94a3b8',
        borderRadius: 8,
      }}
    >
      <ChartContainer range={RANGE} width="auto">
        {chart}
      </ChartContainer>
    </div>
  ),
};

/**
 * **FlexRow** — two auto containers as flex children. Each measures its own
 * box, so they split the row without either knowing the other exists.
 */
export const FlexRow: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ChartContainer range={RANGE} width="auto">
          <ChartRow height={160}>
            <YAxis id="v" min={140} max={230} />
            <Layers>
              <LineChart series={s} column="fast" axis="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ChartContainer range={RANGE} width="auto">
          <ChartRow height={160}>
            <YAxis id="w" min={140} max={230} />
            <Layers>
              <LineChart series={s} column="slow" axis="w" />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </div>
    </div>
  ),
};

/**
 * **ResizableBox** — a `resize: horizontal` parent, so you can drag the width
 * and watch the axis re-tick live. `minWidth: 0` on the flex/resize parent is
 * what lets it actually shrink.
 */
export const ResizableBox: Story = {
  render: () => (
    <div
      style={{
        resize: 'horizontal',
        overflow: 'auto',
        width: 560,
        minWidth: 220,
        maxWidth: '100%',
        paddingBottom: 12,
      }}
    >
      <ChartContainer range={RANGE} width="auto">
        {chart}
      </ChartContainer>
    </div>
  ),
};
