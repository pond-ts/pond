import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { Sequence, TimeRange, TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  PlayButton,
  SegmentedControl,
} from '@site/src/components/ConceptViz';

/**
 * The `align` mental model, drawn with the real charts. The grid splits time
 * into steps — the regions between the orange lines. `sample` picks WHERE in
 * each step the read-line sits (its begin / center / end). At that read-line
 * `hold` takes the previous sample (to its left); `linear` interpolates the two
 * samples around it. The teal dots are the real `align` output at the read-line.
 *
 * Play runs a staged reveal — raw dots → grid → construction lines → aligned
 * dots → the result alone → loop. Pause freezes; changing a knob shows the
 * full view.
 */

function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** (1-t)·a + t·b per channel; falls back to `b` if either isn't 6-digit hex. */
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return b;
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const T_MAX = 170;
const at = (s: number) => BASE + s * 1000;

// One source sample roughly a third into each step (grid boundary + ~6-10s,
// jittered), kept off the begin/center/end read-lines so no carry-line
// collapses.
const RAW = [
  { t: 7, v: 0.32 },
  { t: 39, v: 0.67 },
  { t: 66, v: 0.47 },
  { t: 100, v: 0.73 },
  { t: 128, v: 0.41 },
  { t: 157, v: 0.6 },
];
// The 30s grid lines and the four steps (regions) they bound.
const GRID_LINES = [30, 60, 90, 120, 150];
const STEP_BEGINS = [30, 60, 90, 120];
// A fixed BoundedSequence — the SAME four intervals [30,60)…[120,150) for every
// sample. (Passing a range instead lets align's inclusion vary the interval
// count between begin/center/end, which desyncs the dots from the lines.)
const BOUNDED = Sequence.every('30s').bounded(
  new TimeRange({ start: at(30), end: at(120) }),
  { sample: 'begin' },
);

const rawSeries = TimeSeries.fromJSON({
  name: 'raw',
  schema: SCHEMA,
  rows: RAW.map((r) => [at(r.t), r.v] as [number, number]),
});

const prevOf = (s: number) => [...RAW].reverse().find((r) => r.t <= s)!;

type Method = 'hold' | 'linear';
type Sample = 'begin' | 'center' | 'end';
const METHODS = [
  { value: 'hold' as const, label: 'hold' },
  { value: 'linear' as const, label: 'linear' },
];
const SAMPLES = [
  { value: 'begin' as const, label: 'begin' },
  { value: 'center' as const, label: 'center' },
  { value: 'end' as const, label: 'end' },
];
const OFFSET: Record<Sample, number> = { begin: 0, center: 15, end: 30 };

const HEIGHT = 200;
// Staged reveal durations (ms): raw → +grid → +construction → +aligned → result.
const STAGE_MS = [900, 900, 1100, 1500, 2300];
const N_STAGES = STAGE_MS.length;

// hold: one horizontal segment per step — the previous sample carried right to
// the read-line (step begin + the sample offset).
function holdSegments(sample: Sample): TimeSeries<typeof SCHEMA>[] {
  return STEP_BEGINS.map((b) => {
    const s = b + OFFSET[sample];
    const src = prevOf(s);
    return TimeSeries.fromJSON({
      name: 'seg',
      schema: SCHEMA,
      rows: [
        [at(src.t), src.v],
        [at(s), src.v],
      ],
    });
  });
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

export default function CoreAlign() {
  const base = useSiteChartTheme();
  const theme = useMemo(
    () => ({
      ...base,
      // construction is scaffolding — a light grey, fainter than body text
      line: {
        ...base.line,
        context: {
          ...base.line?.context,
          color: mix(
            base.background ?? '#ffffff',
            base.axis?.label ?? '#889',
            0.5,
          ),
        },
      },
      scatter: {
        ...base.scatter,
        default: { ...base.scatter?.default, outlineWidth: 0 },
        secondary: { ...base.scatter?.secondary, outlineWidth: 0 },
      },
    }),
    [base],
  );

  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const [method, setMethod] = useState<Method>('hold');
  const [sample, setSample] = useState<Sample>('begin');
  const [playing, setPlaying] = useState(true);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(
      () => setStage((s) => (s + 1) % N_STAGES),
      STAGE_MS[stage],
    );
    return () => clearTimeout(t);
  }, [playing, stage]);

  // The teal dots are the real align() output, placed at the read-line
  // (`asTime({ at: sample })` puts each on the same begin/center/end point).
  const aligned = useMemo(
    () => rawSeries.align(BOUNDED, { method, sample }).asTime({ at: sample }),
    [method, sample],
  );
  const segments = useMemo(
    () => (method === 'hold' ? holdSegments(sample) : null),
    [method, sample],
  );

  // Changing a knob jumps to the full view (everything on) and pauses.
  const showAll = () => {
    setStage(3);
    setPlaying(false);
  };
  const blank = () => '';

  // Stage-driven visibility: raw(0-3) → grid(1+) → construction(2-3) →
  // aligned(3+) → result only, raw+construction hidden (4).
  const showRaw = stage <= 3;
  const showGrid = stage >= 1;
  const showConstruction = stage === 2 || stage === 3;
  const showAligned = stage >= 3;

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {width > 0 ? (
          <ChartContainer
            range={[at(0), at(T_MAX)]}
            width={width}
            theme={theme}
          >
            <ChartRow height={HEIGHT}>
              <YAxis
                id="val"
                side="left"
                label="value"
                min={0}
                max={1}
                format={blank}
              />
              <Layers>
                {/* the regular grid — the step boundaries */}
                {showGrid
                  ? GRID_LINES.map((b) => <Marker key={b} at={at(b)} />)
                  : null}
                {/* construction: horizontal carries (hold) or the interp line */}
                {showConstruction ? (
                  method === 'linear' ? (
                    <LineChart
                      series={rawSeries}
                      column="value"
                      axis="val"
                      as="context"
                    />
                  ) : (
                    segments!.map((s, i) => (
                      <LineChart
                        key={i}
                        series={s}
                        column="value"
                        axis="val"
                        as="context"
                      />
                    ))
                  )
                ) : null}
                {/* raw samples (blue) and aligned results (teal) */}
                {showRaw ? (
                  <ScatterChart
                    series={rawSeries}
                    column="value"
                    axis="val"
                    as="secondary"
                    radius={4.5}
                  />
                ) : null}
                {showAligned ? (
                  <ScatterChart
                    series={aligned}
                    column="value"
                    axis="val"
                    radius={4.5}
                  />
                ) : null}
              </Layers>
            </ChartRow>
          </ChartContainer>
        ) : (
          <div style={{ height: HEIGHT }} />
        )}
      </div>
      <ConceptControls>
        <SegmentedControl
          label="method"
          options={METHODS}
          value={method}
          onChange={(v) => {
            setMethod(v);
            showAll();
          }}
        />
        <SegmentedControl
          label="sample"
          options={SAMPLES}
          value={sample}
          onChange={(v) => {
            setSample(v);
            showAll();
          }}
        />
        <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
      </ConceptControls>
    </>
  );
}
