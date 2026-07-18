import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  SegmentedControl,
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

// A fixed source series — built once, never streamed.
const N_POINTS = 240;
const HEIGHT = 220;
const source = (() => {
  const rand = mulberry32(7);
  const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N_POINTS; i++) {
    const wave = 0.5 + 0.3 * Math.sin(i / 18);
    const v = Math.max(0.03, Math.min(0.97, wave + (rand() - 0.5) * 0.24));
    rows.push([BASE + i * 400, v]);
  }
  return TimeSeries.fromJSON({ name: 'source', schema, rows });
})();
const RANGE = source.timeRange()!;

type Method = 'stride' | 'reservoir';
const METHODS = [
  { value: 'stride' as const, label: 'stride' },
  { value: 'reservoir' as const, label: 'reservoir' },
];

/**
 * Batch `sample` on a **static** `TimeSeries` — the faint dots are the whole
 * source, the teal dots the kept subset, straight from `source.sample(...)`.
 * `stride` keeps every Nth event (evenly spaced); `reservoir` draws a random
 * K-of-N (Algorithm R). Nothing streams, so the draw is steady.
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
  const [method, setMethod] = useState<Method>('stride');
  const [stride, setStride] = useState(4);
  const [size, setSize] = useState(60);

  const sampled = useMemo(
    () =>
      method === 'stride'
        ? source.sample({ stride })
        : source.sample({ reservoir: { size } }),
    [method, stride, size],
  );

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {width > 0 ? (
          <ChartContainer range={RANGE} width={width} theme={theme}>
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
                  series={source}
                  column="value"
                  axis="val"
                  as="secondary"
                  radius={1.7}
                />
                <ScatterChart
                  series={sampled}
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
      </ConceptControls>
    </>
  );
}
