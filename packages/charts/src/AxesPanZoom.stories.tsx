import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { BarChart } from './BarChart.js';
import { XAxis } from './XAxis.js';
import { YAxis } from './YAxis.js';

/**
 * Axis pan/zoom — drag or wheel an axis strip to scale it, double-click to put
 * it back. Enabled by the container's `panZoom`, so each story shows which mode
 * turns which strip on. One story per surface the gesture behaves differently on.
 *
 * Drag **zooms**; panning stays the plot's drag, so try both: drag the plot to
 * slide, drag the strip to scale.
 */
const N = 240;
const BASE = Date.UTC(2026, 2, 2, 9, 30, 0);
const STEP = 60_000;
const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];
const W = 560;

function demo() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      185 + 30 * Math.sin(i / 30) + 4 * Math.sin(i / 3),
      40 + 25 * Math.cos(i / 20),
    ]);
  }
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'price', kind: 'number' },
      { name: 'flow', kind: 'number' },
    ] as const,
    rows,
  });
}

const DESKS = ['EMEA', 'APAC', 'AMER', 'LATAM', 'MEA'];
const desks = DESKS.map((label, i) => ({ label, value: 12 + i * 7 }));

const meta = {
  title: 'Axes/PanZoom',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** `panZoom="panZoom"` — the x strip scales time. Drag it, wheel it, dbl-click. */
export const XStripZoom: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} showAxis={false} panZoom="panZoom">
      <ChartRow height={200}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
        </Layers>
      </ChartRow>
      <XAxis label="drag / wheel me — double-click to reset" />
    </ChartContainer>
  ),
};

/**
 * `panZoom="panZoomY"` — each gutter scales **itself**. Drag the left one and
 * watch the right one hold still: the per-axis transform is the whole point.
 */
export const YGutterPerAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W + 60} panZoom="panZoomY">
      <ChartRow height={220}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
          <LineChart series={demo()} column="flow" axis="flow" />
        </Layers>
        <YAxis id="flow" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * `panZoom="panZoomXY"` — every strip is live. The plot's own vertical gesture
 * still scales both axes **together** (the uniform transform, which is what fixes
 * the aspect ratio); a gutter drag scales just that one.
 */
export const BothAxes: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W + 60}
      showAxis={false}
      panZoom="panZoomXY"
    >
      <ChartRow height={220}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
          <LineChart series={demo()} column="flow" axis="flow" />
        </Layers>
        <YAxis id="flow" side="right" format=",.0f" />
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/**
 * Two rows, one shared x. A gutter drag is scoped to its own row's axis — the
 * lower row doesn't move — while the x strip scales both rows at once, because
 * the x view is the container's.
 */
export const StackedRows: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      showAxis={false}
      panZoom="panZoomXY"
    >
      <ChartRow height={140}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
        </Layers>
      </ChartRow>
      <ChartRow height={100}>
        <YAxis id="flow" format=",.0f" />
        <Layers>
          <LineChart series={demo()} column="flow" axis="flow" />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/**
 * `minDuration` is the zoom-in floor for the strip exactly as for the plot —
 * drag right as hard as you like, the view stops at 30 minutes.
 */
export const ZoomInFloor: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      showAxis={false}
      panZoom="panZoom"
      minDuration={30 * 60_000}
    >
      <ChartRow height={200}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
        </Layers>
      </ChartRow>
      <XAxis label="floors at 30 minutes" />
    </ChartContainer>
  ),
};

/**
 * A **category** x axis has no continuous domain to zoom, so its strip stays
 * inert (no resize cursor) even under `panZoomXY` — the y gutter still zooms.
 */
export const CategoryStripInert: Story = {
  render: () => (
    <ChartContainer
      width={W}
      categories={DESKS}
      showAxis={false}
      panZoom="panZoomXY"
    >
      <ChartRow height={200}>
        <YAxis id="flow" format=",.0f" />
        <Layers>
          <BarChart categories={desks} axis="flow" />
        </Layers>
      </ChartRow>
      <XAxis label="inert — categories don't zoom" />
    </ChartContainer>
  ),
};
