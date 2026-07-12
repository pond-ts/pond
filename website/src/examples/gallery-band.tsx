import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { latencyPercentileBand } from './lib/gallery-fixtures';

/** Variance band: a rolling p5–p95 latency envelope with the p50 centreline
 *  — two nested bands (`outer`/`inner`) plus a line, the shape a
 *  `rollingByColumn` percentile pass produces. */
export default function GalleryBand({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = latencyPercentileBand();

  return (
    <ChartContainer range={series.timeRange()} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="ms" side="right" label="ms" format=",.0f" width={44} />
        <Layers>
          <BandChart
            series={series}
            lower="p5"
            upper="p95"
            as="outer"
            axis="ms"
          />
          <BandChart
            series={series}
            lower="p25"
            upper="p75"
            as="inner"
            axis="ms"
          />
          <LineChart series={series} column="p50" axis="ms" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
