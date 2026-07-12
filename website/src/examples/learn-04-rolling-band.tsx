import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

export default function RollingBand() {
  const theme = useSiteChartTheme();
  const banded = singleHostSeries().baseline('cpu', {
    window: '10m',
    sigma: 1.5,
  });

  return (
    <ChartContainer range={banded.timeRange()} width={560} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <BandChart
            series={banded}
            lower="lower"
            upper="upper"
            axis="pct"
            as="outer"
          />
          <LineChart series={banded} column="avg" axis="pct" as="primary" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
