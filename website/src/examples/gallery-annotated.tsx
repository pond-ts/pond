import {
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  annotatedLatency,
  annotatedLatencyMarks,
} from './lib/gallery-fixtures';

/** Annotated chart: latency data (the *data* register) with an incident
 *  window, a deploy marker, and an SLA baseline (the *annotation* register)
 *  — two registers that never share a hue, so a placed mark is never
 *  mistaken for a series. */
export default function GalleryAnnotated({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = annotatedLatency();
  const marks = annotatedLatencyMarks;

  return (
    <ChartContainer range={series.timeRange()} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="ms" side="right" label="ms" format=",.0f" width={44} />
        <Layers>
          <LineChart series={series} column="latency" axis="ms" />
          <Region
            from={marks.incidentStart}
            to={marks.incidentEnd}
            label="incident"
          />
          <Marker at={marks.deployAt} label="deploy" />
          <Baseline value={marks.slaMs} axis="ms" label="SLA" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
