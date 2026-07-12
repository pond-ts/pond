import {
  BoxPlot,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { hourlyLatencyBoxes, hourlyLatencyRange } from './lib/gallery-fixtures';

/** Latency percentiles: hourly box-and-whisker buckets from five
 *  pre-computed quantile columns — the shape a percentile rollup produces. */
export default function GalleryBoxplot({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = hourlyLatencyBoxes();

  return (
    <ChartContainer range={hourlyLatencyRange()} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="ms" side="right" label="ms" format=",.0f" width={44} />
        <Layers>
          <BoxPlot
            series={series}
            lower="p5"
            q1="p25"
            median="p50"
            q3="p75"
            upper="p95"
            axis="ms"
            gap={10}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
