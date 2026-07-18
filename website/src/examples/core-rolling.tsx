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
import { Sequence, TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  PlayButton,
  SegmentedControl,
} from '@site/src/components/ConceptViz';

/**
 * The `rolling` mental model, drawn with the real charts. Raw samples (blue)
 * stream along the time axis; a sliding **window** (orange Region) anchored at
 * the **anchor** (orange Marker) reduces the samples inside it, and the result
 * traces the teal **rolling line**. `anchor` chooses what the window is
 * anchored to — each event, or a regular sequence; `alignment` places the
 * window trailing / centered / leading around the anchor. The teal line is the
 * real `rolling()` output. Play sweeps the anchor across the data.
 */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (s: number) => BASE + s * 1000;

const RAW: Array<[number, number]> = [
  [10, 0.4],
  [22, 0.6],
  [31, 0.48],
  [43, 0.68],
  [52, 0.54],
  [64, 0.72],
  [73, 0.58],
  [85, 0.66],
  [96, 0.5],
  [108, 0.44],
  [117, 0.56],
  [129, 0.46],
  [140, 0.58],
];
const source = TimeSeries.fromJSON({
  name: 'raw',
  schema: SCHEMA,
  rows: RAW.map(([s, v]) => [at(s), v] as [number, number]),
});

const WINDOW = '40s';
const WINDOW_MS = 40_000;
const GRID = '20s';

type Anchor = 'event' | 'sequence';
type Alignment = 'trailing' | 'centered' | 'leading';
const ANCHORS = [
  { value: 'event' as const, label: 'event' },
  { value: 'sequence' as const, label: 'sequence' },
];
const ALIGNMENTS = [
  { value: 'trailing' as const, label: 'trailing' },
  { value: 'centered' as const, label: 'centered' },
  { value: 'leading' as const, label: 'leading' },
];

const HEIGHT = 210;
const STEP_MS = 620;

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

export default function CoreRolling() {
  const base = useSiteChartTheme();
  const theme = useMemo(
    () => ({
      ...base,
      scatter: {
        ...base.scatter,
        default: { ...base.scatter?.default, outlineWidth: 0 },
        secondary: { ...base.scatter?.secondary, outlineWidth: 0 },
      },
    }),
    [base],
  );
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const [anchor, setAnchor] = useState<Anchor>('event');
  const [alignment, setAlignment] = useState<Alignment>('trailing');
  const [playing, setPlaying] = useState(true);
  const [idx, setIdx] = useState(0);

  // The real rolling() output — per-event, or grid-anchored via a sequence.
  const rollingOut = useMemo(
    () =>
      anchor === 'event'
        ? source.rolling(WINDOW, { value: 'avg' }, { alignment })
        : source
            .rolling(
              Sequence.every(GRID),
              WINDOW,
              { value: 'avg' },
              { alignment, sample: 'begin' },
            )
            .asTime({ at: 'begin' }),
    [anchor, alignment],
  );
  const anchorTimes = useMemo(
    () => rollingOut.toPoints().map((p) => p.ts as number),
    [rollingOut],
  );

  // Keep idx in range as the anchor set changes; sweep it while playing.
  useEffect(() => {
    setIdx((i) => (i >= anchorTimes.length ? 0 : i));
  }, [anchorTimes.length]);
  useEffect(() => {
    if (!playing || anchorTimes.length === 0) return;
    const t = setInterval(
      () => setIdx((i) => (i + 1) % anchorTimes.length),
      STEP_MS,
    );
    return () => clearInterval(t);
  }, [playing, anchorTimes.length]);

  const i = Math.min(idx, Math.max(0, anchorTimes.length - 1));
  const a = anchorTimes[i] ?? at(0);
  const [wLo, wHi] =
    alignment === 'trailing'
      ? [a - WINDOW_MS, a]
      : alignment === 'leading'
        ? [a, a + WINDOW_MS]
        : [a - WINDOW_MS / 2, a + WINDOW_MS / 2];

  const revealed = useMemo(() => rollingOut.slice(0, i + 1), [rollingOut, i]);
  const current = useMemo(() => rollingOut.slice(i, i + 1), [rollingOut, i]);

  const ready = width > 0 && anchorTimes.length > 0;

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {ready ? (
          <ChartContainer
            range={[at(-25), at(175)]}
            width={width}
            theme={theme}
          >
            <ChartRow height={HEIGHT}>
              <YAxis id="val" side="left" label="value" min={0.2} max={0.85} />
              <Layers>
                {/* the sliding window + its anchor */}
                <Region from={wLo} to={wHi} label="window" />
                <Marker at={a} />
                {/* raw samples, then the rolling output line + current point */}
                <ScatterChart
                  series={source}
                  column="value"
                  axis="val"
                  as="secondary"
                  radius={3.5}
                />
                <LineChart
                  series={revealed}
                  column="value"
                  axis="val"
                  curve="monotone"
                />
                <ScatterChart
                  series={current}
                  column="value"
                  axis="val"
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
        <SegmentedControl
          label="anchor"
          options={ANCHORS}
          value={anchor}
          onChange={(v) => {
            setAnchor(v);
            setPlaying(false);
          }}
        />
        <SegmentedControl
          label="alignment"
          options={ALIGNMENTS}
          value={alignment}
          onChange={(v) => {
            setAlignment(v);
            setPlaying(false);
          }}
        />
        <PlayButton playing={playing} onToggle={() => setPlaying((p) => !p)} />
      </ConceptControls>
    </>
  );
}
