import {
  AreaChart,
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
  AIR_RANGE,
  AQI_THRESHOLDS,
  airQuality,
} from './lib/science-fixtures';

/** A week of hourly PM2.5 at a Bronx monitor through the June 2023 Canadian
 *  wildfire smoke, with the US AQI category boundaries as `<Baseline>`
 *  reference lines.
 *
 *  Threshold bands are what turns a concentration into a judgement: 40 µg/m³
 *  means nothing until you can see which line it crossed. Several baselines on
 *  one axis is the shape — they're all one annotation register, so they read
 *  as marks rather than as five more series.
 *
 *  `gaps="dashed"` bridges the one hour the monitor didn't report with a faint
 *  dashed connector instead of silently interpolating it. */
export default function GalleryAirQuality({
  width = 720,
  phase,
  height = 210,
}: {
  width?: number;
  phase?: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();
  const air = airQuality();

  const range =
    phase === undefined
      ? AIR_RANGE
      : scanWindow(AIR_RANGE[0], AIR_RANGE[1], 72 * 3_600_000, phase);

  // Five labelled baselines is right on a full-size chart and a thicket on a
  // 190px card, so the preview keeps the three that the smoke actually
  // crossed. (`phase` is the Gallery card's clock — its absence means this is
  // the full-size embed.)
  const thresholds =
    phase === undefined ? AQI_THRESHOLDS : AQI_THRESHOLDS.slice(2);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={height}>
        <YAxis id="pm" label="PM2.5 (µg/m³)" format=",.0f" min={0} width={62} />
        <Layers>
          <AreaChart series={air} column="pm25" axis="pm" gaps="dashed" />
          <LineChart series={air} column="pm25" axis="pm" gaps="dashed" />
          {thresholds.map((t) => (
            <Baseline
              key={t.label}
              value={t.pm25}
              axis="pm"
              label={t.label}
              labelPosition="above"
              selectable={false}
            />
          ))}
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
