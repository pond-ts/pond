import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

const STEP_MS = 60_000;

/** A `<Region>` — a shaded x span with a flag label. Here it brackets a busy
 *  window on the cpu curve. */
export default function ChartsAnnotationRegion() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const base = series.timeRange()!.begin();

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
          <Region
            from={base + 40 * STEP_MS}
            to={base + 58 * STEP_MS}
            label="busy"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
