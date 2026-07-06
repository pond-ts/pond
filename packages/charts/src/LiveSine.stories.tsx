import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { LiveSeries } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme, type ChartTheme } from './theme.js';
import type { CursorMode, TrackerInfo } from './context.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const STEP_MS = 1000; // each sample is 1s of synthetic time
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** A clean light theme: white ground, black trace, grey chrome — the foil to
 *  estela's dark palette (the "light/dark" toggle). `as="foam"` falls back to
 *  `default`, so the live line renders black here. */
const lightTheme: ChartTheme = {
  background: '#ffffff',
  line: { default: { color: '#111827', width: 1.5 } },
  band: { default: { fill: '#111827', opacity: 0.12 } },
  area: {
    default: {
      color: '#111827',
      width: 1.5,
      fill: '#111827',
      fillOpacity: 0.3,
    },
  },
  scatter: {
    default: {
      color: '#111827',
      radius: 4,
      outline: '#ffffff',
      outlineWidth: 1,
      selectedOutline: '#111827',
      selectedWidth: 2,
      label: '#374151',
    },
  },
  box: {
    default: {
      fill: '#111827',
      fillOpacity: 0.25,
      stroke: '#111827',
      strokeWidth: 1.5,
      median: '#111827',
      medianWidth: 2,
      whisker: '#111827',
      whiskerWidth: 1.5,
    },
  },
  candle: {
    default: {
      rising: { body: '#111827', wick: '#374151' },
      falling: { body: '#9ca3af', wick: '#4b5563' },
      wickWidth: 1,
    },
  },
  bar: {
    default: {
      fill: '#111827',
      opacity: 0.85,
      highlight: '#000000',
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
    },
  },
  axis: { label: '#6b7280', grid: '#e5e7eb', gridDash: [2, 2] },
  font: { family: 'system-ui, -apple-system, sans-serif', size: 11 },
  cursor: '#6b7280',
  chip: { background: '#ffffff' },
};

interface LiveSineArgs {
  amplitude: number;
  period: number;
  midline: number;
  pushMs: number;
  windowSize: number;
  /** Cursor method: in-chart `line`/`point`/`inline`/`flag`, or a panel `outside`. */
  cursor: CursorMode | 'outside';
  theme: 'estela' | 'light';
}

/**
 * A *real* live monitor: a `LiveSeries` with a `maxEvents` ring buffer, fed one
 * sine sample at the end every `pushMs`. The chart renders off a `useSnapshot`
 * `TimeSeries`; the window slides on its own (`timeRange` from the retained key
 * extent) and the ring evicts the oldest sample on every push. Every control
 * restarts the feed with fresh parameters.
 */
function LiveSineMonitor({
  amplitude,
  period,
  midline,
  pushMs,
  windowSize,
  cursor,
  theme: themeName,
}: LiveSineArgs) {
  const theme = themeName === 'light' ? lightTheme : estelaTheme;
  const outside = cursor === 'outside';
  const [info, setInfo] = useState<TrackerInfo | null>(null);

  // A fresh series per parameter set, so changing any control restarts the feed
  // cleanly (no stale ring contents or out-of-order timestamps).
  const live = useMemo(
    () =>
      new LiveSeries({
        name: 'live',
        schema,
        retention: { maxEvents: windowSize },
      }),
    [windowSize, amplitude, period, midline, pushMs],
  );

  useEffect(() => {
    const sampleAt = (n: number) =>
      midline + amplitude * Math.sin((n * 2 * Math.PI) / period);
    let n = 0;
    // Seed a full window so it opens populated, then push at the end.
    for (; n < windowSize; n += 1) live.push([T0 + n * STEP_MS, sampleAt(n)]);
    const id = setInterval(() => {
      live.push([T0 + n * STEP_MS, sampleAt(n)]);
      n += 1;
    }, pushMs);
    return () => clearInterval(id);
  }, [live, amplitude, period, midline, pushMs, windowSize]);

  const snapshot = useSnapshot(live, { throttle: 0 });
  if (!snapshot || snapshot.length < 2) return null;

  const begins = snapshot.keyColumn().begin;
  const timeRange: [number, number] = [
    begins[0]!,
    begins[snapshot.length - 1]!,
  ];
  // Frame the wave from the controls (stable, unlike a breathing auto-domain).
  const pad = Math.max(5, amplitude * 0.15);
  const yMin = midline - amplitude - pad;
  const yMax = midline + amplitude + pad;

  return (
    <div style={{ width: '620px' }}>
      {outside && (
        <div
          style={{
            display: 'flex',
            gap: '16px',
            marginBottom: '8px',
            padding: '3px 8px',
            borderRadius: '4px',
            background: theme.background,
            fontFamily: theme.font.family,
            fontSize: '12px',
            color: theme.axis.label,
          }}
        >
          {info === null ? (
            <span style={{ opacity: 0.5 }}>hover the chart…</span>
          ) : (
            <>
              <span>{new Date(info.time).toISOString().slice(11, 19)} UTC</span>
              {info.values.map((v) => (
                <span key={v.label} style={{ color: v.color }}>
                  {v.label} {Math.round(v.value * 100) / 100}
                </span>
              ))}
            </>
          )}
        </div>
      )}
      <ChartContainer
        range={timeRange}
        width={620}
        theme={theme}
        cursor={outside ? 'line' : cursor}
        {...(outside ? { onTrackerChanged: setInfo } : {})}
      >
        <ChartRow height={280}>
          <YAxis id="v" label="v" min={yMin} max={yMax} />
          <Layers>
            <LineChart series={snapshot} column="v" as="foam" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

/**
 * **Animated playground — not a visual baseline.** Lives under `Playground/` and
 * is left out of the Playwright screenshot specs (which name stories explicitly),
 * so it can move without making the baselines flaky. Drive the sine, the tooltip
 * method, and the theme from the Storybook controls.
 */
const meta = {
  title: 'Playground/LiveSine',
  parameters: { layout: 'centered' },
  args: {
    amplitude: 38,
    period: 40,
    midline: 50,
    pushMs: 16,
    windowSize: 240,
    cursor: 'line',
    theme: 'estela',
  },
  argTypes: {
    amplitude: { control: { type: 'range', min: 5, max: 50, step: 1 } },
    period: {
      control: { type: 'range', min: 10, max: 160, step: 2 },
      description: 'Samples per sine cycle (higher = slower wave).',
    },
    midline: { control: { type: 'range', min: 10, max: 90, step: 1 } },
    pushMs: {
      control: { type: 'range', min: 8, max: 250, step: 2 },
      description: 'Feed interval in ms (lower = faster scroll).',
    },
    windowSize: {
      control: { type: 'range', min: 60, max: 600, step: 20 },
      description: 'Points retained (the visible window width).',
    },
    cursor: {
      control: 'inline-radio',
      options: ['line', 'point', 'inline', 'flag', 'outside'],
      description:
        'Cursor method — in-chart line/point/inline/flag, or a panel outside.',
    },
    theme: { control: 'inline-radio', options: ['estela', 'light'] },
  },
} satisfies Meta<typeof LiveSineMonitor>;

export default meta;
type Story = StoryObj<typeof LiveSineMonitor>;

/** A live sine streaming in, scrolling left as the ring buffer fills. */
export const LiveMonitor: Story = {
  render: (args) => <LiveSineMonitor {...args} />,
};
