import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { AreaChart } from './AreaChart.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';
import { type GapMode } from './gaps.js';

const N = 48;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step → deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** The five gap modes, in the order the stories stack them top→bottom. */
const MODES: readonly GapMode[] = ['none', 'empty', 'dashed', 'step', 'fade'];

/**
 * A sine value column with a deliberate coast (gap) at indices 14–19 — placed on
 * a **falling slope** (last-good ≈ 67, next-good ≈ 24) so the `step` mode's
 * flat-at-average line is visibly distinct from `dashed`'s diagonal bridge.
 */
function sineWithGap() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 14 && i < 20;
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

const meta = {
  title: 'Charts/GapModes',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * The shared gap-rendering modes on a **line**, stacked top→bottom in the order
 * `none, empty, dashed, step, fade`, all on `docsTheme`. Each row is the same
 * sine with the same coast (indices 14–19, on a falling slope); only `gaps`
 * differs — so the five renderings of one gap sit directly comparable:
 *
 * - `none` bridges straight across (interpolated).
 * - `empty` (default) leaves a clean break.
 * - `dashed` breaks, then a faint dashed diagonal across the hole (last → next).
 * - `step` breaks, then a faint flat dashed line at the **average** of the two
 *   edge values (`- - -`) — flatter than `dashed`'s diagonal.
 * - `fade` is estela's fade-to-baseline at each gap edge.
 *
 * (`dashed` / `step` render faint via `theme.gap.connectorOpacity`.)
 */
export const Line: Story = {
  render: () => {
    const s = sineWithGap();
    return (
      <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
        {MODES.map((mode) => (
          <ChartRow key={mode} height={90}>
            <YAxis id="v" label={mode} min={0} max={100} />
            <Layers>
              <LineChart series={s} column="v" as="primary" gaps={mode} />
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
      <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
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
