import {
  BandChart,
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { bollinger, ema } from '@pond-ts/financial';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { dailyCandles, dailyCandlesRange } from './lib/gallery-fixtures';

/** Studies are pure `(series, options) => series` functions that **append**
 *  columns to a bar `TimeSeries` — so they compose, and you draw their output
 *  as ordinary chart layers. Here `bollinger` adds `bbUpper`/`bbMiddle`/
 *  `bbLower` and `ema` adds `ema`; the band and line just read those columns
 *  over the same candles. */
export default function ChartsFinancialStudies({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const bars = ema(bollinger(dailyCandles(), { period: 20 }), { period: 10 });

  return (
    <ChartContainer
      range={dailyCandlesRange()}
      width={width}
      theme={theme}
      cursor="crosshair"
    >
      <ChartRow height={240}>
        <YAxis id="price" side="right" format="$,.0f" />
        <Layers>
          <BandChart
            series={bars}
            lower="bbLower"
            upper="bbUpper"
            axis="price"
            as="inner"
          />
          <LineChart series={bars} column="ema" axis="price" as="secondary" />
          <Candlestick series={bars} as="ACME" showOHLC />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
