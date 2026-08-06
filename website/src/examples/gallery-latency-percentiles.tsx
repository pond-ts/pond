import {
  BandChart,
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  latencyPercentiles,
  LATENCY_EVENTS,
  LATENCY_RANGE,
} from './lib/ops-fixtures';

/**
 * Request latency as a **percentile envelope**: a wide p50–p99 band, a tighter
 * p50–p90 band inside it, and the median as a line through the middle.
 *
 * The point of the shape is that the bands are not decoration — the *distance*
 * between the edges is the story. When a downstream cache goes cold at 11:12
 * the envelope tears open (p99 ×5.7) while the median line barely moves
 * (×1.23), which is precisely the failure a single mean line hides.
 *
 * Two `<BandChart>`s rather than one: nesting `outer` inside `inner` gives the
 * two-tone envelope for free, because both roles are tints of the same hue and
 * the inner one paints over the outer.
 */
export default function GalleryLatencyPercentiles({
  width,
  phase,
  height = 210,
  showSlo = true,
}: {
  width: number;
  phase?: number;
  height?: number;
  showSlo?: boolean;
}) {
  const theme = useSiteChartTheme();
  const series = latencyPercentiles();

  const range =
    phase === undefined
      ? LATENCY_RANGE
      : scanWindow(LATENCY_RANGE[0], LATENCY_RANGE[1], 150 * 60_000, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme} cursor="line">
      <ChartRow height={height}>
        <YAxis
          id="ms"
          side="right"
          label="ms"
          labelPlacement="top"
          format=",.0f"
          width={50}
        />
        <Layers>
          <BandChart
            series={series}
            lower="p50"
            upper="p99"
            as="outer"
            axis="ms"
            legend="p50–p99"
          />
          <BandChart
            series={series}
            lower="p50"
            upper="p90"
            as="inner"
            axis="ms"
            legend="p50–p90"
          />
          <LineChart series={series} column="p50" axis="ms" legend="p50" />
          {showSlo ? (
            <Baseline
              value={LATENCY_EVENTS.sloMs}
              axis="ms"
              label="p99 objective"
            />
          ) : null}
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
