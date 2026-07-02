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
 * `cursor="crosshair"` — the trading-terminal readout: a synced vertical line +
 * a dot per series, each series' value pinned to **its y-axis** as an on-axis
 * pill (with a faint dashed connector from the dot to the pill), and the
 * hovered time pinned once to the **x-axis** (drawn by the auto `<XAxis>` —
 * `showAxis` defaults to true, so no story declares it explicitly). These
 * stories fan out: single vs multiple series, dual-axis sides, a left-only
 * axis, and multi-row (the line spans rows, each row pins its own value, the
 * x-time pill shows once on the shared axis). All pinned via a controlled
 * `trackerPosition` for a static shot — no hover.
 *
 * Crosshair puts the time on the x-axis pill only — unlike `flag`/`inline`'s
 * `cursorTime`, there is no per-row time chip to opt into (see `Layers`'s
 * `showTime`, which excludes `chip: 'axis'` so the time never doubles up).
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
