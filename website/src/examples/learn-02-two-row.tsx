import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

export default function TwoRow() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={140}>
        <YAxis id="pct" side="right" label="cpu" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" as="primary" />
        </Layers>
      </ChartRow>
      <ChartRow height={100}>
        <YAxis id="ms" side="right" label="latency (ms)" format=",.0f" />
        <Layers>
          <LineChart
            series={series}
            column="latency"
            axis="ms"
            as="secondary"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
