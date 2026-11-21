/**
 * The README story, in one continuous take on the Niño 3.4 record (see
 * ./nino.ts), every frame computed by pond:
 *
 * 1. Zoom from all 44 years into 75 days of single readings (level of detail:
 *    `within` + `aggregate` to about 260 buckets, raw days at the bottom).
 * 2. Zoom back out to the first half of the record, 1982 to mid-2004.
 * 3. A one-year rolling window sweeps across that view.
 * 4. The series goes live: the second half streams into a `LiveSeries`,
 *    about three months of readings per frame, and the live `rolling` view
 *    keeps the one-year average up to date as it arrives.
 *
 * With `boxes`, a live `aggregate(Sequence.calendar('year'), …)` of
 * percentiles fades in during the stream as one box per calendar year, and
 * the daily line fades back to let it read.
 */
import type { ReactNode } from 'react';
import { LiveSeries, Sequence, TimeSeries } from 'pond-ts';
import {
  BandChart,
  BoxPlot,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Region,
  ScatterChart,
  YAxis,
  defaultTheme,
} from '@pond-ts/charts';
import { CHART_WIDTH, Header, ease, fmtInt, mount } from './frame';
import { ninoColumns, ninoDaily } from './nino';

const DAY = 86_400_000;
const WINDOW_DAYS = 365;
const SOURCE = 'Pacific temperature, NOAA';

const daily = ninoDaily();
const full = daily.timeRange()!;
const FULL: [number, number] = [full.begin(), full.end()];
const MID = Date.UTC(2004, 5, 1);
const HALF: [number, number] = [FULL[0], MID];

// The live side. Everything is pushed through a LiveSeries from the start, so
// the rolling line in parts 3 and 4 is one live view's output throughout.
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'sst', kind: 'number' },
] as const;
const live = new LiveSeries({ name: 'nino34', schema });
const rolling = live.rolling(`${WINDOW_DAYS}d`, {
  avg: { from: 'sst', using: 'avg' },
});
const rollTime: number[] = [];
const rollAvg: number[] = [];
rolling.on('event', (e) => {
  rollTime.push(e.begin());
  rollAvg.push(e.get('avg') as number);
});
const years = live.aggregate(Sequence.calendar('year'), {
  lo: { from: 'sst', using: 'p5' },
  q1: { from: 'sst', using: 'p25' },
  med: { from: 'sst', using: 'median' },
  q3: { from: 'sst', using: 'p75' },
  hi: { from: 'sst', using: 'p95' },
});

const cols = ninoColumns();
const rows = cols.time.map((t, i) => [t, cols.sst[i]!] as const);
const midIndex = rows.findIndex((r) => r[0] >= MID);
let pushedTo = midIndex;
live.pushMany(rows.slice(0, midIndex));

const rolledSeries = (to: number) => {
  let n = rollTime.length;
  while (n > 0 && rollTime[n - 1]! > to) n--;
  return TimeSeries.fromColumns({
    name: 'rolling',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'avg', kind: 'number' },
    ] as const,
    columns: { time: rollTime.slice(0, n), avg: rollAvg.slice(0, n) },
  });
};

// Frame plan.
const ZOOM_IN = [0, 46] as const;
const HOLD_IN = 56;
const ZOOM_OUT = [56, 90] as const;
const SWEEP = [94, 142] as const;
const STREAM = [148, 236] as const;
/** Boxes: in over the first part of the stream, then out after it ends. */
const BOX_IN = [8, 34] as const; // frames into the stream
const BOX_OUT = [242, 262] as const;
/** Back out to the whole record, ending on the opening frame so it loops. */
const FINAL_ZOOM = [264, 299] as const;
const FRAMES = 300;
const PER_FRAME = Math.ceil((rows.length - midIndex) / (STREAM[1] - STREAM[0]));

const FOCUS = Date.UTC(1997, 11, 1);
const NARROW = 75 * DAY;
const TARGET_BUCKETS = 260;

const lerpLog = (a: number, b: number, t: number) =>
  Math.exp(Math.log(a) * (1 - t) + Math.log(b) * t);

/** A view of `span` centred on `centre`, kept inside the record. */
function clampView(centre: number, span: number): [number, number] {
  let a = centre - span / 2;
  let b = centre + span / 2;
  if (a < FULL[0]) [a, b] = [FULL[0], FULL[0] + span];
  if (b > FULL[1]) [a, b] = [FULL[1] - span, FULL[1]];
  return [a, b];
}

function zoomView(f: number): [number, number] {
  const fullSpan = FULL[1] - FULL[0];
  const fullMid = (FULL[0] + FULL[1]) / 2;
  if (f < HOLD_IN) {
    const z = ease((f - ZOOM_IN[0]) / (ZOOM_IN[1] - ZOOM_IN[0]));
    const centre = fullMid + (FOCUS - fullMid) * Math.min(1, z * 1.6);
    return clampView(centre, lerpLog(fullSpan, NARROW, z));
  }
  const z = ease((f - ZOOM_OUT[0]) / (ZOOM_OUT[1] - ZOOM_OUT[0]));
  const halfMid = (HALF[0] + HALF[1]) / 2;
  const centre = FOCUS + (halfMid - FOCUS) * Math.min(1, z * 1.4);
  return clampView(centre, lerpLog(NARROW, HALF[1] - HALF[0], z));
}

