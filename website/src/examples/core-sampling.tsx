import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
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
  Slider,
} from '@site/src/components/ConceptViz';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

/** A tiny deterministic PRNG (mulberry32) for the source wander. */
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

type Method = 'stride' | 'reservoir';
const METHODS = [
  { value: 'stride' as const, label: 'stride' },
  { value: 'reservoir' as const, label: 'reservoir' },
];

const PUSH_MS = 45; // fast push → a crowded source
const WINDOW_MS = 11_000;
const MAX_EVENTS = 240;
const HEIGHT = 240;

/**
 * The `sample` concept figure. A live `LiveSeries` streams a crowded scatter of
 * raw points; the highlighted teal dots are the **kept** subset —
 * `snapshot.sample({ stride })` (every Nth, evenly spaced) or
 * `snapshot.sample({ reservoir: { size } })` (a random K-of-N, re-drawn each
 * frame). The controls are `sample`'s core options: the strategy and its value.
 */
export default function CoreSampling() {
  const base = useSiteChartTheme();
  const theme = useMemo(() => {
    const faint = mix(
      base.background ?? '#ffffff',
      base.scatter?.secondary?.color ?? base.axis?.label ?? '#8899aa',
      0.55,
    );
    return {
      ...base,
      scatter: {
        ...base.scatter,
        // the kept subset (teal, no ring); the raw cloud recedes to grey
        default: { ...base.scatter?.default, outlineWidth: 0 },
        secondary: {
          ...base.scatter?.secondary,
          color: faint,
          outlineWidth: 0,
        },
      },
    };
  }, [base]);

  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const live = useRef(
    new LiveSeries({
      name: 'raw',
      schema,
      retention: { maxEvents: MAX_EVENTS },
    }),
  ).current;
  const rand = useRef(mulberry32(9)).current;
  const tick = useRef(0);

  const [method, setMethod] = useState<Method>('stride');
  const [stride, setStride] = useState(4);
  const [size, setSize] = useState(60);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const i = tick.current++;
      const wave = 0.5 + 0.3 * Math.sin(i / 22);
      const v = Math.max(0.03, Math.min(0.97, wave + (rand() - 0.5) * 0.24));
      live.push([Date.now(), v]);
    }, PUSH_MS);
    return () => clearInterval(id);
  }, [live, rand, playing]);

  const raw = useSnapshot(live, { throttle: 300 });

  const sampled = useMemo(() => {
    if (raw === null || raw.length === 0) return null;
    return method === 'stride'
      ? raw.sample({ stride })
      : raw.sample({ reservoir: { size } });
  }, [raw, method, stride, size]);

  const ready = raw !== null && sampled !== null && width > 0;
  const view: [number, number] = ready
    ? (() => {
        const span = raw!.timeRange()!;
        const end = span.end();
        return [Math.max(end - WINDOW_MS, span.begin()), end];
      })()
    : [0, 1];

  const controls = (
    <ConceptControls>
      <SegmentedControl
        label="strategy"
        options={METHODS}
        value={method}
        onChange={setMethod}
      />
      {method === 'stride' ? (
        <Slider
          label="stride"
          min={2}
          max={16}
          value={stride}
          onChange={setStride}
          display={`1-in-${stride}`}
        />
      ) : (
        <Slider
          label="keep"
          min={10}
          max={160}
          step={5}
          value={size}
          onChange={setSize}
          display={String(size)}
        />
      )}
      <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
    </ConceptControls>
  );

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {ready ? (
          <ChartContainer range={view} width={width} theme={theme}>
            <ChartRow height={HEIGHT}>
              <YAxis
                id="val"
                side="left"
                label="value"
                min={0}
                max={1}
                width={40}
                format={() => ''}
              />
              <Layers>
                <ScatterChart
                  series={raw!}
                  column="value"
                  axis="val"
                  as="secondary"
                  radius={1.7}
                />
                <ScatterChart
                  series={sampled!}
                  column="value"
                  axis="val"
                  radius={3.4}
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
