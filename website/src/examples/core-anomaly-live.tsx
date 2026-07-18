import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BandChart,
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
  Slider,
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

const PUSH_MS = 130;
const WINDOW_MS = 14_000;
const MAX_EVENTS = 240;
const HEIGHT = 240;

/**
 * Live anomaly detection. Values stream into a `LiveSeries`; each frame we take
 * a snapshot and run real `snap.baseline('value', { window, sigma })` — the
 * rolling mean ± `sigma`·sd is drawn as a shaded band, and the events that fall
 * outside it (`bands.filter(...)`) are the anomaly dots. The slider drives the
 * `sigma` option live: tighten the band and more points flag; widen it and they
 * fall back inside. Nothing here touches a chart prop — only the pond option.
 */
export default function CoreAnomalyLive() {
  const base = useSiteChartTheme();
  const teal = base.line?.default?.color ?? '#0e8f86';
  const blue = base.line?.secondary?.color ?? '#3d6fd9';
  const orange = base.annotation?.color ?? '#e8833a';

  const theme = useMemo(() => {
    const faintTeal = mix(base.background ?? '#ffffff', teal, 0.5);
    return {
      ...base,
      band: {
        ...base.band,
        inner: { ...base.band?.inner, fill: teal, opacity: 0.16 },
      },
      line: {
        ...base.line,
        avg: { color: faintTeal, width: 1 },
        stream: { color: blue, width: 1.5 },
      },
      scatter: {
        ...base.scatter,
        anomaly: {
          ...base.scatter?.default,
          color: orange,
          outlineWidth: 0,
        },
      },
    };
  }, [base, teal, blue, orange]);

  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const live = useRef(
    new LiveSeries({
      name: 'stream',
      schema,
      retention: { maxEvents: MAX_EVENTS },
    }),
  ).current;
  const rand = useRef(mulberry32(11)).current;
  const tick = useRef(0);

  const [sigma, setSigma] = useState(2);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const i = tick.current++;
      // A gently wandering mean, broadband noise, and the occasional spike —
      // the spikes are what a rolling band is meant to catch.
      const mean = 50 + 14 * Math.sin(i / 34) + 6 * Math.sin(i / 11);
      const noise = (rand() - 0.5) * 10;
      const spike =
        rand() < 0.05 ? (rand() < 0.5 ? -1 : 1) * (26 + rand() * 12) : 0;
      const v = Math.max(2, Math.min(98, mean + noise + spike));
      live.push([Date.now(), v]);
    }, PUSH_MS);
    return () => clearInterval(id);
  }, [live, rand, playing]);

  const raw = useSnapshot(live, { throttle: 200 });

  // Real rolling baseline on the snapshot; the slider's `sigma` sets band width.
  // Anomalies are the events outside the band — one filter, no extra pass.
  const bands = useMemo(
    () =>
      raw && raw.length > 0
        ? raw.baseline('value', { window: '4s', sigma, minSamples: 10 })
        : null,
    [raw, sigma],
  );
  const anomalies = useMemo(
    () =>
      bands
        ? bands.filter((e) => {
            const v = e.get('value') as number | undefined;
            const lo = e.get('lower') as number | undefined;
            const hi = e.get('upper') as number | undefined;
            return v != null && lo != null && hi != null && (v > hi || v < lo);
          })
        : null,
    [bands],
  );

  const ready = raw !== null && bands !== null && width > 0;
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
                <BandChart
                  series={bands!}
                  lower="lower"
                  upper="upper"
                  axis="v"
                  as="inner"
                />
                <LineChart series={bands!} column="avg" axis="v" as="avg" />
                <LineChart series={raw!} column="value" axis="v" as="stream" />
                <ScatterChart
                  series={anomalies!}
                  column="value"
                  axis="v"
                  as="anomaly"
                  radius={4}
                />
              </Layers>
            </ChartRow>
          </ChartContainer>
        ) : (
          <div style={{ height: HEIGHT }} />
        )}
      </div>
      <ConceptControls>
        <Slider
          label="sigma"
          min={1}
          max={4}
          step={0.25}
          value={sigma}
          onChange={setSigma}
          display={`${sigma.toFixed(2)}σ`}
        />
        <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
      </ConceptControls>
    </>
  );
}
