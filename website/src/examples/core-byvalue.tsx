import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AreaChart,
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { Sequence, TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  PlayButton,
  SegmentedControl,
} from '@site/src/components/ConceptViz';

/**
 * The `byValue` hero (value-axis concept page) — built with the real charts, so
 * it's an honest demo, not a hand-drawn look-alike. A run's elevation (area) +
 * pace (line) plot against **time**; flipping to **distance** re-renders them
 * from `run.byValue('dist')` — same rows, re-keyed, so a slow climb that looked
 * gradual over time is short and steep over distance. The splits row underneath
 * comes from the real value-axis aggregators: `aggregate` (time) vs `byColumn`
 * (distance). The control is the pond core option: which axis to project onto.
 *
 * Pace is plotted the running way — **faster is up** — so the line dips on a
 * climb (you slow down), rather than spiking on it.
 */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number' },
  { name: 'ele', kind: 'number' },
  { name: 'pace', kind: 'number' },
] as const;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const N = 60; // one sample per second → a 60 s run
const SPLITS = 6;

const hill = (u: number, c: number, w: number) =>
  Math.exp(-((u - c) ** 2) / (2 * w * w));
// Smooth base drives speed (→ pace); texture is display-only.
const eleBase = (u: number) =>
  0.24 + 0.42 * hill(u, 0.4, 0.11) + 0.18 * hill(u, 0.73, 0.06);
const eleFn = (u: number) => eleBase(u) + 0.02 * Math.sin(u * 18);

// The run: sampled evenly in TIME (like GPS), slow uphill so distance accrues
// unevenly. This is the whole reason byValue is interesting.
function buildRun() {
  const us: number[] = [];
  const eles: number[] = [];
  const paceRaw: number[] = [];
  const dists: number[] = [];
  let d = 0;
  const du = 1 / (N - 1);
  for (let i = 0; i < N; i++) {
    const u = i * du;
    const grad = (eleBase(u + 0.006) - eleBase(u - 0.006)) / 0.012;
    const speed = 0.9 - 0.5 * Math.tanh(1.3 * grad); // smooth, no hard clamp
    us.push(u);
    eles.push(eleFn(u));
    paceRaw.push(1 / speed); // min/km — higher is slower
    dists.push(d);
    d += speed * du;
  }
  // Plot pace the running way: faster is UP, so the line dips on a climb.
  // Reflect raw pace about its own range (an affine flip, so split averages
  // flip the same way and stay consistent with the line).
  const flip = Math.min(...paceRaw) + Math.max(...paceRaw);
  const rows = us.map(
    (_, i) =>
      [BASE + i * 1000, dists[i], eles[i], flip - paceRaw[i]] as [
        number,
        number,
        number,
        number,
      ],
  );
  return { rows, distMax: d };
}
const { rows, distMax } = buildRun();

const run = TimeSeries.fromJSON({ name: 'run', schema: SCHEMA, rows });
const runByDist = run.byValue('dist'); // the projection — throws if not monotonic
const timeSplits = run.aggregate(Sequence.every('10s'), {
  pace: { from: 'pace', using: 'avg' },
});
const distSplits = run.byColumn(
  'dist',
  { width: distMax / SPLITS },
  { pace: { from: 'pace', using: 'avg' } },
);

const AXES = [
  { value: 'time' as const, label: 'time' },
  { value: 'dist' as const, label: 'distance' },
];
type AxisKind = (typeof AXES)[number]['value'];

const TOTAL_H = 268;
const FLIP_MS = 3800;

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

export default function CoreByValue() {
  const theme = useSiteChartTheme();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const [axis, setAxis] = useState<AxisKind>('time');
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(
      () => setAxis((a) => (a === 'time' ? 'dist' : 'time')),
      FLIP_MS,
    );
    return () => clearInterval(id);
  }, [playing]);

  const chart = (isTime: boolean) => {
    const top = isTime ? run : runByDist;
    const range: readonly [number, number] | ReturnType<typeof run.timeRange> =
      isTime ? run.timeRange() : [0, distMax];
    // Pace is plotted reflected (faster up), so its absolute tick numbers would
    // read backwards — blank them; the shape and the elevation axis carry it.
    const blank = () => '';
    return (
      <ChartContainer range={range} width={width} theme={theme}>
        <ChartRow height={150}>
          <YAxis id="ele" side="left" label="elevation" pad={0.08} />
          <YAxis
            id="pace"
            side="right"
            label="pace (faster ↑)"
            pad={0.15}
            format={blank}
          />
          <Layers>
            <AreaChart series={top} column="ele" axis="ele" />
            <LineChart series={top} column="pace" axis="pace" as="secondary" />
          </Layers>
        </ChartRow>
        <ChartRow height={80}>
          <YAxis
            id="sp"
            side="left"
            label="pace / split"
            min={0}
            width={44}
            format={blank}
          />
          <Layers>
            {isTime ? (
              <BarChart series={timeSplits} column="pace" axis="sp" gap={6} />
            ) : (
              <BarChart bins={distSplits} column="pace" axis="sp" gap={6} />
            )}
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  };

  const isTime = axis === 'time';

  return (
    <>
      <div
        ref={boxRef}
        style={{ position: 'relative', width: '100%', height: TOTAL_H }}
      >
        {width > 0 && (
          <>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: isTime ? 1 : 0,
                transition: 'opacity 0.5s ease',
                pointerEvents: isTime ? 'auto' : 'none',
              }}
            >
              {chart(true)}
            </div>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: isTime ? 0 : 1,
                transition: 'opacity 0.5s ease',
                pointerEvents: isTime ? 'none' : 'auto',
              }}
            >
              {chart(false)}
            </div>
          </>
        )}
      </div>
      <ConceptControls>
        <SegmentedControl
          label="x-axis"
          options={AXES}
          value={axis}
          onChange={(v) => {
            setAxis(v);
            setPlaying(false);
          }}
        />
        <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
      </ConceptControls>
    </>
  );
}
