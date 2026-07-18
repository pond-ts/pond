import { useEffect, useRef, useState } from 'react';
import { TimeSeries } from 'pond-ts';
import {
  ConceptControls,
  PlayButton,
  SegmentedControl,
} from '@site/src/components/ConceptViz';

/**
 * The `byValue` mental model — the confusing one, because it's a **projection**,
 * not an aggregation. `byValue('dist')` re-keys the series onto a monotonic
 * value axis: same rows, same order, but the x-axis becomes **distance** instead
 * of **time**. A climb you took slowly is spread out over time yet short and
 * steep over distance — so the profile re-spaces horizontally when you flip the
 * axis. The one control is the pond core option: which column to project onto.
 */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number' },
  { name: 'ele', kind: 'number' },
] as const;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

const AXES = [
  { value: 'time' as const, label: 'time' },
  { value: 'dist' as const, label: 'distance' },
];
type AxisKind = (typeof AXES)[number]['value'];

// --- layout (SVG user units) ---
const W = 560;
const H = 230;
const PAD_L = 46;
const PAD_R = 28;
const TOP = 28;
const BOT = 172;
const AXIS_Y = BOT + 6;
const N = 40;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mapX = (u: number) => PAD_L + u * (W - PAD_L - PAD_R);
const mapY = (ele: number) => BOT - ele * (BOT - TOP);

// Build the route: evenly sampled in TIME, but slow through the climb so
// distance accrues unevenly — the whole point of byValue.
function buildRoute() {
  const rows: Array<[number, number, number]> = [];
  let dist = 0;
  const raw: { t: number; dist: number; ele: number }[] = [];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1); // even in time
    const climb = Math.exp(-((u - 0.48) ** 2) / 0.012); // slow zone ~ the climb
    const speed = 1 - 0.82 * climb;
    dist += speed;
    const ele = 0.18 + 0.64 * smoothstep(0.34, 0.62, u);
    raw.push({ t: u, dist, ele });
    rows.push([BASE + i * 1000, dist, ele]);
  }
  const distMax = raw[raw.length - 1].dist;
  // Dogfood the projection: byValue re-keys onto the monotonic `dist` axis
  // (throws if it isn't non-decreasing — it is). Positions === the dist keys.
  TimeSeries.fromJSON({ name: 'route', schema: SCHEMA, rows }).byValue('dist');
  return raw.map((p) => ({
    xTime: mapX(p.t),
    xDist: mapX(p.dist / distMax),
    y: mapY(p.ele),
  }));
}
const POINTS = buildRoute();

const FLIP_MS = 2600;

export default function CoreByValue() {
  const [axis, setAxis] = useState<AxisKind>('time');
  const [playing, setPlaying] = useState(true);
  const [, setFrame] = useState(0);
  const dispX = useRef<number[]>(POINTS.map((p) => p.xTime));

  // Auto-flip between the two projections so the figure demonstrates itself.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(
      () => setAxis((a) => (a === 'time' ? 'dist' : 'time')),
      FLIP_MS,
    );
    return () => clearInterval(id);
  }, [playing]);

  // Ease each point's x toward its target projection.
  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const step = (ts: number) => {
      if (last === null) last = ts;
      const dt = Math.min(48, ts - last);
      last = ts;
      const k = Math.min(1, dt / 130);
      for (let i = 0; i < POINTS.length; i++) {
        const target = axis === 'dist' ? POINTS[i].xDist : POINTS[i].xTime;
        dispX.current[i] += (target - dispX.current[i]) * k;
      }
      setFrame((f) => (f + 1) & 0xffff);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [axis]);

  const xs = dispX.current;
  const linePts = POINTS.map((p, i) => `${xs[i].toFixed(1)},${p.y.toFixed(1)}`);
  const areaPath =
    `M ${xs[0].toFixed(1)} ${BOT} ` +
    POINTS.map((p, i) => `L ${xs[i].toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
    ` L ${xs[xs.length - 1].toFixed(1)} ${BOT} Z`;

  const body = { fill: 'var(--pond-body)' };

  const controls = (
    <ConceptControls>
      <SegmentedControl
        label="x-axis"
        options={AXES}
        value={axis}
        onChange={(v) => {
          setAxis(v);
          setPlaying(false); // hand control to the reader
        }}
      />
      <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
    </ConceptControls>
  );

  return (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="An elevation profile re-projected from the time axis onto the distance axis"
      >
        {/* elevation area + line */}
        <path
          d={areaPath}
          style={{
            fill: 'color-mix(in srgb, var(--pond-viz-1) 20%, var(--pond-surface))',
          }}
        />
        <polyline
          points={linePts.join(' ')}
          fill="none"
          style={{ stroke: 'var(--pond-viz-1)' }}
          strokeWidth={2}
        />
        {POINTS.map((p, i) => (
          <circle
            key={i}
            cx={xs[i]}
            cy={p.y}
            r={3}
            style={{ fill: 'var(--pond-viz-1)' }}
          />
        ))}

        {/* x-axis + its (changing) label */}
        <line
          x1={PAD_L}
          y1={AXIS_Y}
          x2={W - PAD_R}
          y2={AXIS_Y}
          style={{ stroke: 'var(--pond-body)' }}
          strokeWidth={1.5}
        />
        <text
          x={(PAD_L + (W - PAD_R)) / 2}
          y={AXIS_Y + 22}
          textAnchor="middle"
          fontSize={13}
          fontFamily="var(--ifm-font-family-monospace)"
          style={body}
        >
          {axis === 'dist' ? 'ele  vs  distance' : 'ele  vs  time'}
        </text>
        <text
          x={PAD_L - 8}
          y={TOP + 6}
          textAnchor="end"
          fontSize={12}
          fontFamily="var(--ifm-font-family-monospace)"
          style={body}
        >
          ele
        </text>
      </svg>
      {controls}
    </>
  );
}
