import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  SEA_BOUNDS,
  SEA_TEMP_EXTENT,
  seattleTemperature,
} from './lib/weather-fixtures';

const DAY_MS = 86_400_000;

/** Temperature range: a year of daily min/max at Seattle-Tacoma as a band,
 *  with a 15-day centred mean drawn through it. The band is the day's *range*
 *  rather than an uncertainty envelope — the same `<BandChart>`, asked a
 *  different question.
 *
 *  With a `phase` (the Gallery card's autoplay clock) a 16-week window sweeps
 *  the year, so the band visibly widens into summer and narrows again. The
 *  y-axis is pinned to the year's extremes rather than auto-fitting, or the
 *  scan would rescale every frame. `phase` is `undefined` for every other
 *  embed — the whole year, still. */
export default function GalleryTemperatureRange({
  width,
  phase,
}: {
  width: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const series = seattleTemperature();
  const range =
    phase === undefined
      ? SEA_BOUNDS
      : scanWindow(SEA_BOUNDS[0], SEA_BOUNDS[1], 112 * DAY_MS, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis
          id="c"
          side="right"
          label="temperature (°C)"
          format=",.0f"
          width={44}
          min={SEA_TEMP_EXTENT[0]}
          max={SEA_TEMP_EXTENT[1]}
        />
        <Layers>
          <BandChart
            series={series}
            lower="low"
            upper="high"
            axis="c"
            as="outer"
          />
          <LineChart series={series} column="trend" axis="c" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
