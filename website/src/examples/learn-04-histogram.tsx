import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { allHostsSeries } from './lib/server-metrics';

export default function Histogram() {
  const theme = useSiteChartTheme();
  const series = allHostsSeries();
  const count = new Float64Array(series.length).fill(1);
  const bins = series
    .withColumn('count', count)
    .byColumn(
      'latency',
      { width: 5 },
      { count: { from: 'count', using: 'sum' } },
    );

  return (
    <ChartContainer range={[20, 90]} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="count" label="minutes" min={0} width={44} />
        <Layers>
          <BarChart bins={bins} column="count" gap={2} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
