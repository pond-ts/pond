import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { requestMetrics } from './lib/gallery-fixtures';

/** Ops dashboard: requests/sec (area) over error rate (line), two rows
 *  sharing one time axis and cursor — the multi-row layout ops telemetry
 *  reaches for first. */
export default function GalleryDashboard({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = requestMetrics();

  return (
    <ChartContainer range={series.timeRange()} width={width} theme={theme}>
      <ChartRow height={90}>
        <YAxis id="rps" side="right" format=",.0f" width={46} />
        <Layers>
          <AreaChart series={series} column="rps" axis="rps" />
        </Layers>
      </ChartRow>
      <ChartRow height={70}>
        <YAxis id="err" side="right" format=".1%" width={46} />
        <Layers>
          <LineChart series={series} column="errorRate" axis="err" as="slow" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
