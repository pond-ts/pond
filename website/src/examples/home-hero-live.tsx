import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { LiveSeries } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  PlayButton,
  ToggleChips,
} from '@site/src/components/ConceptViz';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

/** A tiny deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return b;
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const PUSH_MS = 140;
const WINDOW_MS = 14_000;
const MAX_EVENTS = 220;
const HEIGHT = 260;

/**
 * The homepage hero. Raw points stream in (blue); a real
 * `smooth('value', 'movingAverage', …)` draws the trend line through them.
 * The **clip** toggle runs the platform's whole pitch in one flip: a
 * `baseline()` pass finds the outliers, `filter()` drops them from the line's
 * input, and the dropped points stay behind as red dots — analytics options,
 * not chart props. The view scrolls on a rAF clock (end = now), so motion is
 * smooth regardless of the data's arrival rate.
 */
export default function HomeHeroLive() {
  const base = useSiteChartTheme();
  const blue = base.line?.secondary?.color ?? '#3d6fd9';
  // Canvas fillStyle can't resolve CSS vars — use the theme's already-resolved
  // viz-down red (the falling-candle body) rather than 'var(--pond-viz-down)'.
  const red = base.candle?.default?.falling?.body ?? '#d8473f';

  const theme = useMemo(() => {
    const softBlue = mix(base.background ?? '#ffffff', blue, 0.55);
    return {
      ...base,
      line: {
        ...base.line,
        trend: { color: blue, width: 2 },
      },
      scatter: {
        ...base.scatter,
        raw: { color: softBlue, outlineWidth: 0 },
        outlier: { color: red, outlineWidth: 0 },
      },
    };
  }, [base, blue, red]);

  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const live = useRef(
    new LiveSeries({
      name: 'stream',
      schema,
      retention: { maxEvents: MAX_EVENTS },
    }),
  ).current;
  const rand = useRef(mulberry32(17)).current;
  const tick = useRef(0);

  const [clip, setClip] = useState(false);
  const [playing, setPlaying] = useState(true);

  // One rAF loop drives both the data and the scroll. Pushes are scheduled
  // against the wall clock with catch-up (`nextPush`), not setInterval —
  // embedded/background tabs clamp timers to ~1Hz, which starves the stream;
  // rAF only runs when the page is actually visible, and the catch-up loop
  // keeps the effective rate at PUSH_MS regardless of frame rate. The view's
  // right edge is wall-clock now, re-rendered every frame, so the window
  // glides instead of jumping once per snapshot.
  const [, setFrame] = useState(0);
  const pausedAt = useRef<number | null>(null);
  const nextPush = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) {
      pausedAt.current = Date.now();
      return;
    }
    pausedAt.current = null;
    nextPush.current = Date.now();
    let raf = 0;
    const step = () => {
      const now = Date.now();
      // If we fell far behind (tab hidden), skip ahead — no burst on return.
      if (nextPush.current !== null && now - nextPush.current > 2000) {
        nextPush.current = now;
      }
      while (nextPush.current !== null && now >= nextPush.current) {
        const i = tick.current++;
        const mean = 52 + 15 * Math.sin(i / 30) + 6 * Math.sin(i / 9.5);
        const noise = (rand() - 0.5) * 9;
        const spike =
          rand() < 0.045 ? (rand() < 0.5 ? -1 : 1) * (24 + rand() * 12) : 0;
        const v = Math.max(2, Math.min(98, mean + noise + spike));
        live.push([nextPush.current, v]);
        nextPush.current += PUSH_MS;
      }
      setFrame((f) => (f + 1) & 0xffff);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [live, rand, playing]);

  // Data updates arrive on the snapshot cadence; the scroll is per-frame.
  const raw = useSnapshot(live, { throttle: 120 });

  // Real pond ops, recomputed per snapshot: a rolling baseline finds the
  // outliers; with clip on they're filtered out of the smoothing input and
  // drawn as their own (red) series.
  const parts = useMemo(() => {
    if (!raw || raw.length < 2) return null;
    const bands = raw.baseline('value', {
      window: '4s',
      sigma: 2.6,
      minSamples: 8,
    });
    const outliers = bands.filter((e) => {
      const v = e.get('value') as number | undefined;
      const lo = e.get('lower') as number | undefined;
      const hi = e.get('upper') as number | undefined;
      return v != null && lo != null && hi != null && (v > hi || v < lo);
    });
    const clean = bands.filter((e) => {
      const v = e.get('value') as number | undefined;
      const lo = e.get('lower') as number | undefined;
      const hi = e.get('upper') as number | undefined;
      return v == null || lo == null || hi == null || (v <= hi && v >= lo);
    });
    const trendSource = clip ? clean : bands;
    // Light smoothing on purpose: with clip off, a spike visibly tugs the
    // line toward it; flipping clip on is what makes the line let go.
    const trend = trendSource.smooth('value', 'movingAverage', {
      window: '800ms',
      alignment: 'centered',
      output: 'trend',
    });
    return { outliers, trend };
  }, [raw, clip]);

  const ready = raw !== null && parts !== null && width > 0;
  const end = pausedAt.current ?? Date.now();
  const view: [number, number] = [end - WINDOW_MS, end];

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {ready ? (
          <ChartContainer range={view} width={width} theme={theme}>
            <ChartRow height={HEIGHT}>
              <YAxis
                id="v"
                side="left"
                label="value"
                min={0}
                max={100}
                width={40}
                format={() => ''}
              />
              <Layers>
                <ScatterChart
                  series={raw!}
                  column="value"
                  axis="v"
                  as="raw"
                  radius={2.4}
                />
                <LineChart
                  series={parts!.trend}
                  column="trend"
                  axis="v"
                  as="trend"
                />
                {clip ? (
                  <ScatterChart
                    series={parts!.outliers}
                    column="value"
                    axis="v"
                    as="outlier"
                    radius={4}
                  />
                ) : null}
              </Layers>
            </ChartRow>
          </ChartContainer>
        ) : (
          <div style={{ height: HEIGHT }} />
        )}
      </div>
      <ConceptControls>
        <ToggleChips
          label="clip"
          options={[
            {
              value: 'clip',
              label: 'clip outliers',
              color: 'var(--pond-viz-down)',
            },
          ]}
          selected={clip ? ['clip'] : []}
          onToggle={() => setClip((c) => !c)}
        />
        <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
      </ConceptControls>
    </>
  );
}
