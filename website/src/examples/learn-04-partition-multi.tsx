import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { allHostsSeries, HOSTS } from './lib/server-metrics';

const ROLES = ['primary', 'secondary', 'slow'] as const;

export default function PartitionMulti() {
  const theme = useSiteChartTheme();
  const series = allHostsSeries();
  const byHost = series.partitionBy('host').toMap();

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          {HOSTS.map((host, i) => {
            const hostSeries = byHost.get(host);
            if (!hostSeries) return null;
            return (
              <LineChart
                key={host}
                series={hostSeries}
                column="cpu"
                axis="pct"
                as={ROLES[i]}
              />
            );
          })}
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
