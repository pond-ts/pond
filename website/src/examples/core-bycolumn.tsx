import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
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
/** Box–Muller standard normal from a uniform PRNG. */
function gauss(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
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

function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3)
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return b;
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const BIN_OPTIONS = [
  { value: '0.10' as const, label: '0.10' },
  { value: '0.05' as const, label: '0.05' },
  { value: '0.025' as const, label: '0.025' },
  { value: 'custom' as const, label: 'custom' },
];
type Bin = (typeof BIN_OPTIONS)[number]['value'];

// `byColumn`'s other binning mode: explicit non-uniform edges (think zones) —
// fine through the middle of the distribution, coarse out at the tails.
const CUSTOM_EDGES = [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1];

const PUSH_MS = 55; // fast fill so the bell emerges
const HEIGHT = 230;
const MAX_EVENTS = 600; // retained sample — the histogram settles to a bell

/**
 * The `byColumn` mental model (plan §3a / §4): points stream in with
 * bell-curve values; `byColumn('value', { width }, { count: 'count' })` bins
 * them along the **value** axis and the bars grow into the distribution — a
 * real value-axis histogram, not time. The one control is a pond core option —
 * the bin `width` — never a chart prop: widen it and the bars re-bin coarser.
 */
export default function CoreByColumn() {
  const base = useSiteChartTheme();
  const theme = useMemo(() => {
    const viz = base.bar?.default?.fill ?? '#0e8f86';
    const bg = base.background ?? '#ffffff';
    return {
      ...base,
      bar: {
        ...base.bar,
        default: { ...base.bar?.default, fill: mix(bg, viz, 0.55) },
      },
    };
  }, [base]);

  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const live = useRef(
    new LiveSeries({
      name: 'value',
      schema,
      retention: { maxEvents: MAX_EVENTS },
    }),
  ).current;
  const rand = useRef(mulberry32(23)).current;

  const [binWidth, setBinWidth] = useState<Bin>('0.05');
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const value = Math.max(0.03, Math.min(0.97, 0.5 + gauss(rand) * 0.15));
      live.push([Date.now(), value]);
    }, PUSH_MS);
    return () => clearInterval(id);
  }, [live, rand, playing]);

  const raw = useSnapshot(live, { throttle: 150 });

  // Bin the current sample by value — the histogram.
  const bins = useMemo(() => {
    if (raw === null || raw.length === 0) return null;
    const spec =
      binWidth === 'custom'
        ? { edges: CUSTOM_EDGES }
        : { width: parseFloat(binWidth) };
    const vs = raw.byColumn('value', spec, {
      count: { from: 'value', using: 'count' },
    });
    return vs.length === 0 ? null : vs;
  }, [raw, binWidth]);

  const controls = (
    <ConceptControls>
      <SegmentedControl
        label="binning"
        options={BIN_OPTIONS}
        value={binWidth}
        onChange={setBinWidth}
      />
      <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
    </ConceptControls>
  );

  const ready = bins !== null && width > 0;

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {ready ? (
          <ChartContainer range={[0, 1]} width={width} theme={theme}>
            <ChartRow height={HEIGHT}>
              <YAxis id="count" side="left" label="count" min={0} width={44} />
              <Layers>
                <BarChart bins={bins!} column="count" axis="count" gap={1} />
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
