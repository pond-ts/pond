import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';
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
 * M4 interaction stories — the cursor tracker. The cursor lives on a per-row
 * overlay canvas above the data; the hovered time + every series' value live on
 * `ChartContainer`, so the cursor syncs across rows and the values can be
 * surfaced *outside* the chart. Presentation is the **`cursor` mode**
 * (`'line' | 'point' | 'inline' | 'flag' | 'none'`) — set on the container
 * (default `'line'`) or per-row. `'flag'` raises a staff from each data point to
 * a value flag stacked near the top.
 */
const meta = {
  title: 'Charts/Cursors/Scenarios',
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
          <LineChart series={demo(0)} column="v" as="primary" />
        </Layers>
      </ChartRow>
      <ChartRow height={130}>
        <YAxis id="b" label="hr" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="secondary" />
        </Layers>
      </ChartRow>
    </>
  );
}

/**
 * **Cross-row cursor sync (default `cursor='line'`).** Hover the plot — the
 * synced vertical line spans both rows (shared x), no marks over the data.
 * Surface the values outside via `onTrackerChanged` (see `OutsideReadout`).
 * (Apps can also drive the cursor with `trackerPosition` — an external time
 * slider, a video playhead — but hovering is the common case.)
 */
export const CursorSync: Story = {
  render: () => (
    <ChartContainer range={TIME_RANGE} width={560} theme={docsTheme}>
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **`cursor='flag'`.** Hover the plot — a staff rises from each data point to a
 * value flag stacked near the top, kept out of the data's way.
 */
export const FlagReadout: Story = {
  render: () => (
    <ChartContainer
      range={TIME_RANGE}
      width={560}
      theme={docsTheme}
      cursor="flag"
    >
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **`cursor='inline'`.** Hover the plot — dots + a value chip beside each at the
 * point's height. Most direct, but it sits over the data — the "chart ick" the
 * others avoid.
 */
export const InlineReadout: Story = {
  render: () => (
    <ChartContainer
      range={TIME_RANGE}
      width={560}
      theme={docsTheme}
      cursor="inline"
    >
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **`cursor='point'`.** Hover the plot — a dot rides each series at the cursor,
 * no line and no text. Pair with an off-chart readout for the values.
 */
export const PointCursor: Story = {
  render: () => (
    <ChartContainer
      range={TIME_RANGE}
      width={560}
      theme={docsTheme}
      cursor="point"
    >
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **Axis `format` — d3 specifiers + a custom fn, each matched by the readout.**
 * `cursor='inline'`, so every row's readout uses the *same* formatter as its
 * ticks: a percent (`.0%`), a grouped thousands (`,.0f`), an SI prefix (`.2s`),
 * and a custom `(v) => \`${v} ms\`` function. The last row is **dual-axis** —
 * `%` left, count right — proving the formatter is resolved **per axis**. (Axis
 * labels render rotated by default.)
 */
export const Formats: Story = {
  render: () => (
    <ChartContainer
      range={TIME_RANGE}
      width={560}
      theme={docsTheme}
      cursor="inline"
    >
      <ChartRow height={90}>
        <YAxis id="pct" label="ratio" min={0} max={1} format=".0%" />
        <Layers>
          <LineChart series={demo(0, 0.4, 0.5)} column="v" as="primary" />
        </Layers>
      </ChartRow>
      <ChartRow height={90}>
        <YAxis
          id="k"
          label="requests"
          min={0}
          max={100000}
          format=",.0f"
          width={70}
        />
        <Layers>
          <LineChart series={demo(0.5, 40000, 50000)} column="v" as="primary" />
        </Layers>
      </ChartRow>
      <ChartRow height={90}>
        <YAxis
          id="si"
          label="bytes"
          min={0}
          max={100000}
          format=".2s"
          width={70}
        />
        <Layers>
          <LineChart series={demo(1, 40000, 50000)} column="v" as="primary" />
        </Layers>
      </ChartRow>
      <ChartRow height={90}>
        <YAxis id="ms" label="latency" format={(v) => `${Math.round(v)} ms`} />
        <Layers>
          <LineChart series={demo(1.5, 40, 50)} column="v" as="primary" />
        </Layers>
      </ChartRow>
      <ChartRow height={90}>
        <YAxis id="L" label="ratio" min={0} max={1} format=".0%" />
        {/* Authored before <Layers> but side="right" → ChartRow places it on the
            right; placement follows `side`, not JSX order. */}
        <YAxis
          id="R"
          side="right"
          label="count"
          min={0}
          max={1000}
          format=",.0f"
          width={55}
        />
        <Layers>
          <LineChart
            series={demo(0, 0.4, 0.5)}
            column="v"
            as="primary"
            axis="L"
          />
          <LineChart
            series={demo(2, 400, 500)}
            column="v"
            as="secondary"
            axis="R"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Cursor time (`cursorTime`).** Hover — the cursor's time shows **once, atop
 * the first row's readout** (it's shared across rows), formatted to match the
 * time axis. Here `timeFormat='%I:%M %p'` (reads `12:30 PM`); omit it for d3's
 * multi-scale default. Works with any readout mode (shown with `flag`).
 */
export const CursorTime: Story = {
  render: () => (
    <ChartContainer
      range={TIME_RANGE}
      width={560}
      theme={docsTheme}
      cursor="flag"
      cursorTime
      timeFormat="%I:%M %p"
    >
      <Rows />
    </ChartContainer>
  ),
};

/**
 * **The preferred surface: readout *outside* the chart.** The default
 * `cursor='line'` (line only, no in-chart values); `onTrackerChanged` feeds a
 * panel above the chart. Hover — the panel updates with the time + each series'
 * value, color-matched.
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
          fontFamily: docsTheme.font.family,
          fontSize: '12px',
          color: docsTheme.axis.label,
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
        range={TIME_RANGE}
        width={560}
        theme={docsTheme}
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
 * **Controlled cursor (`trackerPosition`).** The other half of the tracker API:
 * the app owns the cursor. Here a slider drives it — the way an external time
 * control or a video playhead would — moving the synced cursor across both rows
 * with no pointer involved. (The mode stories above drive the same cursor from
 * hover.)
 */
function ControlledCursorDemo() {
  const [t, setT] = useState(BASE + 30 * STEP);
  return (
    <div>
      <input
        type="range"
        min={TIME_RANGE[0]}
        max={TIME_RANGE[1]}
        step={STEP}
        value={t}
        onChange={(e) => setT(Number(e.target.value))}
        style={{ display: 'block', width: '560px', marginBottom: '8px' }}
      />
      <ChartContainer
        range={TIME_RANGE}
        width={560}
        theme={docsTheme}
        trackerPosition={t}
      >
        <Rows />
      </ChartContainer>
    </div>
  );
}

export const ControlledCursor: Story = {
  render: () => <ControlledCursorDemo />,
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
      range={TIME_RANGE}
      width={560}
      theme={docsTheme}
      panZoom
      minDuration={2 * STEP}
    >
      <Rows />
    </ChartContainer>
  ),
};
