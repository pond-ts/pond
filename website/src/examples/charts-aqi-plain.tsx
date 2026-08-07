import {
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { aqiSeries } from './lib/aqi-fixtures';

/**
 * The same two sensors, drawn as plain lines — the "before" in the air-quality
 * guide.
 *
 * Nothing here is wrong: it's an accurate plot of the data, and it answers
 * *what happened* (quiet nights, a spike on the last morning). What it can't
 * answer is the question the reading exists to answer — **is this bad?** — and
 * no amount of styling the traces will fix that, because the missing
 * information isn't in the traces. It's the scale.
 */
export default function ChartsAqiPlain({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = aqiSeries();
  const range = series.timeRange()!;

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      panZoom
      bounds={[range.begin(), range.end()]}
      minDuration={60 * 60 * 1000}
    >
      <ChartRow height={220}>
        <YAxis id="aqi" label="US EPA PM2.5 AQI" width={56} />
        <Layers>
          <LineChart
            series={series}
            column="a"
            axis="aqi"
            as="secondary"
            legend="Argüelles A"
          />
          <LineChart
            series={series}
            column="b"
            axis="aqi"
            as="primary"
            legend="Argüelles B"
          />
        </Layers>
      </ChartRow>
      <Legend placement="top-left" />
    </ChartContainer>
  );
}
