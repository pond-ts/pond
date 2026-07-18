import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxPlot,
  ChartContainer,
  ChartRow,
  Layers,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { LiveSeries, Sequence } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  PlayButton,
  SegmentedControl,
} from '@site/src/components/ConceptViz';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

/** A tiny deterministic PRNG (mulberry32) — no external dependency. */
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

/** Measure a box's content width via `ResizeObserver` (first read is sync). */
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

type Window = '1s' | '2s' | '4s';
const WINDOW_OPTIONS = [
  { value: '1s' as const, label: '1s' },
  { value: '2s' as const, label: '2s' },
  { value: '4s' as const, label: '4s' },
];

const WINDOW_MS = 12_000; // visible span
const PUSH_MS = 100; // one raw point every 100ms
const HEIGHT = 230;

/**
 * The `aggregate` hero (plan §3a / §4 flagship). Raw points stream into a
 * `LiveSeries`; every snapshot we bucket the current window and, per bucket,
 * reduce the distribution into an **IQR box** (`p25`–`p75`) with a **median**
 * line — a `BoxPlot` on the time axis (`shape="none"`, so no noisy min/max
 * whiskers over the raw cloud). The raw points scatter on top, and the box
 * over the newest bucket re-forms as it fills.
 *
 * Full-width (measured), styled as a sibling of the pond figure. The one
 * control is a pond core option — the aggregation `window` — never a chart prop.
 */
export default function CoreAggregate() {
  const base = useSiteChartTheme();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const live = useRef(
    new LiveSeries({ name: 'value', schema, retention: { maxAge: '16s' } }),
  ).current;
  const rand = useRef(mulberry32(11)).current;
  const tick = useRef(0);

  const [windowSize, setWindowSize] = useState<Window>('2s');
  const [playing, setPlaying] = useState(true);

  // A two-level box in the brand teal: opacity does the shading — a light
  // outer min–max bar with a more-prominent inner IQR box on top — plus a
  // brand-teal median line and points. (`shape="solid"` below.)
  const theme = useMemo(() => {
    const viz =
      base.box?.default?.stroke ?? base.scatter?.default?.color ?? '#0e8f86';
    return {
      ...base,
      box: {
        ...base.box,
        default: {
          ...base.box?.default,
          fill: viz,
          fillOpacity: 0.11, // very light outer min–max band; inner IQR ~0.22
          stroke: viz,
          median: viz,
        },
      },
      scatter: {
        ...base.scatter,
        // solid green dots — no outline ring
        default: { ...base.scatter?.default, color: viz, outlineWidth: 0 },
      },
    };
  }, [base]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const i = tick.current++;
      // The mean steps roughly one swing per bucket, so each box sits at a
      // distinct level (a staircase, not a flat band); modest noise gives the
      // IQR box some height and scatters the raw points around the median.
      const wave = 0.5 + 0.26 * Math.sin(i / 16);
      const value = Math.max(0.06, Math.min(0.94, wave + (rand() - 0.5) * 0.3));
      live.push([Date.now(), value]);
    }, PUSH_MS);
    return () => clearInterval(id);
  }, [live, rand, playing]);

  const raw = useSnapshot(live, { throttle: 150 });

  // Per bucket: the quartiles + extremes. We draw only the IQR box + median.
  const boxes = useMemo(() => {
    if (raw === null || raw.length === 0) return null;
    const agg = raw.aggregate(Sequence.every(windowSize), {
      lo: { from: 'value', using: 'min' },
      q1: { from: 'value', using: 'p25' },
      med: { from: 'value', using: 'p50' },
      q3: { from: 'value', using: 'p75' },
      hi: { from: 'value', using: 'max' },
    });
    return agg.length === 0 ? null : agg;
  }, [raw, windowSize]);

  const controls = (
    <ConceptControls>
      <SegmentedControl
        label="window"
        options={WINDOW_OPTIONS}
        value={windowSize}
        onChange={setWindowSize}
      />
      <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
    </ConceptControls>
  );

  const ready = raw !== null && boxes !== null && width > 0;
  const view: [number, number] = ready
    ? (() => {
        const span = raw!.timeRange()!;
        const end = span.end();
        return [Math.max(end - WINDOW_MS, span.begin()), end];
      })()
    : [0, 1];

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {ready ? (
          <ChartContainer range={view} width={width} theme={theme}>
            <ChartRow height={HEIGHT}>
              <YAxis id="val" side="right" format=".0%" min={0} max={1} />
              <Layers>
                {/* light min–max outer bar + prominent inner IQR box + median */}
                <BoxPlot
                  series={boxes!}
                  lower="lo"
                  q1="q1"
                  median="med"
                  q3="q3"
                  upper="hi"
                  shape="solid"
                  axis="val"
                  gap={16}
                />
                {/* the raw events being summarized */}
                <ScatterChart
                  series={raw!}
                  column="value"
                  axis="val"
                  radius={3}
                />
              </Layers>
            </ChartRow>
          </ChartContainer>
        ) : (
          <div style={{ height: HEIGHT }} />
        )}
      </div>
      {controls}
    </>
  );
}
