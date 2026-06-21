import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { LiveSeries } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { ChartContainer } from '../ChartContainer.js';
import { ChartRow } from '../ChartRow.js';
import { Layers } from '../Layers.js';
import { LineChart } from '../LineChart.js';
import { BandChart } from '../BandChart.js';
import { YAxis } from '../YAxis.js';
import { estelaTheme } from '../theme.js';
import {
  BASE,
  STEP_MS,
  liveSampleAt,
  makeBandSeries,
  makeLineSeries,
  makeThreeSeries,
  rangeFor,
} from './generators.js';
import {
  installBench,
  markFirstPaint,
  type StaticScenario,
} from './harness.js';

/**
 * **Performance bench stories — not visual baselines.** These live under
 * `Perf/` and are excluded from the screenshot specs (which name stories
 * explicitly). They exist for the Playwright *perf* spec (`e2e/perf.spec.ts`)
 * to drive at every size × scenario, and they expose a `window.__bench` API the
 * spec reads (see `harness.ts`).
 *
 * Two families:
 *  - **Static** (`StaticRender`) — N points set once; the spec times
 *    mount→first-paint, then programmatic pan/zoom FPS. Drives the competitive
 *    curve (1k…1M) and the pan/zoom interaction metric.
 *  - **Live** (`LiveAppend`) — a `LiveSeries` ring fed at a fixed rate through
 *    the *real* `useSnapshot` path (what consumers use); the spec samples FPS +
 *    heap over a window. This is the **gating invariant** (no heap-growth
 *    trend, no FPS decay), per the RFC's dashboard review.
 *
 * Sizes/scenarios are Storybook **args**, so the spec parameterizes via the
 * story URL (`&args=size:100000;scenario:line`).
 */

// Shared plot geometry — fixed so pan/zoom pixel math is comparable across runs.
const WIDTH = 900;
const HEIGHT = 360;

interface StaticArgs {
  size: number;
  scenario: StaticScenario;
}

/**
 * Renders one static scenario at `size` points and wires the bench hooks:
 * records mount→first-paint and exposes a programmatic pan/zoom driver. The
 * series is built in `useMemo` so its (one-time) construction cost is *outside*
 * the timed mount→paint region — the bench measures the renderer, not pond's
 * row validation.
 */
