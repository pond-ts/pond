import { useEffect, useRef, useState } from 'react';
import { TimeSeries } from 'pond-ts';
import {
  ConceptControls,
  PlayButton,
  SegmentedControl,
} from '@site/src/components/ConceptViz';

/**
 * The `aggregate` mental model: request events fall as drops into three
 * buckets — little ponds — and each pond's level is the reducer over the
 * drops inside it, computed for real by pond (`reduce('req', reducer)`). The
 * one control is a pond core option — the reducer — never a chart prop. A
 * looping, deterministic illustration (plan §3a); replaces the static PNG.
 */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'req', kind: 'number' },
] as const;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

const REDUCERS = [
  { value: 'sum' as const, label: 'sum' },
  { value: 'avg' as const, label: 'avg' },
  { value: 'max' as const, label: 'max' },
];
type Reducer = (typeof REDUCERS)[number]['value'];

// --- layout (SVG user units) ---
const W = 560;
const H = 300;
const X0 = 54;
const X1 = W - 34;
const TL_Y = 54;
const RIM_Y = 188;
const FLOOR_Y = 270;
const MAXH = FLOOR_Y - RIM_Y;
const MINUTES = 15;
const BUCKET = 5;
const NB = 3;
const mToX = (m: number) => X0 + (m / MINUTES) * (X1 - X0);

// Fixed drop schedule (sorted by minute → release order === index order).
// The middle pond is denser, echoing the original diagram.
const DROPS = [
  { min: 1.2, v: 3 },
  { min: 2.4, v: 5 },
  { min: 3.9, v: 2 },
  { min: 5.4, v: 4 },
  { min: 6.0, v: 6 },
  { min: 7.3, v: 3 },
  { min: 8.8, v: 5 },
  { min: 11.5, v: 5 },
  { min: 13.6, v: 4 },
].map((d, i) => ({
  ...d,
  i,
  x: mToX(d.min),
  bucket: Math.floor(d.min / BUCKET),
}));
type Drop = (typeof DROPS)[number];

// timings (ms)
const REL_STEP = 520;
const FALL = 560;
const HOLD = 1600;
const LOOP = (DROPS.length - 1) * REL_STEP + FALL + HOLD;

// drop radius scales with the event's value
const V_MIN = 2;
const V_MAX = 6;
const rOf = (v: number) => 3.4 + ((v - V_MIN) / (V_MAX - V_MIN)) * 4.2;

// solid, light, brand-teal water — theme-aware via color-mix over the surface
const WATER = 'color-mix(in srgb, var(--pond-viz-1) 26%, var(--pond-surface))';

/** Reduce one pond's landed drops with pond itself — the real number. */
function pondValue(drops: Drop[], reducer: Reducer): number {
  if (drops.length === 0) return 0;
  const ts = TimeSeries.fromJSON({
    name: 'req',
    schema: SCHEMA,
    rows: drops.map((d) => [BASE + d.min * 60_000, d.v] as const),
  });
  return (ts.reduce('req', reducer) as number | undefined) ?? 0;
}

const bucketBounds = (b: number) => ({
  l: mToX(b * BUCKET) + 5,
  r: mToX((b + 1) * BUCKET) - 5,
});

const fmt = (v: number, reducer: Reducer) =>
  reducer === 'avg' ? v.toFixed(1) : String(Math.round(v));

