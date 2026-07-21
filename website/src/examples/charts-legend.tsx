import {
  BandChart,
  ChartContainer,
  Legend,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { latencyPercentileBand } from './lib/gallery-fixtures';

/** The zero-config card: `<Legend />` enumerates the registered layers. Each
 *  row's swatch is the layer's *resolved* style (a translucent band, a solid
 *  line), so the key can never drift from the plot. `legend="…"` renames a
 *  row without touching its `as` style role. */
export default function ChartsLegend({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const band = latencyPercentileBand();

  return (
    <ChartContainer range={band.timeRange()} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="ms" label="latency (ms)" width={56} />
        <Layers>
          <BandChart
            series={band}
            lower="p25"
            upper="p75"
            as="inner"
            legend="p25–p75"
            axis="ms"
          />
          <LineChart
            series={band}
            column="p50"
            as="primary"
            legend="median"
            axis="ms"
          />
          <LineChart
            series={band}
            column="p95"
            as="secondary"
            legend="p95"
            axis="ms"
          />
        </Layers>
      </ChartRow>
      <Legend placement="top-right" />
    </ChartContainer>
  );
}
