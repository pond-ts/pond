import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { requestMetrics } from './lib/gallery-fixtures';

/** Ops dashboard: requests/sec (area) over error rate (line), two rows
 *  sharing one time axis and cursor — the multi-row layout ops telemetry
 *  reaches for first.
 *
 *  With a `phase` (the Gallery card's autoplay clock) a 45-minute window
 *  sweeps across the 90-minute series, so the error spike scrolls into view
 *  rather than sitting there. `phase` defaults to `undefined` — the whole
 *  range, still — for every other embed of this example. */
export default function GalleryDashboard({
  width,
  phase,
}: {
  width: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const series = requestMetrics();
  // `timeRange()` is undefined only for an empty series; the fixture never is.
  const full = series.timeRange()!;
  const range =
    phase === undefined
      ? full
      : scanWindow(full.begin(), full.end(), 45 * 60_000, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={90}>
        <YAxis id="rps" side="right" format=",.0f" width={46} />
        <Layers>
          <AreaChart series={series} column="rps" axis="rps" />
        </Layers>
      </ChartRow>
      <ChartRow height={70}>
        <YAxis id="err" side="right" format=".1%" width={46} />
        <Layers>
          <LineChart series={series} column="errorRate" axis="err" as="slow" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
