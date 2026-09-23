import {
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
  CrosshairCursor,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { marketBars, sessionWindow } from './lib/financial-fixtures';

/** Financial terminal: daily OHLC candles on a session calendar, with the
 *  crosshair cursor and the axis-pill OHLC readout — first-class support, not
 *  a bar-chart hack. Prices are **modelled**, not measured — see
 *  `lib/financial-fixtures.ts`. */
export default function GalleryFinancial({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const set = marketBars();
  const { range, bars } = sessionWindow(set, 60);

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      calendar={set.calendar}
    >
      <CrosshairCursor />
      <ChartRow height={220}>
        <YAxis id="price" side="right" format={set.priceFormat} width={62} />
        <Layers>
          <Candlestick series={bars} as={set.symbol} showOHLC gap={1} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
