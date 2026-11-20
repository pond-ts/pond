/**
 * One record, three things pond does to it, recomputed every frame. Real
 * data: 44 years of daily Niño 3.4 sea-surface temperature (see ./nino.ts).
 *
 * 1. Zoom with level of detail: narrow the view from 44 years to 75 days and
 *    back; each frame takes the days in view (`within`) and buckets them to
 *    about as many buckets as the chart has room for, or shows the raw days
 *    once a bucket would be one day.
 * 2. A rolling window sweeps across and back: a one-year window (shaded)
 *    travels over the record, and `rolling('365d', …)` draws the one-year
 *    average behind it.
 * 3. Bars from fine to coarse and back: `aggregate(Sequence.every(size), …)`
 *    of the temperature against normal, with the bucket size swept from a
 *    month to two years and back. Warm buckets (El Niño side) are red, cool
 *    ones (La Niña side) blue.
 */
import { Sequence } from 'pond-ts';
import {
  BandChart,
  BarChart,
  Baseline,
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
import { ninoDaily } from './nino';

const DAY = 86_400_000;
const PART = 100; // frames per part
const daily = ninoDaily();
const full = daily.timeRange()!;
const FULL: [number, number] = [full.begin(), full.end()];
const SOURCE = 'daily Pacific temperature 1982-2026 (NOAA)';

const theme = {
  ...defaultTheme,
  background: '#ffffff',
  band: {
    ...defaultTheme.band,
    range: { fill: '#e8836b', opacity: 0.3 },
  },
  line: {
    ...defaultTheme.line,
    avg: { color: '#c2410c', width: 1.75 },
    raw: { color: '#fbd5c5', width: 1 },
  },
  scatter: {
    ...defaultTheme.scatter,
    day: { ...defaultTheme.scatter.default, color: '#c2410c', radius: 3.5 },
  },
};

/** Ramp 0 -> 1 over [a, b) frames, hold at 1 until c, back to 0 by d. */
function inHoldOut(f: number, a: number, b: number, c: number, d: number) {
  if (f < a) return 0;
  if (f < b) return ease((f - a) / (b - a));
  if (f < c) return 1;
  return 1 - ease((f - c) / (d - c));
}

const fmtMonth = (t: number) =>
  new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

// ---------------------------------------------------------------- part 1 ---

const FOCUS = Date.UTC(1997, 11, 1); // the peak of the 1997-98 El Niño
const NARROW = 75 * DAY;
const TARGET_BUCKETS = 260;

function zoomView(z: number): [number, number] {
  const span = Math.exp(
    Math.log(FULL[1] - FULL[0]) * (1 - z) + Math.log(NARROW) * z,
  );
  const mid = (FULL[0] + FULL[1]) / 2;
  const centre = mid + (FOCUS - mid) * Math.min(1, z * 1.6);
  let a = centre - span / 2;
  let b = centre + span / 2;
  if (a < FULL[0]) [a, b] = [FULL[0], FULL[0] + span];
  if (b > FULL[1]) [a, b] = [FULL[1] - span, FULL[1]];
  return [a, b];
}

function spanLabel(ms: number): string {
  const days = ms / DAY;
  return days > 730
    ? `${(days / 365.25).toFixed(1)} years`
    : `${Math.round(days)} days`;
}

function zoomPart(f: number) {
  const view = zoomView(inHoldOut(f, 6, 46, 58, 94));
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
        title="1 · Zoom, with level of detail"
        sub={SOURCE}
        code={
          raw
            ? `nino.within(view)  // every day, as recorded`
            : `nino.within(view).aggregate(Sequence.every('${days}d'), { avg, min, max })`
        }
        stats={[
          ['in view', spanLabel(view[1] - view[0])],
          ['days in view', fmtInt(visible.length)],
          ['drawn as', raw ? 'raw days' : `${fmtInt(buckets!.length)} buckets`],
        ]}
      />
      <ChartContainer range={view} width={CHART_WIDTH} theme={theme}>
        <ChartRow height={280}>
          <YAxis id="c" label="sea surface (°C)" format=".1f" width={50} />
          <Layers>
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
          </Layers>
        </ChartRow>
      </ChartContainer>
    </>
  );
}

