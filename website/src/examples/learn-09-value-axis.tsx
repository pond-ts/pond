import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

export default function LearnValueAxis() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  // A synthetic "minutes elapsed" column — defined, finite, and strictly
  // increasing, so it's a valid byValue() axis. In a real pace-curve or
  // vol-smile series this would already be the natural key (distance,
  // strike) rather than something derived from time.
  const elapsed = new Float64Array(series.length);
  for (let i = 0; i < elapsed.length; i++) elapsed[i] = i;
  const byElapsed = series.withColumn('elapsed', elapsed).byValue('elapsed');

  return (
    <ChartContainer range={[0, elapsed.length - 1]} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={byElapsed} column="cpu" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
