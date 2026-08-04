import {
  BarChart,
  CategoryAxis,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  MONTH_NAMES,
  WIND_MONTHLY_PEAK_PCT,
  windRose,
} from './lib/weather-fixtures';

/** Wind direction: a year of hourly reports from Seattle-Tacoma binned into
 *  the 16 compass sectors, each bar the share of hours the wind blew from
 *  that quarter. The x axis is **ordinal** — sixteen equal slots named by
 *  their category, not a number line — which is what `<CategoryAxis>` draws.
 *
 *  With a `phase` the card steps through the twelve months, and the whole
 *  distribution swings: winter blows up the Puget Sound trough from the south,
 *  July reverses it. The axis ceiling is fixed at the tallest sector in any
 *  month so the frames are comparable. */
export default function GalleryWindRose({
  width,
  phase,
}: {
  width: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const month = phase === undefined ? undefined : Math.min(11, Math.floor(phase * 12));
  const rose = windRose(month);

  return (
    // `crosshair` on an ordinal axis degrades to a *vertical line plus the
    // hovered category's name*, pinned to the `<CategoryAxis>` — there's no
    // continuous x position to read back, so no horizontal arm and no value
    // pill. Naming the sector is the point: the axis only has room to print
    // eight of the sixteen labels.
    <ChartContainer
      width={width}
      theme={theme}
      showAxis={false}
      cursor="crosshair"
    >
      <ChartRow height={196}>
        <YAxis
          id="pct"
          side="left"
          label="% of hours"
          format=",.0f"
          width={46}
          min={0}
          max={WIND_MONTHLY_PEAK_PCT}
        />
        <Layers>
          <BarChart categories={rose} axis="pct" gap={6} id="rose" />
        </Layers>
      </ChartRow>
      <CategoryAxis
        label={month === undefined ? 'All of 2024' : `${MONTH_NAMES[month]} 2024`}
      />
    </ChartContainer>
  );
}
