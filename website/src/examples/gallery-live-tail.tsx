import { useEffect, useRef } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  YAxisIndicator,
  createLiveValue,
} from '@pond-ts/charts';
import { LiveSeries } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  requestRateSource,
  tailSchema,
  TAIL_RETENTION,
  TAIL_STEP_MS,
} from './lib/ops-fixtures';

/**
 * The live tail: a `LiveSeries` with a retention window, pushed into as data
 * arrives, and a `YAxisIndicator` pinned to the leading edge showing the
 * current value.
 *
 * This is the one card on the page that is genuinely streaming — the window
 * really is moving because events really are arriving, not because a range is
 * being swept across a table.
 *
 * Three things make it a *live* chart rather than a chart you redraw:
 *
 * - **`retention`** bounds the buffer, so a tail that runs all day doesn't
 *   grow all day. Old events evict; the chart's range follows the survivors.
 * - **`useSnapshot(live, { throttle })`** decouples arrival rate from render
 *   rate. Pushes coalesce into one re-render per throttle window.
 * - **`createLiveValue` + `YAxisIndicator source`** is a side channel for the
 *   number itself: the pill repaints without the chart re-rendering, which is
 *   what lets the readout stay at arrival rate while the line stays at
 *   render rate.
 *
 * **Motion budget.** When the Gallery card supplies a `phase`, the pushes are
 * driven off it — and the card's autoplay clock stops while the card is off
 * screen, so an off-screen live tail stops doing work instead of streaming
 * into a buffer nobody is looking at. Standalone (no `phase`) it uses its own
 * interval.
 */
export default function GalleryLiveTail({
  width,
  phase,
  height = 200,
}: {
  width: number;
  phase?: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();

  const live = useRef(
    new LiveSeries({
      name: 'live-rps',
      schema: tailSchema,
      retention: { maxEvents: TAIL_RETENTION },
    }),
  ).current;
  const nextRate = useRef(requestRateSource()).current;
  const pill = useRef(createLiveValue(0)).current;

  // One push: advance the generator, append the event, update the pill.
  const push = useRef(() => {
    const rps = nextRate();
    live.push([Date.now(), rps]);
    pill.set(rps);
  }).current;

  // Seed enough history that the first frame is a line, not a dot.
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    const now = Date.now();
    for (let i = TAIL_RETENTION - 1; i >= 0; i -= 1) {
      const rps = nextRate();
      live.push([now - i * TAIL_STEP_MS, rps]);
      pill.set(rps);
    }
  }

  // Phase-driven when the card supplies one (so it pauses off screen), a plain
  // interval otherwise.
  const tick = useRef(-1);
  useEffect(() => {
    if (phase === undefined) return;
    const frame = Math.floor(phase * PUSHES_PER_LOOP);
    if (frame === tick.current) return;
    tick.current = frame;
    push();
  }, [phase, push]);

  useEffect(() => {
    if (phase !== undefined) return;
    const id = setInterval(push, TAIL_STEP_MS);
    return () => clearInterval(id);
    // `phase` is either always or never undefined for a given mount, so this
    // never swaps drivers mid-life.
  }, [phase, push]);

  const snapshot = useSnapshot(live, { throttle: 250 });
  if (snapshot === null || snapshot.length < 2) {
    return <div style={{ height }} />;
  }

  return (
    <ChartContainer
      range={snapshot.timeRange()}
      width={width}
      theme={theme}
      cursor="line"
    >
      <ChartRow height={height}>
        <YAxis id="rps" side="right" label="req/s" format=",.0f" width={54} />
        <Layers>
          <LineChart series={snapshot} column="rps" axis="rps" />
          <YAxisIndicator
            source={pill}
            axis="rps"
            color={theme.line.default.color}
            format=",.0f"
            line
            pointer
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/** Samples pushed per autoplay loop. With the card's 14 s period that is a
 *  push roughly every 200 ms — fast enough to read as a stream, slow enough
 *  that the shared clock isn't doing a push per frame. */
const PUSHES_PER_LOOP = 70;
