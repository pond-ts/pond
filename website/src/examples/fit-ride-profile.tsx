import {
  AreaChart,
  ChartContainer,
  ChartRow,
  CrosshairCursor,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { Activity, haversineMeters } from '@pond-ts/fit';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { hillRide } from './lib/fit-fixtures';

// The ride, as `readActivity` reads hill-ride.fit.
const ride = Activity.from(hillRide());
const track = ride.toSeries();

// Kilometres from the start, from the GPS steps: a column that only goes up,
// so it can be the x axis instead of time.
const lat = track.column('lat')!.toFloat64Array();
const lng = track.column('lng')!.toFloat64Array();
let km = 0;
const along = lat.map((_, i) => {
  if (i)
    km += haversineMeters(lat[i - 1]!, lng[i - 1]!, lat[i]!, lng[i]!) / 1000;
  return km;
});

// Power over the last 30 s, so the line reads as effort rather than as every
// pedal stroke. Then both channels go onto the distance axis.
const smoothed = track.smooth('power', 'movingAverage', {
  window: '30s',
  output: 'power30',
});
const byDistance = smoothed.withColumn('km', along).byValue('km');

export default function FitRideProfile({ width = 680 }: { width?: number }) {
  const theme = useSiteChartTheme();
  return (
    <ChartContainer range={[0, km]} width={width} theme={theme}>
      <CrosshairCursor />
      <ChartRow height={130}>
        <YAxis id="w" label="watts" min={0} width={52} />
        <Layers>
          <LineChart
            series={byDistance}
            column="power30"
            axis="w"
            as="primary"
          />
        </Layers>
      </ChartRow>
      <ChartRow height={110}>
        <YAxis id="m" label="metres" width={52} pad={0.05} />
        <Layers>
          <AreaChart
            series={byDistance}
            column="ele"
            axis="m"
            baseline="floor"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
