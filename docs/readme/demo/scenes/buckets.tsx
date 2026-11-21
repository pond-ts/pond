/**
 * Buckets, re-sized every frame. Real data: 44 years of daily sea-surface
 * temperature in the Niño 3.4 box (see ./nino.ts). Each frame calls
 * `aggregate(Sequence.every(size), …)` on all 16,000-plus days with that
 * frame's bucket size, from one week up to a year and back, and draws each
 * bucket's average with its coolest-to-warmest range around it.
 */
import { Sequence } from 'pond-ts';
import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  defaultTheme,
} from '@pond-ts/charts';
import { CHART_WIDTH, Header, ease, fmtInt, mount } from './frame';
import { ninoDaily } from './nino';

const FRAMES = 132;
const daily = ninoDaily();
const range = daily.timeRange()!;
const view: [number, number] = [range.begin(), range.end()];

/** Bucket size in days for frame f: log scale, 7 -> 365 -> 7, with holds. */
function daysFor(f: number): number {
  const up = f < 60 ? ease(f / 60) : f < 72 ? 1 : 1 - ease((f - 72) / 52);
  return Math.round(Math.exp(Math.log(7) + up * Math.log(365 / 7)));
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
};

mount(
  (f) => {
    const days = daysFor(f);
    const buckets = daily.aggregate(Sequence.every(`${days}d`), {
      avg: { from: 'sst', using: 'avg' },
      lo: { from: 'sst', using: 'min' },
      hi: { from: 'sst', using: 'max' },
    });
    return (
      <>
        <Header
          title="Buckets, resized live"
          sub="44 years of Pacific temperature (NOAA)"
          code={`nino.aggregate(Sequence.every('${days}d'), { avg, min, max })`}
          stats={[
            ['days in', fmtInt(daily.length)],
            ['bucket', days === 7 ? '1 week' : `${days} days`],
            ['buckets out', fmtInt(buckets.length)],
          ]}
        />
        <ChartContainer range={view} width={CHART_WIDTH} theme={theme}>
          <ChartRow height={300}>
            <YAxis
              id="c"
              label="Niño 3.4 sea surface (°C)"
              format=".1f"
              width={50}
              min={24}
              max={30}
            />
            <Layers>
              <BandChart
                series={buckets}
                lower="lo"
                upper="hi"
                axis="c"
                as="range"
              />
              <LineChart series={buckets} column="avg" axis="c" as="avg" />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </>
    );
  },
  { frames: FRAMES },
);
