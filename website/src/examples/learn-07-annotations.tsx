import {
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  Region,
  YAxis,
  YAxisIndicator,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

const STEP_MS = 60_000;

export default function LearnAnnotations() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  // singleHostSeries() always returns a non-empty, fixed-length series, so
  // timeRange() is never undefined here.
  const base = series.timeRange()!.begin();
  const latest = series.at(series.length - 1)?.get('cpu');

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
          <Region
            from={base + 40 * STEP_MS}
            to={base + 55 * STEP_MS}
            label="busy"
          />
          <Marker at={base + 40 * STEP_MS} label="deploy" />
          <Baseline value={0.4} axis="pct" label="target" />
          {latest !== undefined && <YAxisIndicator value={latest} axis="pct" />}
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
