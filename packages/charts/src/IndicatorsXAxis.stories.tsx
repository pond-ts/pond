import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Marker } from './annotations.js';
import {
  priceSeries,
  hrSeries,
  twoColorTheme,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';

/**
 * **X-axis indicators** — a value pinned to the x-axis edge as an on-axis pill.
 * There is no standalone `XAxisIndicator` component; two producers share the
 * one strip drawn by `<XAxis>`:
 *  - **`<Marker indicator>`** — a static x-pill at the marker's `at`, in the
 *    annotation colour. The pill echoes the marker's `label` if one is set,
 *    else the axis's formatted `at` value (also the `label={false}` case).
 *  - **`cursor="crosshair"`** — the hovered time, pinned live to the x-axis
 *    (pinned here via the controlled `trackerPosition` for a static shot).
 * Both pills share one `<XAxis>` per container (not per row), so a marker
 * living inside any one row's `<Layers>` still surfaces on the shared axis —
 * and multiple marker pills get no auto-dedup layout: they just sit at their
 * own x, so pick `at`s with enough separation to stay legible.
 * (The y-axis counterpart is the standalone `<YAxisIndicator>`, under
 * **Indicators/Y Axis**.)
 */
const W = 620;
const at = (i: number) => BASE + i * STEP;

const meta = {
  title: 'Charts/Indicators/X Axis',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Marker pill** — `<Marker indicator label={false}>`: no in-plot chip, just
 *  the marker's time pinned to the x-axis. */
export const MarkerPill: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Marker at={at(45)} indicator label={false} />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Marker pill + chip** — `<Marker indicator>` with no `label` override: the
 *  same formatted time appears twice — once as the near-line chip, once as the
 *  axis pill. Compare with `MarkerPill` (`label={false}`, chip suppressed). */
export const MarkerPillWithChip: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Marker at={at(45)} indicator />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Marker pill (custom label)** — with a `label`, the axis pill echoes it
 *  ("open") instead of the formatted time — same string in the chip and the
 *  pill. */
export const MarkerPillLabelled: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Marker at={at(45)} indicator label="open" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Multiple marker pills** — each `<Marker indicator>` is independent, with
 *  no shared lane-packing (unlike the in-plot chips): three pills, three
 *  labels, placed far enough apart on the x to stay legible. */
export const MultipleMarkerPills: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Marker at={at(10)} indicator label="open" />
          <Marker at={at(45)} indicator label="high" />
          <Marker at={at(80)} indicator label="close" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Marker pill on a second row** — the `<Marker>` lives in the bottom row's
 *  `<Layers>` (it has no `axis` prop of its own — position is x-only), but its
 *  indicator surfaces on the one shared `<XAxis>` beneath both rows. */
export const MarkerPillOnSecondRow: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={150}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
      <ChartRow height={150}>
        <Layers>
          <LineChart series={hrSeries()} column="bpm" axis="bpm" />
          <Marker at={at(55)} indicator label="peak" />
        </Layers>
        <YAxis id="bpm" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Crosshair time** — `cursor="crosshair"` pins the hovered time to the
 *  x-axis (pinned here via `trackerPosition` for a static shot; interactively
 *  it tracks the pointer). */
export const CrosshairTime: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      cursor="crosshair"
      trackerPosition={at(40)}
      theme={twoColorTheme}
    >
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};