function StaticRender({ size, scenario }: StaticArgs) {
  // Build the data untimed. The bench timer (markFirstPaint) starts when the
  // chart first paints, below.
  const line = useMemo(
    () => (scenario === 'line' ? makeLineSeries(size) : null),
    [scenario, size],
  );
  const three = useMemo(
    () => (scenario === 'three' ? makeThreeSeries(size) : null),
    [scenario, size],
  );
  const band = useMemo(
    () => (scenario === 'band' ? makeBandSeries(size) : null),
    [scenario, size],
  );

  // Controlled view range so the spec can drive pan/zoom by setting it. Seeded
  // once from the full data extent — the component remounts per dataset (story
  // `key`), so the initializer runs fresh each time; no setState-during-render.
  const [range, setRange] = useState<[number, number]>(() => {
    const [a, b] = rangeFor(size);
    return [a, b];
  });

  // Stamp the data-set mark *during the first render* — NOT in an effect, and
  // NOT after a state update. React runs a child's layout effect before its
  // parent's, and the heavy stroke runs in the descendant `<Canvas>`'s layout
  // effect; a parent effect (or post-setState render) would mark *after* the
  // draw and mis-measure (a bug earlier versions had). Marking in the parent's
  // first render body stamps the instant before any child renders or draws, so
  // the latency spans the whole mount→painted draw. The `key`-driven remount
  // makes this fire exactly once per dataset.
  const marked = useRef(false);
  if (!marked.current) {
    marked.current = true;
    performance.clearMarks('bench:data-set');
    performance.mark('bench:data-set');
  }

  // After mount, kick off the first-paint measurement (it watches rAF cadence
  // for the heavy-draw frame; see markFirstPaint). Runs once per mount.
  useLayoutEffect(() => {
    markFirstPaint();
  }, []);

  // Expose a pan/zoom driver the spec calls to measure interaction FPS. Pans
  // the controlled range by a fraction of its span, or zooms about the centre.
  useEffect(() => {
    installBench({
      pan(fraction) {
        setRange(([a, b]) => {
          const dt = (b - a) * fraction;
          return [a + dt, b + dt];
        });
      },
      zoom(factor) {
        setRange(([a, b]) => {
          const mid = (a + b) / 2;
          return [mid - (mid - a) * factor, mid + (b - mid) * factor];
        });
      },
    });
  }, []);

  return (
    <ChartContainer
      timeRange={range}
      width={WIDTH}
      theme={estelaTheme}
      panZoom
      onTimeRangeChange={setRange}
    >
      <ChartRow height={HEIGHT}>
        <YAxis id="v" label="v" min={0} max={100} />
        <Layers>
          {line && <LineChart series={line} column="v" as="foam" />}
          {three && (
            <>
              <LineChart series={three} column="a" as="foam" />
              <LineChart series={three} column="b" as="hr" />
              <LineChart series={three} column="c" as="elevation" />
            </>
          )}
          {band && (
            <>
              <BandChart series={band} lower="lower" upper="upper" as="inner" />
              <LineChart series={band} column="mid" as="foam" />
            </>
          )}
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

interface LiveArgs {
  /** Points retained in the ring (the visible window width). */
  windowSize: number;
  /** Append interval in ms (100 pts/20ms ≈ 5ms; a slower 100ms tier too). */
  pushMs: number;
  /** Points appended per tick (the references use batches). */
  batch: number;
  scenario: 'line' | 'three';
}

const LIVE_LINE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;
const LIVE_THREE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number' },
  { name: 'b', kind: 'number' },
  { name: 'c', kind: 'number' },
] as const;

/**
 * Seed a full window then append `batch` rows every `pushMs` to `live`, with
 * `sampleRow(n)` building each row. Shared by the line + three-series live
 * bodies so the feed cadence is identical; cleans up its interval on unmount.
 */
function useLiveFeed<R>(
  live: { pushMany(rows: readonly R[]): void },
  windowSize: number,
  pushMs: number,
  batch: number,
  sampleRow: (n: number) => R,
): void {
  useEffect(() => {
    let n = 0;
    const seed: R[] = [];
    for (; n < windowSize; n += 1) seed.push(sampleRow(n));
    live.pushMany(seed);
    const id = setInterval(() => {
      const rows: R[] = [];
      for (let k = 0; k < batch; k += 1, n += 1) rows.push(sampleRow(n));
      live.pushMany(rows);
    }, pushMs);
    // Signal liveness so the spec knows the feed object exists before sampling.
    installBench({});
    return () => clearInterval(id);
    // sampleRow is recreated per render but the feed should restart only on a
    // parameter (identity) change — track those explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, windowSize, pushMs, batch]);
}

/** Read a snapshot's `[start, end]` time extent, or `null` if too short. */
function snapshotRange(
  snapshot: { length: number; keyColumn(): { begin: Float64Array } } | null,
): [number, number] | null {
  if (!snapshot || snapshot.length < 2) return null;
  const begins = snapshot.keyColumn().begin;
  return [begins[0]!, begins[snapshot.length - 1]!];
}

/** Live single-line body (concrete schema → typed `useSnapshot`/`LineChart`). */
function LiveLine({ windowSize, pushMs, batch }: Omit<LiveArgs, 'scenario'>) {
  const live = useMemo(
    () =>
      new LiveSeries({
        name: 'perf-live-line',
        schema: LIVE_LINE_SCHEMA,
        retention: { maxEvents: windowSize },
      }),
    [windowSize],
  );
  useLiveFeed(
    live,
    windowSize,
    pushMs,
    batch,
    (n) => [BASE + n * STEP_MS, liveSampleAt(n, 1)] as const,
  );
  const snapshot = useSnapshot(live, { throttle: 0 });
  const timeRange = snapshotRange(snapshot);
  if (!snapshot || timeRange === null) return null;
  return (
    <ChartContainer
      timeRange={timeRange}
      width={WIDTH}
      theme={estelaTheme}
      cursor="none"
    >
      <ChartRow height={HEIGHT}>
        <YAxis id="v" label="v" min={0} max={100} />
        <Layers>
          <LineChart series={snapshot} column="v" as="foam" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/** Live three-series body (concrete schema → typed snapshot + 3 lines). */
function LiveThree({ windowSize, pushMs, batch }: Omit<LiveArgs, 'scenario'>) {
  const live = useMemo(
    () =>
      new LiveSeries({
        name: 'perf-live-three',
        schema: LIVE_THREE_SCHEMA,
        retention: { maxEvents: windowSize },
      }),
    [windowSize],
  );
  useLiveFeed(
    live,
    windowSize,
    pushMs,
    batch,
    (n) =>
      [
        BASE + n * STEP_MS,
        liveSampleAt(n, 1),
        liveSampleAt(n, 2),
        liveSampleAt(n, 3),
      ] as const,
  );
  const snapshot = useSnapshot(live, { throttle: 0 });
  const timeRange = snapshotRange(snapshot);
  if (!snapshot || timeRange === null) return null;
  return (
    <ChartContainer
      timeRange={timeRange}
      width={WIDTH}
      theme={estelaTheme}
      cursor="none"
    >
      <ChartRow height={HEIGHT}>
        <YAxis id="v" label="v" min={0} max={100} />
        <Layers>
          <LineChart series={snapshot} column="a" as="foam" />
          <LineChart series={snapshot} column="b" as="hr" />
          <LineChart series={snapshot} column="c" as="elevation" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/**
 * A *real* live monitor mirroring a dashboard consumer: a `LiveSeries` with a
 * `maxEvents` ring, fed `batch` samples every `pushMs` through `useSnapshot`
 * (`throttle: 0` — every flush rebuilds the snapshot `TimeSeries`, the data-side
 * cost the RFC's dashboard review flags). The window slides as the ring evicts
 * the oldest. The spec counts frames + samples heap over a fixed window; this is
 * the gating invariant. Dispatches to a concrete-schema body per scenario.
 */
function LiveAppend({ scenario, ...rest }: LiveArgs) {
  return scenario === 'three' ? (
    <LiveThree {...rest} />
  ) : (
    <LiveLine {...rest} />
  );
}

const meta = {
  title: 'Perf/Bench',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

export const Static: StoryObj<StaticArgs> = {
  args: { size: 10_000, scenario: 'line' },
  argTypes: {
    size: { control: { type: 'number' } },
    scenario: { control: 'inline-radio', options: ['line', 'three', 'band'] },
  },
  // `key` per dataset so a size/scenario switch *remounts* — one clean mount draw
  // to measure, no stale view state, no setState-during-render second redraw.
  render: (args) => (
    <StaticRender key={`${args.scenario}:${args.size}`} {...args} />
  ),
};

export const Live: StoryObj<LiveArgs> = {
  args: { windowSize: 1_500, pushMs: 20, batch: 100, scenario: 'line' },
  argTypes: {
    windowSize: { control: { type: 'number' } },
    pushMs: { control: { type: 'number' } },
    batch: { control: { type: 'number' } },
    scenario: { control: 'inline-radio', options: ['line', 'three'] },
  },
  render: (args) => <LiveAppend {...args} />,
};
