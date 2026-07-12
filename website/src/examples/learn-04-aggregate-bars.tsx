import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { Sequence } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

export default function AggregateBars() {
  const theme = useSiteChartTheme();
  const buckets = singleHostSeries().aggregate(Sequence.every('10m'), {
    cpu: 'avg',
  });

  return (
    <ChartContainer range={buckets.timeRange()} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" min={0} />
        <Layers>
          <BarChart series={buckets} column="cpu" axis="pct" gap={3} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