// ---------------------------------------------------------------- part 2 ---

const WINDOW_DAYS = 365;
const rolled = daily.rolling(`${WINDOW_DAYS}d`, {
  avg: { from: 'sst', using: 'avg' },
});

function rollingPart(f: number) {
  // Window's right edge: across over ~55 frames, a beat, then back.
  const first = FULL[0] + WINDOW_DAYS * DAY;
  const p = f < 55 ? ease(f / 55) : f < 62 ? 1 : 1 - ease((f - 62) / 38);
  const edge = first + (FULL[1] - first) * p;
  const drawnTo = f < 55 ? edge : FULL[1];
  const trail = rolled.within(FULL[0], drawnTo);
  const inWindow = daily.within(edge - WINDOW_DAYS * DAY, edge);
  const avg = inWindow.reduce('sst', 'avg') as number;
  return (
    <>
      <Header
        title="2 · Rolling window"
        sub={SOURCE}
        code={`nino.rolling('${WINDOW_DAYS}d', { avg: { from: 'sst', using: 'avg' } })`}
        stats={[
          ['window ends', fmtMonth(edge)],
          ['days in window', fmtInt(inWindow.length)],
          ['window average', `${avg.toFixed(2)} °C`],
        ]}
      />
      <ChartContainer range={FULL} width={CHART_WIDTH} theme={theme}>
        <ChartRow height={280}>
          <YAxis
            id="c"
            label="sea surface (°C)"
            format=".1f"
            width={50}
            min={24}
            max={30}
          />
          <Layers>
            <Region from={edge - WINDOW_DAYS * DAY} to={edge} label={false} />
            <LineChart series={daily} column="sst" axis="c" as="raw" />
            <LineChart series={trail} column="avg" axis="c" as="avg" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </>
  );
}

// ---------------------------------------------------------------- part 3 ---

const WARM = '#d64545';
const COOL = '#3d6fd9';
const NEUTRAL = '#cbd5e1';

function barsPart(f: number) {
  const up = inHoldOut(f, 4, 48, 58, 98);
  const days = Math.round(Math.exp(Math.log(30) + up * Math.log(730 / 30)));
  const buckets = daily.aggregate(Sequence.every(`${days}d`), {
    anom: 'avg',
  });
  const colors = buckets.toRows().map((r) => {
    const v = r[1] as number | undefined;
    return v == null ? NEUTRAL : v >= 0.5 ? WARM : v <= -0.5 ? COOL : NEUTRAL;
  });
  const warm = colors.filter((c) => c === WARM).length;
  return (
    <>
      <Header
        title="3 · Bars, fine to coarse"
        sub={SOURCE}
        code={`nino.aggregate(Sequence.every('${days}d'), { anom: 'avg' })`}
        stats={[
          ['bucket', `${days} days`],
          ['bars', fmtInt(buckets.length)],
          ['warm (≥ +0.5 °C)', fmtInt(warm)],
        ]}
      />
      <ChartContainer range={FULL} width={CHART_WIDTH} theme={theme}>
        <ChartRow height={280}>
          <YAxis
            id="a"
            label="vs 1991-2020 normal (°C)"
            format="+.1f"
            width={50}
            min={-2.6}
            max={3}
          />
          <Layers>
            <BarChart
              series={buckets}
              column="anom"
              axis="a"
              binColors={colors}
              gap={days < 60 ? 0 : 1}
            />
            <Baseline value={0} axis="a" label={false} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </>
  );
}

mount(
  (f) =>
    f < PART
      ? zoomPart(f)
      : f < 2 * PART
        ? rollingPart(f - PART)
        : barsPart(f - 2 * PART),
  { frames: 3 * PART, height: 400 },
);
