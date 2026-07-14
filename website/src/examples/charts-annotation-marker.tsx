import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

const STEP_MS = 60_000;

/** A `<Marker>` — a vertical line at an x. `indicator` also pins its time to
 *  the x-axis as an on-axis pill (the axis-edge counterpart of the chip). */
export default function ChartsAnnotationMarker() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const base = series.timeRange()!.begin();

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
          <Marker at={base + 40 * STEP_MS} label="deploy" indicator />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
