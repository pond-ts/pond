import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import {
  twoSeries,
  hrSeries,
  twoColorTheme,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';

/**
 * `cursor="crosshair"` — a single inspection **reticle**: a full-height dashed
 * vertical line + a full-width dashed horizontal line + a centre dot, with the
 * value pinned to the y-axis and the time to the **x-axis** (connected to the
 * vertical line).
 *
 * **`crosshairSnap`** (default `true`) centres the reticle on the nearest **data
 * point** — the vertical line snaps to a sample's x, the horizontal to its value.
 * `false` is a **free** reticle following the raw pointer, the value read as
 * `yScale.invert(pointerY)`. The snap stories pin a controlled `trackerPosition`
 * (a static shot, no hover → the reticle centres on the first sample); the free
 * reticle is hover-driven (it needs the pointer y), so its story has no pin —
 * hover the plot to see it.
 *
 * Crosshair puts the time on the x-axis pill only — unlike `flag`/`inline`'s
 * `cursorTime`, there is no per-row time chip to opt into.
 */
const W = 620;
const PIN = BASE + 40 * STEP;
const s = twoSeries();

const meta = {
  title: 'Charts/Cursors/Crosshair',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Free reticle** — `crosshairSnap={false}`: the horizontal line + centre
 *  follow the pointer **y** freely (value = `yScale.invert(pointerY)`), while the
 *  vertical line still snaps its **x** to the data grid (a clean time readout).
 *  Hover-driven — **hover the plot** to see it (no `trackerPosition` pin). */
export const FreeReticle: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      crosshairSnap={false}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Single series** — line + dot, the value pinned to the y-axis, the time on the x. */
export const SingleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multiple series** — a value pill per series on the shared axis, each in its
 *  own series colour, each with its own dashed connector; one x-time pill. */
export const MultipleSeries: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
          <LineChart series={s} column="slow" as="slow" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Left-side single axis** — the lone axis is on the left, so the pill hugs the
 *  left gutter (not the right default) with its connector reaching left. */
export const LeftAxis: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <YAxis id="usd" side="left" format=",.0f" />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Dual axis** — each series' pill hugs its own axis's side (left vs right),
 *  each with a connector reaching its own gutter. */
export const DualAxis: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={240}>
        <YAxis id="L" side="left" format=",.0f" />
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="L" />
          <LineChart series={s} column="slow" as="slow" axis="R" />
        </Layers>
        <YAxis id="R" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multi-row** — the vertical line spans both rows; each row pins its own
 *  value on its own axis; the x-time pill shows once, on the shared x-axis. */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={PIN}
      theme={twoColorTheme}
    >
      <ChartRow height={150}>
        <Layers>
          <LineChart series={s} column="fast" as="fast" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
      <ChartRow height={150}>
        <Layers>
          <LineChart series={hrSeries()} column="bpm" axis="bpm" />
        </Layers>
        <YAxis id="bpm" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};
