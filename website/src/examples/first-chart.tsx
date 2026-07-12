import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

export default function FirstChart() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
        </Layers>
        <YAxis id="pct" side="right" format=".0%" />
      </ChartRow>
    </ChartContainer>
  );
}
