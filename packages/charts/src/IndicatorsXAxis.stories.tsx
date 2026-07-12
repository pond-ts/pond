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
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';

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
 * and overlapping marker pills **stack into lanes** (they share the one strip).
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
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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

/** **Multiple marker pills** — three `<Marker indicator>`s spread across the x;
 *  far enough apart that each pill sits in the base lane. */
export const MultipleMarkerPills: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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

/** **Stacked pills** — markers close in time overlap on the shared strip, so the
 *  pills **stack into lanes** (each connector lengthens to its lane) instead of
 *  colliding. */
export const StackedPills: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Marker at={at(44)} indicator label={false} />
          <Marker at={at(46)} indicator label={false} />
          <Marker at={at(48)} indicator label={false} />
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
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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
      theme={docsTheme}
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
