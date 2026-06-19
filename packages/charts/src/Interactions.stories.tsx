import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';

const N = 60;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step → deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

function demo(phase = 0, amp = 40, mid = 50) {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1)
    rows.push([BASE + i * STEP, mid + amp * Math.sin(i / 5 + phase)]);
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

/**
 * Stories for M4 interactions — the cursor tracker (and, as they land, pan/zoom
 * and brush). The tracker is a crosshair drawn on a per-row overlay canvas above
 * the data; the hovered time lives on `ChartContainer`, so every row reads it and
 * the cursor syncs across rows.
 */
const meta = {
  title: 'Interactions',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * **Cross-row cursor sync.** `trackerPosition` pins the tracker at a fixed time
 * (12:30) so the synced crosshair shows deterministically across all three rows
 * — the same x under one time axis, on the bright `--es-reef` cursor colour.
 */
export const CursorSync: Story = {
  render: () => (
    <ChartContainer
      timeRange={TIME_RANGE}
      width={560}
      theme={estelaTheme}
      trackerPosition={BASE + 30 * STEP}
    >
      <ChartRow height={120}>
        <YAxis id="a" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" as="foam" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="b" label="v" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="hr" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="c" label="v" />
        <Layers>
          <LineChart series={demo(3)} column="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Uncontrolled tracker.** No `trackerPosition` — hover the plot and the chart
 * tracks the pointer itself, broadcasting the time to both rows (move over the
 * top row, the bottom row's crosshair follows). The data canvas never repaints
 * on hover; only the overlay does.
 */
export const Interactive: Story = {
  render: () => (
    <ChartContainer timeRange={TIME_RANGE} width={560} theme={estelaTheme}>
      <ChartRow height={150}>
        <YAxis id="a" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" as="foam" />
        </Layers>
      </ChartRow>
      <ChartRow height={150}>
        <YAxis id="b" label="v" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="hr" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
