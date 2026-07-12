import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { elevationProfile } from './lib/gallery-fixtures';

/** Activity chart: a ride's elevation profile as a filled area — the shape
 *  an activity-tracking consumer (estela) reaches for constantly. */
export default function GalleryActivity({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = elevationProfile();

  return (
    <ChartContainer range={series.timeRange()} width={width} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="m" side="right" label="m" format=",.0f" width={44} />
        <Layers>
          <AreaChart series={series} column="elevation" axis="m" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
