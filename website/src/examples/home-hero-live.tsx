import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  Region,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { LiveSeries, Time, TimeRange } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  PlayButton,
  Slider,
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
// The view's right edge trails the true live edge by this much, so new data
// lands off-screen and *flows into* view already smoothed and banded — no
// pop-in, and the centered smooth() tail (max window 3s ⇒ 1.5s of future)
// is fully settled by the time it becomes visible.
const LEAD_MS = 1_600;
const MAX_EVENTS = 220;
const HEIGHT = 260;

/**
 * The homepage hero. Raw points stream in (blue); a real
 * `smooth('value', 'movingAverage', …)` draws the trend line through them,
 * with the **smooth** slider setting the window. With clip off, the rolling
 * `baseline()` band shows at two levels — 1σ (darker) and the adjustable
 * **sigma** (lighter). Flipping **clip** runs the platform's whole pitch in
 * one gesture: the outliers beyond sigma are `filter()`ed out of the line's
 * input and stay behind as red dots — every control is a pond analytics
 * option, not a chart prop. The view scrolls on a rAF clock (end = now), so
 * motion is smooth regardless of the data's arrival rate.
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
      band: {
        ...base.band,
        outer: { fill: blue, opacity: 0.08 },
        inner: { fill: blue, opacity: 0.18 },
      },
      scatter: {
        ...base.scatter,
        raw: { color: softBlue, outlineWidth: 0 },
        outlier: { color: red, outlineWidth: 0 },
      },
    };
  }, [base, blue, red]);

  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const rand = useRef(mulberry32(17)).current;
  const tick = useRef(0);
  const nextValue = () => {
    const i = tick.current++;
    const mean = 52 + 15 * Math.sin(i / 30) + 6 * Math.sin(i / 9.5);
    const noise = (rand() - 0.5) * 9;
    const spike =
      rand() < 0.045 ? (rand() < 0.5 ? -1 : 1) * (24 + rand() * 12) : 0;
    return Math.max(2, Math.min(98, mean + noise + spike));
  };
  // Lazy one-time init, pre-filled with a full window of history (plus the
  // lead) so the page loads mid-stream instead of watching the chart fill.
  const liveRef = useRef<LiveSeries<typeof schema> | null>(null);
  if (liveRef.current === null) {
    const l = new LiveSeries({
      name: 'stream',
      schema,
      retention: { maxEvents: MAX_EVENTS },
    });
    const n = Math.ceil((WINDOW_MS + LEAD_MS + 1000) / PUSH_MS);
    const start = Date.now() - n * PUSH_MS;
    for (let k = 0; k < n; k++) {
      l.push([start + k * PUSH_MS, nextValue()]);
    }
    liveRef.current = l;
  }
  const live = liveRef.current;

  const [clip, setClip] = useState(false);
  const [sigma, setSigma] = useState(2.5);
  const [smoothing, setSmoothing] = useState(800); // smooth() window, ms
  const [playing, setPlaying] = useState(true);
  // The percentile region rides the live edge: its edges are stored as
  // *offsets back from now*, so it holds its place while the window scrolls
  // and stays draggable (drags are converted back to offsets on change).
  const [regionOff, setRegionOff] = useState({
    left: WINDOW_MS / 5,
    right: 0,
  });
  // A draggable marker in the same riding frame: one offset back from now.
  const [markerOff, setMarkerOff] = useState(WINDOW_MS * 0.55);

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
        live.push([nextPush.current, nextValue()]);
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
  // outliers (at the slider's sigma); with clip off the band itself is shown
  // at two levels (1 sigma darker, the adjustable sigma lighter); with clip
  // on the outliers are filtered out of the smoothing input and drawn as
  // their own (red) series.
  const parts = useMemo(() => {
    if (!raw || raw.length < 2) return null;
    const bands = raw.baseline('value', {
      window: '4s',
      sigma,
      minSamples: 8,
    });
    const inner = raw.baseline('value', {
      window: '4s',
      sigma: 1,
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
    // Light smoothing by default: with clip off, a spike visibly tugs the
    // line toward it; flipping clip on is what makes the line let go.
    const trend = trendSource.smooth('value', 'movingAverage', {
      window: `${smoothing}ms`,
      alignment: 'centered',
      output: 'trend',
    });
    return { bands, inner, outliers, trend };
  }, [raw, clip, sigma, smoothing]);

  const ready = raw !== null && parts !== null && width > 0;
  // Everything — view, region, marker — anchors to the *visible* right edge,
  // which trails the true live edge by LEAD_MS.
  const end = (pausedAt.current ?? Date.now()) - LEAD_MS;
  const view: [number, number] = [end - WINDOW_MS, end];

  // Live percentile readout over the region — real pond ops per render:
  // within() slices the events under the region, reduce() runs the
  // percentile reducers.
  const regionFrom = end - regionOff.left;
  const regionTo = end - regionOff.right;
  const markerAt = end - markerOff;
  // The chip reads the smoothed trend under the marker — atOrBefore() is the
  // real lookup a cursor readout would use.
  const markerEvent =
    parts !== null ? parts.trend.atOrBefore(new Time(markerAt)) : undefined;
  const markerVal = markerEvent?.get('trend') as number | undefined;
  const markerLabel =
    markerVal == null ? 'trend –' : `trend ${Math.round(markerVal)}`;

  let regionLabel = 'p25 – · p50 – · p75 –';
  if (raw && raw.length > 0 && regionFrom < regionTo) {
    const slice = raw.within(
      new TimeRange({ start: regionFrom, end: regionTo }),
    );
    if (slice.length > 0) {
      const fmt = (q: 'p25' | 'p50' | 'p75') => {
        const v = slice.reduce('value', q) as number | undefined;
        return v == null ? '–' : String(Math.round(v));
      };
      regionLabel = `p25 ${fmt('p25')} · p50 ${fmt('p50')} · p75 ${fmt('p75')}`;
    }
  }

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {ready ? (
          <ChartContainer range={view} width={width} theme={theme}>
            <ChartRow height={HEIGHT}>
              <YAxis
                id="v"
                side="left"
                min={0}
                max={100}
                width={0}
                format={() => ''}
              />
              <Layers>
                {!clip ? (
                  <BandChart
                    series={parts!.bands}
                    lower="lower"
                    upper="upper"
                    as="outer"
                    axis="v"
                  />
                ) : null}
                {!clip ? (
                  <BandChart
                    series={parts!.inner}
                    lower="lower"
                    upper="upper"
                    as="inner"
                    axis="v"
                  />
                ) : null}
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
                <Marker
                  id="trend-readout"
                  at={markerAt}
                  label={markerLabel}
                  editing
                  onChange={(next) => {
                    const nowEnd = (pausedAt.current ?? Date.now()) - LEAD_MS;
                    setMarkerOff(
                      Math.min(Math.max(nowEnd - next, 0), WINDOW_MS),
                    );
                  }}
                />
                <Region
                  id="percentiles"
                  from={regionFrom}
                  to={regionTo}
                  label={regionLabel}
                  editing
                  onChange={(next) => {
                    // Clamp into the window, order-safe: right ∈ [0, W-600],
                    // left ∈ [right+600, W] — a drag past either window edge
                    // can never invert the span.
                    const nowEnd = (pausedAt.current ?? Date.now()) - LEAD_MS;
                    const right = Math.min(
                      Math.max(0, nowEnd - next.to),
                      WINDOW_MS - 600,
                    );
                    const left = Math.min(
                      Math.max(nowEnd - next.from, right + 600),
                      WINDOW_MS,
                    );
                    setRegionOff({ left, right });
                  }}
                />
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
        <Slider
          label="sigma"
          min={1.5}
          max={4}
          step={0.25}
          value={sigma}
          onChange={setSigma}
          display={`${sigma.toFixed(2)}σ`}
        />
        <Slider
          label="smooth"
          min={200}
          max={3000}
          step={100}
          value={smoothing}
          onChange={setSmoothing}
          display={
            smoothing >= 1000
              ? `${(smoothing / 1000).toFixed(1)}s`
              : `${smoothing}ms`
          }
        />
        <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
      </ConceptControls>
    </>
  );
}
