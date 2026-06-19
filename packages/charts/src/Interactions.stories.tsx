import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';
import type { TrackerInfo } from './context.js';

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
 * M4 interaction stories — the cursor tracker. The crosshair lives on a per-row
 * overlay canvas above the data; the hovered time + every series' value live on
 * `ChartContainer`, so the cursor syncs across rows and the values can be
 * surfaced *outside* the chart. The in-chart value display is opt-in
 * (`readout='none' | 'flag' | 'inline'`); the default keeps values out of the plot.
 */
const meta = {
  title: 'Interactions',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** Two rows of data; reused across the readout-mode stories. */
function Rows() {
  return (
    <>
      <ChartRow height={130}>
        <YAxis id="a" label="power" />
        <Layers>
          <LineChart series={demo(0)} column="v" as="foam" />
        </Layers>
      </ChartRow>
      <ChartRow height={130}>
        <YAxis id="b" label="hr" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="hr" />
        </Layers>
      </ChartRow>
    </>
  );
}

/**
 * **Cross-row cursor sync (default `readout='none'`).** Hover the plot — the
 * crosshair + per-series dots sync across both rows (shared x), but no value text
 * sits over the data. Surface the values outside via `onTrackerChanged` (see
 * `OutsideReadout`). (Apps can also drive the cursor with `trackerPosition` — an
 * external time slider, a video playhead — but hovering is the common case.)
 */
export const CursorSync: Story = {
  render: () => (
    <ChartContainer timeRange={TIME_RANGE} width={560} theme={estelaTheme}>
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **`readout='flag'`.** Hover the plot — value chips stack at the top of the
 * crosshair, in-chart but kept to the top edge, out of the data's way.
 */
export const FlagReadout: Story = {
  render: () => (
    <ChartContainer
      timeRange={TIME_RANGE}
      width={560}
      theme={estelaTheme}
      readout="flag"
    >
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **`readout='inline'`.** Hover the plot — a value chip sits beside each dot at
 * the point's height. Most direct, but it sits over the data — the "chart ick"
 * the others avoid.
 */
export const InlineReadout: Story = {
  render: () => (
    <ChartContainer
      timeRange={TIME_RANGE}
      width={560}
      theme={estelaTheme}
      readout="inline"
    >
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **The preferred surface: readout *outside* the chart.** No in-chart values
 * (`readout='none'`); `onTrackerChanged` feeds a panel above the chart. Hover the
 * plot — the panel updates with the time + each series' value, color-matched.
 */
function OutsideReadoutDemo() {
  const [info, setInfo] = useState<TrackerInfo | null>(null);
  const clock =
    info === null ? '' : new Date(info.time).toISOString().slice(11, 16);
  return (
    <div>
      <div
        style={{
          height: '18px',
          marginBottom: '8px',
          display: 'flex',
          gap: '16px',
          fontFamily: estelaTheme.font.family,
          fontSize: '12px',
          color: estelaTheme.axis.label,
        }}
      >
        {info === null ? (
          <span style={{ opacity: 0.5 }}>hover the chart…</span>
        ) : (
          <>
            <span>{clock} UTC</span>
            {info.values.map((v) => (
              <span key={v.label} style={{ color: v.color }}>
                {v.label} {Math.round(v.value * 100) / 100}
              </span>
            ))}
          </>
        )}
      </div>
      <ChartContainer
        timeRange={TIME_RANGE}
        width={560}
        theme={estelaTheme}
        onTrackerChanged={setInfo}
      >
        <Rows />
      </ChartContainer>
    </div>
  );
}

export const OutsideReadout: Story = {
  render: () => <OutsideReadoutDemo />,
};

/**
 * **Pan / zoom (uncontrolled).** `panZoom` with no `onTimeRangeChange` — the
 * container holds the view internally, so it works standalone: drag to pan the
 * time range, wheel to zoom around the cursor (to a 2-minute floor). The tracker
 * still works on hover and suppresses mid-pan; both rows move together (shared x).
 */
export const PanZoom: Story = {
  render: () => (
    <ChartContainer
      timeRange={TIME_RANGE}
      width={560}
      theme={estelaTheme}
      panZoom
      minDuration={2 * STEP}
    >
      <Rows />
    </ChartContainer>
  ),
};