export default function CoreAggregatePonds() {
  const [reducer, setReducer] = useState<Reducer>('sum');
  const [playing, setPlaying] = useState(true);
  const [, setFrame] = useState(0);

  const elapsed = useRef(0);
  const levels = useRef<number[]>([0, 0, 0]); // eased water heights (px)

  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const denom = Math.max(
      1,
      ...[0, 1, 2].map((b) =>
        pondValue(
          DROPS.filter((d) => d.bucket === b),
          reducer,
        ),
      ),
    );
    const step = (ts: number) => {
      if (last === null) last = ts;
      const dt = Math.min(48, ts - last);
      last = ts;
      if (playing) {
        elapsed.current += dt;
        if (elapsed.current > LOOP) elapsed.current = 0;
      }
      const e = elapsed.current;
      const landedCount = DROPS.filter(
        (d) => d.i * REL_STEP + FALL <= e,
      ).length;
      const landed = DROPS.slice(0, landedCount);
      for (let b = 0; b < NB; b++) {
        const target =
          (pondValue(
            landed.filter((d) => d.bucket === b),
            reducer,
          ) /
            denom) *
          MAXH;
        const k = Math.min(1, dt / 150);
        levels.current[b] += (target - levels.current[b]) * k;
      }
      setFrame((f) => (f + 1) & 0xffff);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, reducer]);

  const e = elapsed.current;
  const landedCount = DROPS.filter((d) => d.i * REL_STEP + FALL <= e).length;
  const landed = DROPS.slice(0, landedCount);
  const displayValues = [0, 1, 2].map((b) =>
    pondValue(
      landed.filter((d) => d.bucket === b),
      reducer,
    ),
  );

  const body = { fill: 'var(--pond-body)' };
  const ink = { fill: 'var(--pond-ink)' };

  const controls = (
    <ConceptControls>
      <SegmentedControl
        label="reducer"
        options={REDUCERS}
        value={reducer}
        onChange={setReducer}
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
        aria-label="Request events falling as drops into three aggregation buckets"
      >
        <defs>
          {[0, 1, 2].map((b) => {
            const { l, r } = bucketBounds(b);
            return (
              <clipPath id={`pond-clip-${b}`} key={b}>
                <rect
                  x={l}
                  y={RIM_Y - 2}
                  width={r - l}
                  height={FLOOR_Y - RIM_Y + 2}
                  rx={9}
                />
              </clipPath>
            );
          })}
        </defs>

        {/* timeline */}
        <line
          x1={X0}
          y1={TL_Y}
          x2={X1 + 6}
          y2={TL_Y}
          style={{ stroke: 'var(--pond-body)' }}
          strokeWidth={1.5}
        />
        {[0, 5, 10, 15].map((m) => (
          <g key={m}>
            <line
              x1={mToX(m)}
              y1={TL_Y - 4}
              x2={mToX(m)}
              y2={TL_Y + 4}
              style={{ stroke: 'var(--pond-body)' }}
              strokeWidth={1.5}
            />
            <text
              x={mToX(m)}
              y={TL_Y - 12}
              textAnchor="middle"
              fontSize={12}
              fontFamily="var(--ifm-font-family-monospace)"
              style={body}
            >
              {`00:${String(m).padStart(2, '0')}`}
            </text>
          </g>
        ))}

        {/* ponds — flat, solid, light */}
        {[0, 1, 2].map((b) => {
          const { l, r } = bucketBounds(b);
          const surfaceY = FLOOR_Y - levels.current[b];
          const cx = (l + r) / 2;
          const filled = levels.current[b] > 0.5;
          return (
            <g key={b}>
              <rect
                x={l}
                y={RIM_Y - 2}
                width={r - l}
                height={FLOOR_Y - RIM_Y + 2}
                rx={9}
                style={{ fill: 'var(--pond-surface-2)' }}
              />
              {filled && (
                <g clipPath={`url(#pond-clip-${b})`}>
                  <rect
                    x={l}
                    y={surfaceY}
                    width={r - l}
                    height={FLOOR_Y - surfaceY}
                    style={{ fill: WATER }}
                  />
                  <line
                    x1={l}
                    y1={surfaceY}
                    x2={r}
                    y2={surfaceY}
                    style={{ stroke: 'var(--pond-viz-1)' }}
                    strokeWidth={2}
                  />
                </g>
              )}
              <rect
                x={l}
                y={RIM_Y - 2}
                width={r - l}
                height={FLOOR_Y - RIM_Y + 2}
                rx={9}
                fill="none"
                style={{ stroke: 'var(--pond-viz-grid)' }}
                strokeWidth={1.25}
              />
              <text
                x={cx}
                y={FLOOR_Y + 20}
                textAnchor="middle"
                fontSize={13}
                fontFamily="var(--ifm-font-family-monospace)"
                style={ink}
              >
                <tspan style={body}>{reducer} = </tspan>
                {fmt(displayValues[b], reducer)}
              </text>
            </g>
          );
        })}

        {/* drops — flat circles, sized by value */}
        {DROPS.map((d) => {
          const rel = d.i * REL_STEP;
          const t = (e - rel) / FALL;
          const r = rOf(d.v);
          const surfaceY = FLOOR_Y - levels.current[d.bucket];
          if (e < rel) {
            return (
              <circle
                key={d.i}
                cx={d.x}
                cy={TL_Y}
                r={r}
                style={{ fill: 'var(--pond-viz-1)', opacity: 0.3 }}
              />
            );
          }
          if (t < 1) {
            const y = TL_Y + (surfaceY - TL_Y) * t;
            return (
              <circle
                key={d.i}
                cx={d.x}
                cy={y}
                r={r}
                style={{ fill: 'var(--pond-viz-1)' }}
              />
            );
          }
          const age = e - (rel + FALL);
          if (age < 340) {
            const p = age / 340;
            return (
              <ellipse
                key={d.i}
                cx={d.x}
                cy={surfaceY}
                rx={r + p * 12}
                ry={(r + p * 12) * 0.3}
                fill="none"
                style={{ stroke: 'var(--pond-viz-1)', opacity: 0.55 * (1 - p) }}
                strokeWidth={1.4}
              />
            );
          }
          return null;
        })}
      </svg>
      {controls}
    </>
  );
}
