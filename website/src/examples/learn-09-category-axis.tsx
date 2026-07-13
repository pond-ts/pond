import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
  transposeRow,
} from '@pond-ts/charts';
import { TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

// A wide row — one column per host, the shape transposeRow reads. A real
// source would be the last row of a partitioned rollup; this is a fixed
// snapshot for the demo.
const wideSchema = [
  { name: 'time', kind: 'time' },
  { name: 'api-1', kind: 'number' },
  { name: 'api-2', kind: 'number' },
  { name: 'worker-1', kind: 'number' },
] as const;

function latestCpuByHost() {
  return new TimeSeries({
    name: 'latest-cpu',
    schema: wideSchema,
    rows: [[Date.UTC(2026, 0, 12, 10, 30), 0.34, 0.48, 0.61]],
  });
}

export default function LearnCategoryAxis() {
  const theme = useSiteChartTheme();
  const data = transposeRow(latestCpuByHost(), { at: 'last' });

  return (
    <ChartContainer width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" min={0} />
        <Layers>
          <BarChart categories={data} gap={8} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