function spanLabel(ms: number): string {
  const days = ms / DAY;
  return days > 730
    ? `${(days / 365.25).toFixed(1)} years`
    : `${Math.round(days)} days`;
}

const fmtMonth = (t: number) =>
  new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
};

const mixHex = (a: string, b: string, t: number) => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const c = [16, 8, 0].map((sh) => {
    const x = (pa >> sh) & 255;
    return Math.round(x + (((pb >> sh) & 255) - x) * t);
  });
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/** `boxFade` shows the yearly boxes; `endFade` (0 -> 1 as the stream wraps
 *  up) hides the rolling line and turns the daily line into the opening
 *  frame's line, so the cut to the final zoom doesn't show. */
function themeFor(boxFade: number, endFade = 0) {
  return {
    ...defaultTheme,
    background: '#ffffff',
    band: {
      ...defaultTheme.band,
      range: { fill: '#e8836b', opacity: 0.3 },
    },
    line: {
      ...defaultTheme.line,
      avg: { color: '#c2410c', width: 1.75 },
      raw: {
        color: alpha(mixHex('#f4b39b', '#c2410c', endFade), 1 - 0.75 * boxFade),
        width: 1 + 0.75 * endFade,
      },
      trend: {
        color: alpha('#c2410c', (1 - 0.35 * boxFade) * (1 - endFade)),
        width: 2,
      },
    },
    scatter: {
      ...defaultTheme.scatter,
      day: { ...defaultTheme.scatter.default, color: '#c2410c', radius: 3.5 },
    },
    box: {
      ...defaultTheme.box,
      year: {
        fill: '#0284c7',
        fillOpacity: 0.28 * boxFade,
        stroke: alpha('#0284c7', boxFade),
        strokeWidth: 1,
        median: alpha('#075985', boxFade),
        medianWidth: 2,
        whisker: alpha('#5ba7d1', boxFade),
        whiskerWidth: 1,
      },
    },
  };
}

