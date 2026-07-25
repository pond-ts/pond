import {
  Baseline,
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { computePower } from '@pond-ts/fit';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { ride, RIDE_ELAPSED_S, RIDE_FTP } from './lib/ride-fixtures';

// ── 1. The ride, and one core transform ────────────────────────────────────
const rideSeries = ride(); // 40 min at 1 Hz
const smoothed = rideSeries.smooth('watts', 'movingAverage', {
  window: '30s',
  output: 'watts30',
});

// ── 2. The histogram — pond's own value-axis aggregation ───────────────────
// Samples are 1 Hz, so counting rows in a watt band *is* seconds in that band.
const bins = rideSeries
  .byColumn('watts', { width: 25 }, { secs: { from: 'watts', using: 'count' } })
  .map((b) => ({ ...b, minutes: b.secs / 60 }));

// ── 3. The domain layer — @pond-ts/fit turns watts into ride analytics ──────
// fit works in typed arrays: elapsed seconds + watts.
const startMs = rideSeries.keyColumn().begin[0]!;
const timeSec = Float64Array.from(
  rideSeries.keyColumn().begin,
  (ms) => (ms - startMs) / 1000,
);
const power = computePower(
  timeSec,
  rideSeries.column('watts').toFloat64Array(),
  RIDE_FTP,
  RIDE_ELAPSED_S,
);

export default function GettingStartedRide() {
  const theme = useSiteChartTheme();

  return (
    <div>
      {/* Time axis: the ride as it happened. */}
      <ChartContainer
        range={rideSeries.timeRange()}
        width={680}
        theme={theme}
        cursor="crosshair"
      >
        <ChartRow height={200}>
          <YAxis id="w" label="watts" min={0} width={52} />
          <Layers>
            <LineChart
              series={rideSeries}
              column="watts"
              axis="w"
              as="secondary"
              legend="power"
            />
            <LineChart
              series={smoothed}
              column="watts30"
              axis="w"
              as="primary"
              legend="30 s average"
            />
            <Baseline
              value={power.normalizedWatts}
              axis="w"
              label={`NP ${Math.round(power.normalizedWatts)} W`}
              indicator
            />
          </Layers>
        </ChartRow>
        <Legend placement="top-right" />
      </ChartContainer>

      {/* Value axis: where the time actually went. */}
      <ChartContainer range={[100, 375]} width={680} theme={theme}>
        <ChartRow height={130}>
          <YAxis id="min" label="minutes" min={0} width={52} />
          <Layers>
            <BarChart bins={bins} column="minutes" axis="min" gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
