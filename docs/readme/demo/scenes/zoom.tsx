/**
 * Zooming with level of detail. Real data: 44 years of daily Niño 3.4
 * sea-surface temperature (see ./nino.ts). Each frame narrows (or widens) the
 * view, takes only the days in it with `within`, and buckets them so there
 * are never many more buckets than the chart has room for: years of data
 * become a few hundred buckets with their range, and once a bucket would be
 * a single day the chart shows the raw days themselves.
 */
import { Sequence } from 'pond-ts';
import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  YAxis,
  defaultTheme,
} from '@pond-ts/charts';
import { CHART_WIDTH, Header, ease, fmtInt, mount } from './frame';
import { ninoDaily } from './nino';

const FRAMES = 140;
const DAY = 86_400_000;
const TARGET_BUCKETS = 260;
const daily = ninoDaily();
const full = daily.timeRange()!;
const FULL: [number, number] = [full.begin(), full.end()];
/** Where the zoom lands: the peak of the 1997-98 El Niño. */
const FOCUS = Date.UTC(1997, 11, 1);
const NARROW = 75 * DAY;

/** How far in, 0 (everything) .. 1 (75 days) for frame f. */
function zoomFor(f: number): number {
  if (f < 10) return 0;
  if (f < 92) return ease((f - 10) / 82);
  if (f < 106) return 1;
  return 1 - ease((f - 106) / 34);
}

function viewFor(z: number): [number, number] {
  const span = Math.exp(
    Math.log(FULL[1] - FULL[0]) * (1 - z) + Math.log(NARROW) * z,
  );
  // Slide the centre from the middle of the record to the focus as we zoom.
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
  },
  scatter: {
    ...defaultTheme.scatter,
    day: { ...defaultTheme.scatter.default, color: '#c2410c', radius: 3.5 },
  },
};

mount(
  (f) => {
    const view = viewFor(zoomFor(f));
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
          title="Zoom with level of detail"
          sub="44 years of daily Pacific temperature (NOAA)"
          code={
            raw
              ? `nino.within(view)  // every day, as recorded`
              : `nino.within(view).aggregate(Sequence.every('${days}d'), { avg, min, max })`
          }
          stats={[
            ['in view', spanLabel(view[1] - view[0])],
            ['days in view', fmtInt(visible.length)],
            [
              'drawn as',
              raw ? 'raw days' : `${fmtInt(buckets!.length)} buckets`,
            ],
          ]}
        />
        <ChartContainer range={view} width={CHART_WIDTH} theme={theme}>
          <ChartRow height={300}>
            <YAxis
              id="c"
              label="Niño 3.4 sea surface (°C)"
              format=".1f"
              width={50}
            />
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
                  <ScatterChart
                    series={visible}
                    column="sst"
                    axis="c"
                    as="day"
                  />
                </>
              )}
            </Layers>
          </ChartRow>
        </ChartContainer>
      </>
    );
  },
  { frames: FRAMES },
);
