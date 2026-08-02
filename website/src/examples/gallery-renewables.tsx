import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { gridMix, gridMixRange } from './lib/energy-fixtures';

const HOUR = 3_600_000;

/**
 * Wind and solar against total demand over Easter weekend 2025 — two
 * overlapping translucent areas, and the crossover that is the whole point of
 * the chart: for 1 h 45 m on Easter Sunday the two weather-driven sources
 * out-produced everything the country was drawing.
 *
 * The `in` / `out` area roles are the theme's contrasting pair (the esnet
 * two-colour traffic look). They line up with the physics here: `out` is power
 * leaving the grid to consumers (demand), `in` is power arriving from wind and
 * solar. Both fills are graded and translucent, so the overlap reads as a
 * blend rather than one area erasing the other — the opposite of the stacked
 * card next door, where the bands must be opaque.
 */
export default function GalleryRenewables({
  width,
  phase,
  height = 220,
  legend = false,
}: {
  width: number;
  phase?: number;
  height?: number;
  legend?: boolean;
}) {
  const theme = useSiteChartTheme();
  // One derived column: the two weather-driven sources added together.
  const series = gridMix().collapse(
    ['wind', 'solar'],
    'renewable',
    (v) => v.wind + v.solar,
    { append: true },
  );
  const [begin, end] = gridMixRange();
  const range: [number, number] =
    phase === undefined
      ? [begin, end]
      : scanWindow(begin, end, 20 * HOUR, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={height}>
        <YAxis id="gw" label="GW" format=",.0f" min={0} width={56} />
        <Layers>
          <AreaChart
            series={series}
            column="load"
            as="out"
            axis="gw"
            legend="Demand"
          />
          <AreaChart
            series={series}
            column="renewable"
            as="in"
            axis="gw"
            legend="Wind + solar"
          />
        </Layers>
      </ChartRow>
      {legend ? <Legend placement="top-left" /> : null}
    </ChartContainer>
  );
}
