import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { AreaChart } from './AreaChart.js';
import { BandChart } from './BandChart.js';
import { XAxis } from './XAxis.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';
import {
  WIDTH,
  provider,
  gappingTicks,
  weekdaySessions,
  rangeOf,
} from './tradingAxis.fixture.js';

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 1_000; // 1s grid

/**
 * A large noisy series — `n` points of a slow sine carrying fast noise, so the
 * min/max envelope per pixel column is wide (the case M4 exists to render
 * faithfully). One deterministic single-sample **spike** at `spikeAt` (value
 * `spikeTo`) so a story can show M4 preserves anomalies LTTB would drop.
 */
function bigSeries(n: number, spikeAt = -1, spikeTo = 0) {
  const rows: Array<[number, number]> = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const base = 50 + 35 * Math.sin(i / (n / 20)) + 8 * Math.sin(i / 3.1);
    rows[i] = [BASE + i * STEP, i === spikeAt ? spikeTo : base];
  }
  return new TimeSeries({
    name: 'big',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

const meta: Meta<typeof LineChart> = {
  title: 'Performance/Decimation',
  component: LineChart,
  parameters: { layout: 'centered' },
};
export default meta;
type Story = StoryObj<typeof LineChart>;

const N = 200_000;
const series = bigSeries(N);
const spiky = bigSeries(N, Math.floor(N / 2), 130);

/** A large series with a wide **gap** (a NaN run) in the middle third, so the
 *  §2.2 gap-edge union is exercised under decimation (the gap must break, and the
 *  `dashed` connector must still bridge it). */
function gappyBig(n: number) {
  const rows: Array<[number, number | undefined]> = new Array(n);
  const gapFrom = Math.floor(n * 0.45);
  const gapTo = Math.floor(n * 0.55);
  for (let i = 0; i < n; i += 1) {
    const v = 50 + 35 * Math.sin(i / (n / 20)) + 8 * Math.sin(i / 3.1);
    rows[i] = [BASE + i * STEP, i >= gapFrom && i < gapTo ? undefined : v];
  }
  return new TimeSeries({
    name: 'gappy',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}
const gappy = gappyBig(N);

/** A large series with a noisy variance envelope (lower/upper) for band + area. */
function bigBand(n: number) {
  const rows: Array<[number, number, number, number]> = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const mid = 50 + 30 * Math.sin(i / (n / 20));
    const spread = 8 + 6 * Math.sin(i / 3.1) ** 2;
    rows[i] = [BASE + i * STEP, mid, mid - spread, mid + spread];
  }
  return new TimeSeries({
    name: 'bandbig',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'mid', kind: 'number' },
      { name: 'lo', kind: 'number' },
      { name: 'hi', kind: 'number' },
    ] as const,
    rows,
  });
}
const bandSeries = bigBand(N);

/** Auto-decimation (default) — 200k points drawn from the per-pixel M4 buckets. */
export const Default: Story = {
  render: () => (
    <ChartContainer width={720} theme={docsTheme} panZoom>
      <ChartRow height={260}>
        <Layers>
          <LineChart series={series} column="v" as="power" />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/** Same 200k series with decimation OFF — the full-resolution draw, for a
 *  side-by-side visual check that auto-decimation is lossless. */
export const Off: Story = {
  render: () => (
    <ChartContainer width={720} theme={docsTheme} panZoom>
      <ChartRow height={260}>
        <Layers>
          <LineChart series={series} column="v" as="power" decimate={false} />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/** A single-sample spike in a 200k series — M4's min/max buckets keep it, so the
 *  anomaly still reads (the property that rules LTTB out as the default). */
export const SpikePreserved: Story = {
  render: () => (
    <ChartContainer width={720} theme={docsTheme} panZoom>
      <ChartRow height={260}>
        <Layers>
          <LineChart series={spiky} column="v" as="power" />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/** A 200k series with a wide gap + `gaps="dashed"`, decimated — the §2.2 gap-edge
 *  union makes the gap break precisely and the dashed connector still bridges it. */
export const GappyDashed: Story = {
  render: () => (
    <ChartContainer width={720} theme={docsTheme} panZoom>
      <ChartRow height={260}>
        <Layers>
          <LineChart series={gappy} column="v" as="power" gaps="dashed" />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/** A 200k-point filled area, auto-decimated (the outline is M4-decimated; the
 *  fill follows it under the full-series gradient). */
export const Area: Story = {
  render: () => (
    <ChartContainer width={720} theme={docsTheme} panZoom>
      <ChartRow height={260}>
        <Layers>
          <AreaChart series={series} column="v" as="power" />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/** A 200k-point variance band, auto-decimated to the per-column min-lower /
 *  max-upper envelope, with the median line over it. */
export const Band: Story = {
  render: () => (
    <ChartContainer width={720} theme={docsTheme} panZoom>
      <ChartRow height={260}>
        <Layers>
          <BandChart series={bandSeries} lower="lo" upper="hi" />
          <LineChart series={bandSeries} column="mid" as="power" />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

// A dense line on a TRADING-TIME axis (collapsed overnight gaps) with
// `sessionBreaks` — the Tidal case: ~40k points over 5 sessions, each opening a
// price jump above the last. Decimation unions the session-break instants into
// the bucket edges, so it decimates AND breaks cleanly per session.
const tradingSessions = weekdaySessions(5);
const tradingLine = gappingTicks(tradingSessions, 3_000); // 3s ticks

/** ~40k-point line on a trading-time axis with `sessionBreaks`, decimated —
 *  breaks cleanly at each session open (no connector across the collapsed gap). */
export const TradingSessionBreaks: Story = {
  render: () => (
    <ChartContainer
      width={WIDTH}
      range={rangeOf(tradingSessions)}
      discontinuities={provider(tradingSessions)}
      theme={docsTheme}
      panZoom
    >
      <ChartRow height={260}>
        <YAxis id="p" side="right" />
        <Layers>
          <LineChart
            series={tradingLine}
            column="price"
            as="power"
            axis="p"
            sessionBreaks
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