function Chart({
  view,
  boxFade = 0,
  endFade = 0,
  fixedY = false,
  y,
  children,
}: {
  view: [number, number];
  boxFade?: number;
  endFade?: number;
  fixedY?: boolean;
  /** An explicit y domain, overriding `fixedY`. */
  y?: [number, number];
  children: ReactNode;
}) {
  return (
    <ChartContainer
      range={view}
      width={CHART_WIDTH}
      theme={themeFor(boxFade, endFade)}
    >
      <ChartRow height={280}>
        <YAxis
          id="c"
          label="sea surface (°C)"
          format=".1f"
          width={50}
          {...(y
            ? { min: y[0], max: y[1] }
            : fixedY
              ? { min: 24, max: 30 }
              : {})}
        />
        <Layers>{children}</Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/** The y domain for a zoom view: the fixed 24-30 °C used everywhere else
 *  while the view is wide, blending into the data's own range as it narrows,
 *  so the axis never jumps. */
function zoomY(
  view: [number, number],
  lo: number,
  hi: number,
): [number, number] {
  const span = (view[1] - view[0]) / DAY;
  const w = Math.min(
    1,
    Math.max(0, Math.log(span / 400) / Math.log(3000 / 400)),
  );
  const pad = (hi - lo) * 0.08 || 0.1;
  return [24 * w + (lo - pad) * (1 - w), 30 * w + (hi + pad) * (1 - w)];
}

function zoomFrame(f: number, at?: [number, number]) {
  const view = at ?? zoomView(f);
  const visible = daily.within(view[0] - DAY, view[1] + DAY);
  const days = Math.floor((view[1] - view[0]) / DAY / TARGET_BUCKETS);
  const raw = days <= 1;
  const buckets = raw
    ? null
    : visible.aggregate(Sequence.every(`${days}d`), {
        avg: { from: 'sst', using: 'avg' },
        lo: { from: 'sst', using: 'min' },
        hi: { from: 'sst', using: 'max' },
      });
  return (
    <>
      <Header
        title="Zoom, with level of detail"
        sub={SOURCE}
        code={
          raw
            ? `nino.within(view)  // every day, as recorded`
            : `nino.within(view).aggregate(Sequence.every('${days}d'), {…})`
        }
        stats={[
          ['in view', spanLabel(view[1] - view[0])],
          ['days in view', fmtInt(visible.length)],
          ['drawn as', raw ? 'raw days' : `${fmtInt(buckets!.length)} buckets`],
        ]}
      />
      <Chart
        view={view}
        y={zoomY(
          view,
          (buckets
            ? buckets.column('lo').min()
            : visible.column('sst').min()) as number,
          (buckets
            ? buckets.column('hi').max()
            : visible.column('sst').max()) as number,
        )}
      >
        {buckets ? (
          <>
            <BandChart
              series={buckets}
              lower="lo"
              upper="hi"
              axis="c"
              as="range"
            />
            <LineChart series={buckets} column="avg" axis="c" as="avg" />
          </>
        ) : (
          <>
            <LineChart series={visible} column="sst" axis="c" as="avg" />
            <ScatterChart series={visible} column="sst" axis="c" as="day" />
          </>
        )}
      </Chart>
    </>
  );
}

const firstHalf = daily.within(HALF[0], HALF[1]);

function sweepFrame(f: number) {
  const first = HALF[0] + WINDOW_DAYS * DAY;
  const p = ease((f - SWEEP[0]) / (SWEEP[1] - SWEEP[0]));
  const edge = f < SWEEP[0] ? first : first + (HALF[1] - first) * p;
  const inWindow = daily.within(edge - WINDOW_DAYS * DAY, edge);
  const avg = inWindow.reduce('sst', 'avg') as number;
  return (
    <>
      <Header
        title="Rolling window"
        sub={SOURCE}
        code={`nino.rolling('${WINDOW_DAYS}d', { avg: { from: 'sst', using: 'avg' } })`}
        stats={[
          ['window ends', fmtMonth(edge)],
          ['days in window', fmtInt(inWindow.length)],
          ['window average', `${avg.toFixed(2)} °C`],
        ]}
      />
      <Chart view={HALF} fixedY>
        <Region from={edge - WINDOW_DAYS * DAY} to={edge} label={false} />
        <LineChart series={firstHalf} column="sst" axis="c" as="raw" />
        <LineChart
          series={rolledSeries(edge)}
          column="avg"
          axis="c"
          as="trend"
        />
      </Chart>
    </>
  );
}

function streamFrame(f: number, boxes: boolean) {
  const s = Math.min(f, STREAM[1]) - STREAM[0];
  if (f >= STREAM[0] && f < STREAM[1] && pushedTo < rows.length) {
    const next = Math.min(rows.length, pushedTo + PER_FRAME);
    live.pushMany(rows.slice(pushedTo, next));
    pushedTo = next;
  }
  const snap = live.toTimeSeries();
  const latest = snap.timeRange()!.end();
  const width = HALF[1] - HALF[0];
  // Slide in over the first few frames from the half view to a view that
  // follows the newest reading.
  const follow = ease(Math.min(1, s / 12));
  const right = HALF[1] + (Math.max(latest, HALF[1]) - HALF[1]) * follow;
  const view: [number, number] = [right - width, right];
  const into = (f: number, [a, b]: readonly [number, number]) =>
    Math.min(1, Math.max(0, (f - a) / (b - a)));
  const boxFade = boxes
    ? ease(into(s, BOX_IN)) * (1 - ease(into(f, BOX_OUT)))
    : 0;
  const endFade = ease(into(f, BOX_OUT));
  const yearBoxes = boxes ? years.snapshot() : null;
  return (
    <>
      <Header
        title="Live"
        sub={SOURCE}
        code={
          boxes && boxFade > 0.5
            ? `live.aggregate(Sequence.calendar('year'), { p5, p25, median, p75, p95 })`
            : `live.pushMany(next90Days)  // rolling view updates as rows arrive`
        }
        stats={[
          ['latest reading', fmtMonth(latest)],
          ['rows pushed', fmtInt(pushedTo)],
          boxes
            ? ['years boxed', fmtInt(yearBoxes!.length)]
            : ['rolling rows', fmtInt(rollTime.length)],
        ]}
      />
      <Chart view={view} boxFade={boxFade} endFade={endFade} fixedY>
        <LineChart series={snap} column="sst" axis="c" as="raw" />
        {yearBoxes && boxFade > 0 ? (
          <BoxPlot
            series={yearBoxes}
            lower="lo"
            q1="q1"
            median="med"
            q3="q3"
            upper="hi"
            axis="c"
            as="year"
            gap={4}
          />
        ) : null}
        <LineChart
          series={rolledSeries(latest)}
          column="avg"
          axis="c"
          as="trend"
        />
      </Chart>
    </>
  );
}

/** The live view at the end of the stream, widening back to the whole
 *  record: the same drawing as the opening frame by the last frame. */
function finalFrame(f: number) {
  const z = ease((f - FINAL_ZOOM[0]) / (FINAL_ZOOM[1] - FINAL_ZOOM[0]));
  const width = HALF[1] - HALF[0];
  const a = FULL[1] - width + (FULL[0] - (FULL[1] - width)) * z;
  return zoomFrame(f, [a, FULL[1]]);
}

export function story(boxes: boolean) {
  mount(
    (f) =>
      f <= ZOOM_OUT[1]
        ? zoomFrame(f)
        : f < STREAM[0]
          ? sweepFrame(f)
          : f < FINAL_ZOOM[0]
            ? streamFrame(f, boxes)
            : finalFrame(f),
    { frames: FRAMES, height: 400 },
  );
}
