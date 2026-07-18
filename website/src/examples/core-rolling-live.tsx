import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  Region,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { LiveSeries } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  PlayButton,
  SegmentedControl,
} from '@site/src/components/ConceptViz';

/**
 * The live counterpart of the rolling figure. Points stream into a `LiveSeries`
 * (blue); each snapshot the current window's trailing average is re-derived
 * with `rolling`, tracing the teal line, and the orange window + anchor sit at
 * the newest point. Change `window` — a pond core option — to smooth more or
 * less, live.
 */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

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

const WINDOWS = [
  { value: '2s' as const, label: '2s' },
  { value: '4s' as const, label: '4s' },
  { value: '8s' as const, label: '8s' },
];
type Window = (typeof WINDOWS)[number]['value'];

const PUSH_MS = 160;
const VISIBLE_MS = 14_000;
const HEIGHT = 210;

export default function CoreRollingLive() {
  const theme = useSiteChartTheme();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const live = useRef(
    new LiveSeries({ name: 'value', schema, retention: { maxAge: '20s' } }),
  ).current;
  const rand = useRef(mulberry32(29)).current;
  const tick = useRef(0);
  const [window, setWindow] = useState<Window>('4s');
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const i = tick.current++;
      const wave = 0.5 + 0.18 * Math.sin(i / 18);
      const value = Math.max(
        0.06,
        Math.min(0.94, wave + (rand() - 0.5) * 0.24),
      );
      live.push([Date.now(), value]);
    }, PUSH_MS);
    return () => clearInterval(id);
  }, [live, rand, playing]);

  const raw = useSnapshot(live, { throttle: 150 });

  const roll = useMemo(() => {
    if (raw === null || raw.length === 0) return null;
    const r = raw.rolling(window, { value: 'avg' });
    return r.length === 0 ? null : r;
  }, [raw, window]);

  const controls = (
    <ConceptControls>
      <SegmentedControl
        label="window"
        options={WINDOWS}
        value={window}
        onChange={setWindow}
      />
      <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
    </ConceptControls>
  );

  const ready = width > 0 && raw !== null && roll !== null;
  const view: [number, number] = ready
    ? (() => {
        const span = raw!.timeRange()!;
        const end = span.end();
        return [Math.max(end - VISIBLE_MS, span.begin()), end];
      })()
    : [0, 1];
  const end = ready ? raw!.timeRange()!.end() : 0;
  const wLo = end - parseInt(window, 10) * 1000;

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {ready ? (
          <ChartContainer range={view} width={width} theme={theme}>
            <ChartRow height={HEIGHT}>
              <YAxis id="val" side="left" label="value" min={0} max={1} />
              <Layers>
                {/* the trailing window + its anchor, riding the newest point */}
                <Region from={wLo} to={end} label="window" />
                <Marker at={end} />
                <ScatterChart
                  series={raw!}
                  column="value"
                  axis="val"
                  as="secondary"
                  radius={3}
                />
                <LineChart
                  series={roll!}
                  column="value"
                  axis="val"
                  curve="monotone"
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
