/**
 * Smoothing, re-run every frame with a different window. Real data: a 1 Hz
 * power-meter recording of a 1 h 54 m bike ride (the docs' ride fixture; see
 * website/src/examples/lib/ride-samples.ts for where it came from). Each frame
 * calls `smooth('watts', 'movingAverage', { window })` on all 6,869 samples
 * with the window for that frame, from one second up to ten minutes and back.
 */
import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  defaultTheme,
} from '@pond-ts/charts';
import { ride } from '../../../../website/src/examples/lib/ride-fixtures';
import { CHART_WIDTH, Header, ease, fmtInt, mount } from './frame';

const FRAMES = 132;
const series = ride();
const range = series.timeRange()!;
const view: [number, number] = [range.begin(), range.end()];

/** Window in seconds for frame f: log scale, 1 s -> 600 s -> 1 s, with holds. */
function windowFor(f: number): number {
  const up = f < 60 ? ease(f / 60) : f < 72 ? 1 : 1 - ease((f - 72) / 52);
  const s = Math.exp(up * Math.log(600));
  return s < 60 ? Math.max(1, Math.round(s)) : Math.round(s / 5) * 5;
}

function label(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m${r}s`;
}

const theme = {
  ...defaultTheme,
  background: '#ffffff',
  line: {
    ...defaultTheme.line,
    raw: { color: '#cbd5e1', width: 1 },
    smooth: { color: '#0284c7', width: 2 },
  },
  area: {
    ...defaultTheme.area,
    ground: {
      color: '#94a3b8',
      width: 1,
      fill: '#94a3b8',
      fillOpacity: 0.25,
    },
  },
};

mount(
  (f) => {
    const w = windowFor(f);
    const smoothed = series.smooth('watts', 'movingAverage', {
      window: `${w}s`,
      alignment: 'centered',
      output: 'avg',
    });
    const peak = smoothed.reduce('avg', 'max') as number;
    return (
      <>
        <Header
          title="Smoothing, live"
          sub="a real 1 Hz bike ride"
          code={`ride.smooth('watts', 'movingAverage', { window: '${label(w)}' })`}
          stats={[
            ['samples', fmtInt(series.length)],
            ['window', label(w)],
            ['peak of the line', `${peak.toFixed(0)} W`],
          ]}
        />
        <ChartContainer range={view} width={CHART_WIDTH} theme={theme}>
          <ChartRow height={240}>
            <YAxis
              id="w"
              label="power (W)"
              format=",.0f"
              width={50}
              min={0}
              max={500}
            />
            <Layers>
              <LineChart series={series} column="watts" axis="w" as="raw" />
              <LineChart series={smoothed} column="avg" axis="w" as="smooth" />
            </Layers>
          </ChartRow>
          <ChartRow height={70}>
            <YAxis id="m" label="elevation (m)" format=",.0f" width={50} />
            <Layers>
              <AreaChart
                series={series}
                column="elevation"
                axis="m"
                as="ground"
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </>
    );
  },
  { frames: FRAMES },
);
