import {
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { dailyCandles, dailyCandlesRange } from './lib/gallery-fixtures';

/** Financial terminal: daily OHLC candles with the crosshair cursor and the
 *  axis-pill OHLC readout — first-class support, not a bar-chart hack. */
export default function GalleryFinancial({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = dailyCandles();

  return (
    <ChartContainer
      range={dailyCandlesRange()}
      width={width}
      theme={theme}
      cursor="crosshair"
    >
      <ChartRow height={220}>
        <YAxis id="price" side="right" format="$,.0f" width={50} />
        <Layers>
          <Candlestick series={series} as="ACME" showOHLC />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
