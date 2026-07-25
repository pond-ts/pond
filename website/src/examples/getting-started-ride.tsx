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
const rideSeries = ride(); // 1 h 54 m of real 1 Hz power
const smoothed = rideSeries.smooth('watts', 'movingAverage', {
  window: '30s',
  output: 'watts30',
});

// A pedalling-only column: 0 W is real (you're coasting) but drawing it as a
// line to the floor turns every descent into a picket fence. Blank it and the
// chart's gap handling breaks the line instead. The 30 s average still
// averages the zeros — coasting is part of your effort, just not of the trace.
const wattsRaw = rideSeries.column('watts').toFloat64Array();
const withGaps = rideSeries.withColumn(
  'pedalling',
  Array.from(wattsRaw, (w) => (w > 0 ? w : undefined)),
);

// ── 2. The histogram — pond's own value-axis aggregation ───────────────────
// Samples are 1 Hz, so counting rows in a watt band *is* seconds in that band.
const bins = rideSeries
  .byColumn('watts', { width: 25 }, { secs: { from: 'watts', using: 'count' } })
  .map((b) => ({ ...b, minutes: b.secs / 60 }));

// The 0–25 W bucket is half an hour of coasting — three times any other bar.
// Cap the axis at the tallest *pedalling* bar so it doesn't flatten the part of
// the distribution worth reading; the coasting bar then runs off the top, and
// is drawn faintly so it reads as context rather than as the headline.
const pedallingPeak = Math.max(...bins.slice(1).map((b) => b.minutes));
const fadeFirstBar = (fill: string) =>
  bins.map((_, i) =>
    i === 0 ? (/^#[0-9a-f]{6}$/i.test(fill) ? `${fill}80` : fill) : undefined,
  );

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
      {/* Time axis: the ride as it happened. `origin="data"` labels the ticks
          as time into the ride — nobody cares what o'clock it was in 2016. */}
      <ChartContainer
        range={rideSeries.timeRange()}
        width={680}
        theme={theme}
        cursor="crosshair"
        origin="data"
      >
        <ChartRow height={200}>
          <YAxis id="w" label="watts" min={0} width={52} />
          <Layers>
            <LineChart
              series={withGaps}
              column="pedalling"
              axis="w"
              as="muted"
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
      <ChartContainer range={[0, 450]} width={680} theme={theme}>
        <ChartRow height={130}>
          <YAxis
            id="min"
            label="minutes"
            min={0}
            max={pedallingPeak}
            width={52}
          />
          <Layers>
            <BarChart
              bins={bins}
              column="minutes"
              axis="min"
              binColors={fadeFirstBar(theme.bar.default.fill)}
              gap={2}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
