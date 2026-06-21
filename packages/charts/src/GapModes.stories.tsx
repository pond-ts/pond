import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { AreaChart } from './AreaChart.js';
import { BandChart } from './BandChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';
import { type GapMode } from './gaps.js';

const N = 48;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step → deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** The five gap modes, in the order the stories stack them top→bottom. */
const MODES: readonly GapMode[] = ['none', 'empty', 'dashed', 'step', 'fade'];

/** A sine value column with a deliberate coast (gap) from index 20–27. */
function sineWithGap() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 20 && i < 28;
    rows.push([BASE + i * STEP, inGap ? undefined : 50 + 34 * Math.sin(i / 5)]);
  }
  return new TimeSeries({
    name: 'gap',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

/** A lo/hi envelope with the same coast — for the band gap-mode story. */
function bandWithGap() {
  const rows: Array<[number, number | undefined, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 20 && i < 28;
    const mid = 50 + 26 * Math.sin(i / 5);
    rows.push([
      BASE + i * STEP,
      inGap ? undefined : mid - 12,
      inGap ? undefined : mid + 12,
    ]);
  }
  return new TimeSeries({
    name: 'gapband',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'lo', kind: 'number', required: false },
      { name: 'hi', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

const meta = {
  title: 'Charts/GapModes',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * The shared gap-rendering modes on a **line**, stacked top→bottom in the order
 * `none, empty, dashed, step, fade`, all on `estelaTheme`. Each row is the same
 * sine with the same coast (indices 20–27); only `gaps` differs — so the five
 * renderings of one gap sit directly comparable:
 *
 * - `none` bridges straight across (interpolated).
 * - `empty` (default) leaves a clean break.
 * - `dashed` breaks, then dashes across the hole.
 * - `step` breaks, then a dashed step drops to the axis floor and back.
 * - `fade` is estela's fade-to-baseline at each gap edge.
 */
export const Line: Story = {
  render: () => {
    const s = sineWithGap();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={520} theme={estelaTheme}>
        {MODES.map((mode) => (
          <ChartRow key={mode} height={90}>
            <YAxis id="v" label={mode} min={0} max={100} />
            <Layers>
              <LineChart series={s} column="v" as="foam" gaps={mode} />
            </Layers>
          </ChartRow>
        ))}
      </ChartContainer>
    );
  },
};

/**
 * The same five modes on an **area** (elevation form — rests on the axis floor).
 * In every mode the *fill* obeys the mode (only `none` fills across the gap); the
 * `dashed` / `step` / `fade` connectors apply to the **outline** while the fill
 * stays broken — so the shade is always honest about the gap.
 */
export const Area: Story = {
  render: () => {
    const s = sineWithGap();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={520} theme={estelaTheme}>
        {MODES.map((mode) => (
          <ChartRow key={mode} height={90}>
            <YAxis id="v" label={mode} min={0} max={100} />
            <Layers>
              <AreaChart series={s} column="v" as="default" gaps={mode} />
            </Layers>
          </ChartRow>
        ))}
      </ChartContainer>
    );
  },
};

/**
 * The same five modes on a **band** (a lo/hi envelope). `none` fills the envelope
 * across the gap; the inferred-connector modes keep the fill broken and bridge
 * **both** edges (a band has two boundaries). The band carries no baseline, so
 * `step` / `fade` drop to the axis floor.
 */
export const Band: Story = {
  render: () => {
    const b = bandWithGap();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={520} theme={estelaTheme}>
        {MODES.map((mode) => (
          <ChartRow key={mode} height={90}>
            <YAxis id="v" label={mode} min={0} max={100} />
            <Layers>
              <BandChart
                series={b}
                lower="lo"
                upper="hi"
                as="inner"
                gaps={mode}
              />
            </Layers>
          </ChartRow>
        ))}
      </ChartContainer>
    );
  },
};
