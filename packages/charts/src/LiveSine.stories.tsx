import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo } from 'react';
import { LiveSeries } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const WINDOW = 240; // points retained (ring buffer) = visible window
const PERIOD = 40; // samples per sine cycle (~6 cycles on screen)
const PUSH_MS = 16; // ~60 Hz feed
const STEP_MS = 1000; // each sample is 1s of synthetic time

const sampleAt = (n: number) => 50 + 38 * Math.sin((n * 2 * Math.PI) / PERIOD);

/**
 * A *real* live monitor: a `LiveSeries` with a `maxEvents` ring buffer, fed by
 * pushing one sine sample at the end every ~16ms. The chart renders off a
 * `useSnapshot` `TimeSeries`, and the window slides on its own — `timeRange` is
 * derived from the snapshot's retained key extent, and the ring evicts the
 * oldest sample on every push. This is the honest version of the phase-rebuild
 * fake: data flows in at the end, old data ages out, memory stays bounded.
 */
function LiveSineMonitor() {
  const live = useMemo(
    () =>
      new LiveSeries({
        name: 'live',
        schema,
        retention: { maxEvents: WINDOW },
      }),
    [],
  );

  // Seed a full window so it opens populated, then push at the end on a fast
  // interval; the ring buffer drops the oldest so length stays at WINDOW.
  useEffect(() => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let n = 0;
    for (; n < WINDOW; n += 1) live.push([t0 + n * STEP_MS, sampleAt(n)]);
    const id = setInterval(() => {
      live.push([t0 + n * STEP_MS, sampleAt(n)]);
      n += 1;
    }, PUSH_MS);
    return () => clearInterval(id);
  }, [live]);

  const snapshot = useSnapshot(live, { throttle: 0 });
  if (!snapshot || snapshot.length < 2) return null;

  // Slide the time axis with the data: the snapshot's first/last retained key.
  const begins = snapshot.keyColumn().begin;
  const timeRange: [number, number] = [
    begins[0]!,
    begins[snapshot.length - 1]!,
  ];

  return (
    <ChartContainer timeRange={timeRange} width={620} theme={estelaTheme}>
      <ChartRow height={280}>
        <YAxis id="v" label="v" min={0} max={100} />
        <Layers>
          <LineChart series={snapshot} column="v" as="foam" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/**
 * **Animated — not a visual baseline.** Lives under `Playground/` and is left
 * out of the Playwright screenshot specs (which name stories explicitly), so it
 * can move without making the baselines flaky.
 */
const meta = {
  title: 'Playground/LiveSine',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** A live sine streaming in at ~60 Hz, scrolling left as the ring buffer fills. */
export const LiveMonitor: Story = {
  render: () => <LiveSineMonitor />,
};
