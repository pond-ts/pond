import {
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  YAxis,
  Zone,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  AQI_CATEGORIES,
  AQI_TICKS,
  aqiAverage,
  aqiSeries,
  aqiTheme,
} from './lib/aqi-fixtures';

/**
 * US EPA PM2.5 AQI from two sensors, read against the EPA's own category bands
 * — the worked example behind the "From a CSV to a banded chart" guide.
 *
 * Three registers, doing three different jobs: the **zones** are the scale you
 * read against, the **lines** are the measurements, and the **baseline** is the
 * one number the export shipped precomputed. Only the middle one is data.
 *
 * The breakpoints (`AQI_CATEGORIES`), their colours (`aqiTheme`) and the axis
 * ticks (`AQI_TICKS`) all live in `lib/aqi-fixtures` — they're one scale, and
 * the gallery card reads the same three, so the two charts can't drift.
 */

export default function ChartsAqiZones({ width }: { width: number }) {
  const theme = aqiTheme(useSiteChartTheme());
  const series = aqiSeries();
  const average = aqiAverage(series);
  // Drag to pan, wheel to zoom — uncontrolled, so the container holds the view.
  // `bounds` is the export's own span, so you can't pan off into empty time or
  // zoom out past the data; `minDuration` floors the zoom at one hour, well
  // under the 10-minute sample grid.
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
      <ChartRow height={260}>
        {/* Pinned to 0–200 rather than fitted to the data: the point of the
            chart is where the readings sit *within the scale*, and an axis that
            hugs the data (9–159 here) would silently redraw the bands every
            time the window changed. */}
        <YAxis
          id="aqi"
          label="US EPA PM2.5 AQI"
          width={56}
          min={0}
          max={200}
          ticks={AQI_TICKS}
        />
        <Layers>
          {/* The scale first, so the bands sit behind the traces in the
              annotation overlay's own paint order. Every category is rendered,
              including the three the axis doesn't reach — a zone past the
              domain clamps to the plot edge and the ones fully above it cull
              themselves, so the table drives the chart rather than a
              hand-pruned copy of it. */}
          {AQI_CATEGORIES.map((c) => (
            <Zone
              key={c.role}
              from={c.from}
              to={c.to}
              axis="aqi"
              role={c.role}
            />
          ))}
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
          {/* The export's "Average" column, recomputed: an annotation, not a
              two-point series. */}
          <Baseline
            value={average}
            axis="aqi"
            role="average"
            label={average.toFixed(1)}
            labelSide="right"
          />
        </Layers>
      </ChartRow>
      <Legend placement="top-left" />
    </ChartContainer>
  );
}
