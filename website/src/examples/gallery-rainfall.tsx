import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  SEA_ANNUAL_MM,
  SEA_BOUNDS,
  SEA_DAILY_CEILING_MM,
  seattleRainfall,
} from './lib/weather-fixtures';

const DAY_MS = 86_400_000;

/** Rainfall and running total: daily precipitation as bars against a
 *  millimetres-per-day axis on the left, the year's cumulative total as a line
 *  against a second axis on the right. Two quantities in different units, one
 *  row — the dual-axis case, and the one chart where a rainy season is
 *  obvious at a glance (the curve goes flat all summer).
 *
 *  Both axes are pinned rather than auto-fitted so the sweeping window keeps
 *  its meaning: the cumulative line's height is "how much of the year's rain
 *  has fallen", which only reads if the top of the axis stays the year's
 *  total. */
export default function GalleryRainfall({
  width,
  phase,
}: {
  width: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const series = seattleRainfall();
  const range =
    phase === undefined
      ? SEA_BOUNDS
      : scanWindow(SEA_BOUNDS[0], SEA_BOUNDS[1], 140 * DAY_MS, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis
          id="mm"
          side="left"
          label="mm/day"
          format=",.0f"
          width={46}
          min={0}
          max={SEA_DAILY_CEILING_MM}
        />
        <Layers>
          <BarChart series={series} column="precip" axis="mm" gap={1} />
          {/* `secondary` (the palette's blue) rather than the default teal —
              two quantities on two axes need two hues, and blue next to the
              accent reads as a companion rather than a competitor. */}
          <LineChart
            series={series}
            column="cumulative"
            axis="total"
            as="secondary"
          />
        </Layers>
        <YAxis
          id="total"
          side="right"
          label="mm this year"
          format=",.0f"
          width={62}
          min={0}
          max={SEA_ANNUAL_MM}
        />
      </ChartRow>
    </ChartContainer>
  );
}
