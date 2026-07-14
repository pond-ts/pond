import {
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

/** A `<Baseline>` — a horizontal line at a y value on a named axis. `indicator`
 *  also pins its value to the y-axis as an on-axis pill. */
export default function ChartsAnnotationBaseline() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
          <Baseline value={0.43} axis="pct" label="target" indicator />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
